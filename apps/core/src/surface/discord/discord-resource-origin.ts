import { Result, type Result as ResultType } from "better-result";

import {
  formatResourceUri,
  type DiscordResourceOriginV1,
  type ResourceRecordV1,
} from "../../resource/contracts";
import { ResourceOriginUnavailable } from "../../resource/errors";
import type { ResolvedResourceOrigin, ResourceOriginAdapter } from "../../resource/origin";
import type { SurfaceAdapter, SurfaceOperationError } from "../adapter";
import type { SurfaceMessage } from "../types";
import { selectVisibleDiscordAttachments, type DiscordAttachmentMeta } from "./discord-attachment";
import { normalizeDiscordRaw } from "./discord-raw-normalizer";

const DISCORD_ATTACHMENT_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

type DiscordResourceRecord = ResourceRecordV1 & {
  readonly origin: DiscordResourceOriginV1;
};

function unavailable(
  record: DiscordResourceRecord,
  retryable: boolean,
  message: string,
): ResourceOriginUnavailable {
  return new ResourceOriginUnavailable({
    uri: formatResourceUri(record.resourceId),
    retryable,
    message,
  });
}

function isRetryableReadFailure(error: SurfaceOperationError): boolean {
  switch (error._tag) {
    case "SurfacePermissionDenied":
    case "SurfaceRateLimited":
    case "SurfaceUnavailable":
      return true;
    case "SurfaceOperationUnsupported":
    case "SurfacePlatformMismatch":
    case "SurfaceSessionMismatch":
    case "SurfaceInvalidInput":
    case "SurfaceOperationPartiallyCompleted":
    case "SurfaceMessageNotFound":
      return false;
  }
}

function normalizeMediaType(value: string | undefined): string | undefined {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function getVisibleDiscordResourceAttachments(message: SurfaceMessage): DiscordAttachmentMeta[] {
  return selectVisibleDiscordAttachments(normalizeDiscordRaw(message.raw));
}

function verifyAttachmentIdentity(
  record: DiscordResourceRecord,
  attachment: DiscordAttachmentMeta,
): ResultType<void, ResourceOriginUnavailable> {
  const attachmentId = record.origin.attachmentId;
  if (attachmentId !== undefined) {
    return attachment.id === attachmentId
      ? Result.ok(undefined)
      : Result.err(unavailable(record, false, "The Discord attachment identity no longer matches"));
  }
  return Result.ok(undefined);
}

function parseDiscordAttachmentUrl(
  record: DiscordResourceRecord,
  attachment: DiscordAttachmentMeta,
): ResultType<URL, ResourceOriginUnavailable> {
  const parsed = Result.try({
    try: () => new URL(attachment.url),
    catch: () => unavailable(record, false, "Discord returned an invalid attachment location"),
  });
  return parsed.andThen((url) =>
    url.protocol === "https:" && DISCORD_ATTACHMENT_HOSTS.has(url.hostname)
      ? Result.ok(url)
      : Result.err(
          unavailable(record, false, "Discord returned an unsupported attachment location"),
        ),
  );
}

export function createDiscordResourceOriginAdapter(
  adapter: Pick<SurfaceAdapter, "readMsg">,
): ResourceOriginAdapter<DiscordResourceOriginV1> {
  return {
    kind: "discord-attachment",
    async resolve(input) {
      const record = input.record;
      return Result.gen(async function* () {
        const message = yield* Result.await(
          adapter
            .readMsg({
              platform: "discord",
              channelId: record.origin.channelId,
              messageId: record.origin.messageId,
            })
            .then((read) =>
              read.mapError((error) =>
                unavailable(
                  record,
                  isRetryableReadFailure(error),
                  "Discord could not reread the resource origin message",
                ),
              ),
            ),
        );
        if (message === null) {
          return Result.err(
            unavailable(record, false, "The Discord resource origin message is unavailable"),
          );
        }

        const attachments = getVisibleDiscordResourceAttachments(message);
        const attachment = attachments[record.origin.ordinal];
        if (attachment === undefined) {
          return Result.err(
            unavailable(record, false, "The Discord resource origin attachment is unavailable"),
          );
        }

        yield* verifyAttachmentIdentity(record, attachment);
        const url = yield* parseDiscordAttachmentUrl(record, attachment);
        return Result.ok({
          url,
          ...(attachment.filename === undefined ? {} : { filename: attachment.filename }),
          ...(normalizeMediaType(attachment.mimeType) === undefined
            ? {}
            : { declaredMediaType: normalizeMediaType(attachment.mimeType) }),
          ...(attachment.size === undefined ? {} : { reportedByteLength: attachment.size }),
        } satisfies ResolvedResourceOrigin);
      });
    },
  };
}
