import { z } from "zod/v4";
import { fileTypeFromBuffer } from "file-type";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import type { ModelMessage } from "ai";
import { lilacEventTypes, type LilacBus } from "@stanley2058/lilac-event-bus";
import { isRecord } from "@stanley2058/lilac-utils";
import { Panic, Result, type Result as ResultType } from "better-result";
import {
  serverToolFailure,
  type ServerToolFailure,
  type ServerToolResult,
} from "@stanley2058/lilac-plugin-runtime";

import {
  defineServerTool,
  type RequestContext,
  type ServerTool,
  type ServerToolCallOptions,
} from "../types";
import {
  decodeToolServerHeaders,
  type RequiredToolServerHeaders,
} from "../../shared/tool-server-context";
import {
  decodeDataUrl,
  formatToolPathForRequestContext,
  inferExtensionFromMimeType,
  inferMimeTypeFromFilename,
  looksLikeDataUrl,
  looksLikeHttpUrl,
  resolveToolPathForRequestContextResult,
  sanitizeExtension,
} from "../../shared/attachment-utils";
import { expandTilde } from "@stanley2058/lilac-fs";
import { preserveToolPanic } from "../../tools/tool-result-adapters";

function attachmentFailure(kind: ServerToolFailure["kind"], message: string): ServerToolFailure {
  return serverToolFailure({
    kind,
    code: `attachment_${kind}`,
    message,
    retryable: kind === "unavailable" || kind === "timeout",
  });
}

function attachmentFailureFromUnknown(cause: unknown, fallbackMessage: string): ServerToolFailure {
  if (Panic.is(cause)) preserveToolPanic(cause);
  const error = isRecord(cause) ? cause : {};
  const name = typeof error.name === "string" ? error.name : undefined;
  const code = typeof error.code === "string" ? error.code : undefined;
  const message = typeof error.message === "string" ? error.message : fallbackMessage;
  if (name === "AbortError") return attachmentFailure("cancelled", message);
  if (name === "TimeoutError" || code === "ETIMEDOUT") {
    return attachmentFailure("timeout", message);
  }
  if (code === "ENOENT") return attachmentFailure("not_found", message);
  if (code === "EACCES" || code === "EPERM") {
    return attachmentFailure("denied", message);
  }
  return attachmentFailure("unavailable", message);
}

function attachmentUrlForFailure(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

function resultBranch<TValue>(
  result: ResultType<TValue, ServerToolFailure>,
): { readonly value: TValue } | { readonly failure: ServerToolFailure } {
  return result.match<{ readonly value: TValue } | { readonly failure: ServerToolFailure }>({
    ok: (value) => ({ value }),
    err: (failure) => ({ failure }),
  });
}

const DEFAULT_OUTBOUND_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_OUTBOUND_MAX_TOTAL_BYTES = 16 * 1024 * 1024;

const DEFAULT_INBOUND_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_INBOUND_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

const DISCORD_CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

type RequestHeaders = RequiredToolServerHeaders;

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
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;

  const input = raw as Record<string, unknown>;
  if (input["paths"] !== undefined || input["files"] === undefined) {
    return raw;
  }

  return {
    ...input,
    paths: input["files"],
  };
}

function toHeaders(ctx: RequestContext | undefined): ResultType<RequestHeaders, ServerToolFailure> {
  return decodeToolServerHeaders(ctx, "attachment").mapError((error) =>
    attachmentFailure("usage", error.message),
  );
}

function asBuffer(data: unknown): ResultType<Buffer, ServerToolFailure> {
  if (Buffer.isBuffer(data)) return Result.ok(data);
  if (data instanceof Uint8Array) return Result.ok(Buffer.from(data));
  if (data instanceof ArrayBuffer) return Result.ok(Buffer.from(new Uint8Array(data)));

  if (typeof data === "string") {
    if (looksLikeDataUrl(data)) {
      return Result.try({
        try: () => decodeDataUrl(data).bytes,
        catch: (cause) => {
          const failure = attachmentFailureFromUnknown(cause, "Invalid attachment data URL");
          return attachmentFailure("usage", failure.message);
        },
      });
    }

    // AI SDK DataContent string is defined as base64.
    return Result.ok(Buffer.from(data, "base64"));
  }

  return Result.err(attachmentFailure("usage", "Unsupported data content"));
}

