import { tool } from "ai";
import { z } from "zod/v4";
import {
  EDIT_ERROR_CODES,
  FileSystem,
  READ_ERROR_CODES,
  expandTilde,
  grepText,
  type EffectiveFuzzySearchBackend,
  type EffectiveSearchBackend,
  type FileEdit,
  type FsBackend,
  type GrepMode,
  type HashlineEdit,
  type HashlineWarning,
  type ReadFileStart,
} from "@stanley2058/lilac-fs";
import { createLogger, env } from "@stanley2058/lilac-utils";
import { boundGrepOutput } from "@stanley2058/lilac-coding-tools/search-output";
import {
  createReadFileInstructionClaims,
  loadReadFileInstructions,
  READ_FILE_INSTRUCTION_HINT,
} from "@stanley2058/lilac-coding-tools/instructions";
import {
  createEditFileInputSchema,
  createGrepInputSchema,
  createReadFileInputSchema,
  editFileInputSchema as sharedEditFileInputSchema,
  fuzzySearchInputSchema as sharedFuzzySearchInputSchema,
  globInputSchema as sharedGlobInputSchema,
  grepInputSchema as sharedGrepInputSchema,
  readFileInputSchema as sharedReadFileInputSchema,
} from "@stanley2058/lilac-coding-tools/schemas";
import { fileTypeFromBuffer } from "file-type";
import path from "node:path";

import {
  adaptToolResultArtifactReadToUnavailablePolicy,
  TOOL_RESULT_UNAVAILABLE_MESSAGE,
  TOOL_RESULT_URI_PREFIX,
  type ToolResultArtifactStore,
} from "../../artifacts/tool-result-artifact-store";
import type { ToolResultOutput } from "../../artifacts/tool-result-output-normalizer";
import { inferMimeTypeFromFilename } from "../../shared/attachment-utils";
import { parseSshCwdTarget } from "../../ssh/ssh-cwd";
import {
  remoteFuzzySearch,
  remoteGrep,
  remoteGlob,
  remoteEditFile,
  remoteReadFileBytes,
  remoteReadTextFile,
  toRemoteDebugPath,
  type RemoteFuzzySearchOutput,
} from "./remote-fs";

const readErrorCodeSchema = z.enum(READ_ERROR_CODES);
const editErrorCodeSchema = z.enum(EDIT_ERROR_CODES);
const warningZod = z.object({
  code: z.literal("LINE_TOO_LONG_FOR_HASHLINE"),
  message: z.string(),
  line: z.number(),
  maxLength: z.number(),
  actualLength: z.number(),
});

const REMOTE_DENY_PATHS = ["~/.ssh", "~/.aws", "~/.gnupg"] as const;
const FFF_CACHE_DIR = path.join(env.dataDir, ".cache", "fff");

function resolveRemoteDenyPaths(dangerouslyAllow?: boolean): readonly string[] {
  return dangerouslyAllow === true ? [] : REMOTE_DENY_PATHS;
}

export const readFileInputZod = sharedReadFileInputSchema;

type ReadFileInput = {
  path: string;
  cwd?: string;
  start?: ReadFileStart;
  maxLines?: number;
  maxCharacters?: number;
  format?: "raw" | "numbered" | "hashline";
  dangerouslyAllow?: boolean;
};

const globEntryTypeSchema = z.enum([
  "symlink",
  "file",
  "directory",
  "socket",
  "block_device",
  "character_device",
  "fifo",
  "unknown",
]);

export const globInputZod = sharedGlobInputSchema;

type GlobInput = z.infer<typeof globInputZod>;

const globOutputZod = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("default"),
    truncated: z.boolean(),
    paths: z.array(z.string()),
    error: z.string().optional(),
    truncationHint: z.string().optional(),
  }),
  z.object({
    mode: z.literal("detailed"),
    truncated: z.boolean(),
    entries: z.array(
      z.object({
        path: z.string(),
        type: globEntryTypeSchema,
        size: z.number(),
      }),
    ),
    error: z.string().optional(),
    truncationHint: z.string().optional(),
  }),
]);

type GlobOutput = z.infer<typeof globOutputZod>;

export const fuzzySearchInputZod = sharedFuzzySearchInputSchema;

type FuzzySearchInput = z.infer<typeof fuzzySearchInputZod>;

const fuzzySearchOutputZod = z.object({
  results: z.array(
    z.object({
      path: z.string(),
      fileName: z.string(),
      size: z.number(),
      gitStatus: z.string(),
      score: z.number().optional(),
      matchType: z.string().optional(),
    }),
  ),
  totalMatched: z.number(),
  totalFiles: z.number(),
  truncated: z.boolean(),
  error: z.string().optional(),
  truncationHint: z.string().optional(),
});

type FuzzySearchOutput = z.infer<typeof fuzzySearchOutputZod>;

export const grepInputZod = sharedGrepInputSchema;

type GrepInput = {
  pattern: string;
  path?: string;
  regex?: boolean;
  maxResults?: number;
  fileExtensions?: string[];
  mode?: GrepMode;
  dangerouslyAllow?: boolean;
};

const grepOutputBase = z.object({
  truncated: z.boolean(),
  warnings: z.array(warningZod).optional(),
  degradedFromHashline: z.boolean().optional(),
  error: z.string().optional(),
  truncationHint: z.string().optional(),
});

function buildGrepOutputZod(hashlineEnabled: boolean) {
  return z.discriminatedUnion("mode", [
    z
      .object({
        mode: z.literal("default"),
      })
      .extend(grepOutputBase.shape)
      .extend({
        results: z.array(
          z.object({
            file: z.string(),
            line: z.number(),
            text: z.string(),
          }),
        ),
      }),
    z
      .object({
        mode: z.literal("detailed"),
      })
      .extend(grepOutputBase.shape)
      .extend({
        results: z.array(
          z.object({
            file: z.string(),
            line: z.number(),
            column: z.number(),
            text: z.string(),
            submatches: z
              .array(
                z.object({
                  match: z.string(),
                  start: z.number(),
                  end: z.number(),
                }),
              )
              .optional(),
          }),
        ),
      }),
    ...(hashlineEnabled
      ? [
          z
            .object({
              mode: z.literal("hashline"),
            })
            .extend(grepOutputBase.shape)
            .extend({
              results: z.array(
                z.object({
                  file: z.string(),
                  resolvedPath: z.string(),
                  fileHash: z.string(),
                  line: z.number(),
                  text: z.string(),
                }),
              ),
            }),
        ]
      : []),
  ]);
}

type GrepOutput =
  | {
      mode: "default";
      truncated: boolean;
      warnings?: HashlineWarning[];
      degradedFromHashline?: boolean;
      results: { file: string; line: number; text: string }[];
      error?: string;
      truncationHint?: string;
    }
  | {
      mode: "detailed";
      truncated: boolean;
      warnings?: HashlineWarning[];
      degradedFromHashline?: boolean;
      results: {
        file: string;
        line: number;
        column: number;
        text: string;
        submatches?: { match: string; start: number; end: number }[];
      }[];
      error?: string;
      truncationHint?: string;
    }
  | {
      mode: "hashline";
      truncated: boolean;
      warnings?: HashlineWarning[];
      degradedFromHashline?: boolean;
      results: {
        file: string;
        resolvedPath: string;
        fileHash: string;
        line: number;
        text: string;
      }[];
      error?: string;
      truncationHint?: string;
    };

