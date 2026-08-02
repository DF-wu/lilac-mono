import { describe, expect, it } from "bun:test";
import { parseCoreConfigV1ToUniversal } from "@stanley2058/lilac-utils";

import {
  startConversationThreadWorker,
  type ConversationThreadWorkerScheduler,
} from "../../src/conversation/thread-worker";
import type { ConversationThreadRunSummarizationInput } from "../../src/conversation/thread-service";

describe("conversation thread periodic worker", () => {
  it("dispatches a bounded periodic run from the configured batch size", async () => {
    const scheduled: Array<{ task: () => void; delayMs: number }> = [];
    const schedule: ConversationThreadWorkerScheduler = (task, delayMs) => {
      const entry = {
        delayMs,
        task() {
          const index = scheduled.indexOf(entry);
          if (index >= 0) scheduled.splice(index, 1);
          task();
        },
      };
      scheduled.push(entry);
      return () => {
        const index = scheduled.indexOf(entry);
        if (index >= 0) scheduled.splice(index, 1);
      };
    };
    const cfg = parseCoreConfigV1ToUniversal({});
    cfg.conversation.thread.summarization.enabled = true;
    cfg.conversation.thread.summarization.batchSize = 17;
    const dispatched = Promise.withResolvers<ConversationThreadRunSummarizationInput>();
    const worker = startConversationThreadWorker({
      getConfig: async () => cfg,
      schedule,
      initialCheckDelayMs: 123,
      runner: {
        async runSummarization(input = {}) {
          dispatched.resolve(input);
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
        },
      },
    });

    expect(scheduled.map((entry) => entry.delayMs)).toEqual([123]);
    scheduled[0]!.task();
    expect(await dispatched.promise).toEqual({ wait: true, limit: 17, trigger: "periodic" });
    await worker.stop();
    expect(scheduled).toEqual([]);
  });
});
