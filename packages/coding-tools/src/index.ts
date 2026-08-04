import path from "node:path";

import { FileSystem, expandTilde, type FsBackend } from "@stanley2058/lilac-fs";
import type { ToolSet } from "ai";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import { createApplyPatchTool } from "./apply-patch";
import type { CodingToolArtifactIntegration } from "./artifact-integration";
import { createBashTool } from "./bash";
import { createBatchToolResult, type BatchRejected } from "./batch";
import { createFilesystemTools } from "./filesystem";
import { validateLocalCwd, type CodingToolGuardrailViolation } from "./guardrails";
import { adaptCodingToolResultToHost } from "./host-compatibility";

export * from "./apply-patch";
export * from "./artifact-integration";
export * from "./bash";
export * from "./batch";
export * from "./buffered-file-sink";
export * from "./filesystem";
export * from "./guardrails";
export * from "./instructions";
export * from "./schemas";

export const DEFAULT_DENY_PATHS = ["~/.ssh", "~/.aws", "~/.gnupg"] as const;

export type CodingToolsetOptions = {
  /** Local working directory. SSH cwd targets are owned by runtime-specific adapters. */
  cwd: string;
  fsBackend?: FsBackend;
  fffCacheDir?: string;
  denyPaths?: readonly string[];
  extraTools?: ToolSet;
  /** Optional Bash wall-clock deadline. The fixed no-output deadline is independent. */
  bashTimeoutMs?: number;
  bashMaxOutputBytes?: number;
  /** Maximum UTF-8 bytes in a read_file textual payload. */
  maxOutputBytes?: number;
  bashStreamOutput?: boolean;
  bashMergeOutput?: boolean;
  /** Complete environment exposed to Bash. Defaults to the parent process environment. */
  bashEnv?: Readonly<Record<string, string | undefined>>;
  enabledTools?: readonly string[];
  batchExcludedTools?: readonly string[];
  /** Authorize dangerouslyAllow for every guardrailed coding tool. */
  allowGuardrailBypass?: boolean;
  /** Authorize dangerouslyAllow for Bash without authorizing filesystem or patch bypasses. */
  allowBashGuardrailBypass?: boolean;
  loadInstructions?: boolean;
  preloadedInstructionPaths?: readonly string[];
  /** Fixed artifact authority for recoverable Bash output and tool-result:// reads. */
  artifactIntegration?: CodingToolArtifactIntegration;
  /** Attach supported local images and PDFs to the model-facing read_file result. */
  readFileDirectAttachmentSupported?: boolean;
  /** Maximum decoded bytes in one read_file media attachment. */
  maxInlineMediaBytesPerPart?: number;
};

export class CodingToolsetInvalidOptions extends TaggedError("CodingToolsetInvalidOptions")<{
  readonly message: string;
}> {}

export type CreateCodingToolsetError =
  | CodingToolsetInvalidOptions
  | CodingToolGuardrailViolation
  | BatchRejected;

/**
 * Create the local, legacy-edit coding toolset.
 *
 * Runtime adapters can use the exported schema factories to expose hashline editing or SSH while
 * retaining their own read state, remote transport, and path policy.
 */
export function createCodingToolsetResult(
  options: CodingToolsetOptions,
): ResultType<ToolSet, CreateCodingToolsetError> {
  const localCwd = validateLocalCwd(options.cwd);
  if (localCwd.status === "error") return Result.err(localCwd.error);
  if (options.artifactIntegration?.scopeId.trim().length === 0) {
    return Result.err(
      new CodingToolsetInvalidOptions({ message: "artifactIntegration.scopeId must not be empty" }),
    );
  }
  if (options.artifactIntegration?.requestId.trim().length === 0) {
    return Result.err(
      new CodingToolsetInvalidOptions({
        message: "artifactIntegration.requestId must not be empty",
      }),
    );
  }
  const cwd = path.resolve(expandTilde(options.cwd));
  const fsBackend = options.fsBackend ?? "node-rg";
  const denyPaths = [...DEFAULT_DENY_PATHS, ...(options.denyPaths ?? [])];
  const enabledTools = options.enabledTools;
  const allToolsEnabled = enabledTools === undefined || enabledTools.includes("*");
  const isEnabled = (name: string) => allToolsEnabled || enabledTools?.includes(name) === true;
  const allowGuardrailBypass = options.allowGuardrailBypass ?? false;
  const allowBashGuardrailBypass = options.allowBashGuardrailBypass ?? allowGuardrailBypass;
  const artifactIntegration = options.artifactIntegration
    ? { ...options.artifactIntegration }
    : undefined;
  const fileSystem = new FileSystem(cwd, {
    denyPaths,
    fsBackend,
    fffCacheDir: options.fffCacheDir,
  });
  const candidates: ToolSet = {
    ...createBashTool({
      cwd,
      denyPaths,
      timeoutMs: options.bashTimeoutMs,
      maxOutputBytes: options.bashMaxOutputBytes,
      streamOutput: options.bashStreamOutput,
      mergeOutput: options.bashMergeOutput,
      env: options.bashEnv,
      allowGuardrailBypass: allowBashGuardrailBypass,
      artifactIntegration,
    }),
    ...createFilesystemTools({
      fileSystem,
      cwd,
      fsBackend,
      allowGuardrailBypass,
      loadInstructions: options.loadInstructions,
      preloadedInstructionPaths: options.preloadedInstructionPaths,
      denyPaths,
      artifactIntegration,
      readFileDirectAttachmentSupported: options.readFileDirectAttachmentSupported,
      maxInlineMediaBytesPerPart: options.maxInlineMediaBytesPerPart,
      maxOutputBytes: options.maxOutputBytes,
    }),
    ...createApplyPatchTool({ cwd, denyPaths, allowGuardrailBypass }),
    ...options.extraTools,
  };
  const tools: ToolSet = {};
  for (const [name, candidate] of Object.entries(candidates)) {
    if (name !== "batch" && isEnabled(name)) tools[name] = candidate;
  }
  if (isEnabled("batch")) {
    const getBatchTools = () =>
      Object.fromEntries(
        Object.entries(tools).filter(([name]) => !options.batchExcludedTools?.includes(name)),
      );
    if (Object.keys(getBatchTools()).length > 0) {
      const batch = createBatchToolResult({ cwd, getTools: getBatchTools });
      if (batch.status === "error") return Result.err(batch.error);
      Object.assign(tools, batch.value);
    }
  }
  return Result.ok(tools);
}

export function createCodingToolset(options: CodingToolsetOptions): ToolSet {
  return adaptCodingToolResultToHost(createCodingToolsetResult(options));
}
