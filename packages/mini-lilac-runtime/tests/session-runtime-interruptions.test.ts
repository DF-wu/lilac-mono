import {
  type MiniLilacRuntimeChunk,
  describe,
  expect,
  it,
  tmpdir,
  path,
  MockLanguageModelV4,
  simulateReadableStream,
  SessionService,
  temporaryDirectories,
  mkdtemp,
  zeroUsage,
  textResult,
  userMessage,
  steeringMessage,
  config,
  temporaryRuntime,
  collect,
} from "./session-runtime-test-support";

describe("SessionService", () => {
  it("rolls back only interrupted output and persists canonical assistant text", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "aborted" },
              { type: "text-delta", id: "aborted", delta: "completed prior text" },
              { type: "text-end", id: "aborted" },
              { type: "text-start", id: "aborted" },
              { type: "text-delta", id: "aborted", delta: "aborted partial" },
              { type: "text-end", id: "aborted" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: zeroUsage(),
              },
            ],
            chunkDelayInMs: 50,
          }),
        },
        // Providers may reuse stream part ids for the replacement turn.
        textResult("aborted", "canonical final"),
      ],
    });
    const { service, session } = await temporaryRuntime(model);
    const started = await service.startPrompt(session.id, userMessage("start"));
    const reader = started.stream.getReader();
    const chunks: MiniLilacRuntimeChunk[] = [];
    while (
      !chunks.some((chunk) => chunk.type === "text-delta" && chunk.delta === "aborted partial")
    ) {
      const next = await reader.read();
      if (next.done) throw new Error("run ended before partial text");
      chunks.push(next.value);
    }

    const replacement = steeringMessage("replace direction");
    await service.steer({
      sessionId: session.id,
      runId: started.runId,
      clientCommandId: "replacement-steer",
      message: replacement,
    });
    const interrupted = await service.interruptQueuedSteering({
      sessionId: session.id,
      runId: started.runId,
      clientCommandId: "replacement-interrupt",
    });
    expect(interrupted.status).toBe("interrupted");
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
    }

    expect(chunks.find((chunk) => chunk.type === "data-outputRollback")).toMatchObject({
      data: { reason: "interrupt", textIds: ["aborted"] },
    });
    const resetIndex = chunks.findIndex((chunk) => chunk.type === "data-outputRollback");
    const commitIndex = chunks.findIndex((chunk) => chunk.type === "data-steeringCommitted");
    expect(commitIndex).toBeGreaterThan(resetIndex);
    expect(chunks[commitIndex]).toEqual({
      type: "data-steeringCommitted",
      id: replacement.id,
      data: replacement,
    });
    const persisted = JSON.stringify(service.getMessages(session.id));
    expect(persisted).toContain("completed prior text");
    expect(persisted).toContain("canonical final");
    expect(persisted).not.toContain("aborted partial");
    const canonicalModel = JSON.stringify(service.store.getModelMessages(session.id));
    expect(canonicalModel).toContain("completed prior text");
    expect(canonicalModel).toContain("canonical final");
    expect(canonicalModel).not.toContain("aborted partial");
    service.close();
  });

  it("persists an interrupted batch without consuming a newer queued steer", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "aborted" },
              { type: "text-delta", id: "aborted", delta: "partial" },
              { type: "text-end", id: "aborted" },
              {
                type: "finish",
                finishReason: { unified: "stop", raw: "stop" },
                usage: zeroUsage(),
              },
            ],
            chunkDelayInMs: 50,
          }),
        },
        textResult("after-interrupt", "after older"),
        textResult("after-newer", "after newer"),
      ],
    });
    const { service, session } = await temporaryRuntime(model);
    const started = await service.startPrompt(session.id, userMessage("start"));
    const reader = started.stream.getReader();
    while (true) {
      const next = await reader.read();
      if (next.done) throw new Error("run ended before partial text");
      if (next.value.type === "text-delta") break;
    }

    const older = steeringMessage("older interrupted steering");
    const newer = steeringMessage("newer queued steering");
    await service.steer({
      sessionId: session.id,
      runId: started.runId,
      clientCommandId: "older-steer",
      message: older,
    });
    expect(
      await service.interruptQueuedSteering({
        sessionId: session.id,
        runId: started.runId,
        clientCommandId: "interrupt-older",
      }),
    ).toMatchObject({ status: "interrupted" });
    await service.steer({
      sessionId: session.id,
      runId: started.runId,
      clientCommandId: "newer-steer",
      message: newer,
    });
    expect(service.getSnapshot(session.id).queuedSteeringCount).toBe(1);

    for (;;) {
      if ((await reader.read()).done) break;
    }

    expect(model.doStreamCalls).toHaveLength(3);
    expect(
      service
        .getMessages(session.id)
        .filter((message) => message.role === "user")
        .slice(1),
    ).toEqual([older, newer]);
    expect(service.getSnapshot(session.id).queuedSteeringCount).toBe(0);
    service.close();
  });

  it("rejects a steer that arrives after its interrupt barrier", async () => {
    const model = new MockLanguageModelV4({
      doStream: {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "active" },
            { type: "text-delta", id: "active", delta: "working" },
            { type: "text-end", id: "active" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: zeroUsage(),
            },
          ],
          chunkDelayInMs: 50,
        }),
      },
    });
    const { service, session } = await temporaryRuntime(model);
    const started = await service.startPrompt(session.id, userMessage("start"));
    const completion = collect(started.stream);

    await service.interruptQueuedSteering({
      sessionId: session.id,
      runId: started.runId,
      clientCommandId: "interrupt-before-admission",
      pendingSteerCommandIds: ["late-steer"],
    });
    await expect(
      service.steer({
        sessionId: session.id,
        runId: started.runId,
        clientCommandId: "late-steer",
        message: steeringMessage("must not be admitted"),
      }),
    ).rejects.toThrow("interrupted before admission");

    await completion;
    expect(JSON.stringify(service.getMessages(session.id))).not.toContain("must not be admitted");
    service.close();
  });

  for (const mode of ["sync", "deferred"] as const) {
    it(`runs and persists ${mode} subagents`, async () => {
      const model = new MockLanguageModelV4({
        doStream: [
          {
            stream: simulateReadableStream({
              chunks: [
                {
                  type: "tool-call",
                  toolCallId: "delegate-call",
                  toolName: "subagent_delegate",
                  input: JSON.stringify({
                    profile: "child",
                    prompt: "investigate",
                    mode,
                    sessionName: "investigation",
                  }),
                },
                {
                  type: "finish",
                  finishReason: { unified: "tool-calls", raw: "tool-calls" },
                  usage: zeroUsage(),
                },
              ],
            }),
          },
          textResult("child-answer", "child result"),
          ...(mode === "deferred" ? [textResult("accepted", "working")] : []),
          textResult("parent-answer", "parent result"),
        ],
      });
      const { directory, service, session } = await temporaryRuntime(model, "delegate");
      const started = await service.startPrompt(session.id, userMessage("delegate this"));
      const chunks = await collect(started.stream);

      const childSessionId = `sub:${session.id}:named:investigation`;
      const child = service.store.getLatestSelectedRootRun(childSessionId);
      expect(child).toMatchObject({ profile: "child", depth: 1, status: "completed" });
      expect(child?.terminalResult).toMatchObject({ text: "child result" });
      expect(service.getRunChunks(child?.id ?? "")).toEqual([]);
      expect(service.getMessages(childSessionId).map((message) => message.role)).toEqual([
        "user",
        "assistant",
      ]);
      expect(model.doStreamCalls).toHaveLength(mode === "deferred" ? 4 : 3);
      expect(JSON.stringify(model.doStreamCalls[1]?.prompt[0])).toContain("Investigate only.");
      expect(JSON.stringify(model.doStreamCalls[1]?.prompt[0])).toContain(
        `Working directory: ${directory}`,
      );
      const finalParentPrompt = JSON.stringify(model.doStreamCalls.at(-1)?.prompt);
      expect(finalParentPrompt).toContain("child result");
      if (mode === "deferred") expect(finalParentPrompt).toContain("subagent_result");
      const statuses = chunks
        .filter((chunk) => chunk.type === "data-subagentStatus")
        .map((chunk) => chunk.data);
      expect(statuses.map((status) => status.state)).toEqual(["running", "completed"]);
      expect(statuses.at(-1)).toMatchObject({
        sessionId: childSessionId,
        sessionName: "investigation",
      });
      service.close();
    });
  }

  it("continues a named subagent session with its canonical model transcript", async () => {
    const delegateCall = (toolCallId: string, prompt: string) => ({
      stream: simulateReadableStream({
        chunks: [
          {
            type: "tool-call" as const,
            toolCallId,
            toolName: "subagent_delegate",
            input: JSON.stringify({
              profile: "child",
              prompt,
              mode: "sync",
              sessionName: "research",
            }),
          },
          {
            type: "finish" as const,
            finishReason: { unified: "tool-calls" as const, raw: "tool-calls" },
            usage: zeroUsage(),
          },
        ],
      }),
    });
    const model = new MockLanguageModelV4({
      doStream: [
        delegateCall("delegate-1", "first investigation"),
        textResult("child-1", "first finding"),
        textResult("parent-1", "first parent result"),
        delegateCall("delegate-2", "continue investigation"),
        textResult("child-2", "second finding"),
        textResult("parent-2", "second parent result"),
      ],
    });
    const { directory, service, session } = await temporaryRuntime(model, "delegate");

    await collect((await service.startPrompt(session.id, userMessage("first"))).stream);
    service.close();
    const resumed = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
    });
    await collect((await resumed.startPrompt(session.id, userMessage("second"))).stream);

    const childSessionId = `sub:${session.id}:named:research`;
    expect(resumed.getMessages(childSessionId).map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    const continuedPrompt = JSON.stringify(model.doStreamCalls[4]?.prompt);
    expect(continuedPrompt).toContain("first investigation");
    expect(continuedPrompt).toContain("first finding");
    expect(continuedPrompt).toContain("continue investigation");
    expect(
      resumed.getRunChunks(resumed.store.getLatestSelectedRootRun(childSessionId)?.id ?? ""),
    ).toEqual([]);
    resumed.close();
  });

  it("rejects a missing directory and subagent-only top-level profile", async () => {
    const model = new MockLanguageModelV4({ doStream: textResult("unused", "unused") });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-validation-"));
    temporaryDirectories.push(directory);
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
    });
    await expect(
      service.createSession({ cwd: path.join(directory, "missing"), model: "test/mock" }),
    ).rejects.toThrow();
    await expect(
      service.createSession({ cwd: directory, model: "test/mock", profile: "child" }),
    ).rejects.toThrow("subagent-only");
    await expect(
      service.createSession({ id: "sub:reserved", cwd: directory, model: "test/mock" }),
    ).rejects.toThrow("reserved");
    expect(service.store.listSessions()).toHaveLength(0);
    service.close();
  });
});
