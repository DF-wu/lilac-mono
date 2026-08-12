import type { ServerTool } from "@stanley2058/lilac-plugin-runtime";
import {
  applyPatchInputSchema,
  LEVEL1_TOOL_NAMES,
  type ApplyPatchInput,
  type Level1ToolName,
} from "@stanley2058/lilac-coding-tools/schemas";
import { expandTilde } from "@stanley2058/lilac-fs";
import {
  errorCode,
  opaqueErrorMessage,
  resolveNativeSubagentProfile,
} from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { parseSshCwdTarget } from "../../ssh/ssh-cwd";
import { applyPatchTool } from "../../tools/apply-patch";
import { parsePatchResult } from "../../tools/apply-patch/apply-patch-core";
import {
  batchTool,
  collectApplyPatchTouchedPaths,
  collectEditFileTouchedPaths,
} from "../../tools/batch";
import { bashToolWithCwd } from "../../tools/bash";
import { fsTool } from "../../tools/fs/fs";
import {
  subagentTools,
  type SubagentDelegationHandle,
  type SubagentDelegationRegistration,
} from "../../tools/subagent";
import {
  summarizeApplyPatchFailure,
  summarizeBashFailure,
  summarizeBatchFailure,
  summarizeReadOrEditFailure,
  summarizeSearchFailure,
  summarizeSubagentFailure,
} from "../../surface/bridge/bus-agent-runner/tool-failure-logging";
import {
  formatApplyPatchToolArgs,
  formatBashToolArgs,
  formatBatchToolArgs,
  formatEditFileToolArgs,
  formatFuzzySearchToolArgs,
  formatGlobToolArgs,
  formatGrepToolArgs,
  formatReadFileToolArgs,
  formatSubagentDelegateToolArgs,
} from "../../tools/tool-args-display";
import { defineLevel1Tool } from "./define-level1-tool";
import { type CoreLevel1ToolSpec, type CoreToolPlugin } from "../types";

type CoreToolBuildContext = Parameters<CoreLevel1ToolSpec["createTool"]>[0];

const localFsToolsByBuildContext = new WeakMap<CoreToolBuildContext, ReturnType<typeof fsTool>>();

type DelegateHandler = (
  registration: SubagentDelegationRegistration,
) => Promise<SubagentDelegationHandle>;
type AgentActivityHandler = (source: "tool" | "subagent") => void;

function isDelegateHandler(value: unknown): value is DelegateHandler {
  return typeof value === "function";
}

function isAgentActivityHandler(value: unknown): value is AgentActivityHandler {
  return typeof value === "function";
}

const coreToolRequestMetadataSchema = z
  .object({
    readFileDirectAttachmentSupported: z.boolean().optional(),
    controlCapability: z.string().optional(),
    onSubagentDelegate: z.custom<DelegateHandler>(isDelegateHandler).optional(),
    onActivity: z.custom<AgentActivityHandler>(isAgentActivityHandler).optional(),
  })
  .passthrough();

const editTargetInputSchema = z.object({
  path: z.string(),
  cwd: z.string().optional(),
});

export function decodeCoreToolRequestMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
): z.output<typeof coreToolRequestMetadataSchema> {
  const decoded = coreToolRequestMetadataSchema.safeParse(metadata ?? {});
  return decoded.success ? decoded.data : {};
}

function getReadFileDirectAttachmentSupported(context: CoreToolBuildContext): boolean {
  return (
    decodeCoreToolRequestMetadata(context.requestContext?.metadata)
      .readFileDirectAttachmentSupported === true
  );
}

function getFsTools(context: CoreToolBuildContext): ReturnType<typeof fsTool> {
  const cached = localFsToolsByBuildContext.get(context);
  if (cached) return cached;

  const tools = fsTool(context.cwd, {
    includeEditFile: true,
    experimentalHashlineEdit:
      context.editingToolMode === "edit_file" &&
      context.runtime.config?.tools.editFile.hashline === true,
    fsBackend: context.runtime.config?.tools.fsBackend,
    readFileDirectAttachmentSupported: getReadFileDirectAttachmentSupported(context),
    maxOutputBytes: context.runtime.config?.tools.output.maxPreviewBytes,
    maxInlineMediaBytesPerPart: context.runtime.config?.tools.media.maxInlineBytesPerPart,
    artifactOnly: context.requestContext?.safetyMode === "restricted",
    toolResultArtifacts: context.runtime.toolResultArtifacts,
    requestContext: context.requestContext
      ? {
          requestId: context.requestContext.requestId,
          sessionId: context.requestContext.sessionId,
        }
      : undefined,
    loadInstructions: true,
  });
  localFsToolsByBuildContext.set(context, tools);
  return tools;
}