async function downloadToBuffer(
  input: unknown,
  signal: AbortSignal | undefined,
): Promise<
  ResultType<
    {
      bytes: Buffer;
      sourceUrl?: string;
      contentType?: string;
    },
    ServerToolFailure
  >
> {
  if (input instanceof URL) {
    if (!DISCORD_CDN_HOSTS.has(input.hostname)) {
      return Result.err(
        attachmentFailure(
          "denied",
          `Blocked attachment host '${input.hostname}'. Allowed: ${[...DISCORD_CDN_HOSTS].join(", ")}`,
        ),
      );
    }

    const safeUrl = attachmentUrlForFailure(input);
    const fetched = await Result.tryPromise({
      try: () => fetch(input.toString(), { redirect: "follow", signal }),
      catch: (cause) => {
        const message = `Attachment download failed for ${safeUrl}`;
        const failure = attachmentFailureFromUnknown(cause, message);
        return attachmentFailure(failure.kind, message);
      },
    });
    return fetched.andThenAsync(async (res) => {
      if (!res.ok) {
        let category: ServerToolFailure["kind"] = "unavailable";
        if (res.status === 404) category = "not_found";
        else if (res.status === 401 || res.status === 403) category = "denied";
        else if (res.status === 408 || res.status === 504) category = "timeout";
        else if (res.status === 409) category = "conflict";
        return Result.err(
          attachmentFailure(category, `Failed to download attachment (${res.status}): ${safeUrl}`),
        );
      }
      return (
        await Result.tryPromise({
          try: () => res.arrayBuffer(),
          catch: (cause) => {
            const message = `Failed to read attachment response for ${safeUrl}`;
            const failure = attachmentFailureFromUnknown(cause, message);
            return attachmentFailure(failure.kind, message);
          },
        })
      ).map((ab) => ({
        bytes: Buffer.from(ab),
        sourceUrl: input.toString(),
        contentType: res.headers.get("content-type") ?? undefined,
      }));
    });
  }

  if (typeof input === "string" && looksLikeHttpUrl(input)) {
    return await downloadToBuffer(new URL(input), signal);
  }

  if (typeof input === "string" && looksLikeDataUrl(input)) {
    return Result.try({
      try: () => decodeDataUrl(input),
      catch: (cause) => {
        const failure = attachmentFailureFromUnknown(cause, "Invalid attachment data URL");
        return attachmentFailure("usage", failure.message);
      },
    }).map((decoded) => ({ bytes: decoded.bytes, contentType: decoded.mimeType }));
  }

  return asBuffer(input).map((bytes) => ({ bytes }));
}

