import type { ServerTool } from "@stanley2058/lilac-plugin-runtime";
import { LEVEL1_TOOL_NAMES, type ApplyPatchInput } from "@stanley2058/lilac-coding-tools/schemas";
import { expandTilde } from "@stanley2058/lilac-fs";
import { resolveNativeSubagentProfile } from "@stanley2058/lilac-utils";
import fs from "node:fs/promises";
import path from "node:path";

import { parseSshCwdTarget } from "../../ssh/ssh-cwd";
import { applyPatchTool } from "../../tools/apply-patch";
import { parsePatch } from "../../tools/apply-patch/local-apply-patch-tool";
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

function getReadFileDirectAttachmentSupported(context: CoreToolBuildContext): boolean {
  return context.requestContext?.metadata?.["readFileDirectAttachmentSupported"] === true;
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
  return (getFsTools(context) as Record<string, unknown>)["edit_file"];
}

function isPathWithin(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function canonicalizeAsFarAsExists(inputPath: string): Promise<string> {
  let current = path.resolve(inputPath);
  const missingSegments: string[] = [];
  const followedSymlinks = new Set<string>();
  let symlinkHops = 0;

  while (true) {
    try {
      return path.resolve(await fs.realpath(current), ...missingSegments);
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? Reflect.get(error, "code")
          : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;

      const stats = await fs.lstat(current).catch(() => undefined);
      if (stats?.isSymbolicLink()) {
        if (followedSymlinks.has(current) || ++symlinkHops > 40) {
          throw new Error(`Too many symbolic links resolving '${inputPath}'`);
        }
        followedSymlinks.add(current);
        const target = await fs.readlink(current);
        current = path.isAbsolute(target)
          ? path.resolve(target)
          : path.resolve(path.dirname(current), target);
        continue;
      }

      const parent = path.dirname(current);
      if (parent === current) return path.resolve(current, ...missingSegments);
      missingSegments.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function assertLocalApplyPatchPathsAllowed(params: {
  input: ApplyPatchInput;
  defaultCwd: string;
  denyPath: string;
}): Promise<void> {
  const cwdTarget = parseSshCwdTarget(params.input.cwd ?? params.defaultCwd);
  if (cwdTarget.kind !== "local") return;

  const baseDir = path.resolve(expandTilde(cwdTarget.cwd || params.defaultCwd));
  const denyResolved = path.resolve(expandTilde(params.denyPath));
  const denyCanonical = await fs.realpath(denyResolved).catch(() => denyResolved);
  const hunks = parsePatch(params.input.patchText);
  const targets = hunks.flatMap((hunk) => [
    hunk.path,
    ...(hunk.type === "update" && hunk.movePath ? [hunk.movePath] : []),
  ]);

  // This closes ordinary lexical and symlink aliases, but remains a best-effort guardrail rather
  // than filesystem isolation: another process can still race path resolution and patch writes.
  for (const target of targets) {
    const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(baseDir, target);
    const canonical = await canonicalizeAsFarAsExists(resolved);
    if (
      isPathWithin(resolved, denyResolved) ||
      isPathWithin(resolved, denyCanonical) ||
      isPathWithin(canonical, denyResolved) ||
      isPathWithin(canonical, denyCanonical)
    ) {
      throw new Error(`Access denied: '${resolved}' is blocked for apply_patch`);
    }
  }
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

      try {
        await assertLocalApplyPatchPathsAllowed({ input, defaultCwd: context.cwd, denyPath });
      } catch (error) {
        return {
          status: "failed" as const,
          output: error instanceof Error ? error.message : String(error),
        };
      }
      return guardedExecute(...args);
    },
  };
}

function withBuiltinMetadata(spec: CoreLevel1ToolSpec): CoreLevel1ToolSpec {
  return {
    ...spec,
    formatArgs: spec.formatArgs ?? BUILTIN_LEVEL1_TOOL_ARGS_FORMATTERS[spec.name],
    summarizeFailure:
      spec.summarizeFailure ??
      (BUILTIN_LEVEL1_TOOL_FAILURE_SUMMARIZERS[spec.name]
        ? ({ result }) => BUILTIN_LEVEL1_TOOL_FAILURE_SUMMARIZERS[spec.name]!(result)
        : undefined),
  };
}

function withBoundedOutput(spec: CoreLevel1ToolSpec): CoreLevel1ToolSpec {
  return markBoundedBuiltinOutput(withBuiltinMetadata(spec));
}

function getDelegateHandler(requestContext: {
  metadata?: Readonly<Record<string, unknown>>;
}):
  | ((registration: SubagentDelegationRegistration) => Promise<SubagentDelegationHandle>)
  | undefined {
  const candidate = requestContext.metadata?.["onSubagentDelegate"];
  return typeof candidate === "function"
    ? (candidate as (
        registration: SubagentDelegationRegistration,
      ) => Promise<SubagentDelegationHandle>)
    : undefined;
}

function getAgentActivityHandler(requestContext: {
  metadata?: Readonly<Record<string, unknown>>;
}): ((source: "tool" | "subagent") => void) | undefined {
  const candidate = requestContext.metadata?.["onActivity"];
  return typeof candidate === "function"
    ? (candidate as (source: "tool" | "subagent") => void)
    : undefined;
}

export function createLocalToolSpecs(): CoreLevel1ToolSpec[] {
  const specs = [
    withBoundedOutput({
      name: "bash",
      isEnabled: () => true,
      createTool: (context) => {
        const { cwd, runtime, requestContext, runProfile } = context;
        const onActivity = requestContext ? getAgentActivityHandler(requestContext) : undefined;
        const controlCapability = requestContext?.metadata?.["controlCapability"];
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
        const record = args as Record<string, unknown>;
        if (typeof record.path !== "string") {
          throw new Error("edit_file batch preflight requires string path");
        }
        return collectEditFileTouchedPaths({ path: record.path, cwd: context.cwd });
      },
    }),
    withBoundedOutput({
      name: "apply_patch",
      isEnabled: (context) =>
        context.editingToolMode === "apply_patch" &&
        context.requestContext?.safetyMode !== "restricted",
      createTool: (context) => getApplyPatchTool(context),
      editTargets: (args, context) => {
        const record = args as Record<string, unknown>;
        if (typeof record.patchText !== "string") {
          throw new Error("apply_patch batch preflight requires string patchText");
        }
        return collectApplyPatchTouchedPaths({ patchText: record.patchText, cwd: context.cwd });
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
          throw new Error("subagent_delegate requires bus");
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
    throw new Error(`Built-in Level-1 registry does not match coding-tools: ${names.join(", ")}`);
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
