import {
  type DeliveryDisposition,
  type EventDeliveryDoneError,
  type EventDeliveryStartFailed,
  type EventDeliveryStopFailed,
  lilacEventTypes,
  type EvtAdapterMessageCreatedData,
  type LilacBus,
} from "@stanley2058/lilac-event-bus";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import { createLogger, formatTaggedErrorForLog } from "@stanley2058/lilac-utils";

import { DurableWorkflowStore } from "./durable-workflow-store";
import type { WorkflowWait } from "./workflow-domain";
import { matchWorkflowReplyWait, workflowReplyMatchKey } from "./workflow-waits";

const WORKFLOW_WAIT_RESOLVER_LEASE_HEARTBEAT_MS = 1_000;

class WorkflowWaitResolverLeaseLost extends TaggedError("WorkflowWaitResolverLeaseLost")<{
  readonly cursor: string;
  readonly message: string;
}> {}

class WorkflowWaitResolverCheckpointNotAdvanced extends TaggedError(
  "WorkflowWaitResolverCheckpointNotAdvanced",
)<{
  readonly cursor: string;
  readonly message: string;
}> {}

class WorkflowWaitResolverLeaseAcquisitionStopped extends TaggedError(
  "WorkflowWaitResolverLeaseAcquisitionStopped",
)<{ readonly message: string }> {}

class WorkflowWaitResolverLeaseAcquisitionTimedOut extends TaggedError(
  "WorkflowWaitResolverLeaseAcquisitionTimedOut",
)<{ readonly message: string }> {}

class WorkflowWaitResolverSubscriptionStartFailed extends TaggedError(
  "WorkflowWaitResolverSubscriptionStartFailed",
)<{
  readonly cause: EventDeliveryStartFailed;
  readonly message: string;
}> {}

class WorkflowWaitResolverStartupLeaseLost extends TaggedError(
  "WorkflowWaitResolverStartupLeaseLost",
)<{ readonly message: string }> {}

class WorkflowWaitResolverConsumerGroupRetirementFailed extends TaggedError(
  "WorkflowWaitResolverConsumerGroupRetirementFailed",
)<{
  readonly cause: unknown;
  readonly message: string;
}> {}

class WorkflowWaitResolverStartupStopped extends TaggedError("WorkflowWaitResolverStartupStopped")<{
  readonly message: string;
}> {}

class WorkflowWaitResolverTrimFailed extends TaggedError("WorkflowWaitResolverTrimFailed")<{
  readonly cause: unknown;
  readonly cursor: string;
  readonly message: string;
}> {}

class WorkflowWaitResolverBarrierPublishFailed extends TaggedError(
  "WorkflowWaitResolverBarrierPublishFailed",
)<{
  readonly cause: unknown;
  readonly barrierId: string;
  readonly message: string;
}> {}

class WorkflowWaitResolverWakeupPublishFailed extends TaggedError(
  "WorkflowWaitResolverWakeupPublishFailed",
)<{
  readonly cause: unknown;
  readonly runId: string;
  readonly operationId: string;
  readonly message: string;
}> {}

type WorkflowWaitResolverLeaseAcquisitionError =
  | WorkflowWaitResolverLeaseAcquisitionStopped
  | WorkflowWaitResolverLeaseAcquisitionTimedOut;
type WorkflowWaitResolverActivationError =
  | WorkflowWaitResolverLeaseAcquisitionError
  | WorkflowWaitResolverSubscriptionStartFailed
  | WorkflowWaitResolverStartupLeaseLost
  | WorkflowWaitResolverConsumerGroupRetirementFailed
  | WorkflowWaitResolverStartupStopped;

type WorkflowWaitResolverDeliveryError =
  | WorkflowWaitResolverLeaseLost
  | WorkflowWaitResolverCheckpointNotAdvanced;

type WorkflowWaitResolverSubscription = {
  readonly done: Promise<ResultType<void, EventDeliveryDoneError>>;
  stop(): Promise<ResultType<void, EventDeliveryStopFailed>>;
};

