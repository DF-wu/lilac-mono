import { describe, expect, it } from "bun:test";
import type { UIMessageChunk } from "ai";
import { Result, type Result as ResultType } from "better-result";

import {
  MiniLilacCompactionCancelledError,
  MiniLilacExternalOperationFailed,
  MiniLilacTransport,
  type MiniLilacCancelCompactionRequest,
  type MiniLilacCancelCompactionResult,
  type MiniLilacCancelResult,
  type MiniLilacCompactionEvent,
  type MiniLilacCompactInput,
  type MiniLilacCompactOptions,
  type MiniLilacCompactResult,
  type MiniLilacRequestError,
  type MiniLilacResultStream,
  type MiniLilacInterruptQueuedSteeringResult,
  type MiniLilacRedoRequest,
  type MiniLilacRedoResult,
  type MiniLilacSteerRequest,
  type MiniLilacSteerResult,
  type MiniLilacSessionSnapshot,
  type MiniLilacSessionResume,
  type MiniLilacTodoState,
  type MiniLilacUndoRequest,
  type MiniLilacUndoResult,
  type MiniLilacUpdateSessionBindingsInput,
  type MiniLilacUIMessage,
  type MiniLilacUserUIMessage,
} from "@stanley2058/mini-lilac-client";

import type { SessionPresentation } from "./presentation";
import { Controller, expandDraftText, type ControllerUISink } from "./controller";
import type { InputState } from "./input-state";
import type { TranscriptEntry } from "./render";

const SESSION_PRESENTATION = {
  title: "Test session",
  inputTokens: null,
  contextWindow: null,
  historyStateId: "history-1",
  canUndo: true,
  canRedo: false,
} as const;

function idleSnapshot(
  historyStateId: string,
  flags: { readonly canUndo: boolean; readonly canRedo: boolean } = {
    canUndo: true,
    canRedo: true,
  },
): MiniLilacSessionSnapshot {
  return {
    ...SESSION_PRESENTATION,
    id: "session-1",
    activeRunId: null,
    status: "idle",
    cwd: process.cwd(),
    model: "provider/model",
    profile: "coding",
    reasoning: "low",
    historyStateId,
    ...flags,
    queuedSteeringCount: 0,
  };
}

function flush(): Promise<void> {
  // test-wait-justification: drains controller work queued onto the next timer turn by fake transport actions
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve = (_value: T) => {};
  let reject = (_error: unknown) => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function silentUI(): ControllerUISink {
  return { onState: () => {}, onOutput: () => {} };
}

function operationTracker(): {
  readonly ui: ControllerUISink;
  readonly next: () => Promise<void>;
} {
  let running = false;
  const waiters: Array<() => void> = [];
  return {
    ui: {
      onState: (state) => {
        if (state.phase === "submitting") running = true;
        else if (running && state.phase === "idle") {
          running = false;
          waiters.shift()?.();
        }
      },
      onOutput: () => {},
    },
    next: () => new Promise((resolve) => waiters.push(resolve)),
  };
}

function submitText(controller: Controller, text: string): void {
  controller.setEditor(text);
  controller.submit();
}

function messageText(message: MiniLilacUIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

async function captureTestTransport<T>(
  operation: string,
  effect: () => Promise<T>,
): Promise<ResultType<T, MiniLilacExternalOperationFailed>> {
  try {
    return Result.ok(await effect());
  } catch (cause) {
    return Result.err(
      new MiniLilacExternalOperationFailed({
        operation,
        cause,
        message: cause instanceof Error ? cause.message : `${operation} failed`,
      }),
    );
  }
}

function testResultStream(stream: ReadableStream<UIMessageChunk>): MiniLilacResultStream {
  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, ResultType<UIMessageChunk, never>>({
      transform: (chunk, controller) => controller.enqueue(Result.ok(chunk)),
    }),
  );
}

/** A transport whose network methods are stubbed while keeping full typing. */
class FakeTransport extends MiniLilacTransport {
  readonly calls: string[] = [];
  private streamController: ReadableStreamDefaultController<UIMessageChunk> | undefined;
  reconnectCount = 0;
  getMessagesCount = 0;
  getSessionResumeCount = 0;
  sendMessagesCount = 0;
  streamCancelCount = 0;
  undoRequests: MiniLilacUndoRequest[] = [];
  redoRequests: MiniLilacRedoRequest[] = [];
  compactRequests: MiniLilacCompactInput[] = [];
  cancelCompactionRequests: MiniLilacCancelCompactionRequest[] = [];
  bindingRequests: MiniLilacUpdateSessionBindingsInput[] = [];
  localBindings: Array<{ model?: string; profile?: string; reasoning?: string }> = [];
  sendAbortSignal: AbortSignal | undefined;
  steerAbortSignals: Array<AbortSignal | undefined> = [];
  interruptAbortSignals: Array<AbortSignal | undefined> = [];
  interruptRequests: Array<Parameters<MiniLilacTransport["interruptQueuedSteering"]>[0]> = [];
  cancelAbortSignals: Array<AbortSignal | undefined> = [];
  sentMessages: MiniLilacUIMessage[] = [];
  canonicalMessages: MiniLilacUIMessage[] = [];
  canonicalHistoryStateId = "history-1";

  constructor(
    private readonly behavior: {
      readonly failFirstRead?: boolean;
      readonly admissionError?: Error;
      readonly admissionGate?: Promise<void>;
      readonly steerError?: Error;
      readonly steer?: (request: MiniLilacSteerRequest) => Promise<MiniLilacSteerResult>;
      readonly interrupt?: () => Promise<MiniLilacInterruptQueuedSteeringResult>;
      readonly messagesError?: Error;
      readonly getMessages?: () => Promise<MiniLilacUIMessage[]>;
      readonly resume?: () => Promise<MiniLilacSessionResume>;
      readonly cancel?: () => Promise<MiniLilacCancelResult>;
      readonly undo?: (request: MiniLilacUndoRequest) => Promise<MiniLilacUndoResult>;
      readonly redo?: (request: MiniLilacRedoRequest) => Promise<MiniLilacRedoResult>;
      readonly compact?: (
        request: MiniLilacCompactInput,
        options: MiniLilacCompactOptions,
      ) => Promise<MiniLilacCompactResult>;
      readonly cancelCompaction?: () => Promise<MiniLilacCancelCompactionResult>;
      readonly updateBindings?: (
        request: MiniLilacUpdateSessionBindingsInput,
      ) => Promise<MiniLilacSessionSnapshot>;
      readonly session?: MiniLilacSessionSnapshot;
      readonly sessionError?: Error;
      readonly getSession?: () => Promise<MiniLilacSessionSnapshot>;
      readonly reconnectPromise?: Promise<ReadableStream<UIMessageChunk> | null>;
      readonly reconnectStream?: () => ReadableStream<UIMessageChunk> | null;
    } = {},
  ) {
    super({});
  }

  override sendMessages(
    options: Parameters<MiniLilacTransport["sendMessages"]>[0],
  ): Promise<ReadableStream<UIMessageChunk>> {
    this.sendMessagesCount += 1;
    this.sentMessages = options.messages;
    this.sendAbortSignal = options.abortSignal;
    const failFirstRead = this.behavior.failFirstRead === true;
    const stream = new ReadableStream<UIMessageChunk>({
      start: (controller) => {
        this.streamController = controller;
        if (failFirstRead) {
          controller.error(new Error("socket reset"));
        } else {
          controller.enqueue({
            type: "data-streamCursor",
            data: { runId: "run-1", seq: 1 },
            transient: true,
          });
        }
      },
      cancel: () => {
        this.streamCancelCount += 1;
      },
    });
    return (this.behavior.admissionGate ?? Promise.resolve()).then(() => {
      if (this.behavior.admissionError !== undefined) throw this.behavior.admissionError;
      return stream;
    });
  }

  override async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    this.reconnectCount += 1;
    this.calls.push("reconnect");
    const stream =
      this.behavior.reconnectPromise !== undefined
        ? await this.behavior.reconnectPromise
        : (this.behavior.reconnectStream?.() ?? null);
    return stream;
  }

  override steer(
    request: MiniLilacSteerRequest,
    options?: Parameters<MiniLilacTransport["steer"]>[1],
  ): Promise<MiniLilacSteerResult> {
    const text = messageText(request.message);
    this.calls.push(`steer:${text}`);
    this.steerAbortSignals.push(options?.signal);
    if (this.behavior.steer !== undefined) return this.behavior.steer(request);
    if (this.behavior.steerError !== undefined) return Promise.reject(this.behavior.steerError);
    return Promise.resolve({ status: "queued", steeringId: `steer-${text}` });
  }

  override interruptQueuedSteering(
    request: Parameters<MiniLilacTransport["interruptQueuedSteering"]>[0],
    options?: Parameters<MiniLilacTransport["interruptQueuedSteering"]>[1],
  ): Promise<MiniLilacInterruptQueuedSteeringResult> {
    this.calls.push("interrupt");
    this.interruptRequests.push(request);
    this.interruptAbortSignals.push(options?.signal);
    if (this.behavior.interrupt !== undefined) return this.behavior.interrupt();
    return Promise.resolve({ status: "interrupted", steeringIds: [] });
  }

  override cancel(
    _request: Parameters<MiniLilacTransport["cancel"]>[0],
    options?: Parameters<MiniLilacTransport["cancel"]>[1],
  ): Promise<MiniLilacCancelResult> {
    this.calls.push("cancel");
    this.cancelAbortSignals.push(options?.signal);
    if (this.behavior.cancel !== undefined) return this.behavior.cancel();
    try {
      this.streamController?.enqueue({ type: "finish", finishReason: "stop" });
      this.streamController?.close();
    } catch {
      // An errored disconnected stream cannot be closed again.
    }
    return Promise.resolve({ status: "cancelled" });
  }

  override async undo(request: MiniLilacUndoRequest): Promise<MiniLilacUndoResult> {
    this.calls.push("undo");
    this.undoRequests.push(request);
    if (this.behavior.undo === undefined) throw new Error("undo not configured");
    const result = await this.behavior.undo(request);
    if (result.status === "undone") this.canonicalHistoryStateId = result.historyStateId;
    return result;
  }

  override async redo(request: MiniLilacRedoRequest): Promise<MiniLilacRedoResult> {
    this.calls.push("redo");
    this.redoRequests.push(request);
    if (this.behavior.redo === undefined) throw new Error("redo not configured");
    const result = await this.behavior.redo(request);
    if (result.status === "redone") this.canonicalHistoryStateId = result.historyStateId;
    return result;
  }

  override compact(
    request: MiniLilacCompactInput,
    options: MiniLilacCompactOptions = {},
  ): Promise<MiniLilacCompactResult> {
    this.calls.push("compact");
    this.compactRequests.push(request);
    if (this.behavior.compact !== undefined) return this.behavior.compact(request, options);
    return Promise.reject(new Error("compact not configured"));
  }

  override cancelCompaction(
    request: MiniLilacCancelCompactionRequest,
  ): Promise<MiniLilacCancelCompactionResult> {
    this.calls.push("cancelCompaction");
    this.cancelCompactionRequests.push(request);
    return this.behavior.cancelCompaction?.() ?? Promise.resolve({ status: "cancelling" as const });
  }

  override setSessionBindings(bindings: {
    readonly model?: string;
    readonly profile?: string;
    readonly reasoning?:
      | "provider-default"
      | "none"
      | "minimal"
      | "low"
      | "medium"
      | "high"
      | "xhigh";
  }): void {
    this.localBindings.push(bindings);
    super.setSessionBindings(bindings);
  }

  override updateSessionBindings(
    request: MiniLilacUpdateSessionBindingsInput,
  ): Promise<MiniLilacSessionSnapshot> {
    this.bindingRequests.push(request);
    if (this.behavior.updateBindings !== undefined) return this.behavior.updateBindings(request);
    return Promise.reject(new Error("binding update not configured"));
  }

  override getMessages(): Promise<MiniLilacUIMessage[]> {
    this.getMessagesCount += 1;
    if (this.behavior.getMessages !== undefined) return this.behavior.getMessages();
    if (this.behavior.messagesError !== undefined)
      return Promise.reject(this.behavior.messagesError);
    return Promise.resolve(this.canonicalMessages);
  }

  override async getSessionResume(): Promise<MiniLilacSessionResume> {
    this.getSessionResumeCount += 1;
    if (this.behavior.resume !== undefined) return this.behavior.resume();
    const messages = await this.getMessages();
    return {
      snapshot: {
        ...SESSION_PRESENTATION,
        id: "session-1",
        activeRunId: null,
        status: "idle",
        cwd: process.cwd(),
        model: "provider/model",
        profile: "coding",
        reasoning: "low",
        historyStateId: this.canonicalHistoryStateId,
        canUndo: true,
        canRedo: true,
        queuedSteeringCount: 0,
      },
      messages,
      todos: { revision: 0, todos: [] },
      replayCursor: null,
    };
  }

  override getSession(): Promise<MiniLilacSessionSnapshot> {
    if (this.behavior.getSession !== undefined) return this.behavior.getSession();
    if (this.behavior.sessionError !== undefined) return Promise.reject(this.behavior.sessionError);
    if (this.behavior.session !== undefined) return Promise.resolve(this.behavior.session);
    return Promise.reject(new Error("MiniLilac request failed (404): session not found"));
  }

  override async sendMessagesResult(
    options: Parameters<MiniLilacTransport["sendMessagesResult"]>[0],
  ) {
    const sent = await captureTestTransport("send", () => this.sendMessages(options));
    return sent.status === "error"
      ? Result.err(sent.error)
      : Result.ok(testResultStream(sent.value));
  }

  override async reconnectToStreamResult() {
    const reconnected = await captureTestTransport("reconnect", () => this.reconnectToStream());
    if (reconnected.status === "error") return Result.err(reconnected.error);
    return Result.ok(reconnected.value === null ? null : testResultStream(reconnected.value));
  }

  override steerResult(
    request: Parameters<MiniLilacTransport["steerResult"]>[0],
    options?: Parameters<MiniLilacTransport["steerResult"]>[1],
  ) {
    return captureTestTransport("steer", () => this.steer(request, options));
  }

  override interruptQueuedSteeringResult(
    request: Parameters<MiniLilacTransport["interruptQueuedSteeringResult"]>[0],
    options?: Parameters<MiniLilacTransport["interruptQueuedSteeringResult"]>[1],
  ) {
    return captureTestTransport("interrupt", () => this.interruptQueuedSteering(request, options));
  }

  override cancelResult(
    request: Parameters<MiniLilacTransport["cancelResult"]>[0],
    options?: Parameters<MiniLilacTransport["cancelResult"]>[1],
  ) {
    return captureTestTransport("cancel", () => this.cancel(request, options));
  }

  override undoResult(request: Parameters<MiniLilacTransport["undoResult"]>[0]) {
    if (request.clientCommandId === undefined) {
      return Promise.resolve(
        Result.err(
          new MiniLilacExternalOperationFailed({
            operation: "undo",
            cause: undefined,
            message: "undo command ID missing",
          }),
        ),
      );
    }
    const clientCommandId = request.clientCommandId;
    return captureTestTransport("undo", () => this.undo({ ...request, clientCommandId }));
  }

  override redoResult(request: Parameters<MiniLilacTransport["redoResult"]>[0]) {
    if (request.clientCommandId === undefined) {
      return Promise.resolve(
        Result.err(
          new MiniLilacExternalOperationFailed({
            operation: "redo",
            cause: undefined,
            message: "redo command ID missing",
          }),
        ),
      );
    }
    const clientCommandId = request.clientCommandId;
    return captureTestTransport("redo", () => this.redo({ ...request, clientCommandId }));
  }

  override async compactResult(
    request: Parameters<MiniLilacTransport["compactResult"]>[0],
    options?: Parameters<MiniLilacTransport["compactResult"]>[1],
  ) {
    try {
      return Result.ok(await this.compact(request, options));
    } catch (cause) {
      if (cause instanceof MiniLilacCompactionCancelledError) return Result.err(cause);
      return Result.err(
        new MiniLilacExternalOperationFailed({
          operation: "compact",
          cause,
          message: cause instanceof Error ? cause.message : "compact failed",
        }),
      );
    }
  }

  override cancelCompactionResult(
    request: Parameters<MiniLilacTransport["cancelCompactionResult"]>[0],
  ) {
    return captureTestTransport("cancel compaction", () => this.cancelCompaction(request));
  }

  override updateSessionBindingsResult(
    request: Parameters<MiniLilacTransport["updateSessionBindingsResult"]>[0],
  ) {
    return captureTestTransport("bindings", () => this.updateSessionBindings(request));
  }

  override getMessagesResult() {
    return captureTestTransport("messages", () => this.getMessages());
  }

  override getSessionResumeResult(): Promise<
    ResultType<MiniLilacSessionResume, MiniLilacRequestError>
  > {
    return captureTestTransport("resume", () => this.getSessionResume());
  }

  override async getSessionResult() {
    const loaded = await captureTestTransport("session", () => this.getSession());
    if (loaded.status === "error") return loaded;
    if (loaded.value !== undefined) return loaded;
    return Result.err(
      new MiniLilacExternalOperationFailed({
        operation: "session",
        cause: undefined,
        message: "session unavailable",
      }),
    );
  }

  enqueue(chunk: UIMessageChunk): void {
    this.streamController?.enqueue(chunk);
  }

  closeStream(): void {
    this.streamController?.enqueue({ type: "finish", finishReason: "stop" });
    this.streamController?.close();
  }

  closeStreamWithoutFinish(): void {
    this.streamController?.close();
  }
}

