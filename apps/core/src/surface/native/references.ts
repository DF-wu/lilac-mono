import { Result } from "better-result";
import {
  referencedConversations,
  type ConversationReference,
} from "@stanley2058/lilac-client-protocol";
import type { NativeStore, NativeStoreResult } from "./store";
import type { NativeSurfaceStore } from "./store-surface";
import type { NativeExternalThreads } from "./search-external";
import { nativeFailure } from "./errors";

export class NativeReferences {
  constructor(
    private readonly store: NativeStore,
    private readonly surface: NativeSurfaceStore,
    private readonly external: NativeExternalThreads,
  ) {}

  resolve(userId: string, target: ConversationReference) {
    if (target.surface !== "native") return this.external.describeReference(userId, target);
    return this.store
      .authorizeThread(userId, target.sessionId)
      .map((thread) => ({ title: thread.title, conversationThreadId: thread.id }));
  }

  read(
    userId: string,
    input: { target: ConversationReference; cursor?: string; direction?: "before" | "after" },
  ) {
    if (input.target.surface !== "native") return this.external.readReference(userId, input);
    return Result.gen(function* () {
      const { target, cursor, direction } = input;
      const thread = yield* this.store.authorizeThread(userId, target.sessionId);
      const checkpoint = yield* this.store.getCheckpoint(userId, target.sessionId);
      const anchor = target.messageId
        ? yield* this.surface.readMessage(userId, target.sessionId, target.messageId)
        : null;
      if (anchor && !cursor) {
        const before = yield* this.surface.listMessages(userId, target.sessionId, {
          beforeMessageId: target.messageId,
          limit: 41,
        });
        const after = yield* this.surface.listMessages(userId, target.sessionId, {
          afterMessageId: target.messageId,
          limit: 41,
        });
        return Result.ok({
          title: thread.title,
          checkpoint,
          messages: [...before.slice(-40), anchor, ...after.slice(0, 40)].map((row) => ({
            ...row.message,
            metadata: { ...row.message.metadata, position: row.position },
          })),
          nextCursor: before.length > 40 ? before.at(-40)?.message.id : undefined,
          nextAfter: after.length > 40 ? after[39]?.message.id : undefined,
          messageFound: true,
        });
      }
      const rows = yield* this.surface.listMessages(userId, target.sessionId, {
        beforeMessageId: direction !== "after" ? cursor : undefined,
        afterMessageId: direction === "after" ? cursor : undefined,
        limit: 101,
      });
      const selected = direction === "after" ? rows.slice(0, 100) : rows.slice(-100);
      const messages = selected.map((row) => ({
        ...row.message,
        metadata: { ...row.message.metadata, position: row.position },
      }));
      return Result.ok({
        title: thread.title,
        checkpoint,
        messages,
        nextCursor: direction === "after" || rows.length > 100 ? messages[0]?.id : undefined,
        nextAfter:
          (direction !== "after" && !!cursor) || (direction === "after" && rows.length > 100)
            ? messages.at(-1)?.id
            : undefined,
        messageFound: !target.messageId || anchor !== null,
      });
    }, this);
  }

  expand(userId: string, text: string): NativeStoreResult<string> {
    const references = referencedConversations(text);
    if (!references.length) return Result.ok(text);
    const context: string[] = [];
    for (const target of references) {
      const resolution = this.coordinates(userId, target).match({
        ok: (value) => value,
        err: () => null,
      });
      context.push(JSON.stringify(resolution ?? { ...target, unavailable: true }));
    }
    return Result.ok(`${text}\n\nConversation references:\n${context.join("\n")}`);
  }

  private coordinates(
    userId: string,
    target: ConversationReference,
  ): NativeStoreResult<ConversationReference & { conversationThreadId?: string }> {
    if (target.surface !== "native")
      return this.external
        .resolveReference(userId, target)
        .map((resolved) => ({ ...target, ...resolved }));
    return Result.gen(function* () {
      yield* this.store.authorizeThread(userId, target.sessionId);
      if (target.messageId) {
        const message = yield* this.surface.readMessage(userId, target.sessionId, target.messageId);
        if (!message) return Result.err(nativeFailure("not-found", "Message is unavailable"));
      }
      return Result.ok({
        ...target,
        ...(target.messageId ? { conversationThreadId: target.sessionId } : {}),
      });
    }, this);
  }
}
