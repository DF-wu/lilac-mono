import { Result } from "better-result";

import type { SurfaceAdapter, SurfaceOperationError } from "../adapter";
import { resolveBuiltinSurfaceRequestMessageRef } from "../builtin-surface-protocols";
import type {
  SurfaceAdapterIngress,
  SurfaceRelayDescriptor,
  SurfaceRelayPolicy,
  SurfaceRuntimeDescriptor,
  SurfaceRuntimeHealthPort,
  SurfaceWorkflowProgressPort,
  WorkflowProgressOperationFailed,
} from "../runtime-descriptor";
import { workflowProgressOperationFailure } from "../runtime-descriptor";
import { telegramSurfaceProtocol } from "./telegram-surface-protocol";

type TelegramWorkflowProgressOperation = "check-message" | "send" | "edit";
type TelegramCheckMessageResult = Awaited<
  ReturnType<SurfaceWorkflowProgressPort<"telegram">["checkMessage"]>
>;
type TelegramSendResult = Awaited<ReturnType<SurfaceWorkflowProgressPort<"telegram">["send"]>>;
type TelegramEditResult = Awaited<ReturnType<SurfaceWorkflowProgressPort<"telegram">["edit"]>>;

export const TELEGRAM_WORKFLOW_PROGRESS_CONFIGURATION_REVISION = "telegram-workflow-progress-v1";

function telegramWorkflowError(
  operation: TelegramWorkflowProgressOperation,
  error: SurfaceOperationError,
): { readonly kind: "failed"; readonly error: WorkflowProgressOperationFailed } {
  return { kind: "failed", error: workflowProgressOperationFailure(operation, error) };
}

export function createTelegramRelayPolicy(): SurfaceRelayPolicy<"telegram"> {
  return {
    refs: {
      createSessionRef: telegramSurfaceProtocol.refs.createSessionRef,
      resolveInitialReplyTarget: ({ requestId, sessionId }) =>
        resolveBuiltinSurfaceRequestMessageRef({
          protocol: telegramSurfaceProtocol,
          requestId,
          sessionRef: telegramSurfaceProtocol.refs.createSessionRef(sessionId),
        }),
      decodeReanchorTarget: telegramSurfaceProtocol.refs.decodeMessageRef,
    },
  };
}

export function createTelegramWorkflowProgressPort(
  adapter: SurfaceAdapter,
): SurfaceWorkflowProgressPort<"telegram"> {
  return {
    configurationRevision: TELEGRAM_WORKFLOW_PROGRESS_CONFIGURATION_REVISION,
    checkMessage: async (target) => {
      const checked = await adapter.readMsg({ platform: "telegram", ...target });
      return checked.match<TelegramCheckMessageResult>({
        err: (error) =>
          error._tag === "SurfaceMessageNotFound"
            ? Result.ok("missing" as const)
            : Result.err(telegramWorkflowError("check-message", error)),
        ok: (value) => Result.ok(value ? ("found" as const) : ("missing" as const)),
      });
    },
    send: async (input) => {
      const sent = await adapter.sendMsg(
        { platform: "telegram", channelId: input.channelId },
        input.content,
        input.replyToMessageId
          ? {
              replyTo: {
                platform: "telegram",
                channelId: input.channelId,
                messageId: input.replyToMessageId,
              },
              silent: input.silent,
            }
          : { silent: input.silent },
      );
      return sent.match<TelegramSendResult>({
        err: (error) => {
          if (
            error._tag === "SurfaceOperationPartiallyCompleted" &&
            error.created.platform === "telegram"
          ) {
            return Result.err({ kind: "created" as const, ref: error.created });
          }
          return Result.err(telegramWorkflowError("send", error));
        },
        ok: (value) =>
          Result.ok({
            platform: "telegram" as const,
            channelId: value.channelId,
            messageId: value.messageId,
          }),
      });
    },
    edit: async (target, content) => {
      const edited = await adapter.editMsg({ platform: "telegram", ...target }, content);
      return edited.match<TelegramEditResult>({
        ok: () => Result.ok(undefined),
        err: (error) =>
          error._tag === "SurfaceMessageNotFound"
            ? Result.err({ kind: "not-found" as const })
            : Result.err(telegramWorkflowError("edit", error)),
      });
    },
  };
}

export function createTelegramSurfaceRuntimeDescriptor(input: {
  readonly adapter: SurfaceAdapter;
  readonly adapterIngress: SurfaceAdapterIngress<"telegram">;
  readonly health: SurfaceRuntimeHealthPort;
  readonly createRelay: (guardedAdapter: SurfaceAdapter) => SurfaceRelayDescriptor<"telegram">;
}): SurfaceRuntimeDescriptor<"telegram"> {
  return {
    protocol: telegramSurfaceProtocol,
    adapter: input.adapter,
    adapterIngress: input.adapterIngress,
    health: input.health,
    createRelay: input.createRelay,
    createWorkflowProgress: createTelegramWorkflowProgressPort,
  };
}
