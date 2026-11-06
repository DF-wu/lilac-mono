import { afterEach, expect, test, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { Result } from "better-result";
import type { DisplayMessage } from "@stanley2058/lilac-client-protocol";
import { NativeStore, nativeStoreTransaction } from "./store";
import { nativeFailure } from "./errors";
import { createNativeDiscordMirror } from "./discord-mirror";
import { createMemoryBlobStore } from "@stanley2058/lilac-blob-storage";
import { SqliteTranscriptStore } from "../../transcript/transcript-store";
import { CoreResourceService } from "../../resource/service";
import { ResourceOriginAdapterRegistry } from "../../resource/origin";
import { NativeResourceService } from "./resources";
import { projectNativeOutput } from "./output-projection";
import { readDiscordMirrorAttachment } from "./discord-mirror-attachment";
import type { NativeOutputEvent } from "@stanley2058/lilac-event-bus";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0)) await stop();
});

function fixture(
  webhookUrl: string | undefined = "https://discord.com/api/webhooks/123/test-only",
  beforeMirror?: (store: NativeStore, threadId: string) => void,
) {
  const db = new Database(":memory:");
  const store = new NativeStore(db);
  store.initialize().unwrap();
  for (const [id, role] of [
    ["owner", "owner"],
    ["lilac", "service"],
  ] as const)
    store.upsertUser({ id, providerId: id, displayName: id, role, toolMode: "full" }).unwrap();
  const thread = store.createThread("owner", { commandId: "new" }).unwrap();
  beforeMirror?.(store, thread.id);
  const requests: {
    method: string;
    url: string;
    payload: Record<string, unknown>;
    files: Blob[];
  }[] = [];
  const warnings: string[] = [];
  let respond = (_request: RequestInit): Promise<Response> =>
    Promise.resolve(Response.json({ id: String(1000 + requests.length) }));
  const resourceBinding: Pick<NativeResourceService, "scopedAccess"> = {
    scopedAccess: () => {
      throw new Error("Unexpected resource read");
    },
  };
  const waits: number[] = [];
  const mirror = createNativeDiscordMirror({
    store,
    webhookUrl,
    resources: resourceBinding,
    wait: async (ms) => {
      waits.push(ms);
    },
    warn: (message) => warnings.push(message),
    fetch: async (url, init) => {
      const form = init.body instanceof FormData ? init.body : null;
      requests.push({
        method: init.method ?? "GET",
        url: String(url),
        payload: JSON.parse(form ? String(form.get("payload_json")) : String(init.body ?? "{}")),
        files: form
          ? ([...form.values()] as unknown[]).filter(
              (value): value is Blob => value instanceof Blob,
            )
          : [],
      });
      return respond(init);
    },
  });
  cleanup.push(async () => {
    await mirror.stop();
    db.close();
  });
  const post = (message: DisplayMessage) =>
    store
      .postMessage("owner", thread.id, {
        ...message,
        metadata: { createdAt: Date.now(), ...message.metadata },
      })
      .unwrap();
  const settle = async () => {
    await new Promise<void>(queueMicrotask);
    await mirror.drain();
  };
  return {
    store,
    db,
    thread,
    mirror,
    requests,
    warnings,
    post,
    settle,
    resourceBinding,
    waits,
    respond: (next: typeof respond) => {
      respond = next;
    },
  };
}

