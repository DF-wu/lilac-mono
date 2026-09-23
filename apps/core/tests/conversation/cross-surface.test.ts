import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Result } from "better-result";
import { parseCoreConfigV1ToUniversal } from "@stanley2058/lilac-utils";
import { NativeStore } from "../../src/surface/native/store";
import { NativeSearchStore } from "../../src/surface/native/store-search";
import { NativeSearchService } from "../../src/surface/native/search";
import { DiscordSearchStore } from "../../src/surface/store/discord-search-store";
import { ConversationThreadStore } from "../../src/conversation/thread-store";
import {
  ConversationThreadService,
  buildThreadSummaryModelMessages,
  createConversationThreadToolService,
  type ConversationThreadSummarizer,
  type ConversationThreadAttachmentHydrator,
} from "../../src/conversation/thread-service";
import { ConversationThread } from "../../src/tool-server/tools/conversation-thread";
import { maybeBuildAutoInjectedThreadSearchMessages } from "../../src/surface/bridge/bus-agent-runner";

let dir: string;
let db: Database;
let native: NativeStore;
let discord: DiscordSearchStore;
let index: ConversationThreadStore;
let service: ConversationThreadService;
let now: number;
let cfg: ReturnType<typeof parseCoreConfigV1ToUniversal>;
const aboutness = {
  domains: [],
  situations: [],
  targets: [],
  entities: [],
  userWouldAskForThisAs: [],
  intentSummary: "deployment",
};
let summarize: ConversationThreadSummarizer;
let hydrate: ConversationThreadAttachmentHydrator;
let duringEmbedding: (() => void) | undefined;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "lilac-cross-surface-"));
  now = Date.now() - 7_200_000;
  db = new Database(path.join(dir, "native.db"));
  native = new NativeStore(db, () => now);
  native.initialize().unwrap();
  for (const id of ["owner", "alice", "bob"])
    native
      .upsertUser({
        id,
        providerId: id,
        displayName: id,
        role: id === "owner" ? "owner" : "participant",
        toolMode: "full",
      })
      .unwrap();
  discord = new DiscordSearchStore(path.join(dir, "search.db"));
  index = new ConversationThreadStore(path.join(dir, "search.db"), {
    nativeDbPath: path.join(dir, "native.db"),
  });
  cfg = parseCoreConfigV1ToUniversal({
    surface: { discord: { botName: "lilac", allowedChannelIds: ["c1"] } },
  });
  summarize = async (input) => ({
    title: "deployment",
    brief: input.messages.map((m) => m.text).join(" "),
    topics: ["deployment"],
  });
  duringEmbedding = undefined;
  hydrate = async () => Result.ok([]);
  service = new ConversationThreadService({
    store: index,
    getConfig: async () => cfg,
    summarizer: (input) => summarize(input),
    attachmentHydrator: (input) => hydrate(input),
    getEmbeddingAdapter: async () => ({
      modelId: "test",
      dimensions: 2,
      embed: async () => {
        duringEmbedding?.();
        duringEmbedding = undefined;
        return new Float32Array([1, 0]);
      },
    }),
    queryAboutnessSummarizer: async () => aboutness,
    autoInjectQueryPlanner: async () => ({ searches: [{ queries: ["deployment"], aboutness }] }),
  });
});
afterEach(async () => {
  index.close();
  discord.close();
  db.close();
  await rm(dir, { recursive: true, force: true });
});
function createNative(userId = "alice", text = "deployment native") {
  const thread = native.createThread(userId, { commandId: crypto.randomUUID() }).unwrap();
  const receipt = native
    .acceptInput(userId, {
      threadId: thread.id,
      commandId: crypto.randomUUID(),
      historyGeneration: 0,
      mode: "prompt",
      text,
      attachmentIds: [],
      skillIds: [],
    })
    .unwrap();
  native.settleInput(receipt.inputId, "admitted").unwrap();
  native
    .projectTurn(thread.id, 0, crypto.randomUUID(), receipt.turnId!, (slot) =>
      Result.ok({
        slot: {
          ...slot,
          state: "complete",
          messages: [
            ...slot.messages,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              parts: [{ type: "text", text: "deployment answer" }],
            },
          ],
        },
        changes: [],
      }),
    )
    .unwrap();
  native.markInputCompleted(receipt.inputId).unwrap();
  return { id: thread.id, ref: `native:${thread.id}`, turnId: receipt.turnId!, userId };
}
function createDiscord(channelId = "c1") {
  for (const [id, text] of [
    ["1", "deployment discord"],
    ["2", "deployment answer"],
  ])
    discord.upsertMessages([
      {
        ref: { platform: "discord", channelId, messageId: id! },
        session: { platform: "discord", channelId },
        userId: id === "1" ? "discord-user" : "bot",
        userName: id === "1" ? "User" : "lilac",
        text: text!,
        ts: now + (id === "1" ? 0 : 1),
        attachments: [],
      },
    ]);
  index.refreshInferredChannel({ channelId });
  return `discord:channel:${channelId}:1`;
}
function toolsForNative() {
  const shared = createConversationThreadToolService(service);
  const search = new NativeSearchService({
    store: native,
    searchStore: new NativeSearchStore({ db, store: native }),
    conversationThreads: shared,
  });
  return {
    shared,
    search,
    tool: new ConversationThread({ service: shared, nativeSearch: search }),
  };
}
function removeThread(item: ReturnType<typeof createNative>) {
  const mutation = native
    .deleteThread(item.userId, { threadId: item.id, commandId: crypto.randomUUID() })
    .unwrap();
  native.finishMutation(item.id, mutation.historyGeneration!).unwrap();
}
test("both origins search one hybrid index and read globally without changing native grants", async () => {
  const alice = createNative();
  const bob = createNative("bob");
  const d = createDiscord();
  createDiscord("denied");
  const refreshed = await service.runSummarization({ now: Date.now() });
  expect(refreshed.failed).toBe(0);
  expect(refreshed.summarized).toBe(4);
  const { tool } = toolsForNative();
  const discordResults = (
    await tool.call("conversation.thread.search", { query: "deployment", mode: "hybrid" })
  ).unwrap();
  const context = {
    serverOwnedRequest: true,
    requestClient: "native" as const,
    requestInitiator: { platform: "native" as const, userId: "alice" },
    requestInitiatorSessionId: alice.id,
  };
  const nativeResults = (
    await tool.call(
      "conversation.thread.search",
      { query: "deployment", mode: "hybrid" },
      { context },
    )
  ).unwrap();
  expect(nativeResults).toEqual(discordResults);
  expect(nativeResults).toMatchObject({
    meta: { vectorAvailable: true },
    results: expect.arrayContaining([
      {
        threadId: alice.ref,
        surface: "native",
        title: "deployment",
        brief: "deployment native deployment answer",
      },
      {
        threadId: d,
        surface: "discord",
        title: "deployment",
        brief: "deployment discord deployment answer",
      },
    ]),
  });
  const read = (
    await tool.call("conversation.thread.read", { threadId: bob.ref, limit: 1 }, { context })
  ).unwrap();
  expect(read).toMatchObject({
    thread: { surface: "native", threadId: bob.ref },
    page: { total: 2, hasMore: true, nextOffset: 1 },
  });
  expect(native.authorizeThread("alice", bob.id, true).isErr()).toBe(true);
  expect((await service.metadata({ threadIds: [bob.ref, d, "missing"] })).unwrap().missing).toEqual(
    ["missing"],
  );
  for (const surface of ["native", "discord"] as const) {
    const result = (
      await service.search({ query: "deployment", surface, mode: "semantic" })
    ).unwrap();
    expect(result.results.length).toBe(surface === "native" ? 2 : 1);
    expect(result.results.every((hit) => hit.surface === surface)).toBe(true);
  }
});
test("automatic recall carries both surfaces and does not apply origin IDs to other surfaces", async () => {
  const n = createNative();
  const d = createDiscord();
  await service.runSummarization({ now: Date.now() });
  const { search } = toolsForNative();
  cfg.conversation.thread.autoInject.enabled = true;
  cfg.conversation.thread.autoInject.minTextUnits = 1;
  cfg.conversation.thread.autoInject.expansionMinConfidence = 0;
  cfg.conversation.thread.autoInject.filterCurrentParticipants = true;
  const output = await maybeBuildAutoInjectedThreadSearchMessages({
    cfg,
    surface: "native",
    conversationThreads: search.forThread(n.id),
    requestId: "recall",
    userMessages: [{ role: "user", content: "Please recall our deployment discussion" }],
    publishToolStatus: async () => {},
    onError: (_message, error) => {
      throw new Error(JSON.stringify(error));
    },
  });
  const serialized = JSON.stringify(output);
  expect(serialized).toContain('"surface":"native"');
  expect(serialized).toContain('"surface":"discord"');
  expect(serialized).toContain(n.ref);
  expect(serialized).toContain(d);
  const filtered = (
    await service.search({
      query: "deployment",
      participantIdsAny: ["alice"],
      participantSurface: "native",
      mode: "lexical",
    })
  ).unwrap();
  expect(filtered.results.map((r) => r.threadId).sort()).toEqual([n.ref, d].sort());
});
test("native revisions discard removed text, pending rewind and deletion disappear immediately", async () => {
  const item = createNative();
  await service.runSummarization({ now: Date.now() });
  const current = native.getThreadRecord(item.id).unwrap();
  native
    .beginRewind("alice", {
      threadId: item.id,
      commandId: "rewind",
      turnId: item.turnId,
      revision: current.revision,
      historyGeneration: 0,
    })
    .unwrap();
  expect((await service.search({ query: "deployment", mode: "lexical" })).unwrap().results).toEqual(
    [],
  );
  expect((await service.read({ threadId: item.ref })).isErr()).toBe(true);
  native.finishMutation(item.id, 1).unwrap();
  const removed = createNative("bob");
  await service.runSummarization({ now: Date.now() });
  removeThread(removed);
  expect((await service.metadata({ threadIds: [removed.ref] })).unwrap().missing).toEqual([
    removed.ref,
  ]);
  expect(index.getSummary(removed.ref).unwrap()).toBeNull();
  expect(await service.getAutoInjectRankingCorpusDocuments()).toEqual([]);
});
test("a concurrent source change cannot publish a stale summary or embedding", async () => {
  const item = createNative();
  summarize = async () => {
    removeThread(item);
    return { title: "removed", brief: "private old text", topics: [] };
  };
  expect((await service.runSummarization({ now: Date.now() })).summarized).toBe(0);
  expect(index.getSummary(item.ref).unwrap()).toBeNull();
  const other = createNative("bob");
  summarize = async () => ({ title: "deployment", brief: "deployment", topics: [] });
  duringEmbedding = () => removeThread(other);
  await service.runSummarization({ now: Date.now() });
  expect(
    (await service.search({ query: "deployment", mode: "semantic" })).unwrap().results,
  ).toEqual([]);
  expect(index.getSummary(other.ref).unwrap()).toBeNull();
});
test("native active runs wait for quiet completion and maintenance options use canonical IDs", async () => {
  const item = createNative();
  native.setActiveRun(item.id, 0, "active").unwrap();
  expect((await service.runSummarization({ force: true, now: Date.now() })).eligible).toBe(0);
  native.setActiveRun(item.id, 0).unwrap();
  const dry = await service.runSummarization({ dryRun: true, threadId: item.ref, now: Date.now() });
  expect(dry.threadIds).toEqual([item.ref]);
  expect((await service.runSummarization({ threadId: item.ref, now: Date.now() })).summarized).toBe(
    1,
  );
  expect((await service.runSummarization({ dryRun: true, now: Date.now() })).eligible).toBe(0);
  expect(
    (await service.runSummarization({ clear: true, dryRun: true, threadId: item.ref })).cleared,
  ).toBe(0);
  expect(index.getSummary(item.ref).unwrap()).not.toBeNull();
  expect(
    (await service.runSummarization({ clear: true, threadId: item.ref, now: Date.now() }))
      .summarized,
  ).toBe(1);
});

