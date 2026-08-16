import { describe, expect, it } from "bun:test";
import type { Result as ResultType } from "better-result";

import type { StartOutputOpts } from "../../../src/surface/adapter";
import type { MsgRef, TelegramSessionRef } from "../../../src/surface/types";
import { projectTelegramError } from "../../../src/surface/telegram/telegram-error-projection";
import {
  TelegramOutputStream,
  type TelegramDeleteMessageParams,
  type TelegramEditMessageTextParams,
  type TelegramOutputApi,
  type TelegramSendChatActionParams,
  type TelegramSendMessageParams,
  type TelegramSentMessage,
  buildTelegramCancelCallbackData,
  buildTelegramProgressLines,
  isTelegramEntityError,
  isTelegramNotModifiedError,
  parseTelegramCancelCallbackData,
  pickWorkingIndicator,
  telegramRetryAfterSeconds,
} from "../../../src/surface/telegram/output/telegram-output-stream";

const SESSION: TelegramSessionRef = { platform: "telegram", channelId: "12345" };
const TOPIC_SESSION: TelegramSessionRef = { platform: "telegram", channelId: "-100777:42" };

function resultValue<T, E>(result: ResultType<T, E>): T {
  if (result.status === "error") throw result.error;
  return result.value;
}

/** A Bot API error the way grammY surfaces it. */
class FakeApiError extends Error {
  constructor(
    readonly error_code: number,
    readonly description: string,
    readonly parameters?: { retry_after?: number },
  ) {
    super(description);
    this.name = "GrammyError";
  }
}

type SendCall = { readonly kind: "send"; readonly params: TelegramSendMessageParams };
type EditCall = { readonly kind: "edit"; readonly params: TelegramEditMessageTextParams };
type DeleteCall = { readonly kind: "delete"; readonly params: TelegramDeleteMessageParams };
type ActionCall = { readonly kind: "action"; readonly params: TelegramSendChatActionParams };
type ApiCall = SendCall | EditCall | DeleteCall | ActionCall;

type FailureHook = (call: ApiCall, attemptIndex: number) => unknown;

/** Records every call and drives the injected clock/scheduler. */
class TestHarness implements TelegramOutputApi {
  readonly calls: ApiCall[] = [];
  private readonly timers: { id: number; dueAtMs: number; cb: () => void }[] = [];
  private nextMessageId = 1000;
  private nextTimerId = 1;
  private nowMs = 0;
  private failure: FailureHook | null = null;
  private readonly attempts = new Map<string, number>();

  now = (): number => this.nowMs;

  scheduleEdit = (cb: () => void, delayMs: number): (() => void) => {
    const id = this.nextTimerId++;
    this.timers.push({ id, dueAtMs: this.nowMs + Math.max(0, delayMs), cb });
    return () => {
      const index = this.timers.findIndex((timer) => timer.id === id);
      if (index >= 0) this.timers.splice(index, 1);
    };
  };

  failWith(hook: FailureHook): void {
    this.failure = hook;
  }

  /** Advance the clock and fire every timer that comes due. */
  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.dueAtMs <= target)
        .sort((a, b) => a.dueAtMs - b.dueAtMs)[0];
      if (!due) break;
      this.timers.splice(this.timers.indexOf(due), 1);
      this.nowMs = Math.max(this.nowMs, due.dueAtMs);
      due.cb();
      await this.drainMicrotasks();
    }
    this.nowMs = target;
    await this.drainMicrotasks();
  }

  async drainMicrotasks(): Promise<void> {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  }

  get pendingTimerCount(): number {
    return this.timers.length;
  }

  get sends(): readonly TelegramSendMessageParams[] {
    return this.calls.flatMap((call) => (call.kind === "send" ? [call.params] : []));
  }

  get edits(): readonly TelegramEditMessageTextParams[] {
    return this.calls.flatMap((call) => (call.kind === "edit" ? [call.params] : []));
  }

  get deletes(): readonly TelegramDeleteMessageParams[] {
    return this.calls.flatMap((call) => (call.kind === "delete" ? [call.params] : []));
  }

  private maybeFail(call: ApiCall): void {
    if (!this.failure) return;
    const key = call.kind;
    const attempt = this.attempts.get(key) ?? 0;
    this.attempts.set(key, attempt + 1);
    const error = this.failure(call, attempt);
    if (error !== undefined && error !== null) throw error;
  }

  async sendMessage(params: TelegramSendMessageParams): Promise<TelegramSentMessage> {
    const call: SendCall = { kind: "send", params };
    this.calls.push(call);
    this.maybeFail(call);
    return { message_id: this.nextMessageId++ };
  }

  async editMessageText(params: TelegramEditMessageTextParams): Promise<void> {
    const call: EditCall = { kind: "edit", params };
    this.calls.push(call);
    this.maybeFail(call);
  }

  async deleteMessage(params: TelegramDeleteMessageParams): Promise<void> {
    const call: DeleteCall = { kind: "delete", params };
    this.calls.push(call);
    this.maybeFail(call);
  }

  async sendChatAction(params: TelegramSendChatActionParams): Promise<void> {
    this.calls.push({ kind: "action", params });
  }
}

