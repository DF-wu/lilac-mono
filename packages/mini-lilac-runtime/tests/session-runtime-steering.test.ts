import {
  type MiniLilacTodo,
  type MiniLilacTodoState,
  type MiniLilacUIMessage,
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
  phasedOpenAITextResult,
  textAndReadToolResult,
  delegateResult,
  todoWriteResult,
  todoAndReadResult,
  userMessage,
  steeringMessage,
  config,
  temporaryRuntime,
  collect,
} from "./session-runtime-test-support";

describe("SessionService", () => {
  it("splits phased assistant output before a committed steering message", async () => {
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const secondEntered = Promise.withResolvers<void>();
    const releaseSecond = Promise.withResolvers<void>();
    let callCount = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        callCount += 1;
        if (callCount === 1) {
          firstEntered.resolve();
          await releaseFirst.promise;
          return phasedOpenAITextResult([
            {
              id: "pre-steer-commentary",
              itemId: "msg_pre_steer_commentary",
              phase: "commentary",
              text: "Preparing for steering.",
            },
            {
              id: "pre-steer-final",
              itemId: "msg_pre_steer_final",
              phase: "final_answer",
              text: "Ready for steering.",
            },
          ]);
        }
        secondEntered.resolve();
        await releaseSecond.promise;
        return textResult("after-steer", "Steering applied.");
      },
    });
    const { service, session } = await temporaryRuntime(model);
    const rootUser = userMessage("start phased work");
    const steer = steeringMessage("change direction");
    const started = await service.startPrompt(session.id, rootUser);
    const completion = collect(started.stream);
    await firstEntered.promise;
    await service.steer({
      sessionId: session.id,
      runId: started.runId,
      clientCommandId: "phase-boundary-steer",
      message: steer,
    });
    releaseFirst.resolve();
    await secondEntered.promise;
    const activeResume = await service.getSessionResume(session.id);
    expect(activeResume.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "user",
    ]);
    expect(activeResume.messages[3]).toEqual(steer);
    expect(activeResume.replayCursor).toMatchObject({ runId: started.runId });
    releaseSecond.resolve();
    await completion;

    const messages = service.getMessages(session.id);
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(messages[0]).toEqual(rootUser);
    expect(messages[3]).toEqual(steer);
    expect(JSON.stringify(messages[1])).toContain("Preparing for steering.");
    expect(JSON.stringify(messages[2])).toContain("Ready for steering.");
    expect(JSON.stringify(messages[4])).toContain("Steering applied.");
    expect(service.store.getModelMessages(session.id).map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    service.close();
  });

  it("persists incremental model and UI prefixes for merged steering", async () => {
    const firstEntered = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const secondEntered = Promise.withResolvers<void>();
    const releaseSecond = Promise.withResolvers<void>();
    let callCount = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        callCount += 1;
        if (callCount === 1) {
          firstEntered.resolve();
          await releaseFirst.promise;
          return textAndReadToolResult("before-steering", "visible before steering", "visible.txt");
        }
        secondEntered.resolve();
        await releaseSecond.promise;
        return textResult(`answer-${callCount}`, "after steering");
      },
    });
    const { directory, service, session } = await temporaryRuntime(model);
    await Bun.write(path.join(directory, "visible.txt"), "visible tool output");
    const started = await service.startPrompt(session.id, userMessage("start"));
    const completion = collect(started.stream);
    await firstEntered.promise;
    const firstSteer = {
      id: "steer-one-message",
      role: "user",
      parts: [
        { type: "text", text: "first steering" },
        {
          type: "file",
          mediaType: "text/plain",
          filename: "direction.txt",
          url: "data:text/plain;base64,cHJlc2VydmUgbWU=",
        },
      ],
    } satisfies MiniLilacUIMessage & { role: "user" };
    const secondSteer = steeringMessage("second steering");

    await service.steer({
      sessionId: session.id,
      runId: started.runId,
      clientCommandId: "steer-one",
      message: firstSteer,
    });
    await service.steer({
      sessionId: session.id,
      runId: started.runId,
      clientCommandId: "steer-two",
      message: secondSteer,
    });
    expect(service.getSnapshot(session.id).queuedSteeringCount).toBe(2);

    releaseFirst.resolve();
    await secondEntered.promise;

    const steeringTransitions = service.store
      .listHistoryTopology(session.id)
      .transitions.filter((transition) => transition.delivery === "steer");
    expect(steeringTransitions).toHaveLength(2);
    const firstDestinationId = steeringTransitions[0]?.toStateId;
    if (firstDestinationId === null || firstDestinationId === undefined) {
      throw new Error("First merged steering transition had no intermediate state");
    }
    expect(steeringTransitions[1]?.toStateId).toBeNull();
    const firstModelPrefix = service.store.getHistoryStateModelMessages(firstDestinationId);
    const firstUiPrefix = service.store.getHistoryStateUiMessages(firstDestinationId);
    expect(JSON.stringify(firstModelPrefix)).toContain("first steering");
    expect(JSON.stringify(firstModelPrefix)).not.toContain("second steering");
    expect(firstUiPrefix.at(-1)).toEqual(firstSteer);
    expect(JSON.stringify(firstUiPrefix)).not.toContain("second steering");
    const openModelPrefix = service.store.getModelMessages(session.id);
    const openUiPrefix = service.store.getUiMessages(session.id);
    expect(JSON.stringify(openModelPrefix)).toContain("first steering");
    expect(JSON.stringify(openModelPrefix)).toContain("second steering");
    expect(openUiPrefix.slice(-2)).toEqual([firstSteer, secondSteer]);
    const providerPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(providerPrompt.indexOf("first steering")).toBeLessThan(
      providerPrompt.indexOf("second steering"),
    );

    releaseSecond.resolve();
    const chunks = await completion;

    expect(model.doStreamCalls).toHaveLength(2);
    expect(
      chunks.filter((chunk) => chunk.type === "data-steeringCommitted").map((chunk) => chunk.data),
    ).toEqual([firstSteer, secondSteer]);
    const finalCommitIndex = chunks.findLastIndex(
      (chunk) => chunk.type === "data-steeringCommitted",
    );
    expect(
      chunks
        .slice(finalCommitIndex + 1)
        .some((chunk) => chunk.type === "data-session" && chunk.data.queuedSteeringCount === 0),
    ).toBe(true);
    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(secondPrompt).toContain("first steering");
    expect(secondPrompt).toContain("second steering");
    expect(service.getSnapshot(session.id).queuedSteeringCount).toBe(0);
    const steeringUsers = service
      .getMessages(session.id)
      .filter((message) => message.role === "user")
      .slice(1);
    expect(steeringUsers).toEqual([firstSteer, secondSteer]);
    const canonicalUi = service.getMessages(session.id);
    service.close();

    const reopened = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => new MockLanguageModelV4({}),
      attachCompaction: async () => () => {},
    });
    await reopened.initialize();
    expect(reopened.getMessages(session.id)).toEqual(canonicalUi);
    expect(reopened.getSnapshot(session.id)).toMatchObject({ canUndo: true, canRedo: false });
    reopened.close();
  });

  it("persists separate steering boundaries as ordered assistant and user segments", async () => {
    let releaseFirst = () => {};
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondStarted = () => {};
    const secondStart = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    let releaseSecond = () => {};
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let callCount = 0;
    const firstStarted = Promise.withResolvers<void>();
    const model = new MockLanguageModelV4({
      doStream: async () => {
        callCount += 1;
        if (callCount === 1) {
          firstStarted.resolve();
          await firstGate;
          return textAndReadToolResult("pre-first", "before first steer", "first.txt");
        }
        if (callCount === 2) {
          secondStarted();
          await secondGate;
          return textAndReadToolResult("between", "between steers", "second.txt");
        }
        return textResult("terminal", "after second steer");
      },
    });
    const { directory, service, session } = await temporaryRuntime(model);
    await Bun.write(path.join(directory, "first.txt"), "first tool output");
    await Bun.write(path.join(directory, "second.txt"), "second tool output");
    const rootUser = userMessage("start separate steering");
    const firstSteer = steeringMessage("first separate steer");
    const secondSteer = steeringMessage("second separate steer");
    const started = await service.startPrompt(session.id, rootUser);
    const completion = collect(started.stream);
    await firstStarted.promise;

    await service.steer({
      sessionId: session.id,
      runId: started.runId,
      clientCommandId: "first-separate-steer",
      message: firstSteer,
    });
    const queuedResume = await service.getSessionResume(session.id);
    expect(queuedResume.messages.filter((message) => message.role === "user")).toEqual([rootUser]);
    expect(queuedResume.replayCursor).toEqual({
      runId: started.runId,
      afterSeq: expect.any(Number),
    });
    if (queuedResume.replayCursor === null) throw new Error("active run had no replay cursor");
    const queuedReplay = await collect(
      service.replayRun(queuedResume.replayCursor.runId, {
        afterSeq: queuedResume.replayCursor.afterSeq,
        tail: false,
      }),
    );
    expect(queuedReplay).toContainEqual({
      type: "data-steering",
      id: firstSteer.id,
      data: firstSteer,
    });
    releaseFirst();
    await secondStart;
    const activeCanonicalUi = service.getMessages(session.id);
    expect(activeCanonicalUi.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(JSON.stringify(activeCanonicalUi)).toContain("before first steer");
    expect(JSON.stringify(activeCanonicalUi)).toContain("first tool output");
    const resume = await service.getSessionResume(session.id);
    expect(resume.snapshot.activeRunId).toBe(started.runId);
    expect(resume.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(resume.messages[0]).toEqual(rootUser);
    expect(resume.messages[2]).toEqual(firstSteer);
    expect(JSON.stringify(resume.messages[1])).toContain("before first steer");
    expect(JSON.stringify(resume.messages[1])).toContain("first tool output");
    expect(resume.replayCursor).toEqual({
      runId: started.runId,
      afterSeq: expect.any(Number),
    });
    if (resume.replayCursor === null) throw new Error("active run had no replay cursor");
    const replayCursor = resume.replayCursor;
    const replayedAfterPrefix = await collect(
      service.replayRun(replayCursor.runId, {
        afterSeq: replayCursor.afterSeq,
        tail: false,
      }),
    );
    expect(
      replayedAfterPrefix
        .filter((chunk) => chunk.type === "data-streamCursor")
        .every((chunk) => chunk.data.seq > replayCursor.afterSeq),
    ).toBe(true);
    expect(JSON.stringify(replayedAfterPrefix)).not.toContain("before first steer");
    expect(JSON.stringify(replayedAfterPrefix)).not.toContain("first tool output");
    const replayedAtBoundary = await collect(service.replayRun(started.runId, { tail: false }));
    expect(JSON.stringify(replayedAtBoundary)).toContain("before first steer");
    expect(JSON.stringify(replayedAtBoundary)).toContain("first tool output");
    await service.steer({
      sessionId: session.id,
      runId: started.runId,
      clientCommandId: "second-separate-steer",
      message: secondSteer,
    });
    releaseSecond();
    await completion;

    expect(model.doStreamCalls).toHaveLength(3);
    const canonicalUi = service.getMessages(session.id);
    expect(canonicalUi.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(canonicalUi[0]).toEqual(rootUser);
    expect(canonicalUi[2]).toEqual(firstSteer);
    expect(canonicalUi[4]).toEqual(secondSteer);
    expect(JSON.stringify(canonicalUi[1])).toContain("before first steer");
    expect(JSON.stringify(canonicalUi[1])).toContain("first tool output");
    expect(JSON.stringify(canonicalUi[3])).toContain("between steers");
    expect(JSON.stringify(canonicalUi[3])).toContain("second tool output");
    expect(JSON.stringify(canonicalUi).match(/before first steer/g)).toHaveLength(1);
    expect(JSON.stringify(canonicalUi).match(/between steers/g)).toHaveLength(1);
    expect(JSON.stringify(canonicalUi).match(/after second steer/g)).toHaveLength(1);
    service.close();

    const reopened = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => new MockLanguageModelV4({}),
      attachCompaction: async () => () => {},
    });
    await reopened.initialize();
    expect(reopened.getMessages(session.id)).toEqual(canonicalUi);
    expect(reopened.getSnapshot(session.id)).toMatchObject({ canUndo: true, canRedo: false });
    reopened.close();
  });

  it("checkpoints each merged steer against the compacted model prefix", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-undo-compaction-"));
    temporaryDirectories.push(directory);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let callCount = 0;
    const firstStarted = Promise.withResolvers<void>();
    const model = new MockLanguageModelV4({
      doStream: async () => {
        callCount += 1;
        if (callCount === 1) {
          firstStarted.resolve();
          await gate;
        }
        return textResult(`answer-${callCount}`, `answer ${callCount}`);
      },
    });
    const compactedPrefix = [{ role: "user" as const, content: "durable compacted prefix" }];
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
      attachCompaction: async (agent) => {
        let compacted = false;
        return agent.subscribe((event) => {
          if (compacted || event.type !== "turn_end") return;
          compacted = true;
          agent.replaceMessages(compactedPrefix, { reason: "compaction" });
        });
      },
    });
    const session = await service.createSession({
      cwd: directory,
      model: "test/mock",
      profile: "reader",
    });
    const started = await service.startPrompt(session.id, userMessage("root"));
    await firstStarted.promise;
    const firstSteer = steeringMessage("first merged steer");
    const secondSteer = steeringMessage("second merged steer");
    await service.steer({
      sessionId: session.id,
      runId: started.runId,
      clientCommandId: "first-merged-steer",
      message: firstSteer,
    });
    await service.steer({
      sessionId: session.id,
      runId: started.runId,
      clientCommandId: "second-merged-steer",
      message: secondSteer,
    });
    release();
    await collect(started.stream);

    expect(model.doStreamCalls).toHaveLength(2);
    const mergedPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
    expect(mergedPrompt).toContain("first merged steer");
    expect(mergedPrompt).toContain("second merged steer");
    const canonicalModel = JSON.stringify(service.store.getModelMessages(session.id));
    expect(canonicalModel).toContain("durable compacted prefix");
    expect(canonicalModel).toContain("first merged steer");
    expect(canonicalModel).toContain("second merged steer");
    expect(
      service.store
        .listHistoryTopology(session.id)
        .transitions.filter((transition) => transition.kind === "user-message"),
    ).toHaveLength(3);
    service.close();
  });

  it("exposes todowrite only to the requested root profile", async () => {
    const runtimeConfig = config();
    const delegate = runtimeConfig.agent.profiles.delegate;
    const child = runtimeConfig.agent.profiles.child;
    if (!delegate || !child) throw new Error("todo visibility profiles missing");
    delegate.tools = ["subagent_delegate", "todowrite"];
    child.tools = ["todowrite"];
    const model = new MockLanguageModelV4({
      doStream: [
        delegateResult("sync", "inspect todo visibility"),
        textResult("child", "child done"),
        textResult("root", "root done"),
      ],
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-todo-visibility-"));
    temporaryDirectories.push(directory);
    const service = new SessionService({
      config: runtimeConfig,
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
    });
    const session = await service.createSession({
      cwd: directory,
      model: "test/mock",
      profile: "delegate",
    });

    await collect(
      (await service.startPrompt(session.id, userMessage("delegate todo check"))).stream,
    );

    expect(model.doStreamCalls[0]?.tools?.map((entry) => entry.name)).toEqual([
      "todowrite",
      "subagent_delegate",
    ]);
    expect(model.doStreamCalls[1]?.tools?.map((entry) => entry.name) ?? []).not.toContain(
      "todowrite",
    );
    expect(model.doStreamCalls[2]?.tools?.map((entry) => entry.name)).toEqual([
      "todowrite",
      "subagent_delegate",
    ]);
    service.close();
  });

  it("persists todo replacements in input-data-output order and injects current context", async () => {
    const todos: MiniLilacTodo[] = [
      {
        content: "Implement durable todo integration",
        status: "in_progress",
        priority: "high",
      },
      { content: "Run runtime tests", status: "pending", priority: "medium" },
    ];
    const runtimeConfig = config();
    const reader = runtimeConfig.agent.profiles.reader;
    if (!reader) throw new Error("reader profile missing");
    reader.tools = ["todowrite"];
    const model = new MockLanguageModelV4({
      doStream: [
        todoWriteResult(todos, "todo-change"),
        todoWriteResult(todos, "todo-noop"),
        todoWriteResult([], "todo-clear"),
        textResult("answer", "done"),
      ],
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-todo-context-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "runtime.sqlite");
    const service = new SessionService({
      config: runtimeConfig,
      databasePath,
      modelResolver: () => model,
      attachCompaction: async (agent) => {
        agent.setPrepareFullModelView((messages) => [
          ...messages,
          { role: "user", content: "compaction-transform-marker" },
        ]);
        return () => {};
      },
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });
    const started = await service.startPrompt(session.id, userMessage("track this work"));
    const chunks = (await collect(started.stream)).filter(
      (chunk) => chunk.type !== "data-streamCursor",
    );

    expect(service.store.getTodos(session.id)).toEqual({ revision: 2, todos: [] });
    expect(chunks.filter((chunk) => chunk.type === "data-todos")).toEqual([
      { type: "data-todos", data: { revision: 1, todos }, transient: true },
      { type: "data-todos", data: { revision: 2, todos: [] }, transient: true },
    ]);
    expect(service.getRunChunks(started.runId)).toEqual([]);
    for (const toolCallId of ["todo-change", "todo-noop", "todo-clear"]) {
      const input = chunks.findIndex(
        (chunk) => chunk.type === "tool-input-available" && chunk.toolCallId === toolCallId,
      );
      const output = chunks.findIndex(
        (chunk) => chunk.type === "tool-output-available" && chunk.toolCallId === toolCallId,
      );
      expect(input).toBeGreaterThanOrEqual(0);
      expect(output).toBeGreaterThan(input);
      if (toolCallId !== "todo-noop") {
        const revision = toolCallId === "todo-change" ? 1 : 2;
        const data = chunks.findIndex(
          (chunk) => chunk.type === "data-todos" && chunk.data.revision === revision,
        );
        expect(data).toBeGreaterThan(input);
        expect(output).toBeGreaterThan(data);
      }
      expect(chunks[output]).toMatchObject({
        output: toolCallId === "todo-clear" ? { revision: 2, todos: [] } : { revision: 1, todos },
      });
    }
    const todoContext = (state: MiniLilacTodoState) =>
      [
        "<session-todos>",
        "This is the authoritative current todo state for this session, not a new user request.",
        "It supersedes todo state found in older tool calls or compaction summaries.",
        JSON.stringify(state),
        "</session-todos>",
      ].join("\n");
    const populatedContext = todoContext({ revision: 1, todos });
    const emptyContext = todoContext({ revision: 2, todos: [] });
    expect(JSON.stringify(model.doStreamCalls[0]?.prompt)).not.toContain("session-todos");
    for (const [index, call] of model.doStreamCalls.slice(1).entries()) {
      expect(JSON.stringify(call.prompt.at(-2))).toContain("compaction-transform-marker");
      const contextMessage = call.prompt.at(-1);
      if (contextMessage?.role !== "user") throw new Error("missing todo context user message");
      expect(contextMessage.content.find((part) => part.type === "text")?.text).toBe(
        index < 2 ? populatedContext : emptyContext,
      );
    }
    expect(JSON.stringify(service.store.getModelMessages(session.id))).not.toContain(
      "session-todos",
    );
    expect(JSON.stringify(service.store.getModelMessages(session.id))).not.toContain(
      "compaction-transform-marker",
    );
    expect(JSON.stringify(service.store.getUiMessages(session.id))).not.toContain("data-todos");
    expect(JSON.stringify(service.store.getUiMessages(session.id))).not.toContain("session-todos");
    service.close();

    const reopenedModel = new MockLanguageModelV4({
      doStream: textResult("reopened", "still done"),
    });
    const reopened = new SessionService({
      config: runtimeConfig,
      databasePath,
      modelResolver: () => reopenedModel,
      attachCompaction: async () => () => {},
    });
    await collect((await reopened.startPrompt(session.id, userMessage("what remains?"))).stream);
    const reopenedContext = reopenedModel.doStreamCalls[0]?.prompt.at(-1);
    if (reopenedContext?.role !== "user") throw new Error("missing reopened todo context");
    expect(reopenedContext.content.find((part) => part.type === "text")?.text).toBe(emptyContext);
    expect(reopened.store.getTodos(session.id)).toEqual({ revision: 2, todos: [] });
    reopened.close();
  });

  it("keeps todowrite outside batch and non-exclusive with parallel tools", async () => {
    const firstTodos: MiniLilacTodo[] = [
      { content: "Run beside a read", status: "in_progress", priority: "medium" },
    ];
    const secondTodos: MiniLilacTodo[] = [
      { content: "Run beside a read", status: "completed", priority: "medium" },
      { content: "Finish the response", status: "in_progress", priority: "low" },
    ];
    const runtimeConfig = config();
    const reader = runtimeConfig.agent.profiles.reader;
    if (!reader) throw new Error("reader profile missing");
    reader.tools = ["todowrite", "read", "batch"];
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-todo-parallel-"));
    temporaryDirectories.push(directory);
    const readable = path.join(directory, "parallel.txt");
    await Bun.write(readable, "parallel read completed");
    const model = new MockLanguageModelV4({
      doStream: [
        todoAndReadResult(firstTodos, secondTodos, readable),
        textResult("answer", "done"),
      ],
    });
    const service = new SessionService({
      config: runtimeConfig,
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });
    const chunks = await collect(
      (await service.startPrompt(session.id, userMessage("track and read"))).stream,
    );

    const tools = model.doStreamCalls[0]?.tools ?? [];
    expect(tools.map((entry) => entry.name)).toEqual(["read", "todowrite", "batch"]);
    expect(JSON.stringify(tools.find((entry) => entry.name === "batch"))).not.toContain(
      '"todowrite"',
    );
    expect(
      chunks.find(
        (chunk) => chunk.type === "tool-output-available" && chunk.toolCallId === "read-with-todos",
      ),
    ).toMatchObject({ output: { content: "parallel read completed", success: true } });
    expect(
      chunks.find(
        (chunk) =>
          chunk.type === "tool-output-available" && chunk.toolCallId === "write-todos-first",
      ),
    ).toMatchObject({ output: { revision: 1, todos: firstTodos } });
    expect(
      chunks.find(
        (chunk) =>
          chunk.type === "tool-output-available" && chunk.toolCallId === "write-todos-second",
      ),
    ).toMatchObject({ output: { revision: 2, todos: secondTodos } });
    expect(
      chunks.filter((chunk) => chunk.type === "data-todos").map((chunk) => chunk.data.revision),
    ).toEqual([1, 2]);
    expect(service.store.getTodos(session.id)).toEqual({ revision: 2, todos: secondTodos });
    expect(chunks.some((chunk) => chunk.type === "tool-output-error")).toBe(false);
    service.close();
  });

  it("preserves committed todos across undo and rehydrates them on the next prompt", async () => {
    const todos: MiniLilacTodo[] = [
      { content: "Keep this durable side effect", status: "in_progress", priority: "high" },
    ];
    const runtimeConfig = config();
    const reader = runtimeConfig.agent.profiles.reader;
    if (!reader) throw new Error("reader profile missing");
    reader.tools = ["todowrite"];
    const model = new MockLanguageModelV4({
      doStream: [
        todoWriteResult(todos),
        textResult("first-answer", "first done"),
        textResult("second-answer", "second done"),
      ],
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-todo-undo-"));
    temporaryDirectories.push(directory);
    const service = new SessionService({
      config: runtimeConfig,
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });
    const first = await service.startPrompt(session.id, userMessage("track then undo"));
    await collect(first.stream);

    expect(service.store.getTodos(session.id)).toEqual({ revision: 1, todos });
    await service.undo({ sessionId: session.id, clientCommandId: "undo-todo-origin" });
    expect(service.getRunChunks(first.runId)).toEqual([]);
    expect(service.store.getTodos(session.id)).toEqual({ revision: 1, todos });

    await collect(
      (await service.startPrompt(session.id, userMessage("continue after undo"))).stream,
    );
    const outbound = JSON.stringify(model.doStreamCalls[2]?.prompt.at(-1));
    expect(outbound).toContain("session-todos");
    expect(outbound).toContain("Keep this durable side effect");
    service.close();
  });

  it("does not mask an invalid assistant-tail compaction transform with todo context", async () => {
    const model = new MockLanguageModelV4({ doStream: textResult("unused", "unused") });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-todo-assistant-tail-"));
    temporaryDirectories.push(directory);
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
      attachCompaction: async (agent) => {
        agent.setPrepareFullModelView((messages) => [
          ...messages,
          { role: "assistant", content: "invalid assistant tail" },
        ]);
        return () => {};
      },
    });
    const session = await service.createSession({ cwd: directory, model: "test/mock" });
    const started = await service.startPrompt(session.id, userMessage("trigger invalid context"));
    await collect(started.stream);

    expect(model.doStreamCalls).toHaveLength(0);
    expect(service.store.getRun(started.runId)).toMatchObject({
      status: "error",
      error: expect.stringContaining(
        "Cannot append an ephemeral overlay after an assistant message",
      ),
    });
    service.close();
  });
});