export const editFileInputZod = sharedEditFileInputSchema;

type LegacyEditFileInput = {
  path: string;
  cwd?: string;
  oldText: string;
  newText: string;
  matching?: "exact" | "regex";
  replaceAll?: boolean;
  expectedMatches?: "any" | number;
  expectedHash?: string;
  dangerouslyAllow?: boolean;
};

type HashlineEditFileInput = {
  path: string;
  cwd?: string;
  edits: HashlineEdit[];
  expectedHash?: string;
  dangerouslyAllow?: boolean;
};

type EditFileInput = LegacyEditFileInput | HashlineEditFileInput;

function isLegacyEditFileInput(input: EditFileInput): input is LegacyEditFileInput {
  return "oldText" in input;
}

const editFileOutputZod = z.union([
  z.object({
    success: z.literal(true),
    resolvedPath: z.string(),
    oldHash: z.string(),
    newHash: z.string(),
    changesMade: z.boolean(),
    replacementsMade: z.number(),
  }),
  z.object({
    success: z.literal(false),
    resolvedPath: z.string(),
    currentHash: z.string().optional(),
    error: z.object({
      code: editErrorCodeSchema,
      message: z.string(),
    }),
  }),
]);

type EditFileOutput = z.infer<typeof editFileOutputZod>;

function countGlobItems(output: GlobOutput): number {
  if (output.mode === "default") return output.paths.length;
  return output.entries.length;
}

function countGrepItems(output: GrepOutput): number {
  return output.results.length;
}

function grepFailure(mode: GrepMode, error: string): GrepOutput {
  switch (mode) {
    case "default":
      return { mode, truncated: false, results: [], error };
    case "detailed":
      return { mode, truncated: false, results: [], error };
    case "hashline":
      return { mode, truncated: false, results: [], error };
  }
}

type SearchBackendMetadata = { effectiveBackend?: EffectiveSearchBackend };
type FuzzySearchBackendMetadata = { effectiveBackend?: EffectiveFuzzySearchBackend };

function stripGlobMetadata(output: GlobOutput & SearchBackendMetadata): GlobOutput {
  const { effectiveBackend: _effectiveBackend, ...rest } = output;
  return rest;
}

function stripFuzzySearchMetadata(
  output: FuzzySearchOutput & FuzzySearchBackendMetadata,
): FuzzySearchOutput {
  const { effectiveBackend: _effectiveBackend, ...rest } = output;
  return rest;
}

function stripGrepMetadata(output: GrepOutput & SearchBackendMetadata): GrepOutput {
  const { effectiveBackend: _effectiveBackend, ...rest } = output;
  return rest;
}

const SEARCH_TRUNCATION_HINT =
  "Search output reached the serialized-size limit. Narrow the query or inspect source files with read.";

function buildInlineMediaLimitMessage(params: {
  filename: string;
  mimeType: string;
  maxBytes: number;
  detail?: string;
}): string {
  const guidance = params.mimeType.startsWith("image/")
    ? "Resize or compress the image, then read the smaller file."
    : "Reduce or compress the file, then read the smaller file.";
  return `Cannot inline '${params.filename}' (${params.mimeType}): it exceeds the ${params.maxBytes}-byte media limit${params.detail ? ` (${params.detail})` : ""}. ${guidance}`;
}

function truncateUnicodeString(
  value: string,
  maxCharacters: number,
  preservePrefixWhenTiny = false,
): string {
  const characters = Array.from(value);
  if (characters.length <= maxCharacters) return value;

  const marker = "...[truncated]";
  if (maxCharacters <= marker.length) {
    return preservePrefixWhenTiny
      ? characters.slice(0, maxCharacters).join("")
      : marker.slice(0, maxCharacters);
  }
  return `${characters.slice(0, maxCharacters - marker.length).join("")}${marker}`;
}

type BoundedSearchOutput = GlobOutput | FuzzySearchOutput | GrepOutput;
type BoundedSearchEntry =
  | string
  | Extract<GlobOutput, { mode: "detailed" }>["entries"][number]
  | FuzzySearchOutput["results"][number]
  | GrepOutput["results"][number];

function truncateSearchEntryStrings(
  value: BoundedSearchEntry,
  maxStringCharacters: number,
): BoundedSearchEntry {
  if (typeof value === "string") return truncateUnicodeString(value, maxStringCharacters);

  const entries = Object.entries(value).map(([key, item]) => {
    if (typeof item === "string") return [key, truncateUnicodeString(item, maxStringCharacters)];
    if (Array.isArray(item)) {
      return [
        key,
        item.map((submatch) => ({
          ...submatch,
          match: truncateUnicodeString(submatch.match, maxStringCharacters),
        })),
      ];
    }
    return [key, item];
  });
  return Object.fromEntries(entries) as BoundedSearchEntry;
}

function searchEntries(
  output: BoundedSearchOutput,
  entriesKey: "paths" | "entries" | "results",
): BoundedSearchEntry[] {
  if (entriesKey === "paths" && "paths" in output) return output.paths;
  if (entriesKey === "entries" && "entries" in output) return output.entries;
  if (entriesKey === "results" && "results" in output) return output.results;
  return [];
}

function removeSearchDiagnostics(output: BoundedSearchOutput): void {
  if ("warnings" in output) delete output.warnings;
  if ("degradedFromHashline" in output) delete output.degradedFromHashline;
}

function hasSearchFailure(output: BoundedSearchOutput): boolean {
  return typeof output.error === "string";
}

function boundSearchOutput<T extends BoundedSearchOutput>(
  output: T,
  entriesKey: "paths" | "entries" | "results",
  maxBytes: number,
): T {
  const effectiveConfiguredMaxBytes = Math.max(2, maxBytes);
  const serializedBytes = (value: BoundedSearchOutput) =>
    Buffer.byteLength(JSON.stringify(value), "utf8");
  if (serializedBytes(output) <= effectiveConfiguredMaxBytes) return output;

  const next = structuredClone(output);
  next.truncated = true;
  next.truncationHint = SEARCH_TRUNCATION_HINT;
  const entries = searchEntries(next, entriesKey);
  const minimum = structuredClone(next);
  searchEntries(minimum, entriesKey).splice(0);
  removeSearchDiagnostics(minimum);
  if (typeof minimum.error === "string") {
    minimum.error = truncateUnicodeString(minimum.error, 160, true);
  }
  const effectiveMaxBytes = Math.max(effectiveConfiguredMaxBytes, serializedBytes(minimum));

  while (entries.length > 1 && serializedBytes(next) > effectiveMaxBytes) entries.pop();

  let maxStringCharacters = Math.max(1, Math.floor(effectiveMaxBytes / 4));
  while (entries.length === 1 && serializedBytes(next) > effectiveMaxBytes) {
    entries[0] = truncateSearchEntryStrings(entries[0]!, maxStringCharacters);
    if (maxStringCharacters === 1) {
      entries.pop();
      break;
    }
    maxStringCharacters = Math.max(1, Math.floor(maxStringCharacters / 2));
  }

  if (serializedBytes(next) <= effectiveMaxBytes) return next;

  // Error results should continue to communicate failure, even when their details are bounded.
  const originalError = next.error;
  removeSearchDiagnostics(next);

  if (originalError !== undefined && serializedBytes(next) > effectiveMaxBytes) {
    const errorCharacters = Array.from(originalError).length;
    let low = 1;
    let high = errorCharacters;
    let best = "Error";

    next.error = best;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = truncateUnicodeString(originalError, middle, true);
      next.error = candidate;
      if (serializedBytes(next) <= effectiveMaxBytes) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    next.error = best;
  }

  if (serializedBytes(next) > effectiveMaxBytes) entries.splice(0);
  if (serializedBytes(next) > effectiveMaxBytes && originalError !== undefined) {
    next.error = "Error";
  }

  if (serializedBytes(next) > effectiveMaxBytes) return minimum;

  return next;
}

