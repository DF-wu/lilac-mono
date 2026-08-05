import path from "node:path";

import type { ArchitectureManifest } from "./manifest.ts";
import { architectureManifest } from "./manifest.ts";
import {
  analyzeArchitectureWorkspace,
  createArchitectureAnalysisContext,
  printDiagnostic,
} from "./runner.ts";
import {
  ARCHITECTURE_FINDINGS_EXIT_CODE,
  ARCHITECTURE_WORKSPACE_FIXTURE_ENV,
  ARCHITECTURE_WORKSPACE_FIXTURE_VALUE,
} from "./workspace-runner-protocol.ts";

async function selectedManifest(): Promise<ArchitectureManifest> {
  const fixture = process.env[ARCHITECTURE_WORKSPACE_FIXTURE_ENV];
  if (fixture === undefined) return architectureManifest;
  if (fixture !== ARCHITECTURE_WORKSPACE_FIXTURE_VALUE) {
    throw new Error(`Unsupported architecture workspace fixture '${fixture}'.`);
  }
  const fixtureModule = await import("./fixtures/workspace-runner/manifest.ts");
  return fixtureModule.workspaceRunnerFixtureManifest;
}

async function main(): Promise<void> {
  const repositoryRoot = path.resolve(import.meta.dir, "../..");
  const workspaceRoot = Bun.argv[2];
  const manifest = await selectedManifest();
  const workspace = manifest.workspaces.find((candidate) => candidate.root === workspaceRoot);
  if (!workspace) {
    throw new Error(`Unknown architecture workspace '${workspaceRoot ?? "<missing>"}'.`);
  }

  const context = createArchitectureAnalysisContext(repositoryRoot, manifest);
  const findings = analyzeArchitectureWorkspace(repositoryRoot, workspace, context);
  for (const diagnostic of findings) printDiagnostic(diagnostic);
  if (findings.length > 0) process.exitCode = ARCHITECTURE_FINDINGS_EXIT_CODE;
}

if (import.meta.main) await main();
