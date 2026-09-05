import {
  type AutoCompactionOptions,
  type MiniLilacCancelCompactionResult,
  type MiniLilacUIMessage,
  type LoadedProviderRegistry,
  type ProviderAuth,
  type ProviderConfig,
  describe,
  expect,
  it,
  Database,
  tmpdir,
  path,
  attachAutoCompaction,
  MockLanguageModelV4,
  createAiProviderRegistry,
  SessionService,
  temporaryDirectories,
  mkdtemp,
  textResult,
  userMessage,
  seedCompletedHistory,
  config,
  temporaryRuntime,
  collect,
  compact,
} from "./session-runtime-test-support";

describe("SessionService", () => {
  it("reports compacting status and leaves the transcript intact when cancelled", async () => {
    // Set once the service exists; the model has to reach back into it to cancel
    // mid-summarization, which is the only window a compaction is stoppable in.
    let cancelDuringSummarization: (() => Promise<unknown>) | undefined;
    const summaryModel = new MockLanguageModelV4({
      doStream: async () => {
        await cancelDuringSummarization?.();
        return textResult("summary", "Condensed prior context.");
      },
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-compact-cancel-"));
    temporaryDirectories.push(directory);
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => summaryModel,
      modelLimitsResolver: async () => ({ context: 10_000, output: 1_000 }),
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });
    const cancelResults: MiniLilacCancelCompactionResult[] = [];
    cancelDuringSummarization = async () => {
      const snapshot = service.getSnapshot(session.id);
      expect(snapshot.activeCompactionCommandId).toBe("compact-cancelled");
      cancelResults.push(
        await service.cancelCompaction({
          sessionId: session.id,
          clientCommandId: snapshot.activeCompactionCommandId ?? undefined,
        }),
      );
    };
    seedCompletedHistory(
      service.store,
      session.id,
      [
        { role: "user", content: `old request ${"a".repeat(6_000)}` },
        { role: "assistant", content: `old answer ${"b".repeat(6_000)}` },
        { role: "user", content: "latest request must remain" },
      ],
      [
        userMessage(`old request ${"a".repeat(6_000)}`),
        { id: "assistant-old", role: "assistant", parts: [{ type: "text", text: "old answer" }] },
        userMessage("latest request must remain"),
      ],
    );
    const before = service.store.getModelMessages(session.id);

    const { events, result } = await compact(service, {
      sessionId: session.id,
      clientCommandId: "compact-cancelled",
    });

    expect(events[0]?.phase).toBe("started");
    expect(cancelResults).toEqual([{ status: "cancelling" }]);
    expect(result.phase).toBe("cancelled");
    // Nothing is written until summarization succeeds, so a cancel is a no-op.
    expect(service.store.getModelMessages(session.id)).toEqual(before);
    expect(service.getSnapshot(session.id).status).toBe("idle");
    // Cancelling when nothing is compacting is reported rather than thrown.
    expect(await service.cancelCompaction({ sessionId: session.id })).toEqual({
      status: "inactive",
    });
    // The reserved command is released, so the same id can be retried.
    cancelDuringSummarization = undefined;
    expect(
      (await compact(service, { sessionId: session.id, clientCommandId: "compact-cancelled" }))
        .result.phase,
    ).toBe("completed");
    service.close();
  });

  it("cancels manual compaction when an aborted provider rejects an ordinary Error", async () => {
    const providerReached = Promise.withResolvers<void>();
    const summaryModel = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => {
        if (abortSignal === undefined) throw new Error("Expected compaction abort signal");
        const aborted = new Promise<void>((resolve) => {
          if (abortSignal.aborted) resolve();
          else abortSignal.addEventListener("abort", () => resolve(), { once: true });
        });
        providerReached.resolve();
        await aborted;
        throw new Error("Provider rejected after cancellation");
      },
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-compact-error-cancel-"));
    temporaryDirectories.push(directory);
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => summaryModel,
      modelLimitsResolver: async () => ({ context: 10_000, output: 1_000 }),
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });
    seedCompletedHistory(
      service.store,
      session.id,
      [
        { role: "user", content: `old request ${"a".repeat(6_000)}` },
        { role: "assistant", content: `old answer ${"b".repeat(6_000)}` },
        { role: "user", content: "latest request must remain" },
      ],
      [userMessage("old request"), userMessage("latest request must remain")],
    );
    const before = service.store.getModelMessages(session.id);

    const started = await service.compact({
      sessionId: session.id,
      clientCommandId: "compact-provider-error-cancelled",
    });
    await providerReached.promise;
    expect(await service.cancelCompaction({ sessionId: session.id })).toEqual({
      status: "cancelling",
    });
    const events = (await collect(started.stream)).flatMap((chunk) =>
      chunk.type === "data-compaction" ? [chunk.data] : [],
    );

    expect(events.at(-1)?.phase).toBe("cancelled");
    expect(service.store.getModelMessages(session.id)).toEqual(before);
    expect(service.getSnapshot(session.id).status).toBe("idle");
    service.close();
  });

  it("commits compaction and the idle transition in one store transaction", async () => {
    const summaryModel = new MockLanguageModelV4({
      doStream: async () => textResult("summary", "Condensed prior context."),
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-compact-atomic-"));
    temporaryDirectories.push(directory);
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => summaryModel,
      modelLimitsResolver: async () => ({ context: 10_000, output: 1_000 }),
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });
    seedCompletedHistory(
      service.store,
      session.id,
      [
        { role: "user", content: `old request ${"a".repeat(6_000)}` },
        { role: "assistant", content: `old answer ${"b".repeat(6_000)}` },
        { role: "user", content: "latest request must remain" },
      ],
      [userMessage("old request"), userMessage("latest request must remain")],
    );
    const updateSessionState = service.store.updateSessionState.bind(service.store);
    service.store.updateSessionState = ((sessionId, status, ...rest) => {
      if (status === "idle") throw new Error("idle must be committed atomically");
      return updateSessionState(sessionId, status, ...rest);
    }) as typeof service.store.updateSessionState;

    const { result } = await compact(service, {
      sessionId: session.id,
      clientCommandId: "compact-atomic",
    });

    expect(result.phase).toBe("completed");
    expect(service.store.getSession(session.id).status).toBe("idle");
    expect(JSON.stringify(service.store.getModelMessages(session.id))).toContain(
      "Condensed prior context.",
    );
    service.close();
  });

  it("keeps compacting when the client detaches, and blocks prompts until it commits", async () => {
    // Held open so the compaction is provably still running while the client is
    // gone and while admission is attempted.
    let releaseSummary: (() => void) | undefined;
    const summarizationReached = Promise.withResolvers<void>();
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    const summaryModel = new MockLanguageModelV4({
      doStream: async () => {
        summarizationReached.resolve();
        await summaryGate;
        return textResult("summary", "Condensed prior context.");
      },
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-compact-detach-"));
    temporaryDirectories.push(directory);
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => summaryModel,
      modelLimitsResolver: async () => ({ context: 10_000, output: 1_000 }),
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });
    seedCompletedHistory(
      service.store,
      session.id,
      [
        { role: "user", content: `old request ${"a".repeat(6_000)}` },
        { role: "assistant", content: `old answer ${"b".repeat(6_000)}` },
        { role: "user", content: "latest request must remain" },
      ],
      [
        userMessage(`old request ${"a".repeat(6_000)}`),
        { id: "assistant-old", role: "assistant", parts: [{ type: "text", text: "old answer" }] },
        userMessage("latest request must remain"),
      ],
    );

    const started = await service.compact({
      sessionId: session.id,
      clientCommandId: "compact-detached",
    });
    await summarizationReached.promise;

    // The client goes away mid-compaction.
    await started.stream.cancel();

    expect(service.getSnapshot(session.id).status).toBe("compacting");
    // A prompt would be summarized away by the compaction it raced, so it is
    // refused for as long as the session is compacting.
    await expect(
      service.startPrompt(session.id, userMessage("must not interleave")),
    ).rejects.toThrow(/cannot accept a prompt/);
    // So is a second compaction, and so is an undo.
    await expect(
      service.compact({ sessionId: session.id, clientCommandId: "compact-second" }),
    ).rejects.toThrow(/must be quiescent to compact/);

    // The commit is the only observable moment the detached compaction reaches,
    // so it is what the test waits on rather than a timer.
    const committed = Promise.withResolvers<void>();
    const commitCompaction = service.store.commitHistoryCompaction.bind(service.store);
    service.store.commitHistoryCompaction = ((...args) => {
      const saved = commitCompaction(...args);
      committed.resolve();
      return saved;
    }) as typeof service.store.commitHistoryCompaction;

    releaseSummary?.();
    await committed.promise;

    // It committed with nobody watching.
    expect(service.getSnapshot(session.id).status).toBe("idle");
    expect(JSON.stringify(service.store.getModelMessages(session.id))).toContain(
      "Condensed prior context.",
    );
    await service.shutdown();
  });

  it("refuses to close while a compaction is running", async () => {
    const summarizationReached = Promise.withResolvers<void>();
    let releaseSummary: (() => void) | undefined;
    const summaryGate = new Promise<void>((resolve) => {
      releaseSummary = resolve;
    });
    const summaryModel = new MockLanguageModelV4({
      doStream: async () => {
        summarizationReached.resolve();
        await summaryGate;
        return textResult("summary", "Condensed prior context.");
      },
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-compact-close-"));
    temporaryDirectories.push(directory);
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => summaryModel,
      modelLimitsResolver: async () => ({ context: 10_000, output: 1_000 }),
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });
    seedCompletedHistory(
      service.store,
      session.id,
      [
        { role: "user", content: `old request ${"a".repeat(6_000)}` },
        { role: "assistant", content: `old answer ${"b".repeat(6_000)}` },
        { role: "user", content: "latest request must remain" },
      ],
      [userMessage("old request"), userMessage("latest request must remain")],
    );

    const started = await service.compact({
      sessionId: session.id,
      clientCommandId: "compact-open",
    });
    await summarizationReached.promise;

    expect(() => service.close()).toThrow(/use shutdown\(\)/);

    releaseSummary?.();
    await collect(started.stream);
    await service.shutdown();
  });

  it("cancels a compaction whose admission is still in the lock queue", async () => {
    const summaryModel = new MockLanguageModelV4({
      doStream: async () => textResult("summary", "Condensed prior context."),
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-compact-race-"));
    temporaryDirectories.push(directory);
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => summaryModel,
      modelLimitsResolver: async () => ({ context: 10_000, output: 1_000 }),
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });
    seedCompletedHistory(
      service.store,
      session.id,
      [
        { role: "user", content: `old request ${"a".repeat(6_000)}` },
        { role: "assistant", content: `old answer ${"b".repeat(6_000)}` },
        { role: "user", content: "latest request must remain" },
      ],
      [userMessage("old request"), userMessage("latest request must remain")],
    );
    const before = service.store.getModelMessages(session.id);

    // The cancel is issued while the compact admission still sits in the actor
    // lock queue. It must observe the freshly admitted operation and stop it;
    // answering `inactive` here would let the compaction proceed despite the
    // user's explicit request.
    const startedPromise = service.compact({
      sessionId: session.id,
      clientCommandId: "compact-race",
    });
    const cancelPromise = service.cancelCompaction({ sessionId: session.id });
    const [started, cancel] = await Promise.all([startedPromise, cancelPromise]);

    expect(cancel).toEqual({ status: "cancelling" });
    const events = (await collect(started.stream)).flatMap((chunk) =>
      chunk.type === "data-compaction" ? [chunk.data] : [],
    );
    expect(events.at(-1)?.phase).toBe("cancelled");
    expect(service.store.getModelMessages(session.id)).toEqual(before);
    expect(service.getSnapshot(session.id).status).toBe("idle");
    service.close();
  });

  it("shutdown cancels a running compaction instead of exhausting its grace", async () => {
    const summarizationReached = Promise.withResolvers<void>();
    const summaryModel = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => {
        summarizationReached.resolve();
        // Hangs until aborted, like a provider request mid-flight: shutdown
        // must cancel the compaction rather than wait out its grace period.
        await new Promise<never>((_, reject) => {
          const fail = () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (abortSignal?.aborted) fail();
          else abortSignal?.addEventListener("abort", fail, { once: true });
        });
        return textResult("summary", "unreachable");
      },
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-compact-shutdown-"));
    temporaryDirectories.push(directory);
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => summaryModel,
      modelLimitsResolver: async () => ({ context: 10_000, output: 1_000 }),
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });
    seedCompletedHistory(
      service.store,
      session.id,
      [
        { role: "user", content: `old request ${"a".repeat(6_000)}` },
        { role: "assistant", content: `old answer ${"b".repeat(6_000)}` },
        { role: "user", content: "latest request must remain" },
      ],
      [userMessage("old request"), userMessage("latest request must remain")],
    );

    const started = await service.compact({
      sessionId: session.id,
      clientCommandId: "compact-shutdown",
    });
    await summarizationReached.promise;

    await service.shutdown();

    const events = (await collect(started.stream)).flatMap((chunk) =>
      chunk.type === "data-compaction" ? [chunk.data] : [],
    );
    expect(events.at(-1)?.phase).toBe("cancelled");
  });

  it("manually compacts model context durably while preserving visible messages", async () => {
    const summaryModel = new MockLanguageModelV4({
      doStream: async () => textResult("summary", "Condensed prior context."),
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-manual-compact-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "runtime.sqlite");
    const service = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => summaryModel,
      modelLimitsResolver: async () => ({ context: 10_000, output: 1_000 }),
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });
    const visibleMessages: MiniLilacUIMessage[] = [
      userMessage(`old request ${"a".repeat(6_000)}`),
      { id: "assistant-old", role: "assistant", parts: [{ type: "text", text: "old answer" }] },
      userMessage("latest request must remain"),
    ];
    seedCompletedHistory(
      service.store,
      session.id,
      [
        { role: "user", content: `old request ${"a".repeat(6_000)}` },
        { role: "assistant", content: `old answer ${"b".repeat(6_000)}` },
        { role: "user", content: "latest request must remain" },
      ],
      visibleMessages,
      [
        {
          content: "Survive manual compaction",
          status: "in_progress",
          priority: "high",
        },
      ],
    );

    const request = { sessionId: session.id, clientCommandId: "compact-1" };
    const { events, result } = await compact(service, request);
    expect(result.phase).toBe("completed");
    expect(result.outcome).toBe("compacted");
    expect(result.messageCountAfter).toBeLessThan(result.messageCountBefore);
    // The lifecycle opens with `started` and streams the summary as it generates.
    expect(events[0]?.phase).toBe("started");
    expect(events.some((event) => event.phase === "progress")).toBe(true);
    expect(result.summary).toContain("Condensed prior context.");
    expect(JSON.stringify(service.store.getModelMessages(session.id))).toContain(
      "Condensed prior context.",
    );
    expect(JSON.stringify(summaryModel.doStreamCalls[0]?.prompt)).not.toContain(
      "Survive manual compaction",
    );
    expect(service.getMessages(session.id)).toEqual([
      ...visibleMessages,
      {
        id: "compaction:compact-1",
        role: "assistant",
        parts: [
          {
            type: "data-compaction",
            id: "compact-1",
            data: {
              source: "manual",
              reason: "manual",
              phase: "completed",
              outcome: "compacted",
              messageCountBefore: result.messageCountBefore,
              messageCountAfter: result.messageCountAfter,
              estimatedInputTokensBefore: result.estimatedInputTokensBefore,
              estimatedInputTokensAfter: result.estimatedInputTokensAfter,
              summary: result.summary,
              durationMs: expect.any(Number),
              elapsedMs: expect.any(Number),
              modelCalls: expect.any(Number),
            },
          },
        ],
      },
    ]);
    expect((await compact(service, request)).result).toMatchObject({
      phase: "completed",
      outcome: "compacted",
    });
    await expect(
      service.undo({ sessionId: session.id, clientCommandId: "undo-before-barrier" }),
    ).resolves.toEqual({ status: "empty", clientCommandId: "undo-before-barrier" });

    const afterBarrier = await service.startPrompt(
      session.id,
      userMessage("new request after compaction"),
    );
    await collect(afterBarrier.stream);
    const afterManualCompactionCalls = summaryModel.doStreamCalls.slice(1);
    const providerCall = afterManualCompactionCalls.find((call) =>
      JSON.stringify(call.prompt.at(-1)).includes("session-todos"),
    );
    expect(providerCall).toBeDefined();
    expect(JSON.stringify(providerCall?.prompt.at(-1))).toContain("Survive manual compaction");
    for (const call of afterManualCompactionCalls.filter(
      (candidate) => candidate !== providerCall,
    )) {
      expect(JSON.stringify(call.prompt)).not.toContain("Survive manual compaction");
    }
    expect(JSON.stringify(service.store.getModelMessages(session.id))).toContain(
      "Condensed prior context.",
    );
    service.close();

    const reopened = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => summaryModel,
      modelLimitsResolver: async () => ({ context: 10_000, output: 1_000 }),
    });
    expect((await compact(reopened, request)).result).toMatchObject({
      phase: "completed",
      outcome: "compacted",
    });
    expect(JSON.stringify(reopened.store.getModelMessages(session.id))).toContain(
      "Condensed prior context.",
    );
    expect(JSON.stringify(reopened.getMessages(session.id))).toContain("data-compaction");
    reopened.close();
  });

  it("manually compacts an ungated session whose stored profile no longer exists", async () => {
    const summaryModel = new MockLanguageModelV4({
      doStream: async () => textResult("summary", "Portable context."),
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-removed-profile-compact-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "runtime.sqlite");
    const initial = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => summaryModel,
      modelLimitsResolver: async () => ({ context: 10_000, output: 1_000 }),
    });
    const session = await initial.createSession({ cwd: directory, model: "test/mock" });
    seedCompletedHistory(
      initial.store,
      session.id,
      [
        { role: "user", content: "retained native input" },
        {
          role: "assistant",
          content: [
            {
              type: "custom",
              kind: "openai.compaction",
              providerOptions: {
                openai: {
                  type: "compaction",
                  itemId: "cmp_removed_profile",
                  encryptedContent: "encrypted-removed-profile-state",
                },
                lilac: {
                  serverCompaction: {
                    formatVersion: 1,
                    protocol: "openai-responses-v2",
                    replayKey: "openai:openai/gpt-old",
                    portableSummary: `Portable removed-profile context ${"p".repeat(6_000)}`,
                    estimatedTokens: 1_600,
                  },
                },
              },
            },
          ],
        },
        { role: "user", content: `latest request ${"b".repeat(6_000)}` },
      ],
      [userMessage("visible history")],
    );
    initial.close();

    const database = new Database(databasePath, { strict: true });
    database.query("UPDATE sessions SET profile = ? WHERE id = ?").run("removed", session.id);
    database.close();

    const reopened = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => summaryModel,
      modelLimitsResolver: async () => ({ context: 10_000, output: 1_000 }),
    });
    const { result } = await compact(reopened, {
      sessionId: session.id,
      clientCommandId: "compact-removed-profile",
    });

    expect(result).toMatchObject({ phase: "completed", outcome: "compacted" });
    expect(result.messageCountBefore).toBe(3);
    expect(JSON.stringify(summaryModel.doStreamCalls)).toContain(
      "Portable removed-profile context",
    );
    expect(JSON.stringify(summaryModel.doStreamCalls)).not.toContain(
      "encrypted-removed-profile-state",
    );
    reopened.close();
  });

  it("streams and persists automatic compaction events in visible history", async () => {
    const model = new MockLanguageModelV4({ doStream: textResult("answer", "done") });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-auto-compact-event-"));
    temporaryDirectories.push(directory);
    let resolvedLimits: number | { readonly context: number; readonly output: number } | undefined;
    let thresholdInputSource: string | undefined;
    let mediaScrubbed = false;
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
      modelLimitsResolver: async () => ({ context: 32_000, output: 12_000 }),
      attachCompaction: async (agent, options) => {
        thresholdInputSource = options.thresholdInputSource;
        const encoded = Buffer.alloc(4, 7).toString("base64");
        const transformed = await options.prepareFullModelView?.(
          [
            {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: "media",
                  toolName: "read",
                  output: {
                    type: "content",
                    value: [
                      {
                        type: "file",
                        mediaType: "image/png",
                        data: { type: "data", data: encoded },
                      },
                    ],
                  },
                },
              ],
            },
          ],
          { system: "test", tools: {} },
        );
        mediaScrubbed = transformed !== undefined && !JSON.stringify(transformed).includes(encoded);
        resolvedLimits = await options.resolveContextLimit?.({
          defaultModel: options.model,
          currentModelSpecifier: agent.state.modelSpecifier,
          currentModel: agent.state.model,
          modelCapability: options.modelCapability,
        });
        return agent.subscribe((event) => {
          if (event.type !== "agent_start") return;
          queueMicrotask(() => {
            const base = {
              spec: "test/mock" as const,
              reason: "threshold" as const,
              messageCountBefore: 12,
              observedInputTokens: 8_000,
              inputTokenSource: "provider-usage" as const,
              estimatedInputTokens: 8_000,
              budget: {
                inputBudget: 9_000,
                safeInputBudget: 8_000,
                reservedOutputTokens: 1_000,
              },
            };
            const progress = {
              stage: "history" as const,
              step: 1,
              stepCount: 1,
              pass: 1,
            };
            options.onCompactionStart?.(base);
            options.onProgress?.(progress);
            options.onSummaryDelta?.("Condensed prior context.", progress);
            options.onCompactionEnd?.({
              ...base,
              status: "completed",
              messageCountAfter: 4,
              estimatedInputTokensAfter: 2_000,
              durationMs: 20,
              summary: "Engine anchored summary.",
            });
          });
        });
      },
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });
    const started = await service.startPrompt(session.id, userMessage("trigger compaction"));
    const streamed = await collect(started.stream);

    expect(resolvedLimits).toEqual({ context: 32_000, output: 12_000 });
    expect(thresholdInputSource).toBe("usage");
    expect(mediaScrubbed).toBe(true);
    const compactionChunks = streamed.filter((chunk) => chunk.type === "data-compaction");
    // One chunk id spans the lifecycle so the renderer updates a single entry.
    expect(new Set(compactionChunks.map((chunk) => chunk.id)).size).toBe(1);
    expect(compactionChunks.map((chunk) => chunk.data.phase)).toEqual([
      "started",
      "progress",
      "progress",
      "completed",
    ]);
    // Publication is deferred behind the run's event queue, so each chunk must
    // carry the state captured when it was raised, not whatever came later.
    expect(compactionChunks.at(0)?.data).toMatchObject({ modelCalls: 0, elapsedMs: 0 });
    expect(compactionChunks.at(0)?.data.summary).toBeUndefined();
    expect(compactionChunks.at(1)?.data.summary).toBeUndefined();
    expect(compactionChunks.at(2)?.data.progress).toEqual({
      stage: "history",
      step: 1,
      stepCount: 1,
      pass: 1,
    });
    expect(compactionChunks.at(2)?.data.summary).toBe("Condensed prior context.");
    // The engine's own summary wins at the terminal phase: it is post-truncation
    // and complete, which a throttled delta buffer cannot guarantee.
    expect(compactionChunks.at(-1)?.data.summary).toBe("Engine anchored summary.");
    expect(compactionChunks.at(-1)?.data).toMatchObject({
      source: "automatic",
      reason: "threshold",
      phase: "completed",
      outcome: "compacted",
      messageCountBefore: 12,
      messageCountAfter: 4,
      estimatedInputTokensBefore: 8_000,
      estimatedInputTokensAfter: 2_000,
      modelCalls: 1,
    });
    expect(service.getMessages(session.id).at(-1)?.parts).toContainEqual(
      expect.objectContaining({
        type: "data-compaction",
        data: expect.objectContaining({ phase: "completed", outcome: "compacted" }),
      }),
    );
    service.close();
  });

  it("enables OpenAI server compaction only for its exact configured model override", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-server-compaction-"));
    temporaryDirectories.push(directory);
    const providerConfig: ProviderConfig = {
      configVersion: 1,
      providers: {
        openai: {
          type: "openai",
          catalog: "models-dev",
          models: { "gpt-enabled": { openaiServerCompaction: true } },
        },
        other: { type: "openai", catalog: "models-dev" },
      },
    };
    const auth: ProviderAuth = {
      openai: { type: "api-key", key: "test-openai-key" },
      other: { type: "api-key", key: "test-other-key" },
    };
    const providers: LoadedProviderRegistry = {
      config: providerConfig,
      auth,
      registry: createAiProviderRegistry(providerConfig, auth),
      supersededProviderIds: [],
    };
    const attached: Array<{ model: string; hasServerCompaction: boolean }> = [];
    const model = new MockLanguageModelV4({ doStream: textResult("answer", "done") });
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      providers,
      modelResolver: () => model,
      attachCompaction: async (_agent, options) => {
        attached.push({
          model: options.model,
          hasServerCompaction: options.serverCompaction !== undefined,
        });
        return () => {};
      },
    });

    for (const modelSpecifier of [
      "openai/gpt-enabled",
      "openai/gpt-unmatched",
      "other/gpt-enabled",
    ]) {
      const session = await service.createSession({
        cwd: directory,
        model: modelSpecifier,
        reasoning: "high",
      });
      await collect((await service.startPrompt(session.id, userMessage(modelSpecifier))).stream);
    }

    expect(attached).toEqual([
      { model: "openai/gpt-enabled", hasServerCompaction: true },
      { model: "openai/gpt-unmatched", hasServerCompaction: false },
      { model: "other/gpt-enabled", hasServerCompaction: false },
    ]);
    service.close();
  });

  it("heals a rejected native replay and re-enables later server compaction", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-server-replay-fallback-"));
    temporaryDirectories.push(directory);
    const providerConfig: ProviderConfig = {
      configVersion: 1,
      providers: {
        openai: {
          type: "openai",
          catalog: "models-dev",
          models: { "gpt-enabled": { openaiServerCompaction: true } },
        },
      },
    };
    const auth: ProviderAuth = { openai: { type: "api-key", key: "test-openai-key" } };
    const providers: LoadedProviderRegistry = {
      config: providerConfig,
      auth,
      registry: createAiProviderRegistry(providerConfig, auth),
      supersededProviderIds: [],
    };
    let calls = 0;
    const prompts: string[] = [];
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        calls += 1;
        prompts.push(JSON.stringify(options.prompt));
        if (calls === 1) {
          throw Object.assign(new Error("invalid compaction item"), { statusCode: 400 });
        }
        return textResult("answer", "portable retry succeeded");
      },
    });
    let attachedOptions: AutoCompactionOptions | undefined;
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      providers,
      modelResolver: () => model,
      modelLimitsResolver: async () => ({ context: 100_000, output: 4_000 }),
      attachCompaction: async (agent, options) => {
        attachedOptions = options;
        return await attachAutoCompaction(agent, options);
      },
    });
    const session = await service.createSession({ cwd: directory, model: "openai/gpt-enabled" });
    seedCompletedHistory(
      service.store,
      session.id,
      [
        { role: "user", content: "retained native input" },
        {
          role: "assistant",
          content: [
            {
              type: "custom",
              kind: "openai.compaction",
              providerOptions: {
                openai: {
                  type: "compaction",
                  itemId: "cmp_rejected",
                  encryptedContent: "encrypted-rejected-state",
                },
                lilac: {
                  serverCompaction: {
                    formatVersion: 1,
                    protocol: "openai-responses-v2",
                    replayKey: "openai:openai/gpt-enabled",
                    portableSummary: "Portable replay context.",
                    estimatedTokens: 64,
                  },
                },
              },
            },
          ],
        },
      ],
      [userMessage("visible prior request")],
      undefined,
      undefined,
      { lastFamily: "ai-sdk", containsCrossFamilyTurns: false },
    );

    await collect(
      (await service.startPrompt(session.id, userMessage("continue after native replay"))).stream,
    );

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("encrypted-rejected-state");
    expect(prompts[1]).toContain("Portable replay context.");
    expect(prompts[1]).not.toContain("encrypted-rejected-state");
    expect(JSON.stringify(service.store.getModelMessages(session.id))).not.toContain(
      "encrypted-rejected-state",
    );
    expect(attachedOptions?.serverCompactionEnabled?.()).toBe(true);
    service.close();
  });

  it("rejects binding updates while an actor or run is active", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const modelStarted = Promise.withResolvers<void>();
    const model = new MockLanguageModelV4({
      doStream: async () => {
        modelStarted.resolve();
        await gate;
        return textResult("answer", "complete");
      },
    });
    const { service, session } = await temporaryRuntime(model);
    const started = await service.startPrompt(session.id, userMessage("active bindings"));
    await modelStarted.promise;

    await expect(
      service.updateSessionBindings({
        sessionId: session.id,
        clientCommandId: "active-bindings",
        reasoning: "medium",
      }),
    ).rejects.toThrow("must be quiescent");
    expect(
      service.store.database
        .query("SELECT COUNT(*) AS count FROM commands WHERE command_id = 'active-bindings'")
        .get(),
    ).toEqual({ count: 0 });
    release();
    await collect(started.stream);
    service.close();
  });
});
