import { asSchema, type FlexibleSchema } from "ai";
import { z } from "zod";
import type { Level1ToolSpec } from "@stanley2058/lilac-plugin-runtime";
import { isRecord } from "@stanley2058/lilac-utils";

import { formatRemoteDisplayPath, parseSshCwdTarget } from "../ssh/ssh-cwd";
import { bashInputSchema } from "./bash";

function safeValidateSync(
  schema: FlexibleSchema<unknown> | z.ZodType<unknown> | undefined,
  value: unknown,
): unknown | undefined {
  try {
    const candidate: unknown = schema;
    if (isRecord(candidate) && typeof candidate["safeParse"] === "function") {
      const result: unknown = candidate["safeParse"](value);
      return isRecord(result) && result["success"] === true ? result["data"] : undefined;
    }

    const validate = asSchema(schema).validate;
    if (!validate) return undefined;

    const result = validate(value);
    if ("then" in result) return undefined;

    return result.success ? result.value : undefined;
  } catch {
    return undefined;
  }
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

export type ToolArgsFormatter = (args: unknown) => string;

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

function getGrepArgs(value: unknown): { pattern: string; cwd?: string } | null {
  if (!isRecord(value) || typeof value["pattern"] !== "string") return null;
  return {
    pattern: value["pattern"],
    cwd: typeof value["cwd"] === "string" ? value["cwd"] : undefined,
  };
}

function getFuzzySearchArgs(value: unknown): { query: string; cwd?: string } | null {
  if (!isRecord(value) || typeof value["query"] !== "string") return null;
  return {
    query: value["query"],
    cwd: typeof value["cwd"] === "string" ? value["cwd"] : undefined,
  };
}

const readFileToolArgsFormatter: ToolArgsFormatter = (args) => {
  const parsedPath = getPathArg(args);
  if (!parsedPath) return "";

  const p = normalizeRemoteDisplay(parsedPath);
  if (!p) return "";
  return " " + truncateMiddle(p, PATH_HEAD_LEN, PATH_TAIL_LEN, DISPLAY_MAX_LEN);
};

export const BUILTIN_LEVEL1_TOOL_ARGS_FORMATTERS: Record<string, ToolArgsFormatter> = {
  bash: (args) => {
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
  },

  read_file: readFileToolArgsFormatter,

  // Back-compat for older transcripts / callers.
  readFile: readFileToolArgsFormatter,

  glob: (args) => {
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
  },

  grep: (args) => {
    const parsed = getGrepArgs(args);
    if (!parsed) return "";

    const pattern = parsed.pattern.replace(/\s+/g, " ").trim();
    if (!pattern) return "";

    const cwd = normalizeRemoteCwdDisplay(parsed.cwd ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const raw = cwd ? `${pattern} ${cwd}` : pattern;
    return " " + truncateEnd(raw, DISPLAY_MAX_LEN);
  },

  fuzzy_search: (args) => {
    const parsed = getFuzzySearchArgs(args);
    if (!parsed) return "";

    const query = parsed.query.replace(/\s+/g, " ").trim();
    if (!query) return "";

    const cwd = normalizeRemoteCwdDisplay(parsed.cwd ?? "")
      .replace(/\s+/g, " ")
      .trim();
    const raw = cwd ? `${query} ${cwd}` : query;
    return " " + truncateEnd(raw, DISPLAY_MAX_LEN);
  },

  subagent_delegate: (args) => {
    const parsed = safeValidateSync(subagentDelegateArgsSchema, args);
    if (!isRecord(parsed) || typeof parsed["task"] !== "string") return "";
    const task = parsed["task"].replace(/\s+/g, " ").trim();
    if (!task) return "";
    const profile = typeof parsed["profile"] === "string" ? parsed["profile"] : "explore";
    return " " + truncateEnd(`(${profile}) ${task}`, DISPLAY_MAX_LEN);
  },

  apply_patch: (args) => {
    const localParsed = safeValidateSync(localApplyPatchArgsSchema, args);
    if (!isRecord(localParsed) || typeof localParsed["patchText"] !== "string") return "";

    const paths = parseApplyPatchPathsFromPatchText(localParsed["patchText"]);
    const first = (paths[0] ?? "").trim();
    if (!first) return "";

    const remaining = Math.max(0, paths.length - 1);
    const suffix = remaining > 0 ? ` (+${remaining})` : "";
    return " " + truncateMiddle(first, PATH_HEAD_LEN, PATH_TAIL_LEN, DISPLAY_MAX_LEN) + suffix;
  },

  edit_file: (args) => {
    const parsedPath = getPathArg(args);
    if (!parsedPath) return "";

    const p = normalizeRemoteDisplay(parsedPath);
    if (!p) return "";
    return " " + truncateMiddle(p, PATH_HEAD_LEN, PATH_TAIL_LEN, DISPLAY_MAX_LEN);
  },

  batch: (args) => {
    const parsed = safeValidateSync(batchArgsSchema, args);
    if (!isRecord(parsed) || !Array.isArray(parsed["tool_calls"])) return "";

    const n = parsed["tool_calls"].length;
    if (!Number.isFinite(n) || n <= 0) return "";
    return ` (${n} tools)`;
  },
};

export function formatToolArgsForDisplay(toolName: string, args: unknown): string {
  const f = BUILTIN_LEVEL1_TOOL_ARGS_FORMATTERS[toolName];
  try {
    return f ? f(args) : "";
  } catch {
    return "";
  }
}

export function formatToolArgsForDisplayWithSpecs(
  toolName: string,
  args: unknown,
  toolSpecs?: ReadonlyMap<string, Level1ToolSpec<unknown>>,
): string {
  const spec = toolSpecs?.get(toolName);
  if (spec?.formatArgs) {
    try {
      return spec.formatArgs(args);
    } catch {
      return "";
    }
  }

  const f = BUILTIN_LEVEL1_TOOL_ARGS_FORMATTERS[toolName];
  if (!f) return "";
  try {
    return f(args);
  } catch {
    return "";
  }
}
