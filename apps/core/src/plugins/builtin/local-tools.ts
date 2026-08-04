import type { ServerTool } from "@stanley2058/lilac-plugin-runtime";
import {
  applyPatchInputSchema,
  editFileInputSchema,
  LEVEL1_TOOL_NAMES,
  type ApplyPatchInput,
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
import { BUILTIN_LEVEL1_TOOL_FAILURE_SUMMARIZERS } from "../../surface/bridge/bus-agent-runner/tool-failure-logging";
import { BUILTIN_LEVEL1_TOOL_ARGS_FORMATTERS } from "../../tools/tool-args-display";
import {
  markAggregateOutputBudgetExempt,
  markBoundedBuiltinOutput,
  type CoreLevel1ToolSpec,
  type CoreToolPlugin,
} from "../types";

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
  name: "read_file" | "glob" | "grep" | "fuzzy_search",
  context: CoreToolBuildContext,
): unknown {
  const tools = getFsTools(context);
  return tools[name];
}

function getEditFileTool(context: CoreToolBuildContext): unknown {
  return (getFsTools(context) as ReturnType<typeof fsTool> & { readonly edit_file?: unknown })
    .edit_file;
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
        message: opaqueErrorMessage(cause, "Local apply_patch filesystem operation failed"),
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
          message: `Access denied: '${resolved}' is blocked for apply_patch`,
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

function withBuiltinMetadata(spec: CoreLevel1ToolSpec): CoreLevel1ToolSpec {
  const failureSummarizer = BUILTIN_LEVEL1_TOOL_FAILURE_SUMMARIZERS[spec.name];
  return {
    ...spec,
    formatArgs: spec.formatArgs ?? BUILTIN_LEVEL1_TOOL_ARGS_FORMATTERS[spec.name],
    summarizeFailure:
      spec.summarizeFailure ??
      (failureSummarizer ? (params) => failureSummarizer(params.result) : undefined),
  };
}

function withBoundedOutput(spec: CoreLevel1ToolSpec): CoreLevel1ToolSpec {
  return markBoundedBuiltinOutput(withBuiltinMetadata(spec));
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

export function createLocalToolSpecs(): CoreLevel1ToolSpec[] {
  const specs = [
    withBoundedOutput({
      name: "bash",
      isEnabled: () => true,
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
    markAggregateOutputBudgetExempt(
      withBoundedOutput({
        name: "read_file",
        isEnabled: () => true,
        createTool: (context) => getFsReadOnlyTool("read_file", context),
      }),
    ),
    withBuiltinMetadata({
      name: "glob",
      isEnabled: (context) => context.requestContext?.safetyMode !== "restricted",
      createTool: (context) => getFsReadOnlyTool("glob", context),
    }),
    withBuiltinMetadata({
      name: "grep",
      isEnabled: (context) => context.requestContext?.safetyMode !== "restricted",
      createTool: (context) => getFsReadOnlyTool("grep", context),
    }),
    withBuiltinMetadata({
      name: "fuzzy_search",
      isEnabled: (context) =>
        context.runtime.config?.tools.fsBackend === "fff" &&
        context.requestContext?.safetyMode !== "restricted",
      createTool: (context) => getFsReadOnlyTool("fuzzy_search", context),
    }),
    withBoundedOutput({
      name: "edit_file",
      isEnabled: (context) =>
        context.editingToolMode === "edit_file" &&
        context.requestContext?.safetyMode !== "restricted",
      createTool: (context) => getEditFileTool(context),
      editTargets: (args, context) => {
        const decoded = editFileInputSchema.safeParse(args);
        if (!decoded.success) {
          return signalBuiltinToolHostError("edit_file batch preflight requires valid input");
        }
        return collectEditFileTouchedPaths({ path: decoded.data.path, cwd: context.cwd });
      },
    }),
    withBoundedOutput({
      name: "apply_patch",
      isEnabled: (context) =>
        context.editingToolMode === "apply_patch" &&
        context.requestContext?.safetyMode !== "restricted",
      createTool: (context) => getApplyPatchTool(context),
      editTargets: (args, context) => {
        const decoded = applyPatchInputSchema.safeParse(args);
        if (!decoded.success) {
          return signalBuiltinToolHostError("apply_patch batch preflight requires valid input");
        }
        return collectApplyPatchTouchedPaths({
          patchText: decoded.data.patchText,
          cwd: context.cwd,
        });
      },
    }),
    withBoundedOutput({
      name: "subagent_delegate",
      isEnabled: ({ runtime, subagentConfig, subagentDepth, requestContext }) =>
        Boolean(runtime.bus) &&
        subagentConfig.enabled &&
        subagentDepth < subagentConfig.maxDepth &&
        requestContext?.safetyMode !== "restricted",
      createTool: ({ runtime, subagentConfig, requestContext }) => {
        if (!runtime.bus) {
          return signalBuiltinToolHostError("subagent_delegate requires bus");
        }
        const onActivity = requestContext ? getAgentActivityHandler(requestContext) : undefined;
        return subagentTools({
          bus: runtime.bus,
          idleTimeoutMs: subagentConfig.idleTimeoutMs,
          maxDepth: subagentConfig.maxDepth,
          modelPresets: runtime.config?.models.def,
          delegatePromptOverlay: runtime.config?.agent.subagents.delegatePromptOverlay,
          onDelegate: requestContext ? getDelegateHandler(requestContext) : undefined,
          onActivity: onActivity ? () => onActivity("subagent") : undefined,
        }).subagent_delegate;
      },
    }),
    withBoundedOutput({
      name: "batch",
      supportsBatch: false,
      isEnabled: () => true,
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
  ];
  const names = specs.map((spec) => spec.name);
  if (
    names.length !== LEVEL1_TOOL_NAMES.length ||
    names.some((name, index) => name !== LEVEL1_TOOL_NAMES[index])
  ) {
    return signalBuiltinToolHostError(
      `Built-in Level-1 registry does not match coding-tools: ${names.join(", ")}`,
    );
  }
  return specs;
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