test("non-content changes preserve recall while message edits remove old summaries", async () => {
  const item = createNative();
  await service.runSummarization({ now: Date.now() });
  const previous = index.getSummary(item.ref).unwrap();
  native
    .updateThread("alice", {
      threadId: item.id,
      commandId: "settings",
      title: "renamed",
      archived: true,
      modelId: "new-model",
    })
    .unwrap();
  native.shareThread("owner", { threadId: item.id, userId: "bob", grant: "read" }).unwrap();
  native.shareThread("owner", { threadId: item.id, userId: "bob", grant: null }).unwrap();
  expect(
    (await service.search({ query: "deployment", mode: "hybrid" })).unwrap().results,
  ).toHaveLength(1);
  expect(index.getSummary(item.ref).unwrap()).toEqual(previous);
  expect((await service.runSummarization({ dryRun: true, now: Date.now() })).eligible).toBe(0);
  const message = index.listMessages(item.ref)[0]!;
  native
    .updateSurfaceMessage("alice", item.id, message.messageId, {
      id: message.messageId,
      role: "user",
      parts: [{ type: "text", text: "replacement text" }],
    })
    .unwrap();
  expect((await service.search({ query: "deployment", mode: "lexical" })).unwrap().results).toEqual(
    [],
  );
  expect(index.getSummary(item.ref).unwrap()).toBeNull();
});

