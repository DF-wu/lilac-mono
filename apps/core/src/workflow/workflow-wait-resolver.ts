import {
  lilacEventTypes,
  type BusSubscription,
  type EvtAdapterMessageCreatedData,
  type LilacBus,
} from "@stanley2058/lilac-event-bus";
import { createLogger } from "@stanley2058/lilac-utils";

import { DurableWorkflowStore } from "./durable-workflow-store";
import type { WorkflowWait } from "./workflow-domain";
import { matchWorkflowReplyWait, workflowReplyMatchKey } from "./workflow-waits";

const WORKFLOW_WAIT_RESOLVER_LEASE_HEARTBEAT_MS = 1_000;

export class WorkflowWaitResolver {
  private readonly logger = createLogger({ module: "workflow-wait-resolver" });
  private readonly workerId = `workflow-wait-resolver:${process.pid}:${crypto.randomUUID()}`;
  private subscription: BusSubscription | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private leaseOwned = false;
  private nextLeaseHeartbeatAt: number | null = null;
  private stopping = true;
  private recoveryTask: Promise<void> | null = null;

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
    await this.activateSubscription();
    this.startTimer();
    await this.reconcileTimers();
  }

  private async acquireLease(): Promise<void> {
    const acquireDeadline = Date.now() + (this.input.leaseAcquireTimeoutMs ?? 7_500);
    while (!this.leaseOwned) {
      if (this.stopping) throw new Error("Workflow wait resolver stopped during lease acquisition");
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
        throw new Error("Timed out waiting for the ordered workflow wait resolver lease");
      }
      await Bun.sleep(this.input.leaseRetryMs ?? 100);
    }
  }

  private async activateSubscription(): Promise<void> {
    await this.acquireLease();
    const checkpoint = this.input.store.getWorkflowWaitResolverCheckpoint("evt.adapter");
    let subscription: BusSubscription | null = null;
    try {
      subscription = await this.input.bus.subscribeTopic(
        "evt.adapter",
        {
          mode: "tail",
          offset: checkpoint ? { type: "cursor", cursor: checkpoint } : { type: "begin" },
          batch: { maxWaitMs: 500 },
        },
        async (message, context) => {
          if (!this.ensureLeaseOwnership(this.now())) return;
          if (message.type === lilacEventTypes.EvtAdapterMessageCreated) {
            await this.resolveAdapterEvent(message.data, context.cursor);
          } else if (message.type === lilacEventTypes.EvtWorkflowWaitResolverBarrier) {
            if (!this.ensureLeaseOwnership(this.now())) return;
            this.input.store.markWaitExpiryBarrierProcessed(
              message.data.barrierId,
              context.cursor,
              this.now(),
            );
          }
          if (!this.ensureLeaseOwnership(this.now())) return;
          if (
            !this.input.store.advanceWorkflowWaitResolverCheckpoint({
              ownerId: this.workerId,
              topic: "evt.adapter",
              cursor: context.cursor,
              now: this.now(),
            })
          ) {
            return;
          }
          if (!this.ensureLeaseOwnership(this.now())) return;
          await context.commit();
          if (!this.ensureLeaseOwnership(this.now())) return;
          try {
            await this.input.bus.trimTopicBeforeCheckpoint("evt.adapter", context.cursor, 100);
          } catch (error) {
            this.logger.error("Workflow adapter stream reclamation failed", error);
          }
        },
      );
      if (!this.ensureLeaseOwnership(this.now())) {
        throw new Error("Ordered workflow wait resolver lease was lost during startup");
      }
      await this.input.bus.retireTopicConsumerGroup(
        "evt.adapter",
        this.input.subscriptionId,
        this.input.confirmLegacyGroupSingleVersionRollout ?? false,
      );
      if (this.stopping) {
        throw new Error("Workflow wait resolver stopped during subscription startup");
      }
      this.subscription = subscription;
      this.observeSubscription(subscription);
    } catch (error) {
      if (subscription) await Promise.allSettled([subscription.stop()]);
      this.releaseLease();
      throw error;
    }
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

  private observeSubscription(subscription: BusSubscription): void {
    if (!subscription.done) return;
    void subscription.done
      .then(
        () => this.handleSubscriptionTermination(subscription, null),
        (error: unknown) => this.handleSubscriptionTermination(subscription, error),
      )
      .catch((error: unknown) => {
        this.logger.error("Workflow wait resolver subscription completion handling failed", error);
      });
  }

  private handleSubscriptionTermination(subscription: BusSubscription, error: unknown): void {
    if (this.stopping || this.subscription !== subscription) return;
    this.subscription = null;
    this.stopTimer();
    this.releaseLease();
    this.logger.error(
      "Workflow wait resolver subscription terminated unexpectedly",
      error ?? new Error("Subscription completed without being stopped"),
    );
    const recovery = this.recoverSubscription()
      .catch((recoveryError: unknown) => {
        this.logger.error("Workflow wait resolver subscription recovery crashed", recoveryError);
      })
      .finally(() => {
        if (this.recoveryTask === recovery) this.recoveryTask = null;
      });
    this.recoveryTask = recovery;
  }

  private async recoverSubscription(): Promise<void> {
    const retryMs = Math.max(0, this.input.subscriptionRecoveryRetryMs ?? 100);
    let attempt = 0;
    while (!this.stopping) {
      attempt += 1;
      try {
        await this.activateSubscription();
        if (this.stopping) return;
        this.startTimer();
        await this.reconcileTimers();
        return;
      } catch (error) {
        if (this.stopping) return;
        this.logger.warn("Workflow wait resolver subscription recovery failed", {
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        await Bun.sleep(Math.min(retryMs * 2 ** Math.min(attempt - 1, 10), 30_000));
      }
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.stopTimer();
    const subscription = this.subscription;
    this.subscription = null;
    try {
      await subscription?.stop();
    } finally {
      this.releaseLease();
    }
    await this.recoveryTask;
  }

  private now(): number {
    return this.input.now?.() ?? Date.now();
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
    if (this.polling) return;
    this.polling = true;
    try {
      const now = this.now();
      if (!this.ensureLeaseOwnership(now)) return;
      const candidates = this.input.store.listDueWaits(now);
      for (const candidate of candidates) {
        if (candidate.match.kind === "reply") {
          if (!this.ensureLeaseOwnership(this.now())) return;
          const barrier = this.input.store.prepareWaitExpiryBarrier({
            runId: candidate.runId,
            operationId: candidate.operationId,
            barrierId: `wfbarrier:${crypto.randomUUID()}`,
            now,
            retryBefore: now - 5_000,
          });
          if (!barrier) continue;
          if (barrier.shouldPublish) {
            if (!this.ensureLeaseOwnership(this.now())) return;
            const published = await this.input.bus.publish(
              lilacEventTypes.EvtWorkflowWaitResolverBarrier,
              { barrierId: barrier.barrierId, ts: now },
            );
            if (!this.ensureLeaseOwnership(this.now())) return;
            this.input.store.recordWaitExpiryBarrierCursor(
              barrier.barrierId,
              published.cursor,
              this.now(),
            );
          }
          if (!barrier.processed) continue;
        }
        const runOwnerId = this.input.store.getRun(candidate.runId)?.claimedBy;
        if (!runOwnerId) continue;
        if (!this.ensureLeaseOwnership(this.now())) return;
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
          if (!this.ensureLeaseOwnership(this.now())) return;
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
        if (!this.ensureLeaseOwnership(this.now())) return;
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
    } catch (error) {
      this.logger.error("Workflow wait timer reconciliation failed", error);
    } finally {
      this.polling = false;
    }
  }

  private async publishWakeup(wait: WorkflowWait): Promise<void> {
    const run = this.input.store.getRun(wait.runId);
    if (!run) return;
    await this.input.bus.publish(lilacEventTypes.EvtWorkflowProgressRequested, {
      runId: run.runId,
      revisionId: run.revisionId,
      reason: "operation_changed",
      ts: this.now(),
    });
  }

  private async publishWakeupAdvisory(wait: WorkflowWait): Promise<void> {
    if (!this.ensureLeaseOwnership(this.now())) return;
    try {
      await this.publishWakeup(wait);
    } catch (error) {
      this.logger.warn("Workflow wait wakeup publication failed after durable resolution", {
        runId: wait.runId,
        operationId: wait.operationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
