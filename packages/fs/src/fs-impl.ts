import type { Stats } from "node:fs";
import { createHash } from "node:crypto";
import { createReadStream, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  join,
  dirname,
  resolve,
  isAbsolute,
  sep,
  relative,
  matchesGlob,
} from "node:path";
import { StringDecoder } from "node:string_decoder";

import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import {
  captureFilesystemOperation,
  captureFilesystemOperationSync,
  FileSystemOperationFailed,
} from "./filesystem-operation";
import {
  applyHashlineEdits,
  buildHashlineWarning,
  HASHLINE_MAX_LINE_CHARS,
  type HashlineEdit,
  type HashlineWarning,
  formatHashlineWindow,
} from "./hashline";

import {
  fuzzyFileSearch,
  getSearchBackend,
  type EffectiveSearchBackend,
  type FsBackend,
  type FuzzyFileSearchResult,
} from "./search-backend";

export function expandTilde(input: string) {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return join(homedir(), input.slice(2));
  return input;
}

export async function canonicalizePathAsFarAsExists(
  inputPath: string,
): Promise<ResultType<string, FileSystemOperationFailed>> {
  let current = resolve(inputPath);
  const missingSegments: string[] = [];

  while (true) {
    const canonical = await captureFilesystemOperation("canonicalize path", () =>
      fs.realpath(current),
    );
    if (canonical.status === "ok") {
      return Result.ok(resolve(canonical.value, ...missingSegments));
    }
    if (canonical.error.code !== "ENOENT" && canonical.error.code !== "ENOTDIR") {
      return Result.err(canonical.error);
    }

    const stats = await captureFilesystemOperation("inspect canonical path segment", () =>
      fs.lstat(current),
    );
    if (stats.status === "ok" && stats.value.isSymbolicLink()) {
      const target = await captureFilesystemOperation("read canonical path symlink", () =>
        fs.readlink(current),
      );
      if (target.status === "error") return Result.err(target.error);
      current = isAbsolute(target.value)
        ? resolve(target.value)
        : resolve(dirname(current), target.value);
      continue;
    }

    const parent = dirname(current);
    if (parent === current) return Result.ok(resolve(current, ...missingSegments));
    missingSegments.unshift(basename(current));
    current = parent;
  }
}

function isSkippableTraversalError(error: FileSystemOperationFailed): boolean {
  const code = error.code;
  return code === "EACCES" || code === "EPERM" || code === "ENOENT" || code === "ENOTDIR";
}

function matchesAnyGlob(entryPath: string, patterns: readonly string[]): boolean {
  return patterns.some(
    (pattern) => matchesGlob(entryPath, pattern) || matchesGlob(`${entryPath}/`, pattern),
  );
}

function normalizeGlobPatternForBase(pattern: string, resolvedBaseDir: string): string {
  const expanded = expandTilde(pattern);
  if (!isAbsolute(expanded)) return expanded.split(sep).join("/");

  const rel = relative(resolvedBaseDir, expanded);
  return (rel.length === 0 ? "." : rel).split(sep).join("/");
}

function hasGlobMeta(segment: string): boolean {
  return /[*?[\]{}()!+@]/.test(segment);
}

function getLiteralSearchRoot(pattern: string): string {
  const segments = pattern.split("/").filter((segment) => segment.length > 0);
  const prefix: string[] = [];

  for (const segment of segments) {
    if (segment === "." || segment === "..") return "";
    if (hasGlobMeta(segment)) return prefix.join("/");
    prefix.push(segment);
  }

  return prefix.slice(0, -1).join("/");
}

function isSameOrChildPath(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

function getGlobSearchRoots(patterns: readonly string[]): string[] {
  const roots = patterns.map(getLiteralSearchRoot).sort((a, b) => a.length - b.length);
  const deduped: string[] = [];

  for (const root of roots) {
    if (root.length === 0) return [""];
    if (deduped.some((existing) => isSameOrChildPath(root, existing))) continue;
    deduped.push(root);
  }

  return deduped.length > 0 ? deduped : [""];
}

export const READ_ERROR_CODES = ["NOT_FOUND", "PERMISSION", "UNKNOWN"] as const;
export type ReadErrorCode = (typeof READ_ERROR_CODES)[number];

export const WRITE_ERROR_CODES = [
  "NOT_FOUND",
  "PERMISSION",
  "UNKNOWN",
  "FILE_EXISTS",
  "HASH_MISMATCH",
] as const;
export type WriteErrorCode = (typeof WRITE_ERROR_CODES)[number];

export const EDIT_ERROR_CODES = [
  "NOT_FOUND",
  "PERMISSION",
  "UNKNOWN",
  "NOT_READ",
  "HASH_MISMATCH",
  "INVALID_RANGE",
  "RANGE_MISMATCH",
  "NO_MATCHES",
  "TOO_MANY_MATCHES",
  "NOT_ENOUGH_MATCHES",
  "INVALID_REGEX",
  "INVALID_EDIT",
  "STALE_ANCHOR",
] as const;
export type EditErrorCode = (typeof EDIT_ERROR_CODES)[number];

class EditOperationFailed extends TaggedError("EditOperationFailed")<{
  readonly code: EditErrorCode;
  readonly message: string;
}> {}

type FileSystemFailureDetails = {
  readonly code: string;
  readonly message: string;
};

function toBasicFsErrorCode(code: string | undefined): ReadErrorCode {
  if (code === "ENOENT") return "NOT_FOUND";
  if (code === "EACCES" || code === "EPERM") return "PERMISSION";
  return "UNKNOWN";
}

function compileEditRegex(pattern: string): ResultType<RegExp, EditOperationFailed> {
  try {
    return Result.ok(new RegExp(pattern, "g"));
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(
      new EditOperationFailed({
        code: "INVALID_REGEX",
        message: `Invalid regex: ${cause instanceof Error ? cause.message : "unknown error"}`,
      }),
    );
  }
}

export type ReadFileSuccessBase = {
  success: true;
  resolvedPath: string;
  fileHash: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  hasMoreLines: boolean;
  truncatedByChars: boolean;
  nextStart?: ReadFileStart;
  warnings?: HashlineWarning[];
  degradedFromHashline?: boolean;
};

export type ReadFileBytesResult =
  | {
      success: true;
      resolvedPath: string;
      fileHash: string;
      bytes: Buffer;
      bytesLength: number;
    }
  | {
      success: false;
      resolvedPath: string;
      error: {
        code: ReadErrorCode;
        message: string;
      };
    };

export type ReadFileResult =
  | (ReadFileSuccessBase & {
      format: "raw";
      content: string;
    })
  | (ReadFileSuccessBase & {
      format: "numbered";
      numberedContent: string;
    })
  | (ReadFileSuccessBase & {
      format: "hashline";
      hashlineContent: string;
    })
  | {
      success: false;
      resolvedPath: string;
      error: {
        code: ReadErrorCode;
        message: string;
      };
    };

export type WriteFileResult =
  | {
      success: true;
      resolvedPath: string;
      created: boolean;
      overwritten: boolean;
      fileHash: string;
    }
  | {
      success: false;
      resolvedPath: string;
      currentHash?: string;
      error: {
        code: WriteErrorCode;
        message: string;
      };
    };

export type EditFileResult =
  | {
      success: true;
      resolvedPath: string;
      oldHash: string;
      newHash: string;
      changesMade: boolean;
      replacementsMade: number;
    }
  | {
      success: false;
      resolvedPath: string;
      currentHash?: string;
      error: {
        code: EditErrorCode;
        message: string;
      };
      errors?: {
        code: EditErrorCode;
        message: string;
        editIndex: number;
        edit: FileEdit;
      }[];
    };

export type ReadFileStart =
  | {
      type: "offset";
      /** 0-based Unicode character offset in the source, including newlines */
      offset: number;
    }
  | {
      type: "line";
      /** 1-based line number */
      line: number;
      /** 0-based Unicode character offset within line, defaults to 0. */
      column?: number;
    };

export interface ReadFileOptions {
  start?: ReadFileStart;
  /** Maximum number of lines to return, defaults to 2000 */
  maxLines?: number;
  /** Maximum number of characters to return, defaults to 10000 */
  maxCharacters?: number;
  /** Maximum UTF-8 bytes in the returned textual payload. Must be at least 4 when set. */
  maxBytes?: number;
  /** Output format, defaults to "raw" */
  format?: "raw" | "numbered" | "hashline";
  /** Bypass denylist guardrails for this call. */
  dangerouslyAllow?: boolean;
}

export type HashlineEditFileResult = EditFileResult;

export type FileEdit =
  | {
      type: "replace_range";
      /** 1-based, inclusive */
      range: {
        startLine: number;
        endLine: number;
      };
      newText: string;
      /**
       * Optional safety check: the exact text currently in the range.
       * If provided and does not match, the edit fails.
       */
      expectedOldText?: string;
    }
  | {
      type: "insert_at";
      /**
       * 1-based line number.
       * New text will be inserted before this line.
       */
      line: number;
      newText: string;
    }
  | {
      type: "delete_range";
      /** 1-based, inclusive */
      range: {
        startLine: number;
        endLine: number;
      };
      /**
       * Optional safety check: the exact text currently in the range.
       * If provided and does not match, the edit fails.
       */
      expectedOldText?: string;
    }
  | {
      type: "replace_snippet";
      /**
       * Exact text to replace if matching is "exact";
       * Regex body if matching is "regex".
       */
      target: string;
      matching?: "exact" | "regex";
      newText: string;
      /**
       * Which occurrences to replace.
       * - "first": replace the first match
       * - "all": replace all matches
       * - number: replace up to N matches
       */
      occurrence?: "first" | "all" | number;
      /**
       * How many matches must exist for the edit to proceed.
       * Default is 1 (opencode-style safety).
       */
      expectedMatches?: number | "any";
    };

type FileEditDecodeResult =
  | { readonly success: true; readonly edit: FileEdit }
  | { readonly success: false; readonly message: string };

function invalidFileEdit(message: string): FileEditDecodeResult {
  return { success: false, message };
}

function decodeFileEdit(value: FileEdit): FileEditDecodeResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalidFileEdit("Unknown edit type: unknown");
  }

  const rawType: string = value.type;
  if (typeof rawType !== "string") {
    return invalidFileEdit(
      `Unknown edit type: ${rawType === undefined ? "unknown" : String(rawType)}`,
    );
  }

  switch (rawType) {
    case "replace_range": {
      const range = "range" in value ? value.range : undefined;
      const newText = "newText" in value ? value.newText : undefined;
      const expectedOldText = "expectedOldText" in value ? value.expectedOldText : undefined;
      if (
        typeof range !== "object" ||
        range === null ||
        Array.isArray(range) ||
        !("startLine" in range) ||
        typeof range.startLine !== "number" ||
        !("endLine" in range) ||
        typeof range.endLine !== "number" ||
        typeof newText !== "string" ||
        (expectedOldText !== undefined && typeof expectedOldText !== "string")
      ) {
        return invalidFileEdit(`Invalid edit payload for type: ${rawType}`);
      }
      const edit: Extract<FileEdit, { type: "replace_range" }> = {
        type: rawType,
        range,
        newText,
      };
      if (expectedOldText !== undefined) edit.expectedOldText = expectedOldText;
      return { success: true, edit };
    }
    case "insert_at": {
      const line = "line" in value ? value.line : undefined;
      const newText = "newText" in value ? value.newText : undefined;
      if (typeof line !== "number" || typeof newText !== "string") {
        return invalidFileEdit(`Invalid edit payload for type: ${rawType}`);
      }
      return { success: true, edit: { type: rawType, line, newText } };
    }
    case "delete_range": {
      const range = "range" in value ? value.range : undefined;
      const expectedOldText = "expectedOldText" in value ? value.expectedOldText : undefined;
      if (
        typeof range !== "object" ||
        range === null ||
        Array.isArray(range) ||
        !("startLine" in range) ||
        typeof range.startLine !== "number" ||
        !("endLine" in range) ||
        typeof range.endLine !== "number" ||
        (expectedOldText !== undefined && typeof expectedOldText !== "string")
      ) {
        return invalidFileEdit(`Invalid edit payload for type: ${rawType}`);
      }
      const edit: Extract<FileEdit, { type: "delete_range" }> = { type: rawType, range };
      if (expectedOldText !== undefined) edit.expectedOldText = expectedOldText;
      return { success: true, edit };
    }
    case "replace_snippet": {
      const target = "target" in value ? value.target : undefined;
      const matching = "matching" in value ? value.matching : undefined;
      const newText = "newText" in value ? value.newText : undefined;
      const occurrence = "occurrence" in value ? value.occurrence : undefined;
      const expectedMatches = "expectedMatches" in value ? value.expectedMatches : undefined;
      if (
        typeof target !== "string" ||
        (matching !== undefined && matching !== "exact" && matching !== "regex") ||
        typeof newText !== "string" ||
        (occurrence !== undefined &&
          typeof occurrence !== "number" &&
          occurrence !== "first" &&
          occurrence !== "all") ||
        (expectedMatches !== undefined &&
          typeof expectedMatches !== "number" &&
          expectedMatches !== "any")
      ) {
        return invalidFileEdit(`Invalid edit payload for type: ${rawType}`);
      }
      const edit: Extract<FileEdit, { type: "replace_snippet" }> = {
        type: rawType,
        target,
        newText,
      };
      if (matching !== undefined) edit.matching = matching;
      if (occurrence !== undefined) edit.occurrence = occurrence;
      if (expectedMatches !== undefined) edit.expectedMatches = expectedMatches;
      return { success: true, edit };
    }
    default:
      return invalidFileEdit(`Unknown edit type: ${rawType}`);
  }
}

