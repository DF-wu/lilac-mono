import { describe, expect, it } from "bun:test";
import { Panic } from "better-result";

import type {
  ConversationThreadAutoInjectQueryPlan,
  ConversationThreadMetadataOutput,
  ConversationThreadReadOutput,
  ConversationThreadRunSummarizationResult,
  ConversationThreadSearchResult,
  ConversationThreadToolService,
} from "../../src/conversation/thread-service";
import { ConversationThread } from "../../src/tool-server/tools/conversation-thread";

const searchOutput: ConversationThreadSearchResult = {
  meta: {
    query: "memory",
    limit: 2,
    mode: "hybrid",
    minScore: 0.1,
    count: 0,
    vectorAvailable: false,
  },
  results: [],
};

const metadataOutput: ConversationThreadMetadataOutput = {
  threads: [],
  missing: ["thread-1"],
};

const readOutput: ConversationThreadReadOutput = {
  thread: {
    threadId: "thread-1",
    session: { platform: "discord", channelId: "channel-1" },
    anchors: { startMessageId: "message-1", endMessageId: "message-1" },
    timeRange: { start: "start", end: "end" },
    messageCount: 1,
  },
  page: { offset: 1, limit: 2, total: 1, hasMore: false },
  messages: [],
};

const summarizationOutput: ConversationThreadRunSummarizationResult = {
  dryRun: true,
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

const autoInjectOutput: ConversationThreadAutoInjectQueryPlan = {
  searches: [
    {
      queries: ["memory"],
      aboutness: {
        domains: [],
        situations: [],
        targets: [],
        entities: [],
        userWouldAskForThisAs: [],
        intentSummary: "memory",
      },
    },
  ],
};

type Invocation = {
  readonly operation: "search" | "metadata" | "read" | "runSummarization";
  readonly input: object | undefined;
};

function createService(invocations: Invocation[]): ConversationThreadToolService {
  return {
    async search(input) {
      invocations.push({ operation: "search", input });
      return searchOutput;
    },
    async metadata(input) {
      invocations.push({ operation: "metadata", input });
      return metadataOutput;
    },
    async read(input) {
      invocations.push({ operation: "read", input });
      return readOutput;
    },
    async runSummarization(input) {
      invocations.push({ operation: "runSummarization", input });
      return summarizationOutput;
    },
    async planAutoInjectSearch() {
      return autoInjectOutput;
    },
  };
}

describe("ConversationThread.call", () => {
  it("dispatches every callable and preserves parsed inputs and service outputs", async () => {
    const invocations: Invocation[] = [];
    const tool = new ConversationThread({ service: createService(invocations) });

    const search = await tool.call("conversation.thread.search", { query: "memory", limit: "2" });
    const metadata = await tool.call("conversation.thread.metadata", { threadIds: ["thread-1"] });
    const read = await tool.call("conversation.thread.read", {
      threadId: "thread-1",
      offset: "1",
      limit: "2",
    });
    const summarization = await tool.call("conversation.thread.runSummarization", {
      dryRun: true,
      limit: "3",
    });

    expect(search.status).toBe("ok");
    expect(metadata.status).toBe("ok");
    expect(read.status).toBe("ok");
    expect(summarization.status).toBe("ok");
    if (search.status === "ok") expect(search.value).toBe(searchOutput);
    if (metadata.status === "ok") expect(metadata.value).toBe(metadataOutput);
    if (read.status === "ok") expect(read.value).toBe(readOutput);
    if (summarization.status === "ok") expect(summarization.value).toBe(summarizationOutput);

    expect(invocations).toEqual([
      { operation: "search", input: { query: "memory", limit: 2 } },
      { operation: "metadata", input: { threadIds: ["thread-1"] } },
      { operation: "read", input: { threadId: "thread-1", offset: 1, limit: 2 } },
      { operation: "runSummarization", input: { dryRun: true, limit: 3 } },
    ]);
  });

  it("preserves the invalid callable rejection contract without invoking the service", async () => {
    const invocations: Invocation[] = [];
    const tool = new ConversationThread({ service: createService(invocations) });

    const result = await tool.call("conversation.thread.missing", {});
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error).toMatchObject({
        kind: "not_found",
        message: "Invalid callable ID 'conversation.thread.missing'",
      });
    }
    expect(invocations).toEqual([]);
  });

  it("retains guided input validation", async () => {
    const invocations: Invocation[] = [];
    const tool = new ConversationThread({ service: createService(invocations) });

    const result = await tool.call("conversation.thread.search", { query: "" });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error.kind).toBe("usage");
      expect(result.error.message).toContain("conversation.thread.search has invalid input.");
    }
    expect(invocations).toEqual([]);
  });

  it("preserves Panic from the selected service operation", async () => {
    const panic = new Panic({ message: "conversation thread invariant failed" });
    const service: ConversationThreadToolService = {
      ...createService([]),
      search: () => Promise.reject(panic),
    };
    const tool = new ConversationThread({ service });

    const [settled] = await Promise.allSettled([
      tool.call("conversation.thread.search", { query: "memory" }),
    ]);
    expect(settled?.status).toBe("rejected");
    if (settled?.status === "rejected") expect(Panic.is(settled.reason)).toBe(true);
  });
});
