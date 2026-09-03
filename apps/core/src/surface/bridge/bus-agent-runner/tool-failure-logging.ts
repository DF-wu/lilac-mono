import {
  getLevel1ContributionSnapshot,
  invokeLevel1SummarizeFailure,
  type Level1ContributionInfo,
  type Level1ToolFailureSummary,
  type Level1ToolSpec,
} from "@stanley2058/lilac-plugin-runtime";
import { isRecord } from "@stanley2058/lilac-utils";
import { Result } from "better-result";

import { redactSecrets } from "../../../tools/bash-safety/format";
import { bashOutputSchema } from "../../../tools/bash";

const SENSITIVE_KEYS = new Set([
  "authorization",
  "Authorization",
  "apiKey",
  "apikey",
  "token",
  "access",
  "refresh",
  "idToken",
  "code",
  "pkceVerifier",
  "privateKey",
  "privateKeyPem",
  "private_key",
  "pem",
  "keyPath",
  "password",
]);

const DEFAULT_PREVIEW_MAX_CHARS = 4_000;

export type ToolFailureSummary = Level1ToolFailureSummary;

function getStringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const v = value[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function getNumberField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const v = value[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function getBooleanField(value: unknown, key: string): boolean | undefined {
  if (!isRecord(value)) return undefined;
  const v = value[key];
  return typeof v === "boolean" ? v : undefined;
}

function toSerializablePreview(value: unknown, maxChars?: number): string {
  const seen = new WeakSet<object>();

  const serialized = Result.try({
    try: () =>
      JSON.stringify(value, (key, nested) => {
        if (SENSITIVE_KEYS.has(key)) return "<redacted>";

        if (nested instanceof Error) {
          return {
            name: nested.name,
            message: nested.message,
            stack: nested.stack,
          };
        }

        if (typeof nested === "bigint") {
          return nested.toString();
        }

        if (isRecord(nested)) {
          if (seen.has(nested)) return "<circular>";
          seen.add(nested);
        }

        return nested;
      }),
    catch: () => undefined,
  });
  const raw = serialized.match({ ok: (text) => text, err: () => String(value) });

  const redacted = redactSecrets(raw);
  if (maxChars === undefined || maxChars <= 0) return redacted;
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, maxChars)}...`;
}

function oneLine(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function defaultErrorFromResult(result: unknown): string {
  if (typeof result === "string" && result.length > 0) return result;
  if (result instanceof Error) return result.message;

  const message = getStringField(result, "message");
  if (message) return message;

  return oneLine(toSerializablePreview(result, 500));
}

export function summarizeBashFailure(result: unknown): ToolFailureSummary {
  const decoded = bashOutputSchema.safeParse(result);
  if (!decoded.success) {
    return {
      ok: false,
      failureKind: "hard",
      failureClass: "unknown",
      failureCode: "invalid_result",
      error: "bash returned an invalid result",
    };
  }

  const { executionError, exitCode } = decoded.data;

  if (executionError !== undefined) {
    switch (executionError.type) {
      case "blocked":
        return {
          ok: false,
          failureKind: "hard",
          failureClass: "policy",
          failureCode: executionError.code,
          retryable: false,
          error: executionError.hint
            ? `${executionError.reason} Hint: ${executionError.hint}`
            : executionError.reason,
        };
      case "timeout":
        return {
          ok: false,
          failureKind: "hard",
          failureClass: "timeout",
          failureCode: executionError.code,
          error: `bash timed out after ${executionError.timeoutMs}ms`,
        };
      case "aborted":
        return {
          ok: false,
          failureKind: "hard",
          failureClass: "cancelled",
          failureCode: executionError.code,
          retryable: false,
          error: "bash execution was cancelled",
        };
      case "exception":
        return {
          ok: false,
          failureKind: "hard",
          failureClass: executionError.phase === "spawn" ? "environment" : "tool",
          failureCode: executionError.code,
          ...(executionError.code === "spawn_cwd_missing" ? { retryable: false } : {}),
          error: executionError.message,
        };
    }
  }

  if (exitCode !== 0) {
    return {
      ok: false,
      failureKind: "soft",
      failureClass: "tool",
      failureCode: "nonzero_exit",
      exitCode,
      error: "bash command exited with a nonzero status",
    };
  }

  return { ok: true };
}

export function summarizeReadOrEditFailure(result: unknown, toolName: string): ToolFailureSummary {
  const success = getBooleanField(result, "success");
  if (success === false) {
    const error = isRecord(result) ? result["error"] : undefined;
    const message = getStringField(error, "message");
    return {
      ok: false,
      failureKind: "soft",
      error: message ?? `${toolName} failed`,
    };
  }
  return { ok: true };
}

export function summarizeSearchFailure(result: unknown, toolName: string): ToolFailureSummary {
  const error = getStringField(result, "error");
  if (error) {
    return {
      ok: false,
      failureKind: "soft",
      error: `${toolName} failed: ${error}`,
    };
  }
  return { ok: true };
}

export function summarizeApplyPatchFailure(result: unknown): ToolFailureSummary {
  const status = getStringField(result, "status");
  if (status === "failed") {
    const output = getStringField(result, "output");
    return {
      ok: false,
      failureKind: "soft",
      error: output ?? "patch failed",
    };
  }
  return { ok: true };
}

export function summarizeBatchFailure(result: unknown): ToolFailureSummary {
  const ok = getBooleanField(result, "ok");
  if (ok === false) {
    const failed = getNumberField(result, "failed");
    const total = getNumberField(result, "total");
    const suffix =
      typeof failed === "number" && typeof total === "number" ? ` (${failed}/${total} failed)` : "";
    return {
      ok: false,
      failureKind: "soft",
      error: `batch failed${suffix}`,
    };
  }
  return { ok: true };
}

export function summarizeSubagentFailure(result: unknown): ToolFailureSummary {
  const ok = getBooleanField(result, "ok");
  if (ok === false) {
    const detail = getStringField(result, "detail");
    const status = getStringField(result, "status");
    return {
      ok: false,
      failureKind: "soft",
      error: detail ?? (status ? `subagent ${status}` : "subagent failed"),
    };
  }
  return { ok: true };
}

export function summarizeToolFailure(params: {
  toolName: string;
  isError: boolean;
  result?: unknown;
  event?: { readonly result: unknown };
  toolSpecs?: ReadonlyMap<string, Level1ToolSpec<unknown>>;
  contributionInfo?: ReadonlyMap<Level1ToolSpec<unknown>, Level1ContributionInfo>;
}): ToolFailureSummary {
  const { toolName, isError, toolSpecs, contributionInfo } = params;
  const result = params.event ? params.event.result : params.result;

  if (isError) {
    return {
      ok: false,
      failureKind: "hard",
      failureClass: "unknown",
      failureCode: "host_execution_error",
      error: defaultErrorFromResult(result),
    };
  }

  const spec = toolSpecs?.get(toolName);
  if (spec) {
    const contribution = contributionInfo?.get(spec) ??
      getLevel1ContributionSnapshot(spec) ?? {
        pluginId: `level1:${toolName}`,
        source: "builtin",
      };
    const summary = invokeLevel1SummarizeFailure({
      pluginId: contribution.pluginId,
      source: contribution.source,
      spec,
      value: { isError: false, result },
    });
    return summary.match<ToolFailureSummary>({
      ok: (value) => value ?? { ok: true },
      err: () => ({ ok: true }),
    });
  }

  return { ok: true };
}

export function formatToolLogPreview(params: {
  toolName: string;
  value?: unknown;
  event?: { readonly args: unknown; readonly result: unknown };
  field?: "args" | "result";
  untruncated?: boolean;
}): string {
  const { untruncated } = params;
  const value = params.event && params.field ? params.event[params.field] : params.value;
  const maxChars = untruncated ? undefined : DEFAULT_PREVIEW_MAX_CHARS;
  return toSerializablePreview(value, maxChars);
}
