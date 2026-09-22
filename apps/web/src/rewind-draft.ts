import { Result } from "better-result";
import type { DisplayPart } from "@stanley2058/lilac-client-protocol";
import { messageClipboard } from "./message-clipboard";
import { attempt } from "./components/ui";
import type { UploadPool } from "./uploads";

export async function rewindDraft(options: {
  parts: readonly DisplayPart[];
  threadId: string;
  resourceUrl: (id: string) => string;
  pool: Pick<UploadPool, "add" | "get" | "signal">;
  rewind: () => Promise<{ text: string } | undefined>;
  onError: (message: string) => void;
}) {
  const resources = messageClipboard("", options.parts).resources;
  const prepared = await attempt(async () => {
    const { restoreMessageAttachments } = await import("./components/composer-editor");
    const downloads = await Promise.all(
      resources.map(async (resource) => {
        const response = await fetch(options.resourceUrl(resource.resourceId), {
          signal: options.pool.signal,
        });
        if (!response.ok) return Result.err(`Could not restore attachment ${resource.name}`);
        return Result.ok(
          new File([await response.blob()], resource.name, { type: resource.mediaType }),
        );
      }),
    );
    const files = Result.all(downloads).match({
      ok: (value) => value,
      err: (message) => {
        options.onError(message);
        return undefined;
      },
    });
    if (!files) return;
    return { files, restoreMessageAttachments };
  }, options.onError);
  if (!prepared || options.pool.signal.aborted) return;
  // Keep the bytes before rewind releases the original turn's resource references.
  const reply = await options.rewind();
  if (!reply || options.pool.signal.aborted) return;
  const keys = prepared.files.map((file) => options.pool.add(options.threadId, file));
  const attachments = options.pool.get(options.threadId);
  return {
    text: resources.length
      ? prepared.restoreMessageAttachments(
          reply.text,
          new Map(
            resources.map((resource, index) => [
              resource.resourceId,
              attachments.find((attachment) => attachment.key === keys[index])!,
            ]),
          ),
        )
      : reply.text,
    attachments: keys,
  };
}
