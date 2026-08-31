import {
  type MiniLilacRuntimeChunk,
  describe,
  expect,
  it,
  tmpdir,
  path,
  MockLanguageModelV4,
  simulateReadableStream,
  Result,
  SessionService,
  MiniLilacStoreOperationRejected,
  temporaryDirectories,
  mkdtemp,
  textResult,
  textResultWithOpenAIItemId,
  streamErrorResult,
  userMessage,
  steeringMessage,
  config,
  IMMEDIATE_TRANSIENT_RETRY,
  temporaryRuntime,
  loadedProviders,
  collect,
} from "./session-runtime-test-support";

describe("SessionService", () => {
  it("strips Codex OAuth item IDs only from second-turn outbound messages", async () => {
    let callCount = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        callCount += 1;
        return callCount === 1
          ? textResultWithOpenAIItemId("answer-1", "first answer", "msg_first")
          : textResult("answer-2", "second answer");
      },
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-codex-replay-"));
    temporaryDirectories.push(directory);
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
      providers: loadedProviders(["oauth"]),
    });
    const session = await service.createSession({
      cwd: directory,
      model: "oauth/mock",
      profile: "reader",
      reasoning: "high",
    });

    await collect((await service.startPrompt(session.id, userMessage("first"))).stream);
    const afterFirstTurn = service.store.getModelMessages(session.id);
    expect(JSON.stringify(afterFirstTurn)).toContain("msg_first");

    await collect((await service.startPrompt(session.id, userMessage("second"))).stream);

    expect(model.doStreamCalls).toHaveLength(2);
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).not.toContain("msg_first");
    expect(model.doStreamCalls[1]?.providerOptions).toEqual({
      openai: {
        store: false,
        include: ["reasoning.encrypted_content"],
        reasoningSummary: "detailed",
      },
    });
    expect(JSON.stringify(service.store.getModelMessages(session.id))).toContain("msg_first");
    service.close();
  });

  it("retries a transient Codex stream failure before output starts", async () => {
    let callCount = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        callCount += 1;
        return callCount === 1
          ? streamErrorResult({ code: "server_is_overloaded" })
          : textResult("recovered", "recovered answer");
      },
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-codex-retry-"));
    temporaryDirectories.push(directory);
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
      providers: loadedProviders(["oauth"]),
      transientModelRetry: IMMEDIATE_TRANSIENT_RETRY,
    });
    const session = await service.createSession({
      cwd: directory,
      model: "oauth/mock",
      profile: "reader",
      reasoning: "high",
    });

    const chunks = await collect(
      (await service.startPrompt(session.id, userMessage("retry overload"))).stream,
    );

    expect(callCount).toBe(2);
    expect(JSON.stringify(chunks)).toContain("recovered answer");
    expect(service.getSnapshot(session.id).status).toBe("idle");
    service.close();
  }, 10_000);

  it("retries a Codex stream failure after partial output", async () => {
    let callCount = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        callCount += 1;
        return callCount === 1
          ? streamErrorResult({ code: "server_is_overloaded" }, "partial answer")
          : textResult("recovered", "recovered answer");
      },
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-codex-partial-error-"));
    temporaryDirectories.push(directory);
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
      providers: loadedProviders(["oauth"]),
      transientModelRetry: IMMEDIATE_TRANSIENT_RETRY,
    });
    const session = await service.createSession({
      cwd: directory,
      model: "oauth/mock",
      profile: "reader",
      reasoning: "high",
    });

    const chunks = await collect(
      (await service.startPrompt(session.id, userMessage("recover partial output"))).stream,
    );

    expect(callCount).toBe(2);
    expect(JSON.stringify(chunks)).toContain("partial answer");
    expect(JSON.stringify(chunks)).toContain("recovered answer");
    expect(JSON.stringify(service.store.getModelMessages(session.id))).not.toContain(
      "partial answer",
    );
    expect(JSON.stringify(service.store.getModelMessages(session.id))).toContain(
      "recovered answer",
    );
    expect(service.getSnapshot(session.id).status).toBe("idle");
    service.close();
  });

  it("marks an abandoned streamed tool draft failed before retrying", async () => {
    let callCount = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        callCount += 1;
        if (callCount > 1) return textResult("recovered", "recovered answer");
        return {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-input-start" as const,
                id: "draft-read",
                toolName: "read",
                providerExecuted: false,
              },
              {
                type: "tool-input-delta" as const,
                id: "draft-read",
                delta: '{"path":"unfinished',
              },
              { type: "error" as const, error: { code: "server_is_overloaded" } },
            ],
          }),
        };
      },
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-codex-tool-draft-retry-"));
    temporaryDirectories.push(directory);
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
      providers: loadedProviders(["oauth"]),
      transientModelRetry: IMMEDIATE_TRANSIENT_RETRY,
    });
    const session = await service.createSession({
      cwd: directory,
      model: "oauth/mock",
      profile: "reader",
      reasoning: "high",
    });

    const chunks = await collect(
      (await service.startPrompt(session.id, userMessage("recover tool draft"))).stream,
    );

    expect(callCount).toBe(2);
    expect(JSON.stringify(chunks)).toContain("Model turn interrupted; tool was not executed");
    expect(JSON.stringify(chunks)).toContain("recovered answer");
    expect(service.getSnapshot(session.id).status).toBe("idle");
    service.close();
  });

  it("does not add turn-level retries for OpenAI API-key models", async () => {
    let callCount = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        callCount += 1;
        return streamErrorResult({ code: "server_is_overloaded" });
      },
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-openai-no-retry-"));
    temporaryDirectories.push(directory);
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
      providers: loadedProviders(["oauth"]),
    });
    const session = await service.createSession({
      cwd: directory,
      model: "api/mock",
      profile: "reader",
      reasoning: "high",
    });

    await collect((await service.startPrompt(session.id, userMessage("fail once"))).stream);

    expect(callCount).toBe(1);
    expect(service.getSnapshot(session.id).status).toBe("error");
    service.close();
  });

  it("requests detailed reasoning summaries for direct OpenAI API-key providers", async () => {
    let callCount = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        callCount += 1;
        return callCount === 1
          ? textResultWithOpenAIItemId("answer-1", "first answer", "msg_api_key")
          : textResult("answer-2", "second answer");
      },
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-openai-replay-"));
    temporaryDirectories.push(directory);
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
      providers: loadedProviders(["oauth"]),
    });
    const session = await service.createSession({
      cwd: directory,
      model: "api/mock",
      profile: "reader",
      reasoning: "high",
    });

    await collect((await service.startPrompt(session.id, userMessage("first"))).stream);
    await collect((await service.startPrompt(session.id, userMessage("second"))).stream);

    // Direct OpenAI providers request detailed summaries but keep replay metadata intact.
    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain("msg_api_key");
    expect(model.doStreamCalls[1]?.providerOptions).toEqual({
      openai: { reasoningSummary: "detailed" },
    });
    service.close();
  });

  it("leaves non-OpenAI provider types without reasoning provider options", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => textResult("answer", "an answer"),
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-non-openai-"));
    temporaryDirectories.push(directory);
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
      providers: loadedProviders(["oauth"]),
    });
    const session = await service.createSession({
      cwd: directory,
      model: "other/mock",
      profile: "reader",
      reasoning: "high",
    });

    await collect((await service.startPrompt(session.id, userMessage("hi"))).stream);

    expect(model.doStreamCalls[0]?.providerOptions).toBeUndefined();
    service.close();
  });

  it("persists and reconstructs provider parts, metadata, data URLs, and usage once", async () => {
    const providerMetadata = { test: { itemId: "provider-item" } };
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "custom", kind: "test.redacted", providerMetadata },
            {
              type: "source",
              sourceType: "url",
              id: "url-source",
              url: "https://example.test/source",
              title: "URL source",
              providerMetadata,
            },
            {
              type: "source",
              sourceType: "document",
              id: "document-source",
              mediaType: "application/pdf",
              title: "Document source",
              filename: "source.pdf",
              providerMetadata,
            },
            {
              type: "file",
              mediaType: "text/plain",
              data: { type: "data", data: "ZmlsZQ==" },
              providerMetadata,
            },
            {
              type: "reasoning-file",
              mediaType: "application/json",
              data: { type: "data", data: "e30=" },
              providerMetadata,
            },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: {
                inputTokens: { total: 12, noCache: 7, cacheRead: 3, cacheWrite: 2 },
                outputTokens: { total: 8, text: 5, reasoning: 3 },
                raw: { billed_tokens: 18 },
              },
            },
          ],
        }),
      },
    });
    const { service, session } = await temporaryRuntime(model);
    const started = await service.startPrompt(session.id, userMessage("provider parts"));
    const streamed = await collect(started.stream);
    const chunks = streamed.filter((chunk) => chunk.type !== "data-streamCursor");
    const providerChunks = chunks.filter((chunk) =>
      ["custom", "source-url", "source-document", "file", "reasoning-file"].includes(chunk.type),
    );

    expect(providerChunks).toEqual([
      { type: "custom", kind: "test.redacted", providerMetadata },
      {
        type: "source-url",
        sourceId: "url-source",
        url: "https://example.test/source",
        title: "URL source",
        providerMetadata,
      },
      {
        type: "source-document",
        sourceId: "document-source",
        mediaType: "application/pdf",
        title: "Document source",
        filename: "source.pdf",
        providerMetadata,
      },
      {
        type: "file",
        mediaType: "text/plain",
        url: "data:text/plain;base64,ZmlsZQ==",
        providerMetadata,
      },
      {
        type: "reasoning-file",
        mediaType: "application/json",
        url: "data:application/json;base64,e30=",
        providerMetadata,
      },
    ]);
    expect(await collect(service.replayRun(started.runId, { tail: false }))).toEqual([]);

    const assistant = service.getMessages(session.id).at(-1);
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.parts.map((part) => part.type)).toEqual([
      "data-session",
      "step-start",
      "custom",
      "source-url",
      "source-document",
      "file",
      "reasoning-file",
      "data-session",
    ]);
    expect(assistant?.metadata).toMatchObject({
      model: "test/mock",
      profile: "reader",
      reasoning: "high",
      usage: {
        inputTokens: 12,
        inputTokenDetails: { noCacheTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 2 },
        outputTokens: 8,
        outputTokenDetails: { textTokens: 5, reasoningTokens: 3 },
        totalTokens: 20,
      },
    });
    expect(assistant?.metadata?.createdAt).toBeString();
    service.close();
  });

  it("serializes steer/interrupt/cancel commands and reuses idempotent results", async () => {
    let releaseFirst = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let releaseSecond = () => {};
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let modelCalls = 0;
    const modelStarted = Promise.withResolvers<void>();
    const model = new MockLanguageModelV4({
      doStream: async () => {
        modelCalls += 1;
        modelStarted.resolve();
        await (modelCalls === 1 ? firstGate : secondGate);
        return textResult("cancelled", "too late");
      },
    });
    const { service, session } = await temporaryRuntime(model);
    const started = await service.startPrompt(session.id, userMessage("wait"));
    await modelStarted.promise;

    const first = await service.steer({
      sessionId: session.id,
      runId: started.runId,
      clientCommandId: "steer-command",
      message: steeringMessage("new direction"),
    });
    const interruptPromise = service.interruptQueuedSteering({
      sessionId: session.id,
      runId: started.runId,
      clientCommandId: "interrupt-command",
    });
    releaseFirst();
    const interrupted = await interruptPromise;
    await expect(
      service.cancel({
        sessionId: session.id,
        runId: "stale-run",
        clientCommandId: "stale-cancel",
      }),
    ).rejects.toThrow("not active");
    const cancelled = await service.cancel({
      sessionId: session.id,
      runId: started.runId,
      clientCommandId: "cancel-command",
    });
    expect(first?.status).toBe("queued");
    expect(interrupted?.status).toBe("interrupted");
    expect(cancelled?.status).toBe("cancelled");
    expect(service.getSnapshot(session.id)).toMatchObject({
      activeRunId: started.runId,
      status: "cancelling",
      queuedSteeringCount: 0,
    });

    const duplicate = await service.steer({
      sessionId: session.id,
      runId: started.runId,
      clientCommandId: "steer-command",
      message: steeringMessage("new direction"),
    });
    expect(duplicate).toEqual(first);
    await expect(
      service.steer({
        sessionId: session.id,
        runId: started.runId,
        clientCommandId: "steer-command",
        message: {
          id: "steer-new direction",
          role: "user",
          parts: [
            { type: "text", text: "new direction" },
            {
              type: "file",
              mediaType: "text/plain",
              url: "data:text/plain;base64,Y2hhbmdlZA==",
            },
          ],
        },
      }),
    ).rejects.toThrow("different payload");
    expect(service.getSnapshot(session.id).queuedSteeringCount).toBe(0);
    expect(
      await service.cancel({
        sessionId: session.id,
        runId: started.runId,
        clientCommandId: "cancel-command",
      }),
    ).toEqual(cancelled);
    await expect(
      service.steer({
        sessionId: session.id,
        runId: started.runId,
        clientCommandId: "late-steer",
        message: steeringMessage("must be rejected"),
      }),
    ).rejects.toThrow("not accepting steering");
    expect(
      service.store.getCommandResult(session.id, "late-steer", {
        kind: "steer",
        runId: started.runId,
        payload: { message: steeringMessage("must be rejected") },
      }),
    ).toBeUndefined();
    releaseSecond();
    const chunks = await collect(started.stream);
    const persistedChunks = chunks.filter((chunk) => chunk.type !== "data-streamCursor");
    const controlIds = persistedChunks
      .filter((chunk) => chunk.type === "data-control")
      .map((chunk) => chunk.id);
    expect(controlIds).toEqual(["steer-command", "interrupt-command", "cancel-command"]);
    const finishIndex = persistedChunks.findIndex((chunk) => chunk.type === "finish");
    expect(finishIndex).toBeGreaterThan(controlIds.length - 1);
    expect(
      persistedChunks.slice(finishIndex + 1).some((chunk) => chunk.type === "data-control"),
    ).toBe(false);
    expect(service.store.getRun(started.runId).status).toBe("cancelled");
    expect(service.getSnapshot(session.id)).toMatchObject({
      status: "idle",
      queuedSteeringCount: 0,
    });
    expect(
      await service.cancel({
        sessionId: session.id,
        runId: started.runId,
        clientCommandId: "cancel-command",
      }),
    ).toEqual(cancelled);
    service.close();
  });

  it("replays only an exact completed prompt and rejects changed prompt payload", async () => {
    const model = new MockLanguageModelV4({ doStream: textResult("answer", "done") });
    const { service, session } = await temporaryRuntime(model);
    const message = userMessage("same prompt");
    const first = await service.startPrompt(session.id, message, "prompt-retry");
    await collect(first.stream);

    const retry = await service.startPrompt(session.id, structuredClone(message), "prompt-retry");
    expect(retry.runId).toBe(first.runId);
    expect(await collect(retry.stream)).toEqual(await collect(service.replayRun(first.runId)));
    expect(model.doStreamCalls).toHaveLength(1);
    await expect(
      service.startPrompt(session.id, userMessage("different prompt"), "prompt-retry"),
    ).rejects.toThrow("different payload");
    expect(model.doStreamCalls).toHaveLength(1);
    service.close();
  });

  it("rejects cross-run command ID reuse without affecting the current run", async () => {
    let releaseFirst = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let releaseSecond = () => {};
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let calls = 0;
    const modelStarts = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        modelStarts[calls - 1]?.resolve();
        await (calls === 1 ? firstGate : secondGate);
        return textResult(`answer-${calls}`, "done");
      },
    });
    const { service, session } = await temporaryRuntime(model);
    const first = await service.startPrompt(session.id, userMessage("first"));
    await modelStarts[0]!.promise;
    await service.cancel({
      sessionId: session.id,
      runId: first.runId,
      clientCommandId: "reused-control",
    });
    releaseFirst();
    await collect(first.stream);

    const second = await service.startPrompt(session.id, userMessage("second"));
    await modelStarts[1]!.promise;
    await expect(
      service.cancel({
        sessionId: session.id,
        runId: second.runId,
        clientCommandId: "reused-control",
      }),
    ).rejects.toThrow("different run");
    expect(service.getSnapshot(session.id)).toMatchObject({
      activeRunId: second.runId,
      status: "streaming",
    });

    await service.cancel({
      sessionId: session.id,
      runId: second.runId,
      clientCommandId: "second-cancel",
    });
    releaseSecond();
    await collect(second.stream);
    service.close();
  });

  it("rejects a stale run control without mutating a newer active run", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const secondModelStarted = Promise.withResolvers<void>();
    const model = new MockLanguageModelV4({
      doStream: async () => {
        calls += 1;
        if (calls === 2) {
          secondModelStarted.resolve();
          await gate;
        }
        return textResult(`answer-${calls}`, "done");
      },
    });
    const { service, session } = await temporaryRuntime(model);
    const first = await service.startPrompt(session.id, userMessage("first"));
    await collect(first.stream);
    const second = await service.startPrompt(session.id, userMessage("second"));
    await secondModelStarted.promise;

    await expect(
      service.cancel({
        sessionId: session.id,
        runId: first.runId,
        clientCommandId: "stale-cancel",
      }),
    ).rejects.toThrow("is not active");
    expect(service.getSnapshot(session.id)).toMatchObject({
      activeRunId: second.runId,
      status: "streaming",
    });
    expect(
      service.store.getCommandResult(session.id, "stale-cancel", {
        kind: "cancel",
        runId: first.runId,
        payload: {},
      }),
    ).toBeUndefined();

    await service.cancel({
      sessionId: session.id,
      runId: second.runId,
      clientCommandId: "current-cancel",
    });
    release();
    await collect(second.stream);
    service.close();
  });

  it("rejects controls once terminal completion begins and appends nothing after finish", async () => {
    const model = new MockLanguageModelV4({ doStream: textResult("answer", "done") });
    const { service, session } = await temporaryRuntime(model);
    const started = await service.startPrompt(session.id, userMessage("finish"));
    const reader = started.stream.getReader();
    const chunks: MiniLilacRuntimeChunk[] = [];
    while (!chunks.some((chunk) => chunk.type === "finish")) {
      const next = await reader.read();
      if (next.done) throw new Error("stream closed before finish");
      chunks.push(next.value);
    }

    await expect(
      service.steer({
        sessionId: session.id,
        runId: started.runId,
        clientCommandId: "terminal-steer",
        message: steeringMessage("too late"),
      }),
    ).rejects.toThrow(/not active|not accepting/);
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
    expect(chunks.filter((chunk) => chunk.type !== "data-streamCursor").at(-1)?.type).toBe(
      "finish",
    );
    expect(
      service.store.getCommandResult(session.id, "terminal-steer", {
        kind: "steer",
        runId: started.runId,
        payload: { message: steeringMessage("too late") },
      }),
    ).toBeUndefined();
    service.close();
  });

  it("leaves a failed post-side-effect control pending so retry cannot repeat it", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const modelStarted = Promise.withResolvers<void>();
    const model = new MockLanguageModelV4({
      doStream: async () => {
        modelStarted.resolve();
        await gate;
        return textResult("answer", "done");
      },
    });
    const { service, session } = await temporaryRuntime(model);
    const started = await service.startPrompt(session.id, userMessage("wait"));
    await modelStarted.promise;
    const saveCommandResult = service.store.saveCommandResultResult.bind(service.store);
    service.store.saveCommandResultResult = () =>
      Result.err(
        new MiniLilacStoreOperationRejected({
          operation: "saveCommandResult",
          message: "command result write failed",
        }),
      );

    const request = {
      sessionId: session.id,
      runId: started.runId,
      clientCommandId: "faulted-steer",
      message: steeringMessage("only once"),
    };
    await expect(service.steer(request)).rejects.toThrow("command result write failed");
    expect(service.getSnapshot(session.id).queuedSteeringCount).toBe(1);
    await expect(service.steer(request)).rejects.toThrow("is pending");
    expect(service.getSnapshot(session.id).queuedSteeringCount).toBe(1);

    service.store.saveCommandResultResult = saveCommandResult;
    await service.cancel({
      sessionId: session.id,
      runId: started.runId,
      clientCommandId: "cleanup-cancel",
    });
    release();
    await collect(started.stream);
    service.close();
  });

  it("removes a reservation when command setup fails before its side effect", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const modelStarted = Promise.withResolvers<void>();
    const model = new MockLanguageModelV4({
      doStream: async () => {
        modelStarted.resolve();
        await gate;
        return textResult("answer", "done");
      },
    });
    const { service, session } = await temporaryRuntime(model);
    const started = await service.startPrompt(session.id, userMessage("wait"));
    await modelStarted.promise;
    const markCommandSideEffectStarted = service.store.markCommandSideEffectStartedResult.bind(
      service.store,
    );
    service.store.markCommandSideEffectStartedResult = () =>
      Result.err(
        new MiniLilacStoreOperationRejected({
          operation: "markCommandSideEffectStarted",
          message: "side-effect marker failed",
        }),
      );

    await expect(
      service.steer({
        sessionId: session.id,
        runId: started.runId,
        clientCommandId: "unstarted-steer",
        message: steeringMessage("must not queue"),
      }),
    ).rejects.toThrow("side-effect marker failed");
    expect(
      service.store.database
        .query("SELECT COUNT(*) AS count FROM commands WHERE command_id = 'unstarted-steer'")
        .get(),
    ).toEqual({ count: 0 });

    service.store.markCommandSideEffectStartedResult = markCommandSideEffectStarted;
    await service.cancel({
      sessionId: session.id,
      runId: started.runId,
      clientCommandId: "cleanup-cancel",
    });
    release();
    await collect(started.stream);
    service.close();
  });

  it("atomically rolls back transcript, run, session state, and prompt command", async () => {
    const model = new MockLanguageModelV4({ doStream: textResult("answer", "done") });
    const { service, session } = await temporaryRuntime(model, "reader", true);
    service.store.database.run(`
      CREATE TRIGGER fail_prompt_command BEFORE UPDATE OF run_id ON commands
      WHEN NEW.kind = 'prompt' AND NEW.run_id IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'prompt command fault');
      END;
    `);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        service.startPrompt(session.id, userMessage("must roll back"), "atomic-prompt"),
      ).rejects.toThrow("Mini Lilac SQLite operation failed");
      expect(
        service.store.database.query("SELECT COUNT(*) AS count FROM workspace_snapshots").get(),
      ).toEqual({ count: 0 });
    }
    expect(service.store.getActiveRootRun(session.id)).toBeNull();
    expect(service.getMessages(session.id)).toEqual([]);
    expect(service.store.getModelMessages(session.id)).toEqual([]);
    expect(service.getSnapshot(session.id)).toMatchObject({
      activeRunId: null,
      status: "idle",
    });
    expect(
      service.store.database
        .query("SELECT COUNT(*) AS count FROM commands WHERE command_id = 'atomic-prompt'")
        .get(),
    ).toEqual({ count: 0 });

    service.store.database.run("DROP TRIGGER fail_prompt_command;");
    const retried = await service.startPrompt(
      session.id,
      userMessage("retry succeeds"),
      "atomic-prompt",
    );
    await collect(retried.stream);
    expect(service.store.getRun(retried.runId).status).toBe("completed");
    expect(
      service.store.database.query("SELECT COUNT(*) AS count FROM workspace_snapshots").get(),
    ).toEqual({ count: 1 });
    service.close();
  });

  it("removes unreferenced snapshot rows at startup without deleting shared history snapshots", async () => {
    const model = new MockLanguageModelV4({ doStream: textResult("answer", "done") });
    const { directory, service, session } = await temporaryRuntime(model, "reader", true);
    const started = await service.startPrompt(
      session.id,
      userMessage("create referenced snapshot"),
      "referenced-prompt",
    );
    await collect(started.stream);
    const workspace = service.store.getWorkspaceForSession(session.id);
    const referencedSnapshotId = service.store.getCurrentHistoryState(
      session.id,
    ).workspaceSnapshotId;
    if (referencedSnapshotId === null) throw new Error("missing referenced workspace snapshot");
    const orphanSnapshotId = "orphan-snapshot";
    service.store.createOrReuseWorkspaceSnapshot({
      id: orphanSnapshotId,
      workspaceId: workspace.id,
      rootTreeOid: "f".repeat(40),
      gitRef: "refs/lilac/snapshots/orphan-snapshot",
      formatVersion: 1,
    });
    service.close();

    const reopened = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => new MockLanguageModelV4({}),
    });
    await reopened.initialize();
    expect(reopened.store.getWorkspaceSnapshot(orphanSnapshotId)).toBeNull();
    expect(reopened.store.getWorkspaceSnapshot(referencedSnapshotId)).not.toBeNull();
    reopened.close();
  });
});
