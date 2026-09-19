import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import {
  bootstrapReplySchema,
  nativeUserSchema,
  threadEventSchema,
  type NativeRpcInputs,
} from "@stanley2058/lilac-client-protocol";
import type { NativeAuthenticator, NativePrincipal } from "./auth";
import { authFailure } from "./auth";
import { NativeConfigService } from "./config-service";
import { nativeFailure } from "./errors";
import { createNativeRpcServices } from "./rpc-services";
import { NativeStore } from "./store";
import { NativeSurfaceStore } from "./store-surface";
import { NativeSearchStore } from "./store-search";

const principal: NativePrincipal = {
  userId: "owner",
  providerUserId: "owner_provider",
  provider: "local",
  expiresAt: Number.MAX_SAFE_INTEGER,
  sessionId: "session",
};
const reader: NativePrincipal = {
  ...principal,
  userId: "reader",
  providerUserId: "reader_provider",
  provider: "clerk",
};

function fixture() {
  const db = new Database(":memory:");
  const store = new NativeStore(db);
  store.initialize().unwrap();
  store
    .upsertUser({
      id: "owner",
      providerId: "owner_provider",
      displayName: "Owner",
      role: "owner",
      toolMode: "full",
    })
    .unwrap();
  store
    .upsertUser({
      id: "reader",
      providerId: "reader_provider",
      displayName: "Reader",
      role: "participant",
      toolMode: "restricted",
    })
    .unwrap();
  const surface = new NativeSurfaceStore(db, store);
  surface.initialize().unwrap();
  const auth: NativeAuthenticator = {
    checkSession: () => Result.ok(),
    authenticate: async () => Result.ok(principal),
    reauthenticate: async () => Result.ok(principal),
    logout: async () => Result.ok({ setCookie: "" }),
  };
  const catalogListeners = new Set<() => void>();
  let catalogRevision = "catalog_1";
  let modelAvailable = true;
  let modelResolutions = 0;
  let kickCalls = 0;
  const services = createNativeRpcServices({
    store,
    auth,
    resolveModel: () => {
      modelResolutions += 1;
      if (!modelAvailable) return Result.err(nativeFailure("invalid", "Model removed"));
      return Result.ok({
        spec: "openai/gpt-5",
        provider: "openai",
        modelId: "gpt-5",
        reasoningDisplay: "detailed",
      });
    },
    installationId: "fixture",
    surface,
    catalogs: {
      subscribe: (listener) => {
        catalogListeners.add(listener);
        return () => {
          catalogListeners.delete(listener);
        };
      },
      get: (_scope, revision) =>
        revision === catalogRevision
          ? { kind: "unchanged", revision }
          : {
              kind: "catalog",
              catalog: {
                revision: catalogRevision,
                models: modelAvailable ? [{ id: "configured", label: "Configured" }] : [],
                commands: [
                  { id: "custom:review", name: "review", description: "Review", kind: "custom" },
                ],
                skills: [],
              },
            },
    },
    config: new NativeConfigService({
      dataDir: "/unused",
      ownerId: "owner",
      registry: { reload: async () => Result.ok([]) },
    }),
    execution: {
      kick: async () => {
        kickCalls += 1;
        return Result.err(nativeFailure("conflict", "Canonical history unavailable"));
      },
      cancel: async () => Result.ok(),
      deleteThread: async () => Result.ok(),
      rewind: async () => Result.err(nativeFailure("invalid", "Not used")),
    },
    resources: { reserve: (actor, input) => store.reserveUpload(actor, input) },
    search: new NativeSearchStore({ db, store }),
    external: {
      list: async () => Result.ok({ items: [] }),
      read: async () => Result.err(nativeFailure("not-found", "Unavailable")),
    },
  });
  const thread = store.createThread("owner", { commandId: "create", title: "Thread" }).unwrap();
  return {
    store,
    services,
    thread,
    auth,
    kickCalls: () => kickCalls,
    modelResolutions: () => modelResolutions,
    removeModel() {
      modelAvailable = false;
    },
    updateCatalog() {
      catalogRevision = "catalog_2";
      for (const listener of catalogListeners) listener();
    },
    [Symbol.dispose]() {
      store.close();
    },
  };
}

