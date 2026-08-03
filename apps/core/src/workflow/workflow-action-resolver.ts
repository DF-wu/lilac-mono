import { z } from "zod";
import {
  type DeliveryDisposition,
  type EventDeliveryDoneError,
  type EventDeliveryStartFailed,
  type EventDeliveryStopFailed,
  type EvtAdapterActionInvokedData,
  lilacEventTypes,
  type LilacBus,
} from "@stanley2058/lilac-event-bus";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { createLogger, formatTaggedErrorForLog } from "@stanley2058/lilac-utils";

import { DurableWorkflowStore, type WorkflowActionOutboxEntry } from "./durable-workflow-store";
import { sha256 } from "./workflow-definition";

const surfaceActionEventSchema = z.strictObject({
  actionId: z.string().min(16).max(200),
  platform: z.enum(["discord", "github"]),
  userId: z.string().min(1).max(200),
  messageRef: z.strictObject({
    platform: z.enum(["discord", "github"]),
    channelId: z.string().min(1).max(200),
    messageId: z.string().min(1).max(200),
  }),
  sourceMessageId: z.string().min(1).max(200).optional(),
  ts: z.number().int().nonnegative(),
});

const runChangedSchema = z.strictObject({
  runId: z.string(),
  revisionId: z.string(),
  state: z.enum(["queued", "running", "blocked", "paused", "succeeded", "failed", "cancelled"]),
  previousState: z
    .enum(["queued", "running", "blocked", "paused", "succeeded", "failed", "cancelled"])
    .optional(),
  ts: z.number(),
});
const progressRequestedSchema = z.strictObject({
  runId: z.string(),
  revisionId: z.string(),
  reason: z.enum(["created", "state_changed", "operation_changed", "usage_changed", "reconcile"]),
  ts: z.number(),
});

class WorkflowActionMalformed extends TaggedError("WorkflowActionMalformed")<{
  readonly eventId: string;
  readonly message: string;
}> {}

class WorkflowActionResolverStopping extends TaggedError("WorkflowActionResolverStopping")<{
  readonly message: string;
}> {}

class WorkflowActionOutboxInvalid extends TaggedError("WorkflowActionOutboxInvalid")<{
  readonly outboxId: string;
  readonly message: string;
}> {}