export const SEARCH_MODES = ["default", "detailed"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];
export const GREP_MODES = ["default", "detailed", "hashline"] as const;
export type GrepMode = (typeof GREP_MODES)[number];

export type GlobEntry = {
  path: string;
  type:
    | "symlink"
    | "file"
    | "directory"
    | "socket"
    | "block_device"
    | "character_device"
    | "fifo"
    | "unknown";
  size: number;
};

export type GlobResult =
  | {
      mode: "default";
      truncated: boolean;
      paths: string[];
      effectiveBackend?: EffectiveSearchBackend;
      error?: string;
    }
  | {
      mode: "detailed";
      truncated: boolean;
      entries: GlobEntry[];
      effectiveBackend?: EffectiveSearchBackend;
      error?: string;
    };

export type GrepResult =
  | {
      mode: "default";
      truncated: boolean;
      warnings?: HashlineWarning[];
      degradedFromHashline?: boolean;
      effectiveBackend?: EffectiveSearchBackend;
      results: {
        file: string;
        line: number;
        text: string;
      }[];
      error?: string;
    }
  | {
      mode: "detailed";
      truncated: boolean;
      warnings?: HashlineWarning[];
      degradedFromHashline?: boolean;
      effectiveBackend?: EffectiveSearchBackend;
      results: {
        file: string;
        line: number;
        column: number;
        text: string;
        submatches?: {
          match: string;
          start: number;
          end: number;
        }[];
      }[];
      error?: string;
    }
  | {
      mode: "hashline";
      truncated: boolean;
      warnings?: HashlineWarning[];
      degradedFromHashline?: boolean;
      effectiveBackend?: EffectiveSearchBackend;
      results: {
        file: string;
        resolvedPath: string;
        fileHash: string;
        line: number;
        text: string;
      }[];
      error?: string;
    };

export type FuzzySearchResult =
  | (FuzzyFileSearchResult & {
      error?: undefined;
    })
  | {
      results: [];
      totalMatched: 0;
      totalFiles: 0;
      truncated: false;
      effectiveBackend?: EffectiveSearchBackend;
      error: string;
    };

export type GlobOpts = {
  /**
   * The base directory to search from, must be absolute path. Default is the root.
   */
  baseDir?: string;
  /**
   * Maximum number of entries to return, default is 100
   */
  maxEntries?: number;
  /**
   * Output verbosity mode. Default is default.
   */
  mode?: SearchMode;
  /** Bypass denylist guardrails for this call. */
  dangerouslyAllow?: boolean;
};

export type GrepOpts = {
  /**
   * The file or base directory to search. Relative paths resolve from the root.
   */
  baseDir?: string;
  /** Path to report for single-file matches when transport requires a different search path. */
  reportedFilePath?: string;
  regex?: boolean;
  maxResults?: number;
  fileExtensions?: string[];
  includeContextLines?: number;
  /**
   * Output verbosity mode. Default is default.
   */
  mode?: GrepMode;
  /** Bypass denylist guardrails for this call. */
  dangerouslyAllow?: boolean;
};

export type FileSystemEventType = "readFile" | "writeFile" | "editFile" | "deleteFile";
export type FileSystemEvent =
  | {
      type: "readFile" | "writeFile" | "deleteFile";
      path: string;
      accessAt: number;
    }
  | {
      type: "editFile";
      path: string;
      accessAt: number;
      operations: FileEdit["type"][];
    };
export type Listener = (event: FileSystemEvent) => void;

export class FileSystem {
  private readonly fileAccessRecord = new Map<string, { lastAccess: number; fileHash: string }>();
  private readonly listeners = new Set<Listener>();