function workflowWaitResolverDeliveryPolicy(
  error: WorkflowWaitResolverDeliveryError,
): DeliveryDisposition {
  switch (error._tag) {
    case "WorkflowWaitResolverLeaseLost":
    case "WorkflowWaitResolverCheckpointNotAdvanced":
      return "stop";
  }
}

function adaptWorkflowWaitResolverStartResultToHost(
  started: ResultType<void, WorkflowWaitResolverActivationError>,
): void {
  if (started.status === "error") throw started.error;
}

function adaptWorkflowWaitResolverStopResultToHost(
  stopped: ResultType<void, EventDeliveryStopFailed>,
): void {
  if (stopped.status === "error") throw stopped.error;
}

export class WorkflowWaitResolver {
  private readonly logger = createLogger({ module: "workflow-wait-resolver" });
  private readonly workerId = `workflow-wait-resolver:${process.pid}:${crypto.randomUUID()}`;
  private subscription: WorkflowWaitResolverSubscription | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private leaseOwned = false;
  private nextLeaseHeartbeatAt: number | null = null;
  private stopping = true;
  private recoveryTask: Promise<ResultType<void, never>> | null = null;

  constructor(
    private readonly input: {
      bus: LilacBus;
      store: DurableWorkflowStore;
      subscriptionId: string;
      now?: () => number;
      pollMs?: number;
      leaseStaleMs?: number;
      leaseHeartbeatMs?: number;
      leaseAcquireTimeoutMs?: number;
      leaseRetryMs?: number;
      subscriptionRecoveryRetryMs?: number;
      confirmLegacyGroupSingleVersionRollout?: boolean;
    },
  ) {}

  async start(): Promise<void> {
    this.stopping = false;
    adaptWorkflowWaitResolverStartResultToHost(await this.startWorkflowWaitResolverResult());
  }

  private async startWorkflowWaitResolverResult(): Promise<
    ResultType<void, WorkflowWaitResolverActivationError>
  > {
    const activated = await this.activateSubscriptionResult();
    if (activated.status === "error") return Result.err(activated.error);
    this.startTimer();
    await this.reconcileTimers();
    return Result.ok(undefined);
  }

  private async acquireLeaseResult(): Promise<
    ResultType<void, WorkflowWaitResolverLeaseAcquisitionError>
  > {
    const acquireDeadline = Date.now() + (this.input.leaseAcquireTimeoutMs ?? 7_500);
    while (!this.leaseOwned) {
      if (this.stopping) {
        return Result.err(
          new WorkflowWaitResolverLeaseAcquisitionStopped({
            message: "Workflow wait resolver stopped during lease acquisition",
          }),
        );
      }
      const now = this.now();
      this.leaseOwned = this.input.store.claimWorkflowWaitResolverLease({
        ownerId: this.workerId,
        now,
        staleBefore: now - (this.input.leaseStaleMs ?? 5_000),
      });
      if (this.leaseOwned) {
        this.nextLeaseHeartbeatAt =
          now + (this.input.leaseHeartbeatMs ?? WORKFLOW_WAIT_RESOLVER_LEASE_HEARTBEAT_MS);
        break;
      }
      if (Date.now() >= acquireDeadline) {
        return Result.err(
          new WorkflowWaitResolverLeaseAcquisitionTimedOut({
            message: "Timed out waiting for the ordered workflow wait resolver lease",
          }),
        );
      }
      await Bun.sleep(this.input.leaseRetryMs ?? 100);
    }
    return Result.ok(undefined);
  }