const instructionFieldsZod = z.object({
  loadedInstructions: z
    .array(z.string())
    .optional()
    .describe("Instruction file paths loaded for this read call"),
  instructionsText: z
    .string()
    .optional()
    .describe("Instruction text auto-loaded from AGENTS.md files. Intended for model context."),
  warnings: z.array(warningZod).optional(),
  degradedFromHashline: z.boolean().optional(),
});

const readFileOffsetStartZod = z.object({
  type: z.literal("offset"),
  offset: z.number().int().nonnegative(),
});
const readFileLineStartZod = z.object({
  type: z.literal("line"),
  line: z.number().int().positive(),
  column: z.number().int().nonnegative().optional(),
});
const readFileStartZod = z.discriminatedUnion("type", [
  readFileOffsetStartZod,
  readFileLineStartZod,
]);

const readFileSuccessBaseZod = z
  .object({
    success: z.literal(true),
    resolvedPath: z.string(),
    fileHash: z.string(),
    startLine: z.number(),
    endLine: z.number(),
    totalLines: z.number(),
    hasMoreLines: z.boolean(),
    truncatedByChars: z.boolean(),
    nextStart: readFileStartZod.optional(),
  })
  .extend(instructionFieldsZod.shape);

const readFileAttachmentSuccessZod = z
  .object({
    success: z.literal(true),
    kind: z.literal("attachment"),
    resolvedPath: z.string(),
    fileHash: z.string(),
    filename: z.string(),
    mimeType: z.string(),
    bytes: z.number(),
  })
  .extend(instructionFieldsZod.shape);

const readFileArtifactSuccessZod = z.object({
  success: z.literal(true),
  kind: z.literal("artifact"),
  resolvedPath: z.string(),
  content: z.string(),
  startOffset: z.number(),
  endOffset: z.number(),
  totalCharacters: z.number(),
  nextStart: readFileStartZod.optional(),
  hasMore: z.boolean(),
});

function buildReadFileOutputZod(hashlineEnabled: boolean) {
  return z.union([
    readFileSuccessBaseZod.extend({
      format: z.literal("raw"),
      content: z.string(),
    }),
    readFileSuccessBaseZod.extend({
      format: z.literal("numbered"),
      numberedContent: z.string(),
    }),
    ...(hashlineEnabled
      ? [
          readFileSuccessBaseZod.extend({
            format: z.literal("hashline"),
            hashlineContent: z.string(),
          }),
        ]
      : []),
    readFileAttachmentSuccessZod,
    readFileArtifactSuccessZod,
    z.object({
      success: z.literal(false),
      resolvedPath: z.string(),
      error: z.object({
        code: readErrorCodeSchema,
        message: z.string(),
      }),
    }),
  ]);
}

type InstructionFields = {
  loadedInstructions?: string[];
  instructionsText?: string;
  warnings?: HashlineWarning[];
  degradedFromHashline?: boolean;
};

type ReadFileOutput =
  | {
      success: true;
      kind: "artifact";
      resolvedPath: string;
      content: string;
      startOffset: number;
      endOffset: number;
      totalCharacters: number;
      nextStart?: ReadFileStart;
      hasMore: boolean;
    }
  | ({
      success: true;
      resolvedPath: string;
      fileHash: string;
      startLine: number;
      endLine: number;
      totalLines: number;
      hasMoreLines: boolean;
      truncatedByChars: boolean;
      nextStart?: ReadFileStart;
      format: "raw";
      content: string;
    } & InstructionFields)
  | ({
      success: true;
      resolvedPath: string;
      fileHash: string;
      startLine: number;
      endLine: number;
      totalLines: number;
      hasMoreLines: boolean;
      truncatedByChars: boolean;
      nextStart?: ReadFileStart;
      format: "numbered";
      numberedContent: string;
    } & InstructionFields)
  | ({
      success: true;
      resolvedPath: string;
      fileHash: string;
      startLine: number;
      endLine: number;
      totalLines: number;
      hasMoreLines: boolean;
      truncatedByChars: boolean;
      nextStart?: ReadFileStart;
      format: "hashline";
      hashlineContent: string;
    } & InstructionFields)
  | ({
      success: true;
      kind: "attachment";
      resolvedPath: string;
      fileHash: string;
      filename: string;
      mimeType: string;
      bytes: number;
    } & InstructionFields)
  | {
      success: false;
      resolvedPath: string;
      error: { code: (typeof READ_ERROR_CODES)[number]; message: string };
    };

function resolveExpectedMatches(input: LegacyEditFileInput): "any" | number {
  if (input.expectedMatches !== undefined) return input.expectedMatches;
  return input.replaceAll ? "any" : 1;
}

function normalizeEditOutput(output: {
  success: boolean;
  resolvedPath: string;
  oldHash?: string;
  newHash?: string;
  changesMade?: boolean;
  replacementsMade?: number;
  currentHash?: string;
  error?: { code: (typeof EDIT_ERROR_CODES)[number]; message: string };
}): EditFileOutput {
  if (output.success) {
    return {
      success: true,
      resolvedPath: output.resolvedPath,
      oldHash: output.oldHash ?? "",
      newHash: output.newHash ?? "",
      changesMade: Boolean(output.changesMade),
      replacementsMade: output.replacementsMade ?? 0,
    };
  }

  return {
    success: false,
    resolvedPath: output.resolvedPath,
    currentHash: output.currentHash,
    error: output.error ?? {
      code: "UNKNOWN",
      message: "Unknown edit error",
    },
  };
}