  private readonly denyPaths: readonly string[];
  private readonly fsBackend: FsBackend;
  private readonly fffCacheDir: string | undefined;

  constructor(
    private root: string,
    opts?: {
      /** Absolute or ~ paths that are blocked for all operations. */
      denyPaths?: readonly string[];
      fsBackend?: FsBackend;
      fffCacheDir?: string;
    },
  ) {
    this.denyPaths = (opts?.denyPaths ?? []).flatMap((p) => {
      const resolvedPath = resolve(expandTilde(p));
      const canonical = captureFilesystemOperationSync("canonicalize deny path", () =>
        realpathSync(resolvedPath),
      );
      if (canonical.status === "ok") {
        const canonicalPath = canonical.value;
        return canonicalPath === resolvedPath ? [resolvedPath] : [resolvedPath, canonicalPath];
      }
      return [resolvedPath];
    });
    this.fsBackend = opts?.fsBackend ?? "node-rg";
    this.fffCacheDir = opts?.fffCacheDir ? resolve(expandTilde(opts.fffCacheDir)) : undefined;
  }

  private isDeniedPath(resolvedPath: string): boolean {
    const normalized = resolve(resolvedPath);
    for (const deny of this.denyPaths) {
      if (normalized === deny) return true;
      if (normalized.startsWith(`${deny}${sep}`)) return true;
    }
    return false;
  }

  private assertAllowed(
    resolvedPath: string,
    op: string,
    dangerouslyAllow = false,
  ): ResultType<void, FileSystemOperationFailed> {
    if (dangerouslyAllow || !this.isDeniedPath(resolvedPath)) return Result.ok(undefined);
    return Result.err(
      new FileSystemOperationFailed({
        operation: op,
        code: "EACCES",
        message: `Access denied: '${resolvedPath}' is blocked for ${op}`,
      }),
    );
  }

  private resolvePath(inputPath: string, cwd?: string) {
    const expandedInput = expandTilde(inputPath);
    if (isAbsolute(expandedInput)) return resolve(expandedInput);

    const base = cwd ?? this.root;
    const expandedBase = resolve(expandTilde(base));
    return resolve(expandedBase, expandedInput);
  }

  on(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Reads a file from the filesystem
   *
   * @param path The path to the file, relative to the root
   *
   */
  async readFile(
    { path, ...opts }: ReadFileOptions & { path: string },
    cwd?: string,
  ): Promise<ReadFileResult> {
    const resolvedPath = this.resolvePath(path, cwd);
    const {
      start = { type: "line", line: 1 },
      maxLines = 2000,
      maxCharacters = 10000,
      maxBytes,
      format = "raw",
      dangerouslyAllow = false,
    } = opts;

    const allowedPath = this.assertAllowed(resolvedPath, "readFile", dangerouslyAllow);
    if (allowedPath.status === "error") return this.readFailure(resolvedPath, allowedPath.error);
    const canonical = await captureFilesystemOperation("resolve file for reading", () =>
      fs.realpath(resolvedPath),
    );
    if (canonical.status === "error") return this.readFailure(resolvedPath, canonical.error);
    const canonicalPath = canonical.value;
    const allowedCanonical = this.assertAllowed(canonicalPath, "readFile", dangerouslyAllow);
    if (allowedCanonical.status === "error") {
      return this.readFailure(resolvedPath, allowedCanonical.error);
    }

    const requestedStartLine = start.type === "line" ? Math.max(1, Math.floor(start.line)) : 1;
    const requestedStartColumn =
      start.type === "line" ? Math.max(0, Math.floor(start.column ?? 0)) : 0;
    const requestedStartOffset =
      start.type === "offset" ? Math.max(0, Math.floor(start.offset)) : undefined;
    const requestedMaxLines = Number.isFinite(maxLines) ? Math.max(1, Math.floor(maxLines)) : 2000;
    const requestedMaxCharacters = Number.isFinite(maxCharacters)
      ? Math.max(1, Math.floor(maxCharacters))
      : 10000;
    const requestedMaxBytes =
      maxBytes !== undefined && Number.isFinite(maxBytes)
        ? Math.max(1, Math.floor(maxBytes))
        : Number.POSITIVE_INFINITY;
    if (requestedMaxBytes < 4) {
      return {
        success: false,
        resolvedPath,
        error: {
          code: "UNKNOWN",
          message: "readFile maxBytes must be at least 4 to fit one Unicode character",
        },
      };
    }
    const storedLineLimit = requestedMaxCharacters + 2;
    const storedCharacterLimit = requestedMaxCharacters + 1;
    const windowLines: string[] = [];
    const decoder = new StringDecoder("utf8");
    const hasher = createHash("sha256");
    let lineNumber = 1;
    let selectedLineCount = 0;
    let storedCharacters = 0;
    let currentLine = "";
    let currentLineCharacters = 0;
    let currentLineUtf16Length = 0;
    let firstSelectedLineCharacters = 0;
    let sourceOffset = 0;
    let offsetStartLine: number | undefined;
    let offsetStartColumn: number | undefined;
    let normalizedStartOffset: number | undefined;
    let selectedNextLineOffset: number | undefined;
    let hashlineOverflow: HashlineWarning | undefined;

    const resolveOffsetStart = () => {
      if (
        requestedStartOffset === undefined ||
        offsetStartLine !== undefined ||
        sourceOffset < requestedStartOffset
      ) {
        return;
      }
      offsetStartLine = lineNumber;
      offsetStartColumn = currentLineCharacters;
      normalizedStartOffset = sourceOffset;
    };

    const isCurrentLineSelected = () => {
      if (start.type === "line") {
        return (
          lineNumber >= requestedStartLine && lineNumber < requestedStartLine + requestedMaxLines
        );
      }
      return (
        offsetStartLine !== undefined &&
        lineNumber >= offsetStartLine &&
        lineNumber < offsetStartLine + requestedMaxLines
      );
    };

    const finishLine = (hasNewline: boolean) => {
      resolveOffsetStart();
      if (isCurrentLineSelected()) {
        if (selectedLineCount === 0) firstSelectedLineCharacters = currentLineCharacters;
        if (!hashlineOverflow && currentLineUtf16Length > HASHLINE_MAX_LINE_CHARS) {
          hashlineOverflow = buildHashlineWarning(lineNumber, currentLineUtf16Length);
        }
        if (windowLines.length < storedLineLimit) windowLines.push(currentLine);
        selectedLineCount++;
        if (hasNewline) selectedNextLineOffset = sourceOffset + 1;
      }
      currentLine = "";
      currentLineCharacters = 0;
      currentLineUtf16Length = 0;
    };

    const consumeText = (text: string) => {
      for (const character of text) {
        if (character === "\n") {
          finishLine(true);
          sourceOffset++;
          lineNumber++;
          continue;
        }

        resolveOffsetStart();
        currentLineCharacters++;
        currentLineUtf16Length += character.length;
        if (
          isCurrentLineSelected() &&
          (start.type === "offset" ||
            lineNumber !== requestedStartLine ||
            currentLineCharacters > requestedStartColumn) &&
          storedCharacters < storedCharacterLimit
        ) {
          currentLine += character;
          storedCharacters++;
        }
        sourceOffset++;
      }
    };

    const streamed = await captureFilesystemOperation("stream file for reading", async () => {
      for await (const chunk of createReadStream(canonicalPath)) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hasher.update(bytes);
        consumeText(decoder.write(bytes));
      }
    });
    if (streamed.status === "error") return this.readFailure(resolvedPath, streamed.error);
    consumeText(decoder.end());
    if (requestedStartOffset !== undefined && offsetStartLine === undefined) {
      offsetStartLine = lineNumber;
      offsetStartColumn = currentLineCharacters;
      normalizedStartOffset = sourceOffset;
    }
    finishLine(false);

    const fileHash = hasher.digest("hex");
    const totalLines = lineNumber;
    const normalizedStartLine =
      start.type === "line"
        ? Math.min(requestedStartLine, totalLines + 1)
        : (offsetStartLine ?? totalLines);
    const normalizedStartColumn =
      start.type === "line"
        ? Math.min(requestedStartColumn, firstSelectedLineCharacters)
        : (offsetStartColumn ?? 0);
    const windowEndLine = normalizedStartLine + selectedLineCount - 1;

    let output: string;
    let warnings: HashlineWarning[] | undefined;
    let degradedFromHashline = false;
    let effectiveFormat: "raw" | "numbered" | "hashline" = format;

    if (format === "numbered") {
      const digits = Math.max(1, String(Math.max(windowEndLine, normalizedStartLine)).length);
      output = windowLines
        .map((line, i) => `${String(normalizedStartLine + i).padStart(digits, " ")}| ${line}`)
        .join("\n");
    } else if (format === "hashline") {
      const overflow = hashlineOverflow;
      if (normalizedStartColumn > 0) {
        effectiveFormat = "raw";
        degradedFromHashline = true;
        output = windowLines.join("\n");
      } else if (overflow) {
        effectiveFormat = "raw";
        degradedFromHashline = true;
        warnings = [overflow];
        output = windowLines.join("\n");
      } else {
        output = formatHashlineWindow(windowLines, normalizedStartLine);
      }
    } else {
      output = windowLines.join("\n");
    }
    const includesOffsetBoundaryNewline =
      start.type === "offset" &&
      selectedLineCount >= requestedMaxLines &&
      selectedNextLineOffset !== undefined;
    if (includesOffsetBoundaryNewline) output += "\n";

    let outputCharacters = Array.from(output);
    if (
      (outputCharacters.length > requestedMaxCharacters ||
        Buffer.byteLength(output, "utf8") > requestedMaxBytes) &&
      effectiveFormat !== "raw"
    ) {
      effectiveFormat = "raw";
      degradedFromHashline ||= format === "hashline";
      output = windowLines.join("\n") + (includesOffsetBoundaryNewline ? "\n" : "");
      outputCharacters = Array.from(output);
    }
    const truncatedByChars = outputCharacters.length > requestedMaxCharacters;
    const boundedCharacters: string[] = [];
    let outputBytes = 0;
    for (const character of outputCharacters.slice(0, requestedMaxCharacters)) {
      const characterBytes = Buffer.byteLength(character, "utf8");
      if (outputBytes + characterBytes > requestedMaxBytes) break;
      boundedCharacters.push(character);
      outputBytes += characterBytes;
    }
    const truncatedByBytes =
      boundedCharacters.length < Math.min(outputCharacters.length, requestedMaxCharacters);
    output = boundedCharacters.join("");
    const truncated = truncatedByChars || truncatedByBytes;
    const completeLines = truncated ? output.split("\n").length - 1 : selectedLineCount;
    const endLine = truncated ? normalizedStartLine + completeLines - 1 : windowEndLine;
    const hasMoreLines = truncated || endLine < totalLines;
    let nextStart: ReadFileStart | undefined;
    if (hasMoreLines) {
      if (start.type === "offset") {
        nextStart = {
          type: "offset",
          offset: truncated
            ? (normalizedStartOffset ?? sourceOffset) + Array.from(output).length
            : (selectedNextLineOffset ?? normalizedStartOffset ?? sourceOffset),
        };
      } else if (truncated) {
        nextStart = {
          type: "line",
          line: normalizedStartLine + completeLines,
          column:
            completeLines === 0
              ? normalizedStartColumn + Array.from(output).length
              : Array.from(output.slice(output.lastIndexOf("\n") + 1)).length,
        };
      } else {
        nextStart = {
          type: "line",
          line:
            selectedLineCount > 0 ? normalizedStartLine + selectedLineCount : normalizedStartLine,
          ...(selectedLineCount === 0 && normalizedStartColumn > 0
            ? { column: normalizedStartColumn }
            : {}),
        };
      }
    }

    this.fileAccessRecord.set(resolvedPath, {
      lastAccess: Date.now(),
      fileHash,
    });

    this.fireEvent({
      type: "readFile",
      path: resolvedPath,
      accessAt: Date.now(),
    });

    const base: ReadFileSuccessBase = {
      success: true,
      resolvedPath,
      fileHash,
      startLine: normalizedStartLine,
      endLine,
      totalLines,
      hasMoreLines,
      truncatedByChars,
      ...(nextStart ? { nextStart } : {}),
      ...(warnings ? { warnings } : {}),
      ...(degradedFromHashline ? { degradedFromHashline } : {}),
    };

    if (effectiveFormat === "numbered") {
      return { ...base, format: "numbered", numberedContent: output };
    }

    if (effectiveFormat === "hashline") {
      return { ...base, format: "hashline", hashlineContent: output };
    }

    return { ...base, format: "raw", content: output };
  }