  private async startWorkflowWaitSubscriptionResult(
    checkpoint: string | null,
  ): Promise<ResultType<WorkflowWaitResolverSubscription, EventDeliveryStartFailed>> {
    try {
      return await this.input.bus.subscribeTopic(
        "evt.adapter",
        {
          mode: "tail",
          offset: checkpoint ? { type: "cursor", cursor: checkpoint } : { type: "begin" },
          batch: { maxWaitMs: 500 },
        },
        async (message, context): Promise<ResultType<void, WorkflowWaitResolverDeliveryError>> => {
          if (!this.ensureLeaseOwnership(this.now())) {
            return Result.err(this.leaseLost(context.cursor));
          }
          if (message.type === lilacEventTypes.EvtAdapterMessageCreated) {
            await this.resolveAdapterEvent(message.data, context.cursor);
          } else if (message.type === lilacEventTypes.EvtWorkflowWaitResolverBarrier) {
            if (!this.ensureLeaseOwnership(this.now())) {
              return Result.err(this.leaseLost(context.cursor));
            }
            this.input.store.markWaitExpiryBarrierProcessed(
              message.data.barrierId,
              context.cursor,
              this.now(),
            );
          }
          if (!this.ensureLeaseOwnership(this.now())) {
            return Result.err(this.leaseLost(context.cursor));
          }
          if (
            !this.input.store.advanceWorkflowWaitResolverCheckpoint({
              ownerId: this.workerId,
              topic: "evt.adapter",
              cursor: context.cursor,
              now: this.now(),
            })
          ) {
            return Result.err(
              new WorkflowWaitResolverCheckpointNotAdvanced({
                cursor: context.cursor,
                message: "Workflow wait resolver checkpoint was not advanced",
              }),
            );
          }
          if (!this.ensureLeaseOwnership(this.now())) {
            return Result.err(this.leaseLost(context.cursor));
          }
          const trimmed = await this.captureWorkflowWaitResolverTrim(context.cursor);
          if (trimmed.status === "error") {
            this.logger.error(
              "Workflow adapter stream reclamation failed",
              formatTaggedErrorForLog(trimmed.error),
            );
          }
          return Result.ok(undefined);
        },
        workflowWaitResolverDeliveryPolicy,
      );
    } catch (cause) {
      this.releaseLease();
      throw cause;
    }
  }

  private async captureWorkflowWaitResolverTrim(
    cursor: string,
  ): Promise<ResultType<void, WorkflowWaitResolverTrimFailed>> {
    try {
      await this.input.bus.trimTopicBeforeCheckpoint("evt.adapter", cursor, 100);
      return Result.ok(undefined);
    } catch (cause) {
      if (Panic.is(cause)) throw cause;
      return Result.err(
        new WorkflowWaitResolverTrimFailed({
          cause,
          cursor,
          message: "Workflow adapter stream reclamation failed",
        }),
      );
    }
  }

  private async captureWorkflowWaitResolverConsumerGroupRetirement(
    subscription: WorkflowWaitResolverSubscription,
  ): Promise<ResultType<void, WorkflowWaitResolverConsumerGroupRetirementFailed>> {
    try {
      await this.input.bus.retireTopicConsumerGroup(
        "evt.adapter",
        this.input.subscriptionId,
        this.input.confirmLegacyGroupSingleVersionRollout ?? false,
      );
      return Result.ok(undefined);
    } catch (cause) {
      if (Panic.is(cause)) {
        const stopped = await subscription.stop();
        if (stopped.status === "error") {
          this.logger.error(
            "Workflow wait resolver subscription cleanup failed",
            formatTaggedErrorForLog(stopped.error),
          );
        }
        this.releaseLease();
        throw cause;
      }
      return Result.err(
        new WorkflowWaitResolverConsumerGroupRetirementFailed({
          cause,
          message: "Workflow wait resolver consumer-group retirement failed",
        }),
      );
    }
  }

  private async failWorkflowWaitResolverActivation(
    subscription: WorkflowWaitResolverSubscription,
    error: WorkflowWaitResolverActivationError,
  ): Promise<ResultType<void, WorkflowWaitResolverActivationError>> {
    const stopped = await subscription.stop();
    if (stopped.status === "error") {
      this.logger.error(
        "Workflow wait resolver subscription cleanup failed",
        formatTaggedErrorForLog(stopped.error),
      );
    }
    this.releaseLease();
    return Result.err(error);
  }