export function fsTool(
  cwd: string,
  opts?: {
    includeEditFile?: boolean;
    experimentalHashlineEdit?: boolean;
    fsBackend?: FsBackend;
    readFileDirectAttachmentSupported?: boolean;
    maxOutputBytes?: number;
    maxInlineMediaBytesPerPart?: number;
    artifactOnly?: boolean;
    toolResultArtifacts?: ToolResultArtifactStore;
    requestContext?: {
      requestId: string;
      sessionId: string;
    };
    loadInstructions?: boolean;
    denyPaths?: readonly string[];
    enforceDenylist?: boolean;
  },
) {
  const logger = createLogger({
    module: "tool:fs",
  });
  const includeEditFile = opts?.includeEditFile ?? false;
  const hashlineEnabled = opts?.experimentalHashlineEdit === true;
  const fsBackend = opts?.fsBackend ?? "node-rg";
  const readFileDirectAttachmentSupported = opts?.readFileDirectAttachmentSupported === true;
  const maxOutputBytes = opts?.maxOutputBytes ?? 40 * 1024;
  const maxInlineMediaBytesPerPart = opts?.maxInlineMediaBytesPerPart ?? 10 * 1024 * 1024;
  const readFileSchema = createReadFileInputSchema({
    hashlineEnabled,
    directAttachmentSupported: readFileDirectAttachmentSupported,
  });
  const readFileOutputSchema = buildReadFileOutputZod(hashlineEnabled);
  const grepInputSchema = createGrepInputSchema(hashlineEnabled);
  const grepOutputSchema = buildGrepOutputZod(hashlineEnabled);
  const editFileSchema = createEditFileInputSchema(hashlineEnabled);

  const toolRootAbs = path.resolve(expandTilde(cwd));

  const denyPaths = [
    path.join(env.dataDir, "secret"),
    path.join(env.dataDir, "tool-results"),
    "~/.ssh",
    "~/.aws",
    "~/.gnupg",
    ...(opts?.denyPaths ?? []),
  ];
  const fileSystem = new FileSystem(cwd, {
    denyPaths,
    fsBackend,
    fffCacheDir: FFF_CACHE_DIR,
    fuzzySearchFallback: "fzf",
  });

  const attachmentExts = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf"]);

  const imageMimeTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
  const attachmentMimeTypes = new Set([...imageMimeTypes, "application/pdf"]);

  const binaryCacheByToolCallId = new Map<
    string,
    {
      resolvedPath: string;
      filename: string;
      mimeType: string;
      bytes: Buffer;
      fileHash: string;
    }
  >();
  const instructionClaims = createReadFileInstructionClaims();

  function buildReadFileDescription(): string {
    let introduction: string;
    if (readFileDirectAttachmentSupported) {
      introduction =
        "Reads files from the filesystem. For supported images and PDFs, calling read attaches the original file to your context for native visual or document analysis. Call read first for an image or PDF path, either directly or as an independent batch child; use shell media processing only if read reports that the input is unsupported or oversized.";
    } else if (hashlineEnabled) {
      introduction =
        "Reads a file from the filesystem. Default format is raw to preserve indentation. Use format='hashline' before edit when you need stable edit anchors. Very long lines may downgrade the response back to raw with a warning that tells you to use bash instead.";
    } else {
      introduction =
        "Reads a file from the filesystem. Default format is raw (no line numbers) to preserve indentation.";
    }
    const parts = [introduction];

    if (readFileDirectAttachmentSupported && hashlineEnabled) {
      parts.push(
        "For text files, default format is raw to preserve indentation. Use format='hashline' before edit when you need stable edit anchors. Very long lines may downgrade the response back to raw with a warning that tells you to use bash instead.",
      );
    } else if (readFileDirectAttachmentSupported) {
      parts.push(
        "For text files, default format is raw (no line numbers) to preserve indentation.",
      );
    }

    parts.push(
      "Use maxCharacters with either absolute offset or line/column start positions to page through text resources. Absolute offsets count Unicode characters including newlines. Reuse nextStart unchanged to continue.",
    );
    parts.push(READ_FILE_INSTRUCTION_HINT);
    parts.push("Denylisted paths require dangerouslyAllow=true.");
    return parts.join(" ");
  }

  const remoteFileAccessByResolvedPath = new Map<string, string>();
  const remoteResolvedPathByLookup = new Map<string, string>();

  function remoteResolvedPathKey(host: string, resolvedPath: string): string {
    return `${host}|${resolvedPath}`;
  }

  function remoteLookupKey(host: string, remoteCwd: string, inputPath: string): string {
    return `${host}|${remoteCwd}|${inputPath}`;
  }

  function normalizeRemoteLookupInputPath(inputPath: string): string {
    return inputPath.replace(/^\.\//, "");
  }

  function recordRemoteFileAccess(params: {
    host: string;
    remoteCwd: string;
    inputPath: string;
    resolvedPath: string;
    fileHash: string;
  }) {
    remoteFileAccessByResolvedPath.set(
      remoteResolvedPathKey(params.host, params.resolvedPath),
      params.fileHash,
    );
    remoteResolvedPathByLookup.set(
      remoteLookupKey(
        params.host,
        params.remoteCwd,
        normalizeRemoteLookupInputPath(params.inputPath),
      ),
      params.resolvedPath,
    );
  }

  function lookupRemoteReadHash(params: {
    host: string;
    remoteCwd: string;
    inputPath: string;
  }): { resolvedPath: string; hash: string } | null {
    const resolvedPath = remoteResolvedPathByLookup.get(
      remoteLookupKey(
        params.host,
        params.remoteCwd,
        normalizeRemoteLookupInputPath(params.inputPath),
      ),
    );
    if (!resolvedPath) return null;

    const hash = remoteFileAccessByResolvedPath.get(
      remoteResolvedPathKey(params.host, resolvedPath),
    );
    if (!hash) return null;

    return { resolvedPath, hash };
  }

  const baseTools = {
    read: tool({
      description: buildReadFileDescription(),
      inputSchema: readFileSchema,
      outputSchema: readFileOutputSchema,
      execute: async ({ cwd: opCwd, dangerouslyAllow, ...input }: ReadFileInput, options) => {
        if (opts?.enforceDenylist) dangerouslyAllow = false;
        if (input.path.startsWith(TOOL_RESULT_URI_PREFIX)) {
          const sessionId = opts?.requestContext?.sessionId;
          const artifact =
            opts?.toolResultArtifacts && sessionId
              ? await adaptToolResultArtifactReadToUnavailablePolicy(
                  opts.toolResultArtifacts,
                  await opts.toolResultArtifacts.readWindow(input.path, sessionId, {
                    start: input.start ?? { type: "offset", offset: 0 },
                    maxCharacters: Math.max(1, input.maxCharacters ?? 10_000),
                    maxLines: Math.max(1, input.maxLines ?? 2_000),
                    maxOutputBytes,
                  }),
                )
              : { ok: false as const };
          if (!artifact.ok) {
            return {
              success: false as const,
              resolvedPath: input.path,
              error: {
                code: "UNKNOWN" as const,
                message: TOOL_RESULT_UNAVAILABLE_MESSAGE,
              },
            };
          }

          return {
            success: true as const,
            kind: "artifact" as const,
            resolvedPath: input.path,
            content: artifact.content,
            startOffset: artifact.startOffset,
            endOffset: artifact.endOffset,
            totalCharacters: artifact.totalCharacters,
            ...(artifact.nextStart ? { nextStart: artifact.nextStart } : {}),
            hasMore: artifact.hasMore,
          };
        }

        if (opts?.artifactOnly) {
          return {
            success: false as const,
            resolvedPath: input.path,
            error: {
              code: "PERMISSION" as const,
              message: "Restricted sessions can use read only with tool-result:// artifacts.",
            },
          };
        }

        const cwdTarget = parseSshCwdTarget(opCwd);
        const remoteDenyPaths = resolveRemoteDenyPaths(dangerouslyAllow);

        logger.info("fs.readFile", {
          path: input.path,
          cwd: opCwd,
          target: cwdTarget.kind,
          start: input.start,
          maxLines: input.maxLines,
          maxCharacters: input.maxCharacters,
          format: input.format ?? "raw",
          dangerouslyAllow: dangerouslyAllow === true,
        });

        const ext = path.extname(input.path).toLowerCase();
        const wantsAttachment = readFileDirectAttachmentSupported && attachmentExts.has(ext);

        const res: ReadFileOutput = await (async (): Promise<ReadFileOutput> => {
          if (wantsAttachment) {
            if (cwdTarget.kind === "ssh") {
              const bytesRes = await remoteReadFileBytes({
                host: cwdTarget.host,
                cwd: cwdTarget.cwd,
                filePath: input.path,
                denyPaths: remoteDenyPaths,
                maxBytes: maxInlineMediaBytesPerPart,
                signal: options.abortSignal,
              });

              if (bytesRes.status === "error") {
                return {
                  success: false,
                  resolvedPath: toRemoteDebugPath(cwdTarget.host, input.path),
                  error: { code: "UNKNOWN", message: bytesRes.error.message },
                };
              }
              const bytesOutput = bytesRes.value;
              if (!bytesOutput.ok) {
                const filename = path.basename(input.path);
                const mimeType = inferMimeTypeFromFilename(filename);
                const message = /too large|media limit|maximum \d+ bytes/i.test(bytesOutput.error)
                  ? buildInlineMediaLimitMessage({
                      filename,
                      mimeType,
                      maxBytes: maxInlineMediaBytesPerPart,
                      detail: bytesOutput.error,
                    })
                  : bytesOutput.error;
                return {
                  success: false as const,
                  resolvedPath: toRemoteDebugPath(cwdTarget.host, input.path),
                  error: {
                    code: "UNKNOWN" as const,
                    message,
                  },
                };
              }

              const bytes = Buffer.from(bytesOutput.base64, "base64");
              const remoteResolvedPath = toRemoteDebugPath(
                cwdTarget.host,
                bytesOutput.resolvedPath,
              );
              recordRemoteFileAccess({
                host: cwdTarget.host,
                remoteCwd: cwdTarget.cwd,
                inputPath: input.path,
                resolvedPath: bytesOutput.resolvedPath,
                fileHash: bytesOutput.fileHash,
              });
              const filename = path.basename(bytesOutput.resolvedPath);

              const detected = await fileTypeFromBuffer(bytes);
              if (!detected || !attachmentMimeTypes.has(detected.mime)) {
                return {
                  success: false as const,
                  resolvedPath: remoteResolvedPath,
                  error: {
                    code: "UNKNOWN" as const,
                    message: `Cannot attach '${filename}': its content is not a supported image or PDF.`,
                  },
                };
              }
              const mimeType = detected.mime;

              binaryCacheByToolCallId.set(options.toolCallId, {
                resolvedPath: remoteResolvedPath,
                filename,
                mimeType,
                bytes,
                fileHash: bytesOutput.fileHash,
              });

              return {
                success: true as const,
                kind: "attachment" as const,
                resolvedPath: remoteResolvedPath,
                fileHash: bytesOutput.fileHash,
                filename,
                mimeType,
                bytes: bytesOutput.bytesLength,
              };
            }

            const bytesRes = await fileSystem.readFileBytes(
              {
                path: input.path,
                dangerouslyAllow,
                maxBytes: maxInlineMediaBytesPerPart,
              },
              opCwd,
            );
            if (!bytesRes.success) {
              if (/too large|media limit|maximum \d+ bytes/i.test(bytesRes.error.message)) {
                const filename = path.basename(bytesRes.resolvedPath);
                const mimeType = inferMimeTypeFromFilename(filename);
                return {
                  ...bytesRes,
                  error: {
                    ...bytesRes.error,
                    message: buildInlineMediaLimitMessage({
                      filename,
                      mimeType,
                      maxBytes: maxInlineMediaBytesPerPart,
                      detail: bytesRes.error.message,
                    }),
                  },
                };
              }
              return bytesRes;
            }

            const resolvedPath = bytesRes.resolvedPath;
            const filename = path.basename(resolvedPath);

            const detected = await fileTypeFromBuffer(bytesRes.bytes);
            if (!detected || !attachmentMimeTypes.has(detected.mime)) {
              return {
                success: false as const,
                resolvedPath,
                error: {
                  code: "UNKNOWN" as const,
                  message: `Cannot attach '${filename}': its content is not a supported image or PDF.`,
                },
              };
            }
            const mimeType = detected.mime;

            binaryCacheByToolCallId.set(options.toolCallId, {
              resolvedPath,
              filename,
              mimeType,
              bytes: bytesRes.bytes,
              fileHash: bytesRes.fileHash,
            });

            const instructions = await loadReadFileInstructions({
              resolvedPath,
              requestedPath: input.path,
              cwd: opCwd ?? toolRootAbs,
              messages: options.messages,
              denyPaths,
              claimedInstructionPaths: instructionClaims.forMessages(options.messages),
            });

            return {
              success: true as const,
              kind: "attachment" as const,
              resolvedPath,
              fileHash: bytesRes.fileHash,
              filename,
              mimeType,
              bytes: bytesRes.bytesLength,
              ...(instructions
                ? {
                    loadedInstructions: instructions.loaded,
                    instructionsText: instructions.text,
                  }
                : {}),
            };
          }
          if (cwdTarget.kind === "ssh") {
            const remoteRes = await remoteReadTextFile({
              host: cwdTarget.host,
              cwd: cwdTarget.cwd,
              input: {
                ...input,
                start: input.start,
                maxBytes: maxOutputBytes,
              },
              denyPaths: remoteDenyPaths,
              signal: options.abortSignal,
            });
            if (remoteRes.status === "error") {
              return {
                success: false,
                resolvedPath: input.path,
                error: { code: "UNKNOWN", message: remoteRes.error.message },
              };
            }
            const remoteOutput = remoteRes.value;
            if (remoteOutput.success) {
              recordRemoteFileAccess({
                host: cwdTarget.host,
                remoteCwd: cwdTarget.cwd,
                inputPath: input.path,
                resolvedPath: remoteOutput.resolvedPath,
                fileHash: remoteOutput.fileHash,
              });
            }
            return remoteOutput;
          }
          return await fileSystem.readFile(
            {
              ...input,
              start: input.start,
              maxBytes: maxOutputBytes,
              dangerouslyAllow,
            },
            opCwd,
          );
        })();

        const resQualified = (() => {
          if (cwdTarget.kind !== "ssh") return res;
          if (res.success && "kind" in res) {
            switch (res.kind) {
              case "artifact":
              case "attachment":
                return res;
            }
          }
          return {
            ...res,
            resolvedPath: toRemoteDebugPath(cwdTarget.host, res.resolvedPath),
          };
        })();

        const withInstructions = await (async () => {
          if (!resQualified.success) return resQualified;
          if ("kind" in resQualified) {
            switch (resQualified.kind) {
              case "artifact":
              case "attachment":
                return resQualified;
            }
          }
          if (cwdTarget.kind === "ssh") {
            // Skip instruction auto-loading for remote reads for now.
            return resQualified;
          }
          if (opts?.loadInstructions === false) return resQualified;
          const instructions = await loadReadFileInstructions({
            resolvedPath: resQualified.resolvedPath,
            requestedPath: input.path,
            cwd: opCwd ?? toolRootAbs,
            messages: options.messages,
            denyPaths,
            claimedInstructionPaths: instructionClaims.forMessages(options.messages),
          });
          if (!instructions) return resQualified;
          return {
            ...resQualified,
            loadedInstructions: instructions.loaded,
            instructionsText: instructions.text,
          };
        })();

        return withInstructions;
      },
      toModelOutput: async ({ toolCallId, output }) => {
        if (!output.success) return { type: "error-json", value: output };
        if (!("kind" in output)) {
          return { type: "json", value: output };
        }
        switch (output.kind) {
          case "artifact":
            return { type: "json", value: output };
          case "attachment":
            break;
        }

        const cached = binaryCacheByToolCallId.get(toolCallId);
        binaryCacheByToolCallId.delete(toolCallId);

        const bytes = cached?.bytes;
        const filename = cached?.filename ?? output.filename;
        const mimeType = cached?.mimeType ?? output.mimeType;

        let base64: string;
        if (bytes) {
          base64 = Buffer.from(bytes).toString("base64");
        } else {
          const bytesRes = await fileSystem.readFileBytes({
            path: output.resolvedPath,
            maxBytes: maxInlineMediaBytesPerPart,
          });
          if (!bytesRes.success) {
            const message = /too large|media limit|maximum \d+ bytes/i.test(bytesRes.error.message)
              ? buildInlineMediaLimitMessage({
                  filename,
                  mimeType,
                  maxBytes: maxInlineMediaBytesPerPart,
                  detail: bytesRes.error.message,
                })
              : bytesRes.error.message;
            return {
              type: "error-text",
              value: `Failed to read attachment bytes: ${message}`,
            };
          }
          base64 = Buffer.from(bytesRes.bytes).toString("base64");
        }

        const intro = `Attached file from read: ${filename} (${mimeType}, ${output.bytes} bytes).`;

        const instructionsText = output.instructionsText;
        const instructionParts =
          typeof instructionsText === "string" && instructionsText.trim().length > 0
            ? [{ type: "text" as const, text: instructionsText }]
            : [];

        if (imageMimeTypes.has(mimeType)) {
          return {
            type: "content",
            value: [
              { type: "text", text: intro },
              ...instructionParts,
              {
                type: "file",
                mediaType: mimeType,
                filename,
                data: { type: "data", data: base64 },
              },
            ],
          };
        }

        return {
          type: "content",
          value: [
            { type: "text", text: intro },
            ...instructionParts,
            {
              type: "file",
              mediaType: mimeType,
              filename,
              data: { type: "data", data: base64 },
            },
          ],
        };
      },
    }),

    glob: tool({
      description:
        "Match filesystem paths using glob patterns. Recommended mode='default' for paths only; use mode='detailed' only when you need type/size. Denylisted paths require dangerouslyAllow=true.",
      inputSchema: globInputZod,
      outputSchema: globOutputZod,
      execute: async ({ cwd: opCwd, dangerouslyAllow, ...input }: GlobInput, options) => {
        if (opts?.enforceDenylist) dangerouslyAllow = false;
        const mode = input.mode ?? "default";
        const cwdTarget = parseSshCwdTarget(opCwd);
        const remoteDenyPaths = resolveRemoteDenyPaths(dangerouslyAllow);

        logger.info("fs.glob", {
          patterns: input.patterns,
          cwd: opCwd,
          target: cwdTarget.kind,
          maxEntries: input.maxEntries,
          mode,
          dangerouslyAllow: dangerouslyAllow === true,
        });

        if (cwdTarget.kind === "ssh") {
          const remoteResult = await remoteGlob({
            host: cwdTarget.host,
            cwd: cwdTarget.cwd,
            patterns: input.patterns,
            maxEntries: input.maxEntries,
            mode,
            denyPaths: remoteDenyPaths,
            fsBackend,
            signal: options.abortSignal,
          });
          const res = (() => {
            if (remoteResult.status === "ok") return remoteResult.value;
            if (mode === "default") {
              return { mode, truncated: false, paths: [], error: remoteResult.error.message };
            }
            return { mode, truncated: false, entries: [], error: remoteResult.error.message };
          })();

          const output = stripGlobMetadata(res);
          return boundSearchOutput(
            output,
            output.mode === "default" ? "paths" : "entries",
            maxOutputBytes,
          );
        }

        const res = await fileSystem.glob({
          patterns: input.patterns,
          maxEntries: input.maxEntries,
          baseDir: opCwd,
          mode,
          dangerouslyAllow,
        });

        logger.info("fs.glob done", {
          entryCount: countGlobItems(res),
          truncated: res.truncated,
          failureMessage: res.error,
          mode: res.mode,
          effectiveBackend: res.effectiveBackend,
        });

        const output = stripGlobMetadata(res);
        return boundSearchOutput(
          output,
          output.mode === "default" ? "paths" : "entries",
          maxOutputBytes,
        );
      },
      toModelOutput: ({ output }): ToolResultOutput =>
        hasSearchFailure(output)
          ? { type: "error-json", value: output }
          : { type: "json", value: output },
    }),

    ...(fsBackend === "fff"
      ? {
          fuzzy_search: tool({
            description:
              "Fuzzy-ranked file/path search powered by FFF with an on-demand fzf fallback. Use this when you know an approximate filename, symbol-adjacent path, or path fragment and want likely files. Use grep instead when searching file contents or exact text inside files. Supports SSH cwd targets when the remote filesystem runner can be installed. Denylisted paths require dangerouslyAllow=true.",
            inputSchema: fuzzySearchInputZod,
            outputSchema: fuzzySearchOutputZod,
            execute: async (
              { cwd: opCwd, dangerouslyAllow, ...input }: FuzzySearchInput,
              options,
            ) => {
              if (opts?.enforceDenylist) dangerouslyAllow = false;
              const cwdTarget = parseSshCwdTarget(opCwd);

              logger.info("fs.fuzzySearch", {
                query: input.query,
                cwd: opCwd,
                target: cwdTarget.kind,
                maxResults: input.maxResults,
                dangerouslyAllow: dangerouslyAllow === true,
              });

              if (cwdTarget.kind === "ssh") {
                const remoteDenyPaths = resolveRemoteDenyPaths(dangerouslyAllow);
                const remoteResult = await remoteFuzzySearch({
                  host: cwdTarget.host,
                  cwd: cwdTarget.cwd,
                  input: {
                    query: input.query,
                    maxResults: input.maxResults,
                  },
                  denyPaths: remoteDenyPaths,
                  signal: options.abortSignal,
                });
                let res: RemoteFuzzySearchOutput;
                if (remoteResult.status === "ok") {
                  res = remoteResult.value;
                } else {
                  res = {
                    results: [],
                    totalMatched: 0,
                    totalFiles: 0,
                    truncated: false,
                    error: `remote fuzzy_search unavailable: ${remoteResult.error.message}`,
                  };
                }

                return boundSearchOutput(stripFuzzySearchMetadata(res), "results", maxOutputBytes);
              }

              const res = await fileSystem.fuzzySearchFiles({
                query: input.query,
                maxResults: input.maxResults,
                baseDir: opCwd,
                dangerouslyAllow,
              });

              logger.info("fs.fuzzySearch done", {
                resultCount: res.results.length,
                totalMatched: res.totalMatched,
                truncated: res.truncated,
                failureMessage: res.error,
                effectiveBackend: res.effectiveBackend,
              });

              return boundSearchOutput(stripFuzzySearchMetadata(res), "results", maxOutputBytes);
            },
            toModelOutput: ({ output }): ToolResultOutput =>
              hasSearchFailure(output)
                ? { type: "error-json", value: output }
                : { type: "json", value: output },
          }),
        }
      : {}),

    grep: tool({
      description: hashlineEnabled
        ? "Search a local file or directory, SSH path, or transient tool-result:// resource. Recommended mode='default'; use mode='hashline' only for editable filesystem paths, or mode='detailed' for column/submatches metadata. Output always stays inline and may be truncated with narrowing guidance. Denylisted filesystem paths require dangerouslyAllow=true."
        : "Search a local file or directory, SSH path, or transient tool-result:// resource. Recommended mode='default'; use mode='detailed' only for column/submatches metadata. Output always stays inline and may be truncated with narrowing guidance. Denylisted filesystem paths require dangerouslyAllow=true.",
      inputSchema: grepInputSchema,
      outputSchema: grepOutputSchema,
      execute: async ({ dangerouslyAllow, ...input }: GrepInput, options): Promise<GrepOutput> => {
        if (opts?.enforceDenylist) dangerouslyAllow = false;
        const mode = input.mode ?? "default";
        const targetPath = input.path;
        if (targetPath?.startsWith(TOOL_RESULT_URI_PREFIX)) {
          const sessionId = opts?.requestContext?.sessionId;
          const artifact =
            opts?.toolResultArtifacts && sessionId
              ? await adaptToolResultArtifactReadToUnavailablePolicy(
                  opts.toolResultArtifacts,
                  await opts.toolResultArtifacts.read(targetPath, sessionId),
                )
              : { ok: false as const };
          if (!artifact.ok) {
            return boundGrepOutput(
              grepFailure(mode, TOOL_RESULT_UNAVAILABLE_MESSAGE),
              maxOutputBytes,
            );
          }
          if (mode === "hashline") {
            return boundGrepOutput(
              grepFailure(
                mode,
                "grep mode='hashline' is unavailable for tool-result:// resources; use mode='default' or mode='detailed'.",
              ),
              maxOutputBytes,
            );
          }

          const searched = await grepText({
            content: artifact.content,
            reportedPath: targetPath,
            pattern: input.pattern,
            regex: input.regex,
            maxMatches: input.maxResults ?? 100,
          });
          if (searched.status === "error") {
            return boundGrepOutput(grepFailure(mode, searched.error.message), maxOutputBytes);
          }
          if (mode === "default") {
            return boundGrepOutput(
              {
                mode,
                truncated: searched.value.truncated,
                results: searched.value.matches.map(({ file, line, text }) => ({
                  file,
                  line,
                  text,
                })),
              },
              maxOutputBytes,
            );
          }
          return boundGrepOutput(
            { mode, truncated: searched.value.truncated, results: searched.value.matches },
            maxOutputBytes,
          );
        }

        const pathTarget = parseSshCwdTarget(targetPath);
        const remoteDenyPaths = resolveRemoteDenyPaths(dangerouslyAllow);

        logger.info("fs.grep", {
          pattern: input.pattern,
          path: targetPath,
          target: pathTarget.kind,
          regex: input.regex,
          fileExtensions: input.fileExtensions,
          maxResults: input.maxResults,
          mode,
          dangerouslyAllow: dangerouslyAllow === true,
        });

        if (pathTarget.kind === "ssh") {
          const remoteResult = await remoteGrep({
            host: pathTarget.host,
            cwd: pathTarget.cwd,
            input: {
              pattern: input.pattern,
              regex: input.regex,
              maxResults: input.maxResults,
              fileExtensions: input.fileExtensions,
              mode,
            },
            denyPaths: remoteDenyPaths,
            fsBackend,
            signal: options.abortSignal,
          });
          const res = (() => {
            if (remoteResult.status === "ok") return remoteResult.value;
            switch (mode) {
              case "default":
                return {
                  mode,
                  truncated: false,
                  results: [],
                  error: remoteResult.error.message,
                };
              case "detailed":
                return {
                  mode,
                  truncated: false,
                  results: [],
                  error: remoteResult.error.message,
                };
              case "hashline":
                return {
                  mode,
                  truncated: false,
                  results: [],
                  error: remoteResult.error.message,
                };
            }
          })();

          if (res.mode === "hashline") {
            for (const match of res.results) {
              recordRemoteFileAccess({
                host: pathTarget.host,
                remoteCwd: pathTarget.cwd,
                inputPath: match.file,
                resolvedPath: match.resolvedPath,
                fileHash: match.fileHash,
              });
            }
          }

          return boundGrepOutput(stripGrepMetadata(res), maxOutputBytes);
        }

        const res = await fileSystem.grep({
          pattern: input.pattern,
          regex: input.regex,
          maxResults: input.maxResults,
          fileExtensions: input.fileExtensions,
          baseDir: targetPath,
          mode,
          dangerouslyAllow,
        });

        logger.info("fs.grep done", {
          resultCount: countGrepItems(res),
          truncated: res.truncated,
          failureMessage: res.error,
          mode: res.mode,
          effectiveBackend: res.effectiveBackend,
        });

        return boundGrepOutput(stripGrepMetadata(res), maxOutputBytes);
      },
      toModelOutput: ({ output }): ToolResultOutput =>
        hasSearchFailure(output)
          ? { type: "error-json", value: output }
          : { type: "json", value: output },
    }),
  };

  if (!includeEditFile) {
    return baseTools;
  }

  return {
    ...baseTools,
    edit: tool({
      description: hashlineEnabled
        ? "Edit an existing file using hashline anchors from read(format='hashline') or grep(mode='hashline'). Batch all edits for the file into one call, then re-read before any further edits. edit also checks the file hash from your prior read so unrelated external modifications are rejected. Very long lines may prevent hashline anchoring and require bash instead. Denylisted paths require dangerouslyAllow=true."
        : "Edit a file by find-and-replace. By default, oldText must be unique in the file. Set replaceAll=true to update all matches. Denylisted paths require dangerouslyAllow=true.",
      inputSchema: editFileSchema,
      outputSchema: editFileOutputZod,
      execute: async (
        { cwd: opCwd, dangerouslyAllow, ...input }: EditFileInput,
        options: { abortSignal?: AbortSignal },
      ) => {
        if (opts?.enforceDenylist) dangerouslyAllow = false;
        const cwdTarget = parseSshCwdTarget(opCwd);
        const remoteDenyPaths = resolveRemoteDenyPaths(dangerouslyAllow);
        const isLegacy = isLegacyEditFileInput(input);

        logger.info("fs.editFile", {
          path: input.path,
          cwd: opCwd,
          target: cwdTarget.kind,
          mode: hashlineEnabled ? "hashline" : "legacy",
          replaceAll: isLegacy ? input.replaceAll : undefined,
          matching: isLegacy ? input.matching : undefined,
          expectedMatches: isLegacy ? resolveExpectedMatches(input) : undefined,
          expectedHashProvided:
            typeof input.expectedHash === "string" && input.expectedHash.length > 0,
          dangerouslyAllow: dangerouslyAllow === true,
        });

        const res = hashlineEnabled
          ? await (async () => {
              const hashlineInput = input as HashlineEditFileInput;
              if (cwdTarget.kind === "ssh") {
                let expectedHash = hashlineInput.expectedHash;
                let resolvedPathHint: string | undefined;

                if (!expectedHash) {
                  const prior = lookupRemoteReadHash({
                    host: cwdTarget.host,
                    remoteCwd: cwdTarget.cwd,
                    inputPath: hashlineInput.path,
                  });
                  if (!prior) {
                    return {
                      success: false as const,
                      resolvedPath: toRemoteDebugPath(cwdTarget.host, hashlineInput.path),
                      error: {
                        code: "NOT_READ" as const,
                        message: `File must be read before editing: ${toRemoteDebugPath(cwdTarget.host, hashlineInput.path)}`,
                      },
                    };
                  }
                  expectedHash = prior.hash;
                  resolvedPathHint = prior.resolvedPath;
                }

                const remoteRes = await remoteEditFile({
                  host: cwdTarget.host,
                  cwd: cwdTarget.cwd,
                  input: {
                    path: hashlineInput.path,
                    edits: hashlineInput.edits,
                    mode: "hashline",
                    expectedHash,
                  },
                  denyPaths: remoteDenyPaths,
                  signal: options.abortSignal,
                });
                if (remoteRes.status === "error") {
                  if (resolvedPathHint) {
                    remoteResolvedPathByLookup.set(
                      remoteLookupKey(cwdTarget.host, cwdTarget.cwd, hashlineInput.path),
                      resolvedPathHint,
                    );
                  }
                  return normalizeEditOutput({
                    success: false,
                    resolvedPath: toRemoteDebugPath(cwdTarget.host, hashlineInput.path),
                    error: { code: "UNKNOWN", message: remoteRes.error.message },
                  });
                }
                const remoteOutput = remoteRes.value;
                if (remoteOutput.success) {
                  recordRemoteFileAccess({
                    host: cwdTarget.host,
                    remoteCwd: cwdTarget.cwd,
                    inputPath: hashlineInput.path,
                    resolvedPath: remoteOutput.resolvedPath,
                    fileHash: remoteOutput.newHash,
                  });
                } else if (resolvedPathHint) {
                  remoteResolvedPathByLookup.set(
                    remoteLookupKey(cwdTarget.host, cwdTarget.cwd, hashlineInput.path),
                    resolvedPathHint,
                  );
                }
                return normalizeEditOutput({
                  ...remoteOutput,
                  resolvedPath: toRemoteDebugPath(cwdTarget.host, remoteOutput.resolvedPath),
                });
              }

              return normalizeEditOutput(
                await fileSystem.hashlineEditFile(
                  {
                    path: hashlineInput.path,
                    edits: hashlineInput.edits,
                    expectedHash: hashlineInput.expectedHash,
                    dangerouslyAllow,
                  },
                  opCwd,
                ),
              );
            })()
          : await (async () => {
              const legacyInput = input as LegacyEditFileInput;
              const occurrence: "all" | "first" = legacyInput.replaceAll ? "all" : "first";
              const editPayload: {
                path: string;
                edits: FileEdit[];
                expectedHash?: string;
              } = {
                path: legacyInput.path,
                edits: [
                  {
                    type: "replace_snippet",
                    target: legacyInput.oldText,
                    matching: legacyInput.matching,
                    newText: legacyInput.newText,
                    occurrence,
                    expectedMatches: resolveExpectedMatches(legacyInput),
                  },
                ],
                expectedHash: legacyInput.expectedHash,
              };

              if (cwdTarget.kind === "ssh") {
                let expectedHash = legacyInput.expectedHash;
                let resolvedPathHint: string | undefined;

                if (!expectedHash) {
                  const prior = lookupRemoteReadHash({
                    host: cwdTarget.host,
                    remoteCwd: cwdTarget.cwd,
                    inputPath: legacyInput.path,
                  });
                  if (!prior) {
                    return {
                      success: false as const,
                      resolvedPath: toRemoteDebugPath(cwdTarget.host, legacyInput.path),
                      error: {
                        code: "NOT_READ" as const,
                        message: `File must be read before editing: ${toRemoteDebugPath(cwdTarget.host, legacyInput.path)}`,
                      },
                    };
                  }
                  expectedHash = prior.hash;
                  resolvedPathHint = prior.resolvedPath;
                }

                const remoteRes = await remoteEditFile({
                  host: cwdTarget.host,
                  cwd: cwdTarget.cwd,
                  input: {
                    path: editPayload.path,
                    edits: editPayload.edits,
                    expectedHash,
                    mode: "legacy",
                  },
                  denyPaths: remoteDenyPaths,
                  signal: options.abortSignal,
                });
                if (remoteRes.status === "error") {
                  if (resolvedPathHint) {
                    remoteResolvedPathByLookup.set(
                      remoteLookupKey(cwdTarget.host, cwdTarget.cwd, legacyInput.path),
                      resolvedPathHint,
                    );
                  }
                  return normalizeEditOutput({
                    success: false,
                    resolvedPath: toRemoteDebugPath(cwdTarget.host, legacyInput.path),
                    error: { code: "UNKNOWN", message: remoteRes.error.message },
                  });
                }
                const remoteOutput = remoteRes.value;

                if (remoteOutput.success) {
                  recordRemoteFileAccess({
                    host: cwdTarget.host,
                    remoteCwd: cwdTarget.cwd,
                    inputPath: legacyInput.path,
                    resolvedPath: remoteOutput.resolvedPath,
                    fileHash: remoteOutput.newHash,
                  });
                } else if (resolvedPathHint) {
                  remoteResolvedPathByLookup.set(
                    remoteLookupKey(cwdTarget.host, cwdTarget.cwd, legacyInput.path),
                    resolvedPathHint,
                  );
                }

                return normalizeEditOutput({
                  ...remoteOutput,
                  resolvedPath: toRemoteDebugPath(cwdTarget.host, remoteOutput.resolvedPath),
                });
              }

              return normalizeEditOutput(
                await fileSystem.editFile({ ...editPayload, dangerouslyAllow }, opCwd),
              );
            })();

        return res;
      },
    }),
  };
}
