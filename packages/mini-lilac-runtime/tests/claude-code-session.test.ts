import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  MaterializedClaudeCodeRun,
  materializeClaudeCodeRun,
} from "@stanley2058/lilac-claude-code-bridge";
import type { MiniLilacUIMessage } from "@stanley2058/mini-lilac-client";
import type { LanguageModel } from "ai";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";

import type { RuntimeConfig } from "../src/config";
import {
  createAiProviderRegistry,
  type LoadedProviderRegistry,
  type ProviderConfig,
} from "../src/providers";
import {
  SessionService,
  type MiniLilacRuntimeChunk,
  type SessionServiceOptions,
} from "../src/session-service";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function zeroUsage() {
  return {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  };
}

function textResult(id: string, text: string) {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id },
        { type: "text-delta" as const, id, delta: text },
        { type: "text-end" as const, id },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: zeroUsage(),
        },
      ],
    }),
  };
}

/**
 * A Claude built-in: the model reports the call and its result inline, and the
 * MCP bridge never sees it, so no Lilac execution events are emitted.
 */
function providerExecutedSearchResult() {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: "tool-input-start" as const,
          id: "toolu_search",
          toolName: "WebSearch",
          providerExecuted: true,
          dynamic: true,
        },
        {
          type: "tool-input-delta" as const,
          id: "toolu_search",
          delta: JSON.stringify({ query: "lilac" }),
        },
        { type: "tool-input-end" as const, id: "toolu_search" },
        {
          type: "tool-call" as const,
          toolCallId: "toolu_search",
          toolName: "WebSearch",
          input: JSON.stringify({ query: "lilac" }),
          providerExecuted: true,
          dynamic: true,
        },
        {
          type: "tool-result" as const,
          toolCallId: "toolu_search",
          toolName: "WebSearch",
          result: "one result",
          providerExecuted: true,
          dynamic: true,
        },
        { type: "text-start" as const, id: "answer" },
        { type: "text-delta" as const, id: "answer", delta: "searched" },
        { type: "text-end" as const, id: "answer" },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: zeroUsage(),
        },
      ],
    }),
  };
}

/** A Lilac MCP call reported inline when no Lilac execution event was emitted. */
function providerExecutedMcpReadResult() {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: "tool-input-start" as const,
          id: "toolu_read",
          toolName: "mcp__lilac__read_file",
          providerExecuted: true,
          dynamic: true,
        },
        {
          type: "tool-input-delta" as const,
          id: "toolu_read",
          delta: JSON.stringify({ path: "README.md" }),
        },
        { type: "tool-input-end" as const, id: "toolu_read" },
        {
          type: "tool-call" as const,
          toolCallId: "toolu_read",
          toolName: "mcp__lilac__read_file",
          input: JSON.stringify({ path: "README.md" }),
          providerExecuted: true,
          dynamic: true,
        },
        {
          type: "tool-result" as const,
          toolCallId: "toolu_read",
          toolName: "mcp__lilac__read_file",
          result: "contents",
          providerExecuted: true,
          dynamic: true,
        },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: zeroUsage(),
        },
      ],
    }),
  };
}

/** A provider-executed call whose result never arrives (run cancelled mid-call). */
function unresolvedProviderCallResult() {
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: "tool-call" as const,
          toolCallId: "toolu_open",
          toolName: "WebSearch",
          input: JSON.stringify({ query: "lilac" }),
          providerExecuted: true,
          dynamic: true,
        },
        {
          type: "finish" as const,
          finishReason: { unified: "stop" as const, raw: "stop" },
          usage: zeroUsage(),
        },
      ],
    }),
  };
}

function userMessage(text: string): MiniLilacUIMessage {
  return { id: crypto.randomUUID(), role: "user", parts: [{ type: "text", text }] };
}

function config(profileTools: readonly string[] = ["read_file", "websearch"]): RuntimeConfig {
  return {
    configVersion: 1,
    server: { host: "127.0.0.1", port: 3000 },
    providerConfigFile: "providers.yaml",
    providerAuthFile: "auth.json",
    agent: {
      systemPrompt: "You are Mini Lilac.",
      defaultProfile: "reader",
      idleTimeoutMs: 900_000,
      compaction: { model: "inherit", earlyCompactionPoint: 0.8 },
      subagents: {
        enabled: true,
        maxDepth: 3,
        maxChildrenPerRun: 16,
        maxConcurrent: 4,
        idleTimeoutMs: 300_000,
      },
      profiles: {
        reader: {
          description: "Read-only main agent",
          subagentOnly: false,
          tools: [...profileTools],
          execution: false,
          workspaceWrites: false,
          delegation: false,
        },
      },
    },
  };
}

