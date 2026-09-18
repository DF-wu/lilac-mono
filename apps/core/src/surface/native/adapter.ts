import { randomUUID } from "node:crypto";
import { displayMessageSchema, type DisplayMessage } from "@stanley2058/lilac-client-protocol";
import { Result } from "better-result";
import type { DurableResolvedModelRequest } from "@stanley2058/lilac-utils";
import {
  SurfaceInvalidInput,
  SurfaceMessageNotFound,
  SurfacePermissionDenied,
  SurfacePlatformMismatch,
  SurfaceSessionMismatch,
  SurfaceUnavailable,
  type StartOutputOpts,
  type StartTypingOpts,
  type SurfaceAdapter,
  type SurfaceMergeBlockPlanOptions,
  type SurfaceOperation,
  type SurfaceOperationError,
  type SurfaceOperationResult,
  type SurfaceOutputPart,
  type SurfaceOutputPartDisposition,
  type SurfaceOutputResult,
  type SurfaceOutputStream,
  type SurfaceReplyChainPlanOptions,
  type SurfaceSendPreparationInput,
  type TypingIndicatorSubscription,
} from "../adapter";
import type {
  ContentOpts,
  LimitOpts,
  MsgRef,
  NativeMsgRef,
  NativeSessionRef,
  SendOpts,
  SessionRef,
  SurfaceMessage,
  SurfaceReactionDetail,
  SurfaceSelf,
  SurfaceSession,
  SurfaceSessionParticipantsResult,
} from "../types";
import type { NativeResourceService, NativeResourceError } from "./resources";
import type { NativeStore, NativeStoreError } from "./store";
import type { NativeSurfaceStore, NativeSurfaceMessage } from "./store-surface";

export type NativeAdapterRequest = {
  readonly principalId: string;
  readonly sourceThreadId: string;
  readonly requestId?: string;
};
export type NativeAdapterDependencies = {
  readonly store: NativeStore;
  readonly surface: NativeSurfaceStore;
  readonly resources?: Pick<NativeResourceService, "ingest">;
  readonly serviceUserId?: string;
  readonly shouldTriggerRun: () => boolean;
  readonly resolveModel?: (modelId?: string) => Result<DurableResolvedModelRequest, Error>;
  readonly streamingMode?: () => "paragraph" | "complete";
  readonly kick: (threadId: string) => void;
  readonly now?: () => number;
};

export function nativeSurfaceError(
  operation: SurfaceOperation,
  error: NativeStoreError | NativeResourceError,
): SurfaceOperationError {
  if (error._tag === "NativeUploadSettlementFailed")
    return new SurfaceUnavailable({
      platform: "native",
      operation,
      message: "Native resource upload could not be settled",
    });
  if (error._tag !== "NativeStoreFailure")
    return new SurfaceUnavailable({
      platform: "native",
      operation,
      message: "Native store could not read persisted data",
    });
  switch (error.code) {
    case "forbidden":
      return new SurfacePermissionDenied({ platform: "native", operation, message: error.message });
    case "not-found":
      return new SurfaceMessageNotFound({ platform: "native", operation, message: error.message });
    case "invalid":
    case "conflict":
    case "stale":
      return new SurfaceInvalidInput({
        platform: "native",
        operation,
        field: "input",
        message: error.message,
      });
    case "sqlite":
      return new SurfaceUnavailable({ platform: "native", operation, message: error.message });
  }
}

function nativeSession(
  operation: SurfaceOperation,
  ref: SessionRef,
): SurfaceOperationResult<NativeSessionRef> {
  if (ref.platform === "native") return Result.ok(ref);
  return Result.err(
    new SurfacePlatformMismatch({
      operation,
      refRole: "sessionRef",
      expectedPlatform: "native",
      receivedPlatform: ref.platform,
      message: "Expected a native thread",
    }),
  );
}
function nativeMessage(
  operation: SurfaceOperation,
  ref: MsgRef,
): SurfaceOperationResult<NativeMsgRef> {
  if (ref.platform === "native") return Result.ok(ref);
  return Result.err(
    new SurfacePlatformMismatch({
      operation,
      refRole: "msgRef",
      expectedPlatform: "native",
      receivedPlatform: ref.platform,
      message: "Expected a native message",
    }),
  );
}
function invalid(
  operation: SurfaceOperation,
  field: string,
  message: string,
): SurfaceOperationError {
  return new SurfaceInvalidInput({ platform: "native", operation, field, message });
}
export function isValidNativeDisplayMessage(message: DisplayMessage): boolean {
  return displayMessageSchema.safeParse(message).success;
}

