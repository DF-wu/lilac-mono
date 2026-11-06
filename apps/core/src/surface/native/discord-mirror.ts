import type { DisplayMessage, DisplayPart } from "@stanley2058/lilac-client-protocol";
import { Result } from "better-result";
import { readDiscordMirrorAttachment } from "./discord-mirror-attachment";
import type { NativeResourceService } from "./resources";
import type { NativeDisplayCommit, NativeStore } from "./store";
import {
  createDiscordMirrorWebhook,
  discordMirrorWebhookUrl,
  type MirrorFetch,
  type MirrorFile,
} from "./discord-mirror-webhook";

type VisiblePart = Extract<DisplayPart, { type: "text" | "data-resource" }>;
type MirroredMessage = {
  threadId: string;
  turnId: string;
  id: string;
  author: string;
  parts: (VisiblePart | null)[];
  ids: string[];
  fingerprint?: string;
  removed: boolean;
  revision: number;
};

function visiblePart(part: DisplayPart): VisiblePart | null {
  if (part.type === "text") return { type: "text", text: part.text.slice(0, 65_536) };
  if (part.type === "data-resource" && part.data.state === "ready") return part;
  return null;
}

function publicText(text: string): string {
  return text
    .replace(/resource:\/\/[^\s<>\])]+/gi, "[native resource]")
    .replace(/(?:https?:\/\/[^\s/]+)?\/api\/(?:files|resources)\/[^\s<>\])]+/gi, "[native file]");
}

function chunks(text: string): string[] {
  const result: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    let end = Math.min(text.length, offset + 1500);
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end--;
    result.push(text.slice(offset, end));
    offset = end;
  }
  return result;
}

