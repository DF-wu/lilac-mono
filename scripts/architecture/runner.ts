import path from "node:path";

import { analyzeWorkspace } from "./analyzer.ts";
import {
  applyBaselines,
  baselineFromFindings,
  formatBaselineModule,
  stage0BaselineReason,
} from "./baseline.ts";
import { boundaryValidationBaseline } from "./boundary-validation.baseline.ts";
import { failureFlowBaseline } from "./failure-flow.baseline.ts";
import type { ArchitectureManifest } from "./manifest.ts";
import {
  architectureManifest,
  assertArchitectureManifestIntegrity,
  STAGE_3_MODULES,
} from "./manifest.ts";
import type { ArchitectureDiagnostic } from "./model.ts";
import { ARCHITECTURE_RULES } from "./model.ts";
import { createWorkspaceProgram, type WorkspaceProgram } from "./program.ts";
import { validateWorkspaceInventory } from "./workspace-inventory.ts";

export type ProgramFactory = (
  repositoryRoot: string,
  workspace: ArchitectureManifest["workspaces"][number],
) => WorkspaceProgram;

export function analyzeArchitecture(
  repositoryRoot: string,
  manifest: ArchitectureManifest = architectureManifest,
  programFactory: ProgramFactory = createWorkspaceProgram,
): readonly ArchitectureDiagnostic[] {
  assertArchitectureManifestIntegrity(manifest);
  const diagnostics: ArchitectureDiagnostic[] = [];
  const packageRoots = manifest.workspaces.map((workspace) => ({
    packageName: workspace.packageName,
    root: path.resolve(repositoryRoot, workspace.root),
  }));
  for (const workspace of manifest.workspaces) {
    const workspaceProgram = programFactory(repositoryRoot, workspace);
    diagnostics.push(
      ...analyzeWorkspace(workspace, workspaceProgram.root, workspaceProgram.program, packageRoots),
    );
  }
  return diagnostics;
}

export function inventoryManifest(manifest: ArchitectureManifest): ArchitectureManifest {
  return {
    ...manifest,
    workspaces: manifest.workspaces.map((workspace) => ({
      ...workspace,
      ruleZones: Object.fromEntries(
        ARCHITECTURE_RULES.map((rule) => [
          rule,
          rule === "architecture/open-protocol-normalization"
            ? (workspace.ruleZones[rule] ?? [])
            : [{ include: "**" }],
        ]),
      ),
    })),
  };
}

function printDiagnostic(diagnostic: ArchitectureDiagnostic): void {
  const location = diagnostic.location
    ? `${diagnostic.workspace}/${diagnostic.location.file}:${diagnostic.location.line}:${diagnostic.location.column}`
    : diagnostic.workspace;
  console[diagnostic.severity === "error" ? "error" : "warn"](
    `${location} ${diagnostic.severity} ${diagnostic.rule}: ${diagnostic.message} ${diagnostic.suggestion} [${diagnostic.fingerprint}]`,
  );
}

function migratedWorkspaceNames(manifest: ArchitectureManifest): ReadonlySet<string> {
  return new Set(
    manifest.workspaces
      .filter((workspace) => workspace.status === "migrated")
      .map((workspace) => workspace.name),
  );
}

async function main(): Promise<void> {
  const repositoryRoot = path.resolve(import.meta.dir, "../..");
  const command = Bun.argv[2] ?? "check";
  if (command !== "check" && command !== "inventory" && command !== "write-baselines") {
    throw new Error(`Unknown architecture command: ${command}`);
  }
  await validateWorkspaceInventory(repositoryRoot);
  const manifest =
    command === "check" ? architectureManifest : inventoryManifest(architectureManifest);
  const findings = analyzeArchitecture(repositoryRoot, manifest);

  if (command === "inventory") {
    console.log(JSON.stringify(findings, null, 2));
    return;
  }

  if (command === "write-baselines") {
    const boundary = baselineFromFindings(findings, "boundary-validation", stage0BaselineReason);
    const failure = baselineFromFindings(findings, "failure-flow", stage0BaselineReason);
    await Promise.all([
      Bun.write(
        path.join(import.meta.dir, "boundary-validation.baseline.ts"),
        formatBaselineModule("boundaryValidationBaseline", boundary),
      ),
      Bun.write(
        path.join(import.meta.dir, "failure-flow.baseline.ts"),
        formatBaselineModule("failureFlowBaseline", failure),
      ),
    ]);
    return;
  }

  const evaluated = applyBaselines(
    findings,
    boundaryValidationBaseline,
    failureFlowBaseline,
    migratedWorkspaceNames(manifest),
    STAGE_3_MODULES,
  );
  for (const diagnostic of evaluated.diagnostics) printDiagnostic(diagnostic);
  if (evaluated.diagnostics.some((diagnostic) => diagnostic.severity === "error"))
    process.exitCode = 1;
}

if (import.meta.main) await main();
