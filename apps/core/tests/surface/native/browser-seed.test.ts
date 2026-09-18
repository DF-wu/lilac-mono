import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { replayReplySchema } from "@stanley2058/lilac-client-protocol";
import { SqliteTranscriptStore } from "../../../src/transcript/transcript-store";
import { NativeStore } from "../../../src/surface/native/store";
import { seedNativeBrowserFixture } from "./browser-seed";

describe("native browser fixture seeding", () => {
  test("creates completed full turns, bounded replay, rich content, and an uploading input", () => {
    using db = new Database(":memory:");
    const store = new NativeStore(db);
    store.initialize().unwrap();
    store
      .upsertUser({
        id: "owner",
        providerId: "owner",
        displayName: "Owner",
        role: "owner",
        toolMode: "full",
      })
      .unwrap();
    const transcript = new SqliteTranscriptStore(":memory:");
    const threads = seedNativeBrowserFixture(store, {
      historyTurns: 12,
      sidebarThreads: 2,
      transcript,
    });
    const canonicalId = store.getLatestCanonicalRequestId(threads.history).unwrap();
    expect(canonicalId).toBeDefined();
    expect(
      transcript.getRequestTranscript({ requestId: canonicalId! }).unwrap()?.messages,
    ).toHaveLength(24);
    const history = store.sync("owner", threads.history).unwrap();
    expect(replayReplySchema.safeParse(history).success).toBe(true);
    expect(history.kind).toBe("window");
    if (history.kind !== "window") throw new Error("Expected a fixture window");
    expect(history.slots[0]?.kind).toBe("deferred");
    expect(history.slots.at(-1)?.kind).toBe("ready");
    expect(JSON.stringify(history)).toContain("Checkpoint **12**");
    const rich = store.sync("owner", threads.rich).unwrap();
    expect(replayReplySchema.safeParse(rich).success).toBe(true);
    expect(JSON.stringify(rich)).toContain("mermaid");
    expect(JSON.stringify(rich)).toContain("typescript");
    const large = store.sync("owner", threads.largeTurn).unwrap();
    expect(replayReplySchema.safeParse(large).success).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(large)).byteLength).toBeLessThan(262_144);
    const pending = store.listPendingInputs().unwrap();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.threadId).toBe(threads.uploads);
    expect(pending[0]?.state).toBe("uploading");
    expect(store.getThread("participant", threads.rich).unwrap().capabilities).toEqual({
      read: true,
      edit: false,
      share: false,
    });
    transcript.close();
  });
});
