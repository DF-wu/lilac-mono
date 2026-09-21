import type { SurfaceMsgRef } from "@stanley2058/lilac-event-bus";
import { Result } from "better-result";

import type { AuthenticatedRequestProjectionFor } from "../authenticated-request";
import {
  SurfaceRefInvalid,
  SurfaceReplyTargetInvalid,
  SurfaceToolTargetInvalid,
  type SurfaceProtocolRouting,
} from "../protocol";

export function nativeSessionId(threadId: string): string {
  return `native:${threadId}`;
}

export function nativeThreadId(sessionId: string): string {
  return sessionId.startsWith("native:") ? sessionId.slice(7) : sessionId;
}

export function nativeRequestId(threadId: string, messageId: string): string {
  return `native:${threadId}:${messageId}`;
}

export function parseNativeRequestId(
  requestId: string,
): { threadId: string; messageId: string } | null {
  const match = /^native:([^:\s]+):([^:\s]+)$/u.exec(requestId);
  return match?.[1] && match[2] ? { threadId: match[1], messageId: match[2] } : null;
}

function isNativeProjectionValid(projection: AuthenticatedRequestProjectionFor<"native">): boolean {
  const native = projection.native;
  if (!native || !projection.verifiedIngress) return false;
  return (
    projection.sessionId === nativeSessionId(native.threadId) &&
    native.requestId === projection.requestId &&
    projection.messageRef !== undefined &&
    projection.authenticatedActor?.userId === native.starterUserId &&
    projection.authenticatedOrigin?.userId === native.starterUserId &&
    projection.authenticatedOrigin?.messageRef?.messageId === projection.messageRef.messageId
  );
}

function decodeNativeMessageRef(input: {
  readonly ref: SurfaceMsgRef;
  readonly expectedSessionId: string;
}) {
  if (input.ref.platform !== "native")
    return Result.err(
      new SurfaceRefInvalid({
        reason: "platform-mismatch",
        expectedPlatform: "native",
        expectedSessionId: input.expectedSessionId,
        message: "Expected a native message reference",
      }),
    );
  if (input.ref.channelId !== nativeThreadId(input.expectedSessionId))
    return Result.err(
      new SurfaceRefInvalid({
        reason: "session-mismatch",
        expectedPlatform: "native",
        expectedSessionId: input.expectedSessionId,
        message: "Native message reference belongs to another thread",
      }),
    );
  return Result.ok({
    platform: "native" as const,
    channelId: input.ref.channelId,
    messageId: input.ref.messageId,
  });
}

export const nativeSurfaceProtocol = {
  platform: "native",
  displayName: "Native",
  ownsRequestId: (requestId) => requestId.startsWith("native:"),
  requestProjection: {
    inferRequestMessageRef: false,
    acceptsNativeMetadata: true,
    projectProtocolMetadata: ({ requestId, sessionRef, common, invalidProjection }) => {
      const native = common.native;
      if (
        !native ||
        native.requestId !== requestId ||
        native.threadId !== sessionRef.channelId ||
        common.actor?.userId !== native.starterUserId ||
        common.origin?.userId !== native.starterUserId ||
        !common.origin?.messageId
      ) {
        return invalidProjection(
          "Native request requires correlated starter authority and author attribution",
        );
      }
      return Result.ok({ native, verifiedIngress: true });
    },
    isProtocolProjectionValid: isNativeProjectionValid,
    hasDurableProtocolProof: isNativeProjectionValid,
    resolveExternalSafetyMode: ({ verifiedIngress, assertedSafetyMode }) =>
      verifiedIngress ? assertedSafetyMode : "restricted",
  },
  refs: {
    createSessionRef: (sessionId) => ({ platform: "native", channelId: nativeThreadId(sessionId) }),
    createMessageRef: (sessionRef, messageId) => ({
      platform: "native",
      channelId: sessionRef.channelId,
      messageId,
    }),
    decodeMessageRef: decodeNativeMessageRef,
    resolveRequestMessageRef: ({ requestId, sessionRef }) => {
      if (!requestId.startsWith("native:")) return { kind: "none" };
      const parsed = parseNativeRequestId(requestId);
      if (!parsed || parsed.threadId !== sessionRef.channelId)
        return {
          kind: "invalid",
          error: new SurfaceReplyTargetInvalid({
            reason: parsed ? "session-mismatch" : "malformed",
            expectedPlatform: "native",
            expectedSessionId: nativeSessionId(sessionRef.channelId),
            message: "Native request does not identify a message in this thread",
          }),
        };
      return {
        kind: "target",
        ref: { platform: "native", channelId: parsed.threadId, messageId: parsed.messageId },
      };
    },
  },
  toolTargets: {
    helpFallbackPriority: 2,
    inferRequestTarget: (requestId) => {
      const parsed = requestId ? parseNativeRequestId(requestId) : null;
      return parsed
        ? { sessionId: nativeSessionId(parsed.threadId), messageId: parsed.messageId }
        : null;
    },
    describeSessionIds: () => ({
      sessionIdFormats: {
        client: "native",
        accepted: [{ format: "native:<threadId>", meaning: "Native chat thread" }],
        notes: [],
      },
    }),
    resolveSession: async ({ selector }) => {
      if (!/^native:[^:\s]+$/u.test(selector))
        return Result.err(new SurfaceToolTargetInvalid({ message: "Expected native:<threadId>" }));
      return Result.ok({ sessionRef: { platform: "native", channelId: nativeThreadId(selector) } });
    },
  },
} satisfies SurfaceProtocolRouting<"native">;