function getFsReadOnlyTool(
  name: "read" | "glob" | "grep" | "fuzzy_search",
  context: CoreToolBuildContext,
): unknown {
  const tools = getFsTools(context);
  return tools[name];
}

function getEditFileTool(context: CoreToolBuildContext): unknown {
  return (getFsTools(context) as ReturnType<typeof fsTool> & { readonly edit?: unknown }).edit;
}

function isPathWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

class LocalApplyPatchGuardFailed extends TaggedError("LocalApplyPatchGuardFailed")<{
  readonly code?: string;
  readonly cause?: unknown;
  readonly message: string;
}> {}

async function captureLocalApplyPatchFs<T>(
  run: () => Promise<T>,
): Promise<ResultType<T, LocalApplyPatchGuardFailed>> {
  try {
    return Result.ok(await run());
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(
      new LocalApplyPatchGuardFailed({
        ...(errorCode(cause) === undefined ? {} : { code: errorCode(cause) }),
        cause,
        message: opaqueErrorMessage(cause, "Local patch filesystem operation failed"),
      }),
    );
  }
}

async function canonicalizeAsFarAsExists(
  inputPath: string,
): Promise<ResultType<string, LocalApplyPatchGuardFailed>> {
  let current = path.resolve(inputPath);
  const missingSegments: string[] = [];
  const followedSymlinks = new Set<string>();
  let symlinkHops = 0;

  while (true) {
    const canonical = await captureLocalApplyPatchFs(() => fs.realpath(current));
    if (canonical.status === "ok") {
      return Result.ok(path.resolve(canonical.value, ...missingSegments));
    }
    const code = canonical.error.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") return Result.err(canonical.error);

    const statsResult = await captureLocalApplyPatchFs(() => fs.lstat(current));
    const stats = statsResult.status === "ok" ? statsResult.value : undefined;
    if (stats?.isSymbolicLink()) {
      if (followedSymlinks.has(current) || ++symlinkHops > 40) {
        return Result.err(
          new LocalApplyPatchGuardFailed({
            message: `Too many symbolic links resolving '${inputPath}'`,
          }),
        );
      }
      followedSymlinks.add(current);
      const target = await captureLocalApplyPatchFs(() => fs.readlink(current));
      if (target.status === "error") return Result.err(target.error);
      current = path.isAbsolute(target.value)
        ? path.resolve(target.value)
        : path.resolve(path.dirname(current), target.value);
      continue;
    }

    const parent = path.dirname(current);
    if (parent === current) return Result.ok(path.resolve(current, ...missingSegments));
    missingSegments.unshift(path.basename(current));
    current = parent;
  }
}

async function assertLocalApplyPatchPathsAllowed(params: {
  input: ApplyPatchInput;
  defaultCwd: string;
  denyPath: string;
}): Promise<ResultType<void, Error>> {
  const cwdTarget = parseSshCwdTarget(params.input.cwd ?? params.defaultCwd);
  if (cwdTarget.kind !== "local") return Result.ok(undefined);

  const baseDir = path.resolve(expandTilde(cwdTarget.cwd || params.defaultCwd));
  const denyResolved = path.resolve(expandTilde(params.denyPath));
  const denyCanonicalResult = await captureLocalApplyPatchFs(() => fs.realpath(denyResolved));
  const denyCanonical =
    denyCanonicalResult.status === "ok" ? denyCanonicalResult.value : denyResolved;
  const parsed = parsePatchResult(params.input.patchText);
  if (parsed.status === "error") return Result.err(parsed.error);
  const hunks = parsed.value;
  const targets = hunks.flatMap((hunk) => [
    hunk.path,
    ...(hunk.type === "update" && hunk.movePath ? [hunk.movePath] : []),
  ]);

  // This closes ordinary lexical and symlink aliases, but remains a best-effort guardrail rather
  // than filesystem isolation: another process can still race path resolution and patch writes.
  for (const target of targets) {
    const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(baseDir, target);
    const canonicalResult = await canonicalizeAsFarAsExists(resolved);
    if (canonicalResult.status === "error") return Result.err(canonicalResult.error);
    const canonical = canonicalResult.value;
    if (
      isPathWithin(resolved, denyResolved) ||
      isPathWithin(resolved, denyCanonical) ||
      isPathWithin(canonical, denyResolved) ||
      isPathWithin(canonical, denyCanonical)
    ) {
      return Result.err(
        new LocalApplyPatchGuardFailed({
          message: `Access denied: '${resolved}' is blocked for patch`,
        }),
      );
    }
  }
  return Result.ok(undefined);
}

