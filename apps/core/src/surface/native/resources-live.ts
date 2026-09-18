import { fromMarkdown } from "mdast-util-from-markdown";
import type { Root, RootContent } from "mdast";
import { basename } from "node:path";
import type { FileSystem } from "@stanley2058/lilac-fs";
import type { PersistedDataError } from "@stanley2058/lilac-utils";
import { Result, type Result as ResultType } from "better-result";
import { RESOURCE_MAX_BYTES } from "../../resource/contracts";
import {
  inferMimeTypeFromFilename,
  resolveToolPathForRequestContextResult,
} from "../../shared/attachment-utils";
import { parseSshCwdTarget } from "../../ssh/ssh-cwd";
import { remoteReadFileBytes } from "../../tools/fs/remote-fs";
import type { NativeThreadRecord, NativeUser } from "./codec";
import { nativeFailure, type NativeStoreFailure } from "./errors";

type NativeFileError = NativeStoreFailure | PersistedDataError;
type NativeFileResult<T> = ResultType<T, NativeFileError>;
export type PublishedNativePath = { id: string; threadId: string; path: string; cwd?: string };

export class NativeLiveFileService {
  constructor(
    readonly dependencies: {
      native: {
        readPublishedPath(actorId: string, id: string): NativeFileResult<PublishedNativePath>;
        getThreadRecord(threadId: string): NativeFileResult<NativeThreadRecord>;
        getUser(actorId: string): NativeFileResult<NativeUser>;
      };
      filesystem: FileSystem;
      toolRoot: string;
      remoteDenyPaths: readonly string[];
    },
  ) {}

  async read(
    actorId: string,
    pathId: string,
    signal?: AbortSignal,
  ): Promise<NativeFileResult<{ bytes: Uint8Array; filename: string; mediaType: string }>> {
    const service = this;
    return Result.gen(async function* () {
      const reference = yield* service.dependencies.native.readPublishedPath(actorId, pathId);
      const thread = yield* service.dependencies.native.getThreadRecord(reference.threadId);
      const starter = yield* service.dependencies.native.getUser(thread.starterId);
      const target = parseSshCwdTarget(reference.cwd);
      if (target.kind === "ssh" && starter.toolMode === "restricted")
        return Result.err(
          nativeFailure("forbidden", "Remote file preview is unavailable for this thread"),
        );
      if (target.kind === "ssh") {
        const read = yield* Result.await(
          remoteReadFileBytes({
            host: target.host,
            cwd: target.cwd,
            filePath: reference.path,
            denyPaths: service.dependencies.remoteDenyPaths,
            maxBytes: RESOURCE_MAX_BYTES,
            ...(signal ? { signal } : {}),
          }).then((result) =>
            result.mapError(() => nativeFailure("not-found", "File is missing or unreadable")),
          ),
        );
        if (!read.ok)
          return Result.err(nativeFailure("not-found", "File is missing or unreadable"));
        const bytes = Buffer.from(read.base64, "base64");
        if (bytes.byteLength > RESOURCE_MAX_BYTES)
          return Result.err(nativeFailure("invalid", "File exceeds the preview size limit"));
        yield* service.dependencies.native.readPublishedPath(actorId, pathId);
        return Result.ok({
          bytes,
          filename: basename(reference.path),
          mediaType: inferMimeTypeFromFilename(reference.path),
        });
      }
      const path = yield* resolveToolPathForRequestContextResult({
        cwd: reference.cwd ?? service.dependencies.toolRoot,
        inputPath: reference.path,
        context: {
          sessionId: reference.threadId,
          safetyMode: starter.toolMode === "restricted" ? "restricted" : "trusted",
        },
      }).mapError(() => nativeFailure("forbidden", "File path is outside this thread's access"));
      const read = await service.dependencies.filesystem.readFileBytes({
        path,
        maxBytes: RESOURCE_MAX_BYTES,
      });
      if (!read.success)
        return Result.err(nativeFailure("not-found", "File is missing or unreadable"));
      if (read.bytes.byteLength > RESOURCE_MAX_BYTES)
        return Result.err(nativeFailure("invalid", "File exceeds the preview size limit"));
      yield* service.dependencies.native.readPublishedPath(actorId, pathId);
      return Result.ok({
        bytes: read.bytes,
        filename: basename(reference.path),
        mediaType: inferMimeTypeFromFilename(reference.path),
      });
    });
  }

  async handle(request: Request, actorId: string): Promise<Response | undefined> {
    const pathId = /^\/api\/files\/([^/]+)$/u.exec(new URL(request.url).pathname)?.[1];
    if (pathId === undefined || request.method !== "GET") return undefined;
    const result = await this.read(actorId, pathId, request.signal);
    return result.match({
      ok: (file) =>
        new Response(new Blob([Uint8Array.from(file.bytes)]), {
          headers: {
            "Content-Type": file.mediaType,
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox; default-src 'none'",
            "Content-Disposition": `${["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", "text/plain", "application/json"].includes(file.mediaType) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.filename).replaceAll("'", "%27")}`,
          },
        }),
      err: (error) =>
        Response.json(
          { error: "File is missing or unavailable" },
          {
            status: error._tag === "NativeStoreFailure" && error.code === "forbidden" ? 403 : 404,
            headers: { "Cache-Control": "no-store" },
          },
        ),
    });
  }
}

export function rewriteNativePublishedFileLinks(input: {
  text: string;
  threadId: string;
  actorId: string;
  cwd: string;
  register: (
    actorId: string,
    threadId: string,
    path: string,
    cwd?: string,
  ) => NativeFileResult<PublishedNativePath>;
}): NativeFileResult<string> {
  const links: { start: number; end: number; marker: number; path: string }[] = [];
  function inspect(node: Root | RootContent): void {
    if (node.type === "link" || node.type === "image") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      const path = publishedFilesystemPath(node.url);
      if (start !== undefined && end !== undefined && path !== null) {
        const marker = input.text.slice(start, end).lastIndexOf("](");
        if (marker >= 0) links.push({ start, end, marker, path });
      }
    }
    if ("children" in node) for (const child of node.children) inspect(child);
  }
  inspect(fromMarkdown(input.text));
  return Result.gen(function* () {
    let text = input.text;
    for (const link of links.toReversed()) {
      const reference = yield* input.register(input.actorId, input.threadId, link.path, input.cwd);
      const prefix = input.text.slice(link.start, link.start + link.marker + 2);
      text = `${text.slice(0, link.start)}${prefix}/api/files/${reference.id})${text.slice(link.end)}`;
    }
    return Result.ok(text);
  });
}

function publishedFilesystemPath(url: string): string | null {
  if (url.startsWith("/") && !url.startsWith("//")) return url;
  if (url.startsWith("./") || url.startsWith("../")) return url;
  if (!url.startsWith("file://") || !URL.canParse(url)) return null;
  const parsed = new URL(url);
  if (parsed.hostname && parsed.hostname !== "localhost") return null;
  const decoded = Result.try({ try: () => decodeURIComponent(parsed.pathname), catch: () => null });
  return decoded.match({ ok: (path) => path, err: () => null });
}