test("allowlists human/assistant text and excludes system, reasoning, tools and service inputs", async () => {
  const f = fixture();
  f.store
    .acceptInput("owner", {
      threadId: f.thread.id,
      commandId: "input",
      historyGeneration: 0,
      text: "Human visible",
      mode: "prompt",
      attachmentIds: [],
      skillIds: [],
    })
    .unwrap();
  f.post({
    id: "answer",
    role: "assistant",
    parts: [
      { type: "text", text: "Assistant visible @everyone resource://private-id" },
      {
        type: "data-activity",
        id: "reason",
        data: {
          kind: "thinking",
          label: "REASONING_SENTINEL",
          state: "complete",
          detail: "REASONING_SENTINEL",
        },
      },
      {
        type: "data-activity",
        id: "tool",
        data: {
          kind: "tool",
          label: "TOOL_CALL_SENTINEL",
          state: "complete",
          output: "TOOL_RESULT_SENTINEL",
        },
      },
    ],
  });
  f.post({
    id: "system",
    role: "system",
    parts: [{ type: "text", text: "SYSTEM_DEVELOPER_SENTINEL" }],
  });
  f.post({
    id: "internal",
    role: "user",
    metadata: { authorId: "lilac" },
    parts: [{ type: "text", text: "INTERNAL_SENTINEL" }],
  });
  await f.settle();
  expect(f.requests).toHaveLength(2);
  const output = JSON.stringify(f.requests.map((request) => request.payload));
  expect(output).toContain("Human visible");
  expect(output).toContain("Assistant visible");
  expect(output).toContain(`native:${f.thread.id}`);
  for (const sentinel of [
    "REASONING_SENTINEL",
    "TOOL_CALL_SENTINEL",
    "TOOL_RESULT_SENTINEL",
    "SYSTEM_DEVELOPER_SENTINEL",
    "INTERNAL_SENTINEL",
    "resource://private-id",
  ])
    expect(output).not.toContain(sentinel);
  for (const request of f.requests)
    expect(request.payload.allowed_mentions).toEqual({
      parse: [],
      users: [],
      roles: [],
      replied_user: false,
    });
});

test("no history on enable, disabled/invalid URL sends nothing, and rolled back writes stay private", async () => {
  for (const url of [
    "",
    "http://discord.com/api/webhooks/123/test-only",
    "https://example.com/api/webhooks/123/test-only",
    "https://discord.com/api/webhooks/123/test-only?thread_id=1",
  ]) {
    const f = fixture(url);
    f.post({ id: "disabled", role: "assistant", parts: [{ type: "text", text: "disabled" }] });
    await f.settle();
    expect(f.requests).toEqual([]);
  }
  const f = fixture();
  nativeStoreTransaction(f.db, () => {
    f.post({
      id: "rolledback",
      role: "assistant",
      parts: [{ type: "text", text: "ROLLBACK_SENTINEL" }],
    });
    return Result.err(nativeFailure("invalid", "Rollback"));
  });
  await f.settle();
  expect(f.requests).toEqual([]);
});

test("startup skips existing history, historical semantic replay, recovered old posts and edits to untracked history", async () => {
  const f = fixture(undefined, (store, threadId) => {
    store
      .postMessage("owner", threadId, {
        id: "old",
        role: "assistant",
        metadata: { createdAt: 1 },
        parts: [{ type: "text", text: "EXISTING_SENTINEL" }],
      })
      .unwrap();
  });
  const input = f.store
    .acceptInput("owner", {
      threadId: f.thread.id,
      commandId: "fresh",
      historyGeneration: 0,
      text: "Fresh input",
      mode: "prompt",
      attachmentIds: [],
      skillIds: [],
    })
    .unwrap();
  const request = f.store.getInput(input.inputId).unwrap();
  const event = {
    eventId: "old-event",
    threadId: f.thread.id,
    generation: 0,
    requestId: request.requestId,
    turnId: input.turnId!,
    attemptId: "old-attempt",
    sequence: 1,
    ordinal: 1,
    occurredAt: 1,
    payload: {
      type: "text" as const,
      partId: "old-part",
      incomplete: false,
      position: 0,
      stepId: "old-step",
      text: "REPLAY_SENTINEL",
      phase: "final_answer" as const,
    },
  };
  f.store
    .projectTurn(f.thread.id, 0, event.eventId, input.turnId!, (slot, projection) =>
      Result.ok(projectNativeOutput(slot, event, projection)),
    )
    .unwrap();
  f.post({
    id: "recovered-post",
    role: "assistant",
    metadata: { createdAt: 1 },
    parts: [{ type: "text", text: "RECOVERED_SENTINEL" }],
  });
  f.store
    .updateSurfaceMessage("owner", f.thread.id, "old", {
      id: "old",
      role: "assistant",
      parts: [{ type: "text", text: "OLD_EDIT_SENTINEL" }],
    })
    .unwrap();
  await f.settle();
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]?.payload.content).toContain("Fresh input");
});

