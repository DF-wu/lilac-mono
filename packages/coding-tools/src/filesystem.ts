import path from "node:path";

import { expandTilde, FileSystem, grepText, type FsBackend } from "@stanley2058/lilac-fs";
import {
  adaptToolResultArtifactReadToUnavailablePolicy,
  TOOL_RESULT_URI_PREFIX,
  TOOL_RESULT_UNAVAILABLE_MESSAGE,
} from "@stanley2058/lilac-tool-results";
import { tool, type ToolSet } from "ai";
import { z } from "zod";

import type { CodingToolArtifactIntegration } from "./artifact-integration";
import { boundGrepOutput } from "./search-output";
import { canonicalPathAllowed, assertGuardrailBypassAllowed, assertLocalCwd } from "./guardrails";
import {
  createReadFileInstructionClaims,
  loadReadFileInstructions,
  READ_FILE_INSTRUCTION_HINT,
} from "./instructions";
import {
  editFileInputSchema,
  fuzzySearchInputSchema,
  globInputSchema,
  grepInputSchema,
  createReadFileInputSchema,
} from "./schemas";

export const DEFAULT_MAX_INLINE_MEDIA_BYTES_PER_PART = 10 * 1024 * 1024;
export const DEFAULT_MAX_READ_FILE_OUTPUT_BYTES = 40 * 1024;

const ATTACHMENT_MIME_TYPES: ReadonlyMap<string, string> = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".pdf", "application/pdf"],
] as const);
const searchFailureSchema = z.object({ error: z.string() }).passthrough();

const readFileStartSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("offset"), offset: z.number() }),
  z.strictObject({ type: z.literal("line"), line: z.number(), column: z.number().optional() }),
]);
const readFileInstructionsShape = {
  loadedInstructions: z.array(z.string()).optional(),
  instructionsText: z.string().optional(),
};
const readFileSuccessShape = {
  success: z.literal(true),
  resolvedPath: z.string(),
  fileHash: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  totalLines: z.number(),
  hasMoreLines: z.boolean(),
  truncatedByChars: z.boolean(),
  nextStart: readFileStartSchema.optional(),
  warnings: z
    .array(
      z.strictObject({
        code: z.literal("LINE_TOO_LONG_FOR_HASHLINE"),
        message: z.string(),
        line: z.number(),
        maxLength: z.number(),
        actualLength: z.number(),
      }),
    )
    .optional(),
  degradedFromHashline: z.boolean().optional(),
  ...readFileInstructionsShape,
};
const readFileCallbackOutputSchema = z.union([
  z.strictObject({
    success: z.literal(false),
    resolvedPath: z.string(),
    error: z.strictObject({
      code: z.enum(["NOT_FOUND", "PERMISSION", "UNKNOWN"]),
      message: z.string(),
    }),
  }),
  z.strictObject({ ...readFileSuccessShape, format: z.literal("raw"), content: z.string() }),
  z.strictObject({
    ...readFileSuccessShape,
    format: z.literal("numbered"),
    numberedContent: z.string(),
  }),
  z.strictObject({
    ...readFileSuccessShape,
    format: z.literal("hashline"),
    hashlineContent: z.string(),
  }),
  z.strictObject({
    success: z.literal(true),
    kind: z.literal("artifact"),
    resolvedPath: z.string(),
    content: z.string(),
    startOffset: z.number(),
    endOffset: z.number(),
    totalCharacters: z.number(),
    nextStart: readFileStartSchema.optional(),
    hasMore: z.boolean(),
  }),
  z.strictObject({
    success: z.literal(true),
    kind: z.literal("attachment"),
    resolvedPath: z.string(),
    fileHash: z.string(),
    filename: z.string(),
    mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]),
    bytes: z.number(),
    ...readFileInstructionsShape,
  }),
]);