  /**
   * Reads a file as bytes.
   *
   * This is intended for binary files (images, PDFs, etc.) where reading as utf-8
   * would corrupt the data.
   */
  async readFileBytes(
    {
      path,
      dangerouslyAllow = false,
      maxBytes,
    }: {
      path: string;
      dangerouslyAllow?: boolean;
      maxBytes?: number;
    },
    cwd?: string,
  ): Promise<ReadFileBytesResult> {
    const resolvedPath = this.resolvePath(path, cwd);
    const allowedPath = this.assertAllowed(resolvedPath, "readFile", dangerouslyAllow);
    if (allowedPath.status === "error")
      return this.readBytesFailure(resolvedPath, allowedPath.error);
    const canonical = await captureFilesystemOperation("resolve byte file for reading", () =>
      fs.realpath(resolvedPath),
    );
    if (canonical.status === "error") return this.readBytesFailure(resolvedPath, canonical.error);
    const canonicalPath = canonical.value;
    const allowedCanonical = this.assertAllowed(canonicalPath, "readFile", dangerouslyAllow);
    if (allowedCanonical.status === "error") {
      return this.readBytesFailure(resolvedPath, allowedCanonical.error);
    }

    if (maxBytes !== undefined) {
      const stats = await captureFilesystemOperation("stat byte file", () =>
        fs.stat(canonicalPath),
      );
      if (stats.status === "error") return this.readBytesFailure(resolvedPath, stats.error);
      if (stats.value.size > maxBytes) {
        return {
          success: false,
          resolvedPath,
          error: {
            code: "UNKNOWN",
            message: `File is too large to inline (${stats.value.size} bytes; maximum ${maxBytes} bytes): ${resolvedPath}`,
          },
        };
      }
    }

    const read = await captureFilesystemOperation("read byte file", () =>
      fs.readFile(canonicalPath),
    );
    if (read.status === "error") return this.readBytesFailure(resolvedPath, read.error);
    const bytes = read.value;
    const fileHash = this.hash(bytes);

    this.fileAccessRecord.set(resolvedPath, {
      lastAccess: Date.now(),
      fileHash,
    });

    this.fireEvent({
      type: "readFile",
      path: resolvedPath,
      accessAt: Date.now(),
    });

    return {
      success: true,
      resolvedPath,
      fileHash,
      bytes,
      bytesLength: bytes.byteLength,
    };
  }

  async writeFile(
    {
      path,
      content,
      overwrite = false,
      expectedHash,
      createParents = true,
    }: {
      path: string;
      content: string;
      overwrite?: boolean;
      expectedHash?: string;
      createParents?: boolean;
    },
    cwd?: string,
  ): Promise<WriteFileResult> {
    const resolvedPath = this.resolvePath(path, cwd);
    const allowedPath = this.assertAllowed(resolvedPath, "writeFile");
    if (allowedPath.status === "error") return this.writeFailure(resolvedPath, allowedPath.error);
    const canonical = await canonicalizePathAsFarAsExists(resolvedPath);
    if (canonical.status === "error") return this.writeFailure(resolvedPath, canonical.error);
    const canonicalPath = canonical.value;
    const allowedCanonical = this.assertAllowed(canonicalPath, "writeFile");
    if (allowedCanonical.status === "error") {
      return this.writeFailure(resolvedPath, allowedCanonical.error);
    }

    let existed = true;
    let currentHash: string | undefined;

    const existing = await captureFilesystemOperation("read file before writing", () =>
      fs.readFile(canonicalPath, "utf-8"),
    );
    if (existing.status === "ok") {
      currentHash = this.hash(existing.value);
    } else if (existing.error.code === "ENOENT") {
      existed = false;
    } else {
      return this.writeFailure(resolvedPath, existing.error);
    }

    if (existed) {
      if (!overwrite) {
        return {
          success: false as const,
          resolvedPath,
          error: {
            code: "FILE_EXISTS",
            message: `File already exists: ${resolvedPath}. Set overwrite=true to overwrite it.`,
          },
        };
      }

      if (expectedHash && currentHash && expectedHash !== currentHash) {
        return {
          success: false as const,
          resolvedPath,
          currentHash,
          error: {
            code: "HASH_MISMATCH",
            message: `File has changed since last read: ${resolvedPath}`,
          },
        };
      }
    } else {
      if (expectedHash) {
        return {
          success: false as const,
          resolvedPath,
          error: {
            code: "NOT_FOUND",
            message: `File does not exist: ${resolvedPath}`,
          },
        };
      }
    }

    if (createParents) {
      const created = await captureFilesystemOperation("create parent directories", () =>
        fs.mkdir(dirname(canonicalPath), { recursive: true }),
      );
      if (created.status === "error") return this.writeFailure(resolvedPath, created.error);
    }

    const written = await captureFilesystemOperation("write file", () =>
      fs.writeFile(canonicalPath, content),
    );
    if (written.status === "error") return this.writeFailure(resolvedPath, written.error);
    const fileHash = this.hash(content);

    this.fileAccessRecord.set(resolvedPath, {
      lastAccess: Date.now(),
      fileHash,
    });

    this.fireEvent({
      type: "writeFile",
      path: resolvedPath,
      accessAt: Date.now(),
    });

    return {
      success: true as const,
      resolvedPath,
      created: !existed,
      overwritten: existed,
      fileHash,
    };
  }