function createStream(
  harness: TestHarness,
  overrides: {
    session?: TelegramSessionRef;
    opts?: StartOutputOpts;
    parseMode?: "html" | "plain";
    outputMode?: "inline" | "preview";
    outputNotification?: boolean;
    streamEditIntervalMs?: number;
  } = {},
): TelegramOutputStream {
  return new TelegramOutputStream({
    api: harness,
    sessionRef: overrides.session ?? SESSION,
    ...(overrides.opts ? { opts: overrides.opts } : {}),
    now: harness.now,
    scheduleEdit: harness.scheduleEdit,
    streamEditIntervalMs: overrides.streamEditIntervalMs ?? 1000,
    parseMode: overrides.parseMode ?? "html",
    outputMode: overrides.outputMode ?? "inline",
    outputNotification: overrides.outputNotification ?? true,
    workingIndicators: ["Working", "Thinking"],
  });
}

describe("cancel callback data", () => {
  it("round-trips a request id", () => {
    const data = buildTelegramCancelCallbackData("telegram:12345:99");
    expect(data).toBe("lc:telegram:12345:99");
    expect(parseTelegramCancelCallbackData(data ?? "")).toBe("telegram:12345:99");
  });

  it("refuses data over Telegram's 64-byte callback limit", () => {
    expect(buildTelegramCancelCallbackData("x".repeat(80))).toBeNull();
  });

  it("rejects foreign callback payloads", () => {
    expect(parseTelegramCancelCallbackData("other:payload")).toBeNull();
    expect(parseTelegramCancelCallbackData("lc:")).toBeNull();
  });
});

describe("error type guards", () => {
  it("reads retry_after from a 429 response", () => {
    const error = new FakeApiError(429, "Too Many Requests: retry after 3", { retry_after: 3 });
    expect(telegramRetryAfterSeconds(projectTelegramError(error, "test failure"))).toBe(3);
  });

  it("treats a 429 without parameters as an immediate retry", () => {
    expect(
      telegramRetryAfterSeconds(
        projectTelegramError(new FakeApiError(429, "Too Many Requests"), "test failure"),
      ),
    ).toBe(0);
  });

  it("returns null for unrelated errors", () => {
    expect(
      telegramRetryAfterSeconds(projectTelegramError(new Error("boom"), "test failure")),
    ).toBeNull();
    expect(telegramRetryAfterSeconds(projectTelegramError(null, "test failure"))).toBeNull();
    expect(telegramRetryAfterSeconds(projectTelegramError("nope", "test failure"))).toBeNull();
  });

  it("detects entity parse failures", () => {
    expect(
      isTelegramEntityError(
        projectTelegramError(
          new FakeApiError(400, "Bad Request: can't parse entities: ..."),
          "test failure",
        ),
      ),
    ).toBe(true);
    expect(
      isTelegramEntityError(
        projectTelegramError(new FakeApiError(400, "Bad Request: chat not found"), "test failure"),
      ),
    ).toBe(false);
  });

  it("detects the not-modified rejection", () => {
    expect(
      isTelegramNotModifiedError(
        projectTelegramError(
          new FakeApiError(400, "Bad Request: message is not modified: ..."),
          "test failure",
        ),
      ),
    ).toBe(true);
    expect(
      isTelegramNotModifiedError(projectTelegramError(new Error("other"), "test failure")),
    ).toBe(false);
  });
});