function project(
  threadId: string,
  row: NativeSurfaceMessage,
  attachments: SurfaceMessage["attachments"] = [],
): SurfaceMessage {
  return {
    ref: { platform: "native", channelId: threadId, messageId: row.message.id },
    session: { platform: "native", channelId: threadId },
    userId: row.message.metadata?.authorId ?? "lilac",
    text: row.message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
    ts: row.message.metadata?.createdAt ?? 0,
    ...(attachments.length ? { attachments } : {}),
  };
}

export class NativeSurfaceAdapter implements SurfaceAdapter {
  private readonly serviceUserId: string;
  constructor(
    readonly dependencies: NativeAdapterDependencies,
    readonly request?: NativeAdapterRequest,
  ) {
    this.serviceUserId = dependencies.serviceUserId ?? "lilac";
  }
  forRequest(request: NativeAdapterRequest): NativeSurfaceAdapter {
    return new NativeSurfaceAdapter(this.dependencies, request);
  }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async getSelf(): Promise<SurfaceSelf> {
    return { platform: "native", userId: this.serviceUserId, userName: "Lilac" };
  }

  private principal(operation: SurfaceOperation): SurfaceOperationResult<NativeAdapterRequest> {
    const request = this.request;
    if (!request)
      return Result.err(
        new SurfacePermissionDenied({
          platform: "native",
          operation,
          message: "Native surface tools require authenticated request authority",
        }),
      );
    return this.dependencies.store
      .authorizeThread(request.principalId, request.sourceThreadId)
      .mapError((error) => nativeSurfaceError(operation, error))
      .andThen((thread) =>
        thread.starterId === request.principalId
          ? Result.ok(request)
          : Result.err(
              new SurfacePermissionDenied({
                platform: "native",
                operation,
                message: "Native agent authority must match the source thread starter",
              }),
            ),
      );
  }

  private projectMessage(
    principalId: string,
    threadId: string,
    row: NativeSurfaceMessage,
  ): SurfaceMessage {
    const attachments = row.message.parts.flatMap((part) => {
      if (part.type !== "data-resource" || part.data.state !== "ready") return [];
      return this.dependencies.store.readUpload(principalId, part.data.resourceId).match({
        ok: (upload) =>
          upload.resourceUri
            ? [
                {
                  url: upload.resourceUri,
                  filename: upload.filename,
                  mimeType: upload.mediaType,
                  size: upload.size,
                },
              ]
            : [],
        err: () => [],
      });
    });
    return project(threadId, row, attachments);
  }

