import { tool, type FilePart, type ImagePart, type ModelMessage } from "ai";
import { lilacEventTypes, type LilacBus } from "@stanley2058/lilac-event-bus";
import {
  createLogger,
  formatTaggedErrorForLog,
  opaqueErrorMessage,
  isRecord,
} from "@stanley2058/lilac-utils";
import { fileTypeFromBuffer } from "file-type";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { z } from "zod/v4";
import { expandTilde } from "@stanley2058/lilac-fs";
import {
  decodeDataUrl,
  inferExtensionFromMimeType,
  inferMimeTypeFromFilename,
  looksLikeDataUrl,
  looksLikeHttpUrl,
  resolveToolPath,
  sanitizeExtension,
} from "../shared/attachment-utils";
import { requireRequestContext } from "../shared/req-context";
import { adaptEventPublishResultToHost } from "../shared/event-bus-result";
import { captureRuntimeError, projectCapturedRuntimeError } from "../runtime/error-format";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import { adaptToolResultToHost, preserveToolPanic } from "./tool-result-adapters";

const DEFAULT_OUTBOUND_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_OUTBOUND_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

const DEFAULT_INBOUND_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_INBOUND_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

const DISCORD_CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

class AttachmentOperationError extends TaggedError("AttachmentOperationError")<{
  readonly operation: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

async function captureAttachmentOperation<T>(params: {
  readonly operation: string;
  readonly run: () => Promise<T>;
}): Promise<ResultType<T, AttachmentOperationError>> {
  const captured = (
    await Result.tryPromise({ try: params.run, catch: captureRuntimeError })
  ).mapError((error) =>
    projectCapturedRuntimeError(error, `Opaque attachment ${params.operation} failure`),
  );
  return captured.match<() => ResultType<T, AttachmentOperationError>>({
    ok: (value) => () => Result.ok(value),
    err: (error) => () => {
      const cause = preserveToolPanic(error);
      return Result.err(
        new AttachmentOperationError({
          operation: params.operation,
          cause,
          message: opaqueErrorMessage(cause, `Attachment ${params.operation} failed`),
        }),
      );
    },
  })();
}

function signalAttachmentFailure(operation: string, message: string): never {
  return adaptToolResultToHost(
    Result.err(new AttachmentOperationError({ operation, cause: new Error(message), message })),
  );
}

const nonEmptyStringListInputSchema = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .transform((value) => (Array.isArray(value) ? value : [value]));

const optionalNonEmptyStringListInputSchema = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    return Array.isArray(value) ? value : [value];
  });

function normalizeAttachmentAddFilesInput(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;

  const input = raw;
  if (input["paths"] !== undefined || input["files"] === undefined) {
    return raw;
  }

  return {
    ...input,
    paths: input["files"],
  };
}

type AttachmentData = ImagePart["image"] | FilePart["data"];

function asBuffer(data: AttachmentData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));

  if (typeof data === "string") {
    if (looksLikeDataUrl(data)) {
      return decodeDataUrl(data).bytes;
    }

    // AI SDK DataContent string is defined as base64.
    return Buffer.from(data, "base64");
  }

  // URL is handled separately.
  signalAttachmentFailure("decode_data", "Unsupported data content");
}

const attachmentAddFilesInputSchema = z
  .preprocess(
    normalizeAttachmentAddFilesInput,
    z.object({
      paths: nonEmptyStringListInputSchema.describe(
        "Local file paths to attach (resolved relative to tool cwd; alias: files)",
      ),
      filenames: optionalNonEmptyStringListInputSchema.describe(
        "Optional filenames for each attachment",
      ),
      mimeTypes: optionalNonEmptyStringListInputSchema.describe(
        "Optional mime types for each attachment",
      ),
    }),
  )
  .describe("Add one or more attachments from local files.");

const attachmentAddOutputSchema = z.object({
  ok: z.literal(true),
  attachments: z.array(
    z.object({
      filename: z.string(),
      mimeType: z.string(),
      bytes: z.number(),
    }),
  ),
});
type AttachmentAddFilesOutput = z.infer<typeof attachmentAddOutputSchema>;

