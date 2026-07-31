import { describe, expect, it } from "bun:test";
import { createClaudeCode, type ClaudeCodeSettings } from "ai-sdk-provider-claude-code";

import {
  ClaudeNativeSessionPreflightError,
  materializeClaudeCodeRun,
  type ClaudeNativeSessionLifecycle,
  type MaterializedClaudeCodeRun,
} from "../claude-code-run";

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const CANDIDATE_ID = "22222222-2222-4222-8222-222222222222";

function createModelCapture(settings: ClaudeCodeSettings[]) {
  const provider = createClaudeCode();
  return (modelId: string, modelSettings: ClaudeCodeSettings) => {
    settings.push(modelSettings);
    return provider(modelId, modelSettings);
  };
}

async function emitSdkMessage(settings: ClaudeCodeSettings, message: unknown): Promise<void> {
  const callback = settings.onSdkMessage;
  if (!callback) throw new Error("onSdkMessage was not installed");
  await Reflect.apply(callback, undefined, [message]);
}

async function runStopHook(settings: ClaudeCodeSettings): Promise<void> {
  const callback = settings.hooks?.Stop?.[0]?.hooks[0];
  if (!callback) throw new Error("Stop hook was not installed");
  await Reflect.apply(callback, undefined, [
    { hook_event_name: "Stop" },
    undefined,
    { signal: new AbortController().signal },
  ]);
}

function successfulInit(sessionId: string, model = "claude-sonnet-4-6"): unknown {
  return { type: "system", subtype: "init", session_id: sessionId, model };
}

function successfulResult(sessionId: string): unknown {
  return { type: "result", subtype: "success", session_id: sessionId };
}

function nativeSession(run: MaterializedClaudeCodeRun): ClaudeNativeSessionLifecycle {
  if (!run.nativeSession) throw new Error("native session lifecycle was not materialized");
  return run.nativeSession;
}