  async listSessions(): Promise<SurfaceOperationResult<SurfaceSession[]>> {
    const adapter = this;
    return Result.gen(function* () {
      const request = yield* adapter.principal("list-sessions");
      const threads = yield* adapter.dependencies.store
        .listThreads(request.principalId, { limit: 100 })
        .mapError((error) => nativeSurfaceError("list-sessions", error));
      return Result.ok(
        threads.map((thread) => ({
          ref: { platform: "native" as const, channelId: thread.id },
          title: thread.title,
          kind: "thread" as const,
        })),
      );
    });
  }
  async listSessionParticipants(
    sessionRef: SessionRef,
    opts?: { limit?: number },
  ): Promise<SurfaceOperationResult<SurfaceSessionParticipantsResult>> {
    const adapter = this;
    return Result.gen(function* () {
      const ref = yield* nativeSession("list-session-participants", sessionRef);
      const request = yield* adapter.principal("list-session-participants");
      return adapter.dependencies.surface
        .participants(request.principalId, ref.channelId, opts?.limit)
        .mapError((error) => nativeSurfaceError("list-session-participants", error));
    });
  }
  async prepareSendMsg(
    sessionRef: SessionRef,
    input: SurfaceSendPreparationInput,
    opts?: SendOpts,
  ): Promise<SurfaceOperationResult<void>> {
    const adapter = this;
    return Result.gen(function* () {
      const ref = yield* nativeSession("send-message", sessionRef);
      const request = yield* adapter.principal("send-message");
      yield* adapter.dependencies.store
        .authorizeThread(request.principalId, ref.channelId, true)
        .mapError((error) => nativeSurfaceError("send-message", error));
      if (!(input.text?.trim() || input.attachmentCount || input.actionCount))
        return Result.err(
          invalid("send-message", "content", "A message requires text, attachments, or actions"),
        );
      if (
        (input.text?.length ?? 0) > 65_536 ||
        input.attachmentCount > 32 ||
        input.actionCount > 25
      )
        return Result.err(invalid("send-message", "content", "Message exceeds the display limits"));
      if (input.attachmentCount && !adapter.dependencies.resources)
        return Result.err(
          new SurfaceUnavailable({
            platform: "native",
            operation: "send-message",
            message: "Native resources are unavailable",
          }),
        );
      if (!opts?.replyTo) return Result.ok(undefined);
      const reply = yield* nativeMessage("send-message", opts.replyTo);
      if (reply.channelId !== ref.channelId)
        return Result.err(
          new SurfaceSessionMismatch({
            operation: "send-message",
            refRole: "replyTo",
            expectedSessionId: ref.channelId,
            receivedSessionId: reply.channelId,
            message: "Reply target belongs to another thread",
          }),
        );
      const message = yield* adapter.dependencies.surface
        .readMessage(request.principalId, ref.channelId, reply.messageId)
        .mapError((error) => nativeSurfaceError("send-message", error));
      if (!message)
        return Result.err(
          new SurfaceMessageNotFound({
            platform: "native",
            operation: "send-message",
            message: "Reply target is unavailable",
          }),
        );
      return Result.ok(undefined);
    });
  }
  async sendMsg(
    sessionRef: SessionRef,
    content: ContentOpts,
    opts?: SendOpts,
  ): Promise<SurfaceOperationResult<MsgRef>> {
    return this.post(sessionRef, content, opts, true);
  }
  private async post(
    sessionRef: SessionRef,
    content: ContentOpts,
    opts: SendOpts | undefined,
    trigger: boolean,
  ): Promise<SurfaceOperationResult<MsgRef>> {
    const adapter = this;
    return Result.gen(async function* () {
      yield* Result.await(
        adapter.prepareSendMsg(
          sessionRef,
          {
            text: content.text,
            attachmentCount: content.attachments?.length ?? 0,
            actionCount: content.actions?.length ?? 0,
          },
          opts,
        ),
      );
      const request = yield* adapter.principal("send-message");
      const ref = yield* nativeSession("send-message", sessionRef);
      const id = randomUUID();
      const parts: DisplayMessage["parts"] =
        content.text === undefined ? [] : [{ type: "text", text: content.text }];
      const attachmentIds: string[] = [];
      for (const attachment of content.attachments ?? []) {
        const resources = adapter.dependencies.resources;
        if (!resources)
          return Result.err(
            new SurfaceUnavailable({
              platform: "native",
              operation: "send-message",
              message: "Native resources are unavailable",
            }),
          );
        const upload = yield* Result.await(
          resources
            .ingest(request.principalId, ref.channelId, {
              filename: attachment.filename,
              mediaType: attachment.mimeType,
              bytes: attachment.bytes,
            })
            .then((result) =>
              result.mapError((error) => nativeSurfaceError("send-message", error)),
            ),
        );
        attachmentIds.push(upload.id);
        parts.push({
          type: "data-resource",
          id: upload.id,
          data: {
            resourceId: upload.id,
            name: upload.filename,
            mediaType: upload.mediaType,
            size: upload.size,
            state: "ready",
          },
        });
      }
      if (content.actions?.length)
        parts.push({
          type: "data-actions",
          id: `actions_${id}`,
          data: { requestId: request.requestId ?? id, revision: 0, actions: content.actions },
        });
      const message: DisplayMessage = {
        id,
        role: "assistant",
        metadata: {
          authorId: adapter.serviceUserId,
          createdAt: (adapter.dependencies.now ?? Date.now)(),
          ...(opts?.replyTo ? { replyToMessageId: opts.replyTo.messageId } : {}),
        },
        parts,
      };
      if (!isValidNativeDisplayMessage(message))
        return Result.err(
          invalid("send-message", "content", "Message exceeds native display limits"),
        );
      if (
        trigger &&
        ref.channelId !== request.sourceThreadId &&
        adapter.dependencies.shouldTriggerRun()
      ) {
        const thread = yield* adapter.dependencies.store
          .authorizeThread(request.principalId, ref.channelId, true)
          .mapError((error) => nativeSurfaceError("send-message", error));
        const resolvedModelRequest = adapter.dependencies.resolveModel
          ? yield* adapter.dependencies
              .resolveModel(thread.modelId)
              .mapError((error) => invalid("send-message", "model", error.message))
          : undefined;
        const receipt = yield* adapter.dependencies.store
          .acceptSurfaceInput(
            request.principalId,
            {
              threadId: ref.channelId,
              commandId: id,
              historyGeneration: thread.historyGeneration,
              text: content.text ?? "",
              attachmentIds,
              skillIds: [],
              mode: thread.activeRunId ? "followup" : "prompt",
            },
            adapter.serviceUserId,
            message,
            resolvedModelRequest,
          )
          .mapError((error) => nativeSurfaceError("send-message", error));
        adapter.dependencies.kick(ref.channelId);
        return Result.ok({
          platform: "native" as const,
          channelId: ref.channelId,
          messageId: receipt.messageId,
        });
      }
      yield* adapter.dependencies.store
        .postMessage(request.principalId, ref.channelId, message)
        .mapError((error) => nativeSurfaceError("send-message", error));
      return Result.ok({ platform: "native" as const, channelId: ref.channelId, messageId: id });
    });
  }
  async readMsg(msgRef: MsgRef): Promise<SurfaceOperationResult<SurfaceMessage | null>> {
    const adapter = this;
    return Result.gen(function* () {
      const ref = yield* nativeMessage("read-message", msgRef);
      const request = yield* adapter.principal("read-message");
      const message = yield* adapter.dependencies.surface
        .readMessage(request.principalId, ref.channelId, ref.messageId)
        .mapError((error) => nativeSurfaceError("read-message", error));
      return Result.ok(
        message ? adapter.projectMessage(request.principalId, ref.channelId, message) : null,
      );
    });
  }
  async listMsg(
    sessionRef: SessionRef,
    opts?: LimitOpts,
  ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    const adapter = this;
    return Result.gen(function* () {
      const ref = yield* nativeSession("list-messages", sessionRef);
      const request = yield* adapter.principal("list-messages");
      const messages = yield* adapter.dependencies.surface
        .listMessages(request.principalId, ref.channelId, opts)
        .mapError((error) => nativeSurfaceError("list-messages", error));
      return Result.ok(
        messages.map((message) =>
          adapter.projectMessage(request.principalId, ref.channelId, message),
        ),
      );
    });
  }
  async editMsg(msgRef: MsgRef, content: ContentOpts): Promise<SurfaceOperationResult<void>> {
    const adapter = this;
    return Result.gen(function* () {
      const ref = yield* nativeMessage("edit-message", msgRef);
      const request = yield* adapter.principal("edit-message");
      if (content.attachments?.length)
        return Result.err(
          invalid(
            "edit-message",
            "attachments",
            "Use a new message to send additional attachments",
          ),
        );
      const found = yield* adapter.dependencies.surface
        .readMessage(request.principalId, ref.channelId, ref.messageId)
        .mapError((error) => nativeSurfaceError("edit-message", error));
      if (!found)
        return Result.err(
          new SurfaceMessageNotFound({
            platform: "native",
            operation: "edit-message",
            message: "Message is unavailable",
          }),
        );
      if (found.message.metadata?.authorId !== adapter.serviceUserId)
        return Result.err(
          new SurfacePermissionDenied({
            platform: "native",
            operation: "edit-message",
            message: "Surface maintenance only edits Lilac messages",
          }),
        );
      const parts = found.message.parts.filter(
        (part) =>
          (content.text === undefined || part.type !== "text") &&
          (content.actions === undefined || part.type !== "data-actions"),
      );
      if (content.text !== undefined) parts.unshift({ type: "text", text: content.text });
      if (content.actions?.length)
        parts.push({
          type: "data-actions",
          id: `actions_${ref.messageId}`,
          data: {
            requestId: request.requestId ?? ref.messageId,
            revision:
              (found.message.parts.find((part) => part.type === "data-actions")?.data.revision ??
                0) + 1,
            actions: content.actions,
          },
        });
      const edited = { ...found.message, parts };
      if (!isValidNativeDisplayMessage(edited))
        return Result.err(
          invalid("edit-message", "content", "Message exceeds native display limits"),
        );
      return adapter.dependencies.store
        .updateSurfaceMessage(request.principalId, ref.channelId, ref.messageId, edited)
        .mapError((error) => nativeSurfaceError("edit-message", error));
    });
  }
  async deleteMsg(msgRef: MsgRef): Promise<SurfaceOperationResult<void>> {
    const adapter = this;
    return Result.gen(function* () {
      const ref = yield* nativeMessage("delete-message", msgRef);
      const request = yield* adapter.principal("delete-message");
      const found = yield* adapter.dependencies.surface
        .readMessage(request.principalId, ref.channelId, ref.messageId)
        .mapError((error) => nativeSurfaceError("delete-message", error));
      if (!found)
        return Result.err(
          new SurfaceMessageNotFound({
            platform: "native",
            operation: "delete-message",
            message: "Message is unavailable",
          }),
        );
      if (found.message.metadata?.authorId !== adapter.serviceUserId)
        return Result.err(
          new SurfacePermissionDenied({
            platform: "native",
            operation: "delete-message",
            message: "Surface maintenance only deletes Lilac messages",
          }),
        );
      return adapter.dependencies.store
        .updateSurfaceMessage(request.principalId, ref.channelId, ref.messageId, null)
        .mapError((error) => nativeSurfaceError("delete-message", error));
    });
  }
  async planReplyChain(
    msgRef: MsgRef,
    opts?: SurfaceReplyChainPlanOptions,
  ): Promise<SurfaceOperationResult<readonly MsgRef[]>> {
    const adapter = this;
    return Result.gen(function* () {
      const ref = yield* nativeMessage("plan-reply-chain", msgRef);
      const request = yield* adapter.principal("plan-reply-chain");
      const refs: MsgRef[] = [];
      const seen = new Set<string>();
      let id: string | undefined = ref.messageId;
      const limit = Math.min(100, Math.max(1, opts?.maxDepth ?? 20));
      while (id && refs.length < limit && !seen.has(id)) {
        seen.add(id);
        const row: NativeSurfaceMessage | null = yield* adapter.dependencies.surface
          .readMessage(request.principalId, ref.channelId, id)
          .mapError((error) => nativeSurfaceError("plan-reply-chain", error));
        if (!row) break;
        refs.push({ ...ref, messageId: id });
        id = row.message.metadata?.replyToMessageId;
      }
      return Result.ok(refs.reverse());
    });
  }
  async getReplyContext(
    msgRef: MsgRef,
    opts?: LimitOpts,
  ): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    const adapter = this;
    return Result.gen(async function* () {
      const refs = yield* Result.await(adapter.planReplyChain(msgRef, { maxDepth: opts?.limit }));
      const messages = yield* Result.await(
        Result.allAsync(refs.map((ref) => adapter.readMsg(ref))),
      );
      return Result.ok(messages.flatMap((message) => (message ? [message] : [])));
    });
  }
  async planMergeBlockEndingAt(
    msgRef: MsgRef,
    opts?: SurfaceMergeBlockPlanOptions,
  ): Promise<SurfaceOperationResult<readonly MsgRef[]>> {
    const adapter = this;
    return Result.gen(async function* () {
      const target = yield* Result.await(adapter.readMsg(msgRef));
      if (!target)
        return Result.err(
          new SurfaceMessageNotFound({
            platform: "native",
            operation: "plan-merge-block",
            message: "Message is unavailable",
          }),
        );
      const messages = yield* Result.await(
        adapter.listMsg(target.session, {
          beforeMessageId: msgRef.messageId,
          limit: opts?.lookbackLimit ?? 50,
        }),
      );
      const refs: MsgRef[] = [target.ref];
      for (const message of messages.toReversed()) {
        if (message.userId !== target.userId) break;
        refs.unshift(message.ref);
      }
      return Result.ok(refs);
    });
  }
  private reaction(msgRef: MsgRef, emoji: string, active: boolean): SurfaceOperationResult<void> {
    const adapter = this;
    const operation = active ? "add-reaction" : "remove-reaction";
    return Result.gen(function* () {
      const ref = yield* nativeMessage(operation, msgRef);
      const request = yield* adapter.principal(operation);
      return adapter.dependencies.surface
        .setReaction(
          request.principalId,
          ref.channelId,
          ref.messageId,
          emoji,
          active,
          adapter.serviceUserId,
        )
        .mapError((error) => nativeSurfaceError(operation, error));
    });
  }
  async addReaction(msgRef: MsgRef, reaction: string): Promise<SurfaceOperationResult<void>> {
    return this.reaction(msgRef, reaction, true);
  }
  async removeReaction(msgRef: MsgRef, reaction: string): Promise<SurfaceOperationResult<void>> {
    return this.reaction(msgRef, reaction, false);
  }
  async listReactionDetails(
    msgRef: MsgRef,
  ): Promise<SurfaceOperationResult<SurfaceReactionDetail[]>> {
    const adapter = this;
    return Result.gen(function* () {
      const ref = yield* nativeMessage("list-reaction-details", msgRef);
      const request = yield* adapter.principal("list-reaction-details");
      return adapter.dependencies.surface
        .reactions(request.principalId, ref.channelId, ref.messageId)
        .mapError((error) => nativeSurfaceError("list-reaction-details", error));
    });
  }
  async listReactions(msgRef: MsgRef): Promise<SurfaceOperationResult<string[]>> {
    return (await this.listReactionDetails(msgRef)).map((details) =>
      details.map((detail) => detail.emoji),
    );
  }
  async getUnRead(sessionRef: SessionRef): Promise<SurfaceOperationResult<SurfaceMessage[]>> {
    const adapter = this;
    return Result.gen(function* () {
      const ref = yield* nativeSession("get-unread", sessionRef);
      const request = yield* adapter.principal("get-unread");
      const rows = yield* adapter.dependencies.surface
        .unread(request.principalId, ref.channelId, adapter.serviceUserId)
        .mapError((error) => nativeSurfaceError("get-unread", error));
      return Result.ok(
        rows.map((row) => adapter.projectMessage(request.principalId, ref.channelId, row)),
      );
    });
  }
  async markRead(
    sessionRef: SessionRef,
    upToMsgRef?: MsgRef,
  ): Promise<SurfaceOperationResult<void>> {
    const adapter = this;
    return Result.gen(function* () {
      const ref = yield* nativeSession("mark-read", sessionRef);
      const request = yield* adapter.principal("mark-read");
      if (upToMsgRef) {
        const upTo = yield* nativeMessage("mark-read", upToMsgRef);
        if (upTo.channelId !== ref.channelId)
          return Result.err(
            new SurfaceSessionMismatch({
              operation: "mark-read",
              refRole: "upToMsgRef",
              expectedSessionId: ref.channelId,
              receivedSessionId: upTo.channelId,
              message: "Read position belongs to another thread",
            }),
          );
      }
      return adapter.dependencies.surface
        .markRead(request.principalId, ref.channelId, adapter.serviceUserId, upToMsgRef?.messageId)
        .mapError((error) => nativeSurfaceError("mark-read", error));
    });
  }
  async startOutput(
    sessionRef: SessionRef,
    opts?: StartOutputOpts,
  ): Promise<SurfaceOperationResult<SurfaceOutputStream>> {
    const adapter = this;
    return Result.gen(async function* () {
      const ref = yield* nativeSession("start-output", sessionRef);
      const request = yield* adapter.principal("start-output");
      yield* adapter.dependencies.store
        .authorizeThread(request.principalId, ref.channelId, true)
        .mapError((error) => nativeSurfaceError("start-output", error));
      let initialParts: DisplayMessage["parts"] = [];
      if (opts?.replyTo) {
        yield* Result.await(
          adapter.prepareSendMsg(
            ref,
            { text: "output", attachmentCount: 0, actionCount: 0 },
            { replyTo: opts.replyTo },
          ),
        );
      }
      if (opts?.resumeAt) {
        const resume = yield* nativeMessage("start-output", opts.resumeAt);
        if (resume.channelId !== ref.channelId)
          return Result.err(
            new SurfaceSessionMismatch({
              operation: "start-output",
              refRole: "resumeAt",
              expectedSessionId: ref.channelId,
              receivedSessionId: resume.channelId,
              message: "Output resume belongs to another thread",
            }),
          );
      }
      if (opts?.resumeAt) {
        const existing = yield* adapter.dependencies.surface
          .readMessage(request.principalId, ref.channelId, opts.resumeAt.messageId)
          .mapError((error) => nativeSurfaceError("start-output", error));
        if (!existing || existing.message.metadata?.authorId !== adapter.serviceUserId)
          return Result.err(
            new SurfacePermissionDenied({
              platform: "native",
              operation: "start-output",
              message: "Cannot resume another author's output",
            }),
          );
        initialParts = existing.message.parts;
      }
      const persist = (
        messageId: string | undefined,
        parts: DisplayMessage["parts"],
      ): SurfaceOperationResult<MsgRef> =>
        Result.gen(function* () {
          yield* adapter.principal("push-output");
          if (messageId) {
            const found = yield* adapter.dependencies.surface
              .readMessage(request.principalId, ref.channelId, messageId)
              .mapError((error) => nativeSurfaceError("push-output", error));
            if (!found)
              return Result.err(
                new SurfaceMessageNotFound({
                  platform: "native",
                  operation: "push-output",
                  message: "Output message is unavailable",
                }),
              );
            if (found.message.metadata?.authorId !== adapter.serviceUserId)
              return Result.err(
                new SurfacePermissionDenied({
                  platform: "native",
                  operation: "push-output",
                  message: "Output can only resume Lilac messages",
                }),
              );
            if (!isValidNativeDisplayMessage({ ...found.message, parts }))
              return Result.err(
                invalid("push-output", "content", "Output exceeds native display limits"),
              );
            yield* adapter.dependencies.store
              .updateSurfaceMessage(request.principalId, ref.channelId, messageId, {
                ...found.message,
                parts,
              })
              .mapError((error) => nativeSurfaceError("push-output", error));
            return Result.ok({ platform: "native" as const, channelId: ref.channelId, messageId });
          }
          const id = randomUUID();
          const message: DisplayMessage = {
            id,
            role: "assistant",
            metadata: {
              authorId: adapter.serviceUserId,
              createdAt: (adapter.dependencies.now ?? Date.now)(),
              ...(opts?.replyTo ? { replyToMessageId: opts.replyTo.messageId } : {}),
            },
            parts,
          };
          if (!isValidNativeDisplayMessage(message))
            return Result.err(
              invalid("push-output", "content", "Output exceeds native display limits"),
            );
          yield* adapter.dependencies.store
            .postMessage(request.principalId, ref.channelId, message)
            .mapError((error) => nativeSurfaceError("push-output", error));
          return Result.ok({
            platform: "native" as const,
            channelId: ref.channelId,
            messageId: id,
          });
        });
      return Result.ok(
        new NativeOutputStream(
          persist,
          async (attachment) => {
            const resources = adapter.dependencies.resources;
            if (!resources)
              return Result.err(
                new SurfaceUnavailable({
                  platform: "native",
                  operation: "push-output",
                  message: "Native resources are unavailable",
                }),
              );
            return (
              await resources.ingest(request.principalId, ref.channelId, {
                filename: attachment.filename,
                mediaType: attachment.mimeType,
                bytes: attachment.bytes,
              })
            )
              .mapError((error) => nativeSurfaceError("push-output", error))
              .map((upload) => ({
                type: "data-resource" as const,
                id: upload.id,
                data: {
                  resourceId: upload.id,
                  name: upload.filename,
                  mediaType: upload.mediaType,
                  size: upload.size,
                  state: "ready" as const,
                },
              }));
          },
          opts,
          adapter.dependencies.streamingMode?.() ?? "complete",
          initialParts,
        ),
      );
    });
  }
  async startTyping(
    sessionRef: SessionRef,
    opts?: StartTypingOpts,
  ): Promise<SurfaceOperationResult<TypingIndicatorSubscription>> {
    const adapter = this;
    return Result.gen(async function* () {
      const stream = yield* Result.await(adapter.startOutput(sessionRef));
      yield* Result.await(
        stream.push({
          type: "reasoning.status",
          update: { startedAtMs: (adapter.dependencies.now ?? Date.now)() },
        }),
      );
      opts?.onStarted?.();
      return Result.ok({ stop: async () => (await stream.finish()).map(() => undefined) });
    });
  }
}