test("child streams and imported external output are excluded; visible native service assistant posts are included", async () => {
  let parentRequestId = "";
  const f = fixture(undefined, (store, threadId) => {
    const input = store
      .acceptInput("owner", {
        threadId,
        commandId: "parent",
        historyGeneration: 0,
        text: "Parent",
        mode: "prompt",
        attachmentIds: [],
        skillIds: [],
      })
      .unwrap();
    parentRequestId = store.getInput(input.inputId).unwrap().requestId;
    store.prepareInput(input.inputId).unwrap();
    store.settleInput(input.inputId, "admitted").unwrap();
    store.markInputCompleted(input.inputId).unwrap();
  });
  const stream = f.store
    .ensureAgentStream({
      parentThreadId: f.thread.id,
      parentRequestId,
      runId: "child-run",
      requestId: "child-request",
      messages: [],
      state: "running",
      startedAt: Date.now(),
    })
    .unwrap();
  const child: DisplayMessage = {
    id: "child-message",
    role: "assistant",
    metadata: { createdAt: Date.now() },
    parts: [{ type: "text", text: "CHILD_SENTINEL" }],
  };
  f.store
    .projectTurn(stream.id, stream.historyGeneration, "child-event", stream.turnId, (slot) =>
      Result.ok({
        slot: { ...slot, messages: [child] },
        changes: [
          { kind: "append-message", message: child, turnId: slot.turnId, position: slot.position },
        ],
      }),
    )
    .unwrap();
  for (const externalRunId of ["discord-run", "telegram-run"])
    f.post({
      id: externalRunId,
      role: "assistant",
      metadata: { externalRunId },
      parts: [{ type: "text", text: "EXTERNAL_SENTINEL" }],
    });
  f.post({
    id: "native-service",
    role: "assistant",
    metadata: { authorId: "lilac" },
    parts: [{ type: "text", text: "Visible native send" }],
  });
  await f.settle();
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0]?.payload.content).toContain("Visible native send");
});

test("rate limits retry in order, cap attempts and isolate transport rejection", async () => {
  const f = fixture();
  let attempts = 0;
  f.respond(async () =>
    ++attempts === 1
      ? Response.json({ retry_after: 0.01 }, { status: 429 })
      : Response.json({ id: "9999" }),
  );
  f.post({ id: "limited", role: "assistant", parts: [{ type: "text", text: "Rate limited" }] });
  await f.settle();
  expect(f.requests).toHaveLength(2);
  expect(f.waits.some((ms) => ms > 0 && ms <= 10)).toBe(true);
  f.respond(async () => Response.json({ retry_after: 0 }, { status: 429 }));
  f.post({ id: "exhausted", role: "assistant", parts: [{ type: "text", text: "Exhausted" }] });
  await f.settle();
  expect(f.requests).toHaveLength(5);
  f.respond(async () => {
    throw new Error("https://discord.com/api/webhooks/123/test-only");
  });
  f.post({ id: "error", role: "assistant", parts: [{ type: "text", text: "Error" }] });
  await f.settle();
  expect(f.requests).toHaveLength(6);
  expect(JSON.stringify(f.warnings)).not.toContain("test-only");
});

test("committed-display observer contains listener exceptions, closed DB reads and immediate store close", async () => {
  const f = fixture();
  f.store.subscribeCommittedDisplay(() => {
    throw new Error("Observer defect");
  });
  f.post({ id: "listener", role: "assistant", parts: [{ type: "text", text: "Still delivered" }] });
  await f.settle();
  expect(f.requests).toHaveLength(1);
  f.post({ id: "closed", role: "assistant", parts: [{ type: "text", text: "Closed" }] });
  f.db.close();
  await f.settle();
  expect(f.requests).toHaveLength(1);
});

