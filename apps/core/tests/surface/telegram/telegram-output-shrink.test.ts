import { describe, expect, it } from "bun:test";

import {
  TelegramOutputStream,
  type TelegramOutputApi,
  type TelegramOutputStreamDeps,
} from "../../../src/surface/telegram/output/telegram-output-stream";
import type { TelegramSessionRef } from "../../../src/surface/types";

const SESSION: TelegramSessionRef = { platform: "telegram", channelId: "1001" };

type Recorded = { method: string; messageId?: number; text?: string };

function harness(): { api: TelegramOutputApi; calls: Recorded[]; live: Map<number, string> } {
  const calls: Recorded[] = [];
  const live = new Map<number, string>();
  let nextId = 100;

  return {
    calls,
    live,
    api: {
      sendMessage: async (params) => {
        nextId += 1;
        live.set(nextId, params.text);
        calls.push({ method: "sendMessage", messageId: nextId, text: params.text });
        return { message_id: nextId };
      },
      editMessageText: async (params) => {
        live.set(params.message_id, params.text);
        calls.push({ method: "editMessageText", messageId: params.message_id, text: params.text });
      },
      deleteMessage: async (params) => {
        live.delete(params.message_id);
        calls.push({ method: "deleteMessage", messageId: params.message_id });
      },
      sendChatAction: async () => undefined,
    },
  };
}

function makeStream(
  api: TelegramOutputApi,
  outputMode: "inline" | "preview" = "inline",
): TelegramOutputStream {
  let now = 0;
  const deps: TelegramOutputStreamDeps = {
    api,
    sessionRef: SESSION,
    // Advance past the throttle window on every read so each flush is issued.
    now: () => (now += 10_000),
    scheduleEdit: (cb) => {
      cb();
      return () => undefined;
    },
    streamEditIntervalMs: 500,
    parseMode: "html",
    outputMode,
    outputNotification: true,
    workingIndicators: ["working"],
  };
  return new TelegramOutputStream(deps);
}

describe("a shrinking answer must not leave stale messages behind", () => {
  it("deletes overflow messages when the final text fits in one", async () => {
    const { api, calls, live } = harness();
    const stream = makeStream(api);

    // Grow well past the 4096-char limit, then replace with a short answer.
    await stream.push({ type: "text.set", text: "x".repeat(9000) });
    await stream.settled();

    const created = calls.filter((c) => c.method === "sendMessage").length;
    expect(created).toBeGreaterThan(1);

    await stream.push({ type: "text.set", text: "short" });
    const result = await stream.finish();

    expect(calls.some((c) => c.method === "deleteMessage")).toBe(true);
    expect(live.size).toBe(1);
    expect(result.created).toHaveLength(1);
    expect([...live.values()][0]).toContain("short");
  });

  it("reports only the surviving message from finish()", async () => {
    const { api, live } = harness();
    const stream = makeStream(api);

    await stream.push({ type: "text.set", text: "y".repeat(9000) });
    await stream.settled();
    await stream.push({ type: "text.set", text: "brief" });
    const result = await stream.finish();

    const surviving = [...live.keys()].map(String);
    expect(result.created.map((ref) => ref.messageId)).toEqual(surviving);
    expect(result.last.messageId).toBe(surviving[surviving.length - 1] ?? "");
  });

  it("keeps every message when the answer does not shrink", async () => {
    const { api, calls, live } = harness();
    const stream = makeStream(api);

    await stream.push({ type: "text.set", text: "z".repeat(9000) });
    await stream.settled();
    const result = await stream.finish();

    expect(calls.some((c) => c.method === "deleteMessage")).toBe(false);
    expect(result.created.length).toBe(live.size);
  });
});

describe("output mode only governs cancellation, not successful completion", () => {
  // Telegram edits the streamed message in place, so unlike Discord there is no
  // separate final repost. This pins that documented contract.
  for (const mode of ["inline", "preview"] as const) {
    it(`${mode}: a successful run leaves exactly the final answer`, async () => {
      const { api, live } = harness();
      const stream = makeStream(api, mode);

      await stream.push({ type: "text.set", text: "the answer" });
      const result = await stream.finish();

      expect(live.size).toBe(1);
      expect([...live.values()][0]).toContain("the answer");
      expect(result.created).toHaveLength(1);
    });
  }

  it("preview removes the streamed messages when the run is cancelled", async () => {
    const { api, live } = harness();
    const stream = makeStream(api, "preview");

    await stream.push({ type: "text.set", text: "partial thought" });
    await stream.settled();
    await stream.abort("cancelled");

    expect(live.size).toBe(0);
  });

  it("inline keeps the partial answer visible when the run is cancelled", async () => {
    const { api, live } = harness();
    const stream = makeStream(api, "inline");

    await stream.push({ type: "text.set", text: "partial thought" });
    await stream.settled();
    await stream.abort("cancelled");

    expect(live.size).toBe(1);
  });
});