  async deleteFile({ path, cwd }: { path: string; cwd?: string }) {
    const resolvedPath = this.resolvePath(path, cwd);
    const allowedPath = this.assertAllowed(resolvedPath, "deleteFile");
    if (allowedPath.status === "error") {
      return { success: false as const, error: allowedPath.error.message };
    }
    const parent = await captureFilesystemOperation("resolve deleted file parent", () =>
      fs.realpath(dirname(resolvedPath)),
    );
    if (parent.status === "error") return { success: false as const, error: parent.error.message };
    const allowedCanonical = this.assertAllowed(
      resolve(parent.value, basename(resolvedPath)),
      "deleteFile",
    );
    if (allowedCanonical.status === "error") {
      return { success: false as const, error: allowedCanonical.error.message };
    }

    const deleted = await captureFilesystemOperation("delete file", () => fs.unlink(resolvedPath));
    if (deleted.status === "error")
      return { success: false as const, error: deleted.error.message };
    this.fileAccessRecord.delete(resolvedPath);

    this.fireEvent({
      type: "deleteFile",
      path: resolvedPath,
      accessAt: Date.now(),
    });

    return { success: true as const };
  }

  /**
   * Edits a file in the filesystem.
   *
   * By default, edits are atomic: if any edit fails, the file is not written.
   */
  async editFile(
    {
      path,
      edits,
      expectedHash,
      dangerouslyAllow = false,
    }: {
      path: string;
      edits: FileEdit[];
      expectedHash?: string;
      dangerouslyAllow?: boolean;
    },
    cwd?: string,
  ): Promise<EditFileResult> {
    const resolvedPath = this.resolvePath(path, cwd);
    const allowedPath = this.assertAllowed(resolvedPath, "editFile", dangerouslyAllow);
    if (allowedPath.status === "error")
      return this.editFilesystemFailure(resolvedPath, allowedPath.error);
    const canonical = await captureFilesystemOperation("resolve file for editing", () =>
      fs.realpath(resolvedPath),
    );
    if (canonical.status === "error")
      return this.editFilesystemFailure(resolvedPath, canonical.error);
    const canonicalPath = canonical.value;
    const allowedCanonical = this.assertAllowed(canonicalPath, "editFile", dangerouslyAllow);
    if (allowedCanonical.status === "error") {
      return this.editFilesystemFailure(resolvedPath, allowedCanonical.error);
    }

    const lastAccess = this.fileAccessRecord.get(resolvedPath);
    const read = await captureFilesystemOperation("read file for editing", () =>
      fs.readFile(canonicalPath, "utf-8"),
    );
    if (read.status === "error") return this.editFilesystemFailure(resolvedPath, read.error);
    const file = read.value;

    const oldHash = this.hash(file);
    if (expectedHash) {
      if (expectedHash !== oldHash) {
        return {
          success: false as const,
          resolvedPath,
          currentHash: oldHash,
          error: {
            code: "HASH_MISMATCH",
            message: `File has changed since last read: ${resolvedPath}`,
          },
        };
      }
    } else {
      if (!lastAccess) {
        return {
          success: false as const,
          resolvedPath,
          currentHash: oldHash,
          error: {
            code: "NOT_READ",
            message: `File must be read before editing: ${resolvedPath}`,
          },
        };
      }

      if (lastAccess.fileHash !== oldHash) {
        return {
          success: false as const,
          resolvedPath,
          currentHash: oldHash,
          error: {
            code: "HASH_MISMATCH",
            message: `File has changed since last read: ${resolvedPath}`,
          },
        };
      }
    }

    const countExactOccurrences = (haystack: string, needle: string) => {
      if (needle.length === 0) return 0;
      let count = 0;
      let i = 0;
      while (true) {
        i = haystack.indexOf(needle, i);
        if (i === -1) break;
        count++;
        i += needle.length;
      }
      return count;
    };

    const replaceExactOccurrences = (
      haystack: string,
      needle: string,
      replacement: string,
      maxReplacements: number,
    ) => {
      if (needle.length === 0) {
        return { result: haystack, replacementsMade: 0 };
      }

      let replacementsMade = 0;
      let start = 0;
      let result = "";
      while (replacementsMade < maxReplacements) {
        const idx = haystack.indexOf(needle, start);
        if (idx === -1) break;
        result += haystack.slice(start, idx) + replacement;
        start = idx + needle.length;
        replacementsMade++;
      }

      result += haystack.slice(start);
      return { result, replacementsMade };
    };

    const countRegexMatches = (haystack: string, re: RegExp) => {
      let count = 0;
      re.lastIndex = 0;
      while (true) {
        const match = re.exec(haystack);
        if (!match) break;
        count++;
        if (match[0].length === 0) re.lastIndex++;
      }
      return count;
    };

    const replaceRegexOccurrences = (
      haystack: string,
      re: RegExp,
      replacement: string,
      maxReplacements: number,
    ) => {
      let replacementsMade = 0;
      let lastIndex = 0;
      let result = "";

      re.lastIndex = 0;
      while (replacementsMade < maxReplacements) {
        const match = re.exec(haystack);
        if (!match) break;

        result += haystack.slice(lastIndex, match.index) + replacement;
        lastIndex = match.index + match[0].length;
        replacementsMade++;

        if (match[0].length === 0) re.lastIndex++;
      }

      result += haystack.slice(lastIndex);
      return { result, replacementsMade };
    };

    const enforceExpectedMatches = (
      matchesFound: number,
      expected: number | "any",
      target: string,
    ): EditOperationFailed | undefined => {
      if (expected === "any") {
        if (matchesFound === 0) {
          return new EditOperationFailed({
            code: "NO_MATCHES",
            message: `No matches found for target: ${target}`,
          });
        }
        return undefined;
      }

      if (matchesFound === 0) {
        return new EditOperationFailed({
          code: "NO_MATCHES",
          message: `No matches found for target: ${target}`,
        });
      }

      if (matchesFound > expected) {
        return new EditOperationFailed({
          code: "TOO_MANY_MATCHES",
          message: `Too many matches found (${matchesFound}); expected ${expected} for target: ${target}`,
        });
      }

      if (matchesFound < expected) {
        return new EditOperationFailed({
          code: "NOT_ENOUGH_MATCHES",
          message: `Not enough matches found (${matchesFound}); expected ${expected} for target: ${target}`,
        });
      }
      return undefined;
    };

    const validateRange = (
      lines: string[],
      startLine: number,
      endLine: number,
    ): EditOperationFailed | undefined => {
      if (startLine < 1 || endLine < startLine || endLine > lines.length) {
        return new EditOperationFailed({
          code: "INVALID_RANGE",
          message: `Invalid range ${startLine}-${endLine}. File has ${lines.length} lines.`,
        });
      }
      return undefined;
    };

    let lines = file.split("\n");
    const succeededOperations: FileEdit["type"][] = [];
    let replacementsMade = 0;

    for (let editIndex = 0; editIndex < edits.length; editIndex++) {
      const suppliedEdit = edits[editIndex]!;
      const decodedEdit = decodeFileEdit(suppliedEdit);
      if (!decodedEdit.success) {
        return this.editOperationFailure(
          resolvedPath,
          oldHash,
          editIndex,
          suppliedEdit,
          new EditOperationFailed({ code: "INVALID_EDIT", message: decodedEdit.message }),
        );
      }
      const edit = decodedEdit.edit;
      switch (edit.type) {
        case "replace_range": {
          const {
            newText,
            expectedOldText,
            range: { startLine, endLine },
          } = edit;

          const rangeError = validateRange(lines, startLine, endLine);
          if (rangeError) {
            return this.editOperationFailure(
              resolvedPath,
              oldHash,
              editIndex,
              suppliedEdit,
              rangeError,
            );
          }

          if (expectedOldText !== undefined) {
            const actual = lines.slice(startLine - 1, endLine).join("\n");
            if (actual !== expectedOldText) {
              return this.editOperationFailure(
                resolvedPath,
                oldHash,
                editIndex,
                suppliedEdit,
                new EditOperationFailed({
                  code: "RANGE_MISMATCH",
                  message: `Range content mismatch for ${startLine}-${endLine}. Re-read the file and try again.`,
                }),
              );
            }
          }

          lines.splice(startLine - 1, endLine - startLine + 1, ...newText.split("\n"));
          break;
        }
        case "insert_at": {
          const { line, newText } = edit;
          if (line < 1 || line > lines.length + 1) {
            return this.editOperationFailure(
              resolvedPath,
              oldHash,
              editIndex,
              suppliedEdit,
              new EditOperationFailed({
                code: "INVALID_RANGE",
                message: `Invalid insert line ${line}. Must be between 1 and ${lines.length + 1}.`,
              }),
            );
          }

          lines.splice(line - 1, 0, ...newText.split("\n"));
          break;
        }
        case "delete_range": {
          const {
            expectedOldText,
            range: { startLine, endLine },
          } = edit;

          const rangeError = validateRange(lines, startLine, endLine);
          if (rangeError) {
            return this.editOperationFailure(
              resolvedPath,
              oldHash,
              editIndex,
              suppliedEdit,
              rangeError,
            );
          }

          if (expectedOldText !== undefined) {
            const actual = lines.slice(startLine - 1, endLine).join("\n");
            if (actual !== expectedOldText) {
              return this.editOperationFailure(
                resolvedPath,
                oldHash,
                editIndex,
                suppliedEdit,
                new EditOperationFailed({
                  code: "RANGE_MISMATCH",
                  message: `Range content mismatch for ${startLine}-${endLine}. Re-read the file and try again.`,
                }),
              );
            }
          }

          lines.splice(startLine - 1, endLine - startLine + 1);
          break;
        }
        case "replace_snippet": {
          const {
            target,
            matching = "exact",
            newText,
            occurrence = "first",
            expectedMatches = 1,
          } = edit;

          if (target.length === 0) {
            return this.editOperationFailure(
              resolvedPath,
              oldHash,
              editIndex,
              suppliedEdit,
              new EditOperationFailed({
                code: "INVALID_EDIT",
                message: "target must not be empty",
              }),
            );
          }

          if (matching === "exact" && target === newText) {
            return this.editOperationFailure(
              resolvedPath,
              oldHash,
              editIndex,
              suppliedEdit,
              new EditOperationFailed({
                code: "INVALID_EDIT",
                message: "newText is identical to target; edit would be a no-op",
              }),
            );
          }

          let maxReplace: number;
          if (typeof occurrence === "number") {
            maxReplace = occurrence;
          } else {
            switch (occurrence) {
              case "first":
                maxReplace = 1;
                break;
              case "all":
                maxReplace = Number.MAX_SAFE_INTEGER;
                break;
            }
          }

          if (typeof occurrence === "number" && occurrence <= 0) {
            return this.editOperationFailure(
              resolvedPath,
              oldHash,
              editIndex,
              suppliedEdit,
              new EditOperationFailed({
                code: "INVALID_EDIT",
                message: "occurrence must be a positive number",
              }),
            );
          }

          const content = lines.join("\n");

          if (matching === "exact") {
            const matchesFound = countExactOccurrences(content, target);
            const matchError = enforceExpectedMatches(matchesFound, expectedMatches, target);
            if (matchError) {
              return this.editOperationFailure(
                resolvedPath,
                oldHash,
                editIndex,
                suppliedEdit,
                matchError,
              );
            }

            const replaced = replaceExactOccurrences(content, target, newText, maxReplace);

            lines = replaced.result.split("\n");
            replacementsMade += replaced.replacementsMade;
          } else {
            const compiled = compileEditRegex(target);
            if (compiled.status === "error") {
              return this.editOperationFailure(
                resolvedPath,
                oldHash,
                editIndex,
                suppliedEdit,
                compiled.error,
              );
            }
            const re = compiled.value;

            const matchesFound = countRegexMatches(content, re);
            const matchError = enforceExpectedMatches(matchesFound, expectedMatches, target);
            if (matchError) {
              return this.editOperationFailure(
                resolvedPath,
                oldHash,
                editIndex,
                suppliedEdit,
                matchError,
              );
            }

            const replaced = replaceRegexOccurrences(content, re, newText, maxReplace);

            lines = replaced.result.split("\n");
            replacementsMade += replaced.replacementsMade;
          }

          break;
        }
      }

      succeededOperations.push(edit.type);
    }

    const nextContent = lines.join("\n");
    const newHash = this.hash(nextContent);
    const changesMade = newHash !== oldHash;

    if (changesMade) {
      const written = await captureFilesystemOperation("write edited file", () =>
        fs.writeFile(canonicalPath, nextContent),
      );
      if (written.status === "error")
        return this.editFilesystemFailure(resolvedPath, written.error);
    }

    this.fileAccessRecord.set(resolvedPath, {
      lastAccess: Date.now(),
      fileHash: newHash,
    });

    this.fireEvent({
      type: "editFile",
      path: resolvedPath,
      accessAt: Date.now(),
      operations: succeededOperations,
    });

    return {
      success: true as const,
      resolvedPath,
      oldHash,
      newHash,
      changesMade,
      replacementsMade,
    };
  }

