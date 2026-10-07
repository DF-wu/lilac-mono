import type { SurfaceMsgRef } from "@stanley2058/lilac-event-bus";
import { Result } from "better-result";

import type { AuthenticatedRequestProjectionFor } from "../authenticated-request";
import { parseRequestId } from "../bridge/request-ids";
import {
  SurfaceRefInvalid,
  SurfaceReplyTargetInvalid,
  type SurfaceProtocolRouting,
} from "../protocol";
import { telegramToolTargetRouting } from "./telegram-tool-targets";

function isTelegramProjectionValid(projection: AuthenticatedRequestProjectionFor<"telegram">) {
  const kind = projection.authenticationMetadataKind;
  const expectedActor = kind.includes("actor");
  const expectedOrigin = kind.includes("origin");
  const expectedVerified =
    expectedOrigin || (expectedActor && projection.authenticatedOrigin !== undefined);
  const restrictedActorWithoutMessageProof =
    expectedActor &&
    !expectedOrigin &&
    projection.messageRef === undefined &&
    projection.authenticatedOrigin?.messageRef === undefined &&
    !projection.verifiedIngress;
  return restrictedActorWithoutMessageProof || projection.verifiedIngress === expectedVerified;
}

function hasDurableTelegramMessageProof(projection: AuthenticatedRequestProjectionFor<"telegram">) {
  const messageRef = projection.messageRef;
  const originMessageRef = projection.authenticatedOrigin?.messageRef;
  if (!messageRef && !originMessageRef) return true;
  if (!messageRef) return false;
  const request = parseRequestId(projection.requestId);
  if (
    request?.kind !== "telegram_message" ||
    request.sessionId !== projection.sessionId ||
    request.sessionId !== messageRef.channelId ||
    request.messageId !== messageRef.messageId
  ) {
    return false;
  }
  return (
    originMessageRef === undefined ||
    (originMessageRef.channelId === request.sessionId &&
      originMessageRef.messageId === request.messageId)
  );
}

function invalidRequestMessageTarget(input: {
  readonly reason: SurfaceReplyTargetInvalid["reason"];
  readonly sessionId: string;
  readonly message: string;
}) {
  return {
    kind: "invalid" as const,
    error: new SurfaceReplyTargetInvalid({
      reason: input.reason,
      expectedPlatform: "telegram",
      expectedSessionId: input.sessionId,
      message: input.message,
    }),
  };
}

function decodeTelegramMessageRef(input: {
  readonly ref: SurfaceMsgRef;
  readonly expectedSessionId: string;
}) {
  if (input.ref.platform !== "telegram") {
    return Result.err(
      new SurfaceRefInvalid({
        reason: "platform-mismatch",
        expectedPlatform: "telegram",
        expectedSessionId: input.expectedSessionId,
        message: `Expected a Telegram reply target, received '${input.ref.platform}'`,
      }),
    );
  }
  if (input.ref.channelId !== input.expectedSessionId) {
    return Result.err(
      new SurfaceRefInvalid({
        reason: "session-mismatch",
        expectedPlatform: "telegram",
        expectedSessionId: input.expectedSessionId,
        message: `Telegram reply target belongs to session '${input.ref.channelId}'`,
      }),
    );
  }
  return Result.ok({
    platform: "telegram" as const,
    channelId: input.ref.channelId,
    messageId: input.ref.messageId,
  });
}

export const telegramSurfaceProtocol = {
  platform: "telegram",
  displayName: "Telegram",
  ownsRequestId: (requestId) => requestId.startsWith("telegram:"),
  toolTargets: telegramToolTargetRouting,
  requestProjection: {
    inferRequestMessageRef: true,
    isProtocolProjectionValid: isTelegramProjectionValid,
    hasDurableProtocolProof: hasDurableTelegramMessageProof,
    resolveExternalSafetyMode: ({ verifiedIngress, assertedSafetyMode }) =>
      verifiedIngress ? assertedSafetyMode : "restricted",
  },
  refs: {
    createSessionRef: (sessionId) => ({ platform: "telegram", channelId: sessionId }),
    createMessageRef: (sessionRef, messageId) => ({
      platform: "telegram",
      channelId: sessionRef.channelId,
      messageId,
    }),
    resolveRequestMessageRef: ({ requestId, sessionRef }) => {
      const parsed = parseRequestId(requestId);
      if (parsed?.kind === "telegram_message") {
        if (parsed.sessionId !== sessionRef.channelId) {
          return invalidRequestMessageTarget({
            reason: "session-mismatch",
            sessionId: sessionRef.channelId,
            message: `Telegram request belongs to session '${parsed.sessionId}'`,
          });
        }
        return {
          kind: "target",
          ref: {
            platform: "telegram",
            channelId: sessionRef.channelId,
            messageId: parsed.messageId,
          },
        };
      }
      if (parsed !== null) return { kind: "none" };
      if (requestId.startsWith("telegram:")) {
        return invalidRequestMessageTarget({
          reason: "malformed",
          sessionId: sessionRef.channelId,
          message: `Malformed Telegram request ID '${requestId}'`,
        });
      }
      return { kind: "none" };
    },
    decodeMessageRef: decodeTelegramMessageRef,
  },
} satisfies SurfaceProtocolRouting<"telegram">;