describe("Controller effect wiring", () => {
  it("expands repeated placeholders by display range", () => {
    const placeholder = "[Pasted ~3 lines]";
    const text = `${placeholder}\n${placeholder}`;

    expect(
      expandDraftText(
        text,
        [],
        [
          {
            id: "paste-2",
            placeholder,
            start: 18,
            end: 35,
            text: "second",
          },
          {
            id: "paste-1",
            placeholder,
            start: 0,
            end: 17,
            text: `first contains ${placeholder}`,
          },
        ],
      ),
    ).toBe(`first contains ${placeholder}\nsecond`);
  });

  it("uses terminal display offsets when removing file placeholders", () => {
    expect(
      expandDraftText(
        "😀界 [Image 1]",
        [
          {
            id: "image-1",
            placeholder: "[Image 1]",
            start: 5,
            end: 14,
            file: { type: "file", mediaType: "image/png", url: "data:image/png;base64,AA==" },
          },
        ],
        [],
      ),
    ).toBe("😀界");
  });

  it("updates local bindings before a fresh session is admitted", async () => {
    const transport = new FakeTransport();
    const seen: Array<{ model?: string; profile?: string; reasoning?: string }> = [];
    const controller = new Controller({
      transport,
      ui: {
        onState: () => {},
        onOutput: () => {},
        onBindings: (bindings) => seen.push(bindings),
      },
      sessionId: "new-session",
      initialBindings: {
        model: "provider/old",
        profile: "coding",
        reasoning: "low",
      },
      onExit: () => {},
    });
    controller.start();

    expect(await controller.updateSessionBindings({ model: "provider/new" })).toBe(true);
    expect(transport.bindingRequests).toEqual([]);
    expect(transport.localBindings).toEqual([{ model: "provider/new" }]);
    expect(seen.at(-1)).toEqual({
      model: "provider/new",
      profile: "coding",
      reasoning: "low",
    });
    expect(controller.inputState.phase).toBe("idle");
  });

  it("updates durable bindings for an existing quiescent session", async () => {
    const initial: MiniLilacSessionSnapshot = {
      ...SESSION_PRESENTATION,
      id: "session-1",
      activeRunId: null,
      status: "idle",
      cwd: process.cwd(),
      model: "provider/old",
      profile: "coding",
      reasoning: "low",
      queuedSteeringCount: 0,
    };
    const transport = new FakeTransport({
      updateBindings: (request) =>
        Promise.resolve({
          ...initial,
          model: request.model ?? initial.model,
          profile: request.profile ?? initial.profile,
          reasoning: request.reasoning ?? initial.reasoning,
        }),
    });
    let latest: { model?: string; profile?: string; reasoning?: string } | undefined;
    const controller = new Controller({
      transport,
      ui: {
        onState: () => {},
        onOutput: () => {},
        onBindings: (bindings) => {
          latest = bindings;
        },
      },
      sessionId: "session-1",
      initialSnapshot: initial,
      onExit: () => {},
    });
    controller.start();

    expect(await controller.updateSessionBindings({ profile: "review" })).toBe(true);
    expect(transport.bindingRequests).toEqual([
      expect.objectContaining({ sessionId: "session-1", profile: "review" }),
    ]);
    expect(latest).toEqual({ model: "provider/old", profile: "review", reasoning: "low" });
  });

  it("rejects binding changes while a run is active", async () => {
    const transport = new FakeTransport();
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "start");
    await flush();

    expect(await controller.updateSessionBindings({ reasoning: "high" })).toBe(false);
    expect(transport.bindingRequests).toEqual([]);
    controller.dispose();
  });

  it("reconciles a binding update whose responses were lost", async () => {
    const initial: MiniLilacSessionSnapshot = {
      ...SESSION_PRESENTATION,
      id: "session-1",
      activeRunId: null,
      status: "idle",
      cwd: process.cwd(),
      model: "provider/old",
      profile: "coding",
      reasoning: "low",
      queuedSteeringCount: 0,
    };
    const updated = { ...initial, model: "provider/new" };
    const transport = new FakeTransport({
      updateBindings: () => Promise.reject(new Error("response lost")),
      session: updated,
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialSnapshot: initial,
      onExit: () => {},
    });
    controller.start();

    expect(await controller.updateSessionBindings({ model: "provider/new" })).toBe(true);
    expect(transport.bindingRequests).toHaveLength(2);
    expect(transport.bindingRequests[0]?.clientCommandId).toBe(
      transport.bindingRequests[1]?.clientCommandId,
    );
    expect(transport.localBindings.at(-1)).toEqual({
      model: "provider/new",
      profile: "coding",
      reasoning: "low",
    });
    expect(controller.inputState.phase).toBe("idle");
  });

  it("recovers a server-created session after an ambiguous first admission failure", async () => {
    const snapshot: MiniLilacSessionSnapshot = {
      ...SESSION_PRESENTATION,
      id: "session-1",
      activeRunId: null,
      status: "idle",
      cwd: process.cwd(),
      model: "provider/original",
      profile: "coding",
      reasoning: "low",
      queuedSteeringCount: 0,
    };
    const transport = new FakeTransport({
      admissionError: new Error("response lost"),
      session: snapshot,
      updateBindings: (request) =>
        Promise.resolve({
          ...snapshot,
          model: request.model ?? snapshot.model,
          profile: request.profile ?? snapshot.profile,
          reasoning: request.reasoning ?? snapshot.reasoning,
        }),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialBindings: {
        model: "provider/original",
        profile: "coding",
        reasoning: "low",
      },
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "first prompt");
    await flush();
    await flush();

    expect(await controller.updateSessionBindings({ model: "provider/new" })).toBe(true);
    expect(transport.bindingRequests).toEqual([
      expect.objectContaining({ sessionId: "session-1", model: "provider/new" }),
    ]);
    expect(transport.localBindings).toEqual([
      { model: "provider/original", profile: "coding", reasoning: "low" },
    ]);
  });

  it("reconnects an active prompt after its admission response is lost", async () => {
    const snapshot: MiniLilacSessionSnapshot = {
      ...SESSION_PRESENTATION,
      id: "session-1",
      activeRunId: "run-1",
      status: "streaming",
      cwd: process.cwd(),
      model: "provider/model",
      profile: "coding",
      reasoning: "high",
      queuedSteeringCount: 0,
    };
    let transport: FakeTransport;
    transport = new FakeTransport({
      admissionError: new Error("response lost"),
      session: snapshot,
      getMessages: () => Promise.resolve(transport.sentMessages),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialSnapshot: { ...snapshot, activeRunId: null, status: "idle" },
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "admitted once");
    await flush();
    await flush();

    expect(transport.reconnectCount).toBe(1);
    expect(controller.inputState.editor).toBe("");
    expect(controller.transcript.map((entry) => entry.text)).toEqual(["admitted once"]);
  });

  it("follows compaction discovered while recovering ambiguous prompt admission", async () => {
    const compacting: MiniLilacSessionSnapshot = {
      ...SESSION_PRESENTATION,
      id: "session-1",
      activeRunId: null,
      activeCompactionCommandId: "compact-recovery",
      status: "compacting",
      cwd: process.cwd(),
      model: "provider/model",
      profile: "coding",
      reasoning: "high",
      queuedSteeringCount: 0,
    };
    const snapshots = [compacting, { ...compacting, status: "idle" as const }];
    const transport = new FakeTransport({
      admissionError: new Error("response lost"),
      getSession: () => Promise.resolve(snapshots.shift() ?? snapshots[0]!),
    });
    transport.canonicalMessages = [
      { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "before" }] },
    ];
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialSnapshot: { ...compacting, status: "idle" },
      initialMessages: transport.canonicalMessages,
      compactionWatchDelay: () => Promise.resolve(),
      onExit: () => {},
    });
    controller.start();

    submitText(controller, "keep this draft");
    await flush();
    await flush();

    expect(controller.inputState.phase).toBe("idle");
    expect(controller.inputState.editor).toBe("keep this draft");
    expect(controller.transcript.some((entry) => entry.text === "keep this draft")).toBe(false);
  });

  it("reconciles a completed prompt after its admission response is lost", async () => {
    const snapshot: MiniLilacSessionSnapshot = {
      ...SESSION_PRESENTATION,
      id: "session-1",
      activeRunId: null,
      status: "idle",
      cwd: process.cwd(),
      model: "provider/model",
      profile: "coding",
      reasoning: "high",
      queuedSteeringCount: 0,
    };
    let transport: FakeTransport;
    transport = new FakeTransport({
      admissionError: new Error("response lost"),
      session: snapshot,
      getMessages: () =>
        Promise.resolve([
          ...transport.sentMessages,
          {
            id: "assistant-1",
            role: "assistant",
            parts: [{ type: "text", text: "completed once" }],
          },
        ]),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialBindings: {
        model: "provider/model",
        profile: "coding",
        reasoning: "high",
      },
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "admitted once");
    await flush();
    await flush();

    expect(transport.sendMessagesCount).toBe(1);
    expect(controller.inputState.editor).toBe("");
    expect(controller.transcript.map((entry) => entry.text)).toEqual([
      "admitted once",
      "completed once",
    ]);
  });

  it("blocks resubmission when admission and reconciliation are both unreachable", async () => {
    const initial: MiniLilacSessionSnapshot = {
      ...SESSION_PRESENTATION,
      id: "session-1",
      activeRunId: null,
      status: "idle",
      cwd: process.cwd(),
      model: "provider/model",
      profile: "coding",
      reasoning: "high",
      queuedSteeringCount: 0,
    };
    const transport = new FakeTransport({
      admissionError: new Error("response lost"),
      sessionError: new Error("network unreachable"),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialSnapshot: initial,
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "possibly admitted");
    await flush();
    await flush();

    expect(controller.inputState.phase).toBe("disconnected");
    expect(controller.inputState.editor).toBe("");
    expect(controller.transcript.map((entry) => entry.text)).toContain("possibly admitted");
    submitText(controller, "must not resubmit");
    expect(transport.sendMessagesCount).toBe(1);
  });

  it("resolves the active run before cancelling a disconnected admission", async () => {
    let snapshotCalls = 0;
    const transport = new FakeTransport({
      admissionError: new Error("response lost"),
      getSession: () => {
        snapshotCalls += 1;
        if (snapshotCalls === 1) return Promise.reject(new Error("network unreachable"));
        return Promise.resolve({
          ...SESSION_PRESENTATION,
          id: "session-1",
          activeRunId: "run-1",
          status: "streaming",
          cwd: process.cwd(),
          model: "provider/model",
          profile: "coding",
          reasoning: "high",
          queuedSteeringCount: 0,
        });
      },
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialBindings: { model: "provider/model", profile: "coding", reasoning: "high" },
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "possibly admitted");
    await flush();
    await flush();
    expect(controller.inputState.phase).toBe("disconnected");

    controller.escape();
    await flush();
    await flush();
    // One recovery read identifies the run; completion then rechecks session
    // activity before exposing idle controls.
    expect(snapshotCalls).toBe(3);
    expect(transport.calls).toContain("cancel");
  });

  it("submits image-only drafts as file UI parts", async () => {
    const transport = new FakeTransport();
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    controller.addFile({
      id: "image-1",
      placeholder: "[Image 1]",
      start: 0,
      end: 9,
      file: {
        type: "file",
        mediaType: "image/png",
        filename: "clipboard.png",
        url: "data:image/png;base64,AA==",
      },
    });
    controller.setEditor("[Image 1]");
    controller.submit();
    await flush();

    expect(transport.sentMessages.at(-1)?.parts).toEqual([
      {
        type: "file",
        mediaType: "image/png",
        filename: "clipboard.png",
        url: "data:image/png;base64,AA==",
      },
    ]);
    controller.dispose();
  });

  it("expands pasted-text placeholders only in the submitted message", async () => {
    const transport = new FakeTransport();
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    controller.setEditor("Review this:\n[Pasted ~3 lines]");
    controller.addPastedText({
      id: "paste-1",
      placeholder: "[Pasted ~3 lines]",
      start: 13,
      end: 30,
      text: "one\ntwo\nthree",
    });
    controller.submit();
    await flush();

    expect(messageText(transport.sentMessages.at(-1)!)).toBe("Review this:\none\ntwo\nthree");
    controller.dispose();
  });

  it("executes /undo locally, reconciles history, and restores multipart input", async () => {
    const removed: MiniLilacUserUIMessage = {
      id: "user-2",
      role: "user",
      parts: [
        { type: "text", text: "second prompt" },
        {
          type: "file",
          mediaType: "image/png",
          filename: "diagram.png",
          url: "data:image/png;base64,AA==",
        },
      ],
    };
    const remaining: MiniLilacUIMessage[] = [
      { id: "user-1", role: "user", parts: [{ type: "text", text: "first prompt" }] },
      { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "first answer" }] },
    ];
    const transport = new FakeTransport({
      undo: () =>
        Promise.resolve({
          status: "undone",
          clientCommandId: "undo-1",
          message: removed,
          historyStateId: "history-1",
          filesystem: { status: "restored" },
        }),
      getMessages: () => Promise.resolve(remaining),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages: [...remaining, removed],
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "/undo");
    await flush();

    expect(transport.calls).toEqual(["undo"]);
    expect(transport.sendMessagesCount).toBe(0);
    expect(controller.transcript.map((entry) => entry.text)).toEqual([
      "first prompt",
      "first answer",
    ]);
    expect(controller.inputState.editor).toBe("second prompt\n[Image 1]");
    expect(controller.inputState.files.map((file) => file.file.filename)).toEqual(["diagram.png"]);
    expect(controller.inputState.phase).toBe("idle");
  });

  it("treats undo with no user turn as a successful no-op", async () => {
    const initialMessages: MiniLilacUIMessage[] = [
      { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "hello" }] },
    ];
    const transport = new FakeTransport({
      undo: (request) =>
        Promise.resolve({
          status: "empty",
          clientCommandId: request.clientCommandId ?? "missing",
        }),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages,
      onExit: () => {},
    });
    controller.start();
    controller.undo();
    await flush();

    expect(controller.inputState.phase).toBe("idle");
    expect(controller.inputState.editor).toBe("");
    expect(controller.transcript.map((entry) => entry.text)).toEqual(["hello"]);
    expect(transport.getMessagesCount).toBe(0);
  });

  it("runs typed /compact as a quiet submitting operation", async () => {
    const completion = deferred<MiniLilacCompactResult>();
    const initialMessages: MiniLilacUIMessage[] = [
      { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "hello" }] },
    ];
    const transport = new FakeTransport({
      compact: () => completion.promise,
      session: {
        ...SESSION_PRESENTATION,
        id: "session-1",
        activeRunId: null,
        status: "idle",
        cwd: process.cwd(),
        model: "provider/model",
        profile: "coding",
        reasoning: "low",
        queuedSteeringCount: 0,
      },
    });
    transport.canonicalMessages = [
      ...initialMessages,
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
              messageCountBefore: 4,
              messageCountAfter: 2,
            },
          },
        ],
      },
    ];
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages,
      onExit: () => {},
    });
    controller.start();

    submitText(controller, "/compact");
    expect(controller.inputState.phase).toBe("compacting");
    expect(transport.calls).toEqual(["compact"]);
    expect(transport.compactRequests[0]).toEqual({
      sessionId: "session-1",
      clientCommandId: expect.any(String),
    });

    completion.resolve({
      status: "compacted",
      clientCommandId: transport.compactRequests[0]?.clientCommandId ?? "compact-1",
      messageCountBefore: 4,
      messageCountAfter: 2,
    });
    await flush();
    expect(controller.inputState.phase).toBe("idle");
    expect(controller.transcript.map((entry) => entry.text)).toEqual([
      "hello",
      "Context compacted · 4 → 2 msgs",
    ]);
  });

  it("streams compaction progress into one entry that the summary fills in", async () => {
    const completion = deferred<MiniLilacCompactResult>();
    let emit: MiniLilacCompactOptions["onEvent"];
    const transport = new FakeTransport({
      compact: (_request, options) => {
        emit = options.onEvent;
        return completion.promise;
      },
    });
    transport.canonicalMessages = [];
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages: [{ id: "a", role: "assistant", parts: [{ type: "text", text: "hi" }] }],
      onExit: () => {},
    });
    controller.start();
    controller.compact();
    await flush();

    const base = { source: "manual", reason: "manual", messageCountBefore: 4 } as const;
    emit?.({ ...base, phase: "started" });
    emit?.({
      ...base,
      phase: "progress",
      progress: { stage: "history", step: 1, stepCount: 2, pass: 1 },
      summary: "Condensed",
      elapsedMs: 3_000,
    });

    // One entry, rewritten in place, carrying the summary as it generates.
    expect(controller.transcript).toHaveLength(2);
    expect(controller.transcript[1]?.text).toBe(
      "Compacting context · summarizing 1/2 · 3s\nCondensed",
    );
    expect(controller.transcript[1]?.running).toBe(true);

    completion.resolve({
      status: "noop",
      clientCommandId: transport.compactRequests[0]?.clientCommandId ?? "compact-1",
      messageCountBefore: 4,
      messageCountAfter: 4,
    });
    await flush();
    expect(controller.inputState.phase).toBe("idle");
  });

  it("cancels an in-flight compaction on escape through the server, not the request", async () => {
    const completion = deferred<MiniLilacCompactResult>();
    let signal: AbortSignal | undefined;
    let emit: ((event: MiniLilacCompactionEvent) => void) | undefined;
    const transport = new FakeTransport({
      compact: (request, options) => {
        signal = options.signal;
        emit = (event) => options.onEvent?.(event);
        emit({ source: "manual", reason: "manual", phase: "started", messageCountBefore: 4 });
        // Runtime publishes the committed idle snapshot before the terminal
        // event. That must not erase this operation's cancel target in between.
        options.onSession?.({
          ...SESSION_PRESENTATION,
          id: "session-1",
          activeRunId: null,
          status: "idle",
          cwd: process.cwd(),
          model: "provider/model",
          profile: "coding",
          reasoning: "low",
          queuedSteeringCount: 0,
        });
        return completion.promise;
      },
      // The server acknowledges, then reports the terminal phase on the stream
      // that is still open, exactly as the real one does.
      cancelCompaction: () => {
        emit?.({ source: "manual", reason: "manual", phase: "cancelled", messageCountBefore: 4 });
        completion.reject(new MiniLilacCompactionCancelledError());
        return Promise.resolve({ status: "cancelling" as const });
      },
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages: [{ id: "a", role: "assistant", parts: [{ type: "text", text: "hi" }] }],
      onExit: () => {},
    });
    controller.start();
    controller.compact();
    await flush();

    controller.escape();
    await flush();

    // Cancellation is a server command; the request signal is only a detach and
    // must not be used to stop work the server owns.
    expect(transport.cancelCompactionRequests).toEqual([
      {
        sessionId: "session-1",
        clientCommandId: transport.compactRequests[0]?.clientCommandId,
      },
    ]);
    expect(signal?.aborted).toBe(false);
    expect(controller.inputState.phase).toBe("idle");
    // A cancel is reported on the entry, not as a transport error line.
    expect(controller.transcript.map((entry) => entry.kind)).toEqual(["assistant", "compaction"]);
    expect(controller.transcript[1]?.text).toBe("Compaction cancelled · transcript unchanged");
  });

  it("reports a streamed compaction failure once, not twice", async () => {
    const transport = new FakeTransport({
      compact: (_request, options) => {
        options.onEvent?.({
          source: "manual",
          reason: "manual",
          phase: "started",
          messageCountBefore: 4,
        });
        options.onEvent?.({
          source: "manual",
          reason: "manual",
          phase: "failed",
          messageCountBefore: 4,
          error: "summary model unavailable",
        });
        return Promise.reject(new Error("summary model unavailable"));
      },
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages: [{ id: "a", role: "assistant", parts: [{ type: "text", text: "hi" }] }],
      onExit: () => {},
    });
    controller.start();

    controller.compact();
    await flush();

    expect(controller.inputState.phase).toBe("idle");
    // The rejection that follows a terminal event is that same event, so the
    // entry carries the failure and nothing else is appended.
    expect(controller.transcript.map((entry) => entry.kind)).toEqual(["assistant", "compaction"]);
    expect(controller.transcript[1]?.text).toBe(
      "Compaction failed: summary model unavailable · transcript unchanged",
    );
  });

  it("does not claim a compaction failed when only the refresh did", async () => {
    const transport = new FakeTransport({
      compact: (request) =>
        Promise.resolve({
          status: "compacted",
          clientCommandId: request.clientCommandId ?? "compact-1",
          messageCountBefore: 4,
          messageCountAfter: 2,
        }),
      messagesError: new Error("connection reset"),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages: [{ id: "a", role: "assistant", parts: [{ type: "text", text: "hi" }] }],
      onExit: () => {},
    });
    controller.start();

    controller.compact();
    await flush();

    expect(controller.inputState.phase).toBe("idle");
    expect(controller.transcript.at(-1)?.text).toBe(
      "context compacted, but refreshing the transcript failed: connection reset",
    );
  });

  it("adopts successor activity even when the committed transcript refresh fails", async () => {
    const successor: MiniLilacSessionSnapshot = {
      ...SESSION_PRESENTATION,
      id: "session-1",
      activeRunId: "run-successor",
      status: "streaming",
      cwd: process.cwd(),
      model: "provider/model",
      profile: "coding",
      reasoning: "low",
      queuedSteeringCount: 0,
    };
    const reconnect = deferred<ReadableStream<UIMessageChunk> | null>();
    const transport = new FakeTransport({
      compact: (request) =>
        Promise.resolve({
          status: "compacted",
          clientCommandId: request.clientCommandId ?? "compact-1",
          messageCountBefore: 4,
          messageCountAfter: 2,
        }),
      messagesError: new Error("connection reset"),
      session: successor,
      reconnectPromise: reconnect.promise,
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages: [
        { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "hello" }] },
      ],
      onExit: () => {},
    });
    controller.start();

    controller.compact();
    await flush();

    expect(controller.inputState.phase).toBe("active");
    expect(controller.transcript.at(-1)?.text).toBe(
      "context compacted, but refreshing the transcript failed: connection reset",
    );
    controller.dispose();
  });

  it("keeps compact noop and empty results quiet", async () => {
    const statuses: Array<"noop" | "empty"> = ["noop", "empty"];
    const transport = new FakeTransport({
      compact: (request) =>
        Promise.resolve({
          status: statuses.shift() ?? "empty",
          clientCommandId: request.clientCommandId ?? "compact-1",
          messageCountBefore: 0,
          messageCountAfter: 0,
        }),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages: [
        { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "hello" }] },
      ],
      onExit: () => {},
    });
    controller.start();

    controller.compact();
    await flush();
    controller.compact();
    await flush();
    expect(controller.inputState.phase).toBe("idle");
    expect(controller.transcript.map((entry) => entry.text)).toEqual(["hello"]);
  });

  it("keeps representing a detached compaction and refreshes when it ends", async () => {
    const base: MiniLilacSessionSnapshot = {
      ...SESSION_PRESENTATION,
      id: "session-1",
      activeRunId: null,
      activeCompactionCommandId: "compact-detached",
      status: "compacting",
      cwd: process.cwd(),
      model: "provider/model",
      profile: "coding",
      reasoning: "low",
      queuedSteeringCount: 0,
    };
    const firstPoll = deferred<MiniLilacSessionSnapshot>();
    const secondPoll = deferred<MiniLilacSessionSnapshot>();
    const polls = [firstPoll, secondPoll];
    const transport = new FakeTransport({
      compact: () => Promise.reject(new Error("socket hang up")),
      getSession: () => (polls.shift() ?? secondPoll).promise,
    });
    transport.canonicalMessages = [
      { id: "summary-1", role: "assistant", parts: [{ type: "text", text: "compacted view" }] },
    ];
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages: [
        { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "hello" }] },
      ],
      compactionWatchDelay: () => Promise.resolve(),
      onExit: () => {},
    });
    controller.start();

    controller.compact();
    await flush();
    // No terminal event arrived, so the compaction is out of view rather than
    // known to have failed; the client keeps representing it instead of lying
    // about being idle, and follows the session until the server reports.
    expect(controller.inputState.phase).toBe("compacting");
    expect(controller.transcript.at(-1)?.text).toBe(
      "compaction stream interrupted (socket hang up); it continues server-side",
    );

    firstPoll.resolve(base);
    await flush();
    expect(controller.inputState.phase).toBe("compacting");

    secondPoll.resolve({ ...base, status: "idle" });
    await flush();
    expect(controller.inputState.phase).toBe("idle");
    expect(transport.getMessagesCount).toBe(1);
    expect(controller.transcript.map((entry) => entry.text)).toEqual(["compacted view"]);
  });

  it("keeps polling when transcript refresh reveals a successor compaction", async () => {
    const idle: MiniLilacSessionSnapshot = {
      ...SESSION_PRESENTATION,
      id: "session-1",
      activeRunId: null,
      status: "idle",
      cwd: process.cwd(),
      model: "provider/model",
      profile: "coding",
      reasoning: "low",
      queuedSteeringCount: 0,
    };
    const successor = {
      ...idle,
      status: "compacting" as const,
      activeCompactionCommandId: "compact-successor",
    };
    const snapshots = [idle, successor, idle, idle];
    const transport = new FakeTransport({
      compact: () => Promise.reject(new Error("socket hang up")),
      getSession: () => Promise.resolve(snapshots.shift() ?? idle),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages: [
        { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "hello" }] },
      ],
      compactionWatchDelay: () => Promise.resolve(),
      onExit: () => {},
    });
    controller.start();

    controller.compact();
    await flush();
    await flush();

    expect(transport.getMessagesCount).toBe(2);
    expect(controller.inputState.phase).toBe("idle");
  });

  it("retargets escape when a detached compaction is replaced between polls", async () => {
    const base: MiniLilacSessionSnapshot = {
      ...SESSION_PRESENTATION,
      id: "session-1",
      activeRunId: null,
      activeCompactionCommandId: "compact-successor",
      status: "compacting",
      cwd: process.cwd(),
      model: "provider/model",
      profile: "coding",
      reasoning: "low",
      queuedSteeringCount: 0,
    };
    const compactingPoll = deferred<MiniLilacSessionSnapshot>();
    const idlePoll = deferred<MiniLilacSessionSnapshot>();
    const polls = [compactingPoll, idlePoll];
    const transport = new FakeTransport({
      compact: () => Promise.reject(new Error("socket hang up")),
      getSession: () => (polls.shift() ?? idlePoll).promise,
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages: [
        { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "hello" }] },
      ],
      compactionWatchDelay: () => Promise.resolve(),
      onExit: () => {},
    });
    controller.start();

    controller.compact();
    await flush();
    expect(controller.inputState.phase).toBe("compacting");

    // The original detached compaction ended and this poll observed its
    // successor without an idle status in between.
    compactingPoll.resolve(base);
    await flush();

    // `esc cancel` must target the observed generation, not the command whose
    // stream was interrupted.
    controller.escape();
    await flush();
    expect(transport.cancelCompactionRequests).toEqual([
      { sessionId: "session-1", clientCommandId: "compact-successor" },
    ]);

    idlePoll.resolve({ ...base, status: "idle" });
    await flush();
    expect(controller.inputState.phase).toBe("idle");
  });

  it("represents a reopened session's running compaction instead of idling", async () => {
    const base: MiniLilacSessionSnapshot = {
      ...SESSION_PRESENTATION,
      id: "session-1",
      activeRunId: null,
      activeCompactionCommandId: "compact-reopened",
      status: "compacting",
      cwd: process.cwd(),
      model: "provider/model",
      profile: "coding",
      reasoning: "low",
      queuedSteeringCount: 0,
    };
    const poll = deferred<MiniLilacSessionSnapshot>();
    const transport = new FakeTransport({ getSession: () => poll.promise });
    transport.canonicalMessages = [
      { id: "summary-1", role: "assistant", parts: [{ type: "text", text: "compacted view" }] },
    ];
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialSnapshot: base,
      compactionWatchDelay: () => Promise.resolve(),
      onExit: () => {},
    });
    controller.start();

    // The server rejects prompts while compacting; showing `Ready` would offer
    // work the server refuses and hide the `esc cancel` affordance.
    expect(controller.inputState.phase).toBe("compacting");

    controller.escape();
    await flush();
    expect(transport.cancelCompactionRequests).toEqual([
      { sessionId: "session-1", clientCommandId: "compact-reopened" },
    ]);

    poll.resolve({ ...base, status: "idle" });
    await flush();
    expect(controller.inputState.phase).toBe("idle");
    expect(transport.getMessagesCount).toBe(1);
    expect(controller.transcript.map((entry) => entry.text)).toEqual(["compacted view"]);
  });

  it("adopts a prompt run that starts as detached compaction ends", async () => {
    const successor: MiniLilacSessionSnapshot = {
      ...SESSION_PRESENTATION,
      id: "session-1",
      activeRunId: "run-successor",
      status: "streaming",
      cwd: process.cwd(),
      model: "provider/model",
      profile: "coding",
      reasoning: "low",
      queuedSteeringCount: 0,
    };
    const reconnect = deferred<ReadableStream<UIMessageChunk> | null>();
    let steerRequest: MiniLilacSteerRequest | undefined;
    const transport = new FakeTransport({
      compact: (request) =>
        Promise.resolve({
          status: "compacted",
          clientCommandId: request.clientCommandId ?? "compact-1",
          messageCountBefore: 4,
          messageCountAfter: 2,
        }),
      session: successor,
      reconnectPromise: reconnect.promise,
      steer: (request) => {
        steerRequest = request;
        return Promise.resolve({ status: "queued", steeringId: "steer-successor" });
      },
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages: [
        { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "hello" }] },
      ],
      onExit: () => {},
    });
    controller.start();

    controller.compact();
    await flush();
    expect(controller.inputState.phase).toBe("active");

    submitText(controller, "for the successor");
    await flush();
    expect(steerRequest?.runId).toBe("run-successor");
    controller.dispose();
  });

  it("holds escape cancellation until the server admits the compaction", async () => {
    const completion = deferred<MiniLilacCompactResult>();
    let emit: ((event: MiniLilacCompactionEvent) => void) | undefined;
    const transport = new FakeTransport({
      compact: (_request, options) => {
        emit = (event) => options.onEvent?.(event);
        return completion.promise;
      },
      cancelCompaction: () => {
        emit?.({ source: "manual", reason: "manual", phase: "cancelled", messageCountBefore: 4 });
        completion.reject(new MiniLilacCompactionCancelledError());
        return Promise.resolve({ status: "cancelling" as const });
      },
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages: [
        { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "hello" }] },
      ],
      onExit: () => {},
    });
    controller.start();

    controller.compact();
    await flush();
    controller.escape();
    await flush();
    // A cancel that reaches the server before the compact command is admitted
    // answers `inactive`, and the compaction then proceeds despite the user.
    expect(transport.cancelCompactionRequests).toEqual([]);

    emit?.({ source: "manual", reason: "manual", phase: "started", messageCountBefore: 4 });
    await flush();
    expect(transport.cancelCompactionRequests).toEqual([
      {
        sessionId: "session-1",
        clientCommandId: transport.compactRequests[0]?.clientCommandId,
      },
    ]);
    expect(controller.inputState.phase).toBe("idle");
    expect(controller.transcript.at(-1)?.text).toBe("Compaction cancelled · transcript unchanged");
  });

  it("reports a refused compaction request instead of watching for it", async () => {
    const transport = new FakeTransport({
      compact: () =>
        Promise.reject(
          new Error(
            "MiniLilac request failed (409): Session 'session-1' must be quiescent to compact",
          ),
        ),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages: [
        { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "hello" }] },
      ],
      onExit: () => {},
    });
    controller.start();

    controller.compact();
    await flush();
    // The server answered: nothing was admitted, so there is nothing to follow.
    expect(controller.inputState.phase).toBe("idle");
    expect(controller.transcript.at(-1)?.kind).toBe("error");
  });

  it("never compacts or steers while active", async () => {
    const transport = new FakeTransport({
      compact: (request) =>
        Promise.resolve({
          status: "compacted",
          clientCommandId: request.clientCommandId ?? "compact-1",
          messageCountBefore: 4,
          messageCountAfter: 2,
        }),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "start");
    await flush();

    controller.compact();
    submitText(controller, "/compact");
    await flush();
    expect(transport.compactRequests).toEqual([]);
    expect(transport.calls).not.toContain("steer:/compact");
    expect(controller.inputState.editor).toBe("/compact");
    controller.dispose();
  });

  it("publishes initial and updated session presentation", async () => {
    const initial = {
      id: "session-1",
      activeRunId: null,
      status: "idle" as const,
      cwd: process.cwd(),
      model: "provider/model",
      profile: "coding",
      reasoning: "low" as const,
      queuedSteeringCount: 0,
      historyStateId: "history-1",
      canUndo: true,
      canRedo: false,
      title: "Initial title",
      inputTokens: 1_000,
      contextWindow: 10_000,
    };
    const updated = {
      ...initial,
      profile: "review",
      title: "Updated title",
      inputTokens: 2_500,
    };
    const seen: SessionPresentation[] = [];
    const transport = new FakeTransport({ updateBindings: () => Promise.resolve(updated) });
    const controller = new Controller({
      transport,
      ui: {
        onState: () => {},
        onOutput: () => {},
        onSession: (session) => seen.push(session),
      },
      sessionId: "session-1",
      initialSnapshot: initial,
      onExit: () => {},
    });
    controller.start();
    expect(seen.at(-1)).toEqual({
      title: "Initial title",
      inputTokens: 1_000,
      inputTokensEstimated: false,
      contextWindow: 10_000,
      compactionThreshold: null,
    });

    expect(await controller.updateSessionBindings({ profile: "review" })).toBe(true);
    expect(seen.at(-1)).toEqual({
      title: "Updated title",
      inputTokens: 2_500,
      inputTokensEstimated: false,
      contextWindow: 10_000,
      compactionThreshold: null,
    });
  });

  it("does not call the server when undoing before session creation", async () => {
    const transport = new FakeTransport();
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    controller.undo();
    await flush();

    expect(controller.inputState.phase).toBe("idle");
    expect(transport.undoRequests).toEqual([]);
    expect(controller.transcript).toEqual([]);
  });

  it("retries an uncertain undo with the same idempotency key", async () => {
    const removed: MiniLilacUserUIMessage = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "restore me" }],
    };
    let attempt = 0;
    const transport = new FakeTransport({
      undo: (request) => {
        attempt += 1;
        if (attempt === 1) return Promise.reject(new Error("response lost"));
        return Promise.resolve({
          status: "undone",
          clientCommandId: request.clientCommandId ?? "missing",
          message: removed,
          historyStateId: "history-1",
          filesystem: { status: "restored" },
        });
      },
      getMessages: () => Promise.resolve([]),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages: [removed],
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "/undo");
    await flush();

    expect(transport.undoRequests).toHaveLength(2);
    expect(transport.undoRequests[0]?.clientCommandId).toBe(
      transport.undoRequests[1]?.clientCommandId,
    );
    expect(controller.inputState.editor).toBe("restore me");
  });

  it("keeps the undo idempotency key after both responses are uncertain", async () => {
    const removed: MiniLilacUserUIMessage = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "restore me" }],
    };
    let attempt = 0;
    const transport = new FakeTransport({
      undo: (request) => {
        attempt += 1;
        if (attempt <= 2) return Promise.reject(new Error("response lost"));
        return Promise.resolve({
          status: "undone",
          clientCommandId: request.clientCommandId ?? "missing",
          message: removed,
          historyStateId: "history-1",
          filesystem: { status: "restored" },
        });
      },
      getMessages: () => Promise.resolve([]),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages: [removed],
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "/undo");
    await flush();
    expect(transport.undoRequests).toHaveLength(2);

    submitText(controller, "/undo");
    await flush();
    expect(transport.undoRequests).toHaveLength(3);
    expect(new Set(transport.undoRequests.map((request) => request.clientCommandId)).size).toBe(1);
    expect(controller.inputState.editor).toBe("restore me");
  });

  it("supersedes an uncertain undo key when a new prompt is admitted", async () => {
    const removed: MiniLilacUserUIMessage = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "restore me" }],
    };
    let attempt = 0;
    const transport = new FakeTransport({
      undo: (request) => {
        attempt += 1;
        if (attempt <= 2) return Promise.reject(new Error("response lost"));
        return Promise.resolve({
          status: "undone",
          clientCommandId: request.clientCommandId ?? "missing",
          message: removed,
          historyStateId: "history-1",
          filesystem: { status: "restored" },
        });
      },
      getMessages: () => Promise.resolve([]),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages: [removed],
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "/undo");
    await flush();
    const uncertainId = transport.undoRequests[0]?.clientCommandId;

    submitText(controller, "new prompt");
    await flush();
    transport.closeStream();
    await flush();
    submitText(controller, "/undo");
    await flush();

    expect(transport.undoRequests).toHaveLength(3);
    expect(transport.undoRequests[2]?.clientCommandId).not.toBe(uncertainId);
  });

  it("supersedes an uncertain redo key only after a new prompt is admitted", async () => {
    const redone: MiniLilacUserUIMessage = {
      id: "user-redo-after-prompt",
      role: "user",
      parts: [{ type: "text", text: "redo after prompt" }],
    };
    let attempt = 0;
    const transport = new FakeTransport({
      redo: (request) => {
        attempt += 1;
        if (attempt <= 2) return Promise.reject(new Error("response lost"));
        return Promise.resolve({
          status: "redone",
          clientCommandId: request.clientCommandId,
          message: redone,
          historyStateId: "history-redone",
          filesystem: { status: "restored" },
        });
      },
      getMessages: () => Promise.resolve([redone]),
    });
    const operations = operationTracker();
    const controller = new Controller({
      transport,
      ui: operations.ui,
      sessionId: "session-1",
      initialMessages: [
        { id: "assistant-before", role: "assistant", parts: [{ type: "text", text: "before" }] },
      ],
      onExit: () => {},
    });
    controller.start();
    const uncertain = operations.next();
    controller.redo();
    await uncertain;
    const uncertainId = transport.redoRequests[0]?.clientCommandId;

    const promptCompleted = operations.next();
    submitText(controller, "admitted prompt");
    await Promise.resolve();
    await Promise.resolve();
    transport.closeStream();
    await promptCompleted;
    const retried = operations.next();
    controller.redo();
    await retried;

    expect(transport.redoRequests).toHaveLength(3);
    expect(transport.redoRequests[2]?.clientCommandId).not.toBe(uncertainId);
  });

  it("keeps an uncertain undo key when the superseding prompt fails admission", async () => {
    const removed: MiniLilacUserUIMessage = {
      id: "user-undo-failed-prompt",
      role: "user",
      parts: [{ type: "text", text: "restore me" }],
    };
    let attempt = 0;
    const transport = new FakeTransport({
      admissionError: new Error("prompt rejected"),
      undo: (request) => {
        attempt += 1;
        if (attempt <= 2) return Promise.reject(new Error("undo response lost"));
        return Promise.resolve({
          status: "undone",
          clientCommandId: request.clientCommandId,
          message: removed,
          historyStateId: "history-undone",
          filesystem: { status: "restored" },
        });
      },
      getMessages: () => Promise.resolve([]),
    });
    const operations = operationTracker();
    const controller = new Controller({
      transport,
      ui: operations.ui,
      sessionId: "session-1",
      initialMessages: [removed],
      onExit: () => {},
    });
    controller.start();

    const uncertain = operations.next();
    controller.undo();
    await uncertain;
    const uncertainId = transport.undoRequests[0]?.clientCommandId;

    const failedPrompt = operations.next();
    submitText(controller, "not admitted");
    await failedPrompt;

    const retried = operations.next();
    controller.undo();
    await retried;
    expect(transport.undoRequests).toHaveLength(3);
    expect(transport.undoRequests[2]?.clientCommandId).toBe(uncertainId);
  });

  it("keeps an uncertain redo key when the superseding prompt fails admission", async () => {
    const redone: MiniLilacUserUIMessage = {
      id: "user-redo-failed-prompt",
      role: "user",
      parts: [{ type: "text", text: "redo me" }],
    };
    let attempt = 0;
    const transport = new FakeTransport({
      admissionError: new Error("prompt rejected"),
      redo: (request) => {
        attempt += 1;
        if (attempt <= 2) return Promise.reject(new Error("redo response lost"));
        return Promise.resolve({
          status: "redone",
          clientCommandId: request.clientCommandId,
          message: redone,
          historyStateId: "history-redone",
          filesystem: { status: "restored" },
        });
      },
      getMessages: () => Promise.resolve([redone]),
    });
    const operations = operationTracker();
    const controller = new Controller({
      transport,
      ui: operations.ui,
      sessionId: "session-1",
      initialMessages: [
        { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "before" }] },
      ],
      onExit: () => {},
    });
    controller.start();

    const uncertain = operations.next();
    controller.redo();
    await uncertain;
    const uncertainId = transport.redoRequests[0]?.clientCommandId;

    const failedPrompt = operations.next();
    submitText(controller, "not admitted");
    await failedPrompt;

    const retried = operations.next();
    controller.redo();
    await retried;
    expect(transport.redoRequests).toHaveLength(3);
    expect(transport.redoRequests[2]?.clientCommandId).toBe(uncertainId);
  });

  it("restores the draft when canonical refresh fails after undo commits", async () => {
    const removed: MiniLilacUserUIMessage = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "restore me" }],
    };
    const transport = new FakeTransport({
      undo: (request) =>
        Promise.resolve({
          status: "undone",
          clientCommandId: request.clientCommandId ?? "missing",
          message: removed,
          historyStateId: "history-1",
          filesystem: { status: "restored" },
        }),
      messagesError: new Error("offline"),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages: [removed],
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "/undo");
    await flush();

    expect(controller.inputState.editor).toBe("restore me");
    expect(controller.inputState.phase).toBe("idle");
    expect(controller.transcript.at(-1)?.text).toContain(
      "undo committed on server; transcript refresh failed",
    );
  });

  it("preserves text entered while undo is in flight", async () => {
    const removed: MiniLilacUserUIMessage = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "restored prompt" }],
    };
    const undo = deferred<MiniLilacUndoResult>();
    const transport = new FakeTransport({
      undo: () => undo.promise,
      getMessages: () => Promise.resolve([]),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages: [removed],
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "/undo");
    controller.setEditor("new draft text");
    undo.resolve({
      status: "undone",
      clientCommandId: "undo-1",
      message: removed,
      historyStateId: "history-1",
      filesystem: { status: "restored" },
    });
    await flush();

    expect(controller.inputState.editor).toBe("restored prompt\nnew draft text");
  });

  it("preserves pasted-text metadata entered while undo is in flight", async () => {
    const removed: MiniLilacUserUIMessage = {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text: "restored prompt" }],
    };
    const undo = deferred<MiniLilacUndoResult>();
    const transport = new FakeTransport({
      undo: () => undo.promise,
      getMessages: () => Promise.resolve([]),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages: [removed],
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "/undo");
    controller.setEditor("[Pasted ~3 lines]");
    controller.addPastedText({
      id: "paste-1",
      placeholder: "[Pasted ~3 lines]",
      start: 0,
      end: 17,
      text: "one\ntwo\nthree",
    });
    undo.resolve({
      status: "undone",
      clientCommandId: "undo-1",
      message: removed,
      historyStateId: "history-1",
      filesystem: { status: "restored" },
    });
    await flush();

    expect(controller.inputState.editor).toBe("restored prompt\n[Pasted ~3 lines]");
    expect(controller.inputState.pastedTexts).toMatchObject([
      { id: "paste-1", start: 16, end: 33 },
    ]);
    expect(
      expandDraftText(
        controller.inputState.editor,
        controller.inputState.files,
        controller.inputState.pastedTexts,
      ),
    ).toBe("restored prompt\none\ntwo\nthree");
  });

  it("redoes canonical history and clears an unchanged automatically restored draft", async () => {
    const message: MiniLilacUserUIMessage = {
      id: "user-redo",
      role: "user",
      parts: [
        { type: "text", text: "restore this" },
        {
          type: "file",
          mediaType: "image/png",
          filename: "diagram.png",
          url: "data:image/png;base64,AA==",
        },
      ],
    };
    let canonical: MiniLilacUIMessage[] = [];
    const transport = new FakeTransport({
      undo: (request) =>
        Promise.resolve({
          status: "undone",
          clientCommandId: request.clientCommandId,
          message,
          historyStateId: "history-root",
          filesystem: { status: "restored" },
        }),
      redo: (request) => {
        canonical = [
          message,
          { id: "assistant-redo", role: "assistant", parts: [{ type: "text", text: "answer" }] },
        ];
        return Promise.resolve({
          status: "redone",
          clientCommandId: request.clientCommandId,
          message,
          historyStateId: "history-redone",
          filesystem: { status: "restored" },
        });
      },
      getMessages: () => Promise.resolve(canonical),
    });
    const operations = operationTracker();
    const controller = new Controller({
      transport,
      ui: operations.ui,
      sessionId: "session-1",
      initialMessages: [message],
      onExit: () => {},
    });
    controller.start();

    const undoCompleted = operations.next();
    controller.undo();
    await undoCompleted;
    expect(controller.inputState).toMatchObject({
      editor: "restore this\n[Image 1]",
      phase: "idle",
    });
    expect(controller.inputState.files).toHaveLength(1);

    const redoCompleted = operations.next();
    controller.redo();
    await redoCompleted;
    expect(transport.calls).toEqual(["undo", "redo"]);
    expect(controller.inputState).toMatchObject({
      editor: "",
      files: [],
      pastedTexts: [],
      phase: "idle",
    });
    expect(controller.transcript.map((entry) => entry.text)).toEqual([
      "restore this",
      "Image: diagram.png",
      "answer",
    ]);
  });

  it("restores the exact pre-existing multipart draft after undo then redo", async () => {
    const removed: MiniLilacUserUIMessage = {
      id: "user-preexisting-draft",
      role: "user",
      parts: [{ type: "text", text: "removed prompt" }],
    };
    const pastedText = {
      id: "paste-existing",
      placeholder: "[Pasted ~3 lines]",
      start: 6,
      end: 23,
      text: "one\ntwo\nthree",
    };
    const file = {
      id: "file-existing",
      placeholder: "[Image 9]",
      start: 24,
      end: 33,
      file: {
        type: "file" as const,
        mediaType: "image/png",
        filename: "existing.png",
        url: "data:image/png;base64,AA==",
      },
    };
    let canonical: MiniLilacUIMessage[] = [];
    const transport = new FakeTransport({
      undo: (request) =>
        Promise.resolve({
          status: "undone",
          clientCommandId: request.clientCommandId,
          message: removed,
          historyStateId: "history-before",
          filesystem: { status: "restored" },
        }),
      redo: (request) => {
        canonical = [removed];
        return Promise.resolve({
          status: "redone",
          clientCommandId: request.clientCommandId,
          message: removed,
          historyStateId: "history-after",
          filesystem: { status: "restored" },
        });
      },
      getMessages: () => Promise.resolve(canonical),
    });
    const operations = operationTracker();
    const controller = new Controller({
      transport,
      ui: operations.ui,
      sessionId: "session-1",
      initialMessages: [removed],
      onExit: () => {},
    });
    controller.start();
    controller.setEditor("notes\n[Pasted ~3 lines]\n[Image 9]");
    controller.addPastedText(pastedText);
    controller.addFile(file);
    const before = {
      editor: controller.inputState.editor,
      files: controller.inputState.files,
      pastedTexts: controller.inputState.pastedTexts,
    };

    const undoCompleted = operations.next();
    controller.undo();
    await undoCompleted;
    expect(controller.inputState.editor).toBe(
      "removed prompt\nnotes\n[Pasted ~3 lines]\n[Image 9]",
    );

    const redoCompleted = operations.next();
    controller.redo();
    await redoCompleted;
    expect(controller.inputState.editor).toBe(before.editor);
    expect(controller.inputState.files).toEqual(before.files);
    expect(controller.inputState.pastedTexts).toEqual(before.pastedTexts);
  });

  it("unwinds repeated undo draft injections one level per redo", async () => {
    const first: MiniLilacUserUIMessage = {
      id: "user-first-history",
      role: "user",
      parts: [{ type: "text", text: "first" }],
    };
    const second: MiniLilacUserUIMessage = {
      id: "user-second-history",
      role: "user",
      parts: [{ type: "text", text: "second" }],
    };
    const undoTargets = [second, first];
    const redoTargets = [first, second];
    let canonical: MiniLilacUIMessage[] = [first, second];
    const transport = new FakeTransport({
      undo: (request) => {
        const message = undoTargets.shift();
        if (message === undefined) throw new Error("missing undo target");
        canonical = message.id === second.id ? [first] : [];
        return Promise.resolve({
          status: "undone",
          clientCommandId: request.clientCommandId,
          message,
          historyStateId: `undo-${message.id}`,
          filesystem: { status: "restored" },
        });
      },
      redo: (request) => {
        const message = redoTargets.shift();
        if (message === undefined) throw new Error("missing redo target");
        canonical = message.id === first.id ? [first] : [first, second];
        return Promise.resolve({
          status: "redone",
          clientCommandId: request.clientCommandId,
          message,
          historyStateId: `redo-${message.id}`,
          filesystem: { status: "restored" },
        });
      },
      getMessages: () => Promise.resolve(canonical),
    });
    const operations = operationTracker();
    const controller = new Controller({
      transport,
      ui: operations.ui,
      sessionId: "session-1",
      initialMessages: canonical,
      onExit: () => {},
    });
    controller.start();

    for (const expected of ["second", "first\nsecond"]) {
      const completed = operations.next();
      controller.undo();
      await completed;
      expect(controller.inputState.editor).toBe(expected);
    }
    for (const expected of ["second", ""]) {
      const completed = operations.next();
      controller.redo();
      await completed;
      expect(controller.inputState.editor).toBe(expected);
    }
  });

  it("keeps typed, pasted, and attached drafts after redo", async () => {
    for (const mutation of ["typed", "pasted", "attached"] as const) {
      const message: MiniLilacUserUIMessage = {
        id: `user-${mutation}`,
        role: "user",
        parts: [{ type: "text", text: "automatic draft" }],
      };
      let canonical: MiniLilacUIMessage[] = [];
      const transport = new FakeTransport({
        undo: (request) =>
          Promise.resolve({
            status: "undone",
            clientCommandId: request.clientCommandId,
            message,
            historyStateId: `history-${mutation}-undo`,
            filesystem: { status: "restored" },
          }),
        redo: (request) => {
          canonical = [message];
          return Promise.resolve({
            status: "redone",
            clientCommandId: request.clientCommandId,
            message,
            historyStateId: `history-${mutation}-redo`,
            filesystem: { status: "restored" },
          });
        },
        getMessages: () => Promise.resolve(canonical),
      });
      const operations = operationTracker();
      const controller = new Controller({
        transport,
        ui: operations.ui,
        sessionId: `session-${mutation}`,
        initialMessages: [message],
        onExit: () => {},
      });
      controller.start();
      const undoCompleted = operations.next();
      controller.undo();
      await undoCompleted;

      if (mutation === "typed") controller.setEditor("automatic draft\nuser text");
      if (mutation === "pasted") {
        controller.setEditor("automatic draft\n[Pasted ~3 lines]");
        controller.addPastedText({
          id: "paste-user",
          placeholder: "[Pasted ~3 lines]",
          start: 16,
          end: 33,
          text: "one\ntwo\nthree",
        });
      }
      if (mutation === "attached") {
        controller.setEditor("automatic draft\n[Image 1]");
        controller.addFile({
          id: "image-user",
          placeholder: "[Image 1]",
          start: 16,
          end: 25,
          file: { type: "file", mediaType: "image/png", url: "data:image/png;base64,AA==" },
        });
      }
      const beforeRedo = controller.inputState;
      const redoCompleted = operations.next();
      controller.redo();
      await redoCompleted;
      expect(controller.inputState.editor).toBe(beforeRedo.editor);
      expect(controller.inputState.files).toEqual(beforeRedo.files);
      expect(controller.inputState.pastedTexts).toEqual(beforeRedo.pastedTexts);
      controller.dispose();
    }
  });

  it("keeps a matching draft after process-local undo provenance is lost", async () => {
    const message: MiniLilacUserUIMessage = {
      id: "user-restarted",
      role: "user",
      parts: [{ type: "text", text: "automatic draft" }],
    };
    const transport = new FakeTransport({
      redo: (request) =>
        Promise.resolve({
          status: "redone",
          clientCommandId: request.clientCommandId,
          message,
          historyStateId: "history-redone",
          filesystem: { status: "restored" },
        }),
      getMessages: () => Promise.resolve([message]),
    });
    const operations = operationTracker();
    const controller = new Controller({
      transport,
      ui: operations.ui,
      sessionId: "session-1",
      initialMessages: [message],
      onExit: () => {},
    });
    controller.start();
    controller.setEditor("automatic draft");

    const redoCompleted = operations.next();
    controller.redo();
    await redoCompleted;
    expect(controller.inputState.editor).toBe("automatic draft");
  });

  it("treats empty redo as a successful no-op", async () => {
    const transport = new FakeTransport({
      redo: (request) =>
        Promise.resolve({ status: "empty", clientCommandId: request.clientCommandId }),
    });
    const operations = operationTracker();
    const controller = new Controller({
      transport,
      ui: operations.ui,
      sessionId: "session-1",
      initialMessages: [
        { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "hello" }] },
      ],
      onExit: () => {},
    });
    controller.start();

    const completed = operations.next();
    controller.redo();
    await completed;
    expect(controller.inputState.phase).toBe("idle");
    expect(transport.redoRequests).toHaveLength(1);
    expect(transport.getMessagesCount).toBe(0);
  });

  it("reuses the redo command id after both retry responses are uncertain", async () => {
    const message: MiniLilacUserUIMessage = {
      id: "user-retry-redo",
      role: "user",
      parts: [{ type: "text", text: "retry redo" }],
    };
    let attempt = 0;
    const transport = new FakeTransport({
      redo: (request) => {
        attempt += 1;
        if (attempt <= 2) return Promise.reject(new Error("response lost"));
        return Promise.resolve({
          status: "redone",
          clientCommandId: request.clientCommandId,
          message,
          historyStateId: "history-redone",
          filesystem: { status: "restored" },
        });
      },
      getMessages: () => Promise.resolve([message]),
    });
    const operations = operationTracker();
    const controller = new Controller({
      transport,
      ui: operations.ui,
      sessionId: "session-1",
      initialMessages: [
        { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "hello" }] },
      ],
      onExit: () => {},
    });
    controller.start();

    const uncertain = operations.next();
    controller.redo();
    await uncertain;
    expect(transport.redoRequests).toHaveLength(2);

    const completed = operations.next();
    controller.redo();
    await completed;
    expect(transport.redoRequests).toHaveLength(3);
    expect(new Set(transport.redoRequests.map((request) => request.clientCommandId)).size).toBe(1);
  });

  it("leaves assistant/tool transcript untouched when a steering redo needs refresh", async () => {
    const message: MiniLilacUserUIMessage = {
      id: "user-fallback-redo",
      role: "user",
      parts: [{ type: "text", text: "steering target" }],
    };
    const transport = new FakeTransport({
      redo: (request) =>
        Promise.resolve({
          status: "redone",
          clientCommandId: request.clientCommandId,
          message,
          historyStateId: "history-redone",
          filesystem: { status: "restored" },
        }),
      messagesError: new Error("offline"),
    });
    const operations = operationTracker();
    const notices: string[] = [];
    const controller = new Controller({
      transport,
      ui: { ...operations.ui, onNotice: (notice) => notices.push(notice) },
      sessionId: "session-1",
      initialMessages: [
        { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "hello" }] },
        {
          id: "assistant-tool",
          role: "assistant",
          parts: [
            {
              type: "dynamic-tool",
              toolName: "read_file",
              toolCallId: "read-1",
              state: "output-available",
              input: { path: "src/index.ts" },
              output: "contents",
            },
          ],
        },
      ],
      onExit: () => {},
    });
    controller.start();
    const transcriptBefore = controller.transcript;

    const completed = operations.next();
    controller.redo();
    await completed;
    expect(controller.transcript).toEqual(transcriptBefore);
    expect(notices).toEqual(["Redo committed; transcript refresh required: offline"]);
    expect(controller.inputState.phase).toBe("idle");
  });

  it("reports redo refresh failure and skipped filesystem restoration without transcript mutation", async () => {
    const message: MiniLilacUserUIMessage = {
      id: "user-refresh-and-filesystem-warning",
      role: "user",
      parts: [{ type: "text", text: "redo target" }],
    };
    const notices: string[] = [];
    const transport = new FakeTransport({
      redo: (request) =>
        Promise.resolve({
          status: "redone",
          clientCommandId: request.clientCommandId,
          message,
          historyStateId: "history-redone-warning",
          filesystem: { status: "skipped", reason: "snapshot-unavailable" },
        }),
      messagesError: new Error("resume unavailable"),
    });
    const operations = operationTracker();
    const controller = new Controller({
      transport,
      ui: { ...operations.ui, onNotice: (notice) => notices.push(notice) },
      sessionId: "session-1",
      initialMessages: [
        { id: "assistant-existing", role: "assistant", parts: [{ type: "text", text: "keep" }] },
      ],
      onExit: () => {},
    });
    controller.start();
    const transcriptBefore = controller.transcript;

    const completed = operations.next();
    controller.redo();
    await completed;
    expect(controller.transcript).toEqual(transcriptBefore);
    expect(notices).toEqual([
      "Redo committed; transcript refresh required: resume unavailable. Managed worktree unchanged because no worktree snapshot is available.",
    ]);
  });

  it("renders a newer authoritative history race without applying stale undo draft effects", async () => {
    const removed: MiniLilacUserUIMessage = {
      id: "user-stale-undo",
      role: "user",
      parts: [{ type: "text", text: "stale undo draft" }],
    };
    const authoritative: MiniLilacUIMessage[] = [
      { id: "user-latest", role: "user", parts: [{ type: "text", text: "latest prompt" }] },
      {
        id: "assistant-latest",
        role: "assistant",
        parts: [{ type: "text", text: "latest answer" }],
      },
    ];
    const notices: string[] = [];
    const transport = new FakeTransport({
      undo: (request) =>
        Promise.resolve({
          status: "undone",
          clientCommandId: request.clientCommandId,
          message: removed,
          historyStateId: "history-undone",
          filesystem: { status: "restored" },
        }),
      resume: () =>
        Promise.resolve({
          snapshot: idleSnapshot("history-newer", { canUndo: false, canRedo: true }),
          messages: authoritative,
          todos: { revision: 0, todos: [] },
          replayCursor: null,
        }),
    });
    const operations = operationTracker();
    const controller = new Controller({
      transport,
      ui: { ...operations.ui, onNotice: (notice) => notices.push(notice) },
      sessionId: "session-1",
      initialMessages: [removed],
      onExit: () => {},
    });
    controller.start();
    controller.setEditor("keep this draft");

    const completed = operations.next();
    controller.undo();
    await completed;
    expect(controller.transcript.map((entry) => entry.text)).toEqual([
      "latest prompt",
      "latest answer",
    ]);
    expect(controller.inputState.editor).toBe("keep this draft");
    expect(controller.historyNavigation).toEqual({
      historyStateId: "history-newer",
      canUndo: false,
      canRedo: true,
    });
    expect(notices).toEqual(["History changed again; showing latest server state."]);
  });

  it("ignores a replayed old redo result when resume points at a newer state", async () => {
    const staleTarget: MiniLilacUserUIMessage = {
      id: "user-old-redo",
      role: "user",
      parts: [{ type: "text", text: "old redo target" }],
    };
    const authoritative: MiniLilacUIMessage[] = [
      { id: "user-current", role: "user", parts: [{ type: "text", text: "current branch" }] },
    ];
    const transport = new FakeTransport({
      redo: (request) =>
        Promise.resolve({
          status: "redone",
          clientCommandId: request.clientCommandId,
          message: staleTarget,
          historyStateId: "history-old-command",
          filesystem: { status: "restored" },
        }),
      resume: () =>
        Promise.resolve({
          snapshot: idleSnapshot("history-current", { canUndo: true, canRedo: false }),
          messages: authoritative,
          todos: { revision: 0, todos: [] },
          replayCursor: null,
        }),
    });
    const operations = operationTracker();
    const controller = new Controller({
      transport,
      ui: operations.ui,
      sessionId: "session-1",
      initialMessages: authoritative,
      onExit: () => {},
    });
    controller.start();
    controller.setEditor("local draft survives");

    const completed = operations.next();
    controller.redo();
    await completed;
    expect(controller.transcript.map((entry) => entry.text)).toEqual(["current branch"]);
    expect(controller.inputState.editor).toBe("local draft survives");
    expect(controller.historyNavigation).toEqual({
      historyStateId: "history-current",
      canUndo: true,
      canRedo: false,
    });
  });

  it("treats a same-state active prompt as authoritative after undo", async () => {
    const removed: MiniLilacUserUIMessage = {
      id: "user-same-state-undo",
      role: "user",
      parts: [{ type: "text", text: "must not become a draft" }],
    };
    const resumeObserved = deferred<void>();
    const activeObserved = deferred<void>();
    const cancelObserved = deferred<void>();
    const reconnect = deferred<ReadableStream<UIMessageChunk> | null>();
    const activeSnapshot: MiniLilacSessionSnapshot = {
      ...idleSnapshot("history-same-undo"),
      activeRunId: "run-successor",
      status: "streaming",
    };
    const transport = new FakeTransport({
      undo: (request) =>
        Promise.resolve({
          status: "undone",
          clientCommandId: request.clientCommandId,
          message: removed,
          historyStateId: "history-same-undo",
          filesystem: { status: "restored" },
        }),
      resume: () => {
        resumeObserved.resolve(undefined);
        return Promise.resolve({
          snapshot: activeSnapshot,
          messages: [
            { id: "user-successor", role: "user", parts: [{ type: "text", text: "successor" }] },
          ],
          todos: { revision: 0, todos: [] },
          replayCursor: { runId: "run-successor", afterSeq: 4 },
        });
      },
      cancel: () => {
        cancelObserved.resolve(undefined);
        return Promise.resolve({ status: "cancelled" });
      },
      reconnectPromise: reconnect.promise,
    });
    const controller = new Controller({
      transport,
      ui: {
        onState: (state) => {
          if (state.phase === "active") activeObserved.resolve(undefined);
        },
        onOutput: () => {},
      },
      sessionId: "session-1",
      initialMessages: [removed],
      onExit: () => {},
    });
    controller.start();
    controller.setEditor("local draft");
    controller.undo();
    await resumeObserved.promise;
    await activeObserved.promise;

    expect(controller.inputState.phase).toBe("active");
    expect(controller.inputState.editor).toBe("local draft");
    expect(controller.transcript.map((entry) => entry.text)).toEqual(["successor"]);
    controller.escape();
    await cancelObserved.promise;
    expect(transport.calls).toContain("cancel");
    controller.dispose();
  });

  it("treats a same-state active compaction as authoritative after redo", async () => {
    const removed: MiniLilacUserUIMessage = {
      id: "user-same-state-redo",
      role: "user",
      parts: [{ type: "text", text: "automatic undo draft" }],
    };
    const redoResumeObserved = deferred<void>();
    const compactingObserved = deferred<void>();
    const watch = deferred<void>();
    const compactingSnapshot: MiniLilacSessionSnapshot = {
      ...idleSnapshot("history-same-redo"),
      activeCompactionCommandId: "compact-successor",
      status: "compacting",
    };
    let resumeCount = 0;
    const transport = new FakeTransport({
      undo: (request) =>
        Promise.resolve({
          status: "undone",
          clientCommandId: request.clientCommandId,
          message: removed,
          historyStateId: "history-before-redo",
          filesystem: { status: "restored" },
        }),
      redo: (request) =>
        Promise.resolve({
          status: "redone",
          clientCommandId: request.clientCommandId,
          message: removed,
          historyStateId: "history-same-redo",
          filesystem: { status: "restored" },
        }),
      resume: () => {
        resumeCount += 1;
        if (resumeCount === 1) {
          return Promise.resolve({
            snapshot: idleSnapshot("history-before-redo"),
            messages: [],
            todos: { revision: 0, todos: [] },
            replayCursor: null,
          });
        }
        redoResumeObserved.resolve(undefined);
        return Promise.resolve({
          snapshot: compactingSnapshot,
          messages: [removed],
          todos: { revision: 0, todos: [] },
          replayCursor: null,
        });
      },
      getSession: () => Promise.resolve(compactingSnapshot),
    });
    const operations = operationTracker();
    const controller = new Controller({
      transport,
      ui: {
        ...operations.ui,
        onState: (state) => {
          operations.ui.onState(state);
          if (state.phase === "compacting") compactingObserved.resolve(undefined);
        },
      },
      sessionId: "session-1",
      initialMessages: [removed],
      compactionWatchDelay: () => watch.promise,
      onExit: () => {},
    });
    controller.start();
    const undoCompleted = operations.next();
    controller.undo();
    await undoCompleted;
    expect(controller.inputState.editor).toBe("automatic undo draft");

    controller.redo();
    await redoResumeObserved.promise;
    await compactingObserved.promise;
    expect(controller.inputState.phase).toBe("compacting");
    expect(controller.inputState.editor).toBe("automatic undo draft");
    controller.escape();
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.cancelCompactionRequests).toEqual([
      { sessionId: "session-1", clientCommandId: "compact-successor" },
    ]);
    controller.dispose();
  });

  it("reports filesystem skips as noncanonical warnings without failing history commands", async () => {
    const reasons = [
      ["git-unavailable", "Git is unavailable"],
      ["snapshot-unavailable", "no worktree snapshot is available"],
      ["platform-unsupported", "worktree restore is unsupported on this platform"],
    ] as const;
    for (const [reason, expected] of reasons) {
      const message: MiniLilacUserUIMessage = {
        id: `user-${reason}`,
        role: "user",
        parts: [{ type: "text", text: reason }],
      };
      const notices: Array<{ message: string; tone: string }> = [];
      const operations = operationTracker();
      const transport = new FakeTransport({
        redo: (request) =>
          Promise.resolve({
            status: "redone",
            clientCommandId: request.clientCommandId,
            message,
            historyStateId: `history-${reason}`,
            filesystem: { status: "skipped", reason },
          }),
        getMessages: () => Promise.resolve([message]),
      });
      const controller = new Controller({
        transport,
        ui: {
          ...operations.ui,
          onNotice: (notice, tone) => notices.push({ message: notice, tone }),
        },
        sessionId: `session-${reason}`,
        initialMessages: [
          { id: "assistant-1", role: "assistant", parts: [{ type: "text", text: "hello" }] },
        ],
        onExit: () => {},
      });
      controller.start();

      const completed = operations.next();
      controller.redo();
      await completed;
      expect(notices).toEqual([
        {
          message: `Transcript redone; managed worktree unchanged because ${expected}.`,
          tone: "warning",
        },
      ]);
      expect(controller.transcript.some((entry) => entry.text.includes("worktree unchanged"))).toBe(
        false,
      );
      expect(controller.transcript.some((entry) => entry.kind === "error")).toBe(false);
      controller.dispose();
    }
  });

  it("does not warn when filesystem history is disabled outside Git", async () => {
    const message: MiniLilacUserUIMessage = {
      id: "user-non-git",
      role: "user",
      parts: [{ type: "text", text: "non-git" }],
    };
    const notices: string[] = [];
    const operations = operationTracker();
    const transport = new FakeTransport({
      redo: (request) =>
        Promise.resolve({
          status: "redone",
          clientCommandId: request.clientCommandId,
          message,
          historyStateId: "history-non-git",
          filesystem: { status: "skipped", reason: "non-git-workspace" },
        }),
      getMessages: () => Promise.resolve([message]),
    });
    const controller = new Controller({
      transport,
      ui: { ...operations.ui, onNotice: (notice) => notices.push(notice) },
      sessionId: "session-non-git",
      initialMessages: [],
      onExit: () => {},
    });
    controller.start();

    const completed = operations.next();
    controller.redo();
    await completed;
    expect(notices).toEqual([]);
    controller.dispose();
  });

  it("reports an undo filesystem skip after restoring the draft and returning idle", async () => {
    const removed: MiniLilacUserUIMessage = {
      id: "user-skipped-undo",
      role: "user",
      parts: [{ type: "text", text: "restore after skipped filesystem" }],
    };
    const notices: string[] = [];
    const transport = new FakeTransport({
      undo: (request) =>
        Promise.resolve({
          status: "undone",
          clientCommandId: request.clientCommandId,
          message: removed,
          historyStateId: "history-skipped-undo",
          filesystem: { status: "skipped", reason: "git-unavailable" },
        }),
      getMessages: () => Promise.resolve([]),
    });
    const operations = operationTracker();
    const controller = new Controller({
      transport,
      ui: { ...operations.ui, onNotice: (notice) => notices.push(notice) },
      sessionId: "session-1",
      initialMessages: [removed],
      onExit: () => {},
    });
    controller.start();

    const completed = operations.next();
    controller.undo();
    await completed;
    expect(controller.inputState).toMatchObject({
      editor: "restore after skipped filesystem",
      phase: "idle",
    });
    expect(notices).toEqual([
      "Transcript undone; managed worktree unchanged because Git is unavailable.",
    ]);
    expect(controller.transcript).toEqual([]);
  });

  it("gates direct undo and redo controller actions while work is active", async () => {
    const transport = new FakeTransport();
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialMessages: [
        { id: "assistant-existing", role: "assistant", parts: [{ type: "text", text: "ready" }] },
      ],
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "active prompt");
    await Promise.resolve();
    expect(controller.inputState.phase).toBe("active");

    controller.undo();
    controller.redo();
    expect(transport.undoRequests).toEqual([]);
    expect(transport.redoRequests).toEqual([]);
    expect(controller.inputState.phase).toBe("active");
    controller.dispose();
  });

  it("does not call the server when redoing before session creation", async () => {
    const transport = new FakeTransport();
    const operations = operationTracker();
    const controller = new Controller({
      transport,
      ui: operations.ui,
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();

    const completed = operations.next();
    controller.redo();
    await completed;
    expect(transport.redoRequests).toEqual([]);
    expect(controller.inputState.phase).toBe("idle");
  });

  it("interrupts pending steer admissions atomically, then cancels on Esc", async () => {
    const transport = new FakeTransport();
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();

    submitText(controller, "hello"); // idle + dirty -> prompt, run becomes active
    await flush();

    submitText(controller, "one"); // active + dirty -> steer "one"
    submitText(controller, "two"); // active + dirty -> steer "two"
    controller.submit(); // active + empty + queued -> interrupt
    await flush();

    expect(transport.calls).toEqual(["interrupt"]);
    expect(transport.interruptRequests[0]?.pendingSteerCommandIds).toHaveLength(2);

    controller.escape(); // active Esc/Ctrl-C semantic event -> explicit cancel
    expect(controller.inputState.pendingSteeringCount).toBe(0);
    expect(controller.inputState.confirmedSteeringCount).toBe(0);
    await flush();

    expect(transport.calls).toEqual(["interrupt", "cancel"]);
  });

  it("orders cancel after deferred prompt and steer admission", async () => {
    const admission = deferred<void>();
    const transport = new FakeTransport({ admissionGate: admission.promise });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();

    submitText(controller, "hello");
    submitText(controller, "steer after admission");
    controller.escape();
    await flush();
    expect(transport.calls).toEqual([]);
    expect(transport.sentMessages.map(messageText)).toEqual(["hello"]);

    admission.resolve(undefined);
    await flush();
    expect(transport.calls).toEqual(["steer:steer after admission", "cancel"]);
  });

  it("cancels without waiting for a stalled steer response", async () => {
    const cancelReached = deferred<void>();
    const transport = new FakeTransport({
      steer: () => new Promise<MiniLilacSteerResult>(() => {}),
      cancel: async () => {
        cancelReached.resolve(undefined);
        return { status: "cancelled" };
      },
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();

    submitText(controller, "stalled steer");
    await flush();
    controller.escape();
    await Promise.race([
      cancelReached.promise,
      Bun.sleep(1_000).then(() => {
        throw new Error("cancel did not reach the transport");
      }),
    ]);

    expect(transport.calls).toEqual(["steer:stalled steer", "cancel"]);
    expect(transport.steerAbortSignals[0]?.aborted).toBe(true);
    expect(transport.cancelAbortSignals[0]?.aborted).toBe(false);
    expect(transport.sendAbortSignal?.aborted).toBe(false);
    expect(transport.streamCancelCount).toBe(0);
    controller.dispose();
  });

  it("interrupts without waiting for a stalled steer response", async () => {
    const interruptReached = deferred<void>();
    const transport = new FakeTransport({
      steer: () => new Promise<MiniLilacSteerResult>(() => {}),
      interrupt: async () => {
        interruptReached.resolve(undefined);
        return { status: "interrupted", steeringIds: [] };
      },
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();

    submitText(controller, "stalled steer");
    await flush();
    controller.submit();
    await Promise.race([
      interruptReached.promise,
      Bun.sleep(1_000).then(() => {
        throw new Error("interrupt did not reach the transport");
      }),
    ]);

    expect(transport.calls).toEqual(["steer:stalled steer", "interrupt"]);
    expect(transport.interruptAbortSignals[0]?.aborted).toBe(false);
    expect(transport.sendAbortSignal?.aborted).toBe(false);
    await flush();
    expect(controller.transcript.map((entry) => entry.text)).toEqual(["hello"]);
    expect(controller.steeringQueue).toEqual([]);
    expect(controller.inputState.queuedSteeringCount).toBe(0);
    controller.dispose();
  });

  it("retries an interrupt barrier after the first interrupt request fails", async () => {
    let interruptAttempts = 0;
    const transport = new FakeTransport({
      steer: () => new Promise<MiniLilacSteerResult>(() => {}),
      interrupt: () => {
        interruptAttempts += 1;
        return interruptAttempts === 1
          ? Promise.reject(new Error("interrupt unavailable"))
          : Promise.resolve({ status: "interrupted", steeringIds: [] });
      },
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();

    submitText(controller, "stalled steer");
    await flush();
    controller.submit();
    await flush();
    expect(controller.steeringQueue.map(messageText)).toEqual(["stalled steer"]);
    expect(controller.inputState.queuedSteeringCount).toBe(1);

    controller.submit();
    await flush();
    expect(transport.interruptRequests).toHaveLength(2);
    expect(transport.interruptRequests[1]?.pendingSteerCommandIds).toEqual(
      transport.interruptRequests[0]?.pendingSteerCommandIds,
    );
    expect(controller.steeringQueue).toEqual([]);
    expect(controller.inputState.queuedSteeringCount).toBe(0);
    controller.dispose();
  });

  it("keeps newer steer barriers when an older interrupt reset arrives", async () => {
    const transport = new FakeTransport({
      steer: () => new Promise<MiniLilacSteerResult>(() => {}),
      interrupt: async () => ({ status: "empty" }),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();

    submitText(controller, "older steer");
    await flush();
    controller.submit();
    await flush();
    expect(transport.interruptRequests[0]?.pendingSteerCommandIds).toHaveLength(1);

    submitText(controller, "newer steer");
    await flush();
    transport.enqueue({ type: "data-transcriptReset", data: { reason: "interrupt" } });
    await flush();
    controller.submit();
    await flush();

    expect(transport.interruptRequests[1]?.pendingSteerCommandIds).toHaveLength(1);
    controller.dispose();
  });

  it("does not cancel and removes local user output when prompt admission fails", async () => {
    const admission = deferred<void>();
    const transport = new FakeTransport({
      admissionGate: admission.promise,
      admissionError: new Error("rejected"),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "not admitted");
    controller.escape();

    admission.resolve(undefined);
    await flush();
    expect(transport.calls).not.toContain("cancel");
    expect(controller.transcript.map((entry) => entry.kind)).toEqual(["error"]);
    expect(controller.inputState.phase).toBe("idle");
  });

  it("preserves a newer draft when prompt admission fails", async () => {
    const admission = deferred<void>();
    const transport = new FakeTransport({
      admissionGate: admission.promise,
      admissionError: new Error("rejected"),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "original prompt");
    controller.setEditor("new draft");
    admission.resolve(undefined);
    await flush();

    expect(controller.inputState.editor).toBe("original prompt\nnew draft");
    expect(controller.inputState.phase).toBe("idle");
  });

  it("removes a queued steering block when steering fails", async () => {
    const transport = new FakeTransport({ steerError: new Error("steer rejected") });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();

    submitText(controller, "failed steer");
    expect(controller.transcript.map((entry) => entry.text)).toEqual(["hello"]);
    expect(controller.steeringQueue.map(messageText)).toEqual(["failed steer"]);
    await flush();
    expect(controller.transcript.map((entry) => entry.text)).toEqual(["hello", "steer rejected"]);
    expect(controller.steeringQueue).toEqual([]);
    expect(controller.inputState.queuedSteeringCount).toBe(0);
    expect(controller.inputState.editor).toBe("failed steer");
    controller.dispose();
  });

  it("retries an ambiguous steer with the same command id", async () => {
    const attempts: MiniLilacSteerRequest[] = [];
    const transport = new FakeTransport({
      steer: async (request) => {
        attempts.push(request);
        if (attempts.length === 1) throw new Error("response lost");
        return { status: "queued", steeringId: "steer-recovered" };
      },
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();
    submitText(controller, "recover steer");
    await flush();

    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.clientCommandId).toBeTruthy();
    expect(attempts[1]?.clientCommandId).toBe(attempts[0]?.clientCommandId);
    expect(controller.inputState.editor).toBe("");
  });

  it("keeps confirmed steering when a later submission fails, then clears it on consumption", async () => {
    const secondSteer = deferred<MiniLilacSteerResult>();
    const transport = new FakeTransport({
      steer: (request) =>
        messageText(request.message) === "second"
          ? secondSteer.promise
          : Promise.resolve({ status: "queued", steeringId: "steer-first" }),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();

    submitText(controller, "first");
    submitText(controller, "second");
    await flush();
    transport.enqueue({
      type: "data-control",
      data: { status: "queued", steeringId: "steer-first" },
    });
    transport.enqueue({
      type: "data-session",
      data: {
        id: "session-1",
        activeRunId: "run-1",
        status: "streaming",
        cwd: process.cwd(),
        model: "provider/model",
        profile: "general",
        reasoning: null,
        historyStateId: "history-streaming",
        canUndo: true,
        canRedo: false,
        queuedSteeringCount: 1,
      },
    });
    await flush();
    expect(controller.inputState.pendingSteeringCount).toBe(1);
    expect(controller.inputState.confirmedSteeringCount).toBe(1);
    expect(controller.inputState.queuedSteeringCount).toBe(2);

    secondSteer.reject(new Error("second rejected"));
    await flush();
    expect(controller.inputState.pendingSteeringCount).toBe(0);
    expect(controller.inputState.confirmedSteeringCount).toBe(1);
    expect(controller.inputState.queuedSteeringCount).toBe(1);
    expect(controller.inputState.editor).toBe("second");

    controller.ctrlC();
    controller.submit();
    await flush();
    expect(transport.calls).toContain("interrupt");

    transport.enqueue({
      type: "data-session",
      data: {
        id: "session-1",
        activeRunId: "run-1",
        status: "streaming",
        cwd: process.cwd(),
        model: "provider/model",
        profile: "general",
        reasoning: null,
        historyStateId: "history-streaming",
        canUndo: true,
        canRedo: false,
        queuedSteeringCount: 0,
      },
    });
    await flush();
    expect(controller.inputState.queuedSteeringCount).toBe(0);
    controller.dispose();
  });

  it("aborts and discards a stream that arrives after disposal during admission", async () => {
    const admission = deferred<void>();
    const transport = new FakeTransport({ admissionGate: admission.promise });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    controller.dispose();
    expect(transport.sendAbortSignal?.aborted).toBe(true);

    admission.resolve(undefined);
    await flush();
    expect(transport.streamCancelCount).toBe(1);
    expect(transport.getMessagesCount).toBe(0);
  });

  it("classifies reader cancellation during disposal as disposed", async () => {
    const transport = new FakeTransport();
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();

    controller.dispose();
    await flush();
    expect(transport.streamCancelCount).toBe(1);
    expect(transport.getMessagesCount).toBe(0);
  });

  it("discards a resumed stream that arrives after disposal", async () => {
    const reconnect = deferred<ReadableStream<UIMessageChunk> | null>();
    let cancelled = false;
    const transport = new FakeTransport({ reconnectPromise: reconnect.promise });
    const snapshot: MiniLilacSessionSnapshot = {
      ...SESSION_PRESENTATION,
      id: "session-1",
      activeRunId: "run-1",
      status: "streaming",
      cwd: process.cwd(),
      model: "provider/model",
      profile: "general",
      reasoning: null,
      queuedSteeringCount: 0,
    };
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialSnapshot: snapshot,
      onExit: () => {},
    });
    controller.start();
    controller.dispose();
    reconnect.resolve(
      new ReadableStream<UIMessageChunk>({
        cancel: () => {
          cancelled = true;
        },
      }),
    );
    await flush();
    expect(cancelled).toBe(true);
    expect(transport.getMessagesCount).toBe(0);
  });

  it("truncates the current-run tail immediately on transcript reset", async () => {
    const transport = new FakeTransport({ messagesError: new Error("offline") });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();
    submitText(controller, "discard queued steer");
    expect(controller.transcript.map((entry) => entry.text)).toEqual(["hello"]);
    expect(controller.steeringQueue.map(messageText)).toEqual(["discard queued steer"]);

    transport.enqueue({ type: "text-start", id: "text-1" });
    transport.enqueue({ type: "text-delta", id: "text-1", delta: "discard me" });
    transport.enqueue({
      type: "tool-input-start",
      toolCallId: "tool-1",
      toolName: "bash",
      dynamic: true,
    });
    transport.enqueue({ type: "data-transcriptReset", data: { reason: "cancel" } });
    await flush();

    expect(controller.transcript.map((entry) => entry.text)).toEqual([
      "hello",
      "transcript rewound (cancel); canonical transcript will be reconciled",
    ]);
    expect(controller.steeringQueue).toEqual([]);
    transport.closeStream();
    await flush();
    expect(controller.transcript.map((entry) => entry.text)).toEqual([
      "hello",
      "transcript rewound (cancel); canonical transcript will be reconciled",
    ]);
    expect(controller.inputState.phase).toBe("idle");
  });

  it("rolls back only the interrupted block and keeps completed run output", async () => {
    const transport = new FakeTransport();
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();
    submitText(controller, "discard queued steer");

    transport.enqueue({ type: "text-start", id: "completed" });
    transport.enqueue({ type: "text-delta", id: "completed", delta: "keep me" });
    transport.enqueue({ type: "text-end", id: "completed" });
    transport.enqueue({ type: "reasoning-start", id: "discarded" });
    transport.enqueue({ type: "reasoning-delta", id: "discarded", delta: "remove me" });
    transport.enqueue({
      type: "data-outputRollback",
      data: {
        reason: "cancel",
        reasoningIds: ["discarded"],
        textIds: [],
        toolCallIds: [],
      },
    });
    await flush();

    expect(controller.transcript.map((entry) => entry.text)).toEqual(["hello", "keep me"]);
    expect(controller.steeringQueue).toEqual([]);

    transport.canonicalMessages = [
      { id: "user", role: "user", parts: [{ type: "text", text: "hello" }] },
      {
        id: "assistant",
        role: "assistant",
        parts: [{ type: "text", text: "keep me", state: "done" }],
      },
    ];
    transport.closeStream();
    await flush();
    expect(controller.transcript.map((entry) => entry.text)).toEqual(["hello", "keep me"]);
    expect(controller.inputState.phase).toBe("idle");
  });

  it("keeps admitted steering queued across an interrupt reset until it commits", async () => {
    const transport = new FakeTransport();
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();
    submitText(controller, "replacement direction");
    await flush();
    transport.enqueue({ type: "text-start", id: "discarded" });
    transport.enqueue({ type: "text-delta", id: "discarded", delta: "discard me" });
    transport.enqueue({ type: "data-transcriptReset", data: { reason: "interrupt" } });
    await flush();

    expect(controller.transcript.map((entry) => entry.text)).toEqual([
      "hello",
      "transcript rewound (interrupt); canonical transcript will be reconciled",
    ]);
    expect(controller.steeringQueue.map(messageText)).toEqual(["replacement direction"]);

    const [steering] = controller.steeringQueue;
    if (steering === undefined) throw new Error("expected queued steering");
    transport.enqueue({ type: "data-steeringCommitted", id: steering.id, data: steering });
    await flush();
    expect(controller.steeringQueue).toEqual([]);
    expect(controller.transcript.map((entry) => entry.text)).toEqual([
      "hello",
      "transcript rewound (interrupt); canonical transcript will be reconciled",
      "replacement direction",
    ]);
  });

  it("moves committed steering after preceding live activity and reconciles it", async () => {
    const transport = new FakeTransport();
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();
    submitText(controller, "change direction");
    expect(controller.transcript.map((entry) => entry.text)).toEqual(["hello"]);
    expect(controller.steeringQueue.map(messageText)).toEqual(["change direction"]);
    await flush();

    transport.enqueue({ type: "text-start", id: "working" });
    transport.enqueue({ type: "text-delta", id: "working", delta: "working" });
    transport.enqueue({ type: "text-end", id: "working" });
    const [steering] = controller.steeringQueue;
    if (steering === undefined) throw new Error("expected queued steering");
    transport.enqueue({ type: "data-steeringCommitted", id: steering.id, data: steering });
    await flush();
    expect(controller.steeringQueue).toEqual([]);
    expect(controller.transcript.map((entry) => entry.text)).toEqual([
      "hello",
      "working",
      "change direction",
    ]);

    transport.canonicalMessages = [
      { id: "user-prompt", role: "user", parts: [{ type: "text", text: "hello" }] },
      {
        id: "assistant-before-steer",
        role: "assistant",
        parts: [{ type: "text", text: "working", state: "done" }],
      },
      {
        id: "user-steer",
        role: "user",
        parts: [{ type: "text", text: "change direction" }],
      },
    ];
    transport.closeStream();
    await flush();

    expect(controller.transcript.map((entry) => entry.text)).toEqual([
      "hello",
      "working",
      "change direction",
    ]);
    expect(controller.transcript[2]?.id).toBe("message:user-steer:0");
    expect(transport.getMessagesCount).toBe(1);
  });

  it("replaces a divergent streamed transcript with canonical messages on completion", async () => {
    const transport = new FakeTransport();
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();
    transport.enqueue({ type: "text-start", id: "text-1" });
    transport.enqueue({ type: "text-delta", id: "text-1", delta: "streamed draft" });
    transport.enqueue({ type: "text-end", id: "text-1" });
    transport.canonicalMessages = [
      { id: "user-canonical", role: "user", parts: [{ type: "text", text: "hello" }] },
      {
        id: "assistant-canonical",
        role: "assistant",
        parts: [{ type: "text", text: "canonical answer", state: "done" }],
      },
    ];
    transport.closeStream();
    await flush();

    expect(controller.transcript.map((entry) => entry.text)).toEqual(["hello", "canonical answer"]);
    expect(controller.transcript.map((entry) => entry.text)).not.toContain("streamed draft");
    expect(transport.reconnectCount).toBe(0);
  });

  it("keeps the run active until its deferred canonical reconciliation settles", async () => {
    const canonical = deferred<MiniLilacUIMessage[]>();
    const transport = new FakeTransport({ getMessages: () => canonical.promise });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "first prompt");
    await flush();

    transport.closeStream();
    await flush();
    expect(transport.getMessagesCount).toBe(1);
    expect(controller.inputState.phase).toBe("active");

    submitText(controller, "must not become a second prompt");
    await flush();
    expect(transport.sendMessagesCount).toBe(1);

    canonical.resolve([
      { id: "canonical", role: "user", parts: [{ type: "text", text: "first prompt" }] },
    ]);
    await flush();
    expect(controller.inputState.phase).toBe("idle");
    expect(controller.transcript.map((entry) => entry.text)).toEqual(["first prompt"]);
  });

  it("never lets an older deferred reconciliation overwrite a newer generation", async () => {
    const older = deferred<MiniLilacUIMessage[]>();
    const newer = deferred<MiniLilacUIMessage[]>();
    let reconciliation = 0;
    const transport = new FakeTransport({
      getMessages: () => {
        reconciliation += 1;
        return reconciliation === 1 ? older.promise : newer.promise;
      },
    });
    const snapshot: MiniLilacSessionSnapshot = {
      ...SESSION_PRESENTATION,
      id: "session-1",
      activeRunId: "run-1",
      status: "streaming",
      cwd: process.cwd(),
      model: "provider/model",
      profile: "general",
      reasoning: null,
      queuedSteeringCount: 0,
    };
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialSnapshot: snapshot,
      onExit: () => {},
    });

    controller.start();
    await flush();
    expect(transport.getMessagesCount).toBe(1);

    // A second lifecycle generation supersedes the still-pending first one.
    controller.start();
    await flush();
    expect(transport.getMessagesCount).toBe(2);

    newer.resolve([
      { id: "newer", role: "assistant", parts: [{ type: "text", text: "newer output" }] },
    ]);
    await flush();
    expect(controller.inputState.phase).toBe("idle");
    expect(controller.transcript.map((entry) => entry.text)).toEqual(["newer output"]);

    older.resolve([
      { id: "older", role: "assistant", parts: [{ type: "text", text: "stale output" }] },
    ]);
    await flush();
    expect(controller.inputState.phase).toBe("idle");
    expect(controller.transcript.map((entry) => entry.text)).toEqual(["newer output"]);
  });

  it("does not cancel on a transport disconnect and reconnects exactly once", async () => {
    let reconnectStreamCreated = false;
    const transport = new FakeTransport({
      failFirstRead: true,
      reconnectStream: () => {
        reconnectStreamCreated = true;
        return new ReadableStream<UIMessageChunk>({
          start: (controller) => {
            controller.enqueue({
              type: "data-streamCursor",
              data: { runId: "run-1", seq: 1 },
              transient: true,
            });
            controller.enqueue({ type: "finish", finishReason: "stop" });
            controller.close();
          },
        });
      },
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();

    submitText(controller, "hello");
    await flush();

    expect(reconnectStreamCreated).toBe(true);
    expect(transport.reconnectCount).toBe(1);
    expect(transport.calls).not.toContain("cancel");
    expect(controller.inputState.phase).toBe("idle");
  });

  it("reconnects exactly once after clean partial EOF and completes only on terminal finish", async () => {
    const transport = new FakeTransport({
      reconnectStream: () =>
        new ReadableStream<UIMessageChunk>({
          start: (streamController) => {
            streamController.enqueue({
              type: "data-streamCursor",
              data: { runId: "run-1", seq: 2 },
              transient: true,
            });
            streamController.enqueue({ type: "text-delta", id: "text-1", delta: " world" });
            streamController.enqueue({ type: "finish", finishReason: "stop" });
            streamController.close();
          },
        }),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();

    transport.enqueue({ type: "text-start", id: "text-1" });
    transport.enqueue({ type: "text-delta", id: "text-1", delta: "partial" });
    transport.closeStreamWithoutFinish();
    await flush();

    expect(transport.reconnectCount).toBe(1);
    expect(transport.getMessagesCount).toBe(1);
    expect(controller.inputState.phase).toBe("idle");
  });

  it("keeps reconnecting when a replacement stream also ends before terminal finish", async () => {
    let reconnectAttempt = 0;
    const transport = new FakeTransport({
      reconnectStream: () => {
        reconnectAttempt += 1;
        return new ReadableStream<UIMessageChunk>({
          start: (streamController) => {
            streamController.enqueue({
              type: "data-streamCursor",
              data: { runId: "run-1", seq: reconnectAttempt + 1 },
              transient: true,
            });
            if (reconnectAttempt === 2) {
              streamController.enqueue({ type: "finish", finishReason: "stop" });
            }
            streamController.close();
          },
        });
      },
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      reconnectDelay: async () => {},
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();

    transport.closeStreamWithoutFinish();
    await flush();

    expect(transport.reconnectCount).toBe(2);
    expect(transport.getMessagesCount).toBe(1);
    expect(controller.inputState.phase).toBe("idle");
  });

  it("accepts reconnect null as server-confirmed terminal after clean EOF", async () => {
    const transport = new FakeTransport();
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();

    transport.closeStreamWithoutFinish();
    await flush();

    expect(transport.reconnectCount).toBe(1);
    expect(transport.getMessagesCount).toBe(1);
    expect(controller.inputState.phase).toBe("idle");
  });

  it("retries a transient reconnect request failure instead of exhausting", async () => {
    let reconnectAttempt = 0;
    const transport = new FakeTransport({
      failFirstRead: true,
      reconnectStream: () => {
        reconnectAttempt += 1;
        if (reconnectAttempt === 1) {
          throw new Error("The socket connection was closed unexpectedly");
        }
        return new ReadableStream<UIMessageChunk>({
          start: (controller) => {
            controller.enqueue({
              type: "data-streamCursor",
              data: { runId: "run-1", seq: 1 },
              transient: true,
            });
            controller.enqueue({ type: "finish", finishReason: "stop" });
            controller.close();
          },
        });
      },
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      reconnectDelay: async () => {},
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();

    expect(transport.reconnectCount).toBe(2);
    expect(controller.inputState.phase).toBe("idle");
    expect(transport.calls).not.toContain("cancel");
  });

  it("waits for terminal stream after cancelling while reconnecting", async () => {
    const cancelResponse = deferred<MiniLilacCancelResult>();
    let terminalReconnect: ReadableStreamDefaultController<UIMessageChunk> | undefined;
    const transport = new FakeTransport({
      cancel: () => cancelResponse.promise,
      reconnectStream: () =>
        new ReadableStream<UIMessageChunk>({
          start: (streamController) => {
            terminalReconnect = streamController;
          },
        }),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "first prompt");
    await flush();

    transport.closeStreamWithoutFinish();
    await flush();
    expect(controller.inputState.phase).toBe("active");
    expect(transport.reconnectCount).toBe(1);

    controller.escape();
    await flush();
    expect(transport.calls.at(-1)).toBe("cancel");

    cancelResponse.resolve({ status: "cancelled" });
    await flush();
    expect(transport.getMessagesCount).toBe(0);
    expect(controller.inputState.phase).toBe("active");

    submitText(controller, "must not become a second prompt");
    await flush();
    expect(transport.sendMessagesCount).toBe(1);
    expect(controller.inputState.phase).toBe("active");

    terminalReconnect?.enqueue({ type: "finish", finishReason: "stop" });
    terminalReconnect?.close();
    await flush();
    expect(transport.getMessagesCount).toBe(1);
    expect(controller.inputState.phase).toBe("idle");
  });

  it("returns idle when prompt admission fails", async () => {
    const transport = new FakeTransport({ admissionError: new Error("rejected") });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "hello");
    await flush();
    expect(controller.inputState.phase).toBe("idle");
  });

  it("hydrates resumed messages and reconnects an active snapshot immediately", async () => {
    const initialMessages: MiniLilacUIMessage[] = [
      { id: "existing", role: "user", parts: [{ type: "text", text: "before resume" }] },
    ];
    const snapshot: MiniLilacSessionSnapshot = {
      ...SESSION_PRESENTATION,
      id: "session-1",
      activeRunId: "run-1",
      status: "streaming",
      cwd: process.cwd(),
      model: "provider/model",
      profile: "general",
      reasoning: null,
      queuedSteeringCount: 0,
    };
    const transport = new FakeTransport();
    transport.canonicalMessages = initialMessages;
    const states: InputState[] = [];
    const outputs: (readonly TranscriptEntry[])[] = [];
    const controller = new Controller({
      transport,
      ui: {
        onState: (state) => states.push(state),
        onOutput: (entries) => outputs.push(entries),
      },
      sessionId: "session-1",
      initialSnapshot: snapshot,
      initialMessages,
      onExit: () => {},
    });

    controller.start();
    expect(outputs[0]).toEqual([
      {
        id: "message:existing:0",
        kind: "user",
        tone: "accent",
        text: "before resume",
      },
    ]);
    expect(states[0]?.phase).toBe("active");
    await flush();
    expect(transport.calls[0]).toBe("reconnect");
    expect(controller.inputState.phase).toBe("idle");

    submitText(controller, "continued");
    await flush();
    expect(transport.sentMessages.map((message) => message.id)).toEqual([
      "existing",
      expect.any(String),
    ]);
  });

  it("follows compaction that starts after a resumed prompt run completes", async () => {
    const initial: MiniLilacSessionSnapshot = {
      ...SESSION_PRESENTATION,
      id: "session-1",
      activeRunId: "run-1",
      status: "streaming",
      cwd: process.cwd(),
      model: "provider/model",
      profile: "general",
      reasoning: null,
      queuedSteeringCount: 0,
    };
    const compacting: MiniLilacSessionSnapshot = {
      ...initial,
      activeRunId: null,
      activeCompactionCommandId: "compact-after-run",
      status: "compacting",
    };
    const idlePoll = deferred<MiniLilacSessionSnapshot>();
    let sessionRead = 0;
    const transport = new FakeTransport({
      getSession: () => {
        sessionRead += 1;
        return sessionRead === 1 ? Promise.resolve(compacting) : idlePoll.promise;
      },
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialSnapshot: initial,
      compactionWatchDelay: () => Promise.resolve(),
      onExit: () => {},
    });

    controller.start();
    await flush();
    expect(controller.inputState.phase).toBe("compacting");

    controller.escape();
    await flush();
    expect(transport.cancelCompactionRequests).toEqual([
      { sessionId: "session-1", clientCommandId: "compact-after-run" },
    ]);

    idlePoll.resolve({ ...compacting, activeCompactionCommandId: null, status: "idle" });
    await flush();
    expect(controller.inputState.phase).toBe("idle");
  });

  it("replays only uncommitted steering into the queue", async () => {
    const committed: MiniLilacUserUIMessage = {
      id: "committed",
      role: "user",
      parts: [{ type: "text", text: "already committed" }],
    };
    const initialMessages: MiniLilacUIMessage[] = [
      { id: "root", role: "user", parts: [{ type: "text", text: "root prompt" }] },
      committed,
    ];
    const steering: MiniLilacUserUIMessage = {
      id: "steer-replayed",
      role: "user",
      parts: [{ type: "text", text: "replayed steering" }],
    };
    const transport = new FakeTransport({
      reconnectStream: () =>
        new ReadableStream<UIMessageChunk>({
          start(stream) {
            stream.enqueue({
              type: "data-steeringCommitted",
              id: "committed",
              data: committed,
            });
            stream.enqueue({ type: "data-steering", id: steering.id, data: steering });
          },
        }),
    });
    const controller = new Controller({
      transport,
      ui: silentUI(),
      sessionId: "session-1",
      initialSnapshot: {
        ...SESSION_PRESENTATION,
        id: "session-1",
        activeRunId: "run-1",
        status: "streaming",
        cwd: process.cwd(),
        model: "provider/model",
        profile: "general",
        reasoning: null,
        queuedSteeringCount: 1,
      },
      initialMessages,
      onExit: () => {},
    });

    controller.start();
    await flush();
    expect(controller.transcript.map((entry) => entry.text)).toEqual([
      "root prompt",
      "already committed",
    ]);
    expect(controller.steeringQueue).toEqual([steering]);
    controller.dispose();
  });

  it("publishes hydrated todos initially and admits only newer live revisions", async () => {
    const initialTodos: MiniLilacTodoState = {
      revision: 2,
      todos: [{ content: "Existing", status: "pending", priority: "medium" }],
    };
    const newerTodos: MiniLilacTodoState = {
      revision: 3,
      todos: [{ content: "Live", status: "in_progress", priority: "high" }],
    };
    const seen: MiniLilacTodoState[] = [];
    const transport = new FakeTransport();
    const controller = new Controller({
      transport,
      ui: {
        onState: () => {},
        onOutput: () => {},
        onTodos: (todos) => seen.push(todos),
      },
      sessionId: "session-1",
      initialTodos,
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "start stream");
    await flush();

    transport.enqueue({
      type: "data-todos",
      data: { revision: 1, todos: [] },
      transient: true,
    });
    transport.enqueue({ type: "data-todos", data: initialTodos, transient: true });
    transport.enqueue({ type: "data-todos", data: newerTodos, transient: true });
    transport.enqueue({
      type: "data-todos",
      data: { revision: 2, todos: [] },
      transient: true,
    });
    await flush();

    expect(seen).toEqual([initialTodos, newerTodos]);
    expect(controller.transcript.map((entry) => entry.text)).toEqual(["start stream"]);
    controller.dispose();
  });

  it("retains the latest todos across transcript reset replay overlap", async () => {
    const seen: MiniLilacTodoState[] = [];
    const transport = new FakeTransport({ messagesError: new Error("offline") });
    const controller = new Controller({
      transport,
      ui: {
        onState: () => {},
        onOutput: () => {},
        onTodos: (todos) => seen.push(todos),
      },
      sessionId: "session-1",
      initialTodos: { revision: 0, todos: [] },
      onExit: () => {},
    });
    controller.start();
    submitText(controller, "start stream");
    await flush();

    const latest: MiniLilacTodoState = {
      revision: 4,
      todos: [{ content: "Keep me", status: "in_progress", priority: "high" }],
    };
    transport.enqueue({ type: "data-todos", data: latest, transient: true });
    transport.enqueue({ type: "data-transcriptReset", data: { reason: "cancel" } });
    transport.enqueue({
      type: "data-todos",
      data: { revision: 3, todos: [] },
      transient: true,
    });
    transport.enqueue({ type: "data-todos", data: latest, transient: true });
    await flush();

    expect(seen).toEqual([{ revision: 0, todos: [] }, latest]);
    controller.dispose();
  });
});

describe("Controller stream normalization", () => {
  it("keeps state unchanged and continues rendering after an unsupported transport chunk", async () => {
    const encoder = new TextEncoder();
    const connected = deferred<void>();
    const firstText = deferred<void>();
    const continuedText = deferred<void>();
    let source: ReadableStreamDefaultController<Uint8Array> | undefined;
    const fetch = Object.assign(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              source = controller;
              connected.resolve();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      { preconnect() {} },
    );
    const transport = new MiniLilacTransport({ baseUrl: "/mini", fetch });
    const controller = new Controller({
      transport,
      ui: {
        onState: () => {},
        onOutput: (entries) => {
          const text = entries.map((entry) => entry.text).join("\n");
          if (text === "before") firstText.resolve();
          if (text === "before after") continuedText.resolve();
        },
      },
      sessionId: "session-1",
      initialSnapshot: {
        ...idleSnapshot("history-1"),
        activeRunId: "run-1",
        status: "streaming",
      },
      onExit: () => {},
    });

    controller.start();
    await connected.promise;
    if (source === undefined) throw new Error("expected stream source");
    source.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({ type: "text-delta", id: "answer", delta: "before" })}\n\n`,
      ),
    );
    await firstText.promise;
    const stateBeforeUnsupported = controller.inputState;

    source.enqueue(
      encoder.encode(
        [
          `data: ${JSON.stringify({ type: "future-observation", payload: { opaque: true } })}`,
          `data: ${JSON.stringify({ type: "text-delta", id: "answer", delta: " after" })}`,
          "",
        ].join("\n\n"),
      ),
    );
    await continuedText.promise;

    expect(controller.inputState).toBe(stateBeforeUnsupported);
    expect(controller.inputState.phase).toBe("active");
    expect(controller.transcript.map((entry) => entry.text)).toEqual(["before after"]);
    controller.dispose();
  });
});
