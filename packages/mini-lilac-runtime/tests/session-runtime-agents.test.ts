import {
  type MiniLilacRuntimeChunk,
  describe,
  expect,
  it,
  mkdir,
  readdir,
  writeFile,
  tmpdir,
  path,
  createToolResultArtifactStore,
  MockLanguageModelV4,
  simulateReadableStream,
  SessionService,
  temporaryDirectories,
  mkdtemp,
  zeroUsage,
  textResult,
  delegateResult,
  bashToolResult,
  textThenBashToolResult,
  bashOutputDeltaTestSchema,
  userMessage,
  steeringMessage,
  config,
  temporaryRuntime,
  delegatedRuns,
  collect,
} from "./session-runtime-test-support";

describe("SessionService", () => {
  for (const mode of ["sync", "deferred"] as const) {
    it(`interrupts a gated ${mode} child without cancelling the root run`, async () => {
      let childEntered = () => {};
      const childGate = new Promise<void>((resolve) => {
        childEntered = resolve;
      });
      let continuationEntered = () => {};
      const continuationGate = new Promise<void>((resolve) => {
        continuationEntered = resolve;
      });
      let firstCall = true;
      let parentContinuations = 0;
      const model = new MockLanguageModelV4({
        doStream: async (options) => {
          if (firstCall) {
            firstCall = false;
            return delegateResult(mode);
          }
          const userMessages = options.prompt.filter((message) => message.role === "user");
          const latestUser = JSON.stringify(userMessages.at(-1));
          if (latestUser.includes("investigate")) {
            childEntered();
            await new Promise<void>((_resolve, reject) => {
              if (options.abortSignal?.aborted) {
                reject(new DOMException("cancelled", "AbortError"));
                return;
              }
              options.abortSignal?.addEventListener(
                "abort",
                () => reject(new DOMException("cancelled", "AbortError")),
                { once: true },
              );
            });
          }
          parentContinuations += 1;
          if (mode === "deferred" && parentContinuations === 1) {
            continuationEntered();
            await new Promise<void>((_resolve, reject) => {
              options.abortSignal?.addEventListener(
                "abort",
                () => reject(new DOMException("interrupted", "AbortError")),
                { once: true },
              );
            });
          }
          return textResult("root-final", "root completed");
        },
      });
      const { service, session } = await temporaryRuntime(model, "delegate");
      const started = await service.startPrompt(session.id, userMessage("delegate gated child"));
      const completion = collect(started.stream);
      await childGate;
      if (mode === "deferred") await continuationGate;

      await service.steer({
        sessionId: session.id,
        runId: started.runId,
        clientCommandId: `${mode}-steer`,
        message: steeringMessage("continue root"),
      });
      expect(
        await service.interruptQueuedSteering({
          sessionId: session.id,
          runId: started.runId,
          clientCommandId: `${mode}-interrupt`,
        }),
      ).toMatchObject({ status: "interrupted" });
      await completion;

      expect(service.store.getRun(started.runId).status).toBe("completed");
      expect(delegatedRuns(service, session.id)[0]?.status).toBe("cancelled");
      expect(service.getSnapshot(session.id).status).toBe("idle");
      expect(JSON.stringify(service.store.getModelMessages(session.id))).toContain(
        "root completed",
      );
      service.close();
    });
  }

  it("rejects delegation when subagents are disabled", async () => {
    const runtimeConfig = config();
    runtimeConfig.agent.subagents.enabled = false;
    const model = new MockLanguageModelV4({
      doStream: [delegateResult("sync"), textResult("root", "done")],
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-disabled-subagents-"));
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
    const started = await service.startPrompt(session.id, userMessage("delegate"));
    await collect(started.stream);

    expect(delegatedRuns(service, session.id)).toEqual([]);
    expect(JSON.stringify(model.doStreamCalls.at(-1)?.prompt)).toContain(
      "Model tried to call unavailable tool 'subagent_delegate'",
    );
    service.close();
  });

  it("allows more than eight children in one parent run", async () => {
    const responses = Array.from({ length: 9 }, (_, index) => [
      delegateResult("sync", `child-${index}`),
      textResult(`child-${index}`, `result-${index}`),
    ]).flat();
    const model = new MockLanguageModelV4({
      doStream: [...responses, textResult("root", "done")],
    });
    const { service, session } = await temporaryRuntime(model, "delegate");
    const started = await service.startPrompt(session.id, userMessage("delegate repeatedly"));
    await collect(started.stream);

    expect(delegatedRuns(service, session.id)).toHaveLength(9);
    expect(JSON.stringify(model.doStreamCalls)).not.toContain("maximum children per run reached");
    service.close();
  });

  it("allows more than four child runs concurrently", async () => {
    const allChildrenStarted = Promise.withResolvers<void>();
    const releaseChildren = Promise.withResolvers<void>();
    const delegatedRoots = new Set<string>();
    let childCount = 0;
    const model = new MockLanguageModelV4({
      doStream: async (options) => {
        const latestUser = JSON.stringify(
          options.prompt.filter((message) => message.role === "user").at(-1),
        );
        const childMatch = /child-(\d+)/u.exec(latestUser);
        if (childMatch !== null) {
          childCount += 1;
          if (childCount === 5) allChildrenStarted.resolve();
          await releaseChildren.promise;
          return textResult(`child-${childMatch[1]}`, "child complete");
        }
        const rootMatch = /root-(\d+)/u.exec(latestUser);
        if (rootMatch !== null && !delegatedRoots.has(rootMatch[0])) {
          delegatedRoots.add(rootMatch[0]);
          return delegateResult("sync", `child-${rootMatch[1]}`);
        }
        return textResult("root", "done");
      },
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-unbounded-concurrency-"));
    temporaryDirectories.push(directory);
    const service = new SessionService({
      config: config(),
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
    });
    const sessions = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        service.createSession({
          id: `concurrent-${index}`,
          cwd: directory,
          model: "test/mock",
          profile: "delegate",
        }),
      ),
    );
    const started = await Promise.all(
      sessions.map((session, index) =>
        service.startPrompt(session.id, userMessage(`root-${index}`)),
      ),
    );
    const completions = started.map((run) => collect(run.stream));

    await allChildrenStarted.promise;
    expect(sessions.flatMap((session) => delegatedRuns(service, session.id))).toHaveLength(5);
    releaseChildren.resolve();
    await Promise.all(completions);

    expect(
      sessions.flatMap((session) => delegatedRuns(service, session.id)).map((run) => run.status),
    ).toEqual(Array.from({ length: 5 }, () => "completed"));
    service.close();
  });

  it("allows only one delegation edge by default", async () => {
    const model = new MockLanguageModelV4({
      doStream: [
        delegateResult("sync", "child"),
        delegateResult("sync", "grandchild"),
        textResult("child", "child recovered"),
        textResult("root", "done"),
      ],
    });
    const { service, session } = await temporaryRuntime(model, "delegate");
    const started = await service.startPrompt(session.id, userMessage("delegate once"));
    await collect(started.stream);

    expect(delegatedRuns(service, session.id)).toHaveLength(1);
    expect(JSON.stringify(model.doStreamCalls[2]?.prompt)).toContain(
      "maximum subagent depth reached",
    );
    service.close();
  });

  it("recovers a root run when a tool remains silent past the idle timeout", async () => {
    const runtimeConfig = config();
    runtimeConfig.agent.idleTimeoutMs = 1_500;
    const reader = runtimeConfig.agent.profiles.reader;
    if (!reader) throw new Error("reader profile missing");
    reader.tools = ["bash"];
    reader.execution = true;
    reader.workspaceWrites = true;
    const model = new MockLanguageModelV4({
      doStream: [textThenBashToolResult("sleep 10"), textResult("recovered", "follow-up works")],
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-root-idle-timeout-"));
    temporaryDirectories.push(directory);
    const service = new SessionService({
      config: runtimeConfig,
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
      transientModelRetry: {
        enabled: true,
        maxRetries: 1,
        baseDelayMs: 0,
        maxDelayMs: 0,
      },
    });
    const session = await service.createSession({
      cwd: directory,
      model: "test/mock",
      profile: "reader",
    });

    const started = await service.startPrompt(session.id, userMessage("run a silent tool"));
    const chunks = await collect(started.stream);

    expect(model.doStreamCalls).toHaveLength(2);
    expect(service.store.getRun(started.runId)).toMatchObject({
      status: "completed",
      error: null,
    });
    expect(service.getSnapshot(session.id).status).toBe("idle");
    expect(JSON.stringify(service.store.getModelMessages(session.id))).not.toContain("silent-bash");
    expect(chunks.find((chunk) => chunk.type === "data-outputRollback")).toMatchObject({
      data: {
        reason: "recovery",
        textIds: ["idle-draft"],
        toolCallIds: ["silent-bash"],
      },
    });
    expect(chunks.some((chunk) => chunk.type === "abort")).toBe(false);
    expect(JSON.stringify(service.getMessages(session.id))).toContain("follow-up works");
    service.close();
  });

  it("streams Bash output before the command completes", async () => {
    const runtimeConfig = config();
    const readerProfile = runtimeConfig.agent.profiles.reader;
    if (!readerProfile) throw new Error("reader profile missing");
    readerProfile.tools = ["bash"];
    readerProfile.execution = true;
    readerProfile.workspaceWrites = true;
    const model = new MockLanguageModelV4({
      doStream: [
        bashToolResult("printf 'first'; printf 'warning' >&2; sleep 0.2; printf 'second'"),
        textResult("answer", "done"),
      ],
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-bash-stream-"));
    temporaryDirectories.push(directory);
    const service = new SessionService({
      config: runtimeConfig,
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
    });
    const session = await service.createSession({
      cwd: directory,
      model: "test/mock",
      profile: "reader",
    });
    const started = await service.startPrompt(session.id, userMessage("stream command output"));
    const streamReader = started.stream.getReader();
    const chunks: MiniLilacRuntimeChunk[] = [];
    while (true) {
      const next = await streamReader.read();
      if (next.done) throw new Error("run ended before Bash emitted output");
      chunks.push(next.value);
      if (
        next.value.type === "tool-output-available" &&
        next.value.preliminary === true &&
        JSON.stringify(next.value.output).includes("first")
      ) {
        break;
      }
    }

    expect(model.doStreamCalls).toHaveLength(1);
    while (true) {
      const next = await streamReader.read();
      if (next.done) break;
      chunks.push(next.value);
    }
    const preliminary = chunks
      .flatMap((chunk) =>
        chunk.type === "tool-output-available" && chunk.preliminary === true ? [chunk.output] : [],
      )
      .map((output) => bashOutputDeltaTestSchema.safeParse(output))
      .filter((parsed) => parsed.success)
      .map((parsed) => parsed.data);
    expect(preliminary.map((update) => update.delta).join("")).toBe("firstwarningsecond");
    expect(preliminary.length).toBeLessThanOrEqual(2);
    expect(
      chunks.find((chunk) => chunk.type === "tool-output-available" && chunk.preliminary !== true),
    ).toMatchObject({
      output: { stdout: "firstwarningsecond", stderr: "", exitCode: 0 },
    });
    expect(service.store.getRun(started.runId).status).toBe("completed");
    service.close();
  });

  it("blocks dangerous Bash expansion and permits an explicit dangerouslyAllow retry", async () => {
    const runtimeConfig = config();
    const readerProfile = runtimeConfig.agent.profiles.reader;
    if (!readerProfile) throw new Error("reader profile missing");
    readerProfile.tools = ["bash"];
    readerProfile.execution = true;
    readerProfile.workspaceWrites = true;
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-bash-safety-"));
    temporaryDirectories.push(directory);
    const target = path.join(directory, "expanded-target");
    await mkdir(target);
    await writeFile(path.join(target, "marker.txt"), "keep");
    const command = `target=${JSON.stringify(target)}; rm -rf "$target"`;
    const model = new MockLanguageModelV4({
      doStream: [
        bashToolResult(command),
        bashToolResult(command, true),
        textResult("answer", "done"),
      ],
    });
    const service = new SessionService({
      config: runtimeConfig,
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
    });
    const session = await service.createSession({
      cwd: directory,
      model: "test/mock",
      profile: "reader",
    });

    await collect((await service.startPrompt(session.id, userMessage("clean target"))).stream);

    expect(JSON.stringify(model.doStreamCalls[1]?.prompt)).toContain("dynamic target");
    expect(await readdir(directory)).not.toContain("expanded-target");
    expect(service.getSnapshot(session.id).status).toBe("idle");
    service.close();
  });

  it("keeps bounded Bash output inline and retains the complete output as an artifact", async () => {
    const runtimeConfig = config();
    const readerProfile = runtimeConfig.agent.profiles.reader;
    if (!readerProfile) throw new Error("reader profile missing");
    readerProfile.tools = ["bash", "read"];
    readerProfile.execution = true;
    readerProfile.workspaceWrites = true;
    const model = new MockLanguageModelV4({
      doStream: [
        bashToolResult("printf 'start-'; printf 'z%.0s' {1..50000}; printf -- '-end'"),
        textResult("answer", "done"),
      ],
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-bash-artifact-"));
    temporaryDirectories.push(directory);
    const artifacts = createToolResultArtifactStore(path.join(directory, "tool-results"));
    await artifacts.init();
    const service = new SessionService({
      config: runtimeConfig,
      databasePath: path.join(directory, "runtime.sqlite"),
      modelResolver: () => model,
      toolResultArtifacts: artifacts,
    });
    const session = await service.createSession({
      cwd: directory,
      model: "test/mock",
      profile: "reader",
    });
    await collect((await service.startPrompt(session.id, userMessage("run large command"))).stream);

    const secondPrompt = JSON.stringify(model.doStreamCalls[1]?.prompt);
    const uri = /tool-result:\/\/[0-9a-f-]{36}/u.exec(secondPrompt)?.[0];
    if (uri === undefined) throw new Error("Bash artifact URI was not sent to the model");
    expect(secondPrompt).toContain("middle output omitted");
    expect(secondPrompt).toContain('"completeOutputRetained":true');
    const artifact = await artifacts.read(uri, session.id);
    expect(artifact.status).toBe("ok");
    if (artifact.status === "ok") {
      expect(artifact.value.content).toContain("start-");
      expect(artifact.value.content).toContain("-end");
      expect(artifact.value.content).toContain("z".repeat(40_000));
    }
    service.close();
  });

  for (const mode of ["sync", "deferred"] as const) {
    it(`cancels an inactive ${mode} child after the configured idle timeout`, async () => {
      const runtimeConfig = config();
      runtimeConfig.agent.idleTimeoutMs = 1_500;
      let first = true;
      const model = new MockLanguageModelV4({
        doStream: async (options) => {
          if (first) {
            first = false;
            return delegateResult(mode, "idle-child");
          }
          const latestUser = JSON.stringify(
            options.prompt.filter((message) => message.role === "user").at(-1),
          );
          if (latestUser.includes("idle-child")) {
            await new Promise<void>((_resolve, reject) => {
              options.abortSignal?.addEventListener(
                "abort",
                () => reject(new DOMException("idle timeout", "AbortError")),
                { once: true },
              );
            });
          }
          if (mode === "deferred" && !JSON.stringify(options.prompt).includes("working")) {
            return textResult("working", "working");
          }
          return textResult("root", "done");
        },
      });
      const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-idle-child-"));
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
      const started = await service.startPrompt(session.id, userMessage("delegate idle child"));
      await collect(started.stream);

      expect(delegatedRuns(service, session.id)[0]?.status).toBe("error");
      expect(service.store.getRun(started.runId).status).toBe("completed");
      service.close();
    });
  }

  it("resets the child idle timeout on model activity", async () => {
    const runtimeConfig = config();
    runtimeConfig.agent.idleTimeoutMs = 1_500;
    let first = true;
    const activeChildResult = {
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start" as const, id: "active-child" },
          { type: "text-delta" as const, id: "active-child", delta: "still " },
          { type: "text-delta" as const, id: "active-child", delta: "working" },
          { type: "text-end" as const, id: "active-child" },
          {
            type: "finish" as const,
            finishReason: { unified: "stop" as const, raw: "stop" },
            usage: zeroUsage(),
          },
        ],
        chunkDelayInMs: 400,
      }),
    };
    const model = new MockLanguageModelV4({
      doStream: async () => {
        if (first) {
          first = false;
          return delegateResult("sync", "active-child");
        }
        return model.doStreamCalls.length === 2 ? activeChildResult : textResult("root", "done");
      },
    });
    const directory = await mkdtemp(path.join(tmpdir(), "mini-lilac-active-child-"));
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
    const started = await service.startPrompt(session.id, userMessage("delegate active child"));
    await collect(started.stream);

    expect(delegatedRuns(service, session.id)[0]?.status).toBe("completed");
    service.close();
  });
});
