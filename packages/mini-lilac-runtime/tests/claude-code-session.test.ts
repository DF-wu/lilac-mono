import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ClaudeNativeSessionPreflightError,
  type ClaudeNativeSessionStart,
  type MaterializedClaudeCodeRun,
  type materializeClaudeCodeRun,
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

function delegateResult(
  prompt: string,
  overrides: {
    readonly model?: string;
    readonly effort?: string;
    readonly sessionName?: string | null;
  } = {},
) {
  const { sessionName = "research", ...bindings } = overrides;
  return {
    stream: simulateReadableStream({
      chunks: [
        {
          type: "tool-call" as const,
          toolCallId: `delegate-${prompt}`,
          toolName: "subagent_delegate",
          input: JSON.stringify({
            profile: "child",
            prompt,
            mode: "sync",
            ...(sessionName === null ? {} : { sessionName }),
            ...bindings,
          }),
        },
        {
          type: "finish" as const,
          finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
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
        maxDepth: 1,
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
        delegate: {
          description: "Delegating main agent",
          subagentOnly: false,
          tools: ["subagent_delegate"],
          execution: false,
          workspaceWrites: false,
          delegation: true,
        },
        child: {
          description: "Named child",
          subagentOnly: true,
          tools: ["read_file"],
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

function hybridProviders(): LoadedProviderRegistry {
  const providerConfig: ProviderConfig = {
    configVersion: 1,
    providers: {
      claude: { type: "claude-code", catalog: "models-dev" },
      openai: { type: "openai", catalog: "models-dev" },
    },
  };
  const auth = { openai: { type: "api-key" as const, key: "test-key" } };
  return {
    config: providerConfig,
    auth,
    registry: createAiProviderRegistry(providerConfig, auth),
    supersededProviderIds: [],
  };
}

type MaterializeCall = {
  modelId: string;
  cwd: string;
  toolNames: string[];
  builtInTools: readonly string[];
  nativeSession: ClaudeNativeSessionStart | undefined;
  reasoning: string | undefined;
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
  rejectForks?: boolean;
  missingUsage?: boolean;
  calls?: MaterializeCall[];
  runs?: FakeClaudeRun[];
}): typeof materializeClaudeCodeRun {
  return async (input) => {
    options.calls?.push({
      modelId: input.modelId,
      cwd: input.cwd,
      toolNames: Object.keys(input.tools),
      builtInTools: [...(input.builtInTools ?? [])],
      nativeSession: input.nativeSession,
      reasoning: input.reasoning,
    });
    if (options.rejectForks && input.nativeSession?.mode === "fork") {
      throw new ClaudeNativeSessionPreflightError([
        { code: "source-preflight-missing", message: "test source is missing" },
      ]);
    }
    const requestedSessionId =
      input.nativeSession?.mode === "ephemeral" ? null : (input.nativeSession?.sessionId ?? null);
    if (requestedSessionId === null) throw new Error("expected a persistent Claude test session");
    const sourceSessionId =
      input.nativeSession?.mode === "fork" ? input.nativeSession.baseSessionId : null;
    let disposed = false;
    const run: FakeClaudeRun = {
      agentModel: options.agentModel,
      continuationModel: options.agentModel,
      createUtilityModel: () => options.utilityModel ?? new MockLanguageModelV4({}),
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
      nativeSession: {
        getObservation: () => ({
          requestedSessionId,
          sourceSessionId,
          initSessionId: requestedSessionId,
          resultSessionId: requestedSessionId,
          contextTokens: options.missingUsage ? null : 100,
          contextMaxTokens: options.missingUsage ? null : 200_000,
          requestedModel: input.modelId,
          initializedModel: input.modelId,
          requestedReasoning: input.reasoning ?? null,
          providerWarnings: [],
          invoked: true,
          requiredObservabilityError: null,
          callbackError: null,
        }),
        waitForObservation: async () => ({
          requestedSessionId,
          sourceSessionId,
          initSessionId: requestedSessionId,
          resultSessionId: requestedSessionId,
          contextTokens: options.missingUsage ? null : 100,
          contextMaxTokens: options.missingUsage ? null : 200_000,
          requestedModel: input.modelId,
          initializedModel: input.modelId,
          requestedReasoning: input.reasoning ?? null,
          providerWarnings: [],
          invoked: true,
          requiredObservabilityError: null,
          callbackError: null,
        }),
        recordWarning() {},
        finalize: async () => {
          await run.dispose();
          return {
            status: "promotable" as const,
            issues: [],
            observations: run.nativeSession!.getObservation(),
            candidate: {
              sessionId: requestedSessionId,
              cwd: input.cwd,
              lastModified: 1_000,
            },
            sourcePreflight:
              sourceSessionId === null
                ? null
                : {
                    sessionId: sourceSessionId,
                    cwd: input.cwd,
                    lastModified:
                      input.nativeSession?.mode === "fork"
                        ? input.nativeSession.expectedSourceLastModified
                        : 0,
                  },
            sourceFinal:
              sourceSessionId === null
                ? null
                : {
                    sessionId: sourceSessionId,
                    cwd: input.cwd,
                    lastModified:
                      input.nativeSession?.mode === "fork"
                        ? input.nativeSession.expectedSourceLastModified
                        : 0,
                  },
          };
        },
      },
      dispose: async () => {
        if (disposed) return;
        disposed = true;
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
  providers?: LoadedProviderRegistry;
  initialModel?: string;
  modelResolver?: SessionServiceOptions["modelResolver"];
  rejectForks?: boolean;
  missingUsage?: boolean;
}) {
  const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-claude-"));
  temporaryDirectories.push(directory);
  const service = new SessionService({
    config: config(options.profileTools),
    databasePath: path.join(directory, "runtime.sqlite"),
    providers: options.providers ?? claudeProviders(),
    modelResolver: options.modelResolver ?? (() => new MockLanguageModelV4({})),
    ...(options.attachCompaction ? { attachCompaction: options.attachCompaction } : {}),
    materializeClaudeCodeRun: fakeClaudeCode({
      agentModel: options.model,
      utilityModel: options.utilityModel,
      deliverSteering: options.deliverSteering,
      calls: options.calls,
      runs: options.runs,
      rejectForks: options.rejectForks,
      missingUsage: options.missingUsage,
    }),
  });
  const session = await service.createSession({
    cwd: directory,
    model: options.initialModel ?? "claude/claude-sonnet-4-6",
    profile: "reader",
    reasoning: "high",
  });
  return { directory, service, session };
}

async function temporaryNamedRuntime(options: {
  rootModel: LanguageModel;
  claudeModel: LanguageModel;
  calls?: MaterializeCall[];
  runs?: FakeClaudeRun[];
}) {
  const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-named-claude-"));
  temporaryDirectories.push(directory);
  const service = new SessionService({
    config: config(),
    databasePath: path.join(directory, "runtime.sqlite"),
    providers: hybridProviders(),
    modelResolver: () => options.rootModel,
    materializeClaudeCodeRun: fakeClaudeCode({
      agentModel: options.claudeModel,
      calls: options.calls,
      runs: options.runs,
    }),
  });
  const session = await service.createSession({
    cwd: directory,
    model: "openai/gpt-5",
    profile: "delegate",
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

  it("persists a fresh binding and forks only the unsynchronized suffix", async () => {
    const model = new MockLanguageModelV4({
      doStream: [textResult("first", "one"), textResult("second", "two")],
    });
    const calls: MaterializeCall[] = [];
    const { service, session } = await temporaryRuntime({ model, calls });

    await collect((await service.startPrompt(session.id, userMessage("first prompt"))).stream);
    const firstState = service.store.getCurrentHistoryState(session.id);
    const firstBinding = service.store.getMiniMainClaudeState({
      sessionId: session.id,
      historyStateId: firstState.id,
      providerId: "claude",
    }).binding;
    if (firstBinding === null) throw new Error("expected first Claude binding");

    await collect((await service.startPrompt(session.id, userMessage("second prompt"))).stream);
    const secondState = service.store.getCurrentHistoryState(session.id);
    const secondBinding = service.store.getMiniMainClaudeState({
      sessionId: session.id,
      historyStateId: secondState.id,
      providerId: "claude",
    }).binding;
    if (secondBinding === null) throw new Error("expected second Claude binding");

    expect(calls.map((call) => call.nativeSession)).toEqual([
      { mode: "fresh", sessionId: firstBinding.claudeSessionId },
      {
        mode: "fork",
        baseSessionId: firstBinding.claudeSessionId,
        sessionId: secondBinding.claudeSessionId,
        expectedSourceLastModified: firstBinding.nativeLastModified,
      },
    ]);
    const firstPayload = model.doStreamCalls[0]?.prompt.filter(
      (message) => message.role !== "system",
    );
    const secondPayload = model.doStreamCalls[1]?.prompt.filter(
      (message) => message.role !== "system",
    );
    expect(firstPayload).toHaveLength(1);
    expect(JSON.stringify(firstPayload)).toContain("first prompt");
    expect(secondPayload).toHaveLength(1);
    expect(JSON.stringify(secondPayload)).toContain("second prompt");
    expect(secondBinding.revision).toBe(firstBinding.revision + 1);
    expect(secondState.providerState).toEqual({
      lastFamily: "claude-code",
      containsCrossFamilyTurns: false,
    });
    service.close();
  });

  it("keeps model and effort changes compatible with the selected history binding", async () => {
    const model = new MockLanguageModelV4({
      doStream: [textResult("first", "one"), textResult("second", "two")],
    });
    const calls: MaterializeCall[] = [];
    const { service, session } = await temporaryRuntime({ model, calls });

    await collect((await service.startPrompt(session.id, userMessage("first prompt"))).stream);
    const firstState = service.store.getCurrentHistoryState(session.id);
    const firstBinding = service.store.getMiniMainClaudeState({
      sessionId: session.id,
      historyStateId: firstState.id,
      providerId: "claude",
    }).binding;
    if (firstBinding === null) throw new Error("expected first Claude binding");
    await service.updateSessionBindings({
      sessionId: session.id,
      clientCommandId: crypto.randomUUID(),
      model: "claude/claude-opus-4-1",
      reasoning: "low",
    });

    await collect((await service.startPrompt(session.id, userMessage("changed model"))).stream);

    expect(calls[1]?.modelId).toBe("claude-opus-4-1");
    expect(calls[1]?.reasoning).toBe("low");
    expect(calls[1]?.nativeSession).toMatchObject({
      mode: "fork",
      baseSessionId: firstBinding.claudeSessionId,
    });
    service.close();
  });

  it("continues one current named-child binding across parent undo, overrides, and restart", async () => {
    const rootModel = new MockLanguageModelV4({
      doStream: [
        delegateResult("first", { model: "claude/claude-sonnet-4-6", effort: "high" }),
        textResult("root-1", "first done"),
        delegateResult("second", { model: "claude/claude-opus-4-1", effort: "low" }),
        textResult("root-2", "second done"),
      ],
    });
    const calls: MaterializeCall[] = [];
    const first = await temporaryNamedRuntime({
      rootModel,
      claudeModel: new MockLanguageModelV4({
        doStream: [textResult("child-1", "first child"), textResult("child-2", "second child")],
      }),
      calls,
    });
    await collect(
      (await first.service.startPrompt(first.session.id, userMessage("first root"))).stream,
    );
    const childSessionId = `sub:${first.session.id}:named:research`;
    const firstBinding = first.service.store.getMiniNamedClaudeState({
      sessionId: childSessionId,
      providerId: "claude",
    }).binding;
    if (firstBinding === null) throw new Error("expected first named Claude binding");

    await first.service.undo({
      sessionId: first.session.id,
      clientCommandId: crypto.randomUUID(),
    });
    expect(
      first.service.store.getMiniNamedClaudeState({
        sessionId: childSessionId,
        providerId: "claude",
      }).binding?.claudeSessionId,
    ).toBe(firstBinding.claudeSessionId);
    await collect(
      (await first.service.startPrompt(first.session.id, userMessage("branch after undo"))).stream,
    );
    const secondBinding = first.service.store.getMiniNamedClaudeState({
      sessionId: childSessionId,
      providerId: "claude",
    }).binding;
    if (secondBinding === null) throw new Error("expected second named Claude binding");
    expect(calls.map((call) => call.nativeSession)).toEqual([
      { mode: "fresh", sessionId: firstBinding.claudeSessionId },
      {
        mode: "fork",
        baseSessionId: firstBinding.claudeSessionId,
        sessionId: secondBinding.claudeSessionId,
        expectedSourceLastModified: firstBinding.nativeLastModified,
      },
    ]);
    expect(calls[1]).toMatchObject({ modelId: "claude-opus-4-1", reasoning: "low" });
    expect(secondBinding.revision).toBe(2);
    expect(
      first.service.store.database
        .query("SELECT COUNT(*) AS count FROM mini_named_claude_bindings WHERE session_id = ?")
        .get(childSessionId),
    ).toEqual({ count: 1 });
    first.service.close();

    const resumedCalls: MaterializeCall[] = [];
    const resumed = new SessionService({
      config: config(),
      databasePath: path.join(first.directory, "runtime.sqlite"),
      providers: hybridProviders(),
      modelResolver: () =>
        new MockLanguageModelV4({
          doStream: [delegateResult("third"), textResult("root-3", "third done")],
        }),
      materializeClaudeCodeRun: fakeClaudeCode({
        agentModel: new MockLanguageModelV4({ doStream: [textResult("child-3", "third child")] }),
        calls: resumedCalls,
      }),
    });
    await resumed.initialize();
    await collect(
      (await resumed.startPrompt(first.session.id, userMessage("after restart"))).stream,
    );
    expect(resumedCalls[0]?.nativeSession).toMatchObject({
      mode: "fork",
      baseSessionId: secondBinding.claudeSessionId,
    });
    resumed.close();
  });

  it("starts named children fresh with text replay across provider boundaries", async () => {
    const childApiModel = new MockLanguageModelV4({
      doStream: [
        textResult("api-child", "ordinary child answer"),
        textResult("api-child-again", "ordinary child again"),
      ],
    });
    const rootModel = new MockLanguageModelV4({
      doStream: [
        delegateResult("ordinary", { model: "openai/child" }),
        textResult("root-1", "ordinary done"),
        delegateResult("claude", { model: "claude/claude-sonnet-4-6" }),
        textResult("root-2", "claude done"),
        delegateResult("ordinary-again", { model: "openai/child" }),
        textResult("root-3", "ordinary again done"),
      ],
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-named-boundary-"));
    temporaryDirectories.push(directory);
    const calls: MaterializeCall[] = [];
    const claudeModel = new MockLanguageModelV4({
      doStream: [textResult("claude-child", "claude child answer")],
    });
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      providers: hybridProviders(),
      modelResolver: (specifier) => (specifier === "openai/child" ? childApiModel : rootModel),
      materializeClaudeCodeRun: fakeClaudeCode({ agentModel: claudeModel, calls }),
    });
    const session = await service.createSession({
      cwd: directory,
      model: "openai/gpt-5",
      profile: "delegate",
      reasoning: "high",
    });
    await collect((await service.startPrompt(session.id, userMessage("ordinary root"))).stream);
    await collect((await service.startPrompt(session.id, userMessage("claude root"))).stream);

    const childSessionId = `sub:${session.id}:named:research`;
    expect(calls[0]?.nativeSession?.mode).toBe("fresh");
    expect(service.store.getCurrentHistoryState(childSessionId).providerState).toEqual({
      lastFamily: "claude-code",
      containsCrossFamilyTurns: true,
    });
    const payload = claudeModel.doStreamCalls[0]?.prompt.filter(
      (message) => message.role !== "system",
    );
    expect(JSON.stringify(payload)).toContain("ordinary");
    expect(JSON.stringify(payload)).toContain("ordinary child answer");
    expect(JSON.stringify(payload)).toContain("claude");
    expect(
      payload?.every(
        (message) =>
          typeof message.content === "string" ||
          message.content.every((part) => part.type === "text"),
      ),
    ).toBe(true);

    await collect(
      (await service.startPrompt(session.id, userMessage("ordinary again root"))).stream,
    );
    const returnPayload = childApiModel.doStreamCalls[1]?.prompt.filter(
      (message) => message.role !== "system",
    );
    expect(JSON.stringify(returnPayload)).toContain("claude child answer");
    expect(
      returnPayload?.every(
        (message) =>
          typeof message.content === "string" ||
          message.content.every((part) => part.type === "text"),
      ),
    ).toBe(true);
    expect(service.store.getCurrentHistoryState(childSessionId).providerState).toEqual({
      lastFamily: "ai-sdk",
      containsCrossFamilyTurns: true,
    });
    service.close();
  });

  it("does not replace a named child's clean binding after child failure", async () => {
    let childCall = 0;
    const rootModel = new MockLanguageModelV4({
      doStream: [
        delegateResult("first", { model: "claude/claude-sonnet-4-6" }),
        textResult("root-1", "first done"),
        delegateResult("failing"),
        textResult("root-2", "failure handled"),
      ],
    });
    const { service, session } = await temporaryNamedRuntime({
      rootModel,
      claudeModel: new MockLanguageModelV4({
        doStream: async () => {
          childCall += 1;
          if (childCall === 1) return textResult("child-1", "clean child");
          throw new Error("child failed");
        },
      }),
    });
    await collect((await service.startPrompt(session.id, userMessage("first"))).stream);
    const childSessionId = `sub:${session.id}:named:research`;
    const cleanBinding = service.store.getMiniNamedClaudeState({
      sessionId: childSessionId,
      providerId: "claude",
    }).binding;
    if (cleanBinding === null) throw new Error("expected clean named binding");

    await collect((await service.startPrompt(session.id, userMessage("fail child"))).stream);
    expect(
      service.store.getMiniNamedClaudeState({
        sessionId: childSessionId,
        providerId: "claude",
      }).binding,
    ).toEqual(cleanBinding);
    expect(service.store.getLatestSelectedRootRun(childSessionId)?.status).toBe("error");
    service.close();
  });

  it("does not replace a named child's clean binding after cancellation", async () => {
    const childEntered = Promise.withResolvers<void>();
    let childCall = 0;
    const rootModel = new MockLanguageModelV4({
      doStream: [
        delegateResult("first", { model: "claude/claude-sonnet-4-6" }),
        textResult("root-1", "first done"),
        delegateResult("cancelled"),
      ],
    });
    const { service, session } = await temporaryNamedRuntime({
      rootModel,
      claudeModel: new MockLanguageModelV4({
        doStream: async ({ abortSignal }) => {
          childCall += 1;
          if (childCall === 1) return textResult("child-1", "clean child");
          return {
            stream: new ReadableStream({
              start(controller) {
                childEntered.resolve();
                const abort = () => controller.error(new DOMException("cancelled", "AbortError"));
                if (abortSignal?.aborted) abort();
                else abortSignal?.addEventListener("abort", abort, { once: true });
              },
            }),
          };
        },
      }),
    });
    await collect((await service.startPrompt(session.id, userMessage("first"))).stream);
    const childSessionId = `sub:${session.id}:named:research`;
    const cleanBinding = service.store.getMiniNamedClaudeState({
      sessionId: childSessionId,
      providerId: "claude",
    }).binding;
    if (cleanBinding === null) throw new Error("expected clean named binding");

    const started = await service.startPrompt(session.id, userMessage("cancel child"));
    const completion = collect(started.stream);
    await childEntered.promise;
    await service.cancel({
      sessionId: session.id,
      runId: started.runId,
      clientCommandId: crypto.randomUUID(),
    });
    await completion;
    expect(
      service.store.getMiniNamedClaudeState({
        sessionId: childSessionId,
        providerId: "claude",
      }).binding,
    ).toEqual(cleanBinding);
    expect(service.store.getLatestSelectedRootRun(childSessionId)?.status).toBe("cancelled");
    service.close();
  });

  it("persists a generated delegated Claude session and forks when its returned name is reused", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-unnamed-claude-"));
    temporaryDirectories.push(directory);
    let generatedSessionName: string | undefined;
    let rootCall = 0;
    const rootModel = new MockLanguageModelV4({
      doStream: async () => {
        rootCall += 1;
        if (rootCall === 1) {
          return delegateResult("first", {
            model: "claude/claude-sonnet-4-6",
            sessionName: null,
          });
        }
        if (rootCall === 2) return textResult("root-1", "first done");
        if (rootCall === 3) {
          if (generatedSessionName === undefined)
            throw new Error("expected generated session name");
          return delegateResult("second", {
            model: "claude/claude-sonnet-4-6",
            sessionName: generatedSessionName,
          });
        }
        return textResult("root-2", "second done");
      },
    });
    const childModel = new MockLanguageModelV4({
      doStream: [textResult("child-1", "first answer"), textResult("child-2", "second answer")],
    });
    const calls: MaterializeCall[] = [];
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      providers: hybridProviders(),
      modelResolver: () => rootModel,
      materializeClaudeCodeRun: fakeClaudeCode({ agentModel: childModel, calls }),
    });
    const session = await service.createSession({
      cwd: directory,
      model: "openai/gpt-5",
      profile: "delegate",
      reasoning: "high",
    });
    const firstChunks = await collect(
      (await service.startPrompt(session.id, userMessage("delegate first"))).stream,
    );

    const childPrefix = `sub:${session.id}:named:`;
    const child = service.store
      .listSessions()
      .find((candidate) => candidate.id.startsWith(childPrefix));
    if (child === undefined) throw new Error("expected generated child session");
    generatedSessionName = child.id.slice(childPrefix.length);
    expect(generatedSessionName).toMatch(/^child-[0-9a-f]{8}$/u);
    expect(JSON.stringify(firstChunks)).toContain(`"sessionName":"${generatedSessionName}"`);
    const firstBinding = service.store.getMiniNamedClaudeState({
      sessionId: child.id,
      providerId: "claude",
    }).binding;
    if (firstBinding === null) throw new Error("expected generated child binding");

    await collect(
      (await service.startPrompt(session.id, userMessage("reuse returned name"))).stream,
    );

    const secondBinding = service.store.getMiniNamedClaudeState({
      sessionId: child.id,
      providerId: "claude",
    }).binding;
    if (secondBinding === null) throw new Error("expected continued generated child binding");
    expect(calls.map((call) => call.nativeSession)).toEqual([
      { mode: "fresh", sessionId: firstBinding.claudeSessionId },
      {
        mode: "fork",
        baseSessionId: firstBinding.claudeSessionId,
        sessionId: secondBinding.claudeSessionId,
        expectedSourceLastModified: firstBinding.nativeLastModified,
      },
    ]);
    const suffix = childModel.doStreamCalls[1]?.prompt.filter(
      (message) => message.role !== "system",
    );
    expect(suffix).toHaveLength(1);
    expect(JSON.stringify(suffix)).toContain("second");
    expect(JSON.stringify(suffix)).not.toContain("first");
    service.close();
  });

  it("selects exact undo and redo bindings and retains an abandoned forward branch", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        textResult("first", "one"),
        textResult("second", "two"),
        textResult("third", "three"),
        textResult("branch", "branch"),
      ],
    });
    const calls: MaterializeCall[] = [];
    const { service, session } = await temporaryRuntime({ model, calls });

    await collect((await service.startPrompt(session.id, userMessage("first"))).stream);
    const firstState = service.store.getCurrentHistoryState(session.id);
    const firstBinding = service.store.getMiniMainClaudeState({
      sessionId: session.id,
      historyStateId: firstState.id,
      providerId: "claude",
    }).binding;
    if (firstBinding === null) throw new Error("expected first Claude binding");
    await collect((await service.startPrompt(session.id, userMessage("second"))).stream);
    const secondState = service.store.getCurrentHistoryState(session.id);
    const secondBinding = service.store.getMiniMainClaudeState({
      sessionId: session.id,
      historyStateId: secondState.id,
      providerId: "claude",
    }).binding;
    if (secondBinding === null) throw new Error("expected second Claude binding");

    await service.undo({ sessionId: session.id, clientCommandId: crypto.randomUUID() });
    await service.redo({ sessionId: session.id, clientCommandId: crypto.randomUUID() });
    await collect((await service.startPrompt(session.id, userMessage("after redo"))).stream);
    expect(calls[2]?.nativeSession).toMatchObject({
      mode: "fork",
      baseSessionId: secondBinding.claudeSessionId,
    });

    await service.undo({ sessionId: session.id, clientCommandId: crypto.randomUUID() });
    await service.undo({ sessionId: session.id, clientCommandId: crypto.randomUUID() });
    expect(service.store.getCurrentHistoryState(session.id).id).toBe(firstState.id);
    await collect((await service.startPrompt(session.id, userMessage("new branch"))).stream);
    expect(calls[3]?.nativeSession).toMatchObject({
      mode: "fork",
      baseSessionId: firstBinding.claudeSessionId,
    });
    expect(
      service.store.getMiniMainClaudeState({
        sessionId: session.id,
        historyStateId: secondState.id,
        providerId: "claude",
      }).binding?.claudeSessionId,
    ).toBe(secondBinding.claudeSessionId);
    service.close();
  });

  it("continues a persisted binding after the Mini runtime restarts", async () => {
    const firstCalls: MaterializeCall[] = [];
    const first = await temporaryRuntime({
      model: new MockLanguageModelV4({ doStream: [textResult("first", "one")] }),
      calls: firstCalls,
    });
    await collect(
      (await first.service.startPrompt(first.session.id, userMessage("before restart"))).stream,
    );
    const boundState = first.service.store.getCurrentHistoryState(first.session.id);
    const binding = first.service.store.getMiniMainClaudeState({
      sessionId: first.session.id,
      historyStateId: boundState.id,
      providerId: "claude",
    }).binding;
    if (binding === null) throw new Error("expected binding before restart");
    first.service.close();

    const secondCalls: MaterializeCall[] = [];
    const reopened = new SessionService({
      config: config(),
      databasePath: path.join(first.directory, "runtime.sqlite"),
      providers: claudeProviders(),
      modelResolver: () => new MockLanguageModelV4({}),
      materializeClaudeCodeRun: fakeClaudeCode({
        agentModel: new MockLanguageModelV4({ doStream: [textResult("second", "two")] }),
        calls: secondCalls,
      }),
    });
    await reopened.initialize();
    await collect(
      (await reopened.startPrompt(first.session.id, userMessage("after restart"))).stream,
    );

    expect(secondCalls[0]?.nativeSession).toMatchObject({
      mode: "fork",
      baseSessionId: binding.claudeSessionId,
    });
    reopened.close();
  });

  it("starts fresh when effective protected paths change across restart", async () => {
    const first = await temporaryRuntime({
      model: new MockLanguageModelV4({ doStream: [textResult("first", "one")] }),
    });
    await collect(
      (await first.service.startPrompt(first.session.id, userMessage("before scope change")))
        .stream,
    );
    const binding = first.service.store.getMiniMainClaudeState({
      sessionId: first.session.id,
      historyStateId: first.service.store.getCurrentHistoryState(first.session.id).id,
      providerId: "claude",
    }).binding;
    if (binding === null) throw new Error("expected binding before scope change");
    first.service.close();

    const calls: MaterializeCall[] = [];
    const reopened = new SessionService({
      config: config(),
      databasePath: path.join(first.directory, "runtime.sqlite"),
      providers: claudeProviders(),
      modelResolver: () => new MockLanguageModelV4({}),
      protectedToolPaths: [path.join(first.directory, "new-protected-path")],
      materializeClaudeCodeRun: fakeClaudeCode({
        agentModel: new MockLanguageModelV4({ doStream: [textResult("second", "two")] }),
        calls,
      }),
    });
    await reopened.initialize();
    await collect(
      (await reopened.startPrompt(first.session.id, userMessage("after scope change"))).stream,
    );

    expect(calls[0]?.nativeSession).toMatchObject({ mode: "fresh" });
    expect(calls[0]?.nativeSession).not.toMatchObject({
      mode: "fork",
      baseSessionId: binding.claudeSessionId,
    });
    reopened.close();
  });

  it("falls back to a fresh persisted candidate when native fork preflight fails", async () => {
    const model = new MockLanguageModelV4({
      doStream: [textResult("first", "one"), textResult("second", "two")],
    });
    const calls: MaterializeCall[] = [];
    const { service, session } = await temporaryRuntime({ model, calls, rejectForks: true });
    await collect((await service.startPrompt(session.id, userMessage("first"))).stream);
    const sourceState = service.store.getCurrentHistoryState(session.id);
    const sourceBinding = service.store.getMiniMainClaudeState({
      sessionId: session.id,
      historyStateId: sourceState.id,
      providerId: "claude",
    }).binding;
    if (sourceBinding === null) throw new Error("expected source binding");

    await collect((await service.startPrompt(session.id, userMessage("second"))).stream);
    const destination = service.store.getMiniMainClaudeState({
      sessionId: session.id,
      historyStateId: service.store.getCurrentHistoryState(session.id).id,
      providerId: "claude",
    });

    expect(calls.map((call) => call.nativeSession?.mode)).toEqual(["fresh", "fork", "fresh"]);
    expect(destination.binding?.claudeSessionId).not.toBe(sourceBinding.claudeSessionId);
    expect(
      service.store.getMiniMainClaudeState({
        sessionId: session.id,
        historyStateId: sourceState.id,
        providerId: "claude",
      }).binding?.claudeSessionId,
    ).toBe(sourceBinding.claudeSessionId);
    service.close();
  });

  it("uses text-only replay when Mini crosses the Claude provider boundary", async () => {
    const apiModel = new MockLanguageModelV4({
      doStream: [textResult("api-first", "api answer"), textResult("api-second", "api again")],
    });
    const claudeModel = new MockLanguageModelV4({
      doStream: [textResult("claude", "claude answer")],
    });
    const calls: MaterializeCall[] = [];
    const { service, session } = await temporaryRuntime({
      model: claudeModel,
      calls,
      providers: hybridProviders(),
      initialModel: "openai/gpt-5",
      modelResolver: () => apiModel,
    });
    await collect((await service.startPrompt(session.id, userMessage("api prompt"))).stream);
    await service.updateSessionBindings({
      sessionId: session.id,
      clientCommandId: crypto.randomUUID(),
      model: "claude/claude-sonnet-4-6",
    });
    await collect((await service.startPrompt(session.id, userMessage("claude prompt"))).stream);
    const claudeState = service.store.getCurrentHistoryState(session.id);

    expect(calls[0]?.nativeSession?.mode).toBe("fresh");
    expect(claudeState.providerState).toEqual({
      lastFamily: "claude-code",
      containsCrossFamilyTurns: true,
    });
    const claudePayload = claudeModel.doStreamCalls[0]?.prompt.filter(
      (message) => message.role !== "system",
    );
    expect(JSON.stringify(claudePayload)).toContain("api prompt");
    expect(JSON.stringify(claudePayload)).toContain("api answer");
    expect(JSON.stringify(claudePayload)).toContain("claude prompt");

    await service.updateSessionBindings({
      sessionId: session.id,
      clientCommandId: crypto.randomUUID(),
      model: "openai/gpt-5",
    });
    await collect((await service.startPrompt(session.id, userMessage("back to api"))).stream);
    const returnPayload = apiModel.doStreamCalls[1]?.prompt.filter(
      (message) => message.role !== "system",
    );
    expect(JSON.stringify(returnPayload)).toContain("claude answer");
    expect(
      returnPayload?.every(
        (message) =>
          typeof message.content === "string" ||
          message.content.every((part) => part.type === "text"),
      ),
    ).toBe(true);
    service.close();
  });

  it("measures compaction thresholds from transcript occupancy", async () => {
    let thresholdInputSource: string | undefined;
    const { service, session } = await temporaryRuntime({
      model: new MockLanguageModelV4({ doStream: [textResult("answer", "done")] }),
      attachCompaction: async (_agent, options) => {
        thresholdInputSource = options.thresholdInputSource;
        return () => {};
      },
    });

    await collect((await service.startPrompt(session.id, userMessage("hello"))).stream);

    expect(thresholdInputSource).toBe("transcript-estimate");
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

  it("disables native steering injection and commits through the queued history hook", async () => {
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

    expect(runs[0]?.injected).toEqual([]);
    expect(service.store.getSession(session.id).queuedSteeringCount).toBe(1);

    releaseFirstTurn?.();
    await collected;
    expect(service.store.getSession(session.id).queuedSteeringCount).toBe(0);
    expect(
      service.store.getMiniMainClaudeState({
        sessionId: session.id,
        historyStateId: service.store.getCurrentHistoryState(session.id).id,
        providerId: "claude",
      }).binding,
    ).not.toBeNull();
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

    expect(service.store.getSession(session.id).queuedSteeringCount).toBe(1);

    releaseFirstTurn?.();
    await collected;
    expect(service.store.getSession(session.id).queuedSteeringCount).toBe(0);
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
    const calls: MaterializeCall[] = [];
    // Delivery fails, so the entry stays queued and the operator must be able
    // to flush it rather than wait out the whole Claude query.
    const { service, session } = await temporaryRuntime({
      model,
      runs,
      calls,
      deliverSteering: false,
    });

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

    const resultPromise = service.interruptQueuedSteering({
      sessionId: session.id,
      runId,
      clientCommandId: crypto.randomUUID(),
      pendingSteerCommandIds: [],
    });
    releaseFirstTurn?.();
    const result = await resultPromise;

    expect(result.status).toBe("interrupted");
    expect(runs[0]?.interrupts).toBe(1);

    await collected;
    expect(calls.map((call) => call.nativeSession?.mode)).toEqual(["fresh", "fresh"]);
    const binding = service.store.getMiniMainClaudeState({
      sessionId: session.id,
      historyStateId: service.store.getCurrentHistoryState(session.id).id,
      providerId: "claude",
    }).binding;
    expect(binding?.claudeSessionId).toBe(
      calls[1]?.nativeSession?.mode === "fresh" ? calls[1].nativeSession.sessionId : undefined,
    );
    service.close();
  });

  it("cancels before lazy Claude materialization without starting a native query", async () => {
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
    expect(runs).toHaveLength(0);

    releaseFirstTurn?.();
    await collected;
    expect(runs).toHaveLength(0);
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
    await reopened.initialize();
    expect(reopened.getMessages(session.id)).toEqual(messages);
    reopened.close();
  });

  it("does not materialize Claude when agent construction fails before the first call", async () => {
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
    expect(runs).toHaveLength(0);
    service.close();
  });

  it("drops steering that was never durably delivered when the run is cancelled", async () => {
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
    await service.steer({
      sessionId: session.id,
      runId,
      clientCommandId: crypto.randomUUID(),
      message: { id: "steer-1", role: "user", parts: [{ type: "text", text: "use typescript" }] },
    });
    await service.cancel({ sessionId: session.id, runId, clientCommandId: crypto.randomUUID() });

    releaseFirstTurn?.();
    await collected;

    expect(runs[0]?.injected).toEqual([]);
    const messages = service.store.getModelMessages(session.id);
    expect(JSON.stringify(messages)).not.toContain("use typescript");
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
    expect(
      service.store.getMiniMainClaudeState({
        sessionId: session.id,
        historyStateId: service.store.getCurrentHistoryState(session.id).id,
        providerId: "claude",
      }).binding,
    ).toBeNull();
    service.close();
  });

  it("keeps successful output but does not bind when native usage is missing", async () => {
    const { service, session } = await temporaryRuntime({
      model: new MockLanguageModelV4({ doStream: [textResult("answer", "visible answer")] }),
      missingUsage: true,
    });

    const started = await service.startPrompt(session.id, userMessage("hello"));
    await collect(started.stream);

    expect(service.store.getRun(started.runId).status).toBe("completed");
    expect(JSON.stringify(service.store.getModelMessages(session.id))).toContain("visible answer");
    expect(
      service.store.getMiniMainClaudeState({
        sessionId: session.id,
        historyStateId: service.store.getCurrentHistoryState(session.id).id,
        providerId: "claude",
      }).binding,
    ).toBeNull();
    service.close();
  });
});
