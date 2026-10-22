import { describe, expect, it } from "bun:test";
import type { Result as ResultType } from "better-result";

import {
  TelegramOutputStream,
  type TelegramOutputApi,
  type TelegramOutputStreamDeps,
} from "../../../src/surface/telegram/output/telegram-output-stream";
import { classifySurplusDeletionFailure } from "../../../src/surface/telegram/output/telegram-output-stream";
import { projectTelegramError } from "../../../src/surface/telegram/telegram-error-projection";
import type { MsgRef, TelegramSessionRef } from "../../../src/surface/types";

const SESSION: TelegramSessionRef = { platform: "telegram", channelId: "1001" };

function resultValue<T, E>(result: ResultType<T, E>): T {
  if (result.status === "error") throw result.error;
  return result.value;
}

type Recorded = { method: string; messageId?: number; text?: string };

function harness(opts: { failDelete?: () => Error | null } = {}): {
  api: TelegramOutputApi;
  calls: Recorded[];
  live: Map<number, string>;
} {
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
        calls.push({ method: "deleteMessage", messageId: params.message_id });
        const failure = opts.failDelete?.();
        if (failure) throw failure;
        live.delete(params.message_id);
      },
      sendChatAction: async () => undefined,
    },
  };
}

function makeStream(
  api: TelegramOutputApi,
  outputMode: "inline" | "preview" = "inline",
  opts?: TelegramOutputStreamDeps["opts"],
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
    ...(opts === undefined ? {} : { opts }),
  };
  return new TelegramOutputStream(deps);
}

describe("a shrinking answer must not leave stale messages behind", () => {
  it("deletes overflow messages when the final text fits in one", async () => {
    const { api, calls, live } = harness();
    const stream = makeStream(api);

    // Grow well past the 4096-char limit, then replace with a short answer.
    resultValue(await stream.push({ type: "text.set", text: "x".repeat(9000) }));
    await stream.settled();

    const created = calls.filter((c) => c.method === "sendMessage").length;
    expect(created).toBeGreaterThan(1);

    resultValue(await stream.push({ type: "text.set", text: "short" }));
    const result = resultValue(await stream.finish());

    expect(calls.some((c) => c.method === "deleteMessage")).toBe(true);
    expect(live.size).toBe(1);
    expect(result.created).toHaveLength(1);
    expect([...live.values()][0]).toContain("short");
  });

  it("reports only the surviving message from finish()", async () => {
    const { api, live } = harness();
    const stream = makeStream(api);

    resultValue(await stream.push({ type: "text.set", text: "y".repeat(9000) }));
    await stream.settled();
    resultValue(await stream.push({ type: "text.set", text: "brief" }));
    const result = resultValue(await stream.finish());

    const surviving = [...live.keys()].map(String);
    expect(result.created.map((ref) => ref.messageId)).toEqual(surviving);
    expect(result.last.messageId).toBe(surviving[surviving.length - 1] ?? "");
  });

  it("keeps every message when the answer does not shrink", async () => {
    const { api, calls, live } = harness();
    const stream = makeStream(api);

    resultValue(await stream.push({ type: "text.set", text: "z".repeat(9000) }));
    await stream.settled();
    const result = resultValue(await stream.finish());

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

      resultValue(await stream.push({ type: "text.set", text: "the answer" }));
      const result = resultValue(await stream.finish());

      expect(live.size).toBe(1);
      expect([...live.values()][0]).toContain("the answer");
      expect(result.created).toHaveLength(1);
    });
  }

  it("preview removes the streamed messages when the run is cancelled", async () => {
    const { api, live } = harness();
    const stream = makeStream(api, "preview");

    resultValue(await stream.push({ type: "text.set", text: "partial thought" }));
    await stream.settled();
    resultValue(await stream.abort("cancelled"));

    expect(live.size).toBe(0);
  });

  it("inline keeps the partial answer visible when the run is cancelled", async () => {
    const { api, live } = harness();
    const stream = makeStream(api, "inline");

    resultValue(await stream.push({ type: "text.set", text: "partial thought" }));
    await stream.settled();
    resultValue(await stream.abort("cancelled"));

    expect(live.size).toBe(1);
  });
});