  async hashlineEditFile(
    {
      path,
      edits,
      expectedHash,
      dangerouslyAllow = false,
    }: {
      path: string;
      edits: readonly HashlineEdit[];
      expectedHash?: string;
      dangerouslyAllow?: boolean;
    },
    cwd?: string,
  ): Promise<HashlineEditFileResult> {
    const resolvedPath = this.resolvePath(path, cwd);
    const allowedPath = this.assertAllowed(resolvedPath, "editFile", dangerouslyAllow);
    if (allowedPath.status === "error")
      return this.editFilesystemFailure(resolvedPath, allowedPath.error);
    const canonical = await captureFilesystemOperation("resolve file for hashline editing", () =>
      fs.realpath(resolvedPath),
    );
    if (canonical.status === "error")
      return this.editFilesystemFailure(resolvedPath, canonical.error);
    const canonicalPath = canonical.value;
    const allowedCanonical = this.assertAllowed(canonicalPath, "editFile", dangerouslyAllow);
    if (allowedCanonical.status === "error") {
      return this.editFilesystemFailure(resolvedPath, allowedCanonical.error);
    }

    const lastAccess = this.fileAccessRecord.get(resolvedPath);
    const read = await captureFilesystemOperation("read file for hashline editing", () =>
      fs.readFile(canonicalPath, "utf-8"),
    );
    if (read.status === "error") return this.editFilesystemFailure(resolvedPath, read.error);
    const file = read.value;
    const oldHash = this.hash(file);

    if (expectedHash) {
      if (expectedHash !== oldHash) {
        return {
          success: false,
          resolvedPath,
          currentHash: oldHash,
          error: {
            code: "HASH_MISMATCH",
            message: `File has changed since last read: ${resolvedPath}`,
          },
        };
      }
    } else {
      if (!lastAccess) {
        return {
          success: false,
          resolvedPath,
          currentHash: oldHash,
          error: {
            code: "NOT_READ",
            message: `File must be read before editing: ${resolvedPath}`,
          },
        };
      }

      if (lastAccess.fileHash !== oldHash) {
        return {
          success: false,
          resolvedPath,
          currentHash: oldHash,
          error: {
            code: "HASH_MISMATCH",
            message: `File has changed since last read: ${resolvedPath}`,
          },
        };
      }
    }

    const applied = applyHashlineEdits({ content: file, edits });
    if (applied.status === "error") {
      return {
        success: false,
        resolvedPath,
        currentHash: oldHash,
        error: { code: applied.error.code, message: applied.error.message },
      };
    }
    const newHash = this.hash(applied.value.content);
    const changesMade = newHash !== oldHash;

    if (changesMade) {
      const written = await captureFilesystemOperation("write hashline-edited file", () =>
        fs.writeFile(canonicalPath, applied.value.content),
      );
      if (written.status === "error")
        return this.editFilesystemFailure(resolvedPath, written.error);
    }

    this.fileAccessRecord.set(resolvedPath, {
      lastAccess: Date.now(),
      fileHash: newHash,
    });

    this.fireEvent({
      type: "editFile",
      path: resolvedPath,
      accessAt: Date.now(),
      operations: ["replace_snippet"],
    });

    return {
      success: true,
      resolvedPath,
      oldHash,
      newHash,
      changesMade,
      replacementsMade: applied.value.appliedEditCount,
    };
  }

