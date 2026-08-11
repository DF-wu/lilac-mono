import { isRecord } from "@stanley2058/lilac-utils";
import { Result } from "better-result";

import type { MsgRef, SurfaceMessage } from "../../types";

import type { SurfaceAdapter, SurfaceOperationResult } from "../../adapter";
import { buildDiscordRichTextFromContentAndEmbeds } from "../../discord/discord-embed-text";
import { normalizeDiscordRaw } from "../../discord/discord-raw-normalizer";

import { splitByDiscordWindowOldestToNewest } from "../../discord/merge-window";

import type { DiscordAttachmentMeta, MergedChunk, ReplyChainMessage } from "./types";

const DEFAULT_MENTION_BLOCK_LIMIT = 50;

function compareDiscordSnowflakeLike(a: string, b: string): number {
  try {
    const ai = BigInt(a);
    const bi = BigInt(b);
    if (ai < bi) return -1;
    if (ai > bi) return 1;
    return 0;
  } catch {
    return a.localeCompare(b);
  }
}

export function getForwardSnapshotTextFromRaw(raw: unknown): string | undefined {
  const snapshot = normalizeDiscordRaw(raw)?.forwardSnapshot;
  if (!snapshot) return undefined;

  const fromSnapshot = buildDiscordRichTextFromContentAndEmbeds({
    content: snapshot.content,
    embeds: snapshot.embeds,
    mode: "inbound",
  });

  return fromSnapshot.length > 0 ? fromSnapshot : undefined;
}

function extractDiscordAttachmentsFromRaw(raw: unknown): DiscordAttachmentMeta[] {
  const discordRaw = normalizeDiscordRaw(raw);
  const snapshotAttachments = discordRaw?.forwardSnapshot?.attachments;
  if (snapshotAttachments && snapshotAttachments.length > 0) return snapshotAttachments;
  return discordRaw?.attachments ?? [];
}

function getReferenceFromRaw(raw: unknown): {
  messageId?: string;
  channelId?: string;
} {
  const replyReference = normalizeDiscordRaw(raw)?.replyReference;
  return replyReference ?? {};
}

export function toReplyChainMessage(
  msg: SurfaceMessage,
  opts?: {
    overrideText?: string;
    authorNameFallback?: string;
  },
): ReplyChainMessage {
  const discordRaw = isRecord(msg.raw) && isRecord(msg.raw.discord) ? msg.raw.discord : null;
  const isChat =
    discordRaw && typeof discordRaw.isChat === "boolean" ? discordRaw.isChat : undefined;
  let text = opts?.overrideText;
  if (text === undefined) {
    text =
      msg.text.trim().length > 0 ? msg.text : (getForwardSnapshotTextFromRaw(msg.raw) ?? msg.text);
  }

  return {
    messageId: msg.ref.messageId,
    authorId: msg.userId,
    authorName: msg.userName ?? opts?.authorNameFallback ?? `user_${msg.userId}`,
    ts: msg.ts,
    text,
    attachments: extractDiscordAttachmentsFromRaw(msg.raw),
    ...(isChat === undefined ? {} : { isChat }),
    replyReference: getReferenceFromRaw(msg.raw),
  };
}

function dedupeByMessageId(list: readonly ReplyChainMessage[]): ReplyChainMessage[] {
  const out: ReplyChainMessage[] = [];
  const seen = new Set<string>();
  for (const m of list) {
    if (seen.has(m.messageId)) continue;
    seen.add(m.messageId);
    out.push(m);
  }
  return out;
}

async function mapWithConcurrency<T, R>(input: {
  items: readonly T[];
  concurrency: number;
  run: (item: T, index: number) => Promise<R>;
}): Promise<R[]> {
  const { items, run } = input;
  const concurrency = Math.max(1, Math.floor(input.concurrency));

  const out = Array.from({ length: items.length }) as R[];
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= items.length) return;

      out[i] = await run(items[i]!, i);
    }
  });

  await Promise.all(workers);
  return out;
}

async function readMessagesByRefs(input: {
  adapter: SurfaceAdapter;
  refs: readonly MsgRef[];
  concurrency?: number;
}): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
  const { adapter, refs } = input;
  if (refs.length === 0) return Result.ok([]);

  const pairs = await mapWithConcurrency({
    items: refs,
    concurrency: input.concurrency ?? 8,
    run: async (ref) => {
      return { ref, msg: await adapter.readMsg(ref) };
    },
  });

  const byKey = new Map<string, SurfaceMessage>();
  for (const pair of pairs) {
    if (pair.msg.status === "error") return Result.err(pair.msg.error);
    if (!pair.msg.value) continue;
    const key = `${pair.msg.value.ref.channelId}:${pair.msg.value.ref.messageId}`;
    byKey.set(key, pair.msg.value);
  }

  const out: SurfaceMessage[] = [];
  for (const ref of refs) {
    const key = `${ref.channelId}:${ref.messageId}`;
    const msg = byKey.get(key);
    if (msg) out.push(msg);
  }

  return Result.ok(out);
}