describe("progress rendering helpers", () => {
  it("keeps the five most recent tool lines with status icons", () => {
    const entries = Array.from({ length: 8 }, (_, i) => ({
      toolCallId: `t${i}`,
      updatedSeq: i,
      update: { toolCallId: `t${i}`, display: `tool ${i}`, status: "start" as const },
    }));
    const lines = buildTelegramProgressLines(entries);
    expect(lines).toEqual(["▶ tool 3", "▶ tool 4", "▶ tool 5", "▶ tool 6", "▶ tool 7"]);
  });

  it("uses distinct icons per status", () => {
    const lines = buildTelegramProgressLines([
      {
        toolCallId: "a",
        updatedSeq: 1,
        update: { toolCallId: "a", display: "a", status: "end", ok: true },
      },
      {
        toolCallId: "b",
        updatedSeq: 2,
        update: { toolCallId: "b", display: "b", status: "end", ok: false },
      },
      {
        toolCallId: "c",
        updatedSeq: 3,
        update: { toolCallId: "c", display: "c", status: "update" },
      },
    ]);
    expect(lines).toEqual(["✓ a", "✗ b", "… c"]);
  });

  it("rotates the working indicator over time and falls back when empty", () => {
    expect(pickWorkingIndicator({ indicators: ["A", "B"], elapsedMs: 0 })).toBe("A");
    expect(pickWorkingIndicator({ indicators: ["A", "B"], elapsedMs: 13_000 })).toBe("B");
    expect(pickWorkingIndicator({ indicators: [" ", ""], elapsedMs: 0 })).toBe("Working");
  });
});

