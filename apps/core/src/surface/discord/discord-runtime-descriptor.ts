import { Result } from "better-result";

import type { SurfaceAdapter, SurfaceOperationError } from "../adapter";
import { resolveBuiltinSurfaceRequestMessageRef } from "../builtin-surface-protocols";
import { discordSurfaceProtocol } from "./discord-surface-protocol";
import type {
  SurfaceAdapterIngress,
  SurfaceRelayDescriptor,
  SurfaceRelayPolicy,
  SurfaceRelayRecovery,
  SurfaceRuntimeHealthPort,
  SurfaceRuntimeDescriptor,
  SurfaceWorkflowProgressPort,
  WorkflowProgressOperationFailed,
} from "../runtime-descriptor";
import { workflowProgressOperationFailure } from "../runtime-descriptor";

type DiscordWorkflowProgressOperation = "check-message" | "send" | "edit";

// Bump when the declared workflow operation contract or failure policy changes.
export const DISCORD_WORKFLOW_PROGRESS_CONFIGURATION_REVISION = "discord-workflow-progress-v1";

function discordWorkflowError(
  operation: DiscordWorkflowProgressOperation,
  error: SurfaceOperationError,
): { readonly kind: "failed"; readonly error: WorkflowProgressOperationFailed } {
  return { kind: "failed", error: workflowProgressOperationFailure(operation, error) };
}

export function createDiscordWorkflowProgressPort(
  adapter: SurfaceAdapter,
): SurfaceWorkflowProgressPort<"discord"> {
  return {
    configurationRevision: DISCORD_WORKFLOW_PROGRESS_CONFIGURATION_REVISION,
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
        if (sent.error._tag === "SurfaceOperationPartiallyCompleted") {
          const created = sent.error.created;
          if (created.platform === "discord") {
            return Result.err({
              kind: "created",
              ref: {
                platform: "discord",
                channelId: created.channelId,
                messageId: created.messageId,
              },
            });
          }
        }
        return Result.err(discordWorkflowError("send", sent.error));
      }
      return Result.ok({
        platform: "discord",
        channelId: sent.value.channelId,
        messageId: sent.value.messageId,
      });
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

async function adaptDiscordSkippedOutputCleanupResultToHost(
  adapter: SurfaceAdapter,
  ref: Parameters<SurfaceAdapter["deleteMsg"]>[0],
): Promise<void> {
  const deleted = await adapter.deleteMsg(ref);
  if (deleted.status === "error") throw deleted.error;
}

export function createDiscordRelayPolicy(
  adapter: SurfaceAdapter,
  recovery?: SurfaceRelayRecovery<"discord">,
): SurfaceRelayPolicy<"discord"> {
  return {
    refs: {
      createSessionRef: discordSurfaceProtocol.refs.createSessionRef,
      resolveInitialReplyTarget: ({ requestId, sessionId }) =>
        resolveBuiltinSurfaceRequestMessageRef({
          protocol: discordSurfaceProtocol,
          requestId,
          sessionRef: discordSurfaceProtocol.refs.createSessionRef(sessionId),
        }),
      decodeReanchorTarget: discordSurfaceProtocol.refs.decodeMessageRef,
    },
    finalization: {
      cleanupSkippedOutput: async ({ ref }) =>
        adaptDiscordSkippedOutputCleanupResultToHost(adapter, ref),
    },
    ...(recovery ? { recovery } : {}),
  };
}

export function createDiscordSurfaceRuntimeDescriptor(input: {
  readonly adapter: SurfaceAdapter;
  readonly adapterIngress: SurfaceAdapterIngress<"discord">;
  readonly health?: SurfaceRuntimeHealthPort;
  readonly createRelay: (guardedAdapter: SurfaceAdapter) => SurfaceRelayDescriptor<"discord">;
}): SurfaceRuntimeDescriptor<"discord"> {
  return {
    protocol: discordSurfaceProtocol,
    adapter: input.adapter,
    adapterIngress: input.adapterIngress,
    ...(input.health ? { health: input.health } : {}),
    createRelay: input.createRelay,
    createWorkflowProgress: createDiscordWorkflowProgressPort,
  };
}