function claudeProviders(): LoadedProviderRegistry {
  // Named "claude", not "claude-code": behavior must follow the provider type.
  const providerConfig: ProviderConfig = {
    configVersion: 1,
    providers: { claude: { type: "claude-code", catalog: "models-dev" } },
  };
  return {
    config: providerConfig,
    auth: {},
    registry: createAiProviderRegistry(providerConfig, {}),
    supersededProviderIds: [],
  };
}

type MaterializeCall = {
  modelId: string;
  cwd: string;
  toolNames: string[];
  builtInTools: readonly string[];
};

type FakeClaudeRun = MaterializedClaudeCodeRun & {
  injected: string[];
  interrupts: number;
  disposals: number;
};

/**
 * Stands in for the Claude bridge so tests exercise Lilac's wiring without a
 * Claude installation. `deliverSteering` controls whether the injector reports
 * successful delivery.
 */
function fakeClaudeCode(options: {
  agentModel: LanguageModel;
  utilityModel?: LanguageModel;
  deliverSteering?: boolean;
  calls?: MaterializeCall[];
  runs?: FakeClaudeRun[];
}): typeof materializeClaudeCodeRun {
  return async (input) => {
    options.calls?.push({
      modelId: input.modelId,
      cwd: input.cwd,
      toolNames: Object.keys(input.tools),
      builtInTools: [...(input.builtInTools ?? [])],
    });
    const run: FakeClaudeRun = {
      agentModel: options.agentModel,
      utilityModel: options.utilityModel ?? new MockLanguageModelV4({}),
      injected: [],
      interrupts: 0,
      disposals: 0,
      control: {
        inject(message, onResult) {
          run.injected.push(message);
          onResult?.(options.deliverSteering ?? true);
          return true;
        },
        async interrupt() {
          run.interrupts += 1;
          return true;
        },
        clear() {},
      },
      dispose: async () => {
        run.disposals += 1;
      },
    };
    options.runs?.push(run);
    return run;
  };
}

async function temporaryRuntime(options: {
  model: LanguageModel;
  utilityModel?: LanguageModel;
  profileTools?: readonly string[];
  deliverSteering?: boolean;
  calls?: MaterializeCall[];
  runs?: FakeClaudeRun[];
  attachCompaction?: SessionServiceOptions["attachCompaction"];
}) {
  const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-claude-"));
  temporaryDirectories.push(directory);
  const service = new SessionService({
    config: config(options.profileTools),
    databasePath: path.join(directory, "runtime.sqlite"),
    providers: claudeProviders(),
    modelResolver: () => new MockLanguageModelV4({}),
    ...(options.attachCompaction ? { attachCompaction: options.attachCompaction } : {}),
    materializeClaudeCodeRun: fakeClaudeCode({
      agentModel: options.model,
      utilityModel: options.utilityModel,
      deliverSteering: options.deliverSteering,
      calls: options.calls,
      runs: options.runs,
    }),
  });
  const session = await service.createSession({
    cwd: directory,
    model: "claude/claude-sonnet-4-6",
    profile: "reader",
    reasoning: "high",
  });
  return { directory, service, session };
}

