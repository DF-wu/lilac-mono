import {
  type WorkspaceHistoryStoreOptions,
  describe,
  expect,
  it,
  chmod,
  mkdir,
  rm,
  writeFile,
  tmpdir,
  path,
  MockLanguageModelV4,
  SessionService,
  MiniLilacSqliteStore,
  WorkspaceHistoryStore,
  temporaryDirectories,
  mkdtemp,
  textResult,
  userMessage,
  seedOpenHistory,
  ScriptedWorkspaceHistoryStore,
  capturedWorkspace,
  config,
  temporaryRuntime,
  collect,
} from "./session-runtime-test-support";

describe("SessionService", () => {
  it("fails initialization closed when a restore journal has no durable frozen plan", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-missing-restore-plan-"));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    const databasePath = path.join(directory, "runtime.sqlite");
    await mkdir(workspace);
    const managed = path.join(workspace, "managed.txt");
    await writeFile(managed, "target");
    let historyStore: WorkspaceHistoryStore | undefined;
    const initial = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => new MockLanguageModelV4({ doStream: textResult("answer", "response") }),
      attachCompaction: async () => () => {},
      workspaceHistoryStoreFactory: (options) =>
        (historyStore = new WorkspaceHistoryStore(options)),
    });
    const session = await initial.createSession({ cwd: workspace, model: "test/mock" });
    await collect(
      (await initial.startPrompt(session.id, userMessage("prepare"), "prompt-command")).stream,
    );
    await writeFile(managed, "source");
    const updatePhase = initial.store.updateHistoryOperationPhase.bind(initial.store);
    initial.store.updateHistoryOperationPhase = (operationId, phase) => {
      if (phase === "restoring") throw new Error("injected journal gap");
      return updatePhase(operationId, phase);
    };
    await expect(
      initial.undo({ sessionId: session.id, clientCommandId: "missing-plan-undo" }),
    ).rejects.toThrow("injected journal gap");
    const operation = initial.getHistoryRecoveryStatus().navigation[0];
    if (operation === undefined || historyStore === undefined) {
      throw new Error("missing retained restore setup");
    }
    await historyStore.deleteRestorePlan(operation.id);
    initial.close();

    const reopened = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => new MockLanguageModelV4({}),
      attachCompaction: async () => () => {},
    });
    await expect(reopened.initialize()).rejects.toThrow("restore plan");
    expect(reopened.getHistoryRecoveryStatus().navigation).toMatchObject([
      { id: operation.id, phase: "prepared" },
    ]);
    await reopened.abandonHistoryNavigation({
      operationId: operation.id,
      acknowledgePartialWorktree: true,
      message: "operator acknowledged missing durable plan",
    });
    reopened.close();
  });

  it("verification-only recovery retains a verified journal after offline drift", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-navigation-verified-drift-"));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    const databasePath = path.join(directory, "runtime.sqlite");
    await mkdir(workspace);
    const managed = path.join(workspace, "managed.txt");
    await writeFile(managed, "target");
    const initial = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => new MockLanguageModelV4({ doStream: textResult("answer", "response") }),
      attachCompaction: async () => () => {},
    });
    const session = await initial.createSession({ cwd: workspace, model: "test/mock" });
    await collect(
      (await initial.startPrompt(session.id, userMessage("verified"), "prompt-command")).stream,
    );
    await writeFile(managed, "source-drift");
    initial.store.commitHistoryNavigation = () => {
      throw new Error("injected verified crash");
    };
    await expect(
      initial.undo({ sessionId: session.id, clientCommandId: "verified-drift-undo" }),
    ).rejects.toThrow("injected verified crash");
    const operation = initial.getHistoryRecoveryStatus().navigation[0];
    if (operation === undefined) throw new Error("missing verified operation");
    expect(operation.phase).toBe("verified");
    initial.close();
    await writeFile(managed, "offline-edit-must-survive");

    const reopened = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => new MockLanguageModelV4({}),
      attachCompaction: async () => () => {},
      workspaceHistoryStoreFactory: (options) =>
        new WorkspaceHistoryStore({
          ...options,
          testHooks: {
            beforeMutation: () => {
              throw new Error("verified recovery must not materialize");
            },
          },
        }),
    });
    await expect(reopened.initialize()).rejects.toMatchObject({
      code: "filesystem-error",
      operation: "verify restored workspace",
    });
    expect(await Bun.file(managed).text()).toBe("offline-edit-must-survive");
    expect(reopened.getHistoryRecoveryStatus().navigation).toMatchObject([
      { id: operation.id, phase: "verified" },
    ]);
    await reopened.abandonHistoryNavigation({
      operationId: operation.id,
      acknowledgePartialWorktree: true,
      message: "operator acknowledged verified-worktree drift",
    });
    reopened.close();
  });

  it("keeps a prepared restore blocked when Git disappears after journaling", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-navigation-git-after-"));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    const databasePath = path.join(directory, "runtime.sqlite");
    const gitWrapper = path.join(directory, "git-wrapper");
    await mkdir(workspace);
    const managed = path.join(workspace, "managed.txt");
    await writeFile(managed, "target");
    await writeFile(gitWrapper, '#!/bin/sh\nexec git "$@"\n');
    await chmod(gitWrapper, 0o755);
    const storeFactory = (options: WorkspaceHistoryStoreOptions): WorkspaceHistoryStore =>
      new WorkspaceHistoryStore({ ...options, gitExecutable: gitWrapper, platform: "linux" });
    const initial = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => new MockLanguageModelV4({ doStream: textResult("answer", "response") }),
      attachCompaction: async () => () => {},
      workspaceHistoryStoreFactory: storeFactory,
    });
    const session = await initial.createSession({ cwd: workspace, model: "test/mock" });
    await collect(
      (await initial.startPrompt(session.id, userMessage("Git retained"), "prompt-command")).stream,
    );
    await writeFile(managed, "source-drift");
    const updatePhase = initial.store.updateHistoryOperationPhase.bind(initial.store);
    initial.store.updateHistoryOperationPhase = (operationId, phase) => {
      if (phase === "restoring") throw new Error("injected prepared crash");
      return updatePhase(operationId, phase);
    };
    await expect(
      initial.undo({ sessionId: session.id, clientCommandId: "git-after-undo" }),
    ).rejects.toThrow("injected prepared crash");
    const operation = initial.getHistoryRecoveryStatus().navigation[0];
    if (operation === undefined) throw new Error("missing prepared operation");
    initial.close();
    await rm(gitWrapper);

    const reopened = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => new MockLanguageModelV4({}),
      attachCompaction: async () => () => {},
      workspaceHistoryStoreFactory: storeFactory,
    });
    await expect(reopened.initialize()).rejects.toThrow(
      "requires Git for recovery (git-unavailable)",
    );
    expect(reopened.getHistoryRecoveryStatus().navigation).toMatchObject([
      { id: operation.id, phase: "prepared" },
    ]);
    await reopened.abandonHistoryNavigation({
      operationId: operation.id,
      acknowledgePartialWorktree: true,
      message: "operator acknowledged unavailable Git",
    });
    reopened.close();
  });

  it("abandons only the retained navigation and replays a stable command error", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-navigation-abandon-"));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    await mkdir(workspace);
    const managed = path.join(workspace, "managed.txt");
    await writeFile(managed, "target");
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => new MockLanguageModelV4({ doStream: textResult("answer", "response") }),
      attachCompaction: async () => () => {},
      workspaceHistoryStoreFactory: (options) =>
        new WorkspaceHistoryStore({
          ...options,
          testHooks: {
            beforeMutation: () => {
              throw new Error("injected partial restore");
            },
          },
        }),
    });
    const session = await service.createSession({ cwd: workspace, model: "test/mock" });
    await collect(
      (await service.startPrompt(session.id, userMessage("abandon me"), "prompt-command")).stream,
    );
    await writeFile(managed, "source-drift");
    const sourceStateId = service.getSnapshot(session.id).historyStateId;
    await expect(
      service.undo({ sessionId: session.id, clientCommandId: "abandoned-undo" }),
    ).rejects.toThrow("injected partial restore");
    const operation = service.getHistoryRecoveryStatus().navigation[0];
    if (operation === undefined) throw new Error("missing retained navigation");

    const abandoned = await service.abandonHistoryNavigation({
      operationId: operation.id,
      acknowledgePartialWorktree: true,
      message: "operator acknowledged the partial worktree",
    });
    expect(abandoned).toMatchObject({
      code: "history-recovery-abandoned",
      commandId: "abandoned-undo",
    });
    expect(service.getHistoryRecoveryStatus().navigation).toEqual([]);
    expect(service.getSnapshot(session.id).historyStateId).toBe(sourceStateId);
    await expect(
      service.undo({ sessionId: session.id, clientCommandId: "abandoned-undo" }),
    ).rejects.toMatchObject({
      code: "history-recovery-abandoned",
      commandId: "abandoned-undo",
      message: "operator acknowledged the partial worktree",
    });
    service.close();
  });

  it("skips a missing target snapshot discovered before journaling", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-navigation-missing-"));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    await mkdir(workspace);
    const managed = path.join(workspace, "managed.txt");
    await writeFile(managed, "target");
    let historyStore: WorkspaceHistoryStore | undefined;
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => new MockLanguageModelV4({ doStream: textResult("answer", "response") }),
      attachCompaction: async () => () => {},
      workspaceHistoryStoreFactory: (options) =>
        (historyStore = new WorkspaceHistoryStore(options)),
    });
    const session = await service.createSession({ cwd: workspace, model: "test/mock" });
    const prompt = userMessage("lose target object");
    await collect((await service.startPrompt(session.id, prompt, "prompt-command")).stream);
    if (historyStore === undefined) throw new Error("workspace history store was not created");
    await rm(historyStore.storeDirectory, { recursive: true, force: true });
    await writeFile(managed, "source-drift");

    expect(
      await service.undo({ sessionId: session.id, clientCommandId: "missing-undo" }),
    ).toMatchObject({
      status: "undone",
      message: prompt,
      filesystem: { status: "skipped", reason: "snapshot-unavailable" },
    });
    expect(await Bun.file(managed).text()).toBe("source-drift");
    expect(service.getHistoryRecoveryStatus().navigation).toEqual([]);
    service.close();
  });

  it("fails recovery closed when a target snapshot disappears after journaling", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-navigation-missing-after-"));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    const databasePath = path.join(directory, "runtime.sqlite");
    await mkdir(workspace);
    const managed = path.join(workspace, "managed.txt");
    await writeFile(managed, "target");
    let historyStore: WorkspaceHistoryStore | undefined;
    const initial = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => new MockLanguageModelV4({ doStream: textResult("answer", "response") }),
      attachCompaction: async () => () => {},
      workspaceHistoryStoreFactory: (options) =>
        (historyStore = new WorkspaceHistoryStore(options)),
    });
    const session = await initial.createSession({ cwd: workspace, model: "test/mock" });
    await collect(
      (await initial.startPrompt(session.id, userMessage("retain journal"), "prompt-command"))
        .stream,
    );
    await writeFile(managed, "source-drift");
    const updatePhase = initial.store.updateHistoryOperationPhase.bind(initial.store);
    initial.store.updateHistoryOperationPhase = (operationId, phase) => {
      if (phase === "restoring") throw new Error("injected prepared crash");
      return updatePhase(operationId, phase);
    };
    await expect(
      initial.undo({ sessionId: session.id, clientCommandId: "missing-after-undo" }),
    ).rejects.toThrow("injected prepared crash");
    const operation = initial.getHistoryRecoveryStatus().navigation[0];
    if (operation === undefined || historyStore === undefined) {
      throw new Error("missing retained navigation setup");
    }
    initial.close();
    await rm(historyStore.storeDirectory, { recursive: true, force: true });

    const reopened = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => new MockLanguageModelV4({}),
      attachCompaction: async () => () => {},
    });
    await expect(reopened.initialize()).rejects.toThrow("target snapshot is unavailable");
    expect(reopened.getHistoryRecoveryStatus().navigation).toMatchObject([
      { id: operation.id, phase: "prepared" },
    ]);
    expect(reopened.getSnapshot(session.id).historyStateId).toBe(operation.sourceStateId);
    await reopened.abandonHistoryNavigation({
      operationId: operation.id,
      acknowledgePartialWorktree: true,
      message: "operator acknowledged missing recovery objects",
    });
    reopened.close();
  });

  it("aborts an operational undo capture without a journal or cursor movement", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-navigation-capture-fail-"));
    temporaryDirectories.push(directory);
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => new MockLanguageModelV4({ doStream: textResult("answer", "response") }),
      attachCompaction: async () => () => {},
      workspaceHistoryStoreFactory: (options) =>
        new ScriptedWorkspaceHistoryStore(options, async (call, workspaceId) => {
          if (call === 3) throw new Error("injected navigation capture failure");
          return capturedWorkspace(call, workspaceId);
        }),
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });
    await collect(
      (await service.startPrompt(session.id, userMessage("capture first"), "prompt-command"))
        .stream,
    );
    const sourceStateId = service.getSnapshot(session.id).historyStateId;

    await expect(
      service.undo({ sessionId: session.id, clientCommandId: "capture-failed-undo" }),
    ).rejects.toThrow("injected navigation capture failure");
    expect(service.getSnapshot(session.id).historyStateId).toBe(sourceStateId);
    expect(service.getHistoryRecoveryStatus().navigation).toEqual([]);
    expect(
      service.store.database
        .query("SELECT 1 FROM commands WHERE session_id = ? AND command_id = ?")
        .get(session.id, "capture-failed-undo"),
    ).toBeNull();
    service.close();
  });

  for (const unavailable of ["git-unavailable", "platform-unsupported"] as const) {
    it(`navigates transcript-only when ${unavailable}`, async () => {
      const directory = await mkdtemp(path.join(tmpdir(), `mini-lilac-${unavailable}-`));
      temporaryDirectories.push(directory);
      const workspace = path.join(directory, "workspace");
      await mkdir(workspace);
      const service = new SessionService({
        config: config(),
        databasePath: path.join(directory, "runtime.sqlite"),
        modelResolver: () =>
          new MockLanguageModelV4({ doStream: textResult("answer", "response") }),
        attachCompaction: async () => () => {},
        workspaceHistoryStoreFactory: (options) =>
          new WorkspaceHistoryStore({
            ...options,
            ...(unavailable === "git-unavailable"
              ? { gitExecutable: path.join(directory, "missing-git"), platform: "linux" as const }
              : { platform: "win32" as const }),
          }),
      });
      const session = await service.createSession({ cwd: workspace, model: "test/mock" });
      const prompt = userMessage(unavailable);
      await collect((await service.startPrompt(session.id, prompt, "prompt-command")).stream);

      expect(
        await service.undo({ sessionId: session.id, clientCommandId: `${unavailable}-undo` }),
      ).toMatchObject({
        status: "undone",
        message: prompt,
        filesystem: { status: "skipped", reason: unavailable },
      });
      service.close();
    });
  }

  it("allows undo after an error once the actor and run are quiescent", async () => {
    const model = new MockLanguageModelV4({ doStream: textResult("answer", "complete") });
    const { service, session } = await temporaryRuntime(model);
    const rootUser = userMessage("failing prompt");
    await collect((await service.startPrompt(session.id, rootUser)).stream);
    service.store.updateSessionState(session.id, "error", 0, null);
    expect(service.getSnapshot(session.id)).toMatchObject({ status: "error", activeRunId: null });

    expect(
      await service.undo({ sessionId: session.id, clientCommandId: "error-session-undo" }),
    ).toMatchObject({ message: rootUser });
    expect(service.getMessages(session.id)).toEqual([]);
    expect(service.store.getModelMessages(session.id)).toEqual([]);
    service.close();
  });

  it("allows undo after startup recovers an interrupted run", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-crash-undo-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "runtime.sqlite");
    const rootUser = userMessage("interrupted prompt");
    const first = new MiniLilacSqliteStore(databasePath);
    first.createSession({
      id: "crash-session",
      cwd: directory,
      model: "test/mock",
      profile: "reader",
      reasoning: "high",
    });
    seedOpenHistory(first, "crash-session", "interrupted-run", rootUser);
    expect(first.getSession("crash-session")).toMatchObject({
      status: "streaming",
      activeRunId: "interrupted-run",
    });
    first.close();

    const service = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => new MockLanguageModelV4({}),
      attachCompaction: async () => () => {},
    });
    await service.initialize();
    expect(service.getSnapshot("crash-session")).toMatchObject({
      status: "error",
      activeRunId: null,
    });
    expect(service.store.getRun("interrupted-run").status).toBe("error");
    expect(
      await service.undo({
        sessionId: "crash-session",
        clientCommandId: "crash-recovery-undo",
      }),
    ).toMatchObject({ message: rootUser });
    expect(service.getMessages("crash-session")).toEqual([]);
    expect(service.store.getModelMessages("crash-session")).toEqual([]);
    service.close();
  });

  it("rejects undo while a prompt is streaming or cancelling without reserving commands", async () => {
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
    const started = await service.startPrompt(session.id, userMessage("active"), "active-prompt");
    await modelStarted.promise;

    await expect(
      service.undo({ sessionId: session.id, clientCommandId: "active-undo" }),
    ).rejects.toThrow("must be quiescent");
    await expect(
      service.redo({ sessionId: session.id, clientCommandId: "active-redo" }),
    ).rejects.toThrow("must be quiescent");
    expect(
      service.store.database
        .query("SELECT COUNT(*) AS count FROM commands WHERE command_id = 'active-undo'")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      service.store.database
        .query("SELECT COUNT(*) AS count FROM commands WHERE command_id = 'active-redo'")
        .get(),
    ).toEqual({ count: 0 });
    await service.cancel({
      sessionId: session.id,
      runId: started.runId,
      clientCommandId: "active-cancel",
    });
    await expect(
      service.undo({ sessionId: session.id, clientCommandId: "cancelling-undo" }),
    ).rejects.toThrow("must be quiescent");
    await expect(
      service.redo({ sessionId: session.id, clientCommandId: "cancelling-redo" }),
    ).rejects.toThrow("must be quiescent");
    expect(
      service.store.database
        .query("SELECT COUNT(*) AS count FROM commands WHERE command_id = 'cancelling-undo'")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      service.store.database
        .query("SELECT COUNT(*) AS count FROM commands WHERE command_id = 'cancelling-redo'")
        .get(),
    ).toEqual({ count: 0 });
    release();
    await collect(started.stream);
    service.close();
  });

  it("commits quiescent undo instead of leaving an unreserved Stage 4 command", async () => {
    const { service, session } = await temporaryRuntime(
      new MockLanguageModelV4({ doStream: textResult("answer", "done") }),
    );
    await collect((await service.startPrompt(session.id, userMessage("history exists"))).stream);

    await expect(
      service.undo({ sessionId: session.id, clientCommandId: "stage-4-undo" }),
    ).resolves.toMatchObject({ status: "undone" });
    expect(
      service.store.database
        .query("SELECT 1 FROM commands WHERE command_id = 'stage-4-undo'")
        .get(),
    ).not.toBeNull();
    service.close();
  });
});
