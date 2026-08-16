import type { SurfaceMsgRef } from "@stanley2058/lilac-event-bus";
import { Result } from "better-result";

import { parseRequestId } from "../bridge/request-ids";
import { discordToolTargetRouting } from "./discord-tool-targets";
import type { AuthenticatedRequestProjectionFor } from "../authenticated-request";
import {
  SurfaceRefInvalid,
  SurfaceReplyTargetInvalid,
  type SurfaceProtocolRouting,
} from "../protocol";

function isDiscordProjectionValid(projection: AuthenticatedRequestProjectionFor<"discord">) {
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

function hasDurableDiscordMessageProof(projection: AuthenticatedRequestProjectionFor<"discord">) {
  const messageRef = projection.messageRef;
  const originMessageRef = projection.authenticatedOrigin?.messageRef;
  if (!messageRef && !originMessageRef) return true;
  if (!messageRef) return false;
  const request = parseRequestId(projection.requestId);
  if (
    request?.kind !== "discord_message" ||
    request.channelId !== projection.sessionId ||
    request.channelId !== messageRef.channelId ||
    request.messageId !== messageRef.messageId
  ) {
    return false;
  }
  return (
    originMessageRef === undefined ||
    (originMessageRef.channelId === request.channelId &&
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
      expectedPlatform: "discord",
      expectedSessionId: input.sessionId,
      message: input.message,
    }),
  };
}

function decodeDiscordMessageRef(input: {
  readonly ref: SurfaceMsgRef;
  readonly expectedSessionId: string;
}) {
  if (input.ref.platform !== "discord") {
    return Result.err(
      new SurfaceRefInvalid({
        reason: "platform-mismatch",
        expectedPlatform: "discord",
        expectedSessionId: input.expectedSessionId,
        message: `Expected a Discord reply target, received '${input.ref.platform}'`,
      }),
    );
  }
  if (input.ref.channelId !== input.expectedSessionId) {
    return Result.err(
      new SurfaceRefInvalid({
        reason: "session-mismatch",
        expectedPlatform: "discord",
        expectedSessionId: input.expectedSessionId,
        message: `Discord reply target belongs to session '${input.ref.channelId}'`,
      }),
    );
  }
  return Result.ok({
    platform: "discord" as const,
    channelId: input.ref.channelId,
    messageId: input.ref.messageId,
  });
}

export const discordSurfaceProtocol = {
  platform: "discord",
  displayName: "Discord",
  ownsRequestId: (requestId) => requestId.startsWith("discord:"),
  toolTargets: discordToolTargetRouting,
  requestProjection: {
    inferRequestMessageRef: true,
    isProtocolProjectionValid: isDiscordProjectionValid,
    hasDurableProtocolProof: hasDurableDiscordMessageProof,
    resolveExternalSafetyMode: ({ verifiedIngress, assertedSafetyMode }) =>
      verifiedIngress ? assertedSafetyMode : "restricted",
  },
  refs: {
    createSessionRef: (sessionId) => ({ platform: "discord", channelId: sessionId }),
    createMessageRef: (sessionRef, messageId) => ({
      platform: "discord",
      channelId: sessionRef.channelId,
      messageId,
    }),
    resolveRequestMessageRef: ({ requestId, sessionRef }) => {
      const parsed = parseRequestId(requestId);
      if (parsed?.kind === "discord_message") {
        if (parsed.channelId !== sessionRef.channelId) {
          return invalidRequestMessageTarget({
            reason: "session-mismatch",
            sessionId: sessionRef.channelId,
            message: `Discord request belongs to session '${parsed.channelId}'`,
          });
        }
        return {
          kind: "target",
          ref: {
            platform: "discord",
            channelId: sessionRef.channelId,
            messageId: parsed.messageId,
          },
        };
      }
      if (parsed !== null) return { kind: "none" };
      if (requestId.startsWith("discord:")) {
        return invalidRequestMessageTarget({
          reason: "malformed",
          sessionId: sessionRef.channelId,
          message: `Malformed Discord request ID '${requestId}'`,
        });
      }
      return { kind: "none" };
    },
    decodeMessageRef: decodeDiscordMessageRef,
  },
} satisfies SurfaceProtocolRouting<"discord">;
