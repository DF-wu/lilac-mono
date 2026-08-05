import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { PromptResponse } from "@agentclientprotocol/sdk";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Panic, Result, type Result as ResultType } from "better-result";

import {
  createSessionUpdatePersistence,
  persistRunFromCollector,
  persistSpawnedWorkerAdmission,
  runAcpWorkerLifecycle,
  runPromptWithCancellationMonitor,
} from "../controller.ts";
import { acpCleanupFailuresForPanic } from "../external-adapters.ts";
import { ExternalOperationFailed, type RunStoreError } from "../failures.ts";
import {
  loadRunRecord,
  requestRunCancellation,
  saveRunRecord,
  saveWorkerRunRecord,
} from "../run-store.ts";
import { SessionHistoryCollector } from "../session-history.ts";
import { createEmptyPermissionCounters, type PromptRunRecord } from "../types.ts";

const CONTROLLER_DIR = path.resolve(import.meta.dir, "..");
const SDK_PATH = path.join(
  CONTROLLER_DIR,
  "node_modules",
  "@agentclientprotocol",
  "sdk",
  "dist",
  "acp.js",
);
const CLI_ENTRY = path.join(CONTROLLER_DIR, "client.ts");

type FakeSession = {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt: string;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  plan?: Array<{
    content: string;
    priority: "high" | "medium" | "low";
    status: "pending" | "in_progress" | "completed";
  }>;
};

type FakeHarnessConfig = {
  commandName: string;
  requiresAcpArg: boolean;
  harnessId: string;
  sessions: FakeSession[];
};

type ListedSession = {
  harnessId: string;
  sessionId: string;
  sessionRef: string;
  title?: string;
  cwd: string;
  updatedAt?: string;
  capabilities: string[];
};

type PromptRunOutput = {
  history?: Array<{ role: "user" | "assistant"; text: string }>;
};

let tempRoot = "";

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "lilac-acp-controller-test-"));
}

function createDeferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function createValueDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function createFakeHarness(root: string, config: FakeHarnessConfig): Promise<void> {
  const binDir = path.join(root, "bin");
  await fs.mkdir(binDir, { recursive: true });

  const statePath = path.join(root, `${config.commandName}.json`);
  await fs.writeFile(
    statePath,
    JSON.stringify(
      { nextSessionId: config.sessions.length + 1, sessions: config.sessions },
      null,
      2,
    ),
    "utf8",
  );

  const scriptPath = path.join(binDir, config.commandName);
  const script = [
    "#!/usr/bin/env bun",
    'import fs from "node:fs/promises";',
    'import { Readable, Writable } from "node:stream";',
    `const acp = await import(${JSON.stringify(SDK_PATH)});`,
    `const statePath = ${JSON.stringify(statePath)};`,
    `const harnessId = ${JSON.stringify(config.harnessId)};`,
    `const requiresAcpArg = ${JSON.stringify(config.requiresAcpArg)};`,
    "",
    'if (requiresAcpArg && process.argv[2] !== "acp") {',
    '  process.stderr.write("expected acp subcommand\\n");',
    "  process.exit(1);",
    "}",
    "",
    "function nowIso() {",
    "  return new Date().toISOString();",
    "}",
    "",
    "async function readState() {",
    '  return JSON.parse(await fs.readFile(statePath, "utf8"));',
    "}",
    "",
    "async function writeState(state) {",
    '  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");',
    "}",
    "",
    "function delay(signal, ms) {",
    "  return new Promise((resolve, reject) => {",
    "    const timer = setTimeout(resolve, ms);",
    "    signal.addEventListener(",
    '      "abort",',
    "      () => {",
    "        clearTimeout(timer);",
    '        reject(new Error("aborted"));',
    "      },",
    "      { once: true },",
    "    );",
    "  });",
    "}",
    "",
    "class FakeAgent {",
    "  constructor(connection) {",
    "    this.connection = connection;",
    "    this.pending = new Map();",
    "  }",
    "",
    "  async initialize() {",
    "    return {",
    "      protocolVersion: acp.PROTOCOL_VERSION,",
    "      agentCapabilities: {",
    "        loadSession: true,",
    "        sessionCapabilities: { list: {}, resume: {} },",
    "      },",
    "      authMethods: [],",
    "    };",
    "  }",
    "",
    "  async authenticate() {",
    "    return {};",
    "  }",
    "",
    "  async listSessions(params) {",
    "    const state = await readState();",
    "    return {",
    "      sessions: state.sessions",
    "        .filter((session) => !params.cwd || session.cwd === params.cwd)",
    "        .map((session) => ({",
    "          sessionId: session.sessionId,",
    "          cwd: session.cwd,",
    "          title: session.title,",
    "          updatedAt: session.updatedAt,",
    "        })),",
    "    };",
    "  }",
    "",
    "  async newSession(params) {",
    "    const state = await readState();",
    '    const sessionId = "sess_" + harnessId + "_" + state.nextSessionId;',
    "    state.nextSessionId += 1;",
    "    state.sessions.push({",
    "      sessionId,",
    "      cwd: params.cwd,",
    "      title: undefined,",
    "      updatedAt: nowIso(),",
    "      history: [],",
    "      plan: [],",
    "    });",
    "    await writeState(state);",
    "    return { sessionId };",
    "  }",
    "",
    "  async loadSession(params) {",
    "    const state = await readState();",
    "    const session = state.sessions.find((candidate) => candidate.sessionId === params.sessionId);",
    "    if (!session) throw new Error(`missing session ${params.sessionId}`);",
    "    await this.replaySession(session);",
    "    return {};",
    "  }",
    "",
    "  async unstable_resumeSession(params) {",
    "    return this.loadSession(params);",
    "  }",
    "",
    "  async setSessionMode() {",
    "    return {};",
    "  }",
    "",
    "  async unstable_setSessionModel() {",
    "    return {};",
    "  }",
    "",
    "  async prompt(params) {",
    "    const state = await readState();",
    "    const session = state.sessions.find((candidate) => candidate.sessionId === params.sessionId);",
    "    if (!session) throw new Error(`missing session ${params.sessionId}`);",
    '    const promptText = params.prompt.filter((part) => part.type === "text").map((part) => part.text).join("");',
    '    session.history.push({ role: "user", text: promptText });',
    "    session.updatedAt = nowIso();",
    '    session.plan = [{ content: `Inspect ${promptText}`, priority: "high", status: "completed" }];',
    "    await writeState(state);",
    "",
    "    await this.connection.sessionUpdate({",
    "      sessionId: params.sessionId,",
    "      update: {",
    '        sessionUpdate: "plan",',
    "        entries: session.plan,",
    "      },",
    "    });",
    "",
    "    const controller = new AbortController();",
    "    this.pending.set(params.sessionId, controller);",
    "    try {",
    '      await delay(controller.signal, promptText.includes("sleep") ? 1200 : 50);',
    "    } catch {",
    "      this.pending.delete(params.sessionId);",
    '      return { stopReason: "cancelled", userMessageId: params.messageId };',
    "    }",
    "",
    "    const reply = `Completed ${promptText} via ${harnessId}`;",
    '    session.history.push({ role: "assistant", text: reply });',
    "    session.updatedAt = nowIso();",
    "    await writeState(state);",
    "",
    "    await this.connection.sessionUpdate({",
    "      sessionId: params.sessionId,",
    "      update: {",
    '        sessionUpdate: "agent_message_chunk",',
    '        content: { type: "text", text: reply },',
    "      },",
    "    });",
    "",
    "    this.pending.delete(params.sessionId);",
    '    return { stopReason: "end_turn", userMessageId: params.messageId };',
    "  }",
    "",
    "  async cancel(params) {",
    "    this.pending.get(params.sessionId)?.abort();",
    "  }",
    "",
    "  async replaySession(session) {",
    "    if (session.title) {",
    "      await this.connection.sessionUpdate({",
    "        sessionId: session.sessionId,",
    "        update: {",
    '          sessionUpdate: "session_info_update",',
    "          title: session.title,",
    "          updatedAt: session.updatedAt,",
    "        },",
    "      });",
    "    }",
    "    if (session.plan && session.plan.length > 0) {",
    "      await this.connection.sessionUpdate({",
    "        sessionId: session.sessionId,",
    "        update: {",
    '          sessionUpdate: "plan",',
    "          entries: session.plan,",
    "        },",
    "      });",
    "    }",
    "    for (const message of session.history) {",
    "      await this.connection.sessionUpdate({",
    "        sessionId: session.sessionId,",
    "        update: {",
    '          sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk",',
    '          content: { type: "text", text: message.text },',
    "        },",
    "      });",
    "    }",
    "  }",
    "}",
    "",
    "const stream = acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin));",
    "new acp.AgentSideConnection((connection) => new FakeAgent(connection), stream);",
    "",
  ].join("\n");

  await fs.writeFile(scriptPath, script, "utf8");
  await fs.chmod(scriptPath, 0o755);
}

