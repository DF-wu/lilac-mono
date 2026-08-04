import path from "node:path";

import {
  analyzeWorkspace,
  type ActivePersistenceInfrastructure,
  type WorkspacePackageRoot,
} from "./analyzer.ts";
import type { ArchitectureManifest, WorkspaceArchitecture } from "./manifest.ts";
import { architectureManifest, assertArchitectureManifestIntegrity } from "./manifest.ts";
import type { ArchitectureDiagnostic } from "./model.ts";
import { createWorkspaceProgram, type WorkspaceProgram } from "./program.ts";
import { validateWorkspaceInventory } from "./workspace-inventory.ts";
import {
  ARCHITECTURE_FINDINGS_EXIT_CODE,
  ARCHITECTURE_WORKSPACE_FIXTURE_ENV,
} from "./workspace-runner-protocol.ts";

export { ARCHITECTURE_FINDINGS_EXIT_CODE } from "./workspace-runner-protocol.ts";

export type ProgramFactory = (
  repositoryRoot: string,
  workspace: ArchitectureManifest["workspaces"][number],
) => WorkspaceProgram;

export interface ArchitectureAnalysisContext {
  readonly packageRoots: readonly WorkspacePackageRoot[];
  readonly activeEventDeliveryApiPackages: ReadonlySet<string>;
  readonly activePersistenceInfrastructure: ActivePersistenceInfrastructure;
  readonly approvedExceptionAdapters: ArchitectureManifest["approvedExceptionAdapters"];
}

export type WorkspaceProcessRunner = (
  repositoryRoot: string,
  workspaceRoot: string,
) => Promise<number>;

export function createArchitectureAnalysisContext(
  repositoryRoot: string,
  manifest: ArchitectureManifest,
): ArchitectureAnalysisContext {
  const packageRoots = manifest.workspaces.map((workspace) => ({
    packageName: workspace.packageName,
    root: path.resolve(repositoryRoot, workspace.root),
  }));
  const activeEventDeliveryApiPackages = new Set([
    ...manifest.workspaces
      .filter((workspace) => workspace.eventDeliveryApis.length > 0)
      .map((workspace) => workspace.packageName),
    ...manifest.workspaces.flatMap((workspace) =>
      workspace.eventDeliveryConsumers.map((registration) => registration.apiPackage),
    ),
  ]);
  const activePersistenceInfrastructure = {
    persistedCodecs: manifest.workspaces.flatMap((workspace) =>
      workspace.persistedCodecs.map(({ identity }) => ({
        packageName: workspace.packageName,
        identity,
      })),
    ),
    sqliteTransactionAdapters: manifest.workspaces.flatMap((workspace) =>
      workspace.sqliteTransactionAdapters.map(({ identity }) => ({
        packageName: workspace.packageName,
        identity,
      })),
    ),
    scanAllProductionModules: true,
  };
  return {
    packageRoots,
    activeEventDeliveryApiPackages,
    activePersistenceInfrastructure,
    approvedExceptionAdapters: manifest.approvedExceptionAdapters,
  };
}

export function analyzeArchitectureWorkspace(
  repositoryRoot: string,
  workspace: WorkspaceArchitecture,
  context: ArchitectureAnalysisContext,
  programFactory: ProgramFactory = createWorkspaceProgram,
): readonly ArchitectureDiagnostic[] {
  const workspaceProgram = programFactory(repositoryRoot, workspace);
  return analyzeWorkspace(
    workspace,
    workspaceProgram.root,
    workspaceProgram.program,
    context.packageRoots,
    context.activeEventDeliveryApiPackages,
    context.activePersistenceInfrastructure,
    context.approvedExceptionAdapters,
  );
}

export function analyzeArchitecture(
  repositoryRoot: string,
  manifest: ArchitectureManifest = architectureManifest,
  programFactory: ProgramFactory = createWorkspaceProgram,
): readonly ArchitectureDiagnostic[] {
  assertArchitectureManifestIntegrity(manifest);
  const context = createArchitectureAnalysisContext(repositoryRoot, manifest);
  const diagnostics: ArchitectureDiagnostic[] = [];
  for (const workspace of manifest.workspaces) {
    diagnostics.push(
      ...analyzeArchitectureWorkspace(repositoryRoot, workspace, context, programFactory),
    );
  }
  return diagnostics;
}

export function printDiagnostic(diagnostic: ArchitectureDiagnostic): void {
  const location = diagnostic.location
    ? `${diagnostic.workspace}/${diagnostic.location.file}:${diagnostic.location.line}:${diagnostic.location.column}`
    : diagnostic.workspace;
  console[diagnostic.severity === "error" ? "error" : "warn"](
    `${location} ${diagnostic.severity} ${diagnostic.rule}: ${diagnostic.message} ${diagnostic.suggestion} [${diagnostic.fingerprint}]`,
  );
}

async function runWorkspaceProcess(repositoryRoot: string, workspaceRoot: string): Promise<number> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name !== ARCHITECTURE_WORKSPACE_FIXTURE_ENV),
  );
  const subprocess = Bun.spawn({
    cmd: [process.execPath, path.join(import.meta.dir, "workspace-runner.ts"), workspaceRoot],
    cwd: repositoryRoot,
    env: environment,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  return subprocess.exited;
}

export async function analyzeArchitectureInWorkspaceProcesses(
  repositoryRoot: string,
  manifest: ArchitectureManifest = architectureManifest,
  processRunner: WorkspaceProcessRunner = runWorkspaceProcess,
): Promise<boolean> {
  assertArchitectureManifestIntegrity(manifest);
  let hasFindings = false;
  for (const workspace of manifest.workspaces) {
    const exitCode = await processRunner(repositoryRoot, workspace.root);
    if (exitCode === ARCHITECTURE_FINDINGS_EXIT_CODE) {
      hasFindings = true;
      continue;
    }
    if (exitCode !== 0) {
      throw new Error(
        `Architecture analysis subprocess for ${workspace.name} failed with exit code ${exitCode}.`,
      );
    }
  }
  return hasFindings;
}

async function main(): Promise<void> {
  const repositoryRoot = path.resolve(import.meta.dir, "../..");
  const command = Bun.argv[2] ?? "check";
  if (command !== "check") {
    throw new Error(
      `Unknown architecture command '${command}'. The permanent gate supports only 'check'; inventory and baseline generation were removed after migration.`,
    );
  }
  await validateWorkspaceInventory(repositoryRoot);
  const hasFindings = await analyzeArchitectureInWorkspaceProcesses(repositoryRoot);
  if (hasFindings) process.exitCode = 1;
}

if (import.meta.main) await main();
