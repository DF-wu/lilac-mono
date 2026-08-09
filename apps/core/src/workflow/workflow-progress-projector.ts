import {
  type DeliveryDisposition,
  type EventDeliveryDoneError,
  type EventDeliveryStartFailed,
  type EventDeliveryStopFailed,
  lilacEventTypes,
  type LilacBus,
} from "@stanley2058/lilac-event-bus";
import { Result, TaggedError, type Panic, type Result as ResultType } from "better-result";
import { createLogger, formatTaggedErrorForLog, isPanic } from "@stanley2058/lilac-utils";

import type { ContentOpts, MsgRef } from "../surface/types";
import type {
  RegisteredSurfacePlatform,
  RegisteredSurfaceWorkflowProgressPort,
} from "../surface/runtime-descriptor";
import { adaptToolResultToHost } from "../tools/tool-result-adapters";
import {
  DurableWorkflowStore,
  signalDurableWorkflowReadErrorToHost,
} from "./durable-workflow-store";
import { sha256 } from "./workflow-definition";
import type { WorkflowSurfaceActionKind, WorkflowSurfaceBinding } from "./workflow-domain";
import { formatWorkflowErrorForLog } from "./workflow-error-log";
import {
  buildWorkflowProgressViewResult,
  renderWorkflowProgressView,
  toSurfaceActions,
  type WorkflowProgressView,
} from "./workflow-progress-view";

export interface WorkflowProgressCardService {
  ensureInitialCard(runId: string): Promise<MsgRef>;
  requestProjection(runId: string): void;
}

type CachedActions = {
  key: string;
  ids: Map<WorkflowSurfaceActionKind, string>;
  recordIds: string[];
  expiresAt: number;
};

class WorkflowProgressProjectorStopping extends TaggedError("WorkflowProgressProjectorStopping")<{
  readonly message: string;
}> {}

class WorkflowProgressProjectionFailed extends TaggedError("WorkflowProgressProjectionFailed")<{
  readonly message: string;
}> {}

type WorkflowProgressSurfaceCallFailureFields =
  | { readonly failureKind: "created"; readonly createdRef: MsgRef; readonly message: string }
  | { readonly failureKind: "not-found"; readonly createdRef: null; readonly message: string }
  | {
      readonly failureKind: "failed";
      readonly createdRef: null;
      readonly message: string;
    };

export class WorkflowProgressSurfaceCreated extends TaggedError("WorkflowProgressSurfaceCreated")<
  Extract<WorkflowProgressSurfaceCallFailureFields, { failureKind: "created" }>
> {}

export class WorkflowProgressSurfaceNotFound extends TaggedError("WorkflowProgressSurfaceNotFound")<
  Extract<WorkflowProgressSurfaceCallFailureFields, { failureKind: "not-found" }>
> {}

export class WorkflowProgressSurfaceCallFailed extends TaggedError(
  "WorkflowProgressSurfaceCallFailed",
)<Extract<WorkflowProgressSurfaceCallFailureFields, { failureKind: "failed" }>> {}

type WorkflowProgressSurfaceFailure =
  | WorkflowProgressSurfaceCreated
  | WorkflowProgressSurfaceNotFound
  | WorkflowProgressSurfaceCallFailed;

type WorkflowProgressProjectionError =
  | WorkflowProgressProjectionFailed
  | WorkflowProgressSurfaceFailure;

type WorkflowProgressProjectionResult<T> = ResultType<T, WorkflowProgressProjectionError>;

type WorkflowProgressPortRegistration = {
  readonly platform: RegisteredSurfacePlatform;
  readonly port: RegisteredSurfaceWorkflowProgressPort;
};

function workflowProgressProjectionFailure(message: string): WorkflowProgressProjectionFailed {
  return new WorkflowProgressProjectionFailed({ message });
}

function workflowProgressSurfaceCallFailure(
  input: WorkflowProgressSurfaceCallFailureFields,
): WorkflowProgressSurfaceFailure {
  switch (input.failureKind) {
    case "created":
      return new WorkflowProgressSurfaceCreated(input);
    case "not-found":
      return new WorkflowProgressSurfaceNotFound(input);
    case "failed":
      return new WorkflowProgressSurfaceCallFailed(input);
  }
}

function findWorkflowProgressPort(
  ports: ReadonlyMap<RegisteredSurfacePlatform, RegisteredSurfaceWorkflowProgressPort>,
  platform: string,
): WorkflowProgressPortRegistration | undefined {
  for (const [registeredPlatform, port] of ports) {
    if (registeredPlatform === platform) return { platform: registeredPlatform, port };
  }
  return undefined;
}