class NativeOutputStream implements SurfaceOutputStream {
  private text = "";
  private publishedText = "";
  private parts: DisplayMessage["parts"] = [];
  private ref?: MsgRef;
  private closed = false;
  constructor(
    private readonly persist: (
      messageId: string | undefined,
      parts: DisplayMessage["parts"],
    ) => SurfaceOperationResult<MsgRef>,
    private readonly attach: (
      attachment: import("../types").SurfaceAttachment,
    ) => Promise<SurfaceOperationResult<DisplayMessage["parts"][number]>>,
    private readonly options: StartOutputOpts | undefined,
    private readonly mode: "paragraph" | "complete",
    initialParts: DisplayMessage["parts"] = [],
  ) {
    this.ref = options?.resumeAt;
    this.parts = initialParts;
    this.text = initialParts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
    this.publishedText = this.text;
  }

  private flush(): SurfaceOperationResult<void> {
    const content: DisplayMessage["parts"] = this.parts.filter((part) => part.type !== "text");
    const paragraphs = this.publishedText.split("\n\n");
    const textParts: DisplayMessage["parts"] = [];
    for (const [index, paragraph] of paragraphs.entries()) {
      const text = index < paragraphs.length - 1 ? `${paragraph}\n\n` : paragraph;
      for (let offset = 0; offset < text.length; offset += 65_536)
        textParts.push({ type: "text", text: text.slice(offset, offset + 65_536) });
    }
    content.unshift(...textParts);
    if (!content.length) return Result.ok(undefined);
    return this.persist(this.ref?.messageId, content).map((ref) => {
      const created = !this.ref;
      this.ref = ref;
      if (created) this.options?.onMessageCreated?.(ref);
    });
  }