describe("native RPC service projection", () => {
  test("selected summary reads archived threads without disclosing inaccessible threads", async () => {
    using state = fixture();
    state.store
      .updateThread("owner", {
        threadId: state.thread.id,
        commandId: "archive",
        archived: true,
      })
      .unwrap();
    const input = { threadId: state.thread.id };
    const archived = (await state.services.threads.get(principal, input)).unwrap();
    expect(archived.archived).toBe(true);
    expect(archived.id).toBe(state.thread.id);
    expect((await state.services.threads.get(reader, input)).isErr()).toBe(true);
    state.store
      .shareThread("owner", {
        threadId: state.thread.id,
        userId: "reader",
        grant: "read",
      })
      .unwrap();
    expect((await state.services.threads.get(reader, input)).unwrap().capabilities.edit).toBe(
      false,
    );
    state.auth.checkSession = () => Result.err(authFailure("expired", "Session expired"));
    expect((await state.services.threads.get(principal, input)).isErr()).toBe(true);
  });

  test("bootstrap carries authorized display data and unchanged checkpoints without provider IDs", async () => {
    using state = fixture();
    const initial = (
      await state.services.bootstrap.get(principal, { threadId: state.thread.id })
    ).unwrap();
    expect(bootstrapReplySchema.safeParse(initial).success).toBe(true);
    expect(initial.viewer).not.toHaveProperty("providerId");
    expect(initial.threads.items.map((thread) => thread.id)).toEqual([state.thread.id]);
    const unchanged = (
      await state.services.bootstrap.get(principal, {
        threadId: state.thread.id,
        checkpoint: initial.selectedThread!.checkpoint,
        catalogRevision: "catalog_1",
      })
    ).unwrap();
    expect(unchanged.selectedThread?.kind).toBe("unchanged");
    expect(unchanged.catalog.kind).toBe("unchanged");
    const hidden = (await state.services.bootstrap.get(reader, {})).unwrap();
    expect(hidden.threads.items).toEqual([]);
    const unavailable = (
      await state.services.bootstrap.get(reader, { threadId: state.thread.id })
    ).unwrap();
    expect(unavailable.selectedThreadUnavailable).toBe(true);
    expect(unavailable.selectedThread).toBeUndefined();
  });

  test("uncached catch-up returns recent turns and a deferred range", async () => {
    using state = fixture();
    for (let index = 0; index < 9; index += 1) {
      const input = state.store
        .acceptInput("owner", {
          threadId: state.thread.id,
          commandId: `prompt_${index}`,
          historyGeneration: 0,
          text: `turn ${index}`,
          mode: "prompt",
          attachmentIds: [],
          skillIds: [],
        })
        .unwrap();
      state.store.settleInput(input.inputId, "admitted").unwrap();
      state.store.markInputCompleted(input.inputId).unwrap();
    }
    const controller = new AbortController();
    const stream = (
      await state.services.threads.watch(
        principal,
        { threadId: state.thread.id },
        controller.signal,
      )
    ).unwrap();
    const first = await stream.next();
    expect(first.done).toBe(false);
    expect(threadEventSchema.safeParse(first.value).success).toBe(true);
    if (first.value?.kind !== "replay" || first.value.reply.kind !== "window")
      throw new Error("Expected a window replay");
    const slots = first.value.reply.slots;
    expect(slots[0]?.kind).toBe("deferred");
    expect(slots.at(-1)?.kind).toBe("ready");
    expect(JSON.stringify(slots.at(-1))).toContain("turn 8");
    controller.abort();
    expect((await stream.next()).done).toBe(true);
  });

  test("revocation during a suspended replay prevents the following summary from leaking", async () => {
    using state = fixture();
    state.store
      .shareThread("owner", { threadId: state.thread.id, userId: "reader", grant: "read" })
      .unwrap();
    const controller = new AbortController();
    const stream = (
      await state.services.threads.watch(reader, { threadId: state.thread.id }, controller.signal)
    ).unwrap();
    expect((await stream.next()).value?.kind).toBe("replay");
    const next = stream.next();
    state.store
      .updateThread("owner", { threadId: state.thread.id, commandId: "rename", title: "Changed" })
      .unwrap();
    expect((await next).value?.kind).toBe("replay");
    state.store
      .shareThread("owner", { threadId: state.thread.id, userId: "reader", grant: null })
      .unwrap();
    expect((await stream.next()).value).toEqual({ kind: "revoked" });
    expect((await stream.next()).done).toBe(true);
    controller.abort();
  });

  test("uploading input is accepted immediately and only exposes display resource metadata", async () => {
    using state = fixture();
    const resource = (
      await state.services.resources.reserve(principal, {
        threadId: state.thread.id,
        commandId: "reserve",
        name: "image.png",
        mediaType: "image/png",
        size: 1_000_000,
      })
    ).unwrap();
    expect(resource.state).toBe("pending");
    expect(resource).not.toHaveProperty("uri");
    const receipt = (
      await state.services.inputs.submit(principal, {
        threadId: state.thread.id,
        commandId: "upload_input",
        historyGeneration: 0,
        text: "Inspect this",
        mode: "prompt",
        attachmentIds: [resource.id],
        skillIds: [],
      })
    ).unwrap();
    expect(receipt.state).toBe("uploading");
    expect(state.store.getInput(receipt.inputId).unwrap().state).toBe("uploading");
    expect(state.store.getInput(receipt.inputId).unwrap().resolvedModelRequest?.spec).toBe(
      "openai/gpt-5",
    );
    const queue = (
      await state.services.runs.queue(principal, { threadId: state.thread.id })
    ).unwrap();
    expect(queue.items[0]?.inputId).toBe(receipt.inputId);
  });

  test("submit acknowledges the committed intent without waiting for execution", async () => {
    using state = fixture();
    const receipt = (
      await state.services.inputs.submit(principal, {
        threadId: state.thread.id,
        commandId: "committed",
        historyGeneration: 0,
        text: "Hello",
        mode: "prompt",
        attachmentIds: [],
        skillIds: [],
      })
    ).unwrap();
    expect(receipt.state).toBe("queued");
    expect(state.store.getInput(receipt.inputId).unwrap().text).toBe("Hello");
    expect(state.kickCalls()).toBe(0);
  });

  test("submit retries return the committed receipt before current catalog and model checks", async () => {
    using state = fixture();
    const input: NativeRpcInputs["inputs"]["submit"] = {
      threadId: state.thread.id,
      commandId: "retried",
      historyGeneration: 0,
      text: "Hello",
      mode: "prompt",
      attachmentIds: [],
      skillIds: [],
      modelId: "configured",
    };
    const first = (await state.services.inputs.submit(principal, input)).unwrap();
    state.removeModel();
    const retry = (await state.services.inputs.submit(principal, input)).unwrap();
    expect(retry).toEqual(first);
    expect(state.modelResolutions()).toBe(1);
    expect(state.store.listPendingInputs(state.thread.id).unwrap()).toHaveLength(1);
    expect(
      (await state.services.inputs.submit(principal, { ...input, text: "Changed" })).isErr(),
    ).toBe(true);
    expect(
      (await state.services.inputs.submit(principal, { ...input, commandId: "new" })).isErr(),
    ).toBe(true);
    expect(state.store.listPendingInputs(state.thread.id).unwrap()).toHaveLength(1);
  });

  test.each(["steer", "prompt"] as const)(
    "active custom %s queues a full follow-up with a fresh model and unchanged retry fingerprint",
    async (mode) => {
      using state = fixture();
      const initial = state.store
        .acceptInput(
          "owner",
          {
            threadId: state.thread.id,
            commandId: "initial",
            historyGeneration: 0,
            text: "initial",
            mode: "prompt",
            attachmentIds: [],
            skillIds: [],
          },
          {
            resolvedModelRequest: {
              spec: "openai/old-model",
              provider: "openai",
              modelId: "old-model",
              reasoningDisplay: "detailed",
            },
          },
        )
        .unwrap();
      const active = state.store.prepareInput(initial.inputId).unwrap()!;
      state.store.settleInput(active.id, "admitted").unwrap();
      state.store.setActiveRun(state.thread.id, 0, active.requestId).unwrap();
      const input: NativeRpcInputs["inputs"]["submit"] = {
        threadId: state.thread.id,
        commandId: "custom-steer",
        historyGeneration: 0,
        text: "/review changes",
        mode,
        command: { id: "custom:review", arguments: "changes" },
        attachmentIds: [],
        skillIds: [],
      };
      const receipt = (await state.services.inputs.submit(principal, input)).unwrap();
      const stored = state.store.getInput(receipt.inputId).unwrap();
      expect(stored.mode).toBe("followup");
      expect(stored.turnId).toBeUndefined();
      expect(stored.requestId).not.toBe(active.requestId);
      expect(stored.resolvedModelRequest?.spec).toBe("openai/gpt-5");
      expect(state.store.prepareInput(stored.id).unwrap()).toBeNull();
      state.removeModel();
      expect((await state.services.inputs.submit(principal, input)).unwrap()).toEqual(receipt);
      expect(state.modelResolutions()).toBe(1);
      expect(
        (await state.services.inputs.submit(principal, { ...input, mode: "followup" })).isErr(),
      ).toBe(true);
      state.store.cancelRun("owner", state.thread.id, active.requestId).unwrap();
      expect(state.store.getInput(receipt.inputId).unwrap().state).toBe("canceled");
    },
  );

  test("model validation happens before creating persistent input", async () => {
    using state = fixture();
    expect(
      (
        await state.services.threads.create(principal, {
          commandId: "bad_model",
          title: "Invalid",
          modelId: "arbitrary-provider-model",
        })
      ).isErr(),
    ).toBe(true);
    expect(state.store.listThreads("owner").unwrap()).toHaveLength(1);
    const invalid = await state.services.inputs.submit(principal, {
      threadId: state.thread.id,
      commandId: "bad_input",
      historyGeneration: 0,
      text: "Hello",
      mode: "prompt",
      attachmentIds: [],
      skillIds: [],
      modelId: "arbitrary-provider-model",
    });
    expect(invalid.isErr()).toBe(true);
    expect(state.store.listPendingInputs(state.thread.id).unwrap()).toEqual([]);
  });

  test("expired session ends an existing watch before another projection", async () => {
    using state = fixture();
    const controller = new AbortController();
    const stream = (
      await state.services.threads.watch(
        principal,
        { threadId: state.thread.id },
        controller.signal,
      )
    ).unwrap();
    await stream.next();
    state.auth.checkSession = () => Result.err(authFailure("expired", "Expired"));
    state.store
      .updateThread("owner", {
        threadId: state.thread.id,
        commandId: "expired_rename",
        title: "Changed",
      })
      .unwrap();
    expect((await stream.next()).value).toEqual({ kind: "revoked" });
    controller.abort();
  });

  test("catalog watcher coalesces a large burst and emits static catalog invalidation", async () => {
    using state = fixture();
    const bootstrap = (await state.services.bootstrap.get(principal, {})).unwrap();
    const controller = new AbortController();
    const stream = (
      await state.services.bootstrap.watch(
        principal,
        { cursor: bootstrap.catalogCursor },
        controller.signal,
      )
    ).unwrap();
    const first = stream.next();
    for (let index = 0; index < 105; index += 1)
      state.store
        .createThread("owner", { commandId: `burst_${index}`, title: `Thread ${index}` })
        .unwrap();
    expect((await first).value?.kind).toBe("resync");
    const next = stream.next();
    state.updateCatalog();
    expect((await next).value).toMatchObject({
      kind: "catalog-invalidated",
      revision: "catalog_2",
    });
    controller.abort();
    await stream.return();
  });

  test("direct-link bootstrap includes selected thread capabilities outside the first page", async () => {
    using state = fixture();
    for (let index = 0; index < 35; index += 1)
      state.store
        .createThread("owner", { commandId: `page_${index}`, title: `Thread ${index}` })
        .unwrap();
    const reply = (
      await state.services.bootstrap.get(principal, { threadId: state.thread.id })
    ).unwrap();
    expect(
      reply.threads.items.find((thread) => thread.id === state.thread.id)?.capabilities.edit,
    ).toBe(true);
    expect(reply.threads.nextCursor).toBeDefined();
    expect(reply.selectedThread).toBeDefined();
  });

  test("reaction state is personalized for each authorized viewer", async () => {
    using state = fixture();
    state.store
      .shareThread("owner", { threadId: state.thread.id, userId: "reader", grant: "read" })
      .unwrap();
    const input = state.store
      .acceptInput("owner", {
        threadId: state.thread.id,
        commandId: "reaction_input",
        historyGeneration: 0,
        text: "Hello",
        mode: "prompt",
        attachmentIds: [],
        skillIds: [],
      })
      .unwrap();
    (
      await state.services.reactions.set(principal, {
        threadId: state.thread.id,
        messageId: input.messageId,
        emoji: "👍",
        active: true,
      })
    ).unwrap();
    const ownerReply = (
      await state.services.threads.sync(principal, { threadId: state.thread.id })
    ).unwrap();
    const readerReply = (
      await state.services.threads.sync(reader, { threadId: state.thread.id })
    ).unwrap();
    expect(JSON.stringify(ownerReply)).toContain('"reacted":true');
    expect(JSON.stringify(readerReply)).toContain('"reacted":false');
  });

  test("live receipt hydration uses the latest state and output updates omit unchanged thread metadata", async () => {
    using state = fixture();
    const input = state.store
      .acceptInput("owner", {
        threadId: state.thread.id,
        commandId: "receipt_input",
        historyGeneration: 0,
        text: "Hello",
        mode: "prompt",
        attachmentIds: [],
        skillIds: [],
      })
      .unwrap();
    const controller = new AbortController();
    const stream = (
      await state.services.threads.watch(
        principal,
        { threadId: state.thread.id },
        controller.signal,
      )
    ).unwrap();
    expect((await stream.next()).value?.kind).toBe("replay");
    state.store.settleInput(input.inputId, "admitted").unwrap();
    expect((await stream.next()).value).toMatchObject({
      kind: "input",
      receipt: { inputId: input.inputId, state: "admitted" },
    });
    state.store
      .appendMessage(state.thread.id, 0, input.turnId!, {
        id: "output",
        role: "assistant",
        parts: [{ type: "text", text: "Answer" }],
      })
      .unwrap();
    expect((await stream.next()).value?.kind).toBe("replay");
    const completed = stream.next();
    controller.abort();
    expect((await completed).done).toBe(true);
  });

  test("unchanged cached watch sends only the replay ACK", async () => {
    using state = fixture();
    state.store
      .acceptInput("owner", {
        threadId: state.thread.id,
        commandId: "cached_input",
        historyGeneration: 0,
        text: "Hello",
        mode: "prompt",
        attachmentIds: [],
        skillIds: [],
      })
      .unwrap();
    const checkpoint = state.store.sync("owner", state.thread.id).unwrap().checkpoint;
    const controller = new AbortController();
    const stream = (
      await state.services.threads.watch(
        principal,
        { threadId: state.thread.id, checkpoint },
        controller.signal,
      )
    ).unwrap();
    const first = await stream.next();
    expect(first.value).toMatchObject({ kind: "replay", reply: { kind: "unchanged" } });
    expect(new TextEncoder().encode(JSON.stringify(first.value)).length).toBeLessThan(1024);
    const completed = stream.next();
    controller.abort();
    expect((await completed).done).toBe(true);
  });
});

