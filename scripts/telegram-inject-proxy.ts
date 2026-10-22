/**
 * A Bot API proxy that can inject an inbound update.
 *
 * A Telegram bot cannot send a message to itself, and cannot receive one from
 * another bot, so the inbound half of the surface has no fully automated path:
 * driving it needs a human, or a user account over MTProto.
 *
 * This closes as much of that gap as is possible without either. Every call is
 * forwarded to the real api.telegram.org — so replies land in the real chat,
 * rendered by the real API — and only `getUpdates` is augmented, returning a
 * synthetic user message alongside whatever Telegram actually has.
 *
 * What that verifies: adapter → bridge → router → agent runner → output stream
 * → real Telegram, against real config and a real model.
 *
 * What it does NOT verify: that Telegram delivers user messages to the bot in
 * the first place. That was already observed directly — messages 33 and 34
 * arrived through ordinary long polling.
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=... PROXY_PORT=8099 bun scripts/telegram-inject-proxy.ts
 *
 * Then POST an update to inject:
 *   curl -XPOST localhost:8099/__inject -d '{"chatId":1,"userId":2,"text":"hi"}'
 */
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("set TELEGRAM_BOT_TOKEN");
  process.exit(2);
}

const UPSTREAM = "https://api.telegram.org";
const port = Number(process.env.PROXY_PORT ?? 8099);

type InjectedUpdate = Record<string, unknown>;

const pending: InjectedUpdate[] = [];
let nextUpdateId = Date.now() % 1_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildUpdate(input: {
  chatId: number;
  userId: number;
  text: string;
  firstName: string;
}): InjectedUpdate {
  nextUpdateId += 1;
  return {
    update_id: nextUpdateId,
    message: {
      message_id: Math.floor(Date.now() / 1000) % 100_000,
      date: Math.floor(Date.now() / 1000),
      chat: { id: input.chatId, type: "private", first_name: input.firstName },
      from: { id: input.userId, is_bot: false, first_name: input.firstName },
      text: input.text,
    },
  };
}

async function forward(req: Request, path: string): Promise<Response> {
  const body = req.method === "POST" ? await req.arrayBuffer() : undefined;
  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("content-length");

  return await fetch(`${UPSTREAM}${path}`, {
    method: req.method,
    headers,
    ...(body && body.byteLength > 0 ? { body } : {}),
  });
}

Bun.serve({
  port,
  idleTimeout: 60,
  fetch: async (req) => {
    const url = new URL(req.url);

    if (url.pathname === "/__inject") {
      const raw: unknown = await req.json();
      if (!isRecord(raw)) return Response.json({ ok: false }, { status: 400 });

      const chatId = Number(raw.chatId);
      const userId = Number(raw.userId ?? raw.chatId);
      const text = typeof raw.text === "string" ? raw.text : "";
      const firstName = typeof raw.firstName === "string" ? raw.firstName : "Operator";
      if (!Number.isFinite(chatId) || text.length === 0) {
        return Response.json({ ok: false, error: "chatId and text required" }, { status: 400 });
      }

      const update = buildUpdate({ chatId, userId, text, firstName });
      pending.push(update);
      console.log(`[inject] queued update ${String(update.update_id)}: ${text}`);
      return Response.json({ ok: true, update });
    }

    const method = url.pathname.split("/").pop() ?? "";

    if (method === "getUpdates" && pending.length > 0) {
      const injected = pending.splice(0, pending.length);
      console.log(`[inject] delivering ${injected.length} update(s)`);
      return Response.json({ ok: true, result: injected });
    }

    const response = await forward(req, url.pathname + url.search);

    // Log the outbound calls the runtime makes, so the reply path is visible.
    if (method !== "getUpdates") {
      const clone = response.clone();
      const body: unknown = await clone.json().catch(() => null);
      const ok = isRecord(body) && body.ok === true;
      console.log(`[api] ${method} -> ${ok ? "ok" : JSON.stringify(body)?.slice(0, 160)}`);
    }

    return response;
  },
});

console.log(`bot api proxy listening on http://0.0.0.0:${port} -> ${UPSTREAM}`);