async function runCliJson(
  root: string,
  args: string[],
): Promise<{ parsed: unknown; exitCode: number }> {
  const env = {
    ...process.env,
    PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
    XDG_STATE_HOME: path.join(root, "state"),
  };
  const proc = Bun.spawn(["bun", CLI_ENTRY, ...args], {
    cwd: CONTROLLER_DIR,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (stderr.trim().length > 0) {
    throw new Error(`Unexpected stderr: ${stderr}`);
  }
  return { parsed: JSON.parse(stdout), exitCode };
}

async function runCliText(
  root: string,
  args: string[],
): Promise<{ stdout: string; exitCode: number }> {
  const env = {
    ...process.env,
    PATH: `${path.join(root, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
    XDG_STATE_HOME: path.join(root, "state"),
  };
  const proc = Bun.spawn(["bun", CLI_ENTRY, ...args], {
    cwd: CONTROLLER_DIR,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (stderr.trim().length > 0) {
    throw new Error(`Unexpected stderr: ${stderr}`);
  }
  return { stdout: stdout.trimEnd(), exitCode };
}

beforeEach(async () => {
  tempRoot = await makeTempDir();
});

afterEach(async () => {
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

describe("lilac-acp controller", () => {
  it("commits collector state in memory only after persistence succeeds", async () => {
    const run: PromptRunRecord = {
      id: "run_11111111-1111-4111-8111-111111111111",
      status: "running",
      createdAt: 1,
      updatedAt: 1,
      directory: "/repo",
      harnessId: "opencode",
      targetKind: "new",
      promptText: "build feature",
      textPreview: "build feature",
      permissions: createEmptyPermissionCounters(),
    };
    const collector = new SessionHistoryCollector();
    collector.history.push({ role: "assistant", text: "durable reply" });
    const persistenceFailure = new ExternalOperationFailed({
      operation: "write-run",
      cause: new Error("disk full"),
      message: "disk full",
    });

    const persisted = await persistRunFromCollector(run, collector, async (candidate) => {
      expect(candidate.history).toEqual([{ role: "assistant", text: "durable reply" }]);
      expect(run.history).toBeUndefined();
      return Result.err(persistenceFailure);
    });

    expect(persisted.status).toBe("error");
    expect(run.history).toBeUndefined();
    expect(run.updatedAt).toBe(1);

    const recovered = await persistRunFromCollector(run, collector, async () =>
      Result.ok(undefined),
    );
    expect(recovered.status).toBe("ok");
    expect(run.history).toEqual([{ role: "assistant", text: "durable reply" }]);
  });

  it("drains concurrent updates before terminal persistence and observes pending errors", async () => {
    const run: PromptRunRecord = {
      id: "run_11111111-1111-4111-8111-111111111111",
      status: "running",
      createdAt: 1,
      updatedAt: 1,
      directory: "/repo",
      harnessId: "opencode",
      targetKind: "new",
      promptText: "build feature",
      textPreview: "build feature",
      permissions: createEmptyPermissionCounters(),
    };
    const collector = new SessionHistoryCollector();
    const persistenceFailure = new ExternalOperationFailed({
      operation: "write-run",
      cause: new Error("disk full"),
      message: "disk full",
    });
    const firstStarted = createDeferred();
    const finishFirst = createDeferred();
    const secondUpdateStarted = createDeferred();
    const finishSecondUpdate = createDeferred();
    const events: string[] = [];
    let persistenceCount = 0;
    const updates = createSessionUpdatePersistence(run, collector, (candidate, currentCollector) =>
      persistRunFromCollector(candidate, currentCollector, async (record) => {
        persistenceCount++;
        if (persistenceCount === 1) {
          events.push("update-1-start");
          expect(record.history).toEqual([{ role: "assistant", text: "first" }]);
          firstStarted.resolve();
          await finishFirst.promise;
          events.push("update-1-end");
          return Result.ok(undefined);
        }

        if (persistenceCount === 2) {
          events.push("running-persisted");
          expect(record.status).toBe("running");
          return Result.ok(undefined);
        }

        if (persistenceCount === 3) {
          events.push("update-2-start");
          expect(record.history).toEqual([{ role: "assistant", text: "first second" }]);
          secondUpdateStarted.resolve();
          await finishSecondUpdate.promise;
          events.push("update-2-end");
          return Result.err(persistenceFailure);
        }

        events.push("terminal-persisted");
        expect(record.status).toBe("failed");
        expect(record.history).toEqual([{ role: "assistant", text: "first second" }]);
        return Result.ok(undefined);
      }),
    );

    const firstUpdate = updates.onUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "first" },
      },
    });
    await firstStarted.promise;
    const runningPersistence = updates.persist({ ...run, status: "running", updatedAt: 2 });
    const secondUpdate = updates.onUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: " second" },
      },
    });
    const finalizedThenPersisted = (async () => {
      const finalized = await updates.finalize();
      events.push("finalized");
      const terminal: PromptRunRecord = { ...run, status: "failed" };
      const saved = await updates.persist(terminal);
      expect(saved.status).toBe("ok");
      return finalized;
    })();

    expect(events).toEqual(["update-1-start"]);
    finishFirst.resolve();
    await secondUpdateStarted.promise;
    expect(events).toEqual([
      "update-1-start",
      "update-1-end",
      "running-persisted",
      "update-2-start",
    ]);
    finishSecondUpdate.resolve();

    const [finalized] = await Promise.all([
      finalizedThenPersisted,
      firstUpdate,
      runningPersistence,
      secondUpdate,
    ]);
    expect(finalized.status).toBe("error");
    if (finalized.status === "error") expect(finalized.error).toBe(persistenceFailure);
    expect(events).toEqual([
      "update-1-start",
      "update-1-end",
      "running-persisted",
      "update-2-start",
      "update-2-end",
      "finalized",
      "terminal-persisted",
    ]);

    await updates.onUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: " ignored" },
      },
    });
    expect(persistenceCount).toBe(4);
    expect(collector.latestAssistantText()).toBe("first second");
  });

  it("preserves cross-process cancellation through delayed update and terminal writes", async () => {
    const previousStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = path.join(tempRoot, "state");
    try {
      const run: PromptRunRecord = {
        id: "run_11111111-1111-4111-8111-111111111111",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
        directory: "/repo",
        harnessId: "opencode",
        targetKind: "new",
        promptText: "build feature",
        textPreview: "build feature",
        permissions: createEmptyPermissionCounters(),
      };
      expect((await saveRunRecord(run)).status).toBe("ok");
      const collector = new SessionHistoryCollector();
      const updateSaveStarted = createDeferred();
      const finishUpdateSave = createDeferred();
      const updates = createSessionUpdatePersistence(
        run,
        collector,
        (candidate, currentCollector) =>
          persistRunFromCollector(candidate, currentCollector, async (record) => {
            updateSaveStarted.resolve();
            await finishUpdateSave.promise;
            const saved = await saveWorkerRunRecord(record);
            if (saved.status === "error") return Result.err(saved.error);
            Object.assign(record, saved.value);
            return Result.ok(undefined);
          }),
      );

      const update = updates.onUpdate({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "reply" },
        },
      });
      await updateSaveStarted.promise;
      const cancellation = await requestRunCancellation(run.id);
      expect(cancellation.status).toBe("ok");
      if (cancellation.status === "ok") {
        expect(cancellation.value.kind).toBe("requested");
        expect(cancellation.value.run.cancelRequestedAt).toBeNumber();
      }

      finishUpdateSave.resolve();
      await update;
      expect(run.status).toBe("running");
      expect(run.cancelRequestedAt).toBeNumber();

      expect((await updates.finalize()).status).toBe("ok");
      const originalNow = Date.now;
      Date.now = () => (run.cancelRequestedAt ?? 0) + 1;
      let terminal: ResultType<void, RunStoreError>;
      try {
        terminal = await updates.persist({ ...run, status: "completed", updatedAt: Date.now() });
      } finally {
        Date.now = originalNow;
      }
      expect(terminal.status).toBe("ok");
      expect(run.status).toBe("cancelled");
      expect(run.cancelRequestedAt).toBeNumber();

      const durable = await loadRunRecord(run.id);
      expect(durable.status).toBe("ok");
      if (durable.status === "ok") {
        expect(durable.value.status).toBe("cancelled");
        expect(durable.value.cancelRequestedAt).toBe(run.cancelRequestedAt);
      }
    } finally {
      if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previousStateHome;
    }
  });

  it("preserves Panic identity through update persistence finalization", async () => {
    const run: PromptRunRecord = {
      id: "run_11111111-1111-4111-8111-111111111111",
      status: "running",
      createdAt: 1,
      updatedAt: 1,
      directory: "/repo",
      harnessId: "opencode",
      targetKind: "new",
      promptText: "build feature",
      textPreview: "build feature",
      permissions: createEmptyPermissionCounters(),
    };
    const panic = new Panic({ message: "run persistence invariant" });
    const updates = createSessionUpdatePersistence(run, new SessionHistoryCollector(), () =>
      Promise.reject(panic),
    );
    const update = updates.onUpdate({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "reply" },
      },
    });

    await expect(update).rejects.toBe(panic);
    await expect(updates.finalize()).rejects.toBe(panic);
  });

  it("cancels an in-flight prompt only after the prompt-start handshake", async () => {
    const cancellation = createValueDeferred<ResultType<"requested" | "stopped", RunStoreError>>();
    const promptStarted = createDeferred();
    const finishPrompt = createValueDeferred<PromptResponse>();
    const cancelCalled = createDeferred();
    let closeCount = 0;
    const events: string[] = [];
    const monitored = runPromptWithCancellationMonitor({
      observe: async () =>
        Result.ok({
          result: cancellation.promise,
          close: async () => {
            closeCount++;
            return Result.ok(undefined);
          },
        }),
      prompt: async () => {
        events.push("prompt-started");
        promptStarted.resolve();
        return Result.ok(await finishPrompt.promise);
      },
      cancel: async () => {
        events.push("cancel-called");
        cancelCalled.resolve();
        return Result.ok(undefined);
      },
      terminate: async () => Result.ok(undefined),
    });

    await promptStarted.promise;
    expect(events).toEqual(["prompt-started"]);
    cancellation.resolve(Result.ok("requested"));
    await cancelCalled.promise;
    finishPrompt.resolve({ stopReason: "cancelled" });

    const result = await monitored;
    expect(result.status).toBe("ok");
    expect(events).toEqual(["prompt-started", "cancel-called"]);
    expect(closeCount).toBe(1);
  });

  it("terminates a pending prompt when cancellation monitoring fails", async () => {
    const cancellation = createValueDeferred<ResultType<"requested" | "stopped", RunStoreError>>();
    const promptStarted = createDeferred();
    const releasePrompt = createDeferred();
    const terminationCalled = createDeferred();
    const monitorFailure = new ExternalOperationFailed({
      operation: "watch-run-cancellation",
      cause: new Error("watch failed"),
      message: "watch failed",
    });
    const terminationFailure = new ExternalOperationFailed({
      operation: "close-harness",
      cause: new Error("termination failed"),
      message: "termination failed",
    });
    const monitored = runPromptWithCancellationMonitor({
      observe: async () =>
        Result.ok({
          result: cancellation.promise,
          close: async () => Result.ok(undefined),
        }),
      prompt: async () => {
        promptStarted.resolve();
        await releasePrompt.promise;
        return Result.err(
          new ExternalOperationFailed({
            operation: "prompt-session",
            cause: new Error("terminated"),
            message: "terminated",
          }),
        );
      },
      cancel: async () => Result.ok(undefined),
      terminate: async () => {
        terminationCalled.resolve();
        releasePrompt.resolve();
        return Result.err(terminationFailure);
      },
    });

    await promptStarted.promise;
    cancellation.resolve(Result.err(monitorFailure));
    await terminationCalled.promise;
    const result = await monitored;

    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.error._tag).toBe("MonitorTerminationFailed");
      if (result.error._tag === "MonitorTerminationFailed") {
        expect(result.error.primary).toBe(monitorFailure);
        expect(result.error.termination).toBe(terminationFailure);
      }
    }
  });

  it("removes worker signals and supervises cleanup before rethrowing the primary Panic", async () => {
    const primary = new Panic({ message: "worker persistence invariant" });
    const signalPanic = new Panic({ message: "signal cleanup invariant" });
    const cleanupPanic = new Panic({ message: "harness cleanup invariant" });
    let cleanupCount = 0;
    let signalRemovalCount = 0;
    let observed: unknown;

    try {
      await runAcpWorkerLifecycle(
        () => Promise.reject(primary),
        () => {
          cleanupCount++;
          return Promise.reject(cleanupPanic);
        },
        () => {
          signalRemovalCount++;
          throw signalPanic;
        },
      );
    } catch (cause) {
      observed = cause;
    }

    expect(observed).toBe(primary);
    expect(signalRemovalCount).toBe(1);
    expect(cleanupCount).toBe(1);
    expect(acpCleanupFailuresForPanic(primary)).toEqual([signalPanic, cleanupPanic]);
  });

  it("preserves cleanup Panic when signal removal throws an ordinary failure", async () => {
    const cleanupPanic = new Panic({ message: "harness cleanup invariant" });
    let cleanupCount = 0;
    let observed: unknown;

    try {
      await runAcpWorkerLifecycle(
        async () => Result.ok(undefined),
        () => {
          cleanupCount++;
          return Promise.reject(cleanupPanic);
        },
        () => {
          throw new Error("signal removal failed");
        },
      );
    } catch (cause) {
      observed = cause;
    }

    expect(observed).toBe(cleanupPanic);
    expect(cleanupCount).toBe(1);
    const secondary = acpCleanupFailuresForPanic(cleanupPanic);
    expect(secondary).toHaveLength(1);
    const signalFailure = secondary[0];
    expect(signalFailure).toBeInstanceOf(ExternalOperationFailed);
    if (signalFailure instanceof ExternalOperationFailed) {
      expect(signalFailure.operation).toBe("remove-worker-signals");
    }
  });

  it("terminates an uncommitted worker when PID persistence fails", async () => {
    const run = {
      id: "run_11111111-1111-4111-8111-111111111111",
      status: "submitted",
      createdAt: 1,
      updatedAt: 1,
      directory: "/repo",
      harnessId: "opencode",
      targetKind: "new",
      promptText: "build feature",
      textPreview: "build feature",
      permissions: createEmptyPermissionCounters(),
    } as const;
    const persistenceFailure = new ExternalOperationFailed({
      operation: "write-run",
      cause: new Error("disk full"),
      message: "disk full",
    });
    let terminationCount = 0;
    let detachCount = 0;

    const admitted = await persistSpawnedWorkerAdmission(
      run,
      {
        pid: 1234,
        detach: () => detachCount++,
        terminate: async () => {
          terminationCount++;
          return Result.ok(undefined);
        },
      },
      async (record) => {
        expect(record.workerPid).toBe(1234);
        return Result.err(persistenceFailure);
      },
    );

    expect(admitted.status).toBe("error");
    if (admitted.status === "error") expect(admitted.error).toBe(persistenceFailure);
    expect(terminationCount).toBe(1);
    expect(detachCount).toBe(0);
  });

  it("terminates on persistence Panic without masking the exact Panic with cleanup failure", async () => {
    const run = {
      id: "run_11111111-1111-4111-8111-111111111111",
      status: "submitted",
      createdAt: 1,
      updatedAt: 1,
      directory: "/repo",
      harnessId: "opencode",
      targetKind: "new",
      promptText: "build feature",
      textPreview: "build feature",
      permissions: createEmptyPermissionCounters(),
    } as const;
    const panic = new Panic({ message: "PID persistence invariant" });
    const cleanupFailure = new ExternalOperationFailed({
      operation: "terminate-worker",
      cause: new Error("termination failed"),
      message: "termination failed",
    });
    let terminationCount = 0;
    let observed: unknown;

    try {
      await persistSpawnedWorkerAdmission(
        run,
        {
          pid: 1234,
          detach: () => undefined,
          terminate: async () => {
            terminationCount++;
            return Result.err(cleanupFailure);
          },
        },
        () => Promise.reject(panic),
      );
    } catch (cause) {
      observed = cause;
    }

    expect(terminationCount).toBe(1);
    expect(observed).toBe(panic);
    expect(acpCleanupFailuresForPanic(panic)).toEqual([cleanupFailure]);
  });

  it("merges sessions across discovered harnesses", async () => {
    await createFakeHarness(tempRoot, {
      commandName: "opencode",
      requiresAcpArg: true,
      harnessId: "opencode",
      sessions: [
        {
          sessionId: "sess_opencode_1",
          cwd: "/repo",
          title: "shared exact title",
          updatedAt: "2026-03-11T00:00:00.000Z",
          history: [],
        },
      ],
    });
    await createFakeHarness(tempRoot, {
      commandName: "codex-acp",
      requiresAcpArg: false,
      harnessId: "codex-acp",
      sessions: [
        {
          sessionId: "sess_codex_1",
          cwd: "/repo",
          title: "shared exact title",
          updatedAt: "2026-03-10T00:00:00.000Z",
          history: [],
        },
      ],
    });

    const result = (await runCliJson(tempRoot, [
      "sessions",
      "list",
      "--directory",
      "/repo",
      "--search",
      "shared",
    ])) as { parsed: { ok: boolean; sessions: ListedSession[] }; exitCode: number };

    expect(result.exitCode).toBe(0);
    expect(result.parsed.ok).toBe(true);
    expect(result.parsed.sessions).toHaveLength(2);
    expect(result.parsed.sessions.map((session) => session.harnessId).sort()).toEqual([
      "codex-acp",
      "opencode",
    ]);
  });

  it("errors on ambiguous exact title matches without --harness", async () => {
    await createFakeHarness(tempRoot, {
      commandName: "opencode",
      requiresAcpArg: true,
      harnessId: "opencode",
      sessions: [
        {
          sessionId: "sess_opencode_1",
          cwd: "/repo",
          title: "shared exact title",
          updatedAt: "2026-03-11T00:00:00.000Z",
          history: [],
        },
      ],
    });
    await createFakeHarness(tempRoot, {
      commandName: "codex-acp",
      requiresAcpArg: false,
      harnessId: "codex-acp",
      sessions: [
        {
          sessionId: "sess_codex_1",
          cwd: "/repo",
          title: "shared exact title",
          updatedAt: "2026-03-10T00:00:00.000Z",
          history: [],
        },
      ],
    });

    const result = (await runCliJson(tempRoot, [
      "prompt",
      "submit",
      "--directory",
      "/repo",
      "--title",
      "shared exact title",
      "--text",
      "continue",
    ])) as {
      parsed: { ok: boolean; candidates?: ListedSession[]; error: string };
      exitCode: number;
    };

    expect(result.exitCode).toBe(1);
    expect(result.parsed.ok).toBe(false);
    expect(result.parsed.candidates).toHaveLength(2);
    expect(result.parsed.error).toContain("exact title match");
  });

  it("refreshes remote session titles instead of pinning the first synced title", async () => {
    const statePath = path.join(tempRoot, "opencode.json");
    await createFakeHarness(tempRoot, {
      commandName: "opencode",
      requiresAcpArg: true,
      harnessId: "opencode",
      sessions: [
        {
          sessionId: "sess_opencode_1",
          cwd: "/repo",
          title: "initial title",
          updatedAt: "2026-03-11T00:00:00.000Z",
          history: [],
        },
      ],
    });

    const first = (await runCliJson(tempRoot, [
      "sessions",
      "list",
      "--directory",
      "/repo",
      "--harness",
      "opencode",
    ])) as { parsed: { sessions: ListedSession[] }; exitCode: number };
    expect(first.exitCode).toBe(0);
    expect(first.parsed.sessions[0]?.title).toBe("initial title");

    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      nextSessionId: number;
      sessions: FakeSession[];
    };
    state.sessions[0] = {
      ...state.sessions[0]!,
      title: "renamed title",
      updatedAt: "2026-03-12T00:00:00.000Z",
    };
    await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");

    const second = (await runCliJson(tempRoot, [
      "sessions",
      "list",
      "--directory",
      "/repo",
      "--harness",
      "opencode",
    ])) as { parsed: { sessions: ListedSession[] }; exitCode: number };
    expect(second.exitCode).toBe(0);
    expect(second.parsed.sessions[0]?.title).toBe("renamed title");
  });

  it("persists detached worker results for wait and result", async () => {
    await createFakeHarness(tempRoot, {
      commandName: "opencode",
      requiresAcpArg: true,
      harnessId: "opencode",
      sessions: [],
    });

    const submit = (await runCliJson(tempRoot, [
      "prompt",
      "submit",
      "--directory",
      "/repo",
      "--harness",
      "opencode",
      "--text",
      "build feature",
    ])) as { parsed: { ok: boolean; runId: string }; exitCode: number };

    expect(submit.exitCode).toBe(0);

    const wait = (await runCliJson(tempRoot, [
      "prompt",
      "wait",
      "--run-id",
      submit.parsed.runId,
    ])) as {
      parsed: { ok: boolean; status: string; resultText?: string };
      exitCode: number;
    };
    expect(wait.exitCode).toBe(0);
    expect(wait.parsed.ok).toBe(true);
    expect(wait.parsed.status).toBe("completed");
    expect(wait.parsed.resultText).toContain("Completed build feature via opencode");

    const result = (await runCliJson(tempRoot, [
      "prompt",
      "result",
      "--run-id",
      submit.parsed.runId,
    ])) as {
      parsed: { ok: boolean; run: PromptRunOutput };
      exitCode: number;
    };
    expect(result.exitCode).toBe(0);
    expect(result.parsed.run.history?.at(-1)?.text).toContain(
      "Completed build feature via opencode",
    );
  });

  it("restarts submitted runs whose background worker disappeared", async () => {
    await createFakeHarness(tempRoot, {
      commandName: "opencode",
      requiresAcpArg: true,
      harnessId: "opencode",
      sessions: [],
    });

    const previousStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = path.join(tempRoot, "state");
    try {
      await saveRunRecord({
        id: "run_11111111-1111-4111-8111-111111111111",
        status: "submitted",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        directory: "/repo",
        harnessId: "opencode",
        targetKind: "new",
        promptText: "build feature",
        textPreview: "build feature",
        permissions: createEmptyPermissionCounters(),
        workerPid: 999_999,
      });
    } finally {
      if (previousStateHome === undefined) {
        delete process.env.XDG_STATE_HOME;
      } else {
        process.env.XDG_STATE_HOME = previousStateHome;
      }
    }

    const wait = (await runCliJson(tempRoot, [
      "prompt",
      "wait",
      "--run-id",
      "run_11111111-1111-4111-8111-111111111111",
    ])) as {
      parsed: { ok: boolean; status: string; resultText?: string };
      exitCode: number;
    };

    expect(wait.exitCode).toBe(0);
    expect(wait.parsed.ok).toBe(true);
    expect(wait.parsed.status).toBe("completed");
    expect(wait.parsed.resultText).toContain("Completed build feature via opencode");
  });

  it("cancels running prompts through the worker", async () => {
    await createFakeHarness(tempRoot, {
      commandName: "opencode",
      requiresAcpArg: true,
      harnessId: "opencode",
      sessions: [],
    });

    const submit = (await runCliJson(tempRoot, [
      "prompt",
      "submit",
      "--directory",
      "/repo",
      "--harness",
      "opencode",
      "--text",
      "sleep please",
    ])) as { parsed: { ok: boolean; runId: string }; exitCode: number };

    expect(submit.exitCode).toBe(0);

    const cancel = (await runCliJson(tempRoot, [
      "prompt",
      "cancel",
      "--run-id",
      submit.parsed.runId,
    ])) as {
      parsed: { ok: boolean };
      exitCode: number;
    };
    expect(cancel.exitCode).toBe(0);
    expect(cancel.parsed.ok).toBe(true);

    const wait = (await runCliJson(tempRoot, [
      "prompt",
      "wait",
      "--run-id",
      submit.parsed.runId,
    ])) as {
      parsed: { ok: boolean; status: string };
      exitCode: number;
    };
    expect(wait.exitCode).toBe(1);
    expect(wait.parsed.ok).toBe(false);
    expect(wait.parsed.status).toBe("cancelled");
  });

  it("renders sessions in human output mode", async () => {
    await createFakeHarness(tempRoot, {
      commandName: "opencode",
      requiresAcpArg: true,
      harnessId: "opencode",
      sessions: [
        {
          sessionId: "sess_opencode_1",
          cwd: "/repo",
          title: "shared exact title",
          updatedAt: "2026-03-11T00:00:00.000Z",
          history: [],
        },
      ],
    });

    const result = await runCliText(tempRoot, [
      "sessions",
      "list",
      "--directory",
      "/repo",
      "--output",
      "human",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Sessions (1)");
    expect(result.stdout).toContain("shared exact title");
    expect(result.stdout).toContain("session: opencode::sess_opencode_1");
  });

  it("renders prompt results in human output mode", async () => {
    await createFakeHarness(tempRoot, {
      commandName: "opencode",
      requiresAcpArg: true,
      harnessId: "opencode",
      sessions: [],
    });

    const submit = (await runCliJson(tempRoot, [
      "prompt",
      "submit",
      "--directory",
      "/repo",
      "--harness",
      "opencode",
      "--text",
      "build feature",
    ])) as { parsed: { runId: string }; exitCode: number };

    expect(submit.exitCode).toBe(0);

    const result = await runCliText(tempRoot, [
      "prompt",
      "wait",
      "--run-id",
      submit.parsed.runId,
      "--output",
      "human",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`Run ${submit.parsed.runId}: completed`);
    expect(result.stdout).toContain("Harness: opencode");
    expect(result.stdout).toContain("Completed build feature via opencode");
  });

  it("shows help in human output mode", async () => {
    const result = await runCliText(tempRoot, ["--help", "--output", "human"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("lilac-acp (ACP harness controller)");
    expect(result.stdout).toContain("--output <json|human>");
  });

  it("accepts global output flags before commands and subcommands", async () => {
    await createFakeHarness(tempRoot, {
      commandName: "opencode",
      requiresAcpArg: true,
      harnessId: "opencode",
      sessions: [
        {
          sessionId: "sess_opencode_1",
          cwd: "/repo",
          title: "shared exact title",
          updatedAt: "2026-03-11T00:00:00.000Z",
          history: [],
        },
      ],
    });

    const version = await runCliText(tempRoot, ["--output", "human", "--version"]);
    expect(version.exitCode).toBe(0);
    expect(version.stdout).toContain("lilac-acp ");

    const snapshot = await runCliText(tempRoot, [
      "sessions",
      "--output",
      "human",
      "snapshot",
      "--directory",
      "/repo",
      "--harness",
      "opencode",
      "--latest",
    ]);
    expect(snapshot.exitCode).toBe(0);
    expect(snapshot.stdout).toContain("Session snapshot");
    expect(snapshot.stdout).toContain("Harness: opencode");
  });
});
