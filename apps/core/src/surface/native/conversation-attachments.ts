import { canInlineConversationAttachment } from "../bridge/request-composition/attachments";
import { Result } from "better-result";
import {
  ConversationThreadOperationFailed,
  type ConversationThreadAttachmentHydrator,
  type ConversationThreadSummaryAttachment,
} from "../../conversation/thread-service";
import { consumeVerifiedResourceRead } from "../../resource/service";
import type { NativeStore } from "./store";
import type { NativeSurfaceStore } from "./store-surface";
import type { NativeResourceService } from "./resources";

export function hydrateNativeConversationAttachments(
  dependencies: {
    store: NativeStore;
    surface: NativeSurfaceStore;
    resources: Pick<NativeResourceService, "scopedAccess">;
  },
  ref: Parameters<ConversationThreadAttachmentHydrator>[0]["refs"][number],
  remainingBytes: number,
) {
  const failure = () =>
    new ConversationThreadOperationFailed({
      operation: "summarize-thread",
      message: "Native conversation attachment is unavailable",
    });
  return Result.gen(async function* () {
    const thread = yield* dependencies.store.getThreadRecord(ref.channelId).mapError(failure);
    const message = yield* dependencies.surface
      .readMessage(thread.starterId, thread.id, ref.messageId)
      .mapError(failure);
    if (!message) return Result.err(failure());
    const attachments: ConversationThreadSummaryAttachment[] = [];
    for (const part of message.message.parts) {
      if (part.type !== "data-resource" || part.data.state !== "ready") continue;
      const upload = yield* dependencies.store
        .readUpload(thread.starterId, part.data.resourceId)
        .mapError(failure);
      const attachment: ConversationThreadSummaryAttachment = {
        id: part.data.resourceId,
        url: upload.resourceUri ?? "",
        filename: upload.filename,
        mimeType: upload.mediaType,
        size: upload.size,
      };
      attachments.push(attachment);
      if (upload.state !== "ready" || !upload.resourceUri) continue;
      if (
        upload.size > remainingBytes ||
        !canInlineConversationAttachment(upload.mediaType, upload.size)
      )
        continue;
      const readResult = await dependencies.resources
        .scopedAccess(thread.starterId)
        .open(upload.resourceUri, {
          expected: "any",
          maxBytes: Math.min(25 * 1024 * 1024, remainingBytes),
        });
      const read = readResult.match({ ok: (value) => value, err: () => null });
      if (!read) continue;
      const dataResult = await consumeVerifiedResourceRead(read);
      const data = dataResult.match({ ok: (value) => value, err: () => null });
      if (!data) continue;
      remainingBytes -= data.byteLength;
      attachment.data = data;
    }
    return Result.ok({ ref, attachments });
  });
}