export async function resolveMergeBlockEndingAt(
  adapter: SurfaceAdapter,
  triggerMsg: SurfaceMessage,
  opts?: { limit?: number },
): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
  const limit = opts?.limit ?? DEFAULT_MENTION_BLOCK_LIMIT;

  const planned = await adapter.planMergeBlockEndingAt(triggerMsg.ref, { lookbackLimit: limit });
  if (planned.status === "ok") {
    const plannedRefs = planned.value;

    const refs = plannedRefs.filter((r) => r.channelId === triggerMsg.ref.channelId);
    if (refs.length > 0) {
      const listed = await readMessagesByRefs({
        adapter,
        refs,
        concurrency: 8,
      });
      if (listed.status === "error") return listed;
      const list = listed.value;

      const plannedRefKeys = new Set(refs.map((r) => `${r.channelId}:${r.messageId}`));
      const resolvedRefKeys = new Set(list.map((m) => `${m.ref.channelId}:${m.ref.messageId}`));
      const allResolved =
        plannedRefKeys.size === resolvedRefKeys.size &&
        [...plannedRefKeys].every((key) => resolvedRefKeys.has(key));

      if (!list.some((m) => m.ref.messageId === triggerMsg.ref.messageId)) {
        list.push(triggerMsg);
      }

      list.sort((a, b) => {
        if (a.ts !== b.ts) return a.ts - b.ts;
        return compareDiscordSnowflakeLike(a.ref.messageId, b.ref.messageId);
      });

      if (allResolved && list.length > 0) {
        return Result.ok(list);
      }
    }
  }

  const context = await adapter.getReplyContext(triggerMsg.ref, { limit });
  if (context.status === "error") return Result.ok([triggerMsg]);
  const ctx = context.value;

  const list = ctx.length > 0 ? ctx.slice() : [triggerMsg];

  if (!list.some((m) => m.ref.messageId === triggerMsg.ref.messageId)) {
    list.push(triggerMsg);
  }

  list.sort((a, b) => a.ts - b.ts);

  const triggerIndex = list.findIndex((m) => m.ref.messageId === triggerMsg.ref.messageId);
  if (triggerIndex < 0) return Result.ok([triggerMsg]);

  const authorId = triggerMsg.userId;

  let runStart = triggerIndex;
  for (let i = triggerIndex - 1; i >= 0; i--) {
    const prev = list[i]!;
    if (prev.userId !== authorId) break;
    runStart = i;
  }

  const run = list.slice(runStart, triggerIndex + 1);
  const groups = splitByDiscordWindowOldestToNewest(
    run.map((m) => ({
      message: m,
      authorId: m.userId,
      ts: m.ts,
      hardBreakBefore: typeof toReplyChainMessage(m).replyReference.messageId === "string",
    })),
  );
  const groupEndingAtTrigger = groups[groups.length - 1] ?? [];
  return Result.ok(groupEndingAtTrigger.map((m) => m.message));
}

export function findEarliestReplyAnchor(block: readonly SurfaceMessage[]): SurfaceMessage | null {
  for (const m of block) {
    const ref = getReferenceFromRaw(m.raw);
    if (ref.messageId) return m;
  }
  return null;
}