class WorkflowActionOutboxPublishFailed extends TaggedError("WorkflowActionOutboxPublishFailed")<{
  readonly outboxId: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

class WorkflowActionOutboxCompletionConflict extends TaggedError(
  "WorkflowActionOutboxCompletionConflict",
)<{
  readonly outboxId: string;
  readonly message: string;
}> {}

type WorkflowActionResolverDeliveryError = WorkflowActionMalformed | WorkflowActionResolverStopping;
type WorkflowActionOutboxFailure =
  | WorkflowActionOutboxInvalid
  | WorkflowActionOutboxPublishFailed
  | WorkflowActionOutboxCompletionConflict;
type DecodedWorkflowActionOutboxEvent =
  | {
      readonly type: typeof lilacEventTypes.EvtWorkflowRunChanged;
      readonly data: z.output<typeof runChangedSchema>;
    }
  | {
      readonly type: typeof lilacEventTypes.EvtWorkflowProgressRequested;
      readonly data: z.output<typeof progressRequestedSchema>;
    };
type WorkflowActionResolverSubscription = {
  readonly done: Promise<ResultType<void, EventDeliveryDoneError>>;
  stop(): Promise<ResultType<void, EventDeliveryStopFailed>>;
};

function workflowActionResolverDeliveryPolicy(
  error: WorkflowActionResolverDeliveryError,
): DeliveryDisposition {
  switch (error._tag) {
    case "WorkflowActionMalformed":
      return "commit";
    case "WorkflowActionResolverStopping":
      return "stop";
  }
}

function decodeWorkflowActionOutboxEvent(
  entry: WorkflowActionOutboxEntry,
): ResultType<DecodedWorkflowActionOutboxEvent, WorkflowActionOutboxInvalid> {
  switch (entry.eventType) {
    case lilacEventTypes.EvtWorkflowRunChanged: {
      const decoded = runChangedSchema.safeParse(entry.payload);
      if (!decoded.success) {
        return Result.err(
          new WorkflowActionOutboxInvalid({
            outboxId: entry.outboxId,
            message: "Workflow run-changed outbox payload is invalid",
          }),
        );
      }
      return Result.ok({ type: entry.eventType, data: decoded.data });
    }
    case lilacEventTypes.EvtWorkflowProgressRequested: {
      const decoded = progressRequestedSchema.safeParse(entry.payload);
      if (!decoded.success) {
        return Result.err(
          new WorkflowActionOutboxInvalid({
            outboxId: entry.outboxId,
            message: "Workflow progress-requested outbox payload is invalid",
          }),
        );
      }
      return Result.ok({ type: entry.eventType, data: decoded.data });
    }
    default:
      return Result.err(
        new WorkflowActionOutboxInvalid({
          outboxId: entry.outboxId,
          message: `Unsupported workflow action outbox event: ${entry.eventType}`,
        }),
      );
  }
}

function decodeWorkflowSurfaceAction(
  eventId: string,
  data: EvtAdapterActionInvokedData,
): ResultType<z.output<typeof surfaceActionEventSchema>, WorkflowActionMalformed> {
  const decoded = surfaceActionEventSchema.safeParse(data);
  if (!decoded.success || decoded.data.platform !== decoded.data.messageRef.platform) {
    return Result.err(
      new WorkflowActionMalformed({
        eventId,
        message: "Rejected malformed authenticated surface action event",
      }),
    );
  }
  return Result.ok(decoded.data);
}

async function captureWorkflowActionOutboxPublication(
  bus: LilacBus,
  outboxId: string,
  event: DecodedWorkflowActionOutboxEvent,
): Promise<ResultType<void, WorkflowActionOutboxPublishFailed>> {
  try {
    switch (event.type) {
      case lilacEventTypes.EvtWorkflowRunChanged:
        await bus.publish(event.type, event.data, { headers: { workflow_outbox_id: outboxId } });
        break;
      case lilacEventTypes.EvtWorkflowProgressRequested:
        await bus.publish(event.type, event.data, { headers: { workflow_outbox_id: outboxId } });
        break;
    }
    return Result.ok(undefined);
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(
      new WorkflowActionOutboxPublishFailed({
        outboxId,
        cause,
        message: "Workflow action outbox publication failed",
      }),
    );
  }
}

function adaptWorkflowActionSubscriptionStartResultToHost(
  started: ResultType<WorkflowActionResolverSubscription, EventDeliveryStartFailed>,
): WorkflowActionResolverSubscription {
  if (started.status === "error") throw started.error;
  return started.value;
}

function adaptWorkflowActionSubscriptionStopResultToHost(
  stopped: ResultType<void, EventDeliveryStopFailed>,
): void {
  if (stopped.status === "error") throw stopped.error;
}

export async function startWorkflowActionResolver(input: {
  bus: LilacBus;
  store: DurableWorkflowStore;
  subscriptionId: string;
  now?: () => number;
}): Promise<{ stop(): Promise<void> }> {
  const logger = createLogger({ module: "workflow-action-resolver" });
  let draining = false;
  let stopping = false;
  const drainOutbox = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      const now = input.now?.() ?? Date.now();
      const entries = input.store.listPendingActionOutboxEvents(now);
      for (const entry of entries) {
        const decoded = decodeWorkflowActionOutboxEvent(entry);
        const published: ResultType<
          void,
          WorkflowActionOutboxInvalid | WorkflowActionOutboxPublishFailed
        > =
          decoded.status === "error"
            ? Result.err(decoded.error)
            : await captureWorkflowActionOutboxPublication(
                input.bus,
                entry.outboxId,
                decoded.value,
              );
        let completed: ResultType<void, WorkflowActionOutboxFailure> = published;
        if (
          completed.status === "ok" &&
          !input.store.markActionOutboxPublished({
            outboxId: entry.outboxId,
            now: input.now?.() ?? Date.now(),
          })
        ) {
          completed = Result.err(
            new WorkflowActionOutboxCompletionConflict({
              outboxId: entry.outboxId,
              message: "Workflow action outbox publication was already completed",
            }),
          );
        }
        if (completed.status === "error") {
          input.store.recordActionOutboxFailure({
            outboxId: entry.outboxId,
            error: completed.error.message,
            now: input.now?.() ?? Date.now(),
          });
          logger.warn("Workflow action outbox publication failed", {
            outboxId: entry.outboxId,
            error: completed.error.message,
          });
        }
      }
    } finally {
      draining = false;
    }
  };
  async function startWorkflowActionSubscriptionResult(): Promise<
    ResultType<WorkflowActionResolverSubscription, EventDeliveryStartFailed>
  > {
    return input.bus.subscribeTopic(
      "evt.adapter",
      {
        mode: "fanout",
        subscriptionId: input.subscriptionId,
        consumerId: `${input.subscriptionId}:${process.pid}`,
        offset: { type: "now" },
        batch: { maxWaitMs: 1_000 },
      },
      async (message): Promise<ResultType<void, WorkflowActionResolverDeliveryError>> => {
        if (stopping) {
          return Result.err(
            new WorkflowActionResolverStopping({
              message: "Workflow action resolver is stopping",
            }),
          );
        }
        if (message.type !== lilacEventTypes.EvtAdapterActionInvoked) {
          await drainOutbox();
          return Result.ok(undefined);
        }
        const event = decodeWorkflowSurfaceAction(message.id, message.data);
        if (event.status === "error") {
          logger.warn("Rejected malformed authenticated surface action event", {
            eventId: message.id,
          });
          return Result.err(event.error);
        }

        const result = input.store.applySurfaceAction({
          tokenSha256: sha256(event.value.actionId),
          platform: event.value.platform,
          userId: event.value.userId,
          messageRef: event.value.messageRef,
          sourceMessageId: event.value.sourceMessageId,
          now: input.now?.() ?? Date.now(),
        });
        if (result.status !== "applied") {
          logger.info("Workflow surface action rejected", {
            status: result.status,
            platform: event.value.platform,
            messageId: event.value.messageRef.messageId,
          });
        }
        await drainOutbox();
        return Result.ok(undefined);
      },
      workflowActionResolverDeliveryPolicy,
    );
  }

  const subscription = adaptWorkflowActionSubscriptionStartResultToHost(
    await startWorkflowActionSubscriptionResult(),
  );
  async function stopWorkflowActionSubscriptionResult(): Promise<
    ResultType<void, EventDeliveryStopFailed>
  > {
    return subscription.stop();
  }
  void subscription.done.then((done) => {
    if (stopping) return;
    logger.error(
      "Workflow action resolver subscription terminated unexpectedly",
      done.status === "error"
        ? formatTaggedErrorForLog(done.error)
        : { error: "Subscription completed without being stopped" },
    );
  });

  await drainOutbox();
  const timer = setInterval(() => void drainOutbox(), 1_000);
  timer.unref?.();

  return {
    stop: async () => {
      stopping = true;
      clearInterval(timer);
      adaptWorkflowActionSubscriptionStopResultToHost(await stopWorkflowActionSubscriptionResult());
      const done = await subscription.done;
      if (done.status === "error" && done.error._tag !== "EventDeliveryStopped") {
        logger.error(
          "Workflow action resolver subscription terminated",
          formatTaggedErrorForLog(done.error),
        );
      }
    },
  };
}