test("ready attachments use verified bytes, replace on edit, and omit unavailable/oversized uploads without private URIs", async () => {
  const f = fixture();
  const blobs = (await createMemoryBlobStore()).unwrap();
  const transcript = new SqliteTranscriptStore(":memory:");
  const access = new CoreResourceService({
    store: transcript,
    blobStore: blobs,
    originAdapters: new ResourceOriginAdapterRegistry([]),
  });
  const resources = new NativeResourceService({
    native: f.store,
    resources: transcript,
    access,
    blobs,
  });
  cleanup.push(async () => {
    (await resources.stop()).unwrap();
    transcript.close();
    (await blobs.close({ deadlineAtMs: Date.now() + 1000 })).unwrap();
  });
  f.resourceBinding.scopedAccess = (id) => resources.scopedAccess(id);
  const bytes = new TextEncoder().encode("Attachment bytes");
  const reserved = resources
    .reserve("owner", {
      threadId: f.thread.id,
      filename: "notes.txt",
      mediaType: "text/plain",
      size: bytes.byteLength,
    })
    .unwrap();
  const ready = (
    await resources.upload(
      "owner",
      reserved.id,
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    )
  ).unwrap();
  const part = {
    type: "data-resource" as const,
    id: ready.id,
    data: {
      resourceId: ready.id,
      name: ready.filename,
      mediaType: ready.mediaType,
      size: ready.size,
      state: "ready" as const,
    },
  };
  f.post({ id: "file", role: "assistant", parts: [part] });
  await f.settle();
  expect(f.requests).toHaveLength(1);
  expect(await f.requests[0]!.files[0]!.text()).toBe("Attachment bytes");
  expect(JSON.stringify(f.requests[0]!.payload)).not.toContain("resource://");
  f.store
    .updateSurfaceMessage("owner", f.thread.id, "file", {
      id: "file",
      role: "assistant",
      parts: [{ type: "text", text: "File removed" }],
    })
    .unwrap();
  await f.settle();
  expect(f.requests.at(-1)?.method).toBe("PATCH");
  expect(f.requests.at(-1)?.payload.attachments).toEqual([]);

  const oversized = f.store
    .reserveUpload("owner", {
      threadId: f.thread.id,
      filename: "large.bin",
      mediaType: "application/octet-stream",
      size: 9 * 1024 * 1024,
    })
    .unwrap();
  const large = f.store
    .settleUpload(oversized.id, {
      attempt: oversized.attempt,
      historyGeneration: 0,
      state: "ready",
      resourceUri: "resource://oversized-private",
    })
    .unwrap();
  f.post({
    id: "large-file",
    role: "assistant",
    parts: [
      { ...part, id: large.id, data: { ...part.data, resourceId: large.id, size: large.size } },
    ],
  });
  await f.settle();
  expect(f.requests.at(-1)?.files).toEqual([]);
  expect(f.requests.at(-1)?.payload.content).toContain("Attachment unavailable");
  expect(JSON.stringify(f.requests)).not.toContain("oversized-private");

  for (const mutation of ["delete", "edit"] as const) {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const first = f.requests.length;
    f.resourceBinding.scopedAccess = (actorId) => {
      const scoped = resources.scopedAccess(actorId);
      return {
        ...scoped,
        open: async (uri, options) => {
          started.resolve();
          await release.promise;
          return scoped.open(uri, options);
        },
      };
    };
    const id = `inflight-${mutation}`;
    f.post({ id, role: "assistant", parts: [part] });
    await started.promise;
    f.store
      .updateSurfaceMessage(
        "owner",
        f.thread.id,
        id,
        mutation === "delete"
          ? null
          : { id, role: "assistant", parts: [{ type: "text", text: "Current edited content" }] },
      )
      .unwrap();
    await new Promise<void>(queueMicrotask);
    release.resolve();
    await f.settle();
    expect(f.requests.length - first).toBe(mutation === "delete" ? 0 : 1);
    if (mutation === "edit") {
      expect(f.requests.at(-1)?.payload.content).toContain("Current edited content");
      expect(f.requests.at(-1)?.files).toEqual([]);
    }
  }

  for (const stallAt of ["body", "verification"] as const) {
    const realAccess = resources.scopedAccess("owner");
    const read = (
      await realAccess.open(ready.resourceUri!, { expected: "any", maxBytes: 1024 })
    ).unwrap();
    await read.stream.cancel();
    const started = Promise.withResolvers<void>();
    const completion = Promise.withResolvers<Awaited<typeof read.completion>>();
    const controller = new AbortController();
    const canceled = Promise.withResolvers<void>();
    const stream = new ReadableStream<Uint8Array>({
      pull(source) {
        started.resolve();
        if (stallAt === "verification") source.close();
      },
      cancel() {
        canceled.resolve();
      },
    });
    const reading = readDiscordMirrorAttachment(
      {
        ...realAccess,
        open: async () => Result.ok({ ...read, stream, completion: completion.promise }),
      },
      ready.resourceUri!,
      1024,
      controller.signal,
    );
    await started.promise;
    controller.abort();
    expect(await reading).toBeNull();
    if (stallAt === "body") await canceled.promise;
    completion.resolve(await read.completion);
  }

  const scoped = resources.scopedAccess("owner");
  const verified = (
    await scoped.open(ready.resourceUri!, { expected: "any", maxBytes: 1024 })
  ).unwrap();
  await verified.stream.cancel();
  const late = Promise.withResolvers<Awaited<ReturnType<typeof scoped.open>>>();
  const aborted = new AbortController();
  const lateRead = readDiscordMirrorAttachment(
    { ...scoped, open: () => late.promise },
    ready.resourceUri!,
    1024,
    aborted.signal,
  );
  aborted.abort();
  expect(await lateRead).toBeNull();
  const lateCanceled = Promise.withResolvers<void>();
  late.resolve(
    Result.ok({
      ...verified,
      stream: new ReadableStream({
        cancel() {
          lateCanceled.resolve();
        },
      }),
    }),
  );
  await lateCanceled.promise;
});