describe("TelegramOutputStream streaming", () => {
  it("reports a full final-text mode", () => {
    const harness = new TestHarness();
    expect(createStream(harness).getFinalTextMode()).toBe("full");
  });

  it("sends the first message immediately on the first delta", async () => {
    const harness = new TestHarness();
    const stream = createStream(harness);

    resultValue(await stream.push({ type: "text.delta", delta: "hello" }));
    await stream.settled();

    expect(harness.sends.length).toBe(1);
    expect(harness.sends[0]?.text).toContain("hello");
    expect(harness.sends[0]?.chat_id).toBe(12345);
    expect(harness.sends[0]?.parse_mode).toBe("HTML");
  });

  it("does not edit before the throttle interval elapses", async () => {
    const harness = new TestHarness();
    const stream = createStream(harness, { streamEditIntervalMs: 1000 });

    resultValue(await stream.push({ type: "text.delta", delta: "a" }));
    await stream.settled();
    resultValue(await stream.push({ type: "text.delta", delta: "b" }));
    await harness.advance(500);

    expect(harness.edits.length).toBe(0);
  });

  it("issues exactly one edit once the interval elapses", async () => {
    const harness = new TestHarness();
    const stream = createStream(harness, { streamEditIntervalMs: 1000 });

    resultValue(await stream.push({ type: "text.delta", delta: "a" }));
    await stream.settled();
    resultValue(await stream.push({ type: "text.delta", delta: "b" }));
    resultValue(await stream.push({ type: "text.delta", delta: "c" }));
    await harness.advance(1000);

    expect(harness.edits.length).toBe(1);
    expect(harness.edits[0]?.text).toContain("abc");
  });

  it("coalesces many deltas inside one window into a single edit", async () => {
    const harness = new TestHarness();
    const stream = createStream(harness, { streamEditIntervalMs: 1000 });

    resultValue(await stream.push({ type: "text.delta", delta: "start" }));
    await stream.settled();
    for (let i = 0; i < 20; i += 1) {
      resultValue(await stream.push({ type: "text.delta", delta: ` ${i}` }));
    }
    await harness.advance(1000);

    expect(harness.edits.length).toBe(1);
  });

  it("never repeats an identical edit payload", async () => {
    const harness = new TestHarness();
    const stream = createStream(harness, { streamEditIntervalMs: 1000 });

    resultValue(await stream.push({ type: "text.delta", delta: "stable" }));
    await stream.settled();
    resultValue(await stream.push({ type: "text.delta", delta: "" }));
    await harness.advance(5000);
    const editsAfterNoop = harness.edits.length;

    resultValue(await stream.finish());
    // The only edit is the finalisation (progress header/keyboard removal),
    // never a redundant re-send of identical content.
    expect(editsAfterNoop).toBe(0);
    expect(harness.edits.every((edit) => edit.text.includes("stable"))).toBe(true);
  });

  it("swallows a not-modified rejection without failing the stream", async () => {
    const harness = new TestHarness();
    harness.failWith((call) =>
      call.kind === "edit"
        ? new FakeApiError(400, "Bad Request: message is not modified")
        : undefined,
    );
    const stream = createStream(harness, { streamEditIntervalMs: 1000 });

    resultValue(await stream.push({ type: "text.delta", delta: "a" }));
    await stream.settled();
    resultValue(await stream.push({ type: "text.delta", delta: "b" }));
    await harness.advance(1000);

    const result = resultValue(await stream.finish());
    expect(result.created.length).toBe(1);
  });

  it("targets a forum topic thread for both send and typing", async () => {
    const harness = new TestHarness();
    const stream = createStream(harness, { session: TOPIC_SESSION });

    resultValue(await stream.push({ type: "text.set", text: "hi" }));
    await stream.settled();

    expect(harness.sends[0]?.chat_id).toBe(-100777);
    expect(harness.sends[0]?.message_thread_id).toBe(42);
  });

  it("suppresses notifications when output notification is disabled", async () => {
    const harness = new TestHarness();
    const stream = createStream(harness, { outputNotification: false });

    resultValue(await stream.push({ type: "text.set", text: "quiet" }));
    await stream.settled();

    expect(harness.sends[0]?.disable_notification).toBe(true);
  });

  it("replies to the triggering message", async () => {
    const harness = new TestHarness();
    const replyTo: MsgRef = { platform: "telegram", channelId: "12345", messageId: "77" };
    const stream = createStream(harness, { opts: { replyTo } });

    resultValue(await stream.push({ type: "text.set", text: "answer" }));
    await stream.settled();

    expect(harness.sends[0]?.reply_to_message_id).toBe(77);
  });
});

describe("TelegramOutputStream progress header", () => {
  it("renders tool status while streaming and drops it on finish", async () => {
    const harness = new TestHarness();
    const stream = createStream(harness, { streamEditIntervalMs: 1000 });

    resultValue(
      await stream.push({
        type: "tool.status",
        update: { toolCallId: "t1", display: "read(file.ts)", status: "start" },
      }),
    );
    await stream.settled();
    expect(harness.sends[0]?.text).toContain("read(file.ts)");

    resultValue(await stream.push({ type: "text.delta", delta: "body text" }));
    await harness.advance(1000);
    resultValue(await stream.finish());

    const finalEdit = harness.edits.at(-1);
    expect(finalEdit?.text).toContain("body text");
    expect(finalEdit?.text).not.toContain("read(file.ts)");
  });

  it("escapes tool display text so it cannot inject markup", async () => {
    const harness = new TestHarness();
    const stream = createStream(harness);

    resultValue(
      await stream.push({
        type: "tool.status",
        update: { toolCallId: "t1", display: "bash(<script>x</script>)", status: "start" },
      }),
    );
    await stream.settled();

    expect(harness.sends[0]?.text).toContain("&lt;script&gt;");
    expect(harness.sends[0]?.text).not.toContain("<script>");
  });

  it("freezes the reasoning timer once text starts streaming", async () => {
    const harness = new TestHarness();
    const stream = createStream(harness, { streamEditIntervalMs: 1000 });

    resultValue(await stream.push({ type: "reasoning.status", update: { startedAtMs: 0 } }));
    await stream.settled();

    await harness.advance(4000);
    resultValue(await stream.push({ type: "text.delta", delta: "answer" }));
    await harness.advance(1000);
    const frozenEdit = harness.edits.at(-1)?.text ?? "";
    expect(frozenEdit).toContain("Thought for 4s");

    // More wall-clock time passes, but the frozen value must not advance.
    await harness.advance(10_000);
    resultValue(await stream.push({ type: "text.delta", delta: " more" }));
    await harness.advance(1000);
    expect(harness.edits.at(-1)?.text).toContain("Thought for 4s");
  });

  it("renders stats as a trailing line on the final message only", async () => {
    const harness = new TestHarness();
    const stream = createStream(harness, { streamEditIntervalMs: 1000 });

    resultValue(await stream.push({ type: "text.delta", delta: "answer" }));
    await stream.settled();
    resultValue(await stream.push({ type: "meta.stats", line: "12 tok/s · 3.4s" }));
    await harness.advance(1000);

    expect(harness.edits.every((edit) => !edit.text.includes("12 tok/s"))).toBe(true);

    resultValue(await stream.finish());
    expect(harness.edits.at(-1)?.text).toContain("12 tok/s");
  });
});