export async function fetchReplyChainFrom(
  adapter: SurfaceAdapter,
  opts: {
    platform: "discord";
    botUserId: string;
    botName: string;
    trigger: { type: "mention" | "reply"; msgRef: MsgRef };
    startMsgRef: MsgRef;
    /** Maximum number of merged Discord UI groups to traverse. */
    maxDepth?: number;
  },
): Promise<SurfaceOperationResult<ReplyChainMessage[]>> {
  const maxGroupCount = opts.maxDepth ?? 20;

  const planned = await adapter.planReplyChain(opts.startMsgRef, { maxDepth: maxGroupCount });
  if (planned.status === "ok") {
    const plannedRefs = planned.value;

    const inSessionRefs: MsgRef[] = [];
    for (const ref of plannedRefs) {
      if (ref.channelId !== opts.trigger.msgRef.channelId) break;
      inSessionRefs.push(ref);
    }

    if (inSessionRefs.length > 0) {
      const groups = await mapWithConcurrency({
        items: inSessionRefs,
        concurrency: 4,
        run: async (cursorRef) => {
          const plannedBlock = await adapter.planMergeBlockEndingAt(cursorRef, {
            lookbackLimit: DEFAULT_MENTION_BLOCK_LIMIT,
          });
          const blockRefs = plannedBlock.status === "ok" ? plannedBlock.value : [cursorRef];

          const inChannelBlockRefs = blockRefs.filter(
            (ref) => ref.channelId === opts.trigger.msgRef.channelId,
          );

          const refsToRead = inChannelBlockRefs.length > 0 ? inChannelBlockRefs : [cursorRef];

          const messages = await readMessagesByRefs({
            adapter,
            refs: refsToRead,
            concurrency: 8,
          });
          if (messages.status === "error") return messages;

          const plannedRefKeys = new Set(refsToRead.map((r) => `${r.channelId}:${r.messageId}`));
          const resolvedRefKeys = new Set(
            messages.value.map((m) => `${m.ref.channelId}:${m.ref.messageId}`),
          );
          const allResolved =
            plannedRefKeys.size === resolvedRefKeys.size &&
            [...plannedRefKeys].every((key) => resolvedRefKeys.has(key));

          if (allResolved && messages.value.length > 0) return messages;

          const cursor = await adapter.readMsg(cursorRef);
          if (cursor.status === "error") return Result.err(cursor.error);
          if (!cursor.value) return Result.ok([]);

          return await resolveMergeBlockEndingAt(adapter, cursor.value);
        },
      });

      for (const group of groups) {
        if (group.status === "error") return Result.err(group.error);
      }
      const flattened = groups.flatMap((group) => (group.status === "ok" ? group.value : []));
      if (flattened.length > 0) {
        flattened.sort((a, b) => {
          if (a.ts !== b.ts) return a.ts - b.ts;
          return compareDiscordSnowflakeLike(a.ref.messageId, b.ref.messageId);
        });

        return Result.ok(dedupeByMessageId(flattened.map((m) => toReplyChainMessage(m))));
      }
    }
  }

  const groupsNewestToOldest: ReplyChainMessage[][] = [];
  const seenMessageIds = new Set<string>();

  const initial = await adapter.readMsg(opts.startMsgRef);
  if (initial.status === "error") return Result.err(initial.error);
  let cur = initial.value;
  if (!cur) return Result.ok([]);

  for (let depth = 0; depth < maxGroupCount && cur; depth++) {
    const cursor = cur;

    if (seenMessageIds.has(cursor.ref.messageId)) break;

    const groupResult = await resolveMergeBlockEndingAt(adapter, cursor);
    if (groupResult.status === "error") return Result.err(groupResult.error);
    const group = groupResult.value;
    if (group.length === 0) break;

    for (const m of group) {
      seenMessageIds.add(m.ref.messageId);
    }

    groupsNewestToOldest.push(group.map((m) => toReplyChainMessage(m)));

    const ref = toReplyChainMessage(group[0]!).replyReference;
    if (!ref.messageId) break;

    // Stop if the reference crosses sessions.
    if (ref.channelId && ref.channelId !== opts.trigger.msgRef.channelId) break;

    const next = await adapter.readMsg({
      platform: opts.platform,
      channelId: opts.trigger.msgRef.channelId,
      messageId: ref.messageId,
    });
    if (next.status === "error") return Result.err(next.error);
    cur = next.value;
  }

  return Result.ok(dedupeByMessageId(groupsNewestToOldest.slice().reverse().flat()));
}

export async function fetchMentionThreadContext(
  adapter: SurfaceAdapter,
  params: {
    platform: "discord";
    botUserId: string;
    botName: string;
    triggerMsg: SurfaceMessage;
    maxDepth?: number;
  },
): Promise<SurfaceOperationResult<ReplyChainMessage[]>> {
  const blockResult = await resolveMergeBlockEndingAt(adapter, params.triggerMsg);
  if (blockResult.status === "error") return Result.err(blockResult.error);
  const block = blockResult.value;
  const anchor = findEarliestReplyAnchor(block);

  const startMsgRef = anchor?.ref ?? params.triggerMsg.ref;

  const chain = await fetchReplyChainFrom(adapter, {
    platform: params.platform,
    botUserId: params.botUserId,
    botName: params.botName,
    trigger: { type: "mention", msgRef: params.triggerMsg.ref },
    startMsgRef,
    maxDepth: params.maxDepth,
  });
  if (chain.status === "error") return Result.err(chain.error);

  const blockMessages = block.map((m) => {
    return toReplyChainMessage(m);
  });

  const combined = dedupeByMessageId([...chain.value, ...blockMessages]);

  combined.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    // Stable-ish tie-breaker.
    return a.messageId.localeCompare(b.messageId);
  });

  return Result.ok(combined);
}

export function mergeChainByDiscordWindow(
  chainOldestToNewest: readonly ReplyChainMessage[],
  hardBreakBeforeMessageIds: ReadonlySet<string> = new Set(),
): MergedChunk[] {
  if (chainOldestToNewest.length === 0) return [];

  const groups = splitByDiscordWindowOldestToNewest(
    chainOldestToNewest.map((m) => ({
      message: m,
      authorId: m.authorId,
      ts: m.ts,
      hardBreakBefore:
        typeof m.replyReference.messageId === "string" ||
        hardBreakBeforeMessageIds.has(m.messageId),
    })),
  );

  return groups.map((group) => {
    const messages = group.map((m) => m.message);
    const first = messages[0]!;
    const last = messages[messages.length - 1]!;

    return {
      messageIds: messages.map((m) => m.messageId),
      authorId: first.authorId,
      authorName: first.authorName,
      tsStart: first.ts,
      tsEnd: last.ts,
      text: messages.map((m) => m.text).join("\n\n"),
      attachments: messages.flatMap((m) => m.attachments),
    };
  });
}