function adaptWorkflowProgressProjectionResultToHost<T>(
  result: WorkflowProgressProjectionResult<T>,
): T {
  return adaptToolResultToHost(result);
}

type WorkflowProgressProjectorSubscription = {
  readonly done: Promise<ResultType<void, EventDeliveryDoneError>>;
  stop(): Promise<ResultType<void, EventDeliveryStopFailed>>;
};

function workflowProgressProjectorDeliveryPolicy(
  error: WorkflowProgressProjectorStopping,
): DeliveryDisposition {
  switch (error._tag) {
    case "WorkflowProgressProjectorStopping":
      return "stop";
  }
}

function adaptWorkflowProgressSubscriptionStartResultToHost(
  started: ResultType<WorkflowProgressProjectorSubscription, EventDeliveryStartFailed>,
): WorkflowProgressProjectorSubscription {
  if (started.status === "error") throw started.error;
  return started.value;
}

function adaptWorkflowProgressSubscriptionStopResultToHost(
  stopped: ResultType<void, EventDeliveryStopFailed>,
): void {
  if (stopped.status === "error") throw stopped.error;
}

const WORKFLOW_CARD_TEXT_LIMIT = 4_000;

function correlateWorkflowProgressMessageRef(input: {
  readonly runTargetPlatform: RegisteredSurfacePlatform;
  readonly bindingTargetPlatform: string;
  readonly messageRef: {
    readonly platform: string;
    readonly channelId: string;
    readonly messageId: string;
  };
}): { readonly kind: "correlated"; readonly ref: MsgRef } | { readonly kind: "mismatch" } {
  if (input.bindingTargetPlatform !== input.runTargetPlatform) {
    return { kind: "mismatch" };
  }
  if (input.messageRef.platform !== input.runTargetPlatform) {
    return { kind: "mismatch" };
  }
  // The equality checks establish the discriminant correlation that TypeScript cannot infer.
  return { kind: "correlated", ref: input.messageRef as MsgRef };
}

function limitContentText(content: ContentOpts): ContentOpts {
  return content.text && content.text.length > WORKFLOW_CARD_TEXT_LIMIT
    ? { ...content, text: content.text.slice(0, WORKFLOW_CARD_TEXT_LIMIT) }
    : content;
}

function retryAt(now: number, retryCount: number): number {
  return now + Math.min(300_000, 1_000 * 2 ** Math.min(retryCount - 1, 8));
}

export class WorkflowProgressProjector implements WorkflowProgressCardService {
  private readonly logger = createLogger({ module: "workflow-progress-projector" });
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastEditAt = new Map<string, number>();
  private readonly actions = new Map<string, CachedActions>();
  private readonly actionRotationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly projectionInFlight = new Map<
    string,
    Promise<WorkflowProgressProjectionResult<MsgRef | null>>
  >();
  private subscription: WorkflowProgressProjectorSubscription | null = null;
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private actionOutboxDrain: Promise<void> | null = null;
  private readonly reportedFatalPanics = new WeakSet<Panic>();
  private stopping = false;

  constructor(
    private readonly input: {
      bus: LilacBus;
      store: DurableWorkflowStore;
      ports: ReadonlyMap<RegisteredSurfacePlatform, RegisteredSurfaceWorkflowProgressPort>;
      subscriptionId: string;
      now?: () => number;
      coalesceMs?: number;
      minEditIntervalMs?: number;
      retryIntervalMs?: number;
      reportFatalPanic: (panic: Panic) => void;
    },
  ) {}

  private superviseDetached(effect: () => Promise<void>, event: string): void {
    const operation = Promise.resolve().then(effect);
    void Promise.allSettled([operation]).then(([settled]) => {
      if (settled.status !== "rejected") return;
      if (isPanic(settled.reason)) {
        if (this.reportedFatalPanics.has(settled.reason)) return;
        this.reportedFatalPanics.add(settled.reason);
        this.input.reportFatalPanic(settled.reason);
        return;
      }
      const error =
        settled.reason instanceof Error
          ? settled.reason
          : new Error("Opaque detached workflow progress failure");
      this.logger.error(event, formatWorkflowErrorForLog(error));
    });
  }

