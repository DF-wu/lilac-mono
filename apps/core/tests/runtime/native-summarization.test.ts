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
        return Result.ok({ refreshed: 2, discarded: 0 });
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
    expect(await entered.promise).toEqual({ limit: 3 });
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

  it("does not run models for manual, dry-run or individual legacy-thread operations", async () => {
    let nativeCalls = 0;
    const runner = withNativeThreadSummaries(
      { runSummarization: async () => Result.ok(emptyResult()) },
      async () => {
        nativeCalls += 1;
        return Result.ok({ refreshed: 1, discarded: 0 });
      },
    );
    await runner.runSummarization();
    await runner.runSummarization({ trigger: "periodic", dryRun: true });
    await runner.runSummarization({ trigger: "periodic", threadId: "discord-thread" });
    expect(nativeCalls).toBe(0);
    expect((await runner.runSummarization({ trigger: "periodic" })).unwrap().summarized).toBe(1);
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
