import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { Result } from "better-result";
import type { NativeStore } from "./store";
import { readDiscordMirrorReply, type MirrorFetch } from "./discord-mirror-webhook";

export function discordMirrorThreadName(title: string, nativeThreadId: string): string {
  const suffix = createHash("sha256").update(nativeThreadId).digest("hex").slice(0, 10);
  const clean =
    title
      .replace(/resource:\/\/\S+|(?:https?:\/\/\S+)?\/api\/(?:files|resources)\/\S+/gi, "")
      .replace(/[@<>\p{Cc}\p{Cf}]/gu, " ")
      .replace(/\s+/g, " ")
      .trim() || "Native conversation";
  // Count UTF-16 units conservatively, and never split an emoji surrogate pair.
  let bounded = clean.slice(0, 87);
  if (/[\uD800-\uDBFF]$/.test(bounded)) bounded = bounded.slice(0, -1);
  return `${bounded} [${suffix}]`;
}

export function createDiscordMirrorThreads(options: {
  store: NativeStore;
  url: string;
  botToken: () => string | undefined;
  signal: AbortSignal;
  warn: (message: string) => void;
  fetch?: MirrorFetch;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}) {
  const send = options.fetch ?? fetch;
  const wait = options.wait ?? ((ms, signal) => setTimeout(ms, undefined, { signal }));
  const inFlight = new Map<string, Promise<string | null>>();
  let blockedUntil = 0;

  async function request(
    method: "GET" | "POST" | "PATCH",
    url: string,
    token?: string,
    body?: object,
    current: () => boolean = () => true,
  ) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (options.signal.aborted || !current()) return { status: 0, reply: null };
      const pause = Math.max(0, blockedUntil - Date.now());
      if (pause > 30_000) return { status: 0, reply: null };
      const waited = await Result.tryPromise({
        try: () => wait(pause, options.signal),
        catch: () => null,
      });
      if (waited.isErr()) return { status: 0, reply: null };
      if (options.signal.aborted || !current()) return { status: 0, reply: null };
      const captured = await Result.tryPromise({
        try: async () => {
          const response = await send(url, {
            method,
            redirect: "error",
            signal: AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]),
            headers: {
              ...(token ? { Authorization: `Bot ${token}` } : {}),
              ...(body ? { "Content-Type": "application/json" } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
          const reply = await readDiscordMirrorReply(response);
          return {
            status: response.status,
            reply,
            retry: response.headers.get("retry-after"),
            remaining: response.headers.get("x-ratelimit-remaining"),
            reset: response.headers.get("x-ratelimit-reset-after"),
          };
        },
        catch: () => null,
      });
      const response = captured.match({ ok: (value) => value, err: () => null });
      if (!response) return null;
      const reset = Number(response.reset);
      if (response.remaining === "0" && Number.isFinite(reset) && reset > 0)
        blockedUntil = Date.now() + reset * 1000;
      if (response.status === 429) {
        const seconds = response.reply?.retry_after ?? Number(response.retry ?? 1);
        blockedUntil =
          Date.now() + (Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000);
        if (attempt === 2 || blockedUntil - Date.now() > 30_000) return response;
        continue;
      }
      if (response.status >= 500 && method !== "POST") {
        blockedUntil = Date.now() + 250 * 2 ** attempt;
        continue;
      }
      return response;
    }
    return null;
  }

  async function continueThread(id: string, parentId: string, token: string) {
    if (!/^\d{1,20}$/.test(id)) return null;
    const url = `https://discord.com/api/v10/channels/${id}`;
    const response = await request("GET", url, token);
    const thread = response?.reply;
    if (
      !response ||
      response.status !== 200 ||
      thread?.id !== id ||
      thread.type !== 11 ||
      thread.parent_id !== parentId ||
      !thread.thread_metadata
    ) {
      options.warn("Native Discord mirror child unavailable; mapping retained, update dropped");
      return null;
    }
    if (thread.thread_metadata.locked) {
      options.warn("Native Discord mirror child locked; mapping retained, update dropped");
      return null;
    }
    if (!thread.thread_metadata.archived) return id;
    const reopened = await request("PATCH", url, token, { archived: false });
    if (
      reopened?.status === 200 &&
      reopened.reply?.id === id &&
      reopened.reply.thread_metadata?.archived === false
    )
      return id;
    options.warn("Native Discord mirror child could not reopen; mapping retained, update dropped");
    return null;
  }

  async function route(
    nativeThreadId: string,
    title: string,
    expectedThreadId?: string,
    current: () => boolean = () => true,
  ): Promise<string | null> {
    const token = options.botToken();
    if (!token) {
      options.warn(
        "Native Discord mirror threaded routing requires the configured Discord bot credential; update dropped",
      );
      return null;
    }
    // Resolve on delivery: moving the same webhook to another channel changes the destination.
    const webhook = await request("GET", options.url);
    const webhookId = new URL(options.url).pathname.split("/").at(-2);
    const parentId = webhook?.reply?.channel_id;
    if (
      webhook?.status !== 200 ||
      webhook.reply?.id !== webhookId ||
      webhook.reply?.type !== 1 ||
      !parentId
    ) {
      options.warn("Native Discord mirror destination unavailable; update dropped");
      return null;
    }
    const parent = await request("GET", `https://discord.com/api/v10/channels/${parentId}`, token);
    if (parent?.status !== 200 || parent.reply?.id !== parentId || parent.reply.type !== 0) {
      options.warn(
        "Native Discord mirror requires an accessible Discord text parent channel; update dropped",
      );
      return null;
    }
    const destination = `${webhookId}:${parentId}`;
    const stored = options.store
      .readDiscordMirrorThread(destination, nativeThreadId)
      .match({ ok: (value) => ({ value }), err: () => null });
    if (!stored) {
      options.warn("Native Discord mirror routing storage unavailable; update dropped");
      return null;
    }
    if (expectedThreadId && stored.value?.discordThreadId !== expectedThreadId) {
      options.warn("Native Discord mirror destination changed; tracked message update dropped");
      return null;
    }
    if (stored.value?.discordThreadId)
      return continueThread(stored.value.discordThreadId, parentId, token);
    if (stored.value) {
      options.warn(
        "Native Discord mirror child creation unresolved; operator reconciliation required, update dropped",
      );
      return null;
    }
    if (!current() || options.signal.aborted) return null;
    const reserved = options.store
      .reserveDiscordMirrorThread(destination, nativeThreadId)
      .match({ ok: (value) => value, err: () => false });
    if (!reserved) {
      options.warn("Native Discord mirror child reservation unavailable; update dropped");
      return null;
    }
    // The durable NULL reservation survives a crash or an uncertain create. Never auto-create again.
    const created = await request(
      "POST",
      `https://discord.com/api/v10/channels/${parentId}/threads`,
      token,
      {
        name: discordMirrorThreadName(title, nativeThreadId),
        type: 11,
        auto_archive_duration: 1440,
      },
      current,
    );
    const child = created?.reply;
    if (
      created &&
      created.status >= 200 &&
      created.status < 300 &&
      child?.id &&
      child.type === 11 &&
      child.parent_id === parentId
    ) {
      const saved = options.store
        .settleDiscordMirrorThread(destination, nativeThreadId, child.id)
        .match({ ok: () => true, err: () => false });
      if (saved) return child.id;
      options.warn(
        "Native Discord mirror child mapping could not persist; operator reconciliation required, update dropped",
      );
      return null;
    }
    // A skipped send or confirmed client rejection proves that no child was created.
    if (created && (created.status === 0 || (created.status >= 400 && created.status < 500)))
      options.store
        .settleDiscordMirrorThread(destination, nativeThreadId, null)
        .match({ ok: () => undefined, err: () => undefined });
    options.warn(
      "Native Discord mirror child creation failed or unresolved; update dropped (unresolved reservations require operator reconciliation)",
    );
    return null;
  }

  function resolve(
    nativeThreadId: string,
    title: string,
    expectedThreadId?: string,
    current: () => boolean = () => true,
  ): Promise<string | null> {
    const key = `${nativeThreadId}:${expectedThreadId ?? ""}`;
    const existing = inFlight.get(key);
    if (existing) return existing;
    const pending = route(nativeThreadId, title, expectedThreadId, current).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, pending);
    return pending;
  }
  return { resolve };
}
