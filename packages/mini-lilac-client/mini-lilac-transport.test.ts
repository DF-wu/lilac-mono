import { describe, expect, it } from "bun:test";
import type { UIMessageChunk } from "ai";
import { Panic } from "better-result";

import {
  MiniLilacBoundaryInvalid,
  MiniLilacCompactionAndCleanupFailed,
  MiniLilacCompactionCancelledError,
  MiniLilacExternalOperationFailed,
  MiniLilacHttpError,
  MiniLilacRequestCancelled,
  MiniLilacStreamCleanupFailed,
  MiniLilacStreamDecodeFailed,
  MiniLilacTransport,
} from "./mini-lilac-transport";
import {
  MINI_LILAC_UNSUPPORTED_UI_MESSAGE_CHUNK_TYPE,
  type MiniLilacStreamCursorChunk,
} from "./protocol";

type FetchCall = {
  input: RequestInfo | URL;
  init: RequestInit | undefined;
};

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
  });
}

function eventStreamResponse(chunks: readonly unknown[]): Response {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("");
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

function openEventStreamResponse(
  chunks: readonly unknown[],
  onCancel: () => void | Promise<void>,
): { readonly response: Response; readonly body: ReadableStream<Uint8Array> } {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")),
      );
    },
    cancel: onCancel,
  });
  return {
    response: new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
    body,
  };
}

function cursor(seq: number, runId = "run-1"): MiniLilacStreamCursorChunk {
  return {
    type: "data-streamCursor",
    data: { runId, seq },
    transient: true,
  };
}

