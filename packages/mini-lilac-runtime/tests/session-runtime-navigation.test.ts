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
  WorkspaceHistoryStore,
  temporaryDirectories,
  mkdtemp,
  textResult,
  userMessage,
  InterceptedWorkspaceHistoryStore,
  config,
  collect,
} from "./session-runtime-test-support";

describe("SessionService", () => {
  it("durably and idempotently undoes root prompts after restart without replaying their run", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-undo-restart-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "runtime.sqlite");
    const firstModel = new MockLanguageModelV4({
      doStream: [
        textResult("first-answer", "first response"),
        textResult("second-answer", "second response"),
      ],
    });
    const firstService = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => firstModel,
      attachCompaction: async () => () => {},
    });
    const session = await firstService.createSession({
      id: "undo-session",
      cwd: directory,
      model: "test/mock",
      profile: "reader",
    });
    const firstUser = userMessage("first prompt");
    const firstRun = await firstService.startPrompt(session.id, firstUser, "first-prompt");
    await collect(firstRun.stream);
    const expectedPrefix = firstService.store.getModelMessages(session.id);
    const secondUser = {
      id: "multipart-user",
      role: "user" as const,
      parts: [
        { type: "text" as const, text: "second prompt" },
        {
          type: "file" as const,
          mediaType: "image/png",
          filename: "image.png",
          url: "data:image/png;base64,AA==",
        },
      ],
    };
    const secondRun = await firstService.startPrompt(session.id, secondUser, "second-prompt");
    await collect(secondRun.stream);
    firstService.close();

    const service = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => new MockLanguageModelV4({ doStream: textResult("unused", "unused") }),
      attachCompaction: async () => () => {},
    });
    const undone = await service.undo({
      sessionId: session.id,
      clientCommandId: "undo-second",
    });
    expect(undone).toEqual({
      status: "undone",
      clientCommandId: "undo-second",
      message: secondUser,
      historyStateId: expect.any(String),
      filesystem: { status: "restored" },
    });
    expect(service.store.getModelMessages(session.id)).toEqual(expectedPrefix);
    expect(service.getMessages(session.id).map((message) => message.id)).toEqual([
      firstUser.id,
      expect.any(String),
    ]);
    expect(await service.undo({ sessionId: session.id, clientCommandId: "undo-second" })).toEqual(
      undone,
    );
    expect(await collect(service.replayRun(secondRun.runId, { tail: false }))).toEqual([]);
    const stalePrompt = await service.startPrompt(session.id, secondUser, "second-prompt");
    expect(stalePrompt.runId).toBe(secondRun.runId);
    expect(await collect(stalePrompt.stream)).toEqual([]);

    expect(
      await service.undo({ sessionId: session.id, clientCommandId: "undo-first" }),
    ).toMatchObject({ message: firstUser });
    expect(service.getMessages(session.id)).toEqual([]);
    expect(service.store.getModelMessages(session.id)).toEqual([]);
    expect(service.store.getActiveRootRun(session.id)).toBeNull();
    const empty = await service.undo({
      sessionId: session.id,
      clientCommandId: "undo-empty",
    });
    expect(empty).toEqual({ status: "empty", clientCommandId: "undo-empty" });
    expect(await service.undo({ sessionId: session.id, clientCommandId: "undo-empty" })).toEqual(
      empty,
    );
    service.close();
  });

  it("durably replays an empty undo without affecting later messages", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-empty-undo-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "runtime.sqlite");
    const first = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => new MockLanguageModelV4({}),
      attachCompaction: async () => () => {},
    });
    const session = await first.createSession({
      id: "empty-undo-session",
      cwd: directory,
      model: "test/mock",
      profile: "reader",
    });
    const empty = await first.undo({
      sessionId: session.id,
      clientCommandId: "empty-undo-command",
    });
    expect(empty).toEqual({ status: "empty", clientCommandId: "empty-undo-command" });
    first.close();

    const reopened = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () =>
        new MockLanguageModelV4({ doStream: textResult("later-answer", "later response") }),
      attachCompaction: async () => () => {},
    });
    const laterUser = userMessage("later prompt");
    await collect((await reopened.startPrompt(session.id, laterUser, "later-prompt")).stream);
    expect(
      await reopened.undo({
        sessionId: session.id,
        clientCommandId: "empty-undo-command",
      }),
    ).toEqual(empty);
    expect(reopened.getMessages(session.id)).toContainEqual(laterUser);
    reopened.close();
  });

  it("restores observed worktrees through undo/redo and retains discarded edit topology", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-redo-worktree-"));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    await mkdir(workspace);
    const managed = path.join(workspace, "managed.txt");
    const ignored = path.join(workspace, "ignored.tmp");
    await Promise.all([
      writeFile(path.join(workspace, ".gitignore"), "ignored.tmp\n"),
      writeFile(managed, "root"),
      writeFile(ignored, "ignored-root"),
    ]);
    const model = new MockLanguageModelV4({
      doStream: [
        textResult("first-answer", "first response"),
        textResult("branch-answer", "branch response"),
      ],
    });
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
      attachCompaction: async () => () => {},
    });
    const session = await service.createSession({ cwd: workspace, model: "test/mock" });
    const firstUser = userMessage("first prompt");
    await collect((await service.startPrompt(session.id, firstUser, "first-prompt")).stream);
    const firstTranscript = service.getMessages(session.id);

    await Promise.all([
      writeFile(managed, "manual-before-undo"),
      writeFile(ignored, "ignored-manual"),
    ]);
    const statesBeforeUndo = service.store.listHistoryTopology(session.id).states.length;
    const undone = await service.undo({ sessionId: session.id, clientCommandId: "undo-first" });
    expect(undone).toMatchObject({
      status: "undone",
      message: firstUser,
      filesystem: { status: "restored" },
    });
    expect(await Bun.file(managed).text()).toBe("root");
    expect(await Bun.file(ignored).text()).toBe("ignored-manual");
    expect(service.getMessages(session.id)).toEqual([]);
    expect(service.store.listHistoryTopology(session.id).states.length).toBe(statesBeforeUndo + 1);

    await Promise.all([
      writeFile(managed, "manual-after-undo"),
      writeFile(ignored, "ignored-after"),
    ]);
    const statesBeforeRedo = service.store.listHistoryTopology(session.id).states.length;
    const redone = await service.redo({ sessionId: session.id, clientCommandId: "redo-first" });
    expect(redone).toMatchObject({
      status: "redone",
      message: firstUser,
      filesystem: { status: "restored" },
    });
    expect(await Bun.file(managed).text()).toBe("manual-before-undo");
    expect(await Bun.file(ignored).text()).toBe("ignored-after");
    expect(service.getMessages(session.id)).toEqual(firstTranscript);
    expect(service.store.listHistoryTopology(session.id).states.length).toBe(statesBeforeRedo + 1);
    expect(model.doStreamCalls).toHaveLength(1);
    expect(await service.redo({ sessionId: session.id, clientCommandId: "redo-first" })).toEqual(
      redone,
    );
    await expect(
      service.undo({ sessionId: session.id, clientCommandId: "redo-first" }),
    ).rejects.toThrow("already used for 'redo'");
    expect(await service.redo({ sessionId: session.id, clientCommandId: "redo-empty" })).toEqual({
      status: "empty",
      clientCommandId: "redo-empty",
    });

    await service.undo({ sessionId: session.id, clientCommandId: "undo-for-branch" });
    const retainedStateIds = new Set(
      service.store.listHistoryTopology(session.id).states.map((state) => state.id),
    );
    await collect(
      (await service.startPrompt(session.id, userMessage("new branch"), "branch-prompt")).stream,
    );
    expect(service.getSnapshot(session.id).canRedo).toBe(false);
    expect(
      service.store
        .listHistoryTopology(session.id)
        .states.filter((state) => retainedStateIds.has(state.id)),
    ).toHaveLength(retainedStateIds.size);
    service.close();
  });

  it("aborts before journaling when the workspace drifts between capture and restore preparation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-navigation-source-drift-"));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    await mkdir(workspace);
    const managed = path.join(workspace, "managed.txt");
    await writeFile(managed, "target");
    let injectDrift = false;
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => new MockLanguageModelV4({ doStream: textResult("answer", "response") }),
      attachCompaction: async () => () => {},
      workspaceHistoryStoreFactory: (options) =>
        new InterceptedWorkspaceHistoryStore(options, {
          beforePrepare: async (expectedCurrent) => {
            if (!injectDrift) return;
            expect(expectedCurrent).toMatchObject({
              status: "captured",
              rootTreeOid: expect.any(String),
            });
            await writeFile(managed, "drift-after-source-capture");
          },
        }),
    });
    const session = await service.createSession({ cwd: workspace, model: "test/mock" });
    await collect(
      (await service.startPrompt(session.id, userMessage("source binding"), "prompt-command"))
        .stream,
    );
    await writeFile(managed, "captured-source");
    const sourceStateId = service.getSnapshot(session.id).historyStateId;
    const statesBefore = service.store.listHistoryTopology(session.id).states.length;
    injectDrift = true;

    await expect(
      service.undo({ sessionId: session.id, clientCommandId: "source-drift-undo" }),
    ).rejects.toMatchObject({ code: "restore-conflict" });
    expect(await Bun.file(managed).text()).toBe("drift-after-source-capture");
    expect(service.getSnapshot(session.id)).toMatchObject({
      historyStateId: sourceStateId,
      canRedo: false,
    });
    expect(service.store.listHistoryTopology(session.id).states).toHaveLength(statesBefore);
    expect(service.getHistoryRecoveryStatus().navigation).toEqual([]);
    expect(
      service.store.database
        .query("SELECT 1 FROM commands WHERE session_id = ? AND command_id = ?")
        .get(session.id, "source-drift-undo"),
    ).toBeNull();
    service.close();
  });

  it("completes destination capability preflight before reserving a navigation journal", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-navigation-preflight-"));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    await mkdir(workspace);
    const managed = path.join(workspace, "managed.txt");
    await writeFile(managed, "target");
    let rejectHardLinks = false;
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => new MockLanguageModelV4({ doStream: textResult("answer", "response") }),
      attachCompaction: async () => () => {},
      workspaceHistoryStoreFactory: (options) =>
        new WorkspaceHistoryStore({
          ...options,
          testHooks: {
            beforeHardLinkValidation: () => {
              if (rejectHardLinks) {
                throw Object.assign(new Error("hard links unavailable during preflight"), {
                  code: "EOPNOTSUPP",
                });
              }
            },
          },
        }),
    });
    const session = await service.createSession({ cwd: workspace, model: "test/mock" });
    await collect(
      (await service.startPrompt(session.id, userMessage("preflight"), "prompt-command")).stream,
    );
    await writeFile(managed, "source-must-survive");
    const sourceStateId = service.getSnapshot(session.id).historyStateId;
    rejectHardLinks = true;

    await expect(
      service.undo({ sessionId: session.id, clientCommandId: "preflight-undo" }),
    ).rejects.toMatchObject({
      code: "filesystem-error",
      operation: "prepare workspace restore",
    });
    expect(await Bun.file(managed).text()).toBe("source-must-survive");
    expect(service.getSnapshot(session.id).historyStateId).toBe(sourceStateId);
    expect(service.getHistoryRecoveryStatus().navigation).toEqual([]);
    expect(
      service.store.database
        .query("SELECT 1 FROM commands WHERE session_id = ? AND command_id = ?")
        .get(session.id, "preflight-undo"),
    ).toBeNull();
    service.close();
  });

  it("maps Git disappearance before journaling to a transcript-only navigation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-navigation-git-disappears-"));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    await mkdir(workspace);
    const managed = path.join(workspace, "managed.txt");
    const gitWrapper = path.join(directory, "git-wrapper");
    await writeFile(managed, "target");
    await writeFile(gitWrapper, '#!/bin/sh\nexec git "$@"\n');
    await chmod(gitWrapper, 0o755);
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => new MockLanguageModelV4({ doStream: textResult("answer", "response") }),
      attachCompaction: async () => () => {},
      workspaceHistoryStoreFactory: (options) =>
        new WorkspaceHistoryStore({ ...options, gitExecutable: gitWrapper, platform: "linux" }),
    });
    const session = await service.createSession({ cwd: workspace, model: "test/mock" });
    const prompt = userMessage("Git disappears");
    await collect((await service.startPrompt(session.id, prompt, "prompt-command")).stream);
    await writeFile(managed, "source-drift");
    await rm(gitWrapper);

    expect(
      await service.undo({ sessionId: session.id, clientCommandId: "missing-git-undo" }),
    ).toMatchObject({
      status: "undone",
      message: prompt,
      filesystem: { status: "skipped", reason: "git-unavailable" },
    });
    expect(await Bun.file(managed).text()).toBe("source-drift");
    expect(service.getHistoryRecoveryStatus().navigation).toEqual([]);
    const redoTarget = service.store.peekHistoryRedo(session.id);
    if (redoTarget === null) throw new Error("missing redo target for unavailable source");
    expect(service.store.getHistoryState(redoTarget.targetStateId)).toMatchObject({
      workspaceStatus: "unavailable",
      workspaceUnavailableReason: "git-unavailable",
    });
    service.close();
  });

  it("treats Git exit 128 before journaling as an operational navigation failure", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-navigation-git-128-"));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    await mkdir(workspace);
    const managed = path.join(workspace, "managed.txt");
    const gitWrapper = path.join(directory, "git-wrapper");
    const failMarker = path.join(directory, "fail-git");
    await writeFile(managed, "target");
    await writeFile(
      gitWrapper,
      `#!/bin/sh\nif [ -e ${JSON.stringify(failMarker)} ]; then exit 128; fi\nexec git "$@"\n`,
    );
    await chmod(gitWrapper, 0o755);
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => new MockLanguageModelV4({ doStream: textResult("answer", "response") }),
      attachCompaction: async () => () => {},
      workspaceHistoryStoreFactory: (options) =>
        new WorkspaceHistoryStore({ ...options, gitExecutable: gitWrapper, platform: "linux" }),
    });
    const session = await service.createSession({ cwd: workspace, model: "test/mock" });
    await collect(
      (await service.startPrompt(session.id, userMessage("Git failure"), "prompt-command")).stream,
    );
    await writeFile(managed, "source-must-survive");
    const sourceStateId = service.getSnapshot(session.id).historyStateId;
    await writeFile(failMarker, "fail");

    await expect(
      service.undo({ sessionId: session.id, clientCommandId: "git-128-undo" }),
    ).rejects.toMatchObject({ code: "git-command-failed", exitCode: 128 });
    expect(await Bun.file(managed).text()).toBe("source-must-survive");
    expect(service.getSnapshot(session.id).historyStateId).toBe(sourceStateId);
    expect(service.getHistoryRecoveryStatus().navigation).toEqual([]);
    expect(
      service.store.database
        .query("SELECT 1 FROM commands WHERE session_id = ? AND command_id = ?")
        .get(session.id, "git-128-undo"),
    ).toBeNull();
    service.close();
  });

  it("serializes navigation preparation across sessions sharing one workspace", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-navigation-contention-"));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    await mkdir(workspace);
    await writeFile(path.join(workspace, "managed.txt"), "shared");
    const firstPrepareEntered = Promise.withResolvers<void>();
    const releaseFirstPrepare = Promise.withResolvers<void>();
    const secondLockRequested = Promise.withResolvers<void>();
    let navigationActive = false;
    let lockRequests = 0;
    let navigationCaptures = 0;
    let heldFirstPrepare = false;
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () =>
        new MockLanguageModelV4({
          doStream: [
            textResult("first-answer", "first response"),
            textResult("second-answer", "second response"),
          ],
        }),
      attachCompaction: async () => () => {},
      workspaceHistoryStoreFactory: (options) =>
        new InterceptedWorkspaceHistoryStore(options, {
          onLockRequest: () => {
            if (!navigationActive) return;
            lockRequests += 1;
            if (lockRequests === 2) secondLockRequested.resolve();
          },
          onCapture: () => {
            if (navigationActive) navigationCaptures += 1;
          },
          beforePrepare: async () => {
            if (!navigationActive || heldFirstPrepare) return;
            heldFirstPrepare = true;
            firstPrepareEntered.resolve();
            await releaseFirstPrepare.promise;
          },
        }),
    });
    const first = await service.createSession({
      id: "contention-first",
      cwd: workspace,
      model: "test/mock",
    });
    const second = await service.createSession({
      id: "contention-second",
      cwd: workspace,
      model: "test/mock",
    });
    await collect(
      (await service.startPrompt(first.id, userMessage("first"), "first-prompt")).stream,
    );
    await collect(
      (await service.startPrompt(second.id, userMessage("second"), "second-prompt")).stream,
    );

    navigationActive = true;
    const firstUndo = service.undo({ sessionId: first.id, clientCommandId: "first-undo" });
    await firstPrepareEntered.promise;
    const secondUndo = service.undo({ sessionId: second.id, clientCommandId: "second-undo" });
    await secondLockRequested.promise;
    expect(navigationCaptures).toBe(1);
    expect(
      service.store.database
        .query("SELECT 1 FROM commands WHERE session_id = ? AND command_id = ?")
        .get(second.id, "second-undo"),
    ).not.toBeNull();

    releaseFirstPrepare.resolve();
    expect((await firstUndo).status).toBe("undone");
    expect((await secondUndo).status).toBe("undone");
    expect(navigationCaptures).toBe(2);
    service.close();
  });

  for (const retainedPhase of ["prepared", "restoring", "verified"] as const) {
    it(`rolls a retained ${retainedPhase} navigation forward on restart`, async () => {
      const directory = await mkdtemp(
        path.join(tmpdir(), `mini-lilac-navigation-${retainedPhase}-`),
      );
      temporaryDirectories.push(directory);
      const workspace = path.join(directory, "workspace");
      const databasePath = path.join(directory, "runtime.sqlite");
      await mkdir(workspace);
      const managed = path.join(workspace, "managed.txt");
      await writeFile(managed, "target");
      const service = new SessionService({
        config: config(),
        databasePath,
        modelResolver: () =>
          new MockLanguageModelV4({ doStream: textResult("answer", "response") }),
        attachCompaction: async () => () => {},
        ...(retainedPhase === "restoring"
          ? {
              workspaceHistoryStoreFactory: (options: WorkspaceHistoryStoreOptions) =>
                new WorkspaceHistoryStore({
                  ...options,
                  testHooks: {
                    beforeMutation: () => {
                      throw new Error("injected restore write failure");
                    },
                  },
                }),
            }
          : {}),
      });
      const session = await service.createSession({ cwd: workspace, model: "test/mock" });
      const prompt = userMessage(`recover ${retainedPhase}`);
      await collect((await service.startPrompt(session.id, prompt, "prompt-command")).stream);
      await writeFile(managed, "source-drift");

      if (retainedPhase === "prepared") {
        const updatePhase = service.store.updateHistoryOperationPhase.bind(service.store);
        service.store.updateHistoryOperationPhase = (operationId, phase) => {
          if (phase === "restoring") throw new Error("injected prepared crash");
          return updatePhase(operationId, phase);
        };
      } else if (retainedPhase === "verified") {
        service.store.commitHistoryNavigation = () => {
          throw new Error("injected verified crash");
        };
      }

      await expect(
        service.undo({ sessionId: session.id, clientCommandId: "recoverable-undo" }),
      ).rejects.toThrow("injected");
      expect(service.store.listHistoryOperations()).toMatchObject([
        { requestedAction: "undo", phase: retainedPhase },
      ]);
      expect(service.getMessages(session.id)).not.toEqual([]);
      service.close();

      const reopened = new SessionService({
        config: config(),
        databasePath,
        modelResolver: () => new MockLanguageModelV4({}),
        attachCompaction: async () => () => {},
      });
      await reopened.initialize();
      expect(reopened.getHistoryRecoveryStatus().navigation).toEqual([]);
      expect(await Bun.file(managed).text()).toBe("target");
      expect(reopened.getMessages(session.id)).toEqual([]);
      expect(
        await reopened.undo({ sessionId: session.id, clientCommandId: "recoverable-undo" }),
      ).toMatchObject({
        status: "undone",
        message: prompt,
        filesystem: { status: "restored" },
      });
      reopened.close();
    });
  }

  it("downgrades an unmutated prepared restore when the worktree becomes non-Git", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-prepared-non-git-"));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    const databasePath = path.join(directory, "runtime.sqlite");
    await mkdir(workspace);
    const managed = path.join(workspace, "managed.txt");
    await writeFile(managed, "target");
    const service = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () =>
        new MockLanguageModelV4({ doStream: textResult("non-git-recovery", "response") }),
      attachCompaction: async () => () => {},
    });
    const session = await service.createSession({ cwd: workspace, model: "test/mock" });
    const prompt = userMessage("prepared non-git recovery");
    await collect((await service.startPrompt(session.id, prompt, "prepared-prompt")).stream);
    await writeFile(managed, "source-drift");
    const updatePhase = service.store.updateHistoryOperationPhase.bind(service.store);
    service.store.updateHistoryOperationPhase = (operationId, phase) => {
      if (phase === "restoring") throw new Error("injected prepared crash");
      return updatePhase(operationId, phase);
    };
    await expect(
      service.undo({ sessionId: session.id, clientCommandId: "prepared-non-git-undo" }),
    ).rejects.toThrow("injected prepared crash");
    service.close();
    await rm(path.join(directory, ".git"), { recursive: true });

    const reopened = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => new MockLanguageModelV4({}),
      attachCompaction: async () => () => {},
    });
    await reopened.initialize();
    expect(reopened.getHistoryRecoveryStatus().navigation).toEqual([]);
    expect(await Bun.file(managed).text()).toBe("source-drift");
    expect(reopened.getMessages(session.id)).toEqual([]);
    expect(
      await reopened.undo({ sessionId: session.id, clientCommandId: "prepared-non-git-undo" }),
    ).toMatchObject({
      status: "undone",
      message: prompt,
      filesystem: { status: "skipped", reason: "non-git-workspace" },
    });
    reopened.close();
  });

  it("commits a verified restore after the worktree becomes non-Git", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-verified-non-git-"));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    const databasePath = path.join(directory, "runtime.sqlite");
    await mkdir(workspace);
    const managed = path.join(workspace, "managed.txt");
    await writeFile(managed, "target");
    const service = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () =>
        new MockLanguageModelV4({ doStream: textResult("verified-non-git", "response") }),
      attachCompaction: async () => () => {},
    });
    const session = await service.createSession({ cwd: workspace, model: "test/mock" });
    const prompt = userMessage("verified non-git recovery");
    await collect((await service.startPrompt(session.id, prompt, "verified-prompt")).stream);
    await writeFile(managed, "source-drift");
    service.store.commitHistoryNavigation = () => {
      throw new Error("injected verified crash");
    };
    await expect(
      service.undo({ sessionId: session.id, clientCommandId: "verified-non-git-undo" }),
    ).rejects.toThrow("injected verified crash");
    expect(service.store.listHistoryOperations()).toMatchObject([{ phase: "verified" }]);
    service.close();
    await rm(path.join(directory, ".git"), { recursive: true });

    const reopened = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => new MockLanguageModelV4({}),
      attachCompaction: async () => () => {},
    });
    await reopened.initialize();
    expect(reopened.getHistoryRecoveryStatus().navigation).toEqual([]);
    expect(await Bun.file(managed).text()).toBe("target");
    expect(reopened.getMessages(session.id)).toEqual([]);
    expect(
      await reopened.undo({ sessionId: session.id, clientCommandId: "verified-non-git-undo" }),
    ).toMatchObject({
      status: "undone",
      message: prompt,
      filesystem: { status: "restored" },
    });
    reopened.close();
  });

  it("does not resume a restoring operation after the worktree becomes non-Git", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-restoring-non-git-"));
    temporaryDirectories.push(directory);
    const workspace = path.join(directory, "workspace");
    const databasePath = path.join(directory, "runtime.sqlite");
    await mkdir(workspace);
    const managed = path.join(workspace, "managed.txt");
    await writeFile(managed, "target");
    const service = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () =>
        new MockLanguageModelV4({ doStream: textResult("restoring-non-git", "response") }),
      attachCompaction: async () => () => {},
      workspaceHistoryStoreFactory: (options) =>
        new WorkspaceHistoryStore({
          ...options,
          testHooks: {
            beforeMutation: () => {
              throw new Error("injected restoring failure");
            },
          },
        }),
    });
    const session = await service.createSession({ cwd: workspace, model: "test/mock" });
    await collect(
      (
        await service.startPrompt(
          session.id,
          userMessage("restoring non-git recovery"),
          "restoring-prompt",
        )
      ).stream,
    );
    await writeFile(managed, "source-drift");
    await expect(
      service.undo({ sessionId: session.id, clientCommandId: "restoring-non-git-undo" }),
    ).rejects.toThrow("injected restoring failure");
    expect(service.store.listHistoryOperations()).toMatchObject([{ phase: "restoring" }]);
    service.close();
    await rm(path.join(directory, ".git"), { recursive: true });

    const reopened = new SessionService({
      config: config(),
      databasePath,
      modelResolver: () => new MockLanguageModelV4({}),
      attachCompaction: async () => () => {},
    });
    await expect(reopened.initialize()).rejects.toThrow(
      "requires Git for recovery (non-git-workspace)",
    );
    expect(reopened.getHistoryRecoveryStatus().navigation).toMatchObject([{ phase: "restoring" }]);
    expect(await Bun.file(managed).text()).toBe("source-drift");
    reopened.close();
  });

  for (const scenario of [
    {
      name: "removed-ignore-rule",
      sourceRule: "secret.txt\n",
      targetRule: "other.txt\n",
      preservedPath: "secret.txt",
    },
    {
      name: "added-ignore-rule",
      sourceRule: "other.txt\n",
      targetRule: "secret.txt\n",
      preservedPath: "other.txt",
    },
  ] as const) {
    it(`recovers navigation from frozen membership after target ignore publication (${scenario.name})`, async () => {
      const directory = await mkdtemp(path.join(tmpdir(), `mini-lilac-frozen-${scenario.name}-`));
      temporaryDirectories.push(directory);
      const workspace = path.join(directory, "workspace");
      const databasePath = path.join(directory, "runtime.sqlite");
      await mkdir(workspace);
      const managed = path.join(workspace, "managed.txt");
      const protectedPath = path.join(workspace, "protected.txt");
      await writeFile(path.join(workspace, ".gitignore"), scenario.targetRule);
      await writeFile(managed, "target");
      await writeFile(protectedPath, "protected value");
      let injected = false;
      const initial = new SessionService({
        config: config(),
        databasePath,
        modelResolver: () =>
          new MockLanguageModelV4({ doStream: textResult("answer", "response") }),
        attachCompaction: async () => () => {},
        protectedToolPaths: [protectedPath],
        workspaceHistoryStoreFactory: (options) =>
          new WorkspaceHistoryStore({
            ...options,
            testHooks: {
              afterPublication: (relativePath) => {
                if (relativePath === ".gitignore" && !injected) {
                  injected = true;
                  throw new Error("injected crash after target ignore publication");
                }
              },
            },
          }),
      });
      const session = await initial.createSession({ cwd: workspace, model: "test/mock" });
      await collect(
        (await initial.startPrompt(session.id, userMessage("freeze source"), "prompt-command"))
          .stream,
      );
      await writeFile(path.join(workspace, ".gitignore"), scenario.sourceRule);
      await writeFile(managed, "source");
      await writeFile(path.join(workspace, scenario.preservedPath), "preserved value");

      await expect(
        initial.undo({ sessionId: session.id, clientCommandId: "frozen-undo" }),
      ).rejects.toThrow("injected crash after target ignore publication");
      expect(await Bun.file(path.join(workspace, ".gitignore")).text()).toBe(scenario.targetRule);
      const operation = initial.getHistoryRecoveryStatus().navigation[0];
      if (operation === undefined) throw new Error("missing frozen restore operation");
      expect(operation.phase).toBe("restoring");
      initial.close();

      const reopened = new SessionService({
        config: config(),
        databasePath,
        modelResolver: () => new MockLanguageModelV4({}),
        attachCompaction: async () => () => {},
        protectedToolPaths: [protectedPath],
      });
      await reopened.initialize();
      expect(await Bun.file(path.join(workspace, scenario.preservedPath)).text()).toBe(
        "preserved value",
      );
      expect(await Bun.file(protectedPath).text()).toBe("protected value");
      expect(await Bun.file(managed).text()).toBe("target");
      expect(reopened.getHistoryRecoveryStatus().navigation).toEqual([]);
      reopened.close();
    });
  }
});