describe("Claude native session lifecycle", () => {
  it("keeps omitted session mode ephemeral and rejects ephemeral finalization", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const run = await materializeClaudeCodeRun({
      modelId: "sonnet",
      cwd: process.cwd(),
      tools: {},
      execute: () => {
        throw new Error("not called");
      },
      createModel: createModelCapture(settings),
    });

    expect(settings[0]).toMatchObject({ persistSession: false });
    expect(settings[0]?.sessionId).toBeUndefined();
    expect(settings[0]?.resume).toBeUndefined();
    expect(settings[0]?.forkSession).toBeUndefined();
    expect(nativeSession(run).getObservation()).toMatchObject({
      requestedSessionId: null,
      sourceSessionId: null,
      requestedModel: "sonnet",
      requestedReasoning: null,
      invoked: false,
    });
    expect(() => nativeSession(run).finalize()).toThrow(
      "Cannot finalize an ephemeral Claude native session",
    );

    await run.dispose();
  });

  it("materializes a fresh persisted candidate and finalizes authoritative observations", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const cwd = process.cwd();
    let usageCalls = 0;
    let injectorClosed = false;
    const run = await materializeClaudeCodeRun({
      modelId: "opus",
      reasoning: "xhigh",
      cwd,
      tools: {},
      nativeSession: { mode: "fresh", sessionId: CANDIDATE_ID },
      execute: () => {
        throw new Error("not called");
      },
      controller: {
        getContextUsage: async () => {
          usageCalls += 1;
          return { totalTokens: 1_250, maxTokens: 200_000 };
        },
        interrupt: async () => undefined,
      },
      getSessionInfo: async (sessionId, options) => {
        expect(options).toEqual({ dir: cwd });
        return { sessionId, cwd, lastModified: 50 };
      },
      createModel: createModelCapture(settings),
    });
    const agentSettings = settings[0];
    if (!agentSettings) throw new Error("agent settings were not captured");

    expect(agentSettings).toMatchObject({
      persistSession: true,
      sessionId: CANDIDATE_ID,
      settingSources: [],
    });
    expect(agentSettings.resume).toBeUndefined();
    expect(agentSettings.forkSession).toBeUndefined();
    expect(run.continuationModel).toBeDefined();
    expect(agentSettings.hooks?.Stop).toHaveLength(1);
    expect(agentSettings.onSdkMessage).toBeFunction();

    agentSettings.onStreamStart?.({
      inject: () => undefined,
      close: () => {
        injectorClosed = true;
      },
    });
    await emitSdkMessage(agentSettings, successfulInit(CANDIDATE_ID, "claude-opus-4-6"));
    await emitSdkMessage(agentSettings, successfulResult(CANDIDATE_ID));
    nativeSession(run).recordWarning("provider adjusted an unsupported option");
    await runStopHook(agentSettings);
    expect(usageCalls).toBe(1);

    const finalization = await nativeSession(run).finalize();

    expect(finalization).toEqual({
      status: "promotable",
      issues: [],
      observations: {
        requestedSessionId: CANDIDATE_ID,
        sourceSessionId: null,
        initSessionId: CANDIDATE_ID,
        resultSessionId: CANDIDATE_ID,
        contextTokens: 1_250,
        contextMaxTokens: 200_000,
        requestedModel: "opus",
        initializedModel: "claude-opus-4-6",
        requestedReasoning: "xhigh",
        providerWarnings: ["provider adjusted an unsupported option"],
        invoked: true,
        requiredObservabilityError: null,
        callbackError: null,
      },
      candidate: { sessionId: CANDIDATE_ID, cwd, lastModified: 50 },
      sourcePreflight: null,
      sourceFinal: null,
    });
    expect(injectorClosed).toBe(true);
    expect(await nativeSession(run).finalize()).toBe(finalization);
    await run.dispose();

    run.createUtilityModel();
    expect(settings[2]).toMatchObject({
      cwd,
      tools: [],
      settingSources: [],
      persistSession: false,
    });
    expect(settings[2]?.sessionId).toBeUndefined();
    expect(settings[2]?.resume).toBeUndefined();
    expect(settings[2]?.forkSession).toBeUndefined();
  });

  it("interrupts only through the supported query controller", async () => {
    const settings: ClaudeCodeSettings[] = [];
    let interrupts = 0;
    const run = await materializeClaudeCodeRun({
      modelId: "sonnet",
      cwd: process.cwd(),
      tools: {},
      execute: () => {
        throw new Error("not called");
      },
      controller: {
        getContextUsage: async () => ({ totalTokens: 0, maxTokens: 1 }),
        interrupt: async () => {
          interrupts += 1;
        },
      },
      createModel: createModelCapture(settings),
    });

    expect(await run.control.interrupt()).toBe(true);
    expect(interrupts).toBe(1);
    await run.dispose();
    expect(await run.control.interrupt()).toBe(false);
    expect(interrupts).toBe(1);
  });

  it("forks from a preflight snapshot and permits model changes", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const cwd = process.cwd();
    const reads: string[] = [];
    const run = await materializeClaudeCodeRun({
      modelId: "opus",
      reasoning: "high",
      cwd,
      tools: {},
      nativeSession: {
        mode: "fork",
        baseSessionId: SOURCE_ID,
        sessionId: CANDIDATE_ID,
        expectedSourceLastModified: 10,
      },
      execute: () => {
        throw new Error("not called");
      },
      controller: {
        getContextUsage: async () => ({ totalTokens: 5_000, maxTokens: 200_000 }),
        interrupt: async () => undefined,
      },
      getSessionInfo: async (sessionId, options) => {
        reads.push(sessionId);
        expect(options).toEqual({ dir: cwd });
        return {
          sessionId,
          cwd,
          lastModified: sessionId === SOURCE_ID ? 10 : 20,
        };
      },
      createModel: createModelCapture(settings),
    });
    const agentSettings = settings[0];
    if (!agentSettings) throw new Error("agent settings were not captured");

    expect(reads).toEqual([SOURCE_ID]);
    expect(agentSettings).toMatchObject({
      persistSession: true,
      resume: SOURCE_ID,
      forkSession: true,
      sessionId: CANDIDATE_ID,
    });
    expect(settings[1]).toMatchObject({
      persistSession: true,
      resume: CANDIDATE_ID,
    });
    expect(settings[1]?.forkSession).toBeUndefined();
    expect(settings[1]?.sessionId).toBeUndefined();
    await emitSdkMessage(agentSettings, successfulInit(CANDIDATE_ID, "claude-opus-4-6"));
    await emitSdkMessage(agentSettings, successfulResult(CANDIDATE_ID));
    await runStopHook(agentSettings);

    const finalization = await nativeSession(run).finalize();
    expect(finalization.status).toBe("promotable");
    expect(finalization.observations).toMatchObject({
      sourceSessionId: SOURCE_ID,
      requestedModel: "opus",
      initializedModel: "claude-opus-4-6",
      requestedReasoning: "high",
    });
    expect(finalization.sourcePreflight).toEqual({
      sessionId: SOURCE_ID,
      cwd,
      lastModified: 10,
    });
    expect(finalization.sourceFinal).toEqual(finalization.sourcePreflight);
    expect(reads).toEqual([SOURCE_ID, CANDIDATE_ID, SOURCE_ID]);
  });

  it("awaits pending live context capture before reading sessions and disposing", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const cwd = process.cwd();
    const usage = Promise.withResolvers<unknown>();
    const events: string[] = [];
    let injectorClosed = false;
    const run = await materializeClaudeCodeRun({
      modelId: "sonnet",
      cwd,
      tools: {},
      nativeSession: { mode: "fresh", sessionId: CANDIDATE_ID },
      execute: () => {
        throw new Error("not called");
      },
      controller: {
        getContextUsage: () => {
          events.push("usage-requested");
          return usage.promise;
        },
        interrupt: async () => undefined,
      },
      getSessionInfo: async (sessionId) => {
        events.push("session-read");
        return { sessionId, cwd, lastModified: 30 };
      },
      createModel: createModelCapture(settings),
    });
    const agentSettings = settings[0];
    if (!agentSettings) throw new Error("agent settings were not captured");
    agentSettings.onStreamStart?.({
      inject: () => undefined,
      close: () => {
        events.push("injector-closed");
        injectorClosed = true;
      },
    });
    await emitSdkMessage(agentSettings, successfulInit(CANDIDATE_ID));
    await emitSdkMessage(agentSettings, successfulResult(CANDIDATE_ID));
    await runStopHook(agentSettings);

    expect(events).toEqual(["usage-requested"]);
    const finalizationPromise = nativeSession(run).finalize();
    expect(injectorClosed).toBe(false);
    expect(events).toEqual(["usage-requested"]);

    usage.resolve({ totalTokens: 700, maxTokens: 100_000 });
    const finalization = await finalizationPromise;
    expect(finalization.status).toBe("promotable");
    expect(events).toEqual(["usage-requested", "session-read", "injector-closed"]);
  });

  it("reports source mutation and native identity conflicts without throwing", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const cwd = process.cwd();
    let sourceReadCount = 0;
    const run = await materializeClaudeCodeRun({
      modelId: "sonnet",
      cwd,
      tools: {},
      nativeSession: {
        mode: "fork",
        baseSessionId: SOURCE_ID,
        sessionId: CANDIDATE_ID,
        expectedSourceLastModified: 1,
      },
      execute: () => {
        throw new Error("not called");
      },
      controller: {
        getContextUsage: async () => ({ totalTokens: 800, maxTokens: 100_000 }),
        interrupt: async () => undefined,
      },
      getSessionInfo: async (sessionId) => {
        if (sessionId === SOURCE_ID) sourceReadCount += 1;
        return {
          sessionId,
          cwd,
          lastModified: sessionId === SOURCE_ID ? sourceReadCount : 25,
        };
      },
      createModel: createModelCapture(settings),
    });
    const agentSettings = settings[0];
    if (!agentSettings) throw new Error("agent settings were not captured");

    await emitSdkMessage(agentSettings, successfulInit("33333333-3333-4333-8333-333333333333"));
    await emitSdkMessage(agentSettings, successfulInit(CANDIDATE_ID));
    await emitSdkMessage(agentSettings, successfulResult("44444444-4444-4444-8444-444444444444"));
    await emitSdkMessage(agentSettings, successfulResult(CANDIDATE_ID));
    await runStopHook(agentSettings);

    const finalization = await nativeSession(run).finalize();
    expect(finalization.status).toBe("unpromotable");
    expect(finalization.issues.map(({ code }) => code)).toEqual([
      "init-session-id-mismatch",
      "init-session-id-conflict",
      "result-session-id-mismatch",
      "result-session-id-conflict",
      "required-observability-failed",
      "source-last-modified-changed",
    ]);
  });

  it("rejects invalid fork preflight before model construction", async () => {
    const cwd = process.cwd();
    const cases = [
      undefined,
      { sessionId: CANDIDATE_ID, cwd, lastModified: 10 },
      { sessionId: SOURCE_ID, cwd: `${cwd}/other`, lastModified: 10 },
      { sessionId: SOURCE_ID, cwd, lastModified: 11 },
    ];

    for (const metadata of cases) {
      let createCalls = 0;
      const promise = materializeClaudeCodeRun({
        modelId: "sonnet",
        cwd,
        tools: {},
        nativeSession: {
          mode: "fork",
          baseSessionId: SOURCE_ID,
          sessionId: CANDIDATE_ID,
          expectedSourceLastModified: 10,
        },
        execute: () => {
          throw new Error("not called");
        },
        getSessionInfo: async () => metadata,
        createModel: (modelId, settings) => {
          createCalls += 1;
          return createClaudeCode()(modelId, settings);
        },
      });

      await expect(promise).rejects.toBeInstanceOf(ClaudeNativeSessionPreflightError);
      expect(createCalls).toBe(0);
    }
  });

  it("rejects malformed and self-fork persistent IDs before model construction", async () => {
    let createCalls = 0;
    const createModel = (modelId: string, settings: ClaudeCodeSettings) => {
      createCalls += 1;
      return createClaudeCode()(modelId, settings);
    };
    const base = {
      modelId: "sonnet",
      cwd: process.cwd(),
      tools: {},
      execute: () => {
        throw new Error("not called");
      },
      createModel,
    };

    await expect(
      materializeClaudeCodeRun({
        ...base,
        nativeSession: { mode: "fresh", sessionId: "not-a-uuid" },
      }),
    ).rejects.toThrow();
    await expect(
      materializeClaudeCodeRun({
        ...base,
        nativeSession: {
          mode: "fork",
          baseSessionId: SOURCE_ID,
          sessionId: SOURCE_ID,
          expectedSourceLastModified: 10,
        },
      }),
    ).rejects.toThrow("must be distinct");
    expect(createCalls).toBe(0);
  });

  it("turns missing native state and callback failures into bounded observations", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const longError = "x".repeat(5_000);
    const run = await materializeClaudeCodeRun({
      modelId: "sonnet",
      cwd: process.cwd(),
      tools: {},
      nativeSession: { mode: "fresh", sessionId: CANDIDATE_ID },
      execute: () => {
        throw new Error("not called");
      },
      controller: {
        getContextUsage: async () => {
          throw new Error(longError);
        },
        interrupt: async () => undefined,
      },
      getSessionInfo: async () => undefined,
      onSdkMessage: () => {
        throw new Error(longError);
      },
      createModel: createModelCapture(settings),
    });
    const agentSettings = settings[0];
    if (!agentSettings) throw new Error("agent settings were not captured");

    await expect(emitSdkMessage(agentSettings, { type: "system", subtype: "init" })).resolves.toBe(
      undefined,
    );
    await expect(runStopHook(agentSettings)).resolves.toBeUndefined();
    for (let index = 0; index < 40; index += 1) {
      nativeSession(run).recordWarning(`${index}:${"w".repeat(2_000)}`);
    }

    const finalization = await nativeSession(run).finalize();
    expect(finalization.status).toBe("unpromotable");
    expect(finalization.issues.map(({ code }) => code)).toEqual([
      "init-session-id-missing",
      "result-session-id-missing",
      "context-usage-missing",
      "required-observability-failed",
      "candidate-missing",
    ]);
    expect(finalization.observations.callbackError?.length).toBeLessThanOrEqual(2_000);
    expect(finalization.observations.callbackError).toContain("Invalid SDK init message");
    expect(finalization.observations.requiredObservabilityError).toContain(
      "Invalid SDK init message",
    );
    expect(finalization.observations.providerWarnings).toHaveLength(32);
    expect(
      finalization.observations.providerWarnings.every((warning) => warning.length <= 1_000),
    ).toBe(true);
  });

  it("ignores realistic unrelated SDK messages without subtype", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const cwd = process.cwd();
    const run = await materializeClaudeCodeRun({
      modelId: "sonnet",
      cwd,
      tools: {},
      nativeSession: { mode: "fresh", sessionId: CANDIDATE_ID },
      execute: () => {
        throw new Error("not called");
      },
      controller: {
        getContextUsage: async () => ({ totalTokens: 10, maxTokens: 1_000 }),
        interrupt: async () => undefined,
      },
      getSessionInfo: async (sessionId) => ({ sessionId, cwd, lastModified: 100 }),
      createModel: createModelCapture(settings),
    });
    const agentSettings = settings[0];
    if (!agentSettings) throw new Error("agent settings were not captured");

    await emitSdkMessage(agentSettings, {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
      parent_tool_use_id: null,
      uuid: "message-id",
      session_id: CANDIDATE_ID,
    });
    await emitSdkMessage(agentSettings, successfulInit(CANDIDATE_ID));
    await emitSdkMessage(agentSettings, successfulResult(CANDIDATE_ID));
    await runStopHook(agentSettings);

    const finalization = await nativeSession(run).finalize();
    expect(finalization.status).toBe("promotable");
    expect(finalization.observations.callbackError).toBeNull();
  });

  it("does not promote after a required observability callback failure", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const cwd = process.cwd();
    const run = await materializeClaudeCodeRun({
      modelId: "sonnet",
      cwd,
      tools: {},
      nativeSession: { mode: "fresh", sessionId: CANDIDATE_ID },
      execute: () => {
        throw new Error("not called");
      },
      controller: {
        getContextUsage: async () => ({ totalTokens: 10, maxTokens: 1_000 }),
        interrupt: async () => undefined,
      },
      getSessionInfo: async (sessionId) => ({ sessionId, cwd, lastModified: 100 }),
      createModel: createModelCapture(settings),
    });
    const agentSettings = settings[0];
    if (!agentSettings) throw new Error("agent settings were not captured");

    await emitSdkMessage(agentSettings, { type: "system", subtype: "init" });
    await emitSdkMessage(agentSettings, successfulInit(CANDIDATE_ID));
    await emitSdkMessage(agentSettings, successfulResult(CANDIDATE_ID));
    await runStopHook(agentSettings);

    const finalization = await nativeSession(run).finalize();
    expect(finalization.status).toBe("unpromotable");
    expect(finalization.issues.map(({ code }) => code)).toEqual(["required-observability-failed"]);
    expect(finalization.observations.requiredObservabilityError).toContain(
      "Invalid SDK init message",
    );
  });

  it("keeps optional SDK message callback failures promotable", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const cwd = process.cwd();
    const run = await materializeClaudeCodeRun({
      modelId: "sonnet",
      cwd,
      tools: {},
      nativeSession: { mode: "fresh", sessionId: CANDIDATE_ID },
      execute: () => {
        throw new Error("not called");
      },
      controller: {
        getContextUsage: async () => ({ totalTokens: 10, maxTokens: 1_000 }),
        interrupt: async () => undefined,
      },
      getSessionInfo: async (sessionId) => ({ sessionId, cwd, lastModified: 100 }),
      onSdkMessage: () => {
        throw new Error("optional observer failed");
      },
      createModel: createModelCapture(settings),
    });
    const agentSettings = settings[0];
    if (!agentSettings) throw new Error("agent settings were not captured");

    await emitSdkMessage(agentSettings, successfulInit(CANDIDATE_ID));
    await emitSdkMessage(agentSettings, successfulResult(CANDIDATE_ID));
    await runStopHook(agentSettings);

    const finalization = await nativeSession(run).finalize();
    expect(finalization.status).toBe("promotable");
    expect(finalization.observations.requiredObservabilityError).toBeNull();
    expect(finalization.observations.callbackError).toContain("optional observer failed");
  });

  it("returns explicit candidate metadata validation issues", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const cwd = process.cwd();
    const run = await materializeClaudeCodeRun({
      modelId: "sonnet",
      cwd,
      tools: {},
      nativeSession: { mode: "fresh", sessionId: CANDIDATE_ID },
      execute: () => {
        throw new Error("not called");
      },
      controller: {
        getContextUsage: async () => ({ totalTokens: 1, maxTokens: 10 }),
        interrupt: async () => undefined,
      },
      getSessionInfo: async () => ({
        sessionId: SOURCE_ID,
        cwd: `${cwd}/other`,
        lastModified: 100,
      }),
      createModel: createModelCapture(settings),
    });
    const agentSettings = settings[0];
    if (!agentSettings) throw new Error("agent settings were not captured");
    await emitSdkMessage(agentSettings, successfulInit(CANDIDATE_ID));
    await emitSdkMessage(agentSettings, successfulResult(CANDIDATE_ID));
    await runStopHook(agentSettings);

    const finalization = await nativeSession(run).finalize();
    expect(finalization.status).toBe("unpromotable");
    expect(finalization.issues.map(({ code }) => code)).toEqual([
      "candidate-id-mismatch",
      "candidate-cwd-mismatch",
    ]);
    expect(finalization.candidate).toEqual({
      sessionId: SOURCE_ID,
      cwd: `${cwd}/other`,
      lastModified: 100,
    });
  });

  it("retains the latest successful usage but rejects a failed terminal capture", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const cwd = process.cwd();
    let usageCall = 0;
    const run = await materializeClaudeCodeRun({
      modelId: "sonnet",
      cwd,
      tools: {},
      nativeSession: { mode: "fresh", sessionId: CANDIDATE_ID },
      execute: () => {
        throw new Error("not called");
      },
      controller: {
        getContextUsage: async () => {
          usageCall += 1;
          if (usageCall === 2) throw new Error("terminal usage unavailable");
          return { totalTokens: 12, maxTokens: 1_000 };
        },
        interrupt: async () => undefined,
      },
      getSessionInfo: async (sessionId) => ({ sessionId, cwd, lastModified: 100 }),
      createModel: createModelCapture(settings),
    });
    const agentSettings = settings[0];
    if (!agentSettings) throw new Error("agent settings were not captured");
    await emitSdkMessage(agentSettings, successfulInit(CANDIDATE_ID));
    await emitSdkMessage(agentSettings, successfulResult(CANDIDATE_ID));
    await runStopHook(agentSettings);
    expect(await nativeSession(run).waitForObservation()).toMatchObject({
      contextTokens: 12,
      contextMaxTokens: 1_000,
    });
    await runStopHook(agentSettings);
    expect(await nativeSession(run).waitForObservation()).toMatchObject({
      contextTokens: null,
      contextMaxTokens: null,
    });
    expect(nativeSession(run).getObservation()).toMatchObject({
      contextTokens: 12,
      contextMaxTokens: 1_000,
    });

    const finalization = await nativeSession(run).finalize();
    expect(finalization.status).toBe("unpromotable");
    expect(finalization.observations).toMatchObject({
      contextTokens: 12,
      contextMaxTokens: 1_000,
    });
    expect(finalization.issues.map(({ code }) => code)).toEqual([
      "context-usage-missing",
      "required-observability-failed",
    ]);
  });

  it("delivers init and result identities only when freshly observed for that outer call", async () => {
    const settings: ClaudeCodeSettings[] = [];
    const cwd = process.cwd();
    const run = await materializeClaudeCodeRun({
      modelId: "sonnet",
      cwd,
      tools: {},
      nativeSession: { mode: "fresh", sessionId: CANDIDATE_ID },
      execute: () => {
        throw new Error("not called");
      },
      controller: {
        getContextUsage: async () => ({ totalTokens: 25, maxTokens: 1_000 }),
        interrupt: async () => undefined,
      },
      getSessionInfo: async (sessionId) => ({ sessionId, cwd, lastModified: 100 }),
      createModel: createModelCapture(settings),
    });
    const agentSettings = settings[0];
    if (!agentSettings) throw new Error("agent settings were not captured");

    await emitSdkMessage(agentSettings, successfulInit(CANDIDATE_ID));
    await emitSdkMessage(agentSettings, successfulResult(CANDIDATE_ID));
    await runStopHook(agentSettings);
    expect(await nativeSession(run).waitForObservation()).toMatchObject({
      initSessionId: CANDIDATE_ID,
      resultSessionId: CANDIDATE_ID,
      contextTokens: 25,
      contextMaxTokens: 1_000,
    });

    await runStopHook(agentSettings);
    expect(await nativeSession(run).waitForObservation()).toMatchObject({
      initSessionId: null,
      resultSessionId: null,
      contextTokens: 25,
      contextMaxTokens: 1_000,
    });
    expect(nativeSession(run).getObservation()).toMatchObject({
      initSessionId: CANDIDATE_ID,
      resultSessionId: CANDIDATE_ID,
      contextTokens: 25,
      contextMaxTokens: 1_000,
    });
    await run.dispose();
  });

  it("records every portable requested reasoning value without inventing observed effort", async () => {
    const reasonings = [
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "provider-default",
    ] as const;

    for (const reasoning of reasonings) {
      const settings: ClaudeCodeSettings[] = [];
      const run = await materializeClaudeCodeRun({
        modelId: "sonnet",
        reasoning,
        cwd: process.cwd(),
        tools: {},
        execute: () => {
          throw new Error("not called");
        },
        createModel: createModelCapture(settings),
      });

      expect(nativeSession(run).getObservation().requestedReasoning).toBe(reasoning);
      expect(nativeSession(run).getObservation()).not.toHaveProperty("initializedReasoning");
      await run.dispose();
    }
  });
});