function signalBuiltinToolHostError(message: string): never {
  throw new Error(message);
}

function getApplyPatchTool(context: CoreToolBuildContext) {
  const denyPath = context.runtime.dataDir
    ? path.join(context.runtime.dataDir, "secret")
    : undefined;
  const guarded = applyPatchTool({
    cwd: context.cwd,
    denyPaths: denyPath ? [denyPath] : undefined,
  }).apply_patch;
  if (!denyPath) return guarded;

  const unrestricted = applyPatchTool({ cwd: context.cwd }).apply_patch;
  const guardedExecute = guarded.execute;
  const unrestrictedExecute = unrestricted.execute;
  if (!guardedExecute || !unrestrictedExecute) return guarded;

  return {
    ...guarded,
    description: `${guarded.description} Local denylist checks are best-effort guardrails, not filesystem isolation.`,
    execute: async (...args: Parameters<typeof guardedExecute>) => {
      const [input] = args;
      if (input.dangerouslyAllow === true) return unrestrictedExecute(...args);

      const allowed = await assertLocalApplyPatchPathsAllowed({
        input,
        defaultCwd: context.cwd,
        denyPath,
      });
      if (allowed.status === "error") {
        return {
          status: "failed" as const,
          output: allowed.error.message,
        };
      }
      return guardedExecute(...args);
    },
  };
}

function getDelegateHandler(requestContext: {
  metadata?: Readonly<Record<string, unknown>>;
}): DelegateHandler | undefined {
  return decodeCoreToolRequestMetadata(requestContext.metadata).onSubagentDelegate;
}

function getAgentActivityHandler(requestContext: {
  metadata?: Readonly<Record<string, unknown>>;
}): AgentActivityHandler | undefined {
  return decodeCoreToolRequestMetadata(requestContext.metadata).onActivity;
}