async function collect(stream: ReadableStream<MiniLilacRuntimeChunk>) {
  const values: MiniLilacRuntimeChunk[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

describe("claude-code sessions", () => {
  it("runs on the materialized model, withholds tool declarations, and disposes on completion", async () => {
    const model = new MockLanguageModelV4({ doStream: [textResult("answer", "done")] });
    const calls: MaterializeCall[] = [];
    const runs: FakeClaudeRun[] = [];
    const { service, session, directory } = await temporaryRuntime({ model, calls, runs });

    await collect((await service.startPrompt(session.id, userMessage("hello"))).stream);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.modelId).toBe("claude-sonnet-4-6");
    expect(calls[0]?.cwd).toBe(directory);
    expect(calls[0]?.toolNames).toContain("read_file");
    // Claude ignores AI SDK tool declarations; the toolset reaches it via MCP.
    expect(model.doStreamCalls[0]?.tools ?? []).toEqual([]);
    expect(runs[0]?.disposals).toBe(1);
    service.close();
  });

  it("enables Claude web search only for profiles that request it", async () => {
    const withSearch: MaterializeCall[] = [];
    const withoutSearch: MaterializeCall[] = [];

    const first = await temporaryRuntime({
      model: new MockLanguageModelV4({ doStream: [textResult("a", "done")] }),
      calls: withSearch,
    });
    await collect((await first.service.startPrompt(first.session.id, userMessage("hi"))).stream);
    first.service.close();

    const second = await temporaryRuntime({
      model: new MockLanguageModelV4({ doStream: [textResult("b", "done")] }),
      profileTools: ["read_file"],
      calls: withoutSearch,
    });
    await collect((await second.service.startPrompt(second.session.id, userMessage("hi"))).stream);
    second.service.close();

    expect(withSearch[0]?.builtInTools).toEqual(["WebSearch"]);
    expect(withoutSearch[0]?.builtInTools).toEqual([]);
    // Lilac's own websearch tool needs a provider API key, so it is never built.
    expect(withSearch[0]?.toolNames).not.toContain("websearch");
  });

  it("renders a provider-executed search as one completed call", async () => {
    const model = new MockLanguageModelV4({
      doStream: [providerExecutedSearchResult(), textResult("final", "done")],
    });
    const { service, session } = await temporaryRuntime({ model });

    const chunks = await collect(
      (await service.startPrompt(session.id, userMessage("search it"))).stream,
    );

    const inputs = chunks.filter(
      (chunk) => chunk.type === "tool-input-available" && chunk.toolCallId === "toolu_search",
    );
    const outputs = chunks.filter(
      (chunk) => chunk.type === "tool-output-available" && chunk.toolCallId === "toolu_search",
    );
    expect(inputs).toHaveLength(1);
    expect(outputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ toolName: "WebSearch" });
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: "tool-input-start",
        toolCallId: "toolu_search",
        toolName: "WebSearch",
      }),
    );
    service.close();
  });

  it("suppresses Claude MCP input drafts and keeps the plain-name inline fallback", async () => {
    const model = new MockLanguageModelV4({
      doStream: [providerExecutedMcpReadResult(), textResult("final", "done")],
    });
    const { service, session } = await temporaryRuntime({ model });

    const chunks = await collect(
      (await service.startPrompt(session.id, userMessage("read it"))).stream,
    );

    expect(
      chunks.filter(
        (chunk) => chunk.type === "tool-input-start" && chunk.toolCallId === "toolu_read",
      ),
    ).toEqual([]);
    expect(
      chunks.filter(
        (chunk) => chunk.type === "tool-input-delta" && chunk.toolCallId === "toolu_read",
      ),
    ).toEqual([]);
    expect(
      chunks.filter(
        (chunk) => chunk.type === "tool-input-available" && chunk.toolCallId === "toolu_read",
      ),
    ).toEqual([
      expect.objectContaining({
        toolName: "read_file",
        input: { path: "README.md" },
      }),
    ]);
    expect(
      chunks.filter(
        (chunk) => chunk.type === "tool-output-available" && chunk.toolCallId === "toolu_read",
      ),
    ).toHaveLength(1);
    service.close();
  });

  it("injects steering into the live query and consumes the queue entry once", async () => {
    let releaseFirstTurn: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve;
    });
    let turn = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        turn += 1;
        if (turn === 1) {
          await gate;
          return textResult("first", "working");
        }
        return textResult("second", "done");
      },
    });
    const runs: FakeClaudeRun[] = [];
    const { service, session } = await temporaryRuntime({ model, runs });

    const started = await service.startPrompt(session.id, userMessage("start"));
    const collected = collect(started.stream);
    const runId = service.store.getSession(session.id).activeRunId;
    if (runId === null) throw new Error("expected an active run");
    await service.steer({
      sessionId: session.id,
      runId,
      clientCommandId: crypto.randomUUID(),
      message: { id: "steer-1", role: "user", parts: [{ type: "text", text: "change course" }] },
    });

    expect(runs[0]?.injected).toEqual(["change course"]);
    // test-wait-justification: the delivery callback commits through the actor lock, so the queued count settles one microtask after inject()
    await Bun.sleep(0);
    expect(service.store.getSession(session.id).queuedSteeringCount).toBe(0);

    releaseFirstTurn?.();
    await collected;
    service.close();
  });

  it("leaves steering queued when the live query does not accept it", async () => {
    let releaseFirstTurn: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve;
    });
    let turn = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        turn += 1;
        if (turn === 1) {
          await gate;
          return textResult("first", "working");
        }
        return textResult("second", "done");
      },
    });
    const { service, session } = await temporaryRuntime({ model, deliverSteering: false });

    const started = await service.startPrompt(session.id, userMessage("start"));
    const collected = collect(started.stream);
    const runId = service.store.getSession(session.id).activeRunId;
    if (runId === null) throw new Error("expected an active run");
    await service.steer({
      sessionId: session.id,
      runId,
      clientCommandId: crypto.randomUUID(),
      message: { id: "steer-1", role: "user", parts: [{ type: "text", text: "change course" }] },
    });

    // test-wait-justification: same microtask boundary as the delivered case, proving the entry stays queued rather than being consumed late
    await Bun.sleep(0);
    expect(service.store.getSession(session.id).queuedSteeringCount).toBe(1);

    releaseFirstTurn?.();
    await collected;
    service.close();
  });

  it("flushes steering the live query could not take, and stops the query for it", async () => {
    let releaseFirstTurn: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve;
    });
    let turn = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        turn += 1;
        if (turn === 1) {
          await gate;
          return textResult("first", "working");
        }
        return textResult("second", "done");
      },
    });
    const runs: FakeClaudeRun[] = [];
    // Delivery fails, so the entry stays queued and the operator must be able
    // to flush it rather than wait out the whole Claude query.
    const { service, session } = await temporaryRuntime({ model, runs, deliverSteering: false });

    const started = await service.startPrompt(session.id, userMessage("start"));
    const collected = collect(started.stream);
    const runId = service.store.getSession(session.id).activeRunId;
    if (runId === null) throw new Error("expected an active run");
    await service.steer({
      sessionId: session.id,
      runId,
      clientCommandId: crypto.randomUUID(),
      message: { id: "steer-1", role: "user", parts: [{ type: "text", text: "change course" }] },
    });

    const result = await service.interruptQueuedSteering({
      sessionId: session.id,
      runId,
      clientCommandId: crypto.randomUUID(),
      pendingSteerCommandIds: [],
    });

    expect(result.status).toBe("interrupted");
    expect(runs[0]?.interrupts).toBe(1);

    releaseFirstTurn?.();
    await collected;
    service.close();
  });

  it("interrupts the live query on cancel without waiting for it", async () => {
    let releaseFirstTurn: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve;
    });
    const model = new MockLanguageModelV4({
      doStream: async () => {
        await gate;
        return textResult("first", "done");
      },
    });
    const runs: FakeClaudeRun[] = [];
    const { service, session } = await temporaryRuntime({ model, runs });

    const started = await service.startPrompt(session.id, userMessage("start"));
    const collected = collect(started.stream);
    const runId = service.store.getSession(session.id).activeRunId;
    if (runId === null) throw new Error("expected an active run");

    await service.cancel({ sessionId: session.id, runId, clientCommandId: crypto.randomUUID() });
    expect(runs[0]?.interrupts).toBe(1);

    releaseFirstTurn?.();
    await collected;
    expect(runs[0]?.disposals).toBe(1);
    service.close();
  });

  it("keeps completed Claude blocks and removes only the interrupted block", async () => {
    const model = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({
              type: "tool-call",
              toolCallId: "completed-call",
              toolName: "WebSearch",
              input: JSON.stringify({ query: "lilac" }),
              providerExecuted: true,
            });
            controller.enqueue({
              type: "tool-result",
              toolCallId: "completed-call",
              toolName: "WebSearch",
              result: "completed result",
            });
            controller.enqueue({ type: "text-start", id: "completed-text" });
            controller.enqueue({
              type: "text-delta",
              id: "completed-text",
              delta: "completed text",
            });
            controller.enqueue({ type: "text-end", id: "completed-text" });
            controller.enqueue({ type: "reasoning-start", id: "active-reasoning" });
            controller.enqueue({
              type: "reasoning-delta",
              id: "active-reasoning",
              delta: "discarded reasoning",
            });
            const abort = () => controller.error(new DOMException("cancelled", "AbortError"));
            if (abortSignal?.aborted) abort();
            else abortSignal?.addEventListener("abort", abort, { once: true });
          },
        }),
      }),
    });
    const runs: FakeClaudeRun[] = [];
    const { directory, service, session } = await temporaryRuntime({ model, runs });

    const started = await service.startPrompt(session.id, userMessage("start"));
    const reader = started.stream.getReader();
    const chunks: MiniLilacRuntimeChunk[] = [];
    while (!chunks.some((chunk) => chunk.type === "reasoning-delta")) {
      const next = await reader.read();
      if (next.done) throw new Error("run ended before interrupted reasoning was projected");
      chunks.push(next.value);
    }
    await service.cancel({
      sessionId: session.id,
      runId: started.runId,
      clientCommandId: crypto.randomUUID(),
    });
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }

    const rollback = chunks.find((chunk) => chunk.type === "data-outputRollback");
    expect(rollback).toMatchObject({
      data: {
        reason: "cancel",
        reasoningIds: ["active-reasoning"],
        textIds: [],
        toolCallIds: [],
      },
    });
    const messages = service.getMessages(session.id);
    expect(JSON.stringify(messages)).toContain("completed result");
    expect(JSON.stringify(messages)).toContain("completed text");
    expect(JSON.stringify(messages)).not.toContain("discarded reasoning");
    const modelMessages = service.store.getModelMessages(session.id);
    expect(JSON.stringify(modelMessages)).toContain("completed result");
    expect(JSON.stringify(modelMessages)).toContain("completed text");
    expect(JSON.stringify(modelMessages)).not.toContain("discarded reasoning");
    service.close();

    const reopened = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      providers: claudeProviders(),
      modelResolver: () => new MockLanguageModelV4({}),
      materializeClaudeCodeRun: fakeClaudeCode({ agentModel: new MockLanguageModelV4({}) }),
    });
    expect(reopened.getMessages(session.id)).toEqual(messages);
    reopened.close();
  });

  it("releases the Claude run when agent construction fails after materialization", async () => {
    const runs: FakeClaudeRun[] = [];
    const { service, session } = await temporaryRuntime({
      model: new MockLanguageModelV4({ doStream: [textResult("a", "done")] }),
      runs,
      // Compaction attaches after the Claude run exists; a failure there must
      // not strand the subprocess and MCP bridge.
      attachCompaction: async () => {
        throw new Error("compaction attach failed");
      },
    });

    await expect(service.startPrompt(session.id, userMessage("start"))).rejects.toThrow(
      "compaction attach failed",
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.disposals).toBe(1);
    service.close();
  });

  it("keeps steering the model accepted when the run is cancelled", async () => {
    let releaseFirstTurn: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve;
    });
    const model = new MockLanguageModelV4({
      doStream: async () => {
        await gate;
        return textResult("first", "done");
      },
    });
    const { service, session } = await temporaryRuntime({ model });

    const started = await service.startPrompt(session.id, userMessage("start"));
    const collected = collect(started.stream);
    const runId = service.store.getSession(session.id).activeRunId;
    if (runId === null) throw new Error("expected an active run");
    await service.steer({
      sessionId: session.id,
      runId,
      clientCommandId: crypto.randomUUID(),
      message: { id: "steer-1", role: "user", parts: [{ type: "text", text: "use typescript" }] },
    });
    // test-wait-justification: the delivery callback commits through the actor lock, so the ack lands one microtask after inject()
    await Bun.sleep(0);
    await service.cancel({ sessionId: session.id, runId, clientCommandId: crypto.randomUUID() });

    releaseFirstTurn?.();
    await collected;

    // Claude saw the instruction, so the transcript has to record it even
    // though the run was cancelled.
    const messages = service.store.getModelMessages(session.id);
    expect(JSON.stringify(messages)).toContain("use typescript");
    service.close();
  });

  it("persists a valid transcript when a provider call has no result", async () => {
    const model = new MockLanguageModelV4({ doStream: [unresolvedProviderCallResult()] });
    const { service, session } = await temporaryRuntime({ model });

    await collect((await service.startPrompt(session.id, userMessage("search it"))).stream);

    // The dangling call is closed with a synthetic result rather than left
    // unpaired, so the next prompt starts from a valid transcript.
    const messages = service.store.getModelMessages(session.id);
    expect(messages.at(-1)).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "toolu_open",
          toolName: "WebSearch",
          output: { type: "error-text", value: "run ended" },
        },
      ],
    });
    service.close();
  });
});