test("growth chunks preserve source/part identity while following serialized Discord mutation order", async () => {
  const f = fixture();
  f.post({ id: "earlier", role: "assistant", parts: [{ type: "text", text: "Earlier" }] });
  await f.settle();
  f.post({ id: "later", role: "assistant", parts: [{ type: "text", text: "Later" }] });
  await f.settle();
  f.store
    .updateSurfaceMessage("owner", f.thread.id, "earlier", {
      id: "earlier",
      role: "assistant",
      parts: [{ type: "text", text: "x".repeat(3000) }],
    })
    .unwrap();
  await f.settle();
  expect(f.requests.map((request) => request.method)).toEqual(["POST", "POST", "PATCH", "POST"]);
  expect(f.requests[2]?.payload.content).toContain("| earlier | 1]");
  expect(f.requests[3]?.payload.content).toContain("| earlier | 2]");
});

test("semantic receipts deduplicate new visible output and retry reset retracts its Discord copy", async () => {
  let turnId = "";
  let requestId = "";
  const f = fixture(undefined, (store, threadId) => {
    const input = store
      .acceptInput("owner", {
        threadId,
        commandId: "parent",
        historyGeneration: 0,
        text: "Parent",
        mode: "prompt",
        attachmentIds: [],
        skillIds: [],
      })
      .unwrap();
    turnId = input.turnId!;
    requestId = store.getInput(input.inputId).unwrap().requestId;
  });
  const event: NativeOutputEvent = {
    eventId: "visible-event",
    threadId: f.thread.id,
    generation: 0,
    requestId,
    turnId,
    attemptId: "attempt-one",
    sequence: 1,
    ordinal: 1,
    occurredAt: Date.now(),
    payload: {
      type: "text",
      partId: "part",
      stepId: "step",
      position: 0,
      phase: "final_answer",
      text: "Visible projected answer",
      incomplete: false,
    },
  };
  const project = (output: NativeOutputEvent) =>
    f.store
      .projectTurn(f.thread.id, 0, output.eventId, turnId, (slot, prior) =>
        Result.ok(projectNativeOutput(slot, output, prior)),
      )
      .unwrap();
  project(event);
  project(event);
  await f.settle();
  expect(f.requests).toHaveLength(1);
  project({
    ...event,
    eventId: "reset-event",
    ordinal: 2,
    sequence: 2,
    payload: { type: "reset", previousAttemptId: "attempt-one" },
  });
  await f.settle();
  expect(f.requests.map((request) => request.method)).toEqual(["POST", "DELETE"]);
});