  async push(
    part: SurfaceOutputPart,
  ): Promise<SurfaceOperationResult<SurfaceOutputPartDisposition>> {
    if (this.closed) return Result.ok("terminal");
    switch (part.type) {
      case "text.delta": {
        this.text += part.delta;
        if (this.mode === "complete") return Result.ok("visible");
        const normalized = this.text.replace(/\r\n/g, "\n");
        const boundary = normalized.lastIndexOf("\n\n");
        if (boundary < 0) return Result.ok("visible");
        this.publishedText = normalized.slice(0, boundary + 2);
        return this.flush().map(() => "visible" as const);
      }
      case "text.set": {
        this.text = part.text;
        this.publishedText = part.text;
        return this.flush().map(() => "visible" as const);
      }
      case "attachment.add": {
        const stream = this;
        return Result.gen(async function* () {
          const attachment = yield* Result.await(stream.attach(part.attachment));
          stream.parts.push(attachment);
          return stream.flush().map(() => "visible" as const);
        });
      }
      case "reasoning.status": {
        this.parts = this.parts.filter(
          (item) => item.type !== "data-activity" || item.id !== "thinking",
        );
        this.parts.push({
          type: "data-activity",
          id: "thinking",
          data: {
            kind: "thinking",
            label: "Thinking",
            state: part.update.frozenAtMs === undefined ? "running" : "complete",
          },
        });
        return this.flush().map(() => "visible" as const);
      }
      case "tool.status": {
        this.parts = this.parts.filter(
          (item) => item.type !== "data-activity" || item.id !== part.update.toolCallId,
        );
        const state = part.update.status === "end" ? "complete" : "running";
        const settledState = part.update.ok === false ? "failed" : state;
        this.parts.push({
          type: "data-activity",
          id: part.update.toolCallId,
          data: { kind: "tool", label: part.update.display.slice(0, 256), state: settledState },
        });
        return this.flush().map(() => "visible" as const);
      }
      case "meta.stats":
        return Result.ok("ignored");
    }
  }
  async finish(): Promise<SurfaceOperationResult<SurfaceOutputResult>> {
    if (this.closed && this.ref) return Result.ok({ created: [this.ref], last: this.ref });
    if (this.closed)
      return Result.err(invalid("finish-output", "stream", "Output stream was aborted"));
    this.publishedText = this.text.replace(/\r\n/g, "\n");
    this.parts = this.parts.map((part) =>
      part.type === "data-activity" && part.data.state === "running"
        ? { ...part, data: { ...part.data, state: "complete" } }
        : part,
    );
    const stream = this;
    return Result.gen(function* () {
      yield* stream.flush();
      if (!stream.ref)
        return Result.err(
          invalid("finish-output", "content", "Cannot finish an empty output stream"),
        );
      stream.closed = true;
      return Result.ok({ created: [stream.ref], last: stream.ref });
    });
  }
  async abort(): Promise<SurfaceOperationResult<void>> {
    if (this.closed) return Result.ok(undefined);
    this.parts = this.parts.map((part) =>
      part.type === "data-activity" && part.data.state === "running"
        ? { ...part, data: { ...part.data, state: "failed" } }
        : part,
    );
    return this.flush().map(() => {
      this.closed = true;
    });
  }
}
