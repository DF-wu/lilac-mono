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

export interface WorkspaceProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type WorkspaceProcessRunner = (
  repositoryRoot: string,
  workspaceRoot: string,
) => Promise<WorkspaceProcessResult>;

export interface WorkspaceProcessOptions {
  readonly workers?: number;
  readonly writeStdout?: (output: string) => void;
  readonly writeStderr?: (output: string) => void;
}

const MAX_WORKSPACE_OUTPUT_BYTES = 8 * 1024 * 1024;

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

async function readWorkspaceOutput(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const output: string[] = [];
  let capturedBytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const remaining = MAX_WORKSPACE_OUTPUT_BYTES - capturedBytes;
    if (remaining <= 0) {
      truncated = true;
      continue;
    }
    const captured = value.byteLength <= remaining ? value : value.subarray(0, remaining);
    output.push(decoder.decode(captured, { stream: true }));
    capturedBytes += captured.byteLength;
    if (captured.byteLength < value.byteLength) truncated = true;
  }
  output.push(decoder.decode());
  if (truncated) output.push("\n[architecture workspace output truncated]\n");
  return output.join("");
}

async function runWorkspaceProcess(
  repositoryRoot: string,
  workspaceRoot: string,
): Promise<WorkspaceProcessResult> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name !== ARCHITECTURE_WORKSPACE_FIXTURE_ENV),
  );
  const subprocess = Bun.spawn({
    cmd: [process.execPath, path.join(import.meta.dir, "workspace-runner.ts"), workspaceRoot],
    cwd: repositoryRoot,
    env: environment,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    readWorkspaceOutput(subprocess.stdout),
    readWorkspaceOutput(subprocess.stderr),
  ]);
  return { exitCode, stdout, stderr };
}

export async function analyzeArchitectureInWorkspaceProcesses(
  repositoryRoot: string,
  manifest: ArchitectureManifest = architectureManifest,
  processRunner: WorkspaceProcessRunner = runWorkspaceProcess,
  options: WorkspaceProcessOptions = {},
): Promise<boolean> {
  assertArchitectureManifestIntegrity(manifest);
  const workers = options.workers ?? 1;
  if (!Number.isSafeInteger(workers) || workers < 1) {
    throw new Error(`Architecture worker count must be a positive integer; received ${workers}.`);
  }
  const writeStdout = options.writeStdout ?? ((output: string) => process.stdout.write(output));
  const writeStderr = options.writeStderr ?? ((output: string) => process.stderr.write(output));
  type Completion = { readonly result: WorkspaceProcessResult } | { readonly error: unknown };
  const completions: (Completion | undefined)[] = [];
  let nextWorkspace = 0;
  let nextOutput = 0;
  let stopScheduling = false;
  let hasFindings = false;
  let failure: { readonly message: string; readonly cause?: unknown } | undefined;

  const emitCompletedOutput = (): void => {
    for (;;) {
      const completion = completions[nextOutput];
      if (!completion) return;
      const workspace = manifest.workspaces[nextOutput];
      if (!workspace) return;
      if ("result" in completion) {
        if (completion.result.stdout) writeStdout(completion.result.stdout);
        if (completion.result.stderr) writeStderr(completion.result.stderr);
        if (completion.result.exitCode === ARCHITECTURE_FINDINGS_EXIT_CODE) {
          hasFindings = true;
        } else if (completion.result.exitCode !== 0 && !failure) {
          failure = {
            message: `Architecture analysis subprocess for ${workspace.name} failed with exit code ${completion.result.exitCode}.`,
          };
        }
      } else if (!failure) {
        failure = {
          message: `Architecture analysis subprocess for ${workspace.name} failed to complete.`,
          cause: completion.error,
        };
      }
      nextOutput += 1;
    }
  };

  const runWorker = async (): Promise<void> => {
    for (;;) {
      if (stopScheduling) return;
      const index = nextWorkspace;
      const workspace = manifest.workspaces[index];
      if (!workspace) return;
      nextWorkspace += 1;
      try {
        const result = await processRunner(repositoryRoot, workspace.root);
        completions[index] = { result };
        if (result.exitCode !== 0 && result.exitCode !== ARCHITECTURE_FINDINGS_EXIT_CODE) {
          stopScheduling = true;
        }
      } catch (error) {
        completions[index] = { error };
        stopScheduling = true;
      }
      emitCompletedOutput();
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(workers, manifest.workspaces.length) }, () => runWorker()),
  );
  emitCompletedOutput();
  if (failure) {
    throw new Error(
      failure.message,
      failure.cause === undefined ? undefined : { cause: failure.cause },
    );
  }
  return hasFindings;
}

export function parseArchitectureWorkerCount(options: readonly string[]): number {
  let workers = 1;
  let supplied = false;
  for (const option of options) {
    const match = /^--workers=(.*)$/u.exec(option);
    if (!match) throw new Error(`Unknown architecture option '${option}'.`);
    if (supplied) throw new Error("Architecture option '--workers' may be supplied only once.");
    const value = Number(match[1]);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(
        `Architecture worker count must be a positive integer; received '${match[1]}'.`,
      );
    }
    workers = value;
    supplied = true;
  }
  return workers;
}

async function main(): Promise<void> {
  const repositoryRoot = path.resolve(import.meta.dir, "../..");
  const command = Bun.argv[2] ?? "check";
  if (command !== "check") {
    throw new Error(
      `Unknown architecture command '${command}'. The permanent gate supports only 'check'; inventory and baseline generation were removed after migration.`,
    );
  }
  const workers = parseArchitectureWorkerCount(Bun.argv.slice(3));
  await validateWorkspaceInventory(repositoryRoot);
  const hasFindings = await analyzeArchitectureInWorkspaceProcesses(
    repositoryRoot,
    architectureManifest,
    runWorkspaceProcess,
    { workers },
  );
  if (hasFindings) process.exitCode = 1;
}

if (import.meta.main) await main();