test("duplicates, edits, chunk shrink and retry retractions use existing webhook messages", async () => {
  const f = fixture();
  const message: DisplayMessage = {
    id: "long",
    role: "assistant",
    parts: [{ type: "text", text: "a".repeat(4500) }],
  };
  f.post(message);
  f.post(message);
  await f.settle();
  expect(f.requests).toHaveLength(3);
  for (const request of f.requests)
    expect(String(request.payload.content).length).toBeLessThanOrEqual(2000);
  f.store
    .updateSurfaceMessage("owner", f.thread.id, "long", {
      ...message,
      parts: [{ type: "text", text: "Edited" }],
    })
    .unwrap();
  await f.settle();
  expect(f.requests.slice(3).map((request) => request.method)).toEqual([
    "PATCH",
    "DELETE",
    "DELETE",
  ]);
  f.store.updateSurfaceMessage("owner", f.thread.id, "long", null).unwrap();
  await f.settle();
  expect(f.requests.at(-1)?.method).toBe("DELETE");
});

test("HTTP deadline aborts a stalled request without delaying the next message", async () => {
  const f = fixture();
  const deadline = new AbortController();
  const timer = spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  const started = Promise.withResolvers<AbortSignal>();
  f.respond(
    (init) =>
      new Promise((_, reject) => {
        const signal = init.signal!;
        signal.addEventListener("abort", () => reject(new Error("private transport detail")), {
          once: true,
        });
        started.resolve(signal);
      }),
  );
  f.post({ id: "timeout", role: "assistant", parts: [{ type: "text", text: "Timeout" }] });
  const signal = await started.promise;
  deadline.abort();
  await f.settle();
  timer.mockRestore();
  expect(signal.aborted).toBe(true);
  f.respond(async () => Response.json({ id: "4444" }));
  f.post({
    id: "after-timeout",
    role: "assistant",
    parts: [
      { type: "text", text: "After" },
      { type: "text", text: " timeout" },
    ],
  });
  await f.settle();
  expect(f.requests.at(-1)?.payload.content).toContain("After timeout");
  expect(JSON.stringify(f.warnings)).not.toContain("private transport detail");
});

test("a stalled/failed webhook cannot block native writes and does not log its URL", async () => {
  const f = fixture();
  let release!: (response: Response) => void;
  let started!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.respond(
    () =>
      new Promise((resolve) => {
        release = resolve;
        started();
      }),
  );
  f.post({ id: "first", role: "assistant", parts: [{ type: "text", text: "First" }] });
  await requestStarted;
  f.post({ id: "second", role: "assistant", parts: [{ type: "text", text: "Second" }] });
  expect(f.store.readDisplayMessage("owner", f.thread.id, "second").unwrap().id).toBe("second");
  f.respond(async () => Response.json({ id: "9999" }));
  release(new Response("private response body", { status: 400 }));
  await f.settle();
  expect(f.requests.map((request) => String(request.payload.content))).toEqual([
    expect.stringContaining("First"),
    expect.stringContaining("Second"),
  ]);
  expect(f.warnings.length).toBeGreaterThan(0);
  expect(JSON.stringify(f.warnings)).not.toMatch(/test-only|https:|private response body/);
});