  /**
   * Globs files in the filesystem
   *
   * @param patterns Glob filters, e.g. ["\*\*\/*.ts", "!\*\*\/node_modules/**"]
   */
  async glob({ patterns, ...opts }: GlobOpts & { patterns: string[] }): Promise<GlobResult> {
    const {
      baseDir = this.root,
      maxEntries = 100,
      mode = "default",
      dangerouslyAllow = false,
    } = opts;
    const resolvedBaseDir = this.resolvePath(baseDir);

    const allowedPath = this.assertAllowed(resolvedBaseDir, "glob", dangerouslyAllow);
    if (allowedPath.status === "error") return this.globFailure(mode, allowedPath.error);
    const canonical = await captureFilesystemOperation("resolve glob root", () =>
      fs.realpath(resolvedBaseDir),
    );
    if (canonical.status === "error") return this.globFailure(mode, canonical.error);
    const canonicalBaseDir = canonical.value;
    const allowedCanonical = this.assertAllowed(canonicalBaseDir, "glob", dangerouslyAllow);
    if (allowedCanonical.status === "error") return this.globFailure(mode, allowedCanonical.error);

    const includes: string[] = [];
    const excludes: string[] = [];
    for (const pattern of patterns) {
      if (!pattern) continue;
      if (pattern.startsWith("!")) {
        const negated = normalizeGlobPatternForBase(pattern.slice(1), resolvedBaseDir);
        if (negated.length > 0) {
          excludes.push(negated);
        }
        continue;
      }
      includes.push(normalizeGlobPatternForBase(pattern, resolvedBaseDir));
    }

    if (includes.length === 0) {
      if (mode === "default") {
        return {
          mode,
          truncated: false,
          paths: [],
        };
      }
      return {
        mode,
        truncated: false,
        entries: [],
      };
    }

    if (this.fsBackend === "fff") {
      const normalizedPatterns = [...includes, ...excludes.map((pattern) => `!${pattern}`)];
      const fffResult = await getSearchBackend("fff").glob({
        cwd: canonicalBaseDir,
        patterns: normalizedPatterns,
        maxEntries,
        denyPaths: this.denyPaths,
        dangerouslyAllow,
        cacheDir: this.fffCacheDir,
      });

      if (fffResult) {
        if (mode === "default") {
          return {
            mode,
            truncated: fffResult.truncated,
            paths: fffResult.paths,
            effectiveBackend: fffResult.effectiveBackend,
          };
        }

        const entries: GlobEntry[] = [];
        for (const entry of fffResult.paths) {
          const stats = await captureFilesystemOperation("stat FFF glob result", () =>
            fs.stat(join(canonicalBaseDir, entry)),
          );
          if (stats.status === "error") return this.globFailure(mode, stats.error);
          entries.push({
            path: entry,
            type: this.getFileTypeFromStats(stats.value),
            size: stats.value.size,
          });
        }

        return {
          mode,
          truncated: fffResult.truncated,
          entries,
          effectiveBackend: fffResult.effectiveBackend,
        };
      }
    }

    const collected = await this.collectGlobMatches({
      resolvedBaseDir: canonicalBaseDir,
      includes,
      excludes,
      maxEntries,
      mode,
      dangerouslyAllow,
    });
    if (collected.status === "error") return this.globFailure(mode, collected.error);
    const { paths, entries, truncated } = collected.value;

    if (mode === "default") {
      return {
        mode,
        truncated,
        paths,
        effectiveBackend: "node-fs",
      };
    }

    return {
      mode,
      truncated,
      entries,
      effectiveBackend: "node-fs",
    };
  }

  async fuzzySearchFiles({
    query,
    ...opts
  }: {
    query: string;
    baseDir?: string;
    maxResults?: number;
    dangerouslyAllow?: boolean;
  }): Promise<FuzzySearchResult> {
    const { baseDir = this.root, maxResults = 50, dangerouslyAllow = false } = opts;
    const resolvedBaseDir = this.resolvePath(baseDir);

    const allowedPath = this.assertAllowed(resolvedBaseDir, "fuzzySearch", dangerouslyAllow);
    if (allowedPath.status === "error") return this.fuzzyFailure(allowedPath.error.message);
    const canonical = await captureFilesystemOperation("resolve fuzzy search root", () =>
      fs.realpath(resolvedBaseDir),
    );
    if (canonical.status === "error") return this.fuzzyFailure(canonical.error.message);
    const canonicalBaseDir = canonical.value;
    const allowedCanonical = this.assertAllowed(canonicalBaseDir, "fuzzySearch", dangerouslyAllow);
    if (allowedCanonical.status === "error")
      return this.fuzzyFailure(allowedCanonical.error.message);

    if (this.fsBackend !== "fff") {
      return {
        results: [],
        totalMatched: 0,
        totalFiles: 0,
        truncated: false,
        error: "fuzzy_search requires tools.fsBackend='fff'",
      };
    }

    const result = await fuzzyFileSearch({
      cwd: canonicalBaseDir,
      query,
      maxResults,
      denyPaths: this.denyPaths,
      dangerouslyAllow,
      cacheDir: this.fffCacheDir,
    });

    if (!result) {
      return {
        results: [],
        totalMatched: 0,
        totalFiles: 0,
        truncated: false,
        error: "fff fuzzy file search is unavailable for this path",
      };
    }

    return result;
  }

  async grep({ pattern, ...opts }: GrepOpts & { pattern: string }): Promise<GrepResult> {
    const {
      baseDir = this.root,
      regex = false,
      maxResults = 100,
      fileExtensions = [],
      includeContextLines = 0,
      mode = "default",
      dangerouslyAllow = false,
    } = opts;

    const resolvedBaseDir = this.resolvePath(baseDir);

    const allowedPath = this.assertAllowed(resolvedBaseDir, "grep", dangerouslyAllow);
    if (allowedPath.status === "error") return this.grepFailure(mode, allowedPath.error.message);
    const canonical = await captureFilesystemOperation("resolve grep target", () =>
      fs.realpath(resolvedBaseDir),
    );
    if (canonical.status === "error") return this.grepFailure(mode, canonical.error.message);
    const canonicalBaseDir = canonical.value;
    const allowedCanonical = this.assertAllowed(canonicalBaseDir, "grep", dangerouslyAllow);
    if (allowedCanonical.status === "error")
      return this.grepFailure(mode, allowedCanonical.error.message);
    const stats = await captureFilesystemOperation("stat grep target", () =>
      fs.stat(canonicalBaseDir),
    );
    if (stats.status === "error") return this.grepFailure(mode, stats.error.message);
    const targetStats = stats.value;
    if (!targetStats.isDirectory() && !targetStats.isFile()) {
      return this.grepFailure(
        mode,
        `Grep target '${resolvedBaseDir}' must be a regular file or directory`,
      );
    }

    const isFileTarget = targetStats.isFile();
    const searchCwd = isFileTarget ? dirname(canonicalBaseDir) : canonicalBaseDir;
    const searchPath = isFileTarget ? basename(canonicalBaseDir) : undefined;
    const reportedFilePath = opts.reportedFilePath ?? baseDir;

    const globs = fileExtensions.map((ext) => `**/*.${ext.replace(/^\./, "")}`);

    if (!dangerouslyAllow && !isFileTarget) {
      // Ensure ripgrep doesn't traverse blocked paths when searching from broad base dirs (e.g. "/").
      for (const denyAbs of this.denyPaths) {
        const rel = relative(canonicalBaseDir, denyAbs);
        if (rel.length === 0) continue;
        if (rel.startsWith("..") || rel.startsWith(sep)) continue;
        globs.push(`!${rel}`);
        globs.push(`!${rel}/**`);
      }
    }

    const extraArgs: string[] = [];
    if (includeContextLines > 0) {
      extraArgs.push("--context", String(includeContextLines));
    }

    const searched = await getSearchBackend(this.fsBackend).grep({
      pattern,
      regex,
      cwd: searchCwd,
      searchPath,
      maxMatches: maxResults,
      globs: globs.length > 0 ? globs : undefined,
      extraArgs,
      denyPaths: this.denyPaths,
      dangerouslyAllow,
      contextLines: includeContextLines,
      fffCacheDir: this.fffCacheDir,
    });
    if (searched.status === "error") return this.grepFailure(mode, searched.error.message);
    const ripgrepResult = searched.value;
    const fileMatchesExtensions =
      !isFileTarget ||
      fileExtensions.length === 0 ||
      fileExtensions.some((ext) => canonicalBaseDir.endsWith(`.${ext.replace(/^\./, "")}`));
    let matches = ripgrepResult.matches;
    if (!fileMatchesExtensions) {
      matches = [];
    } else if (isFileTarget) {
      matches = ripgrepResult.matches.map((match) => ({ ...match, file: reportedFilePath }));
    }
    const truncated = fileMatchesExtensions ? ripgrepResult.truncated : false;

    if (mode === "hashline") {
      const warnings: HashlineWarning[] = [];
      const rawResults = matches.map((match) => ({
        file: match.file,
        line: match.line,
        text: match.text,
      }));
      const hashlineResults: {
        file: string;
        resolvedPath: string;
        fileHash: string;
        line: number;
        text: string;
      }[] = [];
      const fileHashCache = new Map<string, string>();

      for (const match of matches) {
        const normalizedMatchText = match.text.replace(/\r?\n$/, "");

        if (normalizedMatchText.length > HASHLINE_MAX_LINE_CHARS) {
          warnings.push(buildHashlineWarning(match.line, normalizedMatchText.length));
          continue;
        }

        const resolvedMatchPath = isFileTarget
          ? canonicalBaseDir
          : this.resolvePath(match.file, resolvedBaseDir);
        let fileHash = fileHashCache.get(resolvedMatchPath);
        if (!fileHash) {
          const read = await captureFilesystemOperation("read hashline grep result", () =>
            fs.readFile(resolvedMatchPath, "utf-8"),
          );
          if (read.status === "error") return this.grepFailure(mode, read.error.message);
          fileHash = this.hash(read.value);
          fileHashCache.set(resolvedMatchPath, fileHash);
          const access = { lastAccess: Date.now(), fileHash };
          this.fileAccessRecord.set(resolvedMatchPath, access);
          if (isFileTarget) this.fileAccessRecord.set(resolvedBaseDir, access);
        }

        hashlineResults.push({
          file: match.file,
          resolvedPath: resolvedMatchPath,
          fileHash,
          line: match.line,
          text: formatHashlineWindow([normalizedMatchText], match.line),
        });
      }

      if (warnings.length > 0) {
        return {
          mode: "default",
          truncated,
          results: rawResults,
          effectiveBackend: ripgrepResult.effectiveBackend,
          warnings,
          degradedFromHashline: true,
        };
      }

      return {
        mode,
        truncated,
        results: hashlineResults,
        effectiveBackend: ripgrepResult.effectiveBackend,
      };
    }

    if (mode === "default") {
      const results = matches.map((match) => ({
        file: match.file,
        line: match.line,
        text: match.text,
      }));
      return {
        mode,
        truncated,
        results,
        effectiveBackend: ripgrepResult.effectiveBackend,
      };
    }

    return {
      mode,
      truncated,
      results: matches,
      effectiveBackend: ripgrepResult.effectiveBackend,
    };
  }

