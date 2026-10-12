/**
 * Drives the real TelegramOutputStream against api.telegram.org.
 *
 * The automated suite runs against a fake Bot API, which can only ever confirm
 * that our code does what we think Telegram wants. This confirms what Telegram
 * actually accepts: HTML entity validation, the 4096-character limit, edit
 * rate limiting, inline keyboards, and deletion.
 *
 * It sends real messages to a real chat, so it is opt-in:
 *
 *   TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... \
 *     bun scripts/telegram-live-smoke.ts
 *
 * Every message it creates is deleted before it exits.
 */
import {
  TelegramOutputStream,
  type TelegramOutputApi,
  type TelegramDeleteMessageParams,
  type TelegramEditMessageTextParams,
  type TelegramSendChatActionParams,
  type TelegramSendMessageParams,
} from "../apps/core/src/surface/telegram/output/telegram-output-stream";
import type { TelegramSessionRef } from "../apps/core/src/surface/types";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!token || !chatId) {
  console.error("set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID");
  process.exit(2);
}

const API_ROOT = `https://api.telegram.org/bot${token}`;

type ApiResult = { ok: boolean; result?: unknown; description?: string; error_code?: number };

function isApiResult(value: unknown): value is ApiResult {
  return typeof value === "object" && value !== null && "ok" in value;
}

const calls: { method: string; ok: boolean; detail?: string }[] = [];

async function call(method: string, params: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${API_ROOT}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(params),
  });

  const body: unknown = await response.json();
  if (!isApiResult(body) || !body.ok) {
    const detail = isApiResult(body) ? `${body.error_code}: ${body.description}` : "unparseable";
    calls.push({ method, ok: false, detail });
    throw new Error(`${method} failed — ${detail}`);
  }

  calls.push({ method, ok: true });
  return body.result;
}

function messageIdOf(result: unknown): number {
  if (typeof result === "object" && result !== null && "message_id" in result) {
    const id = (result as { message_id: unknown }).message_id;
    if (typeof id === "number") return id;
  }
  throw new Error("response carried no message_id");
}

const created: number[] = [];

const api: TelegramOutputApi = {
  sendMessage: async (params: TelegramSendMessageParams) => {
    const result = await call("sendMessage", { ...params });
    const id = messageIdOf(result);
    created.push(id);
    return { message_id: id };
  },
  editMessageText: async (params: TelegramEditMessageTextParams) => {
    await call("editMessageText", { ...params });
  },
  deleteMessage: async (params: TelegramDeleteMessageParams) => {
    await call("deleteMessage", { ...params });
  },
  sendChatAction: async (params: TelegramSendChatActionParams) => {
    await call("sendChatAction", { ...params });
  },
};

const sessionRef: TelegramSessionRef = { platform: "telegram", channelId: chatId };

function makeStream(opts: { requestId?: string } = {}): TelegramOutputStream {
  return new TelegramOutputStream({
    api,
    sessionRef,
    ...(opts.requestId ? { opts: { requestId: opts.requestId } } : {}),
    now: () => Date.now(),
    scheduleEdit: (cb, delayMs) => {
      const timer = setTimeout(cb, delayMs);
      return () => clearTimeout(timer);
    },
    // Match the shipped default, so throttling is exercised as configured.
    streamEditIntervalMs: 1500,
    parseMode: "html",
    outputMode: "inline",
    outputNotification: false,
    workingIndicators: ["thinking"],
  });
}

const checks: { name: string; ok: boolean; note: string }[] = [];

async function check(name: string, run: () => Promise<string>): Promise<void> {
  try {
    checks.push({ name, ok: true, note: await run() });
  } catch (error: unknown) {
    checks.push({ name, ok: false, note: error instanceof Error ? error.message : String(error) });
  }
}

