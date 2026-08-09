import type { SurfaceMsgRef } from "@stanley2058/lilac-event-bus";
import { Result } from "better-result";

import type { SurfaceAdapter } from "../adapter";
import { parseRequestId } from "../bridge/request-ids";
import type {
  SurfaceAdapterIngress,
  SurfaceRelayDescriptor,
  SurfaceRelayPolicy,
  SurfaceReplyTargetInvalid,
  SurfaceRuntimeDescriptor,
  SurfaceWorkflowProgressPort,
} from "../runtime-descriptor";
import { SurfaceReplyTargetInvalid as ReplyTargetInvalid } from "../runtime-descriptor";
import { SurfaceRefInvalid as RefInvalid } from "../runtime-descriptor";

function invalidInitialTarget(input: {
  readonly reason: SurfaceReplyTargetInvalid["reason"];
  readonly sessionId: string;
  readonly message: string;
}) {
  return {
    kind: "invalid" as const,
    error: new ReplyTargetInvalid({
      reason: input.reason,
      expectedPlatform: "discord",
      expectedSessionId: input.sessionId,
      message: input.message,
    }),
  };
}

function decodeDiscordRef(input: {
  readonly ref: SurfaceMsgRef;
  readonly expectedSessionId: string;
}) {
  if (input.ref.platform !== "discord") {
    return Result.err(
      new RefInvalid({
        reason: "platform-mismatch",
        expectedPlatform: "discord",
        expectedSessionId: input.expectedSessionId,
        message: `Expected a Discord reply target, received '${input.ref.platform}'`,
      }),
    );
  }
  if (input.ref.channelId !== input.expectedSessionId) {
    return Result.err(
      new RefInvalid({
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

export function createDiscordRelayPolicy(adapter: SurfaceAdapter): SurfaceRelayPolicy<"discord"> {
  return {
    refs: {
      createSessionRef: (sessionId) => ({ platform: "discord", channelId: sessionId }),
      resolveInitialReplyTarget: ({ requestId, sessionId }) => {
        const parsed = parseRequestId(requestId);
        if (parsed?.kind === "discord_message") {
          if (parsed.channelId !== sessionId) {
            return invalidInitialTarget({
              reason: "session-mismatch",
              sessionId,
              message: `Discord request belongs to session '${parsed.channelId}'`,
            });
          }
          return {
            kind: "target",
            ref: {
              platform: "discord",
              channelId: sessionId,
              messageId: parsed.messageId,
            },
          };
        }
        if (parsed !== null) return { kind: "none" };
        if (requestId.startsWith("discord:")) {
          return invalidInitialTarget({
            reason: "malformed",
            sessionId,
            message: `Malformed Discord request ID '${requestId}'`,
          });
        }
        if (requestId.startsWith("github:")) {
          return invalidInitialTarget({
            reason: "platform-mismatch",
            sessionId,
            message: `GitHub request ID cannot target Discord output`,
          });
        }
        return { kind: "none" };
      },
      decodeReanchorTarget: decodeDiscordRef,
    },
    finalization: {
      cleanupSkippedOutput: ({ ref }) => adapter.deleteMsg(ref),
    },
  };
}

export function createDiscordSurfaceRuntimeDescriptor(input: {
  readonly adapter: SurfaceAdapter;
  readonly adapterIngress: SurfaceAdapterIngress<"discord">;
  readonly relay: SurfaceRelayDescriptor<"discord">;
  readonly workflowProgress?: SurfaceWorkflowProgressPort<"discord">;
}): SurfaceRuntimeDescriptor<"discord"> {
  return {
    platform: "discord",
    adapter: input.adapter,
    adapterIngress: input.adapterIngress,
    relay: input.relay,
    ...(input.workflowProgress ? { workflowProgress: input.workflowProgress } : {}),
  };
}