  private startWorkflowProgressSubscriptionResult(): Promise<
    ResultType<WorkflowProgressProjectorSubscription, EventDeliveryStartFailed>
  > {
    return this.input.bus.subscribeTopic(
      "evt.workflow",
      {
        mode: "fanout",
        subscriptionId: this.input.subscriptionId,
        consumerId: `${this.input.subscriptionId}:${process.pid}`,
        offset: { type: "now" },
        batch: { maxWaitMs: 1_000 },
      },
      async (message): Promise<ResultType<void, WorkflowProgressProjectorStopping>> => {
        if (this.stopping) {
          return Result.err(
            new WorkflowProgressProjectorStopping({
              message: "Workflow progress projector is stopping",
            }),
          );
        }
        if (
          message.type === lilacEventTypes.EvtWorkflowRunChanged ||
          message.type === lilacEventTypes.EvtWorkflowOperationChanged ||
          message.type === lilacEventTypes.EvtWorkflowProgressRequested ||
          message.type === lilacEventTypes.EvtWorkflowUsageChanged ||
          message.type === lilacEventTypes.EvtWorkflowResultReady
        ) {
          this.requestProjection(message.data.runId);
        }
        return Result.ok(undefined);
      },
      workflowProgressProjectorDeliveryPolicy,
    );
  }

  private stopWorkflowProgressSubscriptionResult(
    subscription: WorkflowProgressProjectorSubscription,
  ): Promise<ResultType<void, EventDeliveryStopFailed>> {
    return subscription.stop();
  }

