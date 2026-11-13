import { setTimeout } from "node:timers/promises";
import { Result } from "better-result";
import { z } from "zod";

export type MirrorFetch = (url: string, init: RequestInit) => Promise<Response>;
export type MirrorFile = { name: string; bytes: Uint8Array; mediaType: string };
const replySchema = z.object({
  id: z
    .string()
    .regex(/^\d{1,20}$/)
    .optional(),
  channel_id: z
    .string()
    .regex(/^\d{1,20}$/)
    .optional(),
  parent_id: z
    .string()
    .regex(/^\d{1,20}$/)
    .nullable()
    .optional(),
  type: z.number().int().optional(),
  thread_metadata: z.object({ archived: z.boolean(), locked: z.boolean() }).optional(),
  retry_after: z.number().nonnegative().optional(),
});

export function decodeDiscordMirrorReply(value: unknown) {
  const decoded = replySchema.safeParse(value);
  return decoded.success ? decoded.data : null;
}

export function discordMirrorWebhookUrl(value?: string): string | undefined {
  if (!value || !URL.canParse(value)) return;
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "discord.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return;
  if (!/^\/api\/(?:v10\/)?webhooks\/\d{1,20}\/[A-Za-z0-9_-]+$/.test(url.pathname)) return;
  return `https://discord.com${url.pathname.replace(/^\/api\/(?!v10\/)/, "/api/v10/")}`;
}

export async function readDiscordMirrorReply(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  let length = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > 64 * 1024) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk.value);
  }
  const parsed = Result.try({
    try: (): unknown => JSON.parse(Buffer.concat(chunks).toString("utf8")),
    catch: () => null,
  });
  return parsed.match({ ok: decodeDiscordMirrorReply, err: () => null });
}

export function createDiscordMirrorWebhook(options: {
  url: string;
  signal: AbortSignal;
  warn: (message: string) => void;
  fetch?: MirrorFetch;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}) {
  const send = options.fetch ?? fetch;
  const wait = options.wait ?? ((ms, signal) => setTimeout(ms, undefined, { signal }));
  let blockedUntil = 0;
  async function request(
    method: "POST" | "PATCH" | "DELETE",
    id: string | undefined,
    content: string,
    files: MirrorFile[] = [],
    current: () => boolean = () => true,
    threadId?: string,
  ): Promise<string | null> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (options.signal.aborted) return null;
      const pause = Math.max(0, blockedUntil - Date.now());
      if (pause > 30_000) {
        options.warn("Native Discord mirror rate limit exceeds delivery budget; update dropped");
        return null;
      }
      const waited = await Result.tryPromise({
        try: () => wait(pause, options.signal),
        catch: () => null,
      });
      if (waited.isErr()) return null;
      if (!current() || options.signal.aborted) return null;
      const payload = {
        content,
        allowed_mentions: { parse: [], users: [], roles: [], replied_user: false },
        flags: 4,
        attachments: files.map((file, index) => ({ id: index, filename: file.name })),
      };
      const form = new FormData();
      form.set("payload_json", JSON.stringify(payload));
      for (const [index, file] of files.entries())
        form.set(
          `files[${index}]`,
          new Blob([Uint8Array.from(file.bytes)], { type: file.mediaType }),
          file.name,
        );
      const url = new URL(options.url);
      if (id) url.pathname += `/messages/${id}`;
      if (method === "POST") url.searchParams.set("wait", "true");
      if (threadId) url.searchParams.set("thread_id", threadId);
      const captured = await Result.tryPromise({
        try: async () => {
          const response = await send(url.toString(), {
            method,
            redirect: "error",
            signal: AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]),
            ...(method === "DELETE" ? {} : { body: form }),
          });
          const reply = await readDiscordMirrorReply(response);
          return {
            status: response.status,
            reply,
            remaining: response.headers.get("x-ratelimit-remaining"),
            reset: response.headers.get("x-ratelimit-reset-after"),
            retry: response.headers.get("retry-after"),
          };
        },
        catch: () => new Error("Native Discord mirror transport failed"),
      });
      const response = captured.match({ ok: (value) => value, err: () => null });
      if (!response) {
        // An uncertain POST may already exist on Discord; never blindly repeat it.
        options.warn("Native Discord mirror request failed; update dropped");
        return null;
      }
      const reset = Number(response.reset);
      if (response.remaining === "0" && Number.isFinite(reset) && reset > 0)
        blockedUntil = Date.now() + reset * 1000;
      if (response.status >= 200 && response.status < 300)
        return method === "DELETE" ? (id ?? null) : (response.reply?.id ?? null);
      if (method === "DELETE" && response.status === 404) return id ?? null;
      if (response.status === 429) {
        const seconds = response.reply?.retry_after ?? Number(response.retry ?? 1);
        blockedUntil =
          Date.now() + (Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000);
        continue;
      }
      if (response.status >= 500 && method !== "POST") {
        blockedUntil = Date.now() + 250 * 2 ** attempt;
        continue;
      }
      options.warn("Native Discord mirror HTTP request rejected; update dropped");
      return null;
    }
    options.warn("Native Discord mirror retry budget exhausted; update dropped");
    return null;
  }
  return { request };
}