function sseResponse(chunks: readonly unknown[]): Response {
  return new Response(
    [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`), "data: [DONE]", ""].join("\n\n"),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

function erroringSseResponse(prefix: readonly unknown[]): {
  response: Response;
  fail: (error: Error) => void;
} {
  const encoder = new TextEncoder();
  let failStream: ((error: Error) => void) | undefined;
  const failure = new Promise<never>((_, reject) => {
    failStream = reject;
  });
  let sentPrefix = false;

  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentPrefix) {
        sentPrefix = true;
        controller.enqueue(
          encoder.encode(
            prefix.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n") + "\n\n",
          ),
        );
        return;
      }

      try {
        await failure;
      } catch (error) {
        controller.error(error);
      }
    },
  });

  return {
    response: new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
    fail(error) {
      failStream?.(error);
    },
  };
}

function mockFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(handler, { preconnect() {} });
}

async function readChunks(stream: ReadableStream<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  const reader = stream.getReader();
  while (true) {
    const result = await reader.read();
    if (result.done) return chunks;
    chunks.push(result.value);
  }
}

describe("MiniLilacTransport", () => {
  it("loads an atomic resume projection and primes its exact replay cursor", async () => {
    const calls: FetchCall[] = [];
    const resume = {
      snapshot: {
        id: "session-1",
        activeRunId: "run-1",
        status: "streaming" as const,
        cwd: "/workspace",
        model: "test/model",
        profile: "coding",
        reasoning: "high" as const,
        historyStateId: "history-1",
        canUndo: true,
        canRedo: false,
        queuedSteeringCount: 0,
      },
      messages: [],
      todos: { revision: 0, todos: [] },
      replayCursor: { runId: "run-1", afterSeq: 7 },
    };
    const transport = new MiniLilacTransport({
      baseUrl: "/mini",
      fetch: mockFetch(async (input, init) => {
        calls.push({ input, init });
        return jsonResponse(resume);
      }),
    });

    expect(await transport.getSessionResume("session-1")).toEqual(resume);
    transport.setReconnectCursor("session-1", resume.replayCursor);
    expect(transport.getLastStreamCursor("session-1")).toEqual({ runId: "run-1", seq: 7 });
    expect(String(calls[0]?.input)).toBe("/mini/sessions/session-1/resume");
  });

  it("gets strict todo state from an encoded session URL with auth and abort signal", async () => {
    const calls: FetchCall[] = [];
    const controller = new AbortController();
    const state = {
      revision: 4,
      todos: [{ content: "Ship it", status: "in_progress" as const, priority: "high" as const }],
    };
    const transport = new MiniLilacTransport({
      baseUrl: "/mini",
      bearerToken: async () => "secret",
      fetch: mockFetch(async (input, init) => {
        calls.push({ input, init });
        return jsonResponse(state);
      }),
    });

    expect(await transport.getTodos("session / one", { signal: controller.signal })).toEqual(state);
    expect(String(calls[0]?.input)).toBe("/mini/sessions/session%20%2F%20one/todos");
    expect(calls[0]?.init?.method).toBeUndefined();
    expect(calls[0]?.init?.signal).toBe(controller.signal);
    expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe("Bearer secret");
    expect(new Headers(calls[0]?.init?.headers).get("Content-Type")).toBeNull();
  });

  it("rejects malformed todo state responses", async () => {
    const malformedStates: unknown[] = [
      { revision: -1, todos: [] },
      {
        revision: 1,
        todos: [
          { content: "First", status: "in_progress", priority: "high" },
          { content: "Second", status: "in_progress", priority: "low" },
        ],
      },
      { revision: 1, todos: [], unexpected: true },
    ];
    const transport = new MiniLilacTransport({
      fetch: mockFetch(async () => jsonResponse(malformedStates.shift())),
    });

    for (let index = 0; index < 3; index += 1) {
      await expect(transport.getTodos("session-1")).rejects.toThrow();
    }
  });

  it("returns owned boundary and HTTP failures without changing legacy rejections", async () => {
    const malformed = new MiniLilacTransport({
      fetch: mockFetch(async () => jsonResponse({ revision: -1, todos: [] })),
    });
    const decoded = await malformed.getTodosResult("session-1");
    expect(decoded.status).toBe("error");
    if (decoded.status === "ok") throw new Error("expected boundary failure");
    expect(decoded.error).toBeInstanceOf(MiniLilacBoundaryInvalid);
    if (decoded.error._tag !== "MiniLilacBoundaryInvalid") {
      throw new Error("expected boundary error variant");
    }
    expect(decoded.error.issues.length).toBeGreaterThan(0);
    await expect(malformed.getTodos("session-1")).rejects.toBeInstanceOf(
      decoded.error.cause.constructor,
    );

    const unavailable = new MiniLilacTransport({
      fetch: mockFetch(async () => new Response("temporarily unavailable", { status: 503 })),
    });
    const requested = await unavailable.getTodosResult("session-1");
    expect(requested.status).toBe("error");
    if (requested.status === "ok") throw new Error("expected HTTP failure");
    expect(requested.error).toBeInstanceOf(MiniLilacHttpError);
    expect(requested.error).toMatchObject({ status: 503, detail: "temporarily unavailable" });
    await expect(unavailable.getTodos("session-1")).rejects.toThrow(
      "MiniLilac request failed (503): temporarily unavailable",
    );
  });

  it("returns external and cancellation failures while preserving their original causes", async () => {
    const networkCause = new Error("network unavailable");
    const failed = new MiniLilacTransport({
      fetch: mockFetch(async () => Promise.reject(networkCause)),
    });
    const networkResult = await failed.getTodosResult("session-1");
    expect(networkResult.status).toBe("error");
    if (networkResult.status === "ok") throw new Error("expected network failure");
    expect(networkResult.error).toBeInstanceOf(MiniLilacExternalOperationFailed);
    expect(networkResult.error.cause).toBe(networkCause);
    await expect(failed.getTodos("session-1")).rejects.toBe(networkCause);

    const controller = new AbortController();
    const abortCause = new Error("caller detached");
    controller.abort(abortCause);
    const cancelled = new MiniLilacTransport({
      fetch: mockFetch(async (_input, init) => {
        const signal = init?.signal;
        return Promise.reject(signal instanceof AbortSignal ? signal.reason : abortCause);
      }),
    });
    const cancellationResult = await cancelled.getTodosResult("session-1", {
      signal: controller.signal,
    });
    expect(cancellationResult.status).toBe("error");
    if (cancellationResult.status === "ok") throw new Error("expected cancellation");
    expect(cancellationResult.error).toBeInstanceOf(MiniLilacRequestCancelled);
    expect(cancellationResult.error.cause).toBe(abortCause);
    await expect(cancelled.getTodos("session-1", { signal: controller.signal })).rejects.toBe(
      abortCause,
    );
  });

  it("preserves Panic exactly across external Result capture", async () => {
    const panic = new Panic({ message: "fetch invariant failed" });
    const transport = new MiniLilacTransport({
      fetch: mockFetch(async () => {
        throw panic;
      }),
    });

    await expect(transport.getTodosResult("session-1")).rejects.toBe(panic);
  });

  it("lists only the server-filtered sessions for an encoded cwd", async () => {
    const calls: FetchCall[] = [];
    const session = {
      id: "session-1",
      activeRunId: null,
      status: "idle" as const,
      cwd: "/workspace/with space",
      model: "test/model",
      profile: "coding",
      reasoning: "low" as const,
      historyStateId: "history-1",
      canUndo: false,
      canRedo: false,
      queuedSteeringCount: 0,
    };
    const transport = new MiniLilacTransport({
      baseUrl: "/mini",
      fetch: mockFetch(async (input, init) => {
        calls.push({ input, init });
        return jsonResponse([session]);
      }),
    });

    expect(await transport.listSessions("/workspace/with space")).toEqual([session]);
    expect(String(calls[0]?.input)).toBe("/mini/sessions?cwd=%2Fworkspace%2Fwith%20space");
    expect(calls[0]?.init?.method).toBeUndefined();
  });

  it("rejects malformed session catalogs", async () => {
    const transport = new MiniLilacTransport({
      baseUrl: "/mini",
      fetch: mockFetch(async () => jsonResponse([{ id: "incomplete" }])),
    });

    await expect(transport.listSessions("/workspace")).rejects.toThrow();
  });

  it("streams an encoded active session", async () => {
    const calls: FetchCall[] = [];
    const chunks = [
      { type: "text-start", id: "answer" },
      { type: "text-delta", id: "answer", delta: "child answer" },
      { type: "text-end", id: "answer" },
      { type: "finish", finishReason: "stop" },
    ] satisfies readonly UIMessageChunk[];
    const transport = new MiniLilacTransport({
      baseUrl: "/mini",
      fetch: mockFetch(async (input, init) => {
        calls.push({ input, init });
        return sseResponse(chunks);
      }),
    });

    const stream = await transport.streamSession("session / 1");
    if (stream === null) throw new Error("expected active session stream");
    expect(await readChunks(stream)).toEqual(chunks);
    expect(String(calls[0]?.input)).toBe("/mini/chat/session%20%2F%201/stream");
  });

  it("normalizes future non-data envelopes before installed SDK validation", async () => {
    const transport = new MiniLilacTransport({
      fetch: mockFetch(async () =>
        sseResponse([
          { type: "future-observation", payload: { opaque: true }, secret: "discard-me" },
          { type: "text-delta", id: "answer", delta: "still connected" },
        ]),
      ),
    });

    const stream = await transport.streamSession("session-1");
    if (stream === null) throw new Error("expected active session stream");

    expect(await readChunks(stream)).toEqual([
      {
        type: MINI_LILAC_UNSUPPORTED_UI_MESSAGE_CHUNK_TYPE,
        data: { chunkType: "future-observation" },
        transient: true,
      },
      { type: "text-delta", id: "answer", delta: "still connected" },
    ]);
  });

  it("keeps known chunks SDK-validated while preserving raw tool payloads", async () => {
    const input = { command: "bun test", extension: ["raw", 1] };
    const output = { stdout: "pass\n", nested: { untouched: true } };
    const chunks = [
      { type: "tool-input-available", toolCallId: "tool-1", toolName: "bash", input },
      { type: "tool-output-available", toolCallId: "tool-1", output },
      { type: "data-futureExtension", data: { open: true } },
    ] satisfies readonly UIMessageChunk[];
    const transport = new MiniLilacTransport({
      fetch: mockFetch(async () => sseResponse(chunks)),
    });

    const stream = await transport.streamSession("session-1");
    if (stream === null) throw new Error("expected active session stream");

    expect(await readChunks(stream)).toEqual(chunks);
  });

  it("fails the stream for malformed known and malformed future envelopes", async () => {
    const malformedChunks: readonly unknown[] = [
      { type: "text-delta", id: "answer" },
      { type: "data-futureExtension" },
      { payload: { noType: true } },
      { type: "x".repeat(129), payload: true },
      {
        type: MINI_LILAC_UNSUPPORTED_UI_MESSAGE_CHUNK_TYPE,
        data: { chunkType: "future-observation", leaked: true },
        transient: true,
      },
    ];

    for (const malformed of malformedChunks) {
      const transport = new MiniLilacTransport({
        fetch: mockFetch(async () => sseResponse([malformed])),
      });
      const stream = await transport.streamSession("session-1");
      if (stream === null) throw new Error("expected active session stream");
      await expect(stream.getReader().read()).rejects.toThrow();
    }
  });

  it("emits one terminal Err and closes a Result stream for malformed SSE and chunks", async () => {
    const responses = [
      new Response('data: {"type":\n\n', {
        headers: { "Content-Type": "text/event-stream" },
      }),
      sseResponse([{ type: "text-delta", id: "answer" }]),
    ];
    const transport = new MiniLilacTransport({
      fetch: mockFetch(async () => {
        const response = responses.shift();
        if (response === undefined) throw new Error("missing malformed stream fixture");
        return response;
      }),
    });

    for (let index = 0; index < 2; index += 1) {
      const admitted = await transport.streamSessionResult("session-1");
      if (admitted.status === "error" || admitted.value === null) {
        throw new Error("expected admitted Result stream");
      }
      const reader = admitted.value.getReader();
      const terminal = await reader.read();
      expect(terminal.done).toBe(false);
      if (terminal.done || terminal.value.status === "ok") {
        throw new Error("expected terminal stream error");
      }
      expect(terminal.value.error).toBeInstanceOf(MiniLilacStreamDecodeFailed);
      expect((await reader.read()).done).toBe(true);
    }
  });

  it("turns a response-body failure into one terminal Err while legacy streams still reject", async () => {
    const resultSource = erroringSseResponse([{ type: "text-start", id: "text-1" }]);
    const legacySource = erroringSseResponse([{ type: "text-start", id: "text-1" }]);
    const responses = [resultSource.response, legacySource.response];
    const transport = new MiniLilacTransport({
      fetch: mockFetch(async () => {
        const response = responses.shift();
        if (response === undefined) throw new Error("missing body failure fixture");
        return response;
      }),
    });

    const admitted = await transport.streamSessionResult("session-1");
    if (admitted.status === "error" || admitted.value === null) {
      throw new Error("expected admitted Result stream");
    }
    const resultReader = admitted.value.getReader();
    const first = await resultReader.read();
    expect(first.value).toMatchObject({
      status: "ok",
      value: { type: "text-start", id: "text-1" },
    });
    const resultCause = new Error("result body failed");
    resultSource.fail(resultCause);
    const terminal = await resultReader.read();
    if (terminal.done || terminal.value.status === "ok") {
      throw new Error("expected terminal body failure");
    }
    expect(terminal.value.error).toBeInstanceOf(MiniLilacExternalOperationFailed);
    expect(terminal.value.error.cause).toBe(resultCause);
    expect((await resultReader.read()).done).toBe(true);

    const legacy = await transport.streamSession("session-1");
    if (legacy === null) throw new Error("expected legacy stream");
    const legacyReader = legacy.getReader();
    await legacyReader.read();
    const legacyCause = new Error("legacy body failed");
    legacySource.fail(legacyCause);
    await expect(legacyReader.read()).rejects.toBe(legacyCause);
  });

  it("uses only the owned signal reason for stream cancellation", async () => {
    let fetchCalls = 0;
    const preAborted = new AbortController();
    const preAbortReason = new Error("pre-aborted");
    preAborted.abort(preAbortReason);
    const preAbortedTransport = new MiniLilacTransport({
      fetch: mockFetch(async () => {
        fetchCalls += 1;
        return sseResponse([]);
      }),
    });

    const preAbortedResult = await preAbortedTransport.streamSessionResult("session-1", {
      signal: preAborted.signal,
    });
    expect(preAbortedResult.status).toBe("error");
    if (preAbortedResult.status === "ok") throw new Error("expected pre-aborted request");
    expect(preAbortedResult.error).toBeInstanceOf(MiniLilacRequestCancelled);
    expect(preAbortedResult.error.cause).toBe(preAbortReason);
    expect(fetchCalls).toBe(0);
    await expect(
      preAbortedTransport.streamSession("session-1", { signal: preAborted.signal }),
    ).rejects.toBe(preAbortReason);
    expect(fetchCalls).toBe(0);

    const controller = new AbortController();
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        bodyController = streamController;
      },
    });
    const transport = new MiniLilacTransport({
      fetch: mockFetch(
        async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
      ),
    });
    const admitted = await transport.streamSessionResult("session-1", {
      signal: controller.signal,
    });
    if (admitted.status === "error" || admitted.value === null) {
      throw new Error("expected admitted cancellation stream");
    }
    const reader = admitted.value.getReader();
    const pending = reader.read();
    const unrelated = new Error("socket failed concurrently");
    controller.abort(new Error("caller aborted"));
    if (bodyController === undefined) throw new Error("expected response body controller");
    bodyController.error(unrelated);
    const terminal = await pending;
    if (terminal.done || terminal.value.status === "ok") {
      throw new Error("expected terminal concurrent failure");
    }
    expect(terminal.value.error).toBeInstanceOf(MiniLilacExternalOperationFailed);
    expect(terminal.value.error.cause).toBe(unrelated);

    const ownedController = new AbortController();
    let ownedBodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const ownedBody = new ReadableStream<Uint8Array>({
      start(streamController) {
        ownedBodyController = streamController;
      },
    });
    const ownedTransport = new MiniLilacTransport({
      fetch: mockFetch(
        async () => new Response(ownedBody, { headers: { "Content-Type": "text/event-stream" } }),
      ),
    });
    const ownedAdmission = await ownedTransport.streamSessionResult("session-1", {
      signal: ownedController.signal,
    });
    if (ownedAdmission.status === "error" || ownedAdmission.value === null) {
      throw new Error("expected admitted owned cancellation stream");
    }
    const ownedReader = ownedAdmission.value.getReader();
    const ownedPending = ownedReader.read();
    const ownedReason = new Error("owned cancellation");
    ownedController.abort(ownedReason);
    if (ownedBodyController === undefined) throw new Error("expected owned body controller");
    ownedBodyController.error(ownedReason);
    const ownedTerminal = await ownedPending;
    if (ownedTerminal.done || ownedTerminal.value.status === "ok") {
      throw new Error("expected terminal owned cancellation");
    }
    expect(ownedTerminal.value.error).toBeInstanceOf(MiniLilacRequestCancelled);
    expect(ownedTerminal.value.error.cause).toBe(ownedReason);
    expect((await ownedReader.read()).done).toBe(true);
  });

  it("lists profile-aware skills for an encoded cwd", async () => {
    const calls: FetchCall[] = [];
    const transport = new MiniLilacTransport({
      baseUrl: "/mini",
      fetch: mockFetch(async (input, init) => {
        calls.push({ input, init });
        return jsonResponse([
          { name: "frontend-design", description: "Build deliberate interfaces." },
        ]);
      }),
    });

    expect(await transport.listSkills("/workspace/with space", "coding")).toEqual([
      { name: "frontend-design", description: "Build deliberate interfaces." },
    ]);
    expect(String(calls[0]?.input)).toBe(
      "/mini/skills?cwd=%2Fworkspace%2Fwith+space&profile=coding",
    );
    expect(calls[0]?.init?.method).toBeUndefined();
  });

  it("uses local binding changes when the session has not been created yet", async () => {
    const calls: FetchCall[] = [];
    const transport = new MiniLilacTransport({
      baseUrl: "/mini",
      cwd: "/workspace",
      model: "test/old",
      profile: "coding",
      reasoning: "low",
      createClientCommandId: () => "command-1",
      fetch: mockFetch(async (input, init) => {
        calls.push({ input, init });
        return sseResponse([]);
      }),
    });

    transport.setSessionBindings({ model: "test/new", reasoning: "high" });
    await transport.sendMessages({
      trigger: "submit-message",
      chatId: "new-session",
      messageId: undefined,
      messages: [{ id: "user-1", role: "user", parts: [{ type: "text", text: "next" }] }],
      abortSignal: undefined,
    });

    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      cwd: "/workspace",
      model: "test/new",
      profile: "coding",
      reasoning: "high",
    });
  });

  it("uses successful binding updates for later sends from the same transport", async () => {
    const calls: FetchCall[] = [];
    let command = 0;
    const transport = new MiniLilacTransport({
      baseUrl: "/mini",
      cwd: "/workspace",
      model: "test/old",
      profile: "reader",
      reasoning: "low",
      createClientCommandId: () => `command-${++command}`,
      fetch: mockFetch(async (input, init) => {
        calls.push({ input, init });
        if (String(input).endsWith("/bindings")) {
          return jsonResponse({
            id: "session-1",
            activeRunId: null,
            status: "idle",
            cwd: "/workspace",
            model: "test/new",
            profile: "coding",
            reasoning: "high",
            historyStateId: "history-2",
            canUndo: true,
            canRedo: false,
            queuedSteeringCount: 0,
          });
        }
        return sseResponse([]);
      }),
    });

    await transport.updateSessionBindings({
      sessionId: "session-1",
      model: "test/new",
      profile: "coding",
      reasoning: "high",
    });
    await transport.sendMessages({
      trigger: "submit-message",
      chatId: "session-1",
      messageId: undefined,
      messages: [{ id: "user-1", role: "user", parts: [{ type: "text", text: "next" }] }],
      abortSignal: undefined,
    });

    expect(String(calls[0]?.input)).toBe("/mini/sessions/session-1/bindings");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      sessionId: "session-1",
      model: "test/new",
      profile: "coding",
      reasoning: "high",
      clientCommandId: "command-1",
    });
    expect(JSON.parse(String(calls[1]?.init?.body))).toMatchObject({
      id: "session-1",
      cwd: "/workspace",
      model: "test/new",
      profile: "coding",
      reasoning: "high",
      clientCommandId: "command-2",
    });
  });

  it("serializes concurrent binding updates in invocation order", async () => {
    const calls: FetchCall[] = [];
    let resolveFirst = (_response: Response) => {};
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    let bindingCall = 0;
    const transport = new MiniLilacTransport({
      baseUrl: "/mini",
      cwd: "/workspace",
      model: "test/base",
      profile: "coding",
      reasoning: "low",
      fetch: mockFetch(async (input, init) => {
        calls.push({ input, init });
        if (!String(input).endsWith("/bindings")) return sseResponse([]);
        bindingCall += 1;
        if (bindingCall === 1) return firstResponse;
        return jsonResponse({
          id: "session-1",
          activeRunId: null,
          status: "idle",
          cwd: "/workspace",
          model: "test/newer",
          profile: "coding",
          reasoning: "high",
          historyStateId: "history-3",
          canUndo: true,
          canRedo: false,
          queuedSteeringCount: 0,
        });
      }),
    });

    const first = transport.updateSessionBindings({ sessionId: "session-1", model: "test/older" });
    const second = transport.updateSessionBindings({
      sessionId: "session-1",
      model: "test/newer",
      reasoning: "high",
    });
    // test-wait-justification: lets the first serialized binding request start while its response remains gated
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(1);

    resolveFirst(
      jsonResponse({
        id: "session-1",
        activeRunId: null,
        status: "idle",
        cwd: "/workspace",
        model: "test/older",
        profile: "coding",
        reasoning: "low",
        historyStateId: "history-2",
        canUndo: true,
        canRedo: false,
        queuedSteeringCount: 0,
      }),
    );
    await Promise.all([first, second]);
    await transport.sendMessages({
      trigger: "submit-message",
      chatId: "session-1",
      messageId: undefined,
      messages: [{ id: "user-1", role: "user", parts: [{ type: "text", text: "next" }] }],
      abortSignal: undefined,
    });

    expect(JSON.parse(String(calls.at(-1)?.init?.body))).toMatchObject({
      model: "test/newer",
      reasoning: "high",
    });
  });

  it("delegates standard POST and reconnect stream requests with extras and bearer auth", async () => {
    const calls: FetchCall[] = [];
    const fetchMock = mockFetch(async (input, init) => {
      calls.push({ input, init });
      if (init?.method === "POST") {
        return new Response('data: {"type":"start","messageId":"assistant-1"}\n\n', {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return new Response(null, { status: 204 });
    });
    let token = "token-1";
    const transport = new MiniLilacTransport({
      baseUrl: "https://mini.example.test/v1/",
      bearerToken: () => token,
      cwd: "/workspace",
      model: "deep",
      profile: "general",
      reasoning: "high",
      reconnectEndpoint: ({ chatId }) =>
        `https://streams.example.test/reconnect/${encodeURIComponent(chatId)}`,
      createClientCommandId: () => "standard-command-1",
      fetch: fetchMock,
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "session 1",
      messageId: undefined,
      messages: [{ id: "user-1", role: "user", parts: [{ type: "text", text: "hello" }] }],
      abortSignal: undefined,
    });
    expect(stream).toBeInstanceOf(ReadableStream);

    const regenerateStream = await transport.sendMessages({
      trigger: "regenerate-message",
      chatId: "session 1",
      messageId: "assistant-1",
      messages: [{ id: "user-1", role: "user", parts: [{ type: "text", text: "hello" }] }],
      abortSignal: undefined,
      body: { clientCommandId: "standard-command-explicit", model: "fast" },
    });
    expect(regenerateStream).toBeInstanceOf(ReadableStream);

    token = "token-2";
    expect(await transport.reconnectToStream({ chatId: "session 1" })).toBeNull();
    expect(calls).toHaveLength(3);
    expect(String(calls[0]?.input)).toBe("https://mini.example.test/v1/chat");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe("Bearer token-1");

    const postBody: unknown = JSON.parse(String(calls[0]?.init?.body));
    expect(postBody).toEqual({
      cwd: "/workspace",
      model: "deep",
      profile: "general",
      reasoning: "high",
      id: "session 1",
      messages: [{ id: "user-1", role: "user", parts: [{ type: "text", text: "hello" }] }],
      trigger: "submit-message",
      clientCommandId: "standard-command-1",
    });

    const regenerateBody: unknown = JSON.parse(String(calls[1]?.init?.body));
    expect(regenerateBody).toEqual({
      cwd: "/workspace",
      model: "fast",
      profile: "general",
      reasoning: "high",
      clientCommandId: "standard-command-explicit",
      id: "session 1",
      messages: [{ id: "user-1", role: "user", parts: [{ type: "text", text: "hello" }] }],
      trigger: "regenerate-message",
      messageId: "assistant-1",
    });

    expect(String(calls[2]?.input)).toBe("https://streams.example.test/reconnect/session%201");
    expect(calls[2]?.init?.method).toBe("GET");
    expect(new Headers(calls[2]?.init?.headers).get("Authorization")).toBe("Bearer token-2");
  });

  it("applies send request headers after configured, bearer, and JSON headers", async () => {
    const calls: FetchCall[] = [];
    const transport = new MiniLilacTransport({
      headers: {
        Authorization: "Configured authorization",
        "Content-Type": "application/configured",
        "X-Configured": "retained",
      },
      bearerToken: () => "default-token",
      fetch: mockFetch(async (input, init) => {
        calls.push({ input, init });
        return sseResponse([]);
      }),
    });

    await readChunks(
      await transport.sendMessages({
        trigger: "submit-message",
        chatId: "session-1",
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
        headers: {
          Authorization: "Caller authorization",
          "Content-Type": "application/caller+json",
        },
      }),
    );

    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("Authorization")).toBe("Caller authorization");
    expect(headers.get("Content-Type")).toBe("application/caller+json");
    expect(headers.get("X-Configured")).toBe("retained");
  });

  it("applies reconnect request headers after configured and bearer headers", async () => {
    const calls: FetchCall[] = [];
    const transport = new MiniLilacTransport({
      headers: {
        Authorization: "Configured authorization",
        "Content-Type": "application/configured",
        "X-Configured": "retained",
      },
      bearerToken: () => "default-token",
      fetch: mockFetch(async (input, init) => {
        calls.push({ input, init });
        return new Response(null, { status: 204 });
      }),
    });

    expect(
      await transport.reconnectToStream({
        chatId: "session-1",
        headers: {
          Authorization: "Caller authorization",
          "Content-Type": "application/caller-stream",
        },
      }),
    ).toBeNull();

    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("Authorization")).toBe("Caller authorization");
    expect(headers.get("Content-Type")).toBe("application/caller-stream");
    expect(headers.get("X-Configured")).toBe("retained");
  });

  it("sends control command IDs and parses typed control results", async () => {
    const calls: FetchCall[] = [];
    const responses: unknown[] = [
      { status: "queued", steeringId: "steering-1", clientCommandId: "command-explicit" },
      { status: "interrupted", steeringIds: ["steering-1"], clientCommandId: "command-1" },
      { status: "cancelled", clientCommandId: "command-2" },
    ];
    const fetchMock = mockFetch(async (input, init) => {
      calls.push({ input, init });
      return jsonResponse(responses.shift());
    });
    let nextCommand = 1;
    const transport = new MiniLilacTransport({
      baseUrl: "/mini",
      bearerToken: async () => "secret",
      createClientCommandId: () => `command-${nextCommand++}`,
      fetch: fetchMock,
    });

    expect(
      await transport.steer({
        sessionId: "session-1",
        runId: "run-1",
        message: {
          id: "steer-message-1",
          role: "user",
          parts: [{ type: "text", text: "change direction" }],
        },
        clientCommandId: "command-explicit",
      }),
    ).toEqual({
      status: "queued",
      steeringId: "steering-1",
      clientCommandId: "command-explicit",
    });
    expect(
      await transport.interruptQueuedSteering({ sessionId: "session-1", runId: "run-1" }),
    ).toEqual({
      status: "interrupted",
      steeringIds: ["steering-1"],
      clientCommandId: "command-1",
    });
    expect(await transport.cancel({ sessionId: "session-1", runId: "run-1" })).toEqual({
      status: "cancelled",
      clientCommandId: "command-2",
    });

    expect(calls.map((call) => String(call.input))).toEqual([
      "/mini/sessions/session-1/steer",
      "/mini/sessions/session-1/interrupt-queued-steering",
      "/mini/sessions/session-1/cancel",
    ]);
    expect(
      calls.map((call) => {
        const body: unknown = JSON.parse(String(call.init?.body));
        return body;
      }),
    ).toEqual([
      {
        sessionId: "session-1",
        runId: "run-1",
        message: {
          id: "steer-message-1",
          role: "user",
          parts: [{ type: "text", text: "change direction" }],
        },
        clientCommandId: "command-explicit",
      },
      {
        sessionId: "session-1",
        runId: "run-1",
        clientCommandId: "command-1",
        pendingSteerCommandIds: [],
      },
      { sessionId: "session-1", runId: "run-1", clientCommandId: "command-2" },
    ]);
    for (const call of calls) {
      expect(new Headers(call.init?.headers).get("Authorization")).toBe("Bearer secret");
      expect(new Headers(call.init?.headers).get("Content-Type")).toBe("application/json");
    }
  });

  it("rejects malformed JSON responses at the HTTP boundary", async () => {
    const transport = new MiniLilacTransport({
      fetch: mockFetch(async () => jsonResponse({ status: "queued", steeringId: 123 })),
    });

    await expect(
      transport.steer({
        sessionId: "session-1",
        runId: "run-1",
        message: {
          id: "steer-message-1",
          role: "user",
          parts: [{ type: "text", text: "change direction" }],
        },
      }),
    ).rejects.toThrow();
  });

  it("posts idempotent undo commands and parses the removed multipart user message", async () => {
    const calls: FetchCall[] = [];
    const message = {
      id: "user-1",
      role: "user" as const,
      parts: [
        { type: "text" as const, text: "restore me" },
        { type: "file" as const, mediaType: "image/png", url: "data:image/png;base64,AA==" },
      ],
    };
    const transport = new MiniLilacTransport({
      baseUrl: "/mini",
      createClientCommandId: () => "undo-command",
      fetch: mockFetch(async (input, init) => {
        calls.push({ input, init });
        return jsonResponse({
          status: "undone",
          clientCommandId: "undo-command",
          message,
          historyStateId: "history-1",
          filesystem: { status: "restored" },
        });
      }),
    });

    expect(await transport.undo({ sessionId: "session / one" })).toEqual({
      status: "undone",
      clientCommandId: "undo-command",
      message,
      historyStateId: "history-1",
      filesystem: { status: "restored" },
    });
    expect(String(calls[0]?.input)).toBe("/mini/sessions/session%20%2F%20one/undo");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      sessionId: "session / one",
      clientCommandId: "undo-command",
    });
  });

  it("parses an empty undo result", async () => {
    const transport = new MiniLilacTransport({
      fetch: mockFetch(async () =>
        jsonResponse({ status: "empty", clientCommandId: "empty-command" }),
      ),
    });

    expect(
      await transport.undo({ sessionId: "session-1", clientCommandId: "empty-command" }),
    ).toEqual({ status: "empty", clientCommandId: "empty-command" });
  });

  it("posts idempotent redo commands with generated and reused command IDs", async () => {
    const calls: FetchCall[] = [];
    const message = {
      id: "user-1",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "redo me" }],
    };
    const redone = {
      status: "redone" as const,
      clientCommandId: "redo-generated",
      message,
      historyStateId: "history-2",
      filesystem: { status: "skipped" as const, reason: "git-unavailable" as const },
    };
    const responses = [redone, { status: "empty", clientCommandId: "redo-explicit" }];
    const transport = new MiniLilacTransport({
      baseUrl: "/mini",
      createClientCommandId: () => "redo-generated",
      fetch: mockFetch(async (input, init) => {
        calls.push({ input, init });
        return jsonResponse(responses.shift());
      }),
    });

    expect(await transport.redo({ sessionId: "session / one" })).toEqual(redone);
    expect(
      await transport.redo({ sessionId: "session / one", clientCommandId: "redo-explicit" }),
    ).toEqual({ status: "empty", clientCommandId: "redo-explicit" });
    expect(calls.map((call) => String(call.input))).toEqual([
      "/mini/sessions/session%20%2F%20one/redo",
      "/mini/sessions/session%20%2F%20one/redo",
    ]);
    expect(calls.map((call) => JSON.parse(String(call.init?.body)))).toEqual([
      { sessionId: "session / one", clientCommandId: "redo-generated" },
      { sessionId: "session / one", clientCommandId: "redo-explicit" },
    ]);
  });

  it("streams compaction lifecycle events and resolves with the terminal result", async () => {
    const calls: FetchCall[] = [];
    const events = [
      { source: "manual", reason: "manual", phase: "started", messageCountBefore: 18 },
      {
        source: "manual",
        reason: "manual",
        phase: "progress",
        messageCountBefore: 18,
        summary: "Condensed",
      },
      {
        source: "manual",
        reason: "manual",
        phase: "completed",
        outcome: "compacted",
        messageCountBefore: 18,
        messageCountAfter: 6,
        estimatedInputTokensBefore: 12_000,
        estimatedInputTokensAfter: 3_500,
      },
    ];
    const transport = new MiniLilacTransport({
      baseUrl: "/mini",
      createClientCommandId: () => "compact-command",
      fetch: mockFetch(async (input, init) => {
        calls.push({ input, init });
        return eventStreamResponse(
          events.map((data) => ({ type: "data-compaction", id: "compaction:1", data })),
        );
      }),
    });

    const seen: unknown[] = [];
    expect(
      await transport.compact({ sessionId: "session / one" }, { onEvent: (e) => seen.push(e) }),
    ).toEqual({
      status: "compacted",
      clientCommandId: "compact-command",
      messageCountBefore: 18,
      messageCountAfter: 6,
      estimatedInputTokensBefore: 12_000,
      estimatedInputTokensAfter: 3_500,
    });
    expect(seen).toEqual(events);
    expect(String(calls[0]?.input)).toBe("/mini/sessions/session%20%2F%20one/compact");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      sessionId: "session / one",
      clientCommandId: "compact-command",
    });
  });

  it("treats a completed compaction as terminal even if the stream never closes", async () => {
    const event = {
      type: "data-compaction",
      id: "compaction:1",
      data: {
        source: "manual",
        reason: "manual",
        phase: "completed",
        outcome: "compacted",
        messageCountBefore: 18,
        messageCountAfter: 6,
      },
    };
    // The stream is deliberately never closed: a committed compaction must not
    // hinge on EOF from a server (or proxy) that holds the connection open.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      },
    });
    const transport = new MiniLilacTransport({
      createClientCommandId: () => "compact-command",
      fetch: mockFetch(
        async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
      ),
    });

    expect(await transport.compact({ sessionId: "session-1" })).toEqual({
      status: "compacted",
      clientCommandId: "compact-command",
      messageCountBefore: 18,
      messageCountAfter: 6,
    });
  });

  it("rejects a malformed completed event without waiting for the stream to close", async () => {
    const event = {
      type: "data-compaction",
      id: "compaction:1",
      data: {
        source: "manual",
        reason: "manual",
        phase: "completed",
        messageCountBefore: 18,
        // A current terminal event must identify both its outcome and final count.
      },
    };
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      },
    });
    const transport = new MiniLilacTransport({
      fetch: mockFetch(
        async () => new Response(body, { headers: { "Content-Type": "text/event-stream" } }),
      ),
    });

    await expect(transport.compact({ sessionId: "session-1" })).rejects.toThrow(
      "Invalid compaction lifecycle event",
    );
  });

  it("surfaces a failed compaction as a rejection rather than a silent no-op", async () => {
    const transport = new MiniLilacTransport({
      fetch: mockFetch(async () =>
        eventStreamResponse([
          {
            type: "data-compaction",
            data: {
              source: "manual",
              reason: "manual",
              phase: "failed",
              messageCountBefore: 4,
              error: "summary unavailable",
            },
          },
        ]),
      ),
    });

    await expect(
      transport.compact({ sessionId: "session-1", clientCommandId: "compact-command" }),
    ).rejects.toThrow("summary unavailable");
  });

  it("distinguishes a cancelled compaction from a failed one", async () => {
    const transport = new MiniLilacTransport({
      fetch: mockFetch(async () =>
        eventStreamResponse([
          {
            type: "data-compaction",
            data: {
              source: "manual",
              reason: "manual",
              phase: "cancelled",
              messageCountBefore: 4,
            },
          },
        ]),
      ),
    });

    // A cancel is a deliberate stop, so callers can render it as one instead of
    // as an error they have to explain.
    await expect(
      transport.compact({ sessionId: "session-1", clientCommandId: "compact-command" }),
    ).rejects.toBeInstanceOf(MiniLilacCompactionCancelledError);

    const result = await transport.compactResult({
      sessionId: "session-1",
      clientCommandId: "compact-command",
    });
    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected cancelled compaction");
    expect(result.error).toBeInstanceOf(MiniLilacCompactionCancelledError);
  });

  it("preserves Panic thrown by compaction callbacks", async () => {
    const panic = new Panic({ message: "renderer invariant failed" });
    let cancelled = false;
    const source = openEventStreamResponse(
      [
        {
          type: "data-compaction",
          data: {
            source: "manual",
            reason: "manual",
            phase: "started",
            messageCountBefore: 4,
          },
        },
      ],
      () => {
        cancelled = true;
      },
    );
    const transport = new MiniLilacTransport({
      fetch: mockFetch(async () => source.response),
    });

    await expect(
      transport.compactResult(
        { sessionId: "session-1", clientCommandId: "compact-command" },
        {
          onEvent() {
            throw panic;
          },
        },
      ),
    ).rejects.toBe(panic);
    expect(cancelled).toBe(true);
    expect(source.body.locked).toBe(false);
  });

  it("returns ordinary compaction callback failures as Err and preserves legacy identity", async () => {
    const callbackFailure = new Error("observer unavailable");
    const event = {
      type: "data-compaction",
      data: {
        source: "manual",
        reason: "manual",
        phase: "started",
        messageCountBefore: 4,
      },
    };
    const resultSource = openEventStreamResponse([event], () => {});
    const legacySource = openEventStreamResponse([event], () => {});
    const responses = [resultSource.response, legacySource.response];
    const transport = new MiniLilacTransport({
      fetch: mockFetch(async () => {
        const response = responses.shift();
        if (response === undefined) throw new Error("missing callback failure fixture");
        return response;
      }),
    });
    const options = {
      onEvent() {
        throw callbackFailure;
      },
    };

    const result = await transport.compactResult(
      { sessionId: "session-1", clientCommandId: "compact-callback-result" },
      options,
    );
    expect(result.status).toBe("error");
    if (result.status === "ok") throw new Error("expected callback failure");
    expect(result.error).toBeInstanceOf(MiniLilacExternalOperationFailed);
    if (result.error._tag !== "MiniLilacExternalOperationFailed") {
      throw new Error("expected external callback failure");
    }
    expect(result.error.cause).toBe(callbackFailure);
    expect(resultSource.body.locked).toBe(false);

    await expect(
      transport.compact(
        { sessionId: "session-1", clientCommandId: "compact-callback-legacy" },
        options,
      ),
    ).rejects.toBe(callbackFailure);
    expect(legacySource.body.locked).toBe(false);
  });

  it("returns cleanup-only and combined compaction failures with full reader cleanup", async () => {
    const cleanupOnlyCause = new Error("cleanup-only detach failed");
    const cleanupOnly = openEventStreamResponse(
      [
        {
          type: "data-compaction",
          data: {
            source: "manual",
            reason: "manual",
            phase: "completed",
            outcome: "compacted",
            messageCountBefore: 8,
            messageCountAfter: 3,
          },
        },
      ],
      () => Promise.reject(cleanupOnlyCause),
    );
    const combinedCause = new Error("combined detach failed");
    const combined = openEventStreamResponse(
      [
        {
          type: "data-compaction",
          data: {
            source: "manual",
            reason: "manual",
            phase: "failed",
            messageCountBefore: 8,
            error: "summary failed",
          },
        },
      ],
      () => Promise.reject(combinedCause),
    );
    const responses = [cleanupOnly.response, combined.response];
    const transport = new MiniLilacTransport({
      fetch: mockFetch(async () => {
        const response = responses.shift();
        if (response === undefined) throw new Error("missing compaction cleanup fixture");
        return response;
      }),
    });

    const cleanupOnlyResult = await transport.compactResult({
      sessionId: "session-1",
      clientCommandId: "compact-cleanup-only",
    });
    expect(cleanupOnlyResult.status).toBe("error");
    if (cleanupOnlyResult.status === "ok") throw new Error("expected cleanup-only failure");
    expect(cleanupOnlyResult.error).toBeInstanceOf(MiniLilacStreamCleanupFailed);
    expect(cleanupOnly.body.locked).toBe(false);

    const combinedResult = await transport.compactResult({
      sessionId: "session-1",
      clientCommandId: "compact-combined",
    });
    expect(combinedResult.status).toBe("error");
    if (combinedResult.status === "ok") throw new Error("expected combined failure");
    expect(combinedResult.error).toBeInstanceOf(MiniLilacCompactionAndCleanupFailed);
    expect(combined.body.locked).toBe(false);
  });

  it("preserves an exact cleanup Panic after releasing the compaction reader", async () => {
    const cleanupPanic = new Panic({ message: "response cancellation invariant failed" });
    const source = openEventStreamResponse(
      [
        {
          type: "data-compaction",
          data: {
            source: "manual",
            reason: "manual",
            phase: "completed",
            outcome: "compacted",
            messageCountBefore: 5,
            messageCountAfter: 2,
          },
        },
      ],
      () => Promise.reject(cleanupPanic),
    );
    const transport = new MiniLilacTransport({
      fetch: mockFetch(async () => source.response),
    });

    await expect(
      transport.compactResult({
        sessionId: "session-1",
        clientCommandId: "compact-cleanup-panic",
      }),
    ).rejects.toBe(cleanupPanic);
    expect(source.body.locked).toBe(false);
  });

  it("cancels compaction through its own endpoint", async () => {
    const calls: FetchCall[] = [];
    const transport = new MiniLilacTransport({
      baseUrl: "/mini",
      fetch: mockFetch(async (input, init) => {
        calls.push({ input, init });
        return jsonResponse({ status: "cancelling" });
      }),
    });

    expect(await transport.cancelCompaction({ sessionId: "session / one" })).toEqual({
      status: "cancelling",
    });
    expect(String(calls[0]?.input)).toBe("/mini/sessions/session%20%2F%20one/compact/cancel");
    expect(calls[0]?.init?.method).toBe("POST");
  });

  it("acknowledges a normal cursor-payload pair only after enqueuing the payload", async () => {
    const calls: FetchCall[] = [];
    const fetchMock = mockFetch(async (input, init) => {
      calls.push({ input, init });
      if (init?.method === "POST") {
        return sseResponse([cursor(3), { type: "text-start", id: "text-1" }]);
      }
      return new Response(null, { status: 204 });
    });
    const transport = new MiniLilacTransport({
      baseUrl: "/mini",
      createClientCommandId: () => "command-1",
      fetch: fetchMock,
    });

    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-1",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });
    expect(transport.getLastStreamCursor("chat-1")).toBeUndefined();
    const reader = stream.getReader();
    expect((await reader.read()).value).toEqual(cursor(3));
    expect(transport.getLastStreamCursor("chat-1")).toBeUndefined();
    expect((await reader.read()).value).toEqual({ type: "text-start", id: "text-1" });
    expect(transport.getLastStreamCursor("chat-1")).toEqual({ runId: "run-1", seq: 3 });
    expect((await reader.read()).done).toBe(true);

    expect(await transport.reconnectToStream({ chatId: "chat-1" })).toBeNull();
    expect(String(calls[1]?.input)).toBe("/mini/chat/chat-1/stream?runId=run-1&after=3");

    await transport.sendMessages({
      trigger: "regenerate-message",
      chatId: "chat-1",
      messageId: "assistant-1",
      messages: [],
      abortSignal: undefined,
    });
    expect(transport.getLastStreamCursor("chat-1")).toBeUndefined();
  });

  it("reconnects from the prior acknowledged cursor after a partial pair fails", async () => {
    const calls: FetchCall[] = [];
    const source = erroringSseResponse([
      cursor(2),
      { type: "text-start", id: "text-1" },
      cursor(4),
    ]);
    const transport = new MiniLilacTransport({
      baseUrl: "/mini",
      fetch: mockFetch(async (input, init) => {
        calls.push({ input, init });
        return init?.method === "POST" ? source.response : new Response(null, { status: 204 });
      }),
    });
    const stream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-1",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });
    const reader = stream.getReader();

    expect((await reader.read()).value).toEqual(cursor(2));
    expect((await reader.read()).value).toEqual({ type: "text-start", id: "text-1" });
    expect((await reader.read()).value).toEqual(cursor(4));
    source.fail(new Error("connection lost"));
    await expect(reader.read()).rejects.toThrow("connection lost");
    expect(transport.getLastStreamCursor("chat-1")).toEqual({ runId: "run-1", seq: 2 });
    expect(await transport.reconnectToStream({ chatId: "chat-1" })).toBeNull();
    expect(String(calls[1]?.input)).toBe("/mini/chat/chat-1/stream?runId=run-1&after=2");
  });

  it("does not acknowledge a pending cursor after the stream generation changes", async () => {
    const encoder = new TextEncoder();
    let firstController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let requestCount = 0;
    const transport = new MiniLilacTransport({
      fetch: mockFetch(async () => {
        requestCount += 1;
        if (requestCount > 1) return sseResponse([]);

        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              firstController = controller;
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(cursor(9))}\n\n`));
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      }),
    });
    const firstStream = await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-1",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });
    const firstReader = firstStream.getReader();
    expect((await firstReader.read()).value).toEqual(cursor(9));

    await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-1",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    });

    if (!firstController) throw new Error("Expected the first response stream controller");
    firstController.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({ type: "text-start", id: "stale-text" })}\n\ndata: [DONE]\n\n`,
      ),
    );
    firstController.close();
    expect((await firstReader.read()).value).toEqual({ type: "text-start", id: "stale-text" });
    expect(transport.getLastStreamCursor("chat-1")).toBeUndefined();
  });

  it("rolls exact reconnect cursors across consecutive runs", async () => {
    const calls: FetchCall[] = [];
    let postCount = 0;
    const transport = new MiniLilacTransport({
      baseUrl: "/mini",
      fetch: mockFetch(async (input, init) => {
        calls.push({ input, init });
        if (init?.method !== "POST") return new Response(null, { status: 204 });
        postCount += 1;
        return sseResponse([
          cursor(1, `run-${postCount}`),
          { type: "text-start", id: `text-${postCount}` },
        ]);
      }),
    });

    for (let run = 1; run <= 2; run += 1) {
      const stream = await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-1",
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      });
      await readChunks(stream);
      expect(transport.getLastStreamCursor("chat-1")).toEqual({ runId: `run-${run}`, seq: 1 });
    }

    expect(await transport.reconnectToStream({ chatId: "chat-1" })).toBeNull();
    expect(String(calls[2]?.input)).toBe("/mini/chat/chat-1/stream?runId=run-2&after=1");
  });

  it("retains the exact cursor when admission of a newer run fails", async () => {
    const calls: FetchCall[] = [];
    let postCount = 0;
    const transport = new MiniLilacTransport({
      baseUrl: "/mini",
      fetch: mockFetch(async (input, init) => {
        calls.push({ input, init });
        if (init?.method !== "POST") return new Response(null, { status: 204 });
        postCount += 1;
        if (postCount > 1) return new Response("session active", { status: 409 });
        return sseResponse([cursor(4), { type: "text-start", id: "text-1" }]);
      }),
    });
    const request = {
      trigger: "submit-message" as const,
      chatId: "chat-1",
      messageId: undefined,
      messages: [],
      abortSignal: undefined,
    };

    await readChunks(await transport.sendMessages(request));
    await expect(transport.sendMessages(request)).rejects.toThrow("session active");
    expect(transport.getLastStreamCursor("chat-1")).toEqual({ runId: "run-1", seq: 4 });
    expect(await transport.reconnectToStream({ chatId: "chat-1" })).toBeNull();
    expect(String(calls[2]?.input)).toBe("/mini/chat/chat-1/stream?runId=run-1&after=4");
  });

  it("replaces duplicate exact-run parameters on custom reconnect endpoints", async () => {
    const calls: FetchCall[] = [];
    const transport = new MiniLilacTransport({
      baseUrl: "/mini",
      reconnectEndpoint: "reconnect?token=abc&runId=old&after=99&after=100#stream",
      fetch: mockFetch(async (input, init) => {
        calls.push({ input, init });
        if (init?.method === "POST") {
          return sseResponse([cursor(7), { type: "text-start", id: "text-1" }]);
        }
        return new Response(null, { status: 204 });
      }),
    });

    await readChunks(
      await transport.sendMessages({
        trigger: "submit-message",
        chatId: "chat-1",
        messageId: undefined,
        messages: [],
        abortSignal: undefined,
      }),
    );
    expect(await transport.reconnectToStream({ chatId: "chat-1" })).toBeNull();
    expect(String(calls[1]?.input)).toBe("/mini/reconnect?token=abc&runId=run-1&after=7#stream");
  });
});