describe("a surplus message that cannot be deleted must stay tracked", () => {
  it("keeps the ref when deletion fails transiently, so it is not silently lost", async () => {
    // Dropping the entry before a successful delete would leave the stale text
    // visible while discarding the only reference able to retry or report it.
    let attempts = 0;
    const { api, live } = harness({
      failDelete: () => {
        attempts += 1;
        return new Error("network unreachable");
      },
    });
    const stream = makeStream(api);

    resultValue(await stream.push({ type: "text.set", text: "x".repeat(9000) }));
    await stream.settled();
    resultValue(await stream.push({ type: "text.set", text: "short" }));
    const result = resultValue(await stream.finish());

    expect(attempts).toBeGreaterThan(0);
    // The message is still in the chat, so it is still reported.
    expect(live.size).toBeGreaterThan(1);
    expect(result.created.length).toBeGreaterThan(1);
    expect(stream.getSurplusDeletionFailures().length).toBeGreaterThan(0);
  });

  it("drops the ref when telegram confirms the message is already gone", async () => {
    // Terminal outcome: the desired end state already holds, so retrying would
    // never succeed and retaining the ref would misreport the answer.
    const { api } = harness({
      failDelete: () => new Error("Bad Request: message to delete not found"),
    });
    const stream = makeStream(api);

    resultValue(await stream.push({ type: "text.set", text: "x".repeat(9000) }));
    await stream.settled();
    resultValue(await stream.push({ type: "text.set", text: "short" }));
    const result = resultValue(await stream.finish());

    expect(result.created).toHaveLength(1);
    expect(stream.getSurplusDeletionFailures()).toHaveLength(0);
  });
});

describe("classifying why a surplus message survived", () => {
  it("treats a genuine not-found as absent", () => {
    expect(
      classifySurplusDeletionFailure(
        projectTelegramError(new Error("Bad Request: message to delete not found"), "test failure"),
      ),
    ).toBe("absent");
  });

  it("does NOT treat 'message can't be deleted' as absent", () => {
    // Telegram returns this when the message still exists but the bot may not
    // remove it — an expired 48h window, or missing rights. Calling it absent
    // reports a clean reconciliation while stale text stays in the chat.
    expect(
      classifySurplusDeletionFailure(
        projectTelegramError(new Error("Bad Request: message can't be deleted"), "test failure"),
      ),
    ).toBe("unreconciled");
  });

  it("treats missing rights as unreconciled rather than retryable", () => {
    expect(
      classifySurplusDeletionFailure(
        projectTelegramError(new Error("Bad Request: not enough rights to delete"), "test failure"),
      ),
    ).toBe("unreconciled");
  });

  it("treats a transport failure as retryable", () => {
    expect(
      classifySurplusDeletionFailure(
        projectTelegramError(new Error("network unreachable"), "test failure"),
      ),
    ).toBe("retryable");
  });
});

describe("an unremovable surplus message is reported, not silently kept", () => {
  it("keeps a can't-be-deleted message tracked and records it as unreconciled", async () => {
    // There is no later flush after finish(), so "the next flush retries it"
    // does not apply here: the only way this surfaces is by being reported.
    const { api, live } = harness({
      failDelete: () => new Error("Bad Request: message can't be deleted"),
    });
    const stream = makeStream(api);

    resultValue(await stream.push({ type: "text.set", text: "x".repeat(9000) }));
    await stream.settled();
    resultValue(await stream.push({ type: "text.set", text: "short" }));
    const result = resultValue(await stream.finish());

    const failures = stream.getSurplusDeletionFailures();
    expect(failures.length).toBeGreaterThan(0);
    expect(failures.every((f) => f.outcome === "unreconciled")).toBe(true);

    // Still visible in the chat, so still reported as part of the answer.
    expect(live.size).toBeGreaterThan(1);
    expect(result.created.length).toBeGreaterThan(1);
  });

  it("replaces a resumed message without reporting a surplus deletion", async () => {
    const resumed: MsgRef = {
      platform: "telegram",
      channelId: "1001",
      messageId: "10",
    };
    const { api } = harness({
      failDelete: () => new Error("Bad Request: message can't be deleted"),
    });
    const stream = makeStream(api, "inline", { resumeAt: resumed });

    resultValue(await stream.push({ type: "text.set", text: "replacement" }));
    resultValue(await stream.finish());

    expect(stream.getSurplusDeletionFailures()).toEqual([]);
    expect(stream.getDeliveredMessages()).toEqual([{ messageId: 10, text: "replacement" }]);
  });

  it("distinguishes retryable failures from unreconciled ones", async () => {
    const { api } = harness({ failDelete: () => new Error("socket hang up") });
    const stream = makeStream(api);

    resultValue(await stream.push({ type: "text.set", text: "x".repeat(9000) }));
    await stream.settled();
    resultValue(await stream.push({ type: "text.set", text: "short" }));
    resultValue(await stream.finish());

    expect(stream.getSurplusDeletionFailures().every((f) => f.outcome === "retryable")).toBe(true);
  });
});