describe("TelegramOutputStream overflow", () => {
  it("continues into a second message past the character limit", async () => {
    const harness = new TestHarness();
    const stream = createStream(harness, { streamEditIntervalMs: 1000 });

    resultValue(await stream.push({ type: "text.delta", delta: "start" }));
    await stream.settled();
    resultValue(await stream.push({ type: "text.set", text: "word ".repeat(1500) }));
    await harness.advance(1000);
    const result = resultValue(await stream.finish());

    expect(result.created.length).toBeGreaterThan(1);
    expect(harness.sends.length).toBeGreaterThan(1);
    for (const send of harness.sends) expect(send.text.length).toBeLessThanOrEqual(4096);
    for (const edit of harness.edits) expect(edit.text.length).toBeLessThanOrEqual(4096);
  });

  it("tracks every created message ref in order and returns the last", async () => {
    const harness = new TestHarness();
    const stream = createStream(harness);

    resultValue(await stream.push({ type: "text.set", text: "line\n".repeat(3000) }));
    await stream.settled();
    const result = resultValue(await stream.finish());

    expect(result.created.length).toBeGreaterThan(1);
    expect(result.created.at(-1)).toEqual(result.last);
    for (const ref of result.created) {
      expect(ref.platform).toBe("telegram");
      expect(ref.channelId).toBe("12345");
    }
    const ids = result.created.map((ref) => ref.messageId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("notifies the creation hook for each message", async () => {
    const harness = new TestHarness();
    const seen: MsgRef[] = [];
    const stream = createStream(harness, {
      opts: { onMessageCreated: (ref) => seen.push(ref) },
    });

    resultValue(await stream.push({ type: "text.set", text: "hello" }));
    await stream.settled();
    resultValue(await stream.finish());

    expect(seen.length).toBe(1);
    expect(seen[0]?.messageId).toBe("1000");
  });
});

describe("TelegramOutputStream failure handling", () => {
  it("backs off for retry_after and retries once", async () => {
    const harness = new TestHarness();
    harness.failWith((call, attempt) =>
      call.kind === "send" && attempt === 0
        ? new FakeApiError(429, "Too Many Requests: retry after 2", { retry_after: 2 })
        : undefined,
    );
    const stream = createStream(harness);

    const pushed = stream.push({ type: "text.set", text: "throttled" });
    await harness.drainMicrotasks();

    // The retry is still parked on the injected timer.
    expect(harness.sends.length).toBe(1);
    expect(harness.pendingTimerCount).toBe(1);

    await harness.advance(2000);
    resultValue(await pushed);
    await stream.settled();

    expect(harness.sends.length).toBe(2);
    expect(harness.sends[1]?.text).toContain("throttled");
  });

  it("retries the same content without parse mode after an entity error", async () => {
    const harness = new TestHarness();
    harness.failWith((call, attempt) =>
      call.kind === "send" && attempt === 0
        ? new FakeApiError(400, "Bad Request: can't parse entities: unsupported start tag")
        : undefined,
    );
    const stream = createStream(harness);

    resultValue(await stream.push({ type: "text.set", text: "**bold** and `code`" }));
    await stream.settled();

    expect(harness.sends.length).toBe(2);
    expect(harness.sends[0]?.parse_mode).toBe("HTML");
    expect(harness.sends[0]?.text).toContain("<b>bold</b>");
    expect(harness.sends[1]?.parse_mode).toBeUndefined();
    expect(harness.sends[1]?.text).toBe("bold and code");
  });

  it("sends plain text with no parse mode when configured for plain", async () => {
    const harness = new TestHarness();
    const stream = createStream(harness, { parseMode: "plain" });

    resultValue(await stream.push({ type: "text.set", text: "**bold**" }));
    await stream.settled();

    expect(harness.sends[0]?.parse_mode).toBeUndefined();
    expect(harness.sends[0]?.text).toBe("bold");
  });

  it("surfaces a non-recoverable API failure as a contextual error", async () => {
    const harness = new TestHarness();
    harness.failWith((call) =>
      call.kind === "send" ? new FakeApiError(403, "Forbidden: bot was blocked") : undefined,
    );
    const stream = createStream(harness);

    await expect(stream.push({ type: "text.set", text: "hi" })).rejects.toThrow(
      /telegram: message delivery failed/u,
    );
  });
});

describe("TelegramOutputStream cancel keyboard", () => {
  it("attaches a plain JSON cancel keyboard while streaming", async () => {
    const harness = new TestHarness();
    const stream = createStream(harness, { opts: { requestId: "telegram:12345:9" } });

    resultValue(await stream.push({ type: "text.set", text: "working" }));
    await stream.settled();

    const markup = harness.sends[0]?.reply_markup;
    expect(markup).toEqual({
      inline_keyboard: [[{ text: "Cancel", callback_data: "lc:telegram:12345:9" }]],
    });
    expect(JSON.parse(JSON.stringify(markup))).toEqual(markup);
  });

  it("clears the keyboard on finish", async () => {
    const harness = new TestHarness();
    const stream = createStream(harness, { opts: { requestId: "telegram:12345:9" } });

    resultValue(await stream.push({ type: "text.set", text: "working" }));
    await stream.settled();
    resultValue(await stream.finish());

    expect(harness.edits.at(-1)?.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it("omits the keyboard when no request id is supplied", async () => {
    const harness = new TestHarness();
    const stream = createStream(harness);

    resultValue(await stream.push({ type: "text.set", text: "working" }));
    await stream.settled();

    expect(harness.sends[0]?.reply_markup).toBeUndefined();
  });
});

describe("TelegramOutputStream abort", () => {
  it("deletes preview messages in preview mode", async () => {
    const harness = new TestHarness();
    const stream = createStream(harness, { outputMode: "preview" });

    resultValue(await stream.push({ type: "text.set", text: "draft output" }));
    await stream.settled();
    expect(harness.sends.length).toBe(1);

    resultValue(await stream.abort("cancel"));

    expect(harness.deletes).toEqual([{ chat_id: 12345, message_id: 1000 }]);
  });

  it("leaves the last message in place in inline mode", async () => {
    const harness = new TestHarness();
    const stream = createStream(harness, { outputMode: "inline" });

    resultValue(await stream.push({ type: "text.set", text: "partial output" }));
    await stream.settled();
    resultValue(await stream.abort("cancel"));

    expect(harness.deletes.length).toBe(0);
    expect(harness.sends.at(-1)?.text).toContain("partial output");
    // The content is already correct on the surface, so abort issues no
    // redundant edit that Telegram would reject as not-modified.
    expect(harness.edits.length).toBe(0);
  });

  it("clears the cancel keyboard when aborting in inline mode", async () => {
    const harness = new TestHarness();
    const stream = createStream(harness, {
      outputMode: "inline",
      opts: { requestId: "telegram:12345:9" },
    });

    resultValue(await stream.push({ type: "text.set", text: "partial output" }));
    await stream.settled();
    resultValue(await stream.abort("cancel"));

    expect(harness.deletes.length).toBe(0);
    expect(harness.edits.at(-1)?.reply_markup).toEqual({ inline_keyboard: [] });
    expect(harness.edits.at(-1)?.text).toContain("partial output");
  });

  it("writes a placeholder when cancelling before any text arrived", async () => {
    const harness = new TestHarness();
    const stream = createStream(harness, { outputMode: "inline" });

    resultValue(
      await stream.push({
        type: "tool.status",
        update: { toolCallId: "t1", display: "read(x)", status: "start" },
      }),
    );
    await stream.settled();
    resultValue(await stream.abort("cancel"));

    expect(harness.edits.at(-1)?.text).toContain("Cancelled.");
  });

  it("cancels the pending throttled edit so no write lands after abort", async () => {
    const harness = new TestHarness();
    const stream = createStream(harness, { outputMode: "preview", streamEditIntervalMs: 1000 });

    resultValue(await stream.push({ type: "text.delta", delta: "a" }));
    await stream.settled();
    resultValue(await stream.push({ type: "text.delta", delta: "b" }));
    resultValue(await stream.abort("cancel"));

    const editsAtAbort = harness.edits.length;
    await harness.advance(5000);
    expect(harness.edits.length).toBe(editsAtAbort);
  });

  it("tolerates a delete failure during preview abort", async () => {
    const harness = new TestHarness();
    harness.failWith((call) =>
      call.kind === "delete" ? new FakeApiError(400, "message to delete not found") : undefined,
    );
    const stream = createStream(harness, { outputMode: "preview" });

    resultValue(await stream.push({ type: "text.set", text: "draft" }));
    await stream.settled();

    resultValue(await stream.abort("cancel"));
    expect(harness.deletes.length).toBe(1);
  });

  it("is a no-op when nothing was ever sent", async () => {
    const harness = new TestHarness();
    const stream = createStream(harness, { outputMode: "inline" });

    resultValue(await stream.abort("reanchor"));

    expect(harness.calls.length).toBe(0);
  });
});

describe("TelegramOutputStream lifecycle", () => {
  it("propagates a delivery failure out of finish", async () => {
    const harness = new TestHarness();
    harness.failWith((call) =>
      call.kind === "send" ? new FakeApiError(403, "blocked") : undefined,
    );
    const stream = createStream(harness);

    await expect(stream.finish()).rejects.toThrow(/telegram: message delivery failed/u);
  });

  it("sends a placeholder when finishing with no content at all", async () => {
    const harness = new TestHarness();
    const stream = createStream(harness);

    const result = resultValue(await stream.finish());

    expect(harness.sends.length).toBe(1);
    expect(harness.sends[0]?.text).toContain("no output");
    expect(result.created.length).toBe(1);
  });

  it("buffers attachments for the adapter instead of sending them", async () => {
    const harness = new TestHarness();
    const stream = createStream(harness);

    resultValue(
      await stream.push({
        type: "attachment.add",
        attachment: {
          kind: "file",
          mimeType: "text/plain",
          filename: "a.txt",
          bytes: new Uint8Array([1, 2, 3]),
        },
      }),
    );
    await stream.settled();

    expect(harness.calls.length).toBe(0);
    const taken = stream.takePendingAttachments();
    expect(taken.length).toBe(1);
    expect(taken[0]?.filename).toBe("a.txt");
    expect(stream.takePendingAttachments()).toEqual([]);
  });

  it("edits resumed messages rather than creating new ones", async () => {
    const harness = new TestHarness();
    const resumed: MsgRef = { platform: "telegram", channelId: "12345", messageId: "555" };
    const stream = createStream(harness, { opts: { resume: { created: [resumed] } } });

    resultValue(await stream.push({ type: "text.set", text: "continued" }));
    await stream.settled();

    expect(harness.sends.length).toBe(0);
    expect(harness.edits[0]?.message_id).toBe(555);

    const result = resultValue(await stream.finish());
    expect(result.created[0]).toEqual(resumed);
  });
});