// 1. Formatting Telegram must accept. Every construct the renderer can emit,
//    including the ones most likely to produce an invalid entity.
await check("html rendering accepted by telegram", async () => {
  const stream = makeStream();
  await stream.push({
    type: "text.set",
    text: [
      "# Heading becomes bold",
      "",
      "**bold**, *italic*, ~~strike~~, `inline code`, [a link](https://example.com/a?b=1&c=2)",
      "",
      "```ts",
      'const x: Record<string, number> = { "a<b>": 1 };',
      "if (x && y) console.log(`<not a tag>`);",
      "```",
      "",
      "- list item with & ampersand",
      "- item with <angle> brackets",
      "",
      "> quoted line",
    ].join("\n"),
  });
  const result = await stream.finish();
  return `${result.created.length} message(s), no entity rejection`;
});

// 2. The 4096 limit is a real API constraint, not just our constant.
await check("overflow splits into messages telegram accepts", async () => {
  const stream = makeStream();
  await stream.push({ type: "text.set", text: "lorem ipsum dolor sit amet ".repeat(400) });
  const result = await stream.finish();
  if (result.created.length < 2) throw new Error("expected the answer to split");
  return `${result.created.length} messages`;
});

// 3. A code block spanning a split must stay valid on both sides, which is
//    where a malformed entity would surface.
await check("code block split across messages stays valid", async () => {
  const stream = makeStream();
  const body = Array.from({ length: 260 }, (_, i) => `const line${i} = "value <${i}> & more";`);
  await stream.push({ type: "text.set", text: ["```ts", ...body, "```"].join("\n") });
  const result = await stream.finish();
  if (result.created.length < 2) throw new Error("expected the block to split");
  return `${result.created.length} messages, both accepted`;
});

// 4. Streaming edits at the shipped interval must not trip 429.
await check("throttled streaming edits avoid rate limiting", async () => {
  const stream = makeStream();
  for (let i = 1; i <= 12; i += 1) {
    await stream.push({ type: "text.delta", delta: `chunk ${i} of streamed output. ` });
  }
  await stream.finish();
  const edits = calls.filter((c) => c.method === "editMessageText");
  return `${edits.length} edits issued, ${edits.filter((c) => !c.ok).length} rejected`;
});

// 5. The cancel keyboard must be a shape Telegram renders.
await check("cancel inline keyboard accepted", async () => {
  const stream = makeStream({ requestId: `telegram:${chatId}:1` });
  await stream.push({ type: "text.delta", delta: "working on it" });
  await stream.settled();
  await stream.finish();
  return "reply_markup accepted";
});

// 6. Shrinking output must actually remove the surplus remotely.
await check("shrinking output deletes surplus messages", async () => {
  const stream = makeStream();
  await stream.push({ type: "text.set", text: "x".repeat(9000) });
  await stream.settled();
  const grown = stream.getDeliveredMessages().length;
  await stream.push({ type: "text.set", text: "short final answer" });
  const result = await stream.finish();
  if (grown < 2) throw new Error("expected the draft to overflow first");
  if (result.created.length !== 1) throw new Error(`expected 1 surviving message, got ${result.created.length}`);
  return `${grown} -> 1 message`;
});

// Clean up everything this script put in the chat.
//
// Deliberately bypasses `call()`: the shrink check already removed some of
// these, so "message to delete not found" here is the expected outcome and
// must not be counted as an API failure.
let cleaned = 0;
for (const id of [...new Set(created)].reverse()) {
  const response = await fetch(`${API_ROOT}/deleteMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: Number(chatId), message_id: id }),
  });
  const body: unknown = await response.json();
  if (isApiResult(body) && body.ok) cleaned += 1;
}

console.log("\n=== live telegram smoke ===\n");
for (const c of checks) {
  console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}\n      ${c.note}`);
}

const failedCalls = calls.filter((c) => !c.ok);
console.log(`\napi calls: ${calls.length}, failed: ${failedCalls.length}`);
for (const c of failedCalls) console.log(`  ${c.method}: ${c.detail}`);
console.log(`messages cleaned up: ${cleaned}`);

process.exit(checks.every((c) => c.ok) && failedCalls.length === 0 ? 0 : 1);
