import {
  describe,
  expect,
  it,
  tmpdir,
  path,
  MockLanguageModelV4,
  SessionService,
  MiniLilacDatabaseVersionError,
  MiniLilacSqliteStore,
  temporaryDirectories,
  mkdtemp,
  userMessage,
  seedCompletedHistory,
  seedOpenHistory,
  config,
} from "./session-runtime-test-support";

describe("MiniLilacSqliteStore", () => {
  it("rejects experiment database versions instead of migrating them", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-old-schema-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "runtime.sqlite");
    const original = new MiniLilacSqliteStore(databasePath);
    original.database.run("PRAGMA user_version = 9;");
    original.close();

    expect(() => new MiniLilacSqliteStore(databasePath)).toThrow(MiniLilacDatabaseVersionError);
  });

  it("clears the post-compaction estimate flag on reported usage and model changes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-estimate-flag-"));
    temporaryDirectories.push(directory);
    const store = new MiniLilacSqliteStore(path.join(directory, "runtime.sqlite"));
    store.createSession({
      id: "session-1",
      cwd: directory,
      model: "test/mock",
      profile: "reader",
      reasoning: "high",
    });
    seedCompletedHistory(
      store,
      "session-1",
      [{ role: "user", content: "keep" }],
      [userMessage("keep")],
    );
    const command = { kind: "compact", runId: null, payload: {} } as const;
    const commit = (commandId: string): void => {
      store.reserveCommand("session-1", commandId, command);
      const current = store.getCurrentHistoryState("session-1");
      const result = {
        status: "compacted",
        clientCommandId: commandId,
        messageCountBefore: 1,
        messageCountAfter: 1,
        estimatedInputTokensBefore: 9_000,
        estimatedInputTokensAfter: 1_200,
      } as const;
      store.commitHistoryCompaction({
        sessionId: "session-1",
        commandId,
        request: command,
        expectedCurrentStateId: current.id,
        stateId: `compacted-state:${commandId}`,
        transitionId: `compacted-transition:${commandId}`,
        modelMessages: [{ role: "user", content: "summary" }],
        compactionEvent: {
          source: "manual",
          reason: "manual",
          phase: "completed",
          outcome: "compacted",
          messageCountBefore: result.messageCountBefore,
          messageCountAfter: result.messageCountAfter,
          estimatedInputTokensBefore: result.estimatedInputTokensBefore,
          estimatedInputTokensAfter: result.estimatedInputTokensAfter,
          summary: "summary",
        },
        result,
        workspaceSnapshotId: null,
        workspaceStatus: "unavailable",
        workspaceUnavailableReason: "git-unavailable",
      });
    };

    commit("compact-1");
    expect(store.getSession("session-1")).toMatchObject({
      inputTokens: 1_200,
      inputTokensEstimated: true,
    });

    const transitionId = seedOpenHistory(
      store,
      "session-1",
      "run-1",
      userMessage("reported usage"),
    );
    // Reported usage that happens to equal the estimate is still real usage, so
    // it has to clear the flag rather than read as "nothing changed".
    store.updateActiveRunInputTokens("session-1", "run-1", 1_200);
    expect(store.getSession("session-1")).toMatchObject({
      inputTokens: 1_200,
      inputTokensEstimated: false,
    });

    store.reservePendingRunFinalization({
      runId: "run-1",
      sessionId: "session-1",
      openTransitionId: transitionId,
      modelMessages: store.getModelMessages("session-1"),
      uiMessages: store.getUiMessages("session-1"),
      runStatus: "completed",
      sessionStatus: "idle",
      error: null,
      terminalResult: undefined,
      inputTokens: 1_200,
    });
    store.commitPendingRunFinalization({
      runId: "run-1",
      destinationStateId: "run-1-final",
      workspaceSnapshotId: null,
      workspaceStatus: "unavailable",
      workspaceUnavailableReason: "git-unavailable",
    });
    commit("compact-2");
    expect(store.getSession("session-1").inputTokensEstimated).toBe(true);

    const bindings = {
      kind: "update-bindings",
      runId: null,
      payload: { model: "test/other" },
    } as const;
    store.updateSessionBindings("session-1", "bindings-1", bindings, { model: "test/other" });
    // A model change drops the count; leaving the flag on would render an
    // estimate of nothing.
    const afterBindings = store.getSession("session-1");
    expect(afterBindings.inputTokens).toBeNull();
    expect(afterBindings.inputTokensEstimated).toBe(false);
    store.close();
  });

  it("marks active root and child runs as errors on startup", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-store-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "runtime.sqlite");
    const first = new MiniLilacSqliteStore(databasePath);
    first.createSession({
      id: "session-1",
      cwd: directory,
      model: "test/mock",
      profile: "reader",
      reasoning: "high",
    });
    seedOpenHistory(first, "session-1", "run-1", userMessage("interrupted root"));
    first.createRun({
      id: "child-1",
      sessionId: "session-1",
      parentRunId: "run-1",
      profile: "child",
      depth: 1,
    });
    first.close();

    const recovered = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => new MockLanguageModelV4({}),
    });
    await recovered.initialize();
    expect(recovered.store.getRun("run-1").status).toBe("error");
    expect(recovered.store.getRun("child-1").status).toBe("error");
    expect(
      recovered.store.database
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'run_chunks'")
        .get(),
    ).toBeNull();
    expect(recovered.store.getSession("session-1")).toMatchObject({
      status: "error",
      queuedSteeringCount: 0,
    });
    recovered.close();
  });

  it("retains turn-boundary input usage when startup recovers an interrupted run", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-usage-recovery-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "runtime.sqlite");
    const first = new MiniLilacSqliteStore(databasePath);
    first.createSession({
      id: "session-1",
      cwd: directory,
      model: "test/mock",
      profile: "reader",
      reasoning: "high",
    });
    seedOpenHistory(first, "session-1", "run-1", userMessage("persist usage before the next turn"));

    first.updateActiveRunInputTokens("session-1", "run-1", 37);
    const changesAfterUsage = first.database.query("SELECT total_changes() AS changes").get();
    first.updateActiveRunInputTokens("session-1", "run-1", 37);
    expect(first.database.query("SELECT total_changes() AS changes").get()).toEqual(
      changesAfterUsage,
    );
    first.close();

    const recovered = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => new MockLanguageModelV4({}),
    });
    await recovered.initialize();
    expect(recovered.store.getSession("session-1")).toMatchObject({
      status: "error",
      activeRunId: null,
      inputTokens: 37,
    });
    expect(recovered.store.getRun("run-1").status).toBe("error");
    recovered.close();
  });

  it("uses insertion order when root run timestamps tie", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-run-order-"));
    temporaryDirectories.push(directory);
    const store = new MiniLilacSqliteStore(path.join(directory, "runtime.sqlite"));
    store.createSession({
      id: "session-1",
      cwd: directory,
      model: "test/mock",
      profile: "reader",
      reasoning: "high",
    });
    const olderUser = userMessage("older");
    seedCompletedHistory(
      store,
      "session-1",
      [
        { role: "user", content: "older" },
        { role: "assistant", content: "older answer" },
      ],
      [
        olderUser,
        {
          id: "older-answer",
          role: "assistant",
          parts: [{ type: "text", text: "older answer" }],
        },
      ],
      undefined,
      "older",
    );
    const newerUser = userMessage("newer");
    seedCompletedHistory(
      store,
      "session-1",
      [
        ...store.getModelMessages("session-1"),
        { role: "user", content: "newer" },
        { role: "assistant", content: "newer answer" },
      ],
      [
        ...store.getUiMessages("session-1"),
        newerUser,
        {
          id: "newer-answer",
          role: "assistant",
          parts: [{ type: "text", text: "newer answer" }],
        },
      ],
      undefined,
      "newer",
    );
    store.database
      .query("UPDATE runs SET started_at = ? WHERE session_id = ?")
      .run("2026-07-21T12:00:00.000Z", "session-1");

    expect(store.getLatestSelectedRootRun("session-1")?.id).toBe("newer");
    store.close();
  });

  it("recovers only definitely unstarted command reservations", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-command-recovery-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "runtime.sqlite");
    const request = { kind: "cancel", runId: "run-1", payload: {} };
    const first = new MiniLilacSqliteStore(databasePath);
    first.createSession({
      id: "session-1",
      cwd: directory,
      model: "test/mock",
      profile: "reader",
      reasoning: "high",
    });
    first.reserveCommand("session-1", "unstarted", request);
    first.reserveCommand("session-1", "indeterminate", request);
    first.markCommandSideEffectStarted("session-1", "indeterminate", request);
    first.close();

    const recovered = new MiniLilacSqliteStore(databasePath);
    recovered.recoverInterruptedRuntimeState();
    expect(recovered.getCommandResult("session-1", "unstarted", request)).toBeUndefined();
    expect(() => recovered.getCommandResult("session-1", "indeterminate", request)).toThrow(
      "pending",
    );
    recovered.close();
  });
});
