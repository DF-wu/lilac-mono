import type { SurfaceMsgRef } from "@stanley2058/lilac-event-bus";
import { Result, type Result as ResultType } from "better-result";

import { opaqueErrorMessage } from "@stanley2058/lilac-utils";

import { preserveSurfacePanic, SurfaceMessageNotFoundError, type SurfaceAdapter } from "../adapter";
import { parseRequestId } from "../bridge/request-ids";
import type {
  SurfaceAdapterIngress,
  SurfaceRelayDescriptor,
  SurfaceRelayPolicy,
  SurfaceReplyTargetInvalid,
  SurfaceRuntimeDescriptor,
  SurfaceWorkflowProgressPort,
  WorkflowProgressCheckFailure,
  WorkflowProgressEditFailure,
  WorkflowProgressSendFailure,
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

export function captureDiscordWorkflowProgressCall<T>(input: {
  readonly operation: "check-message";
  readonly effect: () => Promise<T>;
}): Promise<ResultType<T, WorkflowProgressCheckFailure>>;
export function captureDiscordWorkflowProgressCall<T>(input: {
  readonly operation: "send";
  readonly effect: () => Promise<T>;
}): Promise<ResultType<T, WorkflowProgressSendFailure<"discord">>>;
export function captureDiscordWorkflowProgressCall<T>(input: {
  readonly operation: "edit";
  readonly effect: () => Promise<T>;
}): Promise<ResultType<T, WorkflowProgressEditFailure>>;
export async function captureDiscordWorkflowProgressCall<T>(input: {
  readonly operation: DiscordWorkflowProgressOperation;
  readonly effect: () => Promise<T>;
}): Promise<
  ResultType<
    T,
    | WorkflowProgressCheckFailure
    | WorkflowProgressSendFailure<"discord">
    | WorkflowProgressEditFailure
  >
> {
  try {
    return Result.ok(await input.effect());
  } catch (cause) {
    preserveSurfacePanic(cause);
    const failureMessage =
      cause instanceof Error
        ? opaqueErrorMessage(cause, "Workflow progress surface call failed")
        : "Opaque workflow progress surface failure";
    const failed = discordWorkflowProgressFailure(input.operation, failureMessage);
    if (cause instanceof SurfaceMessageNotFoundError) {
      switch (input.operation) {
        case "check-message":
        case "send":
          return Result.err(failed);
        case "edit":
          return Result.err({ kind: "not-found" });
      }
    }
    return Result.err(failed);
  }
}

export function createDiscordWorkflowProgressPort(
  adapter: SurfaceAdapter,
): SurfaceWorkflowProgressPort<"discord"> {
  return {
    checkMessage: async (target) => {
      const checked = await captureDiscordWorkflowProgressCall({
        operation: "check-message",
        effect: () =>
          adapter.readMsg({
            platform: "discord",
            channelId: target.channelId,
            messageId: target.messageId,
          }),
      });
      switch (checked.status) {
        case "ok":
          return Result.ok(checked.value ? "found" : "missing");
        case "error":
          switch (checked.error.kind) {
            case "failed":
              return Result.err(checked.error);
          }
      }
    },
    send: async (input) => {
      const sent = await captureDiscordWorkflowProgressCall({
        operation: "send",
        effect: () =>
          adapter.sendMsg(
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
          ),
      });
      switch (sent.status) {
        case "ok":
          switch (sent.value.platform) {
            case "discord":
              return Result.ok(sent.value);
            case "github":
              return Result.err({
                kind: "failed",
                error: new WorkflowProgressOperationFailed({
                  operation: "send",
                  message: "Discord workflow progress send returned a 'github' message",
                }),
              });
          }
        case "error":
          switch (sent.error.kind) {
            case "failed":
              return Result.err(sent.error);
          }
      }
    },
    edit: async (target, content) => {
      const edited = await captureDiscordWorkflowProgressCall({
        operation: "edit",
        effect: () =>
          adapter.editMsg(
            {
              platform: "discord",
              channelId: target.channelId,
              messageId: target.messageId,
            },
            content,
          ),
      });
      switch (edited.status) {
        case "ok":
          return Result.ok(undefined);
        case "error":
          switch (edited.error.kind) {
            case "not-found":
            case "failed":
              return Result.err(edited.error);
          }
      }
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
}): SurfaceRuntimeDescriptor<"discord"> {
  return {
    platform: "discord",
    adapter: input.adapter,
    adapterIngress: input.adapterIngress,
    relay: input.relay,
    workflowProgress: createDiscordWorkflowProgressPort(input.adapter),
  };
}