  private async activateSubscriptionResult(): Promise<
    ResultType<void, WorkflowWaitResolverActivationError>
  > {
    const lease = await this.acquireLeaseResult();
    if (lease.status === "error") return Result.err(lease.error);
    const checkpoint = this.input.store.getWorkflowWaitResolverCheckpoint("evt.adapter");
    const started = await this.startWorkflowWaitSubscriptionResult(checkpoint);
    if (started.status === "error") {
      this.releaseLease();
      return Result.err(
        new WorkflowWaitResolverSubscriptionStartFailed({
          cause: started.error,
          message: "Workflow wait resolver subscription failed to start",
        }),
      );
    }
    const subscription = started.value;
    if (!this.ensureLeaseOwnership(this.now())) {
      return this.failWorkflowWaitResolverActivation(
        subscription,
        new WorkflowWaitResolverStartupLeaseLost({
          message: "Ordered workflow wait resolver lease was lost during startup",
        }),
      );
    }
    const retired = await this.captureWorkflowWaitResolverConsumerGroupRetirement(subscription);
    if (retired.status === "error") {
      return this.failWorkflowWaitResolverActivation(subscription, retired.error);
    }
    if (this.stopping) {
      return this.failWorkflowWaitResolverActivation(
        subscription,
        new WorkflowWaitResolverStartupStopped({
          message: "Workflow wait resolver stopped during subscription startup",
        }),
      );
    }
    this.subscription = subscription;
    this.observeSubscription(subscription);
    return Result.ok(undefined);
  }

