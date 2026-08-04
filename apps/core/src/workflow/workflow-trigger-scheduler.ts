import { lilacEventTypes, type LilacBus } from "@stanley2058/lilac-event-bus";
import { createLogger, isPanic } from "@stanley2058/lilac-utils";
import type { Panic } from "better-result";

import { adaptEventPublishResultToHost } from "../shared/event-bus-result";
import { preserveToolPanic } from "../tools/tool-result-adapters";

import {
  DEFAULT_MAX_ACTIVE_WORKFLOW_RUNS,
  DurableWorkflowStore,
  signalDurableWorkflowReadErrorToHost,
} from "./durable-workflow-store";
import { computeNextCronAtMsResult } from "./cron";
import { sha256 } from "./workflow-definition";
import type { WorkflowRun, WorkflowTrigger } from "./workflow-domain";
import { formatWorkflowErrorForLog } from "./workflow-error-log";
import type { WorkflowProgressCardService } from "./workflow-progress-projector";

const TERMINAL_RUN_STATES = new Set(["succeeded", "failed", "cancelled"]);

export class WorkflowTriggerScheduler {
  private readonly logger = createLogger({ module: "workflow-trigger-scheduler" });
  private readonly workerId = `workflow-trigger-scheduler:${process.pid}:${crypto.randomUUID()}`;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly input: {
      bus: LilacBus;
      store: DurableWorkflowStore;
      progressCards?: WorkflowProgressCardService;
      now?: () => number;
      pollMs?: number;
      getMaxActiveRuns?: () => number | Promise<number>;
      reportFatalPanic?: (panic: Panic) => void;
    },
  ) {}

  async start(): Promise<void> {
    this.timer = setInterval(() => this.runDetachedTick(), this.input.pollMs ?? 500);
    this.timer.unref?.();
    await this.tick();
  }

  private runDetachedTick(): void {
    void Promise.allSettled([this.tick()]).then(([settled]) => {
      if (settled.status !== "rejected") return;
      if (isPanic(settled.reason)) {
        this.input.reportFatalPanic?.(settled.reason);
        return;
      }
      const error =
        settled.reason instanceof Error
          ? settled.reason
          : new Error("Opaque detached workflow trigger reconciliation failure");
      this.logger.error(
        "Detached workflow trigger reconciliation failed",
        formatWorkflowErrorForLog(error),
      );
    });
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const [settled] = await Promise.allSettled([this.tickOnce()]);
      if (settled.status === "rejected") {
        if (isPanic(settled.reason)) preserveToolPanic(settled.reason);
        const error =
          settled.reason instanceof Error
            ? settled.reason
            : new Error("Opaque workflow trigger reconciliation failure");
        this.logger.error(
          "Workflow trigger reconciliation failed",
          formatWorkflowErrorForLog(error),
        );
      }
    } finally {
      this.running = false;
    }
  }

  private async tickOnce(): Promise<void> {
    const now = this.input.now?.() ?? Date.now();
    this.reconcileTimestampCompletion(now);
    const dueTriggers = this.input.store.listTriggers({ state: "active", dueBefore: now });
    if (dueTriggers.status === "error") signalDurableWorkflowReadErrorToHost(dueTriggers.error);
    for (const trigger of dueTriggers.value) {
      const claimed = this.input.store.tryClaimDueTrigger({
        triggerId: trigger.triggerId,
        claimerId: this.workerId,
        now,
      });
      if (claimed) await this.fire(claimed, now);
    }
  }

  private reconcileTimestampCompletion(now: number): void {
    const activeTriggers = this.input.store.listTriggers({ state: "active", limit: 1_000 });
    if (activeTriggers.status === "error")
      signalDurableWorkflowReadErrorToHost(activeTriggers.error);
    for (const trigger of activeTriggers.value) {
      if (
        trigger.definition.kind !== "timestamp" ||
        trigger.nextFireAt !== null ||
        !trigger.lastRunId
      ) {
        continue;
      }
      const runResult = this.input.store.getRun(trigger.lastRunId);
      if (runResult.status === "error") signalDurableWorkflowReadErrorToHost(runResult.error);
      const run = runResult.value;
      if (!run || !TERMINAL_RUN_STATES.has(run.state)) continue;
      this.input.store.transitionTrigger({
        triggerId: trigger.triggerId,
        from: "active",
        to: "completed",
        now,
      });
    }
  }

  private async fire(trigger: WorkflowTrigger, now: number): Promise<void> {
    const revisionResult = this.input.store.getRevision(trigger.revisionId);
    if (revisionResult.status === "error")
      signalDurableWorkflowReadErrorToHost(revisionResult.error);
    const revision = revisionResult.value;
    const fireAt = trigger.nextFireAt;
    if (!revision || fireAt === null) return;
    let nextFireAt: number | null = null;
    if (trigger.definition.kind === "cron") {
      const computed = computeNextCronAtMsResult(
        {
          expr: trigger.definition.expression,
          tz: trigger.definition.timezone ?? undefined,
        },
        (trigger.schedulingPolicy.skipMissed ? now : fireAt) + 1,
      );
      if (computed.status === "error") return;
      nextFireAt = computed.value;
    }
    const runId = `wfrun:${sha256(`${trigger.triggerId}:${fireAt}`)}`;
    const run: WorkflowRun = {
      runId,
      revisionId: revision.revisionId,
      state: "queued",
      inputSchemaSnapshot: revision.inputSchema,
      args: trigger.args,
      argsSha256: trigger.argsSha256,
      origin: trigger.origin,
      completionTarget: trigger.completionTarget,
      progressTarget: trigger.progressTarget,
      terminalDetail: null,
      result: null,
      resultArtifactId: null,
      claimedBy: null,
      claimedAt: null,
      createdAt: now,
      startedAt: null,
      updatedAt: now,
      terminalAt: null,
    };
    const maxActiveRuns =
      (await this.input.getMaxActiveRuns?.()) ?? DEFAULT_MAX_ACTIVE_WORKFLOW_RUNS;
    const fired = this.input.store.fireClaimedTrigger({
      triggerId: trigger.triggerId,
      claimerId: this.workerId,
      expectedFireAt: fireAt,
      nextFireAt,
      run,
      maxActiveRuns,
      now,
    });
    if (!fired || fired.status === "skipped") return;
    if (fired.run.progressTarget && this.input.progressCards) {
      const [created] = await Promise.allSettled([
        this.input.progressCards.ensureInitialCard(fired.run.runId),
      ]);
      if (created.status === "rejected") {
        if (isPanic(created.reason)) preserveToolPanic(created.reason);
        const error =
          created.reason instanceof Error
            ? created.reason
            : new Error("Opaque scheduled workflow progress card failure");
        this.logger.warn("Scheduled workflow progress card creation failed", {
          runId: fired.run.runId,
          ...formatWorkflowErrorForLog(error),
        });
      }
    }
    adaptEventPublishResultToHost(
      await this.input.bus.publish(lilacEventTypes.EvtWorkflowRunChanged, {
        runId: fired.run.runId,
        revisionId: fired.run.revisionId,
        state: fired.run.state,
        ts: now,
      }),
    );
    adaptEventPublishResultToHost(
      await this.input.bus.publish(lilacEventTypes.EvtWorkflowProgressRequested, {
        runId: fired.run.runId,
        revisionId: fired.run.revisionId,
        reason: "created",
        ts: now,
      }),
    );
  }
}