export const BUILTIN_LEVEL1_TOOLS = {
  bash: defineLevel1Tool("bounded", {
    name: "bash",
    isEnabled: () => true,
    formatArgs: formatBashToolArgs,
    summarizeFailure: ({ result }) => summarizeBashFailure(result),
    createTool: (context) => {
      const { cwd, runtime, requestContext, runProfile } = context;
      const onActivity = requestContext ? getAgentActivityHandler(requestContext) : undefined;
      const controlCapability = decodeCoreToolRequestMetadata(
        requestContext?.metadata,
      ).controlCapability;
      return bashToolWithCwd(cwd, {
        artifacts: runtime.toolResultArtifacts,
        outputConfig: runtime.config?.tools.output,
        onActivity: onActivity ? () => onActivity("tool") : undefined,
        controlCapability: typeof controlCapability === "string" ? controlCapability : undefined,
        nativeProfile:
          runProfile === "primary" || !runtime.config
            ? undefined
            : resolveNativeSubagentProfile(runtime.config, runProfile),
      }).bash;
    },
  }),
  read: defineLevel1Tool("bounded-and-aggregate-exempt", {
    name: "read",
    isEnabled: () => true,
    formatArgs: formatReadFileToolArgs,
    summarizeFailure: ({ result }) => summarizeReadOrEditFailure(result, "read"),
    createTool: (context) => getFsReadOnlyTool("read", context),
  }),
  glob: defineLevel1Tool("generic", {
    name: "glob",
    isEnabled: (context) => context.requestContext?.safetyMode !== "restricted",
    formatArgs: formatGlobToolArgs,
    summarizeFailure: ({ result }) => summarizeSearchFailure(result, "glob"),
    createTool: (context) => getFsReadOnlyTool("glob", context),
  }),
  grep: defineLevel1Tool("bounded-and-aggregate-exempt", {
    name: "grep",
    isEnabled: (context) => context.requestContext?.safetyMode !== "restricted",
    formatArgs: formatGrepToolArgs,
    summarizeFailure: ({ result }) => summarizeSearchFailure(result, "grep"),
    createTool: (context) => getFsReadOnlyTool("grep", context),
  }),
  fuzzy_search: defineLevel1Tool("generic", {
    name: "fuzzy_search",
    isEnabled: (context) =>
      context.runtime.config?.tools.fsBackend === "fff" &&
      context.requestContext?.safetyMode !== "restricted",
    formatArgs: formatFuzzySearchToolArgs,
    summarizeFailure: ({ result }) => summarizeSearchFailure(result, "fuzzy_search"),
    createTool: (context) => getFsReadOnlyTool("fuzzy_search", context),
  }),
  edit: defineLevel1Tool("bounded", {
    name: "edit",
    isEnabled: (context) =>
      context.editingToolMode === "edit_file" &&
      context.requestContext?.safetyMode !== "restricted",
    formatArgs: formatEditFileToolArgs,
    summarizeFailure: ({ result }) => summarizeReadOrEditFailure(result, "edit"),
    createTool: (context) => getEditFileTool(context),
    editTargets: (args, context) => {
      const decoded = editTargetInputSchema.safeParse(args);
      if (!decoded.success) {
        return signalBuiltinToolHostError("edit batch preflight requires valid input");
      }
      return collectEditFileTouchedPaths({
        path: decoded.data.path,
        cwd: decoded.data.cwd ?? context.cwd,
      });
    },
  }),
  patch: defineLevel1Tool("bounded", {
    name: "patch",
    isEnabled: (context) =>
      context.editingToolMode === "apply_patch" &&
      context.requestContext?.safetyMode !== "restricted",
    formatArgs: formatApplyPatchToolArgs,
    summarizeFailure: ({ result }) => summarizeApplyPatchFailure(result),
    createTool: (context) => getApplyPatchTool(context),
    editTargets: (args, context) => {
      const decoded = applyPatchInputSchema.safeParse(args);
      if (!decoded.success) {
        return signalBuiltinToolHostError("patch batch preflight requires valid input");
      }
      return collectApplyPatchTouchedPaths({
        patchText: decoded.data.patchText,
        cwd: decoded.data.cwd ?? context.cwd,
      });
    },
  }),
  subagent_delegate: defineLevel1Tool("bounded", {
    name: "subagent_delegate",
    isEnabled: ({ runtime, subagentConfig, subagentDepth, requestContext }) =>
      Boolean(runtime.bus) &&
      subagentConfig.enabled &&
      subagentDepth < subagentConfig.maxDepth &&
      requestContext?.safetyMode !== "restricted",
    formatArgs: formatSubagentDelegateToolArgs,
    summarizeFailure: ({ result }) => summarizeSubagentFailure(result),
    createTool: ({ runtime, subagentConfig, requestContext }) => {
      if (!runtime.bus) {
        return signalBuiltinToolHostError("subagent_delegate requires bus");
      }
      return subagentTools({
        idleTimeoutMs: subagentConfig.idleTimeoutMs,
        maxDepth: subagentConfig.maxDepth,
        modelPresets: runtime.config?.models.def,
        delegatePromptOverlay: runtime.config?.agent.subagents.delegatePromptOverlay,
        onDelegate: requestContext ? getDelegateHandler(requestContext) : undefined,
      }).subagent_delegate;
    },
  }),
  batch: defineLevel1Tool("bounded", {
    name: "batch",
    supportsBatch: false,
    isEnabled: () => true,
    formatArgs: formatBatchToolArgs,
    summarizeFailure: ({ result }) => summarizeBatchFailure(result),
    createTool: ({
      cwd,
      editingToolMode,
      getTools,
      getLevel1ToolSpecs,
      resolveEditTargets,
      runtime,
    }) =>
      batchTool({
        defaultCwd: cwd,
        getTools,
        getToolSpecs: getLevel1ToolSpecs,
        resolveEditTargets,
        editingMode: editingToolMode,
        maxCalls: runtime.config?.tools.batch.maxCalls ?? 8,
      }).batch,
  }),
} satisfies {
  readonly [Name in Level1ToolName]: CoreLevel1ToolSpec & { readonly name: Name };
};

export function createLocalToolSpecs(): CoreLevel1ToolSpec[] {
  return LEVEL1_TOOL_NAMES.map((name) => BUILTIN_LEVEL1_TOOLS[name]);
}

export function createBuiltinLocalToolsPlugin(): CoreToolPlugin {
  return {
    meta: {
      id: "builtin-local-tools",
      name: "Built-in Local Tools",
    },
    create() {
      return {
        level1: createLocalToolSpecs(),
        level2: [] satisfies readonly ServerTool[],
      };
    },
  };
}