type DetectedAttachment =
  | {
      kind: "image";
      source: string;
      mediaTypeHint?: string;
      filenameHint?: string;
      data: ImagePart["image"];
    }
  | {
      kind: "file";
      source: string;
      mediaTypeHint: string;
      filenameHint?: string;
      data: FilePart["data"];
    };

const attachmentDownloadInputSchema = z.object({
  downloadDir: z
    .string()
    .optional()
    .describe("Directory to save downloaded files (default: ~/Downloads)"),
});

const attachmentDownloadOutputSchema = z.object({
  ok: z.literal(true),
  downloadDir: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      sha10: z.string(),
      bytes: z.number(),
      sourceUrl: z.string(),
      mimeType: z.string().optional(),
    }),
  ),
});

const optionalAttachmentContextSchema = z.object({
  requestId: z.string().optional(),
  sessionId: z.string().optional(),
  requestClient: z.string().optional(),
});

type AttachmentDownloadOutput = z.infer<typeof attachmentDownloadOutputSchema>;

function collectUserAttachments(messages: readonly ModelMessage[]): DetectedAttachment[] {
  const out: DetectedAttachment[] = [];

  for (const m of messages) {
    if (m.role !== "user") continue;
    if (!Array.isArray(m.content)) continue;

    for (const part of m.content) {
      if (!part || typeof part !== "object") continue;
      const p = part;

      const type = p.type;
      if (type === "image") {
        out.push({
          kind: "image",
          source: "user-message",
          mediaTypeHint: p.mediaType,
          data: p.image,
        });
        continue;
      }

      if (type === "file") {
        const mediaType = p.mediaType;
        if (typeof mediaType !== "string" || mediaType.length === 0) {
          // FilePart.mediaType is required; if missing, keep a conservative default.
          out.push({
            kind: "file",
            source: "user-message",
            mediaTypeHint: "application/octet-stream",
            filenameHint: p.filename,
            data: p.data,
          });
          continue;
        }

        out.push({
          kind: "file",
          source: "user-message",
          mediaTypeHint: mediaType,
          filenameHint: p.filename,
          data: p.data,
        });
        continue;
      }

      // Ignore text/unknown parts.
    }
  }

  return out;
}

async function downloadToBuffer(input: AttachmentData): Promise<{
  bytes: Buffer;
  sourceUrl?: string;
  contentType?: string;
}> {
  if (input instanceof URL) {
    if (!DISCORD_CDN_HOSTS.has(input.hostname)) {
      signalAttachmentFailure(
        "authorize_download",
        `Blocked attachment host '${input.hostname}'. Allowed: ${[...DISCORD_CDN_HOSTS].join(", ")}`,
      );
    }

    const res = await fetch(input.toString(), { redirect: "follow" });
    if (!res.ok) {
      signalAttachmentFailure(
        "download",
        `Failed to download attachment (${res.status}): ${input}`,
      );
    }
    const ab = await res.arrayBuffer();
    return {
      bytes: Buffer.from(ab),
      sourceUrl: input.toString(),
      contentType: res.headers.get("content-type") ?? undefined,
    };
  }

  if (typeof input === "string" && looksLikeHttpUrl(input)) {
    return await downloadToBuffer(new URL(input));
  }

  if (typeof input === "string" && looksLikeDataUrl(input)) {
    const decoded = decodeDataUrl(input);
    return { bytes: decoded.bytes, contentType: decoded.mimeType };
  }

  return { bytes: asBuffer(input) };
}

