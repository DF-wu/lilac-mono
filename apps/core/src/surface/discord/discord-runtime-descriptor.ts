import type { SurfaceMsgRef } from "@stanley2058/lilac-event-bus";
import { Result } from "better-result";

import type { SurfaceAdapter, SurfaceOperationError } from "../adapter";
import { parseRequestId } from "../bridge/request-ids";
import type {
  SurfaceAdapterIngress,
  SurfaceRelayDescriptor,
  SurfaceRelayPolicy,
  SurfaceReplyTargetInvalid,
  SurfaceRuntimeDescriptor,
  SurfaceWorkflowProgressPort,
} from "../runtime-descriptor";
import {
  SurfaceReplyTargetInvalid as ReplyTargetInvalid,
  SurfaceRefInvalid as RefInvalid,
  WorkflowProgressOperationFailed,
} from "../runtime-descriptor";

type DiscordWorkflowProgressOperation = "check-message" | "send" | "edit";

function discordWorkflowProgressFailure(
  operation: DiscordWorkflowProgressOperation,
  message: string,
): { readonly kind: "failed"; readonly error: WorkflowProgressOperationFailed } {
  return {
    kind: "failed",
    error: new WorkflowProgressOperationFailed({
      operation,
      message,
    }),
  };
}

function discordWorkflowError(
  operation: DiscordWorkflowProgressOperation,
  error: SurfaceOperationError,
): { readonly kind: "failed"; readonly error: WorkflowProgressOperationFailed } {
  return discordWorkflowProgressFailure(operation, error.message);
}

export function createDiscordWorkflowProgressPort(
  adapter: SurfaceAdapter,
): SurfaceWorkflowProgressPort<"discord"> {
  return {
    checkMessage: async (target) => {
      const checked = await adapter.readMsg({
        platform: "discord",
        channelId: target.channelId,
        messageId: target.messageId,
      });
      if (checked.status === "error") {
        if (checked.error._tag === "SurfaceMessageNotFound") {
          return Result.ok("missing");
        }
        return Result.err(discordWorkflowError("check-message", checked.error));
      }
      return Result.ok(checked.value ? "found" : "missing");
    },
    send: async (input) => {
      const sent = await adapter.sendMsg(
        { platform: "discord", channelId: input.channelId },
        input.content,
        input.replyToMessageId
          ? {
              replyTo: {
                platform: "discord",
                channelId: input.channelId,
                messageId: input.replyToMessageId,
              },
              silent: input.silent,
            }
          : { silent: input.silent },
      );
      if (sent.status === "error") {
        return Result.err(discordWorkflowError("send", sent.error));
      }
      if (sent.value.platform === "discord") return Result.ok(sent.value);
      return Result.err(
        discordWorkflowProgressFailure(
          "send",
          "Discord workflow progress send returned a 'github' message",
        ),
      );
    },
    edit: async (target, content) => {
      const edited = await adapter.editMsg(
        {
          platform: "discord",
          channelId: target.channelId,
          messageId: target.messageId,
        },
        content,
      );
      if (edited.status === "ok") return Result.ok(undefined);
      if (edited.error._tag === "SurfaceMessageNotFound") {
        return Result.err({ kind: "not-found" });
      }
      return Result.err(discordWorkflowError("edit", edited.error));
    },
  };
}

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

async function adaptDiscordSkippedOutputCleanupResultToHost(
  adapter: SurfaceAdapter,
  ref: Parameters<SurfaceAdapter["deleteMsg"]>[0],
): Promise<void> {
  const deleted = await adapter.deleteMsg(ref);
  if (deleted.status === "error") throw deleted.error;
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
      cleanupSkippedOutput: async ({ ref }) =>
        adaptDiscordSkippedOutputCleanupResultToHost(adapter, ref),
    },
  };
}

export function createDiscordSurfaceRuntimeDescriptor(input: {
  readonly adapter: SurfaceAdapter;
  readonly adapterIngress: SurfaceAdapterIngress<"discord">;
  readonly relay: SurfaceRelayDescriptor<"discord">;
}): SurfaceRuntimeDescriptor<"discord"> {
  return {
    platform: "discord",
    adapter: input.adapter,
    adapterIngress: input.adapterIngress,
    relay: input.relay,
    workflowProgress: createDiscordWorkflowProgressPort(input.adapter),
  };
}
