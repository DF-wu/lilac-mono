import { createLogger, formatTaggedErrorForLog } from "@stanley2058/lilac-utils";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import { projectRuntimeError } from "../runtime/error-format";
import { adaptToolResultToHost, preserveToolPanic } from "./tool-result-adapters";

const logger = createLogger({ module: "tool:env" });

const MAX_TOOL_ENV_FILE_BYTES = 64 * 1024;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const RESERVED_PREFIXES = ["LILAC_", "LD_", "DYLD_", "NODE_", "BUN_"] as const;
const RESERVED_NAMES = new Set([
  "BASH_ENV",
  "BASHOPTS",
  "CDPATH",
  "ENV",
  "PROMPT_COMMAND",
  "SHELLOPTS",
  "PATH",
  "HOME",
  "SHELL",
  "PWD",
  "OLDPWD",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "DATA_DIR",
  "TOOL_SERVER_BACKEND_URL",
  "GIT_CONFIG_GLOBAL",
  "GNUPGHOME",
  "FORCE_COLOR",
  "NO_COLOR",
  "REDIS_URL",
]);

const toolEnvFileSchema = z.record(z.string(), z.unknown());
const expiresAtSchema = z
  .union([z.string(), z.number().finite()])
  .refine((value) => Number.isFinite(new Date(value).getTime()), {
    message: "expiresAt must be a valid date string or epoch-millisecond number",
  });
const toolEnvEntrySchema = z.union([
  z.string(),
  z
    .object({
      value: z.string(),
      expiresAt: expiresAtSchema.optional(),
    })
    .strict(),
]);

type ToolEnvEntry = z.output<typeof toolEnvEntrySchema>;

export class ToolEnvInvalidError extends TaggedError("ToolEnvInvalidError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class ToolEnvFileOperationError extends TaggedError("ToolEnvFileOperationError")<{
  readonly filePath: string;
  readonly operation: "inspect" | "read" | "parse";
  readonly cause: unknown;
  readonly message: string;
}> {}

async function captureToolEnvFileOperation<T>(params: {
  readonly filePath: string;
  readonly operation: "inspect" | "read";
  readonly run: () => Promise<T>;
}): Promise<ResultType<T, ToolEnvFileOperationError>> {
  const captured = await Result.tryPromise({
    try: params.run,
    catch: projectRuntimeError(`Opaque tool env ${params.operation} failure`),
  });
  if (captured.status === "error") {
    const cause = preserveToolPanic(captured.error);
    return Result.err(
      new ToolEnvFileOperationError({
        filePath: params.filePath,
        operation: params.operation,
        cause,
        message: `Failed to ${params.operation} tool environment file`,
      }),
    );
  }
  return Result.ok(captured.value);
}

function isMissingToolEnvFile(error: ToolEnvFileOperationError): boolean {
  const decoded = z.object({ code: z.string() }).safeParse(error.cause);
  return decoded.success && decoded.data.code === "ENOENT";
}

function isReservedName(name: string): boolean {
  return RESERVED_NAMES.has(name) || RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function decodeToolEnvEntry(name: string, raw: unknown): ToolEnvEntry | null {
  const parsed = toolEnvEntrySchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn("tool env entry ignored: validation failed", { name });
    return null;
  }

  return parsed.data;
}

function parseEntry(name: string, entry: ToolEnvEntry, now: number): string | null {
  if (typeof entry === "string") return entry;
  if (entry.expiresAt !== undefined) {
    const expiresAtMs = new Date(entry.expiresAt).getTime();
    if (now >= expiresAtMs) return null;
  }

  return entry.value;
}

export function parseToolEnvResult(
  raw: unknown,
  now = Date.now(),
): ResultType<Record<string, string>, ToolEnvInvalidError> {
  const parsedFile = toolEnvFileSchema.safeParse(raw);
  if (!parsedFile.success) {
    return Result.err(
      new ToolEnvInvalidError({
        cause: parsedFile.error,
        message: "Tool environment file must contain an object",
      }),
    );
  }

  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsedFile.data)) {
    if (!ENV_NAME_PATTERN.test(name)) {
      logger.warn("tool env entry ignored: invalid environment variable name", { name });
      continue;
    }
    if (isReservedName(name)) {
      logger.warn("tool env entry ignored: reserved environment variable", { name });
      continue;
    }

    const decoded = decodeToolEnvEntry(name, value);
    if (decoded === null) continue;
    const parsedEntry = parseEntry(name, decoded, now);
    if (parsedEntry === null) continue;
    if (parsedEntry.includes("\0")) {
      logger.warn("tool env entry ignored: value contains a null byte", { name });
      continue;
    }
    result[name] = parsedEntry;
  }

  return Result.ok(result);
}

export function parseToolEnv(raw: unknown, now = Date.now()): Record<string, string> {
  return adaptToolResultToHost(parseToolEnvResult(raw, now));
}

export async function loadToolEnv(dataDir: string): Promise<Record<string, string>> {
  const filePath = path.join(dataDir, "secret", "tool-env.jsonc");

  const inspected = await captureToolEnvFileOperation({
    filePath,
    operation: "inspect",
    run: () => fs.stat(filePath),
  });
  if (inspected.status === "error") {
    if (isMissingToolEnvFile(inspected.error)) return {};
    logger.warn("tool env ignored: failed to read or validate file", {
      filePath,
      ...formatTaggedErrorForLog(inspected.error),
    });
    return {};
  }
  const stat = inspected.value;
  if (!stat.isFile()) {
    logger.warn("tool env ignored: path is not a regular file", { filePath });
    return {};
  }
  if (stat.size > MAX_TOOL_ENV_FILE_BYTES) {
    logger.warn("tool env ignored: file exceeds size limit", {
      filePath,
      maxBytes: MAX_TOOL_ENV_FILE_BYTES,
    });
    return {};
  }
  if ((stat.mode & 0o077) !== 0) {
    logger.warn("tool env file is accessible by group or others; mode 0600 is recommended", {
      filePath,
    });
  }

  const content = await captureToolEnvFileOperation({
    filePath,
    operation: "read",
    run: () => fs.readFile(filePath, "utf8"),
  });
  if (content.status === "error") {
    logger.warn("tool env ignored: failed to read or validate file", {
      filePath,
      ...formatTaggedErrorForLog(content.error),
    });
    return {};
  }
  const json = Result.try({
    try: () => Bun.JSONC.parse(content.value),
    catch: projectRuntimeError("Opaque tool env JSONC parse failure"),
  });
  if (json.status === "error") {
    const cause = preserveToolPanic(json.error);
    const parseError = new ToolEnvFileOperationError({
      filePath,
      operation: "parse",
      cause,
      message: "Failed to parse tool environment file",
    });
    logger.warn("tool env ignored: failed to read or validate file", {
      filePath,
      ...formatTaggedErrorForLog(parseError),
    });
    return {};
  }
  const parsed = parseToolEnvResult(json.value);
  if (parsed.status === "error") {
    logger.warn("tool env ignored: failed to read or validate file", {
      filePath,
      ...formatTaggedErrorForLog(parsed.error),
    });
    return {};
  }
  return parsed.value;
}
