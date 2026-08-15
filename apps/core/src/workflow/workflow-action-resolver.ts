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
import { Result, TaggedError, type Result as ResultType } from "better-result";
import { createLogger, formatTaggedErrorForLog } from "@stanley2058/lilac-utils";

import { DurableWorkflowStore, type WorkflowActionOutboxEntry } from "./durable-workflow-store";
import { workflowConsumerId } from "./workflow-consumer-id";
import { sha256 } from "./workflow-definition";
import type { MsgRef } from "../surface/types";
import type {
  ResolvedSurfaceProtocol,
  SurfaceProtocolResolver,
} from "../surface/runtime-descriptor";
import type { SurfaceRefInvalid } from "../surface/protocol";
import { adaptToolResultToHost } from "../tools/tool-result-adapters";

const surfaceActionEventSchema = z.strictObject({
  actionId: z.string().min(16).max(200),
  platform: z.string().min(1).max(200),
  userId: z.string().min(1).max(200),
  messageRef: z.strictObject({
    platform: z.string().min(1).max(200),
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

class WorkflowActionPersistenceFailed extends TaggedError("WorkflowActionPersistenceFailed")<{
  readonly storeErrorTag: string;
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

type WorkflowActionResolverDeliveryError =
  | WorkflowActionMalformed
  | WorkflowActionPersistenceFailed
  | WorkflowActionResolverStopping;
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
    case "WorkflowActionPersistenceFailed":
      return "park-pending";
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
  surfaceProtocolResolver: SurfaceProtocolResolver | undefined,
): ResultType<
  Omit<z.output<typeof surfaceActionEventSchema>, "platform" | "messageRef"> & {
    readonly platform: ResolvedSurfaceProtocol["platform"];
    readonly messageRef: MsgRef;
  },
  WorkflowActionMalformed
> {
  const decoded = surfaceActionEventSchema.safeParse(data);
  const resolved = surfaceProtocolResolver?.resolve(data.platform) ?? null;
  const messageRef: ResultType<MsgRef, SurfaceRefInvalid> | null =
    resolved?.protocol.refs.decodeMessageRef({
      ref: data.messageRef,
      expectedSessionId: data.messageRef.channelId,
    }) ?? null;
  if (!decoded.success || !resolved || !messageRef) {
    return Result.err(
      new WorkflowActionMalformed({
        eventId,
        message: "Rejected malformed authenticated surface action event",
      }),
    );
  }
  return messageRef
    .map((value) => ({
      ...decoded.data,
      platform: resolved.platform,
      messageRef: value,
    }))
    .mapError(
      () =>
        new WorkflowActionMalformed({
          eventId,
          message: "Rejected malformed authenticated surface action event",
        }),
    );
}

async function captureWorkflowActionOutboxPublication(
  bus: LilacBus,
  outboxId: string,
  event: DecodedWorkflowActionOutboxEvent,
): Promise<ResultType<void, WorkflowActionOutboxPublishFailed>> {
  switch (event.type) {
    case lilacEventTypes.EvtWorkflowRunChanged: {
      const published = await bus.publish(event.type, event.data, {
        headers: { workflow_outbox_id: outboxId },
      });
      return published
        .map(() => undefined)
        .mapError(
          (cause) =>
            new WorkflowActionOutboxPublishFailed({
              outboxId,
              cause,
              message: "Workflow action outbox publication failed",
            }),
        );
    }
    case lilacEventTypes.EvtWorkflowProgressRequested: {
      const published = await bus.publish(event.type, event.data, {
        headers: { workflow_outbox_id: outboxId },
      });
      return published
        .map(() => undefined)
        .mapError(
          (cause) =>
            new WorkflowActionOutboxPublishFailed({
              outboxId,
              cause,
              message: "Workflow action outbox publication failed",
            }),
        );
    }
  }
}

function adaptWorkflowActionSubscriptionStartResultToHost(
  started: ResultType<WorkflowActionResolverSubscription, EventDeliveryStartFailed>,
): WorkflowActionResolverSubscription {
  return adaptToolResultToHost(started);
}

function adaptWorkflowActionSubscriptionStopResultToHost(
  stopped: ResultType<void, EventDeliveryStopFailed>,
): void {
  adaptToolResultToHost(stopped);
}

export async function startWorkflowActionResolver(input: {
  bus: LilacBus;
  store: DurableWorkflowStore;
  subscriptionId: string;
  surfaceProtocolResolver?: SurfaceProtocolResolver;
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
      const pendingEntries = entries.match({
        ok: (value) => value,
        err: (error) => {
          logger.warn("Workflow action outbox read failed", formatTaggedErrorForLog(error));
          return null;
        },
      });
      if (!pendingEntries) return;
      for (const entry of pendingEntries) {
        const decoded = decodeWorkflowActionOutboxEvent(entry);
        const published: ResultType<
          void,
          WorkflowActionOutboxInvalid | WorkflowActionOutboxPublishFailed
        > = await decoded.match<
          Promise<ResultType<void, WorkflowActionOutboxInvalid | WorkflowActionOutboxPublishFailed>>
        >({
          ok: (event) => captureWorkflowActionOutboxPublication(input.bus, entry.outboxId, event),
          err: (error) => Promise.resolve(Result.err(error)),
        });
        const completed: ResultType<void, WorkflowActionOutboxFailure> = published.andThen(() =>
          input.store.markActionOutboxPublished({
            outboxId: entry.outboxId,
            now: input.now?.() ?? Date.now(),
          })
            ? Result.ok(undefined)
            : Result.err(
                new WorkflowActionOutboxCompletionConflict({
                  outboxId: entry.outboxId,
                  message: "Workflow action outbox publication was already completed",
                }),
              ),
        );
        completed.match({
          ok: () => undefined,
          err: (error) => {
            input.store.recordActionOutboxFailure({
              outboxId: entry.outboxId,
              error: error.message,
              now: input.now?.() ?? Date.now(),
            });
            logger.warn("Workflow action outbox publication failed", {
              outboxId: entry.outboxId,
              ...formatTaggedErrorForLog(error),
            });
          },
        });
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
        consumerId: workflowConsumerId(input.subscriptionId),
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
        const handled = Result.gen(function* () {
          const event = yield* decodeWorkflowSurfaceAction(
            message.id,
            message.data,
            input.surfaceProtocolResolver,
          ).mapError((error) => {
            logger.warn("Rejected malformed authenticated surface action event", {
              eventId: message.id,
            });
            return error;
          });
          const action = yield* input.store
            .applySurfaceAction({
              tokenSha256: sha256(event.actionId),
              platform: event.platform,
              userId: event.userId,
              messageRef: event.messageRef,
              sourceMessageId: event.sourceMessageId,
              now: input.now?.() ?? Date.now(),
            })
            .mapError((error) => {
              logger.warn("Workflow surface action persistence failed", {
                eventId: message.id,
                ...formatTaggedErrorForLog(error),
              });
              return new WorkflowActionPersistenceFailed({
                storeErrorTag: error._tag,
                message: "Workflow surface action could not be persisted",
              });
            });
          return Result.ok({ action, event });
        });
        return handled.match<Promise<ResultType<void, WorkflowActionResolverDeliveryError>>>({
          err: (error) => Promise.resolve(Result.err(error)),
          ok: async ({ action, event }) => {
            if (action.status !== "applied") {
              logger.info("Workflow surface action rejected", {
                status: action.status,
                platform: event.platform,
                messageId: event.messageRef.messageId,
              });
            }
            await drainOutbox();
            return Result.ok(undefined);
          },
        });
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
    done.match({
      ok: () =>
        logger.error("Workflow action resolver subscription terminated unexpectedly", {
          error: "Subscription completed without being stopped",
        }),
      err: (error) =>
        logger.error(
          "Workflow action resolver subscription terminated unexpectedly",
          formatTaggedErrorForLog(error),
        ),
    });
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
      done.match({
        ok: () => undefined,
        err: (error) => {
          if (error._tag !== "EventDeliveryStopped") {
            logger.error(
              "Workflow action resolver subscription terminated",
              formatTaggedErrorForLog(error),
            );
          }
        },
      });
    },
  };
}