  async start(): Promise<void> {
    this.stopping = false;
    const subscription = adaptWorkflowProgressSubscriptionStartResultToHost(
      await this.startWorkflowProgressSubscriptionResult(),
    );
    this.subscription = subscription;
    this.superviseDetached(async () => {
      const done = await subscription.done;
      if (this.stopping) return;
      this.logger.error(
        "Workflow progress projector subscription terminated unexpectedly",
        done.status === "error"
          ? formatTaggedErrorForLog(done.error)
          : { error: "Subscription completed without being stopped" },
      );
    }, "Workflow progress projector subscription observer failed");

    await this.drainActionOutboxProjections();
    await this.reconcile();
    this.retryTimer = setInterval(() => {
      this.superviseDetached(async () => {
        this.retryDue();
        await this.drainActionOutboxProjections();
      }, "Workflow progress retry cycle failed");
    }, this.input.retryIntervalMs ?? 1_000);
    this.retryTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const timer of this.actionRotationTimers.values()) clearTimeout(timer);
    this.timers.clear();
    this.actionRotationTimers.clear();
    const subscription = this.subscription;
    this.subscription = null;
    if (subscription) {
      adaptWorkflowProgressSubscriptionStopResultToHost(
        await this.stopWorkflowProgressSubscriptionResult(subscription),
      );
      const done = await subscription.done;
      if (done.status === "error" && done.error._tag !== "EventDeliveryStopped") {
        this.logger.error(
          "Workflow progress projector subscription terminated",
          formatTaggedErrorForLog(done.error),
        );
      }
    }
    await this.actionOutboxDrain;
    while (this.projectionInFlight.size > 0) {
      await Promise.allSettled(this.projectionInFlight.values());
    }
  }

  requestProjection(runId: string): void {
    if (this.stopping || this.timers.has(runId)) return;
    const now = this.input.now?.() ?? Date.now();
    const last = this.lastEditAt.get(runId) ?? 0;
    const delay = Math.max(
      this.input.coalesceMs ?? 250,
      last + (this.input.minEditIntervalMs ?? 1_000) - now,
    );
    const timer = setTimeout(
      () => {
        this.timers.delete(runId);
        this.superviseDetached(async () => {
          const projected = await this.project(runId);
          if (projected.status === "ok") return;
          this.logger.warn("Workflow projection failed", {
            runId,
            ...formatTaggedErrorForLog(projected.error),
          });
        }, "Workflow projection timer failed");
      },
      Math.max(0, delay),
    );
    timer.unref?.();
    this.timers.set(runId, timer);
  }

  async ensureInitialCard(runId: string): Promise<MsgRef> {
    const messageRef = adaptWorkflowProgressProjectionResultToHost(await this.project(runId, true));
    if (!messageRef) {
      return adaptWorkflowProgressProjectionResultToHost(
        Result.err(
          workflowProgressProjectionFailure(
            `Workflow run ${runId} has no supported durable progress target`,
          ),
        ),
      );
    }
    return messageRef;
  }

  async reconcile(): Promise<void> {
    const runs = this.input.store.listRunsNeedingProjectionReconciliation(1_000);
    if (runs.status === "error") signalDurableWorkflowReadErrorToHost(runs.error);
    for (const run of runs.value) {
      const projected = await this.project(run.runId, false, true);
      if (projected.status === "error") {
        this.logger.warn("Workflow startup projection reconciliation failed", {
          runId: run.runId,
          ...formatTaggedErrorForLog(projected.error),
        });
      }
    }
  }

  private retryDue(): void {
    const now = this.input.now?.() ?? Date.now();
    const bindings = this.input.store.listSurfaceBindings({ dueBefore: now, limit: 1_000 });
    if (bindings.status === "error") {
      this.logger.warn(
        "Workflow projection retry read failed",
        formatTaggedErrorForLog(bindings.error),
      );
      return;
    }
    for (const binding of bindings.value) {
      this.requestProjection(binding.runId);
    }
  }

  private async drainActionOutboxProjections(): Promise<void> {
    if (this.actionOutboxDrain) return await this.actionOutboxDrain;
    const drain = this.drainPendingActionOutboxProjections();
    this.actionOutboxDrain = drain;
    try {
      await drain;
    } finally {
      if (this.actionOutboxDrain === drain) this.actionOutboxDrain = null;
    }
  }

  private async drainPendingActionOutboxProjections(): Promise<void> {
    const entries = this.input.store.listPendingActionOutboxProjections();
    if (entries.status === "error") {
      this.logger.warn(
        "Workflow action outbox projection read failed",
        formatTaggedErrorForLog(entries.error),
      );
      return;
    }
    for (const entry of entries.value) {
      const projected = await this.project(entry.runId);
      if (projected.status === "error") {
        this.logger.warn("Workflow action outbox projection failed", {
          outboxId: entry.outboxId,
          runId: entry.runId,
          ...formatTaggedErrorForLog(projected.error),
        });
        continue;
      }
      if (
        !this.input.store.markActionOutboxProjected({
          outboxId: entry.outboxId,
          now: this.input.now?.() ?? Date.now(),
        })
      ) {
        this.logger.warn("Workflow action outbox projection was already completed", {
          outboxId: entry.outboxId,
          runId: entry.runId,
        });
      }
    }
  }

  private async project(
    runId: string,
    requireMessage = false,
    verifyExisting = false,
  ): Promise<WorkflowProgressProjectionResult<MsgRef | null>> {
    const previous = this.projectionInFlight.get(runId);
    let projection: Promise<WorkflowProgressProjectionResult<MsgRef | null>>;
    projection = (async () => {
      if (previous) await previous;
      return await this.projectRun(runId, requireMessage, verifyExisting);
    })();
    this.projectionInFlight.set(runId, projection);
    try {
      return await projection;
    } finally {
      if (this.projectionInFlight.get(runId) === projection) {
        this.projectionInFlight.delete(runId);
      }
    }
  }

  private issueActions(
    runId: string,
    view: WorkflowProgressView,
    messageRef: MsgRef | null,
    now: number,
  ): CachedActions {
    const expectedUserId = view.run.origin.userId;
    const expectedPlatform = view.run.origin.client;
    const key = `${view.run.state}:${expectedPlatform}:${expectedUserId}:${view.availableActions.join(",")}`;
    const cached = this.actions.get(runId);
    if (cached?.key === key && cached.expiresAt > now + 60_000) return cached;

    this.input.store.expireActiveSurfaceActions(runId, now);
    const ids = new Map<WorkflowSurfaceActionKind, string>();
    const recordIds: string[] = [];
    const expiresAt = now + 86_400_000;
    if (
      expectedUserId &&
      expectedPlatform &&
      findWorkflowProgressPort(this.input.ports, expectedPlatform) !== undefined &&
      expectedPlatform === view.run.progressTarget?.platform
    ) {
      for (const kind of view.availableActions) {
        const token = crypto.randomUUID();
        const actionId = `wfaction:${crypto.randomUUID()}`;
        if (
          !this.input.store.createSurfaceAction({
            actionId,
            tokenSha256: sha256(token),
            runId,
            kind,
            expectedPlatform,
            expectedUserId,
            expectedMessageRef: messageRef,
            expiresAt: now + 86_400_000,
            consumedAt: null,
            consumedByPlatform: null,
            consumedByUserId: null,
            createdAt: now,
          })
        ) {
          continue;
        }
        ids.set(kind, token);
        recordIds.push(actionId);
      }
    }
    const next = { key, ids, recordIds, expiresAt };
    this.actions.set(runId, next);
    return next;
  }

  private writeFailure(
    binding: WorkflowSurfaceBinding,
    message: string,
    now: number,
    overrides?: Partial<Pick<typeof binding, "messageRef" | "lastRenderedSha256">>,
  ): void {
    const retryCount = binding.retryCount + 1;
    this.input.store.upsertSurfaceBinding({
      ...binding,
      ...overrides,
      lastError: message,
      retryCount,
      nextAttemptAt: retryAt(now, retryCount),
      updatedAt: now,
    });
  }

  private scheduleActionRotation(runId: string, issued: CachedActions, now: number): void {
    const prior = this.actionRotationTimers.get(runId);
    if (prior) clearTimeout(prior);
    this.actionRotationTimers.delete(runId);
    if (issued.recordIds.length === 0) return;
    const timer = setTimeout(
      () => {
        this.actionRotationTimers.delete(runId);
        this.superviseDetached(async () => {
          this.requestProjection(runId);
        }, "Workflow action rotation timer failed");
      },
      Math.max(1_000, issued.expiresAt - now - 60_000),
    );
    timer.unref?.();
    this.actionRotationTimers.set(runId, timer);
  }

  private async projectRun(
    runId: string,
    requireMessage: boolean,
    verifyExisting: boolean,
  ): Promise<WorkflowProgressProjectionResult<MsgRef | null>> {
    const runResult = this.input.store.getRun(runId);
    if (runResult.status === "error") {
      return Result.err(workflowProgressProjectionFailure(runResult.error.message));
    }
    const run = runResult.value;
    if (run?.progressTarget === null) {
      if (requireMessage) {
        return Result.err(
          workflowProgressProjectionFailure(
            `Workflow run ${runId} has no supported durable progress target`,
          ),
        );
      }
      return Result.ok(null);
    }

    const now = this.input.now?.() ?? Date.now();
    const viewResult = await buildWorkflowProgressViewResult({
      store: this.input.store,
      runId,
      now,
    });
    if (viewResult.status === "error") {
      return Result.err(workflowProgressProjectionFailure(viewResult.error.message));
    }
    const view = viewResult.value;
    const target = view.run.progressTarget;
    if (!target) {
      return Result.err(
        workflowProgressProjectionFailure(
          `Workflow run ${runId} has no supported durable progress target`,
        ),
      );
    }
    const registration = findWorkflowProgressPort(this.input.ports, target.platform);
    if (!registration) {
      return Result.err(
        workflowProgressProjectionFailure(
          `Workflow run ${runId} has no supported durable progress target`,
        ),
      );
    }
    const { platform, port } = registration;
    const existingResult = this.input.store.getSurfaceBinding(runId);
    if (existingResult.status === "error") {
      return Result.err(workflowProgressProjectionFailure(existingResult.error.message));
    }
    let existing: WorkflowSurfaceBinding | null = existingResult.value;
    let messageRef: MsgRef | null = null;
    if (existing?.messageRef) {
      const correlated = correlateWorkflowProgressMessageRef({
        runTargetPlatform: platform,
        bindingTargetPlatform: existing.target.platform,
        messageRef: existing.messageRef,
      });
      switch (correlated.kind) {
        case "correlated":
          messageRef = correlated.ref;
          break;
        case "mismatch":
          existing = {
            ...existing,
            target,
            messageRef: null,
            lastRenderedSha256: null,
            lastError: null,
            retryCount: 0,
            nextAttemptAt: null,
            updatedAt: now,
          };
          this.input.store.upsertSurfaceBinding(existing);
          break;
      }
    }
    if (!existing) {
      existing = {
        runId,
        target,
        messageRef: null,
        lastRenderedSha256: null,
        lastError: null,
        retryCount: 0,
        nextAttemptAt: null,
        createdAt: now,
        updatedAt: now,
      };
      this.input.store.upsertSurfaceBinding(existing);
    }
    if (
      messageRef &&
      (verifyExisting || (existing.nextAttemptAt !== null && existing.nextAttemptAt <= now))
    ) {
      const checked = await port.checkMessage({
        channelId: messageRef.channelId,
        messageId: messageRef.messageId,
      });
      let found: boolean;
      switch (checked.status) {
        case "error": {
          switch (checked.error.kind) {
            case "failed": {
              const error = workflowProgressSurfaceCallFailure({
                failureKind: "failed",
                createdRef: null,
                message: checked.error.error.message,
              });
              this.writeFailure(existing, error.message, now);
              return Result.err(error);
            }
          }
        }
        case "ok":
          switch (checked.value) {
            case "found":
              found = true;
              break;
            case "missing":
              found = false;
              break;
          }
          break;
      }
      existing = {
        ...existing,
        messageRef: found ? existing.messageRef : null,
        lastRenderedSha256: found ? existing.lastRenderedSha256 : null,
        lastError: null,
        retryCount: 0,
        nextAttemptAt: null,
        updatedAt: now,
      };
      this.input.store.upsertSurfaceBinding(existing);
      if (!found) messageRef = null;
    }

    const issued = this.issueActions(runId, view, messageRef, now);
    const content = limitContentText(
      renderWorkflowProgressView({
        view,
        platform,
        actions: toSurfaceActions({ view, actionIds: issued.ids }),
      }),
    );
    const renderedSha256 = sha256(
      JSON.stringify({
        text: content.text,
        actions: content.actions,
        revision: view.revision.sourceSha256,
      }),
    );
    if (messageRef && existing.lastRenderedSha256 === renderedSha256) {
      return Result.ok(messageRef);
    }

    let projected: ResultType<MsgRef, WorkflowProgressSurfaceFailure>;
    if (messageRef) {
      const edited = await port.edit(
        { channelId: messageRef.channelId, messageId: messageRef.messageId },
        content,
      );
      switch (edited.status) {
        case "ok":
          projected = Result.ok(messageRef);
          break;
        case "error":
          switch (edited.error.kind) {
            case "not-found":
              projected = Result.err(
                workflowProgressSurfaceCallFailure({
                  failureKind: "not-found",
                  createdRef: null,
                  message: "Workflow progress message was not found",
                }),
              );
              break;
            case "failed":
              projected = Result.err(
                workflowProgressSurfaceCallFailure({
                  failureKind: "failed",
                  createdRef: null,
                  message: edited.error.error.message,
                }),
              );
              break;
          }
          break;
      }
    } else {
      const sent = await port.send({
        channelId: target.channelId,
        content,
        ...(target.replyToMessageId ? { replyToMessageId: target.replyToMessageId } : {}),
        silent: true,
      });
      switch (sent.status) {
        case "ok":
          projected = Result.ok(sent.value);
          break;
        case "error":
          switch (sent.error.kind) {
            case "created":
              projected = Result.err(
                workflowProgressSurfaceCallFailure({
                  failureKind: "created",
                  createdRef: sent.error.ref,
                  message: "Workflow progress message was created but could not be fully rendered",
                }),
              );
              break;
            case "failed":
              projected = Result.err(
                workflowProgressSurfaceCallFailure({
                  failureKind: "failed",
                  createdRef: null,
                  message: sent.error.error.message,
                }),
              );
              break;
          }
          break;
      }
    }
    let error: WorkflowProgressSurfaceFailure;
    switch (projected.status) {
      case "ok": {
        const projectedRef = projected.value;
        this.input.store.commitSurfaceProjection({
          binding: {
            ...existing,
            target,
            messageRef: projectedRef,
            lastRenderedSha256: renderedSha256,
            lastError: null,
            retryCount: 0,
            nextAttemptAt: null,
            updatedAt: now,
          },
          actionIds: issued.recordIds,
        });
        this.lastEditAt.set(runId, now);
        this.scheduleActionRotation(runId, issued, now);
        return Result.ok(projectedRef);
      }
      case "error":
        error = projected.error;
        break;
    }
    switch (error._tag) {
      case "WorkflowProgressSurfaceCreated":
        this.writeFailure(existing, error.message, now, {
          messageRef: error.createdRef,
          lastRenderedSha256: existing.lastRenderedSha256,
        });
        if (requireMessage) return Result.ok(error.createdRef);
        return Result.err(error);
      case "WorkflowProgressSurfaceNotFound":
        this.writeFailure(existing, error.message, now, {
          messageRef: null,
          lastRenderedSha256: null,
        });
        break;
      case "WorkflowProgressSurfaceCallFailed":
        this.writeFailure(existing, error.message, now, {
          messageRef,
          lastRenderedSha256: existing.lastRenderedSha256,
        });
        break;
    }
    if (requireMessage)
      return Result.err(
        workflowProgressProjectionFailure(
          `Workflow run ${runId} was persisted, but its initial progress card could not be created: ${error.message}`,
        ),
      );
    return Result.err(error);
  }
}