export function createNativeDiscordMirror(options: {
  store: NativeStore;
  resources: Pick<NativeResourceService, "scopedAccess">;
  webhookUrl?: string;
  warn: (message: string) => void;
  fetch?: MirrorFetch;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}) {
  const url = discordMirrorWebhookUrl(options.webhookUrl);
  if (!url) {
    if (options.webhookUrl)
      options.warn("Native Discord mirror disabled: invalid webhook configuration");
    return { drain: async () => {}, stop: async () => {} };
  }
  const abort = new AbortController();
  const activatedAt = Date.now();
  const webhook = createDiscordMirrorWebhook({ ...options, url, signal: abort.signal });
  const messages = new Map<string, MirroredMessage>();
  const pending = new Map<string, MirroredMessage>();
  let active: Promise<void> | undefined;

  function enqueue(key: string, message: MirroredMessage) {
    if (abort.signal.aborted) return;
    if (!pending.has(key) && pending.size >= 128) {
      options.warn("Native Discord mirror backlog full; update dropped");
      return;
    }
    let remaining = 65_536;
    message.parts = message.parts.map((part) => {
      if (part?.type !== "text") return part;
      const text = part.text.slice(0, remaining);
      remaining -= text.length;
      return { type: "text", text };
    });
    pending.set(key, message);
    message.revision++;
    if (!active) active = Promise.resolve().then(observe);
  }

  function insert(threadId: string, turnId: string, message: DisplayMessage) {
    if (message.role === "system" || message.metadata?.externalRunId) return;
    const key = `${threadId}:${message.id}`;
    const existing = messages.get(key);
    // Replayed semantic output preserves its original creation time, even if projected after boot.
    if (
      !existing &&
      (message.metadata?.createdAt === undefined || message.metadata.createdAt < activatedAt)
    )
      return;
    const authorId = message.metadata?.authorId;
    if (message.role === "user") {
      const user = authorId
        ? options.store.getUser(authorId).match({ ok: (value) => value, err: () => null })
        : null;
      if (!user || user.role === "service") return;
    }
    if (message.role === "assistant" && authorId && authorId !== "lilac") return;
    if (existing && !existing.removed) return;
    if (messages.size >= 512) {
      const oldest = messages.keys().next().value;
      if (oldest) messages.delete(oldest);
    }
    const entry: MirroredMessage = {
      threadId,
      turnId,
      id: message.id,
      author: message.role === "user" ? `human:${authorId}` : "assistant:lilac",
      parts: message.parts.slice(0, 128).map(visiblePart),
      ids: existing?.ids ?? [],
      removed: false,
      revision: existing?.revision ?? 0,
    };
    messages.set(key, entry);
    enqueue(key, entry);
  }

  function apply(commit: NativeDisplayCommit) {
    const thread = options.store
      .getThreadRecord(commit.threadId)
      .match({ ok: (value) => value, err: () => null });
    // Agent streams and external surface conversations are never native thread records.
    if (!thread) return;
    if (commit.reset) {
      for (const [key, entry] of messages) {
        if (entry.threadId !== thread.id) continue;
        const current = thread.deleted
          ? null
          : options.store
              .readDisplayMessage(thread.starterId, thread.id, entry.id)
              .match({ ok: (value) => value, err: () => null });
        entry.parts = current ? current.parts.slice(0, 128).map(visiblePart) : [];
        entry.removed = current === null;
        enqueue(key, entry);
      }
      return;
    }
    if (thread.deleted) return;
    for (const change of commit.changes) {
      if (change.kind === "insert" && change.slot.kind === "ready") {
        for (const message of change.slot.messages) insert(thread.id, change.slot.turnId, message);
        continue;
      }
      if (change.kind === "append-message") {
        insert(thread.id, change.turnId, change.message);
        continue;
      }
      if (!("messageId" in change)) continue;
      const key = `${thread.id}:${change.messageId}`;
      const entry = messages.get(key);
      if (!entry) continue; // Never backfill an old message first encountered through an edit.
      switch (change.kind) {
        case "set-part":
          if (change.partIndex >= 128) continue;
          entry.parts[change.partIndex] = visiblePart(change.part);
          break;
        case "append-text": {
          const part = entry.parts[change.partIndex];
          if (part?.type !== "text") continue;
          entry.parts[change.partIndex] = {
            type: "text",
            text: (part.text + change.text).slice(0, 65_536),
          };
          break;
        }
        case "truncate-parts":
          entry.parts.length = Math.min(entry.parts.length, change.length);
          break;
        case "remove-message":
          entry.parts = [];
          entry.removed = true;
          break;
        default:
          continue;
      }
      enqueue(key, entry);
    }
  }

  async function attachments(entry: MirroredMessage, parts: (VisiblePart | null)[]) {
    const files: MirrorFile[] = [];
    const thread = options.store
      .getThreadRecord(entry.threadId)
      .match({ ok: (value) => value, err: () => null });
    let remaining = 8 * 1024 * 1024;
    let omitted = false;
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]);
    for (const part of parts) {
      if (part?.type !== "data-resource") continue;
      const upload = thread
        ? options.store
            .readUpload(thread.starterId, part.data.resourceId)
            .match({ ok: (value) => value, err: () => null })
        : null;
      if (
        !upload ||
        upload.threadId !== entry.threadId ||
        upload.state !== "ready" ||
        !upload.resourceUri ||
        upload.size > remaining ||
        files.length >= 10
      ) {
        omitted = true;
        continue;
      }
      const bytes = await readDiscordMirrorAttachment(
        options.resources.scopedAccess(upload.ownerId),
        upload.resourceUri,
        remaining,
        signal,
      );
      if (!bytes || bytes.byteLength > remaining) {
        omitted = true;
        continue;
      }
      remaining -= bytes.byteLength;
      files.push({
        name:
          publicText(upload.filename)
            .replace(/[\\/\p{Cc}]/gu, "_")
            .slice(-128) || "attachment",
        mediaType: upload.mediaType,
        bytes,
      });
    }
    return { files, omitted };
  }

  async function deliver(entry: MirroredMessage) {
    const revision = entry.revision;
    const current = () =>
      messages.get(`${entry.threadId}:${entry.id}`) === entry && entry.revision === revision;
    const parts = entry.parts.slice();
    const fingerprint = JSON.stringify(parts);
    if (entry.fingerprint === fingerprint) return;
    const { files, omitted } = await attachments(entry, parts);
    if (!current()) return;
    const text = publicText(
      parts.flatMap((part) => (part?.type === "text" ? [part.text] : [])).join(""),
    ).slice(0, 65_536);
    const body = `${text}${omitted ? "\n[Attachment unavailable or exceeds mirror limits]" : ""}`;
    const content = chunks(body);
    if (files.length && content.length === 0) content.push("[Attachment]");
    for (let index = 0; index < content.length; index++) {
      const header = `[native:${entry.threadId} | ${entry.author} | ${entry.id} | ${index + 1}]\n`;
      const id = await webhook.request(
        entry.ids[index] ? "PATCH" : "POST",
        entry.ids[index],
        header + content[index],
        index === 0 ? files : [],
        current,
      );
      if (!id) return;
      entry.ids[index] = id;
    }
    while (entry.ids.length > content.length) {
      const id = entry.ids.at(-1)!;
      if (!(await webhook.request("DELETE", id, "", [], current))) return;
      entry.ids.pop();
    }
    entry.fingerprint = fingerprint;
  }

  async function run() {
    for (const [key, entry] of pending) {
      pending.delete(key);
      if (abort.signal.aborted) return;
      await deliver(entry);
      if (entry.removed && !pending.has(key)) messages.delete(key);
    }
  }

  async function observe() {
    const captured = await Result.tryPromise({
      try: run,
      catch: () => new Error("Native Discord mirror delivery failed"),
    });
    captured.match({
      ok: () => undefined,
      err: () => options.warn("Native Discord mirror delivery failed; update dropped"),
    });
    active = undefined;
    if (pending.size && !abort.signal.aborted) active = observe();
  }

  const unsubscribe = options.store.subscribeCommittedDisplay((commit) => {
    const captured = Result.try({
      try: () => apply(commit),
      catch: () => new Error("Native Discord mirror projection failed"),
    });
    captured.match({
      ok: () => undefined,
      err: () => options.warn("Native Discord mirror projection failed; update dropped"),
    });
  });
  async function drain() {
    while (active) await active;
  }
  return {
    drain,
    async stop() {
      unsubscribe();
      abort.abort();
      pending.clear();
      await drain();
      messages.clear();
    },
  };
}