function inlineMediaLimitMessage(filename: string, mimeType: string, maxBytes: number): string {
  const guidance = mimeType.startsWith("image/")
    ? "Resize or compress the image, then read the smaller file."
    : "Reduce or compress the file, then read the smaller file.";
  return `Cannot inline '${filename}' (${mimeType}): it exceeds the ${maxBytes}-byte media limit. ${guidance}`;
}

function detectAttachmentMimeType(bytes: Uint8Array): string | undefined {
  const startsWith = (signature: readonly number[]) =>
    signature.every((byte, index) => bytes[index] === byte);
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])) return "image/gif";
  if (startsWith([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return "image/gif";
  if (
    startsWith([0x52, 0x49, 0x46, 0x46]) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  if (startsWith([0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  return undefined;
}

function resolveLocalOperationPath(inputPath: string, cwd: string): string {
  const expanded = expandTilde(inputPath);
  return path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(expandTilde(cwd), expanded);
}

async function localFilesystemPathAllowed(params: {
  inputPath: string;
  cwd: string;
  denyPaths: readonly string[];
  operation: string;
  dangerouslyAllow?: boolean;
}) {
  const resolvedPath = resolveLocalOperationPath(params.inputPath, params.cwd);
  const allowed = await canonicalPathAllowed({
    targetPath: resolvedPath,
    denyPaths: params.denyPaths,
    operation: params.operation,
    dangerouslyAllow: params.dangerouslyAllow,
  });
  return { allowed, resolvedPath };
}

export function createFilesystemTools(params: {
  fileSystem: FileSystem;
  cwd: string;
  fsBackend: FsBackend;
  allowGuardrailBypass?: boolean;
  loadInstructions?: boolean;
  preloadedInstructionPaths?: readonly string[];
  denyPaths?: readonly string[];
  artifactIntegration?: CodingToolArtifactIntegration;
  readFileDirectAttachmentSupported?: boolean;
  maxInlineMediaBytesPerPart?: number;
  maxOutputBytes?: number;
}): ToolSet {
  const {
    fileSystem,
    cwd,
    fsBackend,
    allowGuardrailBypass = false,
    loadInstructions = true,
    preloadedInstructionPaths,
    denyPaths,
    artifactIntegration,
    readFileDirectAttachmentSupported = false,
    maxInlineMediaBytesPerPart = DEFAULT_MAX_INLINE_MEDIA_BYTES_PER_PART,
    maxOutputBytes = DEFAULT_MAX_READ_FILE_OUTPUT_BYTES,
  } = params;
  const readFileInputSchema = createReadFileInputSchema({
    directAttachmentSupported: readFileDirectAttachmentSupported,
  });
  const binaryCacheByToolCallId = new Map<string, Buffer>();
  const instructionClaims = createReadFileInstructionClaims();
  const tools: ToolSet = {
    read_file: tool({
      description: `${readFileDirectAttachmentSupported ? "Read a local text file, supported image or PDF, or a transient tool-result:// URI. Supported images and PDFs are attached to your context for native visual or document analysis, including when read_file is an independent batch child." : "Read a local text file or a transient tool-result:// URI."} Artifact URIs ignore cwd and support start/maxCharacters/maxLines paging; reuse nextStart unchanged while hasMore is true. Reading a local file records its hash so edit_file can safely edit it later. ${READ_FILE_INSTRUCTION_HINT}`,
      inputSchema: readFileInputSchema,
      execute: async ({ cwd: operationCwd, ...input }, options) => {
        if (input.path.startsWith(TOOL_RESULT_URI_PREFIX)) {
          const artifact = artifactIntegration
            ? await adaptToolResultArtifactReadToUnavailablePolicy(
                artifactIntegration.artifacts,
                await artifactIntegration.artifacts.readWindow(
                  input.path,
                  artifactIntegration.scopeId,
                  {
                    start: input.start ?? { type: "offset", offset: 0 },
                    maxCharacters: Math.max(1, input.maxCharacters ?? 10_000),
                    maxLines: Math.max(1, input.maxLines ?? 2_000),
                    maxOutputBytes,
                  },
                ),
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
        if (operationCwd) assertLocalCwd(operationCwd);
        assertGuardrailBypassAllowed(input.dangerouslyAllow, allowGuardrailBypass);
        const effectiveCwd = operationCwd ?? cwd;
        const guardedPath = await localFilesystemPathAllowed({
          inputPath: input.path,
          cwd: effectiveCwd,
          denyPaths: denyPaths ?? [],
          operation: "read_file",
          dangerouslyAllow: input.dangerouslyAllow,
        });
        if (guardedPath.allowed.status === "error") {
          return {
            success: false as const,
            resolvedPath: guardedPath.resolvedPath,
            error: {
              code: "PERMISSION" as const,
              message: guardedPath.allowed.error.message,
            },
          };
        }
        const expectedMimeType = readFileDirectAttachmentSupported
          ? ATTACHMENT_MIME_TYPES.get(path.extname(input.path).toLowerCase())
          : undefined;
        if (expectedMimeType !== undefined) {
          const output = await fileSystem.readFileBytes(
            {
              path: input.path,
              dangerouslyAllow: input.dangerouslyAllow,
              maxBytes: maxInlineMediaBytesPerPart,
            },
            effectiveCwd,
          );
          if (!output.success) {
            if (/too large|maximum \d+ bytes/iu.test(output.error.message)) {
              const filename = path.basename(output.resolvedPath);
              return {
                ...output,
                error: {
                  ...output.error,
                  message: inlineMediaLimitMessage(
                    filename,
                    expectedMimeType,
                    maxInlineMediaBytesPerPart,
                  ),
                },
              };
            }
            return output;
          }

          const mimeType = detectAttachmentMimeType(output.bytes);
          binaryCacheByToolCallId.set(options.toolCallId, output.bytes);
          const filename = path.basename(output.resolvedPath);
          if (mimeType === undefined) {
            binaryCacheByToolCallId.delete(options.toolCallId);
            return {
              success: false as const,
              resolvedPath: output.resolvedPath,
              error: {
                code: "UNKNOWN" as const,
                message: `Cannot attach '${filename}': its content is not a supported image or PDF.`,
              },
            };
          }
          const instructions = loadInstructions
            ? await loadReadFileInstructions({
                resolvedPath: output.resolvedPath,
                requestedPath: input.path,
                cwd: effectiveCwd,
                messages: options.messages,
                preloadedInstructionPaths,
                denyPaths,
                claimedInstructionPaths: instructionClaims.forMessages(options.messages),
              })
            : undefined;
          return {
            success: true as const,
            kind: "attachment" as const,
            resolvedPath: output.resolvedPath,
            fileHash: output.fileHash,
            filename,
            mimeType,
            bytes: output.bytesLength,
            ...(instructions
              ? {
                  loadedInstructions: instructions.loaded,
                  instructionsText: instructions.text,
                }
              : {}),
          };
        }

        const output = await fileSystem.readFile(
          { ...input, maxBytes: maxOutputBytes },
          effectiveCwd,
        );
        if (!output.success || !loadInstructions) return output;

        const instructions = await loadReadFileInstructions({
          resolvedPath: output.resolvedPath,
          requestedPath: input.path,
          cwd: effectiveCwd,
          messages: options.messages,
          preloadedInstructionPaths,
          denyPaths,
          claimedInstructionPaths: instructionClaims.forMessages(options.messages),
        });
        if (!instructions) return output;
        return {
          ...output,
          loadedInstructions: instructions.loaded,
          instructionsText: instructions.text,
        };
      },
      toModelOutput: ({ toolCallId, output }) => {
        const decoded = readFileCallbackOutputSchema.safeParse(output);
        if (!decoded.success) return { type: "json", value: output };
        if (!decoded.data.success) {
          return { type: "error-json", value: output };
        }
        if (!("kind" in decoded.data) || decoded.data.kind !== "attachment") {
          return { type: "json", value: output };
        }

        const bytes = binaryCacheByToolCallId.get(toolCallId);
        binaryCacheByToolCallId.delete(toolCallId);
        if (bytes === undefined) {
          return {
            type: "error-text",
            value: `Failed to read attachment bytes for '${decoded.data.filename}'.`,
          };
        }

        const instructions = decoded.data.instructionsText?.trim();
        return {
          type: "content",
          value: [
            {
              type: "text",
              text: `Attached file from read_file: ${decoded.data.filename} (${decoded.data.mimeType}, ${decoded.data.bytes} bytes).`,
            },
            ...(instructions ? [{ type: "text" as const, text: instructions }] : []),
            {
              type: "file",
              mediaType: decoded.data.mimeType,
              filename: decoded.data.filename,
              data: { type: "data", data: bytes.toString("base64") },
            },
          ],
        };
      },
    }),
    glob: tool({
      description: "Match local filesystem paths with include and negated glob patterns.",
      inputSchema: globInputSchema,
      execute: async ({ cwd: operationCwd, ...input }) => {
        if (operationCwd) assertLocalCwd(operationCwd);
        assertGuardrailBypassAllowed(input.dangerouslyAllow, allowGuardrailBypass);
        const effectiveCwd = operationCwd ?? cwd;
        const guardedPath = await localFilesystemPathAllowed({
          inputPath: effectiveCwd,
          cwd: effectiveCwd,
          denyPaths: denyPaths ?? [],
          operation: "glob",
          dangerouslyAllow: input.dangerouslyAllow,
        });
        if (guardedPath.allowed.status === "error") {
          return input.mode === "detailed"
            ? {
                mode: "detailed" as const,
                truncated: false,
                entries: [],
                error: guardedPath.allowed.error.message,
              }
            : {
                mode: "default" as const,
                truncated: false,
                paths: [],
                error: guardedPath.allowed.error.message,
              };
        }
        return fileSystem.glob({ ...input, baseDir: operationCwd ?? cwd });
      },
      toModelOutput: ({ output }) =>
        searchFailureSchema.safeParse(output).success
          ? { type: "error-json", value: output }
          : { type: "json", value: output },
    }),
    grep: tool({
      description:
        "Search a local file, directory, or transient tool-result:// resource, using literal matching unless regex=true. Output always stays inline and may be truncated with narrowing guidance.",
      inputSchema: grepInputSchema,
      execute: async (input) => {
        if (input.path?.startsWith(TOOL_RESULT_URI_PREFIX)) {
          const artifact = artifactIntegration
            ? await adaptToolResultArtifactReadToUnavailablePolicy(
                artifactIntegration.artifacts,
                await artifactIntegration.artifacts.read(input.path, artifactIntegration.scopeId),
              )
            : { ok: false as const };
          if (!artifact.ok) {
            return boundGrepOutput(
              {
                mode: input.mode ?? "default",
                truncated: false,
                results: [],
                error: TOOL_RESULT_UNAVAILABLE_MESSAGE,
              },
              maxOutputBytes,
            );
          }
          const searched = await grepText({
            content: artifact.content,
            reportedPath: input.path,
            pattern: input.pattern,
            regex: input.regex,
            maxMatches: input.maxResults ?? 100,
          });
          if (searched.status === "error") {
            return boundGrepOutput(
              {
                mode: input.mode ?? "default",
                truncated: false,
                results: [],
                error: searched.error.message,
              },
              maxOutputBytes,
            );
          }
          const results =
            input.mode === "detailed"
              ? searched.value.matches
              : searched.value.matches.map(({ file, line, text }) => ({ file, line, text }));
          return boundGrepOutput(
            {
              mode: input.mode ?? "default",
              truncated: searched.value.truncated,
              results,
            },
            maxOutputBytes,
          );
        }

        assertGuardrailBypassAllowed(input.dangerouslyAllow, allowGuardrailBypass);
        const targetPath = input.path ?? cwd;
        const guardedPath = await localFilesystemPathAllowed({
          inputPath: targetPath,
          cwd,
          denyPaths: denyPaths ?? [],
          operation: "grep",
          dangerouslyAllow: input.dangerouslyAllow,
        });
        if (guardedPath.allowed.status === "error") {
          return boundGrepOutput(
            {
              mode: input.mode ?? "default",
              truncated: false,
              results: [],
              error: guardedPath.allowed.error.message,
            },
            maxOutputBytes,
          );
        }
        const { path: _path, ...searchInput } = input;
        return boundGrepOutput(
          await fileSystem.grep({ ...searchInput, baseDir: targetPath }),
          maxOutputBytes,
        );
      },
      toModelOutput: ({ output }) =>
        searchFailureSchema.safeParse(output).success
          ? { type: "error-json", value: output }
          : { type: "json", value: output },
    }),
    edit_file: tool({
      description:
        "Replace a snippet in an existing local file. The file must first be read with read_file; by default oldText must match exactly once.",
      inputSchema: editFileInputSchema,
      execute: async ({ cwd: operationCwd, ...input }) => {
        if (operationCwd) assertLocalCwd(operationCwd);
        assertGuardrailBypassAllowed(input.dangerouslyAllow, allowGuardrailBypass);
        const effectiveCwd = operationCwd ?? cwd;
        const guardedPath = await localFilesystemPathAllowed({
          inputPath: input.path,
          cwd: effectiveCwd,
          denyPaths: denyPaths ?? [],
          operation: "edit_file",
          dangerouslyAllow: input.dangerouslyAllow,
        });
        if (guardedPath.allowed.status === "error") {
          return {
            success: false as const,
            resolvedPath: guardedPath.resolvedPath,
            error: {
              code: "PERMISSION" as const,
              message: guardedPath.allowed.error.message,
            },
          };
        }
        const occurrence = input.replaceAll ? "all" : "first";
        const expectedMatches = input.expectedMatches ?? (input.replaceAll ? "any" : 1);
        return fileSystem.editFile(
          {
            path: input.path,
            edits: [
              {
                type: "replace_snippet",
                target: input.oldText,
                matching: input.matching,
                newText: input.newText,
                occurrence,
                expectedMatches,
              },
            ],
            expectedHash: input.expectedHash,
            dangerouslyAllow: input.dangerouslyAllow,
          },
          operationCwd ?? cwd,
        );
      },
    }),
  };

  if (fsBackend === "fff") {
    tools.fuzzy_search = tool({
      description: "Fuzzy-ranked local filename and path search powered by FFF.",
      inputSchema: fuzzySearchInputSchema,
      execute: async ({ cwd: operationCwd, ...input }) => {
        if (operationCwd) assertLocalCwd(operationCwd);
        assertGuardrailBypassAllowed(input.dangerouslyAllow, allowGuardrailBypass);
        const effectiveCwd = operationCwd ?? cwd;
        const guardedPath = await localFilesystemPathAllowed({
          inputPath: effectiveCwd,
          cwd: effectiveCwd,
          denyPaths: denyPaths ?? [],
          operation: "fuzzy_search",
          dangerouslyAllow: input.dangerouslyAllow,
        });
        if (guardedPath.allowed.status === "error") {
          return {
            results: [],
            totalMatched: 0,
            totalFiles: 0,
            truncated: false as const,
            error: guardedPath.allowed.error.message,
          };
        }
        return fileSystem.fuzzySearchFiles({ ...input, baseDir: operationCwd ?? cwd });
      },
      toModelOutput: ({ output }) =>
        searchFailureSchema.safeParse(output).success
          ? { type: "error-json", value: output }
          : { type: "json", value: output },
    });
  }

  return tools;
}
