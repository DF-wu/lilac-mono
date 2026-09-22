import { describe, expect, it } from "bun:test";
import { Result } from "better-result";
import { parseCoreConfigV1ToUniversal } from "@stanley2058/lilac-utils";
import { withNativeThreadSummaries } from "../../src/runtime/native-summarization";
import { startConversationThreadWorker } from "../../src/conversation/thread-worker";
import type { ConversationThreadRunSummarizationResult } from "../../src/conversation/thread-service";

function emptyResult(): ConversationThreadRunSummarizationResult {
  return {
    dryRun: false,
    refreshed: { channels: 0, threads: 0, messages: 0 },
    eligible: 0,
    eligibleTotal: 0,
    eligibility: { summary: 0, embeddingOnly: 0, reasons: {} },
    cleared: 0,
    summarized: 0,
    failed: 0,
    failures: [],
    threadIds: [],
  };
}

describe("native summary scheduling", () => {
  it("uses the existing periodic scheduler's batch and waits for native work before stopping", async () => {
    const cfg = parseCoreConfigV1ToUniversal({});
    cfg.conversation.thread.summarization.enabled = true;
    cfg.conversation.thread.summarization.batchSize = 3;
    const scheduled: (() => void | Promise<void>)[] = [];
    const entered = Promise.withResolvers<{ limit?: number }>();
    const complete = Promise.withResolvers<void>();
    let legacyCalls = 0;
    const runner = withNativeThreadSummaries(
      {
        async runSummarization() {
          legacyCalls += 1;
          return Result.ok(emptyResult());
        },
      },
      async (input) => {
        entered.resolve(input);
        await complete.promise;
        return Result.ok({ ...emptyResult(), summarized: 2 });
      },
    );
    const worker = startConversationThreadWorker({
      getConfig: async () => cfg,
      runner,
      schedule: (task) => {
        scheduled.push(task);
        return () => {
          const index = scheduled.indexOf(task);
          if (index >= 0) scheduled.splice(index, 1);
        };
      },
    });
    const tick = scheduled.shift()!;
    const running = tick();
    expect(await entered.promise).toMatchObject({ limit: 3, trigger: "periodic" });
    expect(legacyCalls).toBe(1);
    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(scheduled).toHaveLength(0);
    complete.resolve();
    await running;
    await stopping;
    expect(stopped).toBe(true);
    expect(scheduled).toHaveLength(0);
  });

  it("includes native refresh for manual, dry-run and scoped operations", async () => {
    let nativeCalls = 0;
    const runner = withNativeThreadSummaries(
      { runSummarization: async () => Result.ok(emptyResult()) },
      async () => {
        nativeCalls += 1;
        return Result.ok({ ...emptyResult(), summarized: 1 });
      },
    );
    await runner.runSummarization();
    await runner.runSummarization({ trigger: "periodic", dryRun: true });
    await runner.runSummarization({ trigger: "periodic", threadId: "discord-thread" });
    expect(nativeCalls).toBe(3);
    expect((await runner.runSummarization({ trigger: "periodic" })).unwrap().summarized).toBe(1);
  });

  it("forwards manual scope and combines native eligibility and completion counts", async () => {
    const input = {
      trigger: "manual" as const,
      threadId: "native:thread",
      beforeTs: 5000,
      afterTs: 10,
      now: 8000,
      force: true,
      clear: true,
      limit: 2,
      dryRun: true,
    };
    const runner = withNativeThreadSummaries(
      {
        runSummarization: async () =>
          Result.ok({
            ...emptyResult(),
            dryRun: true,
            eligible: 1,
            eligibleTotal: 2,
            eligibility: { summary: 2, embeddingOnly: 0, reasons: { forced: 2 } },
            threadIds: ["discord"],
          }),
      },
      async (received) => {
        expect(received).toEqual(input);
        return Result.ok({
          ...emptyResult(),
          dryRun: true,
          eligible: 1,
          eligibleTotal: 3,
          eligibility: { summary: 3, embeddingOnly: 0, reasons: { forced: 3 } },
          threadIds: ["native"],
        });
      },
    );
    expect((await runner.runSummarization(input)).unwrap()).toMatchObject({
      dryRun: true,
      eligible: 2,
      eligibleTotal: 5,
      eligibility: { summary: 5, embeddingOnly: 0, reasons: { forced: 5 } },
      threadIds: ["discord", "native"],
    });
  });

  it("returns a native model failure through the existing scheduler error contract", async () => {
    const failure = new Error("fixture model unavailable");
    const runner = withNativeThreadSummaries(
      { runSummarization: async () => Result.ok(emptyResult()) },
      async () => Result.err(failure),
    );
    const result = await runner.runSummarization({ trigger: "periodic", limit: 2 });
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.error._tag).toBe("ConversationThreadSummarizationRuntimeError");
    expect(result.error.message).toBe("Native thread summarization failed");
  });
});
