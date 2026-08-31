import {
  type LanguageModel,
  type SessionServiceOptions,
  describe,
  expect,
  it,
  tmpdir,
  path,
  MockLanguageModelV4,
  SessionService,
  temporaryDirectories,
  mkdtemp,
  textResult,
  webfetchToolResult,
  delegateResult,
  userMessage,
  config,
  temporaryRuntime,
  delegatedRuns,
  collect,
} from "./session-runtime-test-support";

describe("SessionService", () => {
  it("terminalizes an admitted root prompt when model preparation fails", async () => {
    const model = new MockLanguageModelV4({ doStream: textResult("unused", "unused") });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-setup-"));
    temporaryDirectories.push(directory);
    let resolutions = 0;
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => {
        resolutions += 1;
        if (resolutions > 1) throw new Error("model construction failed");
        return model;
      },
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });

    await expect(service.startPrompt(session.id, userMessage("should roll back"))).rejects.toThrow(
      "model construction failed",
    );
    expect(service.store.getActiveRootRun(session.id)).toBeNull();
    expect(service.getSnapshot(session.id).status).toBe("error");
    expect(JSON.stringify(service.getMessages(session.id))).toContain("should roll back");
    service.close();
  });

  it("persists a final response after a dynamic tool error", async () => {
    const runtimeConfig = config();
    const reader = runtimeConfig.agent.profiles.reader;
    if (!reader) throw new Error("reader profile missing");
    reader.tools = ["webfetch"];
    const model = new MockLanguageModelV4({
      doStream: [
        webfetchToolResult("http://127.0.0.1/private"),
        textResult("answer", "final survives"),
      ],
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-tool-error-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "runtime.sqlite");
    const service = new SessionService({
      config: runtimeConfig,
      databasePath,
      modelResolver: () => model,
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });
    const started = await service.startPrompt(session.id, userMessage("test a failing tool"));
    const chunks = await collect(started.stream);

    expect(chunks.some((chunk) => chunk.type === "tool-output-error")).toBe(true);
    expect(service.store.getRun(started.runId)).toMatchObject({
      status: "completed",
      error: null,
    });
    expect(service.getSnapshot(session.id).status).toBe("idle");
    const assistant = service.getMessages(session.id).at(-1);
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.parts).toContainEqual(
      expect.objectContaining({
        type: "dynamic-tool",
        toolName: "webfetch",
        state: "output-error",
        preliminary: undefined,
      }),
    );
    expect(JSON.stringify(assistant)).toContain("final survives");
    expect(JSON.stringify(service.store.getModelMessages(session.id))).toContain("final survives");
    service.close();

    const reopened = new SessionService({
      config: runtimeConfig,
      databasePath,
      modelResolver: () => model,
    });
    await reopened.initialize();
    expect(JSON.stringify(reopened.getMessages(session.id))).toContain("final survives");
    reopened.close();
  });

  it("keeps child setup failure from leaving an active child run", async () => {
    const model = new MockLanguageModelV4({
      doStream: [delegateResult("sync"), textResult("root-after-error", "root recovered")],
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-child-setup-"));
    temporaryDirectories.push(directory);
    let resolutions = 0;
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => {
        resolutions += 1;
        if (resolutions === 3) throw new Error("child construction failed");
        return model;
      },
    });
    const session = await service.createSession({
      cwd: directory,
      model: "test/mock",
      profile: "delegate",
    });
    const started = await service.startPrompt(session.id, userMessage("delegate"));
    await collect(started.stream);

    expect(service.store.getRun(started.runId).status).toBe("completed");
    const childRun = delegatedRuns(service, session.id)[0];
    expect(childRun).toMatchObject({
      status: "error",
      error: "Failed to prepare model runtime: child construction failed",
    });
    if (childRun === undefined) throw new Error("expected terminal child setup failure");
    expect(service.store.getActiveRootRun(childRun.sessionId)).toBeNull();
    expect(service.getSnapshot(session.id).status).toBe("idle");
    service.close();
  });

  it("exposes and applies optional subagent model and effort overrides", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        delegateResult("sync", "investigate", { model: "openai/child", effort: "low" }),
        textResult("child", "child result"),
        textResult("root", "done"),
      ],
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-compaction-"));
    temporaryDirectories.push(directory);
    const attachments: Array<{
      model: LanguageModel;
      modelSpecifier: string | undefined;
      reasoning: string | undefined;
      optionModel: string;
    }> = [];
    const resolvedModels: string[] = [];
    const runtimeConfig = config();
    const child = runtimeConfig.agent.profiles.child;
    if (!child) throw new Error("child profile missing");
    child.tools = ["*"];
    child.execution = true;
    child.workspaceWrites = true;
    const service = new SessionService({
      config: runtimeConfig,
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: (specifier) => {
        resolvedModels.push(specifier);
        return model;
      },
      attachCompaction: async (agent, options) => {
        attachments.push({
          model: agent.state.model,
          modelSpecifier: agent.state.modelSpecifier,
          reasoning: agent.state.reasoning,
          optionModel: options.model,
        });
        return () => {};
      },
    });
    const session = await service.createSession({
      cwd: directory,
      model: "test/mock",
      profile: "delegate",
      reasoning: "high",
    });
    const started = await service.startPrompt(session.id, userMessage("delegate"));
    await collect(started.stream);

    expect(attachments).toHaveLength(2);
    expect(attachments).toEqual([
      { model, modelSpecifier: "test/mock", reasoning: "high", optionModel: "test/mock" },
      { model, modelSpecifier: "openai/child", reasoning: "low", optionModel: "openai/child" },
    ]);
    expect(resolvedModels).toEqual(["test/mock", "test/mock", "openai/child"]);
    const delegateTool = model.doStreamCalls[0]?.tools?.find(
      (candidate) => candidate.name === "subagent_delegate",
    );
    expect(JSON.stringify(delegateTool)).toContain('"model"');
    expect(JSON.stringify(delegateTool)).toContain('"effort"');
    const childPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt[0]);
    expect(childPrompt).toContain("Investigate only.");
    expect(childPrompt).not.toContain("openai/child");
    expect(childPrompt).not.toContain('"low"');
    const childToolNames = model.doStreamCalls[1]?.tools?.map((entry) => entry.name) ?? [];
    expect(childToolNames).toContain("patch");
    expect(childToolNames).not.toContain("edit");
    service.close();
  });

  it("persists model and effort changes for a reused named subagent", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        delegateResult("sync", "first child", { sessionName: "research" }),
        textResult("child-1", "first result"),
        textResult("root-1", "first done"),
        delegateResult("sync", "second child", {
          sessionName: "research",
          model: "openai/child",
          effort: "low",
        }),
        textResult("child-2", "second result"),
        textResult("root-2", "second done"),
        delegateResult("sync", "third child", { sessionName: "research" }),
        textResult("child-3", "third result"),
        textResult("root-3", "third done"),
      ],
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-child-bindings-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "runtime.sqlite");
    const attachments: Array<{
      modelSpecifier: string | undefined;
      reasoning: string | undefined;
    }> = [];
    const options = {
      config: config(),
      databasePath,
      modelResolver: () => model,
      attachCompaction: async (agent) => {
        attachments.push({
          modelSpecifier: agent.state.modelSpecifier,
          reasoning: agent.state.reasoning,
        });
        return () => {};
      },
    } satisfies SessionServiceOptions;
    const service = new SessionService(options);
    const session = await service.createSession({
      cwd: directory,
      model: "test/mock",
      profile: "delegate",
      reasoning: "high",
    });

    await collect((await service.startPrompt(session.id, userMessage("first"))).stream);
    await collect((await service.startPrompt(session.id, userMessage("second"))).stream);
    const childSessionId = `sub:${session.id}:named:research`;
    expect(service.store.getSession(childSessionId)).toMatchObject({
      model: "openai/child",
      reasoning: "low",
    });
    service.close();

    const resumed = new SessionService(options);
    await resumed.initialize();
    await collect((await resumed.startPrompt(session.id, userMessage("third"))).stream);

    expect(resumed.store.getSession(childSessionId)).toMatchObject({
      model: "openai/child",
      reasoning: "low",
    });
    expect(attachments).toEqual([
      { modelSpecifier: "test/mock", reasoning: "high" },
      { modelSpecifier: "test/mock", reasoning: "high" },
      { modelSpecifier: "test/mock", reasoning: "high" },
      { modelSpecifier: "openai/child", reasoning: "low" },
      { modelSpecifier: "test/mock", reasoning: "high" },
      { modelSpecifier: "openai/child", reasoning: "low" },
    ]);
    const childAssistantMetadata = resumed
      .getMessages(childSessionId)
      .filter((message) => message.role === "assistant")
      .map((message) => message.metadata);
    expect(childAssistantMetadata).toEqual([
      expect.objectContaining({ model: "test/mock", reasoning: "high" }),
      expect.objectContaining({ model: "openai/child", reasoning: "low" }),
      expect.objectContaining({ model: "openai/child", reasoning: "low" }),
    ]);
    resumed.close();
  });

  it("delivers an eligible completed child before waiting for a newly launched child", async () => {
    let releaseSecondChild = () => {};
    const secondChildGate = new Promise<void>((resolve) => {
      releaseSecondChild = resolve;
    });
    let parentSawFirstChild = () => {};
    const parentProgress = new Promise<void>((resolve) => {
      parentSawFirstChild = resolve;
    });
    let firstRootCall = true;
    let parentContinuation = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        if (firstRootCall) {
          firstRootCall = false;
          return delegateResult("deferred", "child-a");
        }
        const users = options.prompt.filter((message) => message.role === "user");
        const latestUser = JSON.stringify(users.at(-1));
        if (latestUser.includes("child-a")) return textResult("child-a", "result-a");
        if (latestUser.includes("child-b")) {
          await secondChildGate;
          return textResult("child-b", "result-b");
        }
        parentContinuation += 1;
        if (parentContinuation === 1) return delegateResult("deferred", "child-b");
        if (parentContinuation === 2) {
          parentSawFirstChild();
          return textResult("parent-a", "received first child");
        }
        return textResult("parent-final", "received both children");
      },
    });
    const { service, session } = await temporaryRuntime(model, "delegate");
    const started = await service.startPrompt(session.id, userMessage("launch children"));
    const completion = collect(started.stream);

    await parentProgress;
    expect(service.store.getRun(started.runId).status).toBe("active");
    releaseSecondChild();
    await completion;

    expect(delegatedRuns(service, session.id).map((run) => run.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(JSON.stringify(model.doStreamCalls.at(-1)?.prompt)).toContain("result-b");
    expect(service.store.getRun(started.runId).status).toBe("completed");
    service.close();
  });
});