  private hash(input: string | Uint8Array) {
    const hasher = createHash("sha256");
    hasher.update(input);
    return hasher.digest("hex");
  }

  private readFailure(resolvedPath: string, error: FileSystemFailureDetails): ReadFileResult {
    return {
      success: false,
      resolvedPath,
      error: { code: toBasicFsErrorCode(error.code), message: error.message },
    };
  }

  private readBytesFailure(
    resolvedPath: string,
    error: FileSystemFailureDetails,
  ): ReadFileBytesResult {
    return {
      success: false,
      resolvedPath,
      error: { code: toBasicFsErrorCode(error.code), message: error.message },
    };
  }

  private writeFailure(resolvedPath: string, error: FileSystemFailureDetails): WriteFileResult {
    return {
      success: false,
      resolvedPath,
      error: { code: toBasicFsErrorCode(error.code), message: error.message },
    };
  }

  private editFilesystemFailure(
    resolvedPath: string,
    error: FileSystemFailureDetails,
  ): EditFileResult {
    return {
      success: false,
      resolvedPath,
      error: { code: toBasicFsErrorCode(error.code), message: error.message },
    };
  }

  private editOperationFailure(
    resolvedPath: string,
    currentHash: string,
    editIndex: number,
    edit: FileEdit,
    error: EditOperationFailed,
  ): EditFileResult {
    return {
      success: false,
      resolvedPath,
      currentHash,
      error: { code: error.code, message: error.message },
      errors: [{ code: error.code, message: error.message, editIndex, edit }],
    };
  }

  private globFailure(mode: SearchMode, error: FileSystemOperationFailed): GlobResult {
    if (mode === "default") {
      return { mode, truncated: false, paths: [], error: error.message };
    }
    return { mode, truncated: false, entries: [], error: error.message };
  }

  private fuzzyFailure(message: string): FuzzySearchResult {
    return {
      results: [],
      totalMatched: 0,
      totalFiles: 0,
      truncated: false,
      error: message,
    };
  }

  private grepFailure(mode: GrepMode, message: string): GrepResult {
    switch (mode) {
      case "default":
        return { mode, truncated: false, results: [], error: message };
      case "detailed":
        return { mode, truncated: false, results: [], error: message };
      case "hashline":
        return { mode, truncated: false, results: [], error: message };
    }
  }

  private getFileTypeFromStats(stats: Stats) {
    switch (true) {
      case stats.isSymbolicLink(): {
        return "symlink";
      }
      case stats.isFile(): {
        return "file";
      }
      case stats.isDirectory(): {
        return "directory";
      }
      case stats.isSocket(): {
        return "socket";
      }
      case stats.isBlockDevice(): {
        return "block_device";
      }
      case stats.isCharacterDevice(): {
        return "character_device";
      }
      case stats.isFIFO(): {
        return "fifo";
      }
      default: {
        return "unknown";
      }
    }
  }

  private async collectGlobMatches(params: {
    resolvedBaseDir: string;
    includes: readonly string[];
    excludes: readonly string[];
    maxEntries: number;
    mode: SearchMode;
    dangerouslyAllow: boolean;
  }): Promise<
    ResultType<
      { paths: string[]; entries: GlobEntry[]; truncated: boolean },
      FileSystemOperationFailed
    >
  > {
    const paths: string[] = [];
    const entries: GlobEntry[] = [];
    const seen = new Set<string>();
    let truncated = false;

    const addMatch = async (
      entry: string,
      abs: string,
    ): Promise<ResultType<void, FileSystemOperationFailed>> => {
      if (seen.has(entry)) return Result.ok(undefined);
      seen.add(entry);

      const count = params.mode === "default" ? paths.length : entries.length;
      if (count >= params.maxEntries) {
        truncated = true;
        return Result.ok(undefined);
      }

      if (params.mode === "default") {
        paths.push(entry);
        return Result.ok(undefined);
      }

      const stats = await captureFilesystemOperation("stat glob match", () => fs.stat(abs));
      if (stats.status === "ok") {
        entries.push({
          path: entry,
          type: this.getFileTypeFromStats(stats.value),
          size: stats.value.size,
        });
        return Result.ok(undefined);
      }
      if (isSkippableTraversalError(stats.error)) return Result.ok(undefined);
      return Result.err(stats.error);
    };

    const walk = async (relDir: string): Promise<ResultType<void, FileSystemOperationFailed>> => {
      if (truncated) return Result.ok(undefined);

      const absDir = relDir ? join(params.resolvedBaseDir, relDir) : params.resolvedBaseDir;
      if (!params.dangerouslyAllow && this.isDeniedPath(absDir)) return Result.ok(undefined);
      if (relDir && matchesAnyGlob(relDir, params.excludes)) return Result.ok(undefined);
      if (relDir && matchesAnyGlob(relDir, params.includes)) {
        const added = await addMatch(relDir, absDir);
        if (added.status === "error") return Result.err(added.error);
        if (truncated) return Result.ok(undefined);
      }

      const opened = await captureFilesystemOperation("open glob directory", () =>
        fs.opendir(absDir),
      );
      if (opened.status === "error") {
        if (isSkippableTraversalError(opened.error)) return Result.ok(undefined);
        return Result.err(opened.error);
      }

      const iterated = await captureFilesystemOperation("iterate glob directory", async () => {
        const dir = opened.value;
        for await (const dirent of dir) {
          if (truncated) break;

          const relPath = relDir ? `${relDir}/${dirent.name}` : dirent.name;
          const abs = join(params.resolvedBaseDir, relPath);

          if (!params.dangerouslyAllow && this.isDeniedPath(abs)) continue;
          if (matchesAnyGlob(relPath, params.excludes)) continue;

          if (matchesAnyGlob(relPath, params.includes)) {
            const added = await addMatch(relPath, abs);
            if (added.status === "error") return Result.err(added.error);
          }

          if (dirent.isDirectory()) {
            const walked = await walk(relPath);
            if (walked.status === "error") return Result.err(walked.error);
          }
        }
        return Result.ok(undefined);
      });
      if (iterated.status === "error") {
        if (isSkippableTraversalError(iterated.error)) return Result.ok(undefined);
        return Result.err(iterated.error);
      }
      return iterated.value;
    };

    for (const root of getGlobSearchRoots(params.includes)) {
      const walked = await walk(root);
      if (walked.status === "error") return Result.err(walked.error);
    }

    return Result.ok({ paths, entries, truncated });
  }

  private fireEvent(event: FileSystemEvent) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
