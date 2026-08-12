import { asSchema, type FlexibleSchema } from "ai";
import { z } from "zod";
import {
  getLevel1ContributionSnapshot,
  invokeLevel1FormatArgs,
  type Level1ContributionInfo,
  type Level1ToolSpec,
} from "@stanley2058/lilac-plugin-runtime";
import { isRecord } from "@stanley2058/lilac-utils";
import { Result } from "better-result";

import { projectRuntimeError } from "../runtime/error-format";
import { formatRemoteDisplayPath, parseSshCwdTarget } from "../ssh/ssh-cwd";
import { bashInputSchema } from "./bash";
import { preserveToolPanic } from "./tool-result-adapters";

function safeValidateSync(
  schema: FlexibleSchema<unknown> | z.ZodType<unknown> | undefined,
  value: unknown,
): unknown | undefined {
  const validated = Result.try({
    try: () => {
      if (schema instanceof z.ZodType) {
        const result = schema.safeParse(value);
        return result.success ? result.data : undefined;
      }

      const validate = asSchema(schema).validate;
      if (!validate) return undefined;
      const result = validate(value);
      if ("then" in result) return undefined;
      return result.success ? result.value : undefined;
    },
    catch: projectRuntimeError("Opaque tool argument validation failure"),
  });
  if (validated.status === "ok") return validated.value;
  preserveToolPanic(validated.error);
  return undefined;
}

function truncateEnd(input: string, maxLen: number): string {
  const s = input;
  if (s.length <= maxLen) return s;
  if (maxLen <= 3) return "...".slice(0, maxLen);
  return s.slice(0, maxLen - 3) + "...";
}

function truncateMiddle(input: string, headLen: number, tailLen: number, maxLen: number): string {
  const s = input;
  if (s.length <= maxLen) return s;
  const ellipsis = "...";
  const keep = headLen + tailLen + ellipsis.length;
  if (keep !== maxLen) {
    // Safety: ensure we never exceed maxLen even if caller misconfigures.
    return truncateEnd(s, maxLen);
  }
  return s.slice(0, headLen) + ellipsis + s.slice(-tailLen);
}

const localApplyPatchArgsSchema = z.object({
  patchText: z.string(),
  cwd: z.string().optional(),
});

const subagentDelegateArgsSchema = z.object({
  profile: z.enum(["explore", "general", "self"]).optional(),
  task: z.string().min(1),
  timeoutMs: z.number().optional(),
});

const batchArgsSchema = z.object({
  tool_calls: z.array(z.unknown()),
});