  private startTimer(): void {
    if (this.timer || this.stopping) return;
    this.timer = setInterval(() => void this.reconcileTimers(), this.input.pollMs ?? 250);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private releaseLease(): void {
    if (this.leaseOwned) this.input.store.releaseWorkflowWaitResolverLease(this.workerId);
    this.leaseOwned = false;
    this.nextLeaseHeartbeatAt = null;
  }

  private observeSubscription(subscription: WorkflowWaitResolverSubscription): void {
    void subscription.done.then((result) =>
      this.handleSubscriptionTermination(subscription, result),
    );
  }

  private handleSubscriptionTermination(
    subscription: WorkflowWaitResolverSubscription,
    result: ResultType<void, EventDeliveryDoneError>,
  ): void {
    if (this.stopping || this.subscription !== subscription) return;
    this.subscription = null;
    this.stopTimer();
    this.releaseLease();
    this.logger.error(
      "Workflow wait resolver subscription terminated unexpectedly",
      result.status === "error"
        ? formatTaggedErrorForLog(result.error)
        : { error: "Subscription completed without being stopped" },
    );
    const recovery = this.recoverSubscriptionResult().finally(() => {
      if (this.recoveryTask === recovery) this.recoveryTask = null;
    });
    this.recoveryTask = recovery;
  }

  private async recoverSubscriptionResult(): Promise<ResultType<void, never>> {
    const retryMs = Math.max(0, this.input.subscriptionRecoveryRetryMs ?? 100);
    let attempt = 0;
    while (!this.stopping) {
      attempt += 1;
      const activated = await this.activateSubscriptionResult();
      if (activated.status === "ok") {
        if (this.stopping) return Result.ok(undefined);
        this.startTimer();
        await this.reconcileTimers();
        return Result.ok(undefined);
      }
      if (this.stopping) return Result.ok(undefined);
      this.logger.warn("Workflow wait resolver subscription recovery failed", {
        attempt,
        ...formatTaggedErrorForLog(activated.error),
      });
      await Bun.sleep(Math.min(retryMs * 2 ** Math.min(attempt - 1, 10), 30_000));
    }
    return Result.ok(undefined);
  }

  async stop(): Promise<void> {
    adaptWorkflowWaitResolverStopResultToHost(await this.stopWorkflowWaitResolverResult());
  }

  private async stopWorkflowWaitSubscriptionResult(
    subscription: WorkflowWaitResolverSubscription,
  ): Promise<ResultType<void, EventDeliveryStopFailed>> {
    try {
      return await subscription.stop();
    } finally {
      this.releaseLease();
    }
  }

  private async stopWorkflowWaitResolverResult(): Promise<
    ResultType<void, EventDeliveryStopFailed>
  > {
    this.stopping = true;
    this.stopTimer();
    const subscription = this.subscription;
    this.subscription = null;
    if (subscription) {
      const stopped = await this.stopWorkflowWaitSubscriptionResult(subscription);
      if (stopped.status === "error") return Result.err(stopped.error);
      const done = await subscription.done;
      if (done.status === "error" && done.error._tag !== "EventDeliveryStopped") {
        this.logger.error(
          "Workflow wait resolver subscription terminated",
          formatTaggedErrorForLog(done.error),
        );
      }
    } else {
      this.releaseLease();
    }
    await this.recoveryTask;
    return Result.ok(undefined);
  }

  private now(): number {
    return this.input.now?.() ?? Date.now();
  }

  private leaseLost(cursor: string): WorkflowWaitResolverLeaseLost {
    return new WorkflowWaitResolverLeaseLost({
      cursor,
      message: "Ordered workflow wait resolver lease was lost during delivery",
    });
  }

  private ensureLeaseOwnership(now: number): boolean {
    if (!this.leaseOwned) return false;
    const refreshDue = this.nextLeaseHeartbeatAt === null || now >= this.nextLeaseHeartbeatAt;
    const owned = refreshDue
      ? this.input.store.refreshWorkflowWaitResolverLease(this.workerId, now)
      : this.input.store.isWorkflowWaitResolverLeaseOwner(this.workerId);
    if (!owned) {
      this.leaseOwned = false;
      this.nextLeaseHeartbeatAt = null;
      return false;
    }
    if (refreshDue) {
      this.nextLeaseHeartbeatAt =
        now + (this.input.leaseHeartbeatMs ?? WORKFLOW_WAIT_RESOLVER_LEASE_HEARTBEAT_MS);
    }
    return true;
  }

  async resolveAdapterEvent(event: EvtAdapterMessageCreatedData, cursor: string): Promise<void> {
    const key = workflowReplyMatchKey(event.platform, event.channelId);
    for (const candidate of this.input.store.listActiveWaitsByMatchKey("reply", key)) {
      const result = matchWorkflowReplyWait(candidate, event);
      if (result === null) continue;
      const now = this.now();
      if (!this.ensureLeaseOwnership(now)) return;
      const resolved = this.input.store.resolveReplyWaitAndSuppress({
        runId: candidate.runId,
        operationId: candidate.operationId,
        platform: event.platform,
        channelId: event.channelId,
        messageId: event.messageId,
        eventTs: event.ts,
        cursor,
        result,
        now,
      });
      if (resolved) await this.publishWakeupAdvisory(resolved);
    }
  }

  async reconcileTimers(): Promise<void> {
    const reconciled = await this.reconcileTimersResult();
    if (reconciled.status === "error") {
      this.logger.error(
        "Workflow wait timer reconciliation failed",
        formatTaggedErrorForLog(reconciled.error),
      );
    }
  }

  private async captureWorkflowWaitResolverBarrierPublication(
    barrierId: string,
    now: number,
  ): Promise<ResultType<{ readonly cursor: string }, WorkflowWaitResolverBarrierPublishFailed>> {
    try {
      const published = await this.input.bus.publish(
        lilacEventTypes.EvtWorkflowWaitResolverBarrier,
        { barrierId, ts: now },
      );
      return Result.ok({ cursor: published.cursor });
    } catch (cause) {
      if (Panic.is(cause)) throw cause;
      return Result.err(
        new WorkflowWaitResolverBarrierPublishFailed({
          cause,
          barrierId,
          message: "Workflow wait resolver barrier publication failed",
        }),
      );
    }
  }

  private async reconcileTimersResult(): Promise<
    ResultType<void, WorkflowWaitResolverBarrierPublishFailed>
  > {
    if (this.polling) return Result.ok(undefined);
    this.polling = true;
    try {
      const now = this.now();
      if (!this.ensureLeaseOwnership(now)) return Result.ok(undefined);
      const candidates = this.input.store.listDueWaits(now);
      for (const candidate of candidates) {
        if (candidate.match.kind === "reply") {
          if (!this.ensureLeaseOwnership(this.now())) return Result.ok(undefined);
          const barrier = this.input.store.prepareWaitExpiryBarrier({
            runId: candidate.runId,
            operationId: candidate.operationId,
            barrierId: `wfbarrier:${crypto.randomUUID()}`,
            now,
            retryBefore: now - 5_000,
          });
          if (!barrier) continue;
          if (barrier.shouldPublish) {
            if (!this.ensureLeaseOwnership(this.now())) return Result.ok(undefined);
            const published = await this.captureWorkflowWaitResolverBarrierPublication(
              barrier.barrierId,
              now,
            );
            if (published.status === "error") return Result.err(published.error);
            if (!this.ensureLeaseOwnership(this.now())) return Result.ok(undefined);
            this.input.store.recordWaitExpiryBarrierCursor(
              barrier.barrierId,
              published.value.cursor,
              this.now(),
            );
          }
          if (!barrier.processed) continue;
        }
        const runOwnerId = this.input.store.getRun(candidate.runId)?.claimedBy;
        if (!runOwnerId) continue;
        if (!this.ensureLeaseOwnership(this.now())) return Result.ok(undefined);
        const claimed = this.input.store.tryClaimWait({
          runId: candidate.runId,
          operationId: candidate.operationId,
          claimerId: this.workerId,
          runOwnerId,
          now,
        });
        if (!claimed) continue;
        const isSleep =
          claimed.match.kind === "sleep" && claimed.dueAt !== null && claimed.dueAt <= now;
        const isExpired = claimed.deadlineAt !== null && claimed.deadlineAt <= now;
        if (!isSleep && !isExpired) {
          if (!this.ensureLeaseOwnership(this.now())) return Result.ok(undefined);
          this.input.store.transitionWait({
            runId: claimed.runId,
            operationId: claimed.operationId,
            from: "claimed",
            to: "pending",
            now,
            runOwnerId,
          });
          continue;
        }
        const to = isSleep ? "resolved" : "expired";
        if (!this.ensureLeaseOwnership(this.now())) return Result.ok(undefined);
        const changed = this.input.store.transitionWait({
          runId: claimed.runId,
          operationId: claimed.operationId,
          from: "claimed",
          to,
          now,
          result: isSleep ? { kind: "sleep", dueAt: claimed.dueAt, resolvedAt: now } : null,
          resolvedBy: `${to}:${now}`,
          runOwnerId,
        });
        if (changed) await this.publishWakeupAdvisory(claimed);
      }
      return Result.ok(undefined);
    } finally {
      this.polling = false;
    }
  }

  private async captureWorkflowWaitResolverWakeupPublication(
    wait: WorkflowWait,
  ): Promise<ResultType<void, WorkflowWaitResolverWakeupPublishFailed>> {
    const run = this.input.store.getRun(wait.runId);
    if (!run) return Result.ok(undefined);
    try {
      await this.input.bus.publish(lilacEventTypes.EvtWorkflowProgressRequested, {
        runId: run.runId,
        revisionId: run.revisionId,
        reason: "operation_changed",
        ts: this.now(),
      });
      return Result.ok(undefined);
    } catch (cause) {
      if (Panic.is(cause)) throw cause;
      return Result.err(
        new WorkflowWaitResolverWakeupPublishFailed({
          cause,
          runId: wait.runId,
          operationId: wait.operationId,
          message: "Workflow wait wakeup publication failed after durable resolution",
        }),
      );
    }
  }

  private async publishWakeupAdvisory(wait: WorkflowWait): Promise<void> {
    if (!this.ensureLeaseOwnership(this.now())) return;
    const published = await this.captureWorkflowWaitResolverWakeupPublication(wait);
    if (published.status === "error") {
      this.logger.warn("Workflow wait wakeup publication failed after durable resolution", {
        runId: wait.runId,
        operationId: wait.operationId,
        ...formatTaggedErrorForLog(published.error),
      });
    }
  }
}