const attachmentAddFilesInputSchema = z
  .preprocess(
    normalizeAttachmentAddFilesInput,
    z.object({
      paths: nonEmptyStringListInputSchema.describe(
        "Local file paths to attach (resolved relative to request cwd; alias: files)",
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

const attachmentDownloadInputSchema = z.object({
  downloadDir: z
    .string()
    .optional()
    .describe("Directory to save downloaded files (default: ~/Downloads)"),
});

type DetectedAttachment =
  | {
      kind: "image";
      source: string;
      mediaTypeHint?: string;
      filenameHint?: string;
      data: unknown;
    }
  | {
      kind: "file";
      source: string;
      mediaTypeHint: string;
      filenameHint?: string;
      data: unknown;
    };

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
    }
  }

  return out;
}

export class Attachment implements ServerTool {
  id = "attachment";
  private readonly tool: ServerTool;

  constructor(private readonly params: { bus: LilacBus }) {
    this.tool = defineServerTool({
      id: this.id,
      callables: ({ callable }) => ({
        "attachment.add_files": callable({
          name: "Attachment Add Files",
          description: "Reads local files and attaches them to the current reply.",
          inputSchema: attachmentAddFilesInputSchema,
          primaryPositional: {
            field: "paths",
            variadic: true,
          },
          cli: {
            shortInput: ["--paths=<string | string[]>"],
            input: [
              "--paths=<string | string[]> | Local file paths (preferred; alias: files)",
              "--filenames=<string | string[]> | Optional filenames (same length as paths)",
              "--mimeTypes=<string | string[]> | Optional mime types (same length as paths)",
            ],
          },
          run: (input, opts) => this.callAddFiles(input, opts?.context),
        }),
        "attachment.download": callable({
          name: "Attachment Download",
          description:
            "Download inbound user message attachments into the sandbox (from the current request prompt).",
          inputSchema: attachmentDownloadInputSchema,
          cli: {
            shortInput: [],
            input: ["--downloadDir=<string>"],
          },
          run: (input, opts) => {
            const messages = opts?.messages as readonly ModelMessage[] | undefined;
            if (!messages) {
              return Result.err(
                attachmentFailure(
                  "unavailable",
                  "attachment.download requires request messages, but none were available for this request. (Tool server caches cmd.request messages; ensure the tool server is connected to the bus and started before the request.)",
                ),
              );
            }
            return this.callDownload(input, messages, opts?.context, opts?.signal);
          },
        }),
      }),
    });
  }

  async init(): Promise<void> {
    await this.tool.init();
  }

  async destroy(): Promise<void> {
    await this.tool.destroy();
  }

  async list() {
    return await this.tool.list();
  }

  async call(
    callableId: string,
    input: Record<string, unknown>,
    opts?: ServerToolCallOptions,
  ): Promise<ServerToolResult> {
    return await this.tool.call(callableId, input, opts);
  }

  private async callAddFiles(
    input: z.output<typeof attachmentAddFilesInputSchema>,
    ctx: RequestContext | undefined,
  ): Promise<ServerToolResult> {
    const headersResult = toHeaders(ctx);
    const headersBranch = resultBranch(headersResult);
    if ("failure" in headersBranch) return Result.err(headersBranch.failure);
    const headers = headersBranch.value;

    const cwd = ctx?.cwd ?? process.cwd();

    let totalBytes = 0;

    const out: Array<{ filename: string; mimeType: string; bytes: number }> = [];

    for (let i = 0; i < input.paths.length; i++) {
      const p = input.paths[i]!;
      const resolvedPathResult = resolveToolPathForRequestContextResult({
        cwd,
        inputPath: p,
        context: ctx,
      }).mapError((error) => attachmentFailure("denied", error.message));
      const resolvedPathBranch = resultBranch(resolvedPathResult);
      if ("failure" in resolvedPathBranch) return Result.err(resolvedPathBranch.failure);
      const resolvedPath = resolvedPathBranch.value;

      const stat = await Result.tryPromise({
        try: () => fs.stat(resolvedPath),
        catch: (cause) => attachmentFailureFromUnknown(cause, `Unable to read ${resolvedPath}`),
      });
      const statBranch = resultBranch(stat);
      if ("failure" in statBranch) return Result.err(statBranch.failure);
      const st = statBranch.value;
      if (!st.isFile()) {
        return Result.err(
          attachmentFailure(
            "usage",
            `Not a file: ${formatToolPathForRequestContext({ path: resolvedPath, context: ctx })}`,
          ),
        );
      }

      if (st.size > DEFAULT_OUTBOUND_MAX_FILE_BYTES) {
        return Result.err(
          attachmentFailure(
            "usage",
            `Attachment too large (${st.size} bytes). Max is ${DEFAULT_OUTBOUND_MAX_FILE_BYTES} bytes: ${formatToolPathForRequestContext({ path: resolvedPath, context: ctx })}`,
          ),
        );
      }

      totalBytes += st.size;
      if (totalBytes > DEFAULT_OUTBOUND_MAX_TOTAL_BYTES) {
        return Result.err(
          attachmentFailure(
            "usage",
            `Total attachment bytes too large (${totalBytes} bytes). Max is ${DEFAULT_OUTBOUND_MAX_TOTAL_BYTES} bytes.`,
          ),
        );
      }

      const read = await Result.tryPromise({
        try: () => fs.readFile(resolvedPath),
        catch: (cause) => attachmentFailureFromUnknown(cause, `Unable to read ${resolvedPath}`),
      });
      const readBranch = resultBranch(read);
      if ("failure" in readBranch) return Result.err(readBranch.failure);
      const bytes = readBranch.value;

      const filename = (input.filenames && input.filenames[i]) || basename(resolvedPath);

      const typeFromBytes = await fileTypeFromBuffer(bytes);

      const mimeType =
        (input.mimeTypes && input.mimeTypes[i]) ||
        typeFromBytes?.mime ||
        inferMimeTypeFromFilename(filename);

      const dataBase64 = Buffer.from(bytes).toString("base64");

      const published = (
        await this.params.bus.publish(
          lilacEventTypes.EvtAgentOutputResponseBinary,
          { mimeType, dataBase64, filename },
          { headers },
        )
      ).mapError((error) => attachmentFailure("unavailable", error.message));
      const publishedBranch = resultBranch(published);
      if ("failure" in publishedBranch) return Result.err(publishedBranch.failure);

      out.push({ filename, mimeType, bytes: bytes.byteLength });
    }

    return Result.ok({ ok: true as const, attachments: out });
  }

  private async callDownload(
    input: z.output<typeof attachmentDownloadInputSchema>,
    messages: readonly ModelMessage[],
    ctx: RequestContext | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ServerToolResult> {
    const downloadDirResult =
      ctx?.safetyMode === "restricted"
        ? resolveToolPathForRequestContextResult({
            cwd: ctx.cwd ?? "/tmp",
            inputPath: input.downloadDir ?? "/tmp",
            context: ctx,
          }).mapError((error) => attachmentFailure("denied", error.message))
        : Result.ok(resolve(expandTilde(input.downloadDir ?? "~/Downloads")));
    const downloadDirBranch = resultBranch(downloadDirResult);
    if ("failure" in downloadDirBranch) return Result.err(downloadDirBranch.failure);
    const downloadDir = downloadDirBranch.value;

    const attachments = collectUserAttachments(messages);
    const outputDownloadDir = formatToolPathForRequestContext({ path: downloadDir, context: ctx });
    if (attachments.length === 0) {
      return Result.ok({ ok: true as const, downloadDir: outputDownloadDir, files: [] });
    }

    const madeDirectory = await Result.tryPromise({
      try: () => fs.mkdir(downloadDir, { recursive: true }),
      catch: (cause) =>
        attachmentFailureFromUnknown(cause, `Unable to create download directory ${downloadDir}`),
    });
    const madeDirectoryBranch = resultBranch(madeDirectory);
    if ("failure" in madeDirectoryBranch) return Result.err(madeDirectoryBranch.failure);

    const files: Array<{
      path: string;
      sha10: string;
      bytes: number;
      sourceUrl: string;
      mimeType?: string;
    }> = [];

    const seenSha10 = new Set<string>();

    let totalBytes = 0;

    for (const att of attachments) {
      const downloadedResult = await downloadToBuffer(att.data, signal);
      const downloadedBranch = resultBranch(downloadedResult);
      if ("failure" in downloadedBranch) return Result.err(downloadedBranch.failure);
      const downloaded = downloadedBranch.value;

      if (downloaded.bytes.byteLength > DEFAULT_INBOUND_MAX_FILE_BYTES) {
        return Result.err(
          attachmentFailure(
            "usage",
            `Attachment too large (${downloaded.bytes.byteLength} bytes). Max is ${DEFAULT_INBOUND_MAX_FILE_BYTES} bytes.`,
          ),
        );
      }

      totalBytes += downloaded.bytes.byteLength;
      if (totalBytes > DEFAULT_INBOUND_MAX_TOTAL_BYTES) {
        return Result.err(
          attachmentFailure(
            "usage",
            `Total attachment bytes too large (${totalBytes} bytes). Max is ${DEFAULT_INBOUND_MAX_TOTAL_BYTES} bytes.`,
          ),
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

      const exists = (
        await Result.tryPromise({
          try: () => fs.access(target),
          catch: (cause) => attachmentFailureFromUnknown(cause, `Unable to access ${target}`),
        })
      ).match({
        ok: () => true,
        err: () => false,
      });

      if (!exists) {
        const written = await Result.tryPromise({
          try: () => fs.writeFile(target, downloaded.bytes),
          catch: (cause) => attachmentFailureFromUnknown(cause, `Unable to write ${target}`),
        });
        const writtenBranch = resultBranch(written);
        if ("failure" in writtenBranch) return Result.err(writtenBranch.failure);
      }

      files.push({
        path: formatToolPathForRequestContext({ path: target, context: ctx }),
        sha10,
        bytes: downloaded.bytes.byteLength,
        sourceUrl: downloaded.sourceUrl ?? "inline",
        mimeType,
      });
    }

    return Result.ok({ ok: true as const, downloadDir: outputDownloadDir, files });
  }
}