export function attachmentTools(params: { bus: LilacBus; cwd: string }) {
  const { bus, cwd } = params;
  const logger = createLogger({
    module: "tool:attachment",
  });

  return {
    "attachment.add_files": tool({
      description: "Reads local files and attaches them to the current reply.",
      inputSchema: attachmentAddFilesInputSchema,
      outputSchema: attachmentAddOutputSchema,
      execute: async (input, { context }) => {
        const ctx = requireRequestContext(context, "attachment.add_files");
        const startedAt = Date.now();

        logger.info("attachment.add_files", {
          requestId: ctx.requestId,
          sessionId: ctx.sessionId,
          requestClient: ctx.requestClient,
          cwd,
          pathCount: input.paths.length,
          filenameCount: input.filenames?.length,
          mimeTypeCount: input.mimeTypes?.length,
        });

        const runAddFiles = async () => {
          let totalBytes = 0;

          const out: Array<{
            filename: string;
            mimeType: string;
            bytes: number;
          }> = [];

          for (let i = 0; i < input.paths.length; i++) {
            const p = input.paths[i]!;
            const resolvedPath = resolveToolPath(cwd, p);

            const st = await fs.stat(resolvedPath);
            if (!st.isFile()) {
              signalAttachmentFailure("validate_outbound_file", `Not a file: ${resolvedPath}`);
            }

            if (st.size > DEFAULT_OUTBOUND_MAX_FILE_BYTES) {
              signalAttachmentFailure(
                "validate_outbound_file",
                `Attachment too large (${st.size} bytes). Max is ${DEFAULT_OUTBOUND_MAX_FILE_BYTES} bytes: ${resolvedPath}`,
              );
            }

            totalBytes += st.size;
            if (totalBytes > DEFAULT_OUTBOUND_MAX_TOTAL_BYTES) {
              signalAttachmentFailure(
                "validate_outbound_total",
                `Total attachment bytes too large (${totalBytes} bytes). Max is ${DEFAULT_OUTBOUND_MAX_TOTAL_BYTES} bytes.`,
              );
            }

            const bytes = await fs.readFile(resolvedPath);

            const filename = (input.filenames && input.filenames[i]) || basename(resolvedPath);

            const typeFromBytes = await fileTypeFromBuffer(bytes);

            const mimeType =
              (input.mimeTypes && input.mimeTypes[i]) ||
              typeFromBytes?.mime ||
              inferMimeTypeFromFilename(filename);

            const dataBase64 = Buffer.from(bytes).toString("base64");

            adaptEventPublishResultToHost(
              await bus.publish(
                lilacEventTypes.EvtAgentOutputResponseBinary,
                { mimeType, dataBase64, filename },
                {
                  headers: {
                    request_id: ctx.requestId,
                    session_id: ctx.sessionId,
                    request_client: ctx.requestClient,
                  },
                },
              ),
            );

            out.push({ filename, mimeType, bytes: bytes.byteLength });
          }

          const result = { ok: true as const, attachments: out };

          logger.info("attachment.add_files done", {
            requestId: ctx.requestId,
            sessionId: ctx.sessionId,
            requestClient: ctx.requestClient,
            durationMs: Date.now() - startedAt,
            attachmentCount: out.length,
            totalBytes: out.reduce((sum, att) => sum + att.bytes, 0),
          });

          return result;
        };
        const added = await captureAttachmentOperation({
          operation: "add_files",
          run: runAddFiles,
        });
        return added.match<() => AttachmentAddFilesOutput>({
          ok: (value) => () => value,
          err: (error) => () => {
            logger.error("attachment.add_files failed", {
              requestId: ctx.requestId,
              sessionId: ctx.sessionId,
              requestClient: ctx.requestClient,
              durationMs: Date.now() - startedAt,
              pathCount: input.paths.length,
              ...formatTaggedErrorForLog(error),
            });
            return adaptToolResultToHost(added);
          },
        })();
      },
    }),

    "attachment.download": tool({
      description: [
        "Download all inbound user message attachments into the sandbox.",
        "Scans ToolExecutionOptions.messages for user messages with array content parts.",
      ].join("\n"),
      inputSchema: attachmentDownloadInputSchema,
      outputSchema: attachmentDownloadOutputSchema,
      execute: async (input, options) => {
        const startedAt = Date.now();
        const downloadDir = resolve(expandTilde(input.downloadDir ?? "~/Downloads"));
        const decodedContext = optionalAttachmentContextSchema.safeParse(options.context);
        const context = decodedContext.success ? decodedContext.data : undefined;
        const requestId = context?.requestId;
        const sessionId = context?.sessionId;
        const requestClient = context?.requestClient;

        logger.info("attachment.download", {
          requestId,
          sessionId,
          requestClient,
          downloadDir,
        });

        const runDownload = async (): Promise<AttachmentDownloadOutput> => {
          const attachments = collectUserAttachments(options.messages);
          if (attachments.length === 0) {
            const emptyResult = { ok: true as const, downloadDir, files: [] };
            logger.info("attachment.download done", {
              requestId,
              sessionId,
              requestClient,
              durationMs: Date.now() - startedAt,
              attachmentCount: 0,
              fileCount: 0,
              totalBytes: 0,
            });
            return emptyResult;
          }

          await fs.mkdir(downloadDir, { recursive: true });

          const files: AttachmentDownloadOutput["files"] = [];
          const seenSha10 = new Set<string>();

          let totalBytes = 0;

          for (const att of attachments) {
            const downloaded = await downloadToBuffer(att.data);

            if (downloaded.bytes.byteLength > DEFAULT_INBOUND_MAX_FILE_BYTES) {
              signalAttachmentFailure(
                "validate_inbound_file",
                `Attachment too large (${downloaded.bytes.byteLength} bytes). Max is ${DEFAULT_INBOUND_MAX_FILE_BYTES} bytes.`,
              );
            }

            totalBytes += downloaded.bytes.byteLength;
            if (totalBytes > DEFAULT_INBOUND_MAX_TOTAL_BYTES) {
              signalAttachmentFailure(
                "validate_inbound_total",
                `Total attachment bytes too large (${totalBytes} bytes). Max is ${DEFAULT_INBOUND_MAX_TOTAL_BYTES} bytes.`,
              );
            }

            const detected = await fileTypeFromBuffer(downloaded.bytes);

            const mimeType =
              detected?.mime ||
              downloaded.contentType?.split(";")[0]?.trim() ||
              att.mediaTypeHint ||
              (att.filenameHint ? inferMimeTypeFromFilename(att.filenameHint) : undefined);

            const sha256 = createHash("sha256").update(downloaded.bytes).digest("hex");
            const sha10 = sha256.slice(0, 10);

            if (seenSha10.has(sha10)) {
              continue;
            }
            seenSha10.add(sha10);

            const extFromFileType = detected?.ext ? `.${detected.ext}` : "";
            const extFromFilename = att.filenameHint ? extname(att.filenameHint) : "";
            const extFromMime = mimeType ? inferExtensionFromMimeType(mimeType) : "";

            const ext = sanitizeExtension(extFromFileType || extFromFilename || extFromMime);
            const target = join(downloadDir, `${sha10}${ext}`);

            // Only write missing.
            const accessed = await captureAttachmentOperation({
              operation: "inspect_download_target",
              run: () => fs.access(target),
            });
            const exists = accessed.match({ ok: () => true, err: () => false });

            if (!exists) {
              await fs.writeFile(target, downloaded.bytes);
            }

            files.push({
              path: target,
              sha10,
              bytes: downloaded.bytes.byteLength,
              sourceUrl: downloaded.sourceUrl ?? "inline",
              mimeType,
            });
          }

          const result = { ok: true as const, downloadDir, files };

          logger.info("attachment.download done", {
            requestId,
            sessionId,
            requestClient,
            durationMs: Date.now() - startedAt,
            attachmentCount: attachments.length,
            fileCount: files.length,
            totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
          });

          return result;
        };
        const downloaded = await captureAttachmentOperation({
          operation: "download",
          run: runDownload,
        });
        return downloaded.match<() => AttachmentDownloadOutput>({
          ok: (value) => () => value,
          err: (error) => () => {
            logger.error("attachment.download failed", {
              requestId,
              sessionId,
              requestClient,
              durationMs: Date.now() - startedAt,
              downloadDir,
              ...formatTaggedErrorForLog(error),
            });
            return adaptToolResultToHost(downloaded);
          },
        })();
      },
    }),
  };
}