function parseApplyPatchPathsFromPatchText(patchText: string): string[] {
  // Matches tool patch headers like:
  // *** Add File: path
  // *** Update File: path
  // *** Delete File: path
  const re = /^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+)\s*$/gm;
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(patchText)) !== null) {
    const p = (m[1] ?? "").trim();
    if (!p) continue;
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

export type ToolArgsFormatter = NonNullable<Level1ToolSpec<unknown>["formatArgs"]>;

const DISPLAY_MAX_LEN = 30;
const PATH_HEAD_LEN = 14;
const PATH_TAIL_LEN = 13;

function normalizeRemoteDisplay(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";

  const sshUrlMatch = /^ssh:\/\/([^/]+)(\/.*)?$/i.exec(trimmed);
  if (sshUrlMatch) {
    const host = sshUrlMatch[1] ?? "";
    const remotePath = sshUrlMatch[2] ?? "~";
    return formatRemoteDisplayPath(host, remotePath);
  }

  return trimmed;
}

function normalizeRemoteCwdDisplay(input: string): string {
  const normalized = normalizeRemoteDisplay(input);
  if (!normalized) return "";

  const cwdTarget = parseSshCwdTarget(normalized);
  if (cwdTarget.kind === "ssh") {
    return formatRemoteDisplayPath(cwdTarget.host, cwdTarget.cwd);
  }

  return normalized;
}

function getPathArg(value: unknown): string | null {
  return isRecord(value) && typeof value["path"] === "string" ? value["path"] : null;
}

function getGlobArgs(value: unknown): { patterns: string[]; cwd?: string } | null {
  if (!isRecord(value)) return null;
  const rawPatterns = value["patterns"];
  if (!Array.isArray(rawPatterns)) return null;
  const patterns = rawPatterns.filter((item): item is string => typeof item === "string");
  if (patterns.length === 0) return null;
  return {
    patterns,
    cwd: typeof value["cwd"] === "string" ? value["cwd"] : undefined,
  };
}

function getGrepArgs(value: unknown): { pattern: string; path?: string } | null {
  if (!isRecord(value) || typeof value["pattern"] !== "string") return null;
  return {
    pattern: value["pattern"],
    path: typeof value["path"] === "string" ? value["path"] : undefined,
  };
}

function getFuzzySearchArgs(value: unknown): { query: string; cwd?: string } | null {
  if (!isRecord(value) || typeof value["query"] !== "string") return null;
  return {
    query: value["query"],
    cwd: typeof value["cwd"] === "string" ? value["cwd"] : undefined,
  };
}

export const formatReadFileToolArgs: ToolArgsFormatter = (args) => {
  const parsedPath = getPathArg(args);
  if (!parsedPath) return "";

  const p = normalizeRemoteDisplay(parsedPath);
  if (!p) return "";
  return " " + truncateMiddle(p, PATH_HEAD_LEN, PATH_TAIL_LEN, DISPLAY_MAX_LEN);
};

export const formatBashToolArgs: ToolArgsFormatter = (args) => {
  const parsed = safeValidateSync(bashInputSchema, args);
  if (!isRecord(parsed) || typeof parsed["command"] !== "string") return "";

  const cmd = parsed["command"].replace(/\s+/g, " ").trim();
  if (!cmd) return "";

  const cwd = (typeof parsed["cwd"] === "string" ? parsed["cwd"] : "").trim();
  const cwdTarget = parseSshCwdTarget(cwd);
  const display =
    cwdTarget.kind === "ssh"
      ? `${formatRemoteDisplayPath(cwdTarget.host, cwdTarget.cwd)} ${cmd}`
      : cmd;

  return " " + truncateEnd(display, DISPLAY_MAX_LEN);
};

export const formatGlobToolArgs: ToolArgsFormatter = (args) => {
  const parsed = getGlobArgs(args);
  if (!parsed) return "";

  const joinedPatterns = parsed.patterns
    .map((p) => p.trim())
    .filter(Boolean)
    .join(",");
  if (!joinedPatterns) return "";

  const cwd = normalizeRemoteCwdDisplay(parsed.cwd ?? "");
  const raw = cwd ? `${joinedPatterns} ${cwd}` : joinedPatterns;
  const display = raw.replace(/\s+/g, " ").trim();
  return " " + truncateEnd(display, DISPLAY_MAX_LEN);
};

export const formatGrepToolArgs: ToolArgsFormatter = (args) => {
  const parsed = getGrepArgs(args);
  if (!parsed) return "";

  const pattern = parsed.pattern.replace(/\s+/g, " ").trim();
  if (!pattern) return "";

  const target = (
    parsed.path?.startsWith("tool-result://")
      ? parsed.path
      : normalizeRemoteCwdDisplay(parsed.path ?? "")
  )
    .replace(/\s+/g, " ")
    .trim();
  const raw = target ? `${pattern} ${target}` : pattern;
  return " " + truncateEnd(raw, DISPLAY_MAX_LEN);
};

export const formatFuzzySearchToolArgs: ToolArgsFormatter = (args) => {
  const parsed = getFuzzySearchArgs(args);
  if (!parsed) return "";

  const query = parsed.query.replace(/\s+/g, " ").trim();
  if (!query) return "";

  const cwd = normalizeRemoteCwdDisplay(parsed.cwd ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const raw = cwd ? `${query} ${cwd}` : query;
  return " " + truncateEnd(raw, DISPLAY_MAX_LEN);
};

export const formatSubagentDelegateToolArgs: ToolArgsFormatter = (args) => {
  const parsed = safeValidateSync(subagentDelegateArgsSchema, args);
  if (!isRecord(parsed) || typeof parsed["task"] !== "string") return "";
  const task = parsed["task"].replace(/\s+/g, " ").trim();
  if (!task) return "";
  const profile = typeof parsed["profile"] === "string" ? parsed["profile"] : "explore";
  return " " + truncateEnd(`(${profile}) ${task}`, DISPLAY_MAX_LEN);
};

export const formatApplyPatchToolArgs: ToolArgsFormatter = (args) => {
  const localParsed = safeValidateSync(localApplyPatchArgsSchema, args);
  if (!isRecord(localParsed) || typeof localParsed["patchText"] !== "string") return "";

  const paths = parseApplyPatchPathsFromPatchText(localParsed["patchText"]);
  const first = (paths[0] ?? "").trim();
  if (!first) return "";

  const remaining = Math.max(0, paths.length - 1);
  const suffix = remaining > 0 ? ` (+${remaining})` : "";
  return " " + truncateMiddle(first, PATH_HEAD_LEN, PATH_TAIL_LEN, DISPLAY_MAX_LEN) + suffix;
};

export const formatEditFileToolArgs: ToolArgsFormatter = (args) => {
  const parsedPath = getPathArg(args);
  if (!parsedPath) return "";

  const p = normalizeRemoteDisplay(parsedPath);
  if (!p) return "";
  return " " + truncateMiddle(p, PATH_HEAD_LEN, PATH_TAIL_LEN, DISPLAY_MAX_LEN);
};

export const formatBatchToolArgs: ToolArgsFormatter = (args) => {
  const parsed = safeValidateSync(batchArgsSchema, args);
  if (!isRecord(parsed) || !Array.isArray(parsed["tool_calls"])) return "";

  const n = parsed["tool_calls"].length;
  if (!Number.isFinite(n) || n <= 0) return "";
  return ` (${n} tools)`;
};

export function formatToolArgsForDisplay(toolName: string, args: unknown): string {
  switch (toolName) {
    case "read":
    case "read_file":
    case "readFile":
      return formatReadFileToolArgs(args);
    case "edit":
    case "edit_file":
      return formatEditFileToolArgs(args);
    case "patch":
    case "apply_patch":
      return formatApplyPatchToolArgs(args);
    default:
      return "";
  }
}

export function formatToolArgsForDisplayWithSpecs(
  toolName: string,
  args: unknown,
  toolSpecs?: ReadonlyMap<string, Level1ToolSpec<unknown>>,
  contributionInfo?: ReadonlyMap<Level1ToolSpec<unknown>, Level1ContributionInfo>,
): string {
  const spec = toolSpecs?.get(toolName);
  if (spec) {
    const contribution = contributionInfo?.get(spec) ??
      getLevel1ContributionSnapshot(spec) ?? {
        pluginId: `level1:${toolName}`,
        source: "builtin",
      };
    const formatted = invokeLevel1FormatArgs({
      pluginId: contribution.pluginId,
      source: contribution.source,
      spec,
      args,
    });
    return formatted.status === "ok" ? (formatted.value ?? "") : "";
  }

  return formatToolArgsForDisplay(toolName, args);
}
