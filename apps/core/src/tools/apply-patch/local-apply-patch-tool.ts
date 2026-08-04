import { tool } from "ai";
import { z } from "zod";
import { createLogger, formatTaggedErrorForLog } from "@stanley2058/lilac-utils";
import { applyPatchInputSchema } from "@stanley2058/lilac-coding-tools/schemas";
import { Result, type Result as ResultType } from "better-result";

import { parseSshCwdTarget } from "../../ssh/ssh-cwd";
import {
  ApplyPatchAccessDenied,
  ApplyPatchOperationError,
  applyHunksResult,
  parsePatchResult as parseCorePatchResult,
  type PatchHunk,
  type ApplyPatchError,
} from "./apply-patch-core";
import { remoteApplyPatch } from "./remote-apply-patch";

const REMOTE_DENY_RELATIVE_DIRS = [".ssh", ".aws", ".gnupg"] as const;

function normalizeRelativePatchPath(p: string): string {
  let s = p.trim();
  while (s.startsWith("./")) s = s.slice(2);
  return s;
}

function isDeniedRemotePatchPath(remoteCwd: string, patchPath: string): boolean {
  // The remote denylist is intended to protect home-scoped secrets.
  // We only enforce a simple relative-path restriction when the remote cwd is ~.
  if (remoteCwd !== "~") return false;
  const s = normalizeRelativePatchPath(patchPath);
  for (const dir of REMOTE_DENY_RELATIVE_DIRS) {
    if (s === dir) return true;
    if (s.startsWith(`${dir}/`)) return true;
  }
  return false;
}

function deniedRemoteHunkPath(remoteCwd: string, hunk: PatchHunk): string | undefined {
  if (isDeniedRemotePatchPath(remoteCwd, hunk.path)) return hunk.path;
  if (
    hunk.type === "update" &&
    hunk.movePath &&
    isDeniedRemotePatchPath(remoteCwd, hunk.movePath)
  ) {
    return hunk.movePath;
  }
  return undefined;
}

const outputSchema = z.object({
  status: z.enum(["completed", "failed"]),
  output: z.string().optional(),
});

type PatchInput = z.infer<typeof applyPatchInputSchema>;

type ToolContext = {
  requestId: string;
  sessionId: string;
  requestClient: string;
};

const toolContextSchema = z.object({
  requestId: z.string().optional(),
  sessionId: z.string().optional(),
  requestClient: z.string().optional(),
});

function decodeOptionalToolContext(context: unknown): Partial<ToolContext> | undefined {
  const decoded = toolContextSchema.safeParse(context);
  return decoded.success ? decoded.data : undefined;
}

function parsePatchResult(patchText: string): ResultType<PatchHunk[], ApplyPatchError> {
  const parsed = parseCorePatchResult(patchText);
  if (parsed.status === "ok") return Result.ok(parsed.value);
  return Result.err(
    new ApplyPatchOperationError({
      operation: "parsing the patch",
      cause: parsed.error,
      message: parsed.error.message,
    }),
  );
}

async function executeApplyPatchResult(params: {
  readonly input: PatchInput;
  readonly defaultCwd: string;
  readonly denyPaths?: readonly string[];
  readonly abortSignal?: AbortSignal;
}): Promise<ResultType<{ output: string; hunkCount: number }, ApplyPatchError>> {
  const cwd = params.input.cwd ?? params.defaultCwd;
  const cwdTarget = parseSshCwdTarget(cwd);
  const parsed = parsePatchResult(params.input.patchText);
  if (parsed.status === "error") return parsed;
  const hunks = parsed.value;

  if (cwdTarget.kind === "ssh") {
    if (!params.input.dangerouslyAllow) {
      for (const hunk of hunks) {
        const deniedPath = deniedRemoteHunkPath(cwdTarget.cwd, hunk);
        if (deniedPath) {
          return Result.err(
            new ApplyPatchAccessDenied({
              resolvedPath: deniedPath,
              operation: "apply_patch",
              message: `Access denied: '${deniedPath}' is blocked for apply_patch when cwd=${cwdTarget.cwd}`,
            }),
          );
        }
      }
    }

    const remote = await remoteApplyPatch({
      host: cwdTarget.host,
      cwd: cwdTarget.cwd,
      patchText: params.input.patchText,
      dangerouslyAllow: params.input.dangerouslyAllow,
      signal: params.abortSignal,
    });
    if (!remote.ok) {
      return Result.err(
        new ApplyPatchOperationError({
          operation: "applying the remote patch",
          cause: new Error(remote.error),
          message: remote.error,
        }),
      );
    }
    return Result.ok({ output: remote.output, hunkCount: hunks.length });
  }

  const applied = await applyHunksResult(cwd, hunks, {
    denyPaths: params.denyPaths,
    signal: params.abortSignal,
  });
  if (applied.status === "error") return applied;
  return Result.ok({ output: applied.value, hunkCount: hunks.length });
}

export function localApplyPatchTool(
  defaultCwd: string,
  options?: { denyPaths?: readonly string[] },
) {
  const logger = createLogger({
    module: "tool:apply_patch",
  });

  return {
    apply_patch: tool({
      description:
        "Apply a patch in '*** Begin Patch' format (*** Add/Update/Delete File, optional *** Move to:, @@ context blocks). Remote denylisted paths require dangerouslyAllow=true.",
      inputSchema: applyPatchInputSchema,
      outputSchema,
      execute: async (
        input: PatchInput,
        { context, abortSignal }: { context?: unknown; abortSignal?: AbortSignal },
      ) => {
        const ctx = decodeOptionalToolContext(context);
        const cwd = input.cwd ?? defaultCwd;
        const parsed = parsePatchResult(input.patchText);
        const hunks = parsed.status === "ok" ? parsed.value : [];
        logger.info("apply_patch start", {
          requestId: ctx?.requestId,
          sessionId: ctx?.sessionId,
          requestClient: ctx?.requestClient,
          cwd,
          dangerouslyAllow: input.dangerouslyAllow === true,
          hunkCount: hunks.length,
          added: hunks.filter((hunk) => hunk.type === "add").length,
          deleted: hunks.filter((hunk) => hunk.type === "delete").length,
          updated: hunks.filter((hunk) => hunk.type === "update").length,
          paths: hunks.map((hunk) => hunk.path).slice(0, 20),
          pathsTruncated: hunks.length > 20,
        });

        const applied = await executeApplyPatchResult({
          input,
          defaultCwd,
          denyPaths: options?.denyPaths,
          abortSignal,
        });
        if (applied.status === "error") {
          logger.error("apply_patch failed", {
            requestId: ctx?.requestId,
            sessionId: ctx?.sessionId,
            ok: false,
            ...formatTaggedErrorForLog(applied.error),
          });
          return { status: "failed" as const, output: applied.error.message };
        }

        const outputLines = applied.value.output.split("\n");
        const changedLines = outputLines
          .slice(1)
          .map((line) => line.trim())
          .filter(Boolean);
        logger.info("apply_patch done", {
          requestId: ctx?.requestId,
          sessionId: ctx?.sessionId,
          ok: true,
          changedCount: changedLines.length,
          changed: changedLines.slice(0, 20),
          changedTruncated: changedLines.length > 20,
        });
        return { status: "completed" as const, output: applied.value.output };
      },
    }),
  };
}