test("invalid native persisted versions and fields fail before summarization", async () => {
  const item = createNative();
  db.run("UPDATE native_records SET format_version=99 WHERE id=?", [item.id]);
  await expect(service.search({ query: "deployment" })).rejects.toMatchObject({
    _tag: "UnsupportedVersion",
  });
  db.run("UPDATE native_records SET format_version=1 WHERE id=?", [item.id]);
  db.run(
    "UPDATE native_records SET data_json=json_set(data_json,'$.value.messages[0].id',null) WHERE kind='turn' AND thread_id=?",
    [item.id],
  );
  await expect(service.runSummarization({ now: Date.now() })).rejects.toMatchObject({
    _tag: "CorruptPersistedFields",
  });
});

test("quiet timing uses the latest turn and excludes ephemeral conversations", async () => {
  const old = now;
  const item = createNative();
  now = Date.now();
  native
    .postMessage("alice", item.id, {
      id: "recent",
      role: "assistant",
      parts: [{ type: "text", text: "A recent answer without an explicit timestamp" }],
    })
    .unwrap();
  expect((await service.runSummarization({ now, force: true })).eligible).toBe(0);
  const transient = native
    .createThread("alice", { commandId: "ephemeral", ephemeralSessionId: crypto.randomUUID() })
    .unwrap();
  native
    .postMessage("alice", transient.id, {
      id: "temp",
      role: "user",
      parts: [{ type: "text", text: "deployment transient" }],
    })
    .unwrap();
  expect(
    (await service.metadata({ threadIds: [`native:${transient.id}`] })).unwrap().missing,
  ).toEqual([`native:${transient.id}`]);
  now = old;
});