test("user and participant RPC projections never expose stored avatar blobs", async () => {
  using state = fixture();
  state.store
    .upsertUser({
      id: "lilac",
      providerId: "service:lilac",
      displayName: "Garden",
      role: "service",
      toolMode: "full",
      avatar: {
        mediaType: "image/png",
        blob: {
          version: 1,
          objectId: `b1_${"a".repeat(32)}`,
          sha256: "b".repeat(64),
          byteLength: 42,
        },
      },
    })
    .unwrap();
  const directory = (await state.services.users.list(principal, { limit: 30 })).unwrap();
  const participants = (
    await state.services.participants.list(principal, { threadId: state.thread.id })
  ).unwrap();
  for (const user of [...directory.items, ...participants.items.map((entry) => entry.user)]) {
    expect(nativeUserSchema.safeParse(user).success).toBe(true);
    expect(user).not.toHaveProperty("avatar");
    expect(user).not.toHaveProperty("providerId");
  }
  expect(
    (await state.services.identity.update(principal, { displayName: "Lily" })).unwrap(),
  ).toMatchObject({
    id: "lilac",
    displayName: "Lily",
    avatarUrl: expect.stringContaining("/api/identity/avatar"),
  });
  expect((await state.services.identity.update(reader, { displayName: "Changed" })).isErr()).toBe(
    true,
  );
});