test("attachment-only native and Discord messages feed identical bytes to summary models", async () => {
  const item = createNative();
  const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const upload = native
    .reserveUpload("alice", {
      threadId: item.id,
      filename: "diagram.png",
      mediaType: "image/png",
      size: bytes.length,
    })
    .unwrap();
  native
    .settleUpload(upload.id, {
      attempt: 0,
      historyGeneration: 0,
      state: "ready",
      resourceUri: "resource://r1_image",
    })
    .unwrap();
  const attachment = {
    id: upload.id,
    filename: "diagram.png",
    mimeType: "image/png",
    size: bytes.length,
  };
  native
    .postMessage("alice", item.id, {
      id: "native-image",
      role: "user",
      parts: [
        {
          type: "data-resource",
          id: "part",
          data: {
            resourceId: upload.id,
            name: "diagram.png",
            mediaType: "image/png",
            size: bytes.length,
            state: "ready",
          },
        },
      ],
    })
    .unwrap();
  createDiscord();
  discord.upsertMessages([
    {
      ref: { platform: "discord", channelId: "c1", messageId: "1" },
      session: { platform: "discord", channelId: "c1" },
      userId: "discord-user",
      text: "",
      ts: now,
      raw: { attachments: [{ ...attachment, url: "https://cdn.discordapp.com/diagram.png" }] },
    },
  ]);
  index.refreshInferredChannel({ channelId: "c1" });
  const surfaces: string[] = [];
  hydrate = async ({ refs }) =>
    Result.ok(
      refs.map((ref) => {
        surfaces.push(ref.surface ?? "discord");
        return {
          ref,
          attachments: [
            {
              ...attachment,
              url:
                ref.surface === "native"
                  ? "resource://r1_image"
                  : "https://cdn.discordapp.com/diagram.png",
              data: bytes,
            },
          ],
        };
      }),
    );
  let files = 0;
  summarize = async (input) => {
    const messages = await buildThreadSummaryModelMessages({
      previous: "",
      promptContextSection: null,
      messages: input.messages,
      omittedMessages: 0,
    });
    const content = messages[0]!.content;
    if (typeof content !== "string")
      for (const part of content) {
        if (part.type !== "file") continue;
        expect(part.data).toEqual(bytes);
        files++;
      }
    return { title: "diagram", brief: "Image-aware summary", topics: [] };
  };
  const result = await service.runSummarization({ now: Date.now() });
  expect(result.failed).toBe(0);
  expect(files).toBe(2);
  expect(surfaces.sort()).toEqual(["discord", "native"]);
});
