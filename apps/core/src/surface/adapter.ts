import type { AdapterPlatform } from "@stanley2058/lilac-event-bus";
import { Panic, TaggedError, type Result as ResultType } from "better-result";

import type {
  ContentOpts,
  LimitOpts,
  MsgRef,
  RegisteredSurfacePlatform,
  SendOpts,
  SessionRef,
  SurfaceAttachment,
  SurfaceMessage,
  SurfaceReactionDetail,
  SurfaceSelf,
  SurfaceSession,
  SurfaceSessionParticipantsResult,
} from "./types";
import type { AdapterEvent } from "./events";

export function preserveSurfacePanic(cause: unknown): void {
  if (Panic.is(cause)) throw cause;
}

export function surfaceExternalFallback<T>(fallback: T): (cause: unknown) => T {
  return (cause) => {
    preserveSurfacePanic(cause);
    return fallback;
  };
}

export type SurfaceOperation =
  | "list-sessions"
  | "list-session-participants"
  | "start-output"
  | "push-output"
  | "finish-output"
  | "abort-output"
  | "start-typing"
  | "stop-typing"
  | "send-message"
  | "read-message"
  | "list-messages"
  | "edit-message"
  | "delete-message"
  | "get-reply-context"
  | "plan-reply-chain"
  | "plan-merge-block"
  | "add-reaction"
  | "remove-reaction"
  | "list-reactions"
  | "list-reaction-details"
  | "get-unread"
  | "mark-read";

export class SurfaceOperationUnsupported extends TaggedError("SurfaceOperationUnsupported")<{
  readonly platform: RegisteredSurfacePlatform;
  readonly operation: SurfaceOperation;
  readonly message: string;
}> {}

export class SurfacePlatformMismatch extends TaggedError("SurfacePlatformMismatch")<{
  readonly operation: SurfaceOperation;
  readonly refRole: string;
  readonly expectedPlatform: RegisteredSurfacePlatform;
  readonly receivedPlatform: AdapterPlatform;
  readonly message: string;
}> {}

export class SurfaceSessionMismatch extends TaggedError("SurfaceSessionMismatch")<{
  readonly operation: SurfaceOperation;
  readonly refRole: string;
  readonly expectedSessionId: string;
  readonly receivedSessionId: string;
  readonly message: string;
}> {}

export class SurfaceInvalidInput extends TaggedError("SurfaceInvalidInput")<{
  readonly platform: RegisteredSurfacePlatform;
  readonly operation: SurfaceOperation;
  readonly field: string;
  readonly message: string;
}> {}

export class SurfaceOperationPartiallyCompleted extends TaggedError(
  "SurfaceOperationPartiallyCompleted",
)<{
  readonly platform: RegisteredSurfacePlatform;
  readonly operation: SurfaceOperation;
  readonly created: MsgRef;
  readonly message: string;
}> {}

export class SurfaceMessageNotFound extends TaggedError("SurfaceMessageNotFound")<{
  readonly platform: RegisteredSurfacePlatform;
  readonly operation: SurfaceOperation;
  readonly message: string;
}> {}

export class SurfacePermissionDenied extends TaggedError("SurfacePermissionDenied")<{
  readonly platform: RegisteredSurfacePlatform;
  readonly operation: SurfaceOperation;
  readonly message: string;
}> {}

export class SurfaceRateLimited extends TaggedError("SurfaceRateLimited")<{
  readonly platform: RegisteredSurfacePlatform;
  readonly operation: SurfaceOperation;
  readonly retryAfterMs?: number;
  readonly message: string;
}> {}

export class SurfaceUnavailable extends TaggedError("SurfaceUnavailable")<{
  readonly platform: RegisteredSurfacePlatform;
  readonly operation: SurfaceOperation;
  readonly message: string;
}> {}

export type SurfaceOperationError =
  | SurfaceOperationUnsupported
  | SurfacePlatformMismatch
  | SurfaceSessionMismatch
  | SurfaceInvalidInput
  | SurfaceOperationPartiallyCompleted
  | SurfaceMessageNotFound
  | SurfacePermissionDenied
  | SurfaceRateLimited
  | SurfaceUnavailable;

export type SurfaceOperationResult<T> = ResultType<T, SurfaceOperationError>;

export type SurfaceToolStatusUpdate = {
  toolCallId: string;
  display: string;
  status: "start" | "update" | "end";
  ok?: boolean;
  error?: string;
};

export type SurfaceReasoningStatusUpdate = {
  startedAtMs: number;
  /** Freeze timer at this timestamp once text starts streaming. */
  frozenAtMs?: number;
  /** Collapsed provider reasoning text (optional). */
  detailText?: string;
};

export type SurfaceOutputPart =
  | { type: "text.delta"; delta: string }
  | { type: "text.set"; text: string; finalSegments?: readonly string[] }
  | { type: "reasoning.status"; update: SurfaceReasoningStatusUpdate }
  | { type: "meta.stats"; line: string }
  | { type: "tool.status"; update: SurfaceToolStatusUpdate }
  | { type: "attachment.add"; attachment: SurfaceAttachment };

export type SurfaceOutputResult = {
  created: MsgRef[];
  last: MsgRef;
};

export type SurfaceFinalTextMode = "continuation" | "full";
export type SurfaceOutputPartDisposition = "visible" | "terminal" | "ignored";

export type SurfaceReplyChainPlanOptions = {
  maxDepth?: number;
};

export type SurfaceMergeBlockPlanOptions = {
  lookbackLimit?: number;
};

export interface SurfaceOutputStream {
  push(part: SurfaceOutputPart): Promise<SurfaceOperationResult<SurfaceOutputPartDisposition>>;
  finish(): Promise<SurfaceOperationResult<SurfaceOutputResult>>;
  abort(reason?: string): Promise<SurfaceOperationResult<void>>;
  /**
   * Optional final-text policy for bridge slicing behavior.
   * - continuation: treat finalText as current-lane continuation after reanchor
   * - full: treat finalText as complete reply text for the lane
   */
  getFinalTextMode?(): SurfaceFinalTextMode;
}

export type StartOutputOpts = {
  replyTo?: MsgRef;
  /** Disable all Discord notifications for this output stream (mentions + reply ping). */
  silent?: boolean;
  /** Router-derived session mode. Used for surface-specific behaviors (e.g. mention pings). */
  sessionMode?: "mention" | "active";
  /** Request id for this stream (used for surface controls like Cancel buttons). */
  requestId?: string;
  /** Request lifetime start timestamp used by streaming progress UIs. */
  requestStartedAtMs?: number;
  /** Optional hook invoked when the surface creates a message for this stream. */
  onMessageCreated?: (msgRef: MsgRef) => void;
  /** Optional resume metadata used to continue editing an existing output chain. */
  resume?: {
    /** Previously created output messages for this request (oldest to newest). */
    created: MsgRef[];
  };
};

export type AdapterSubscription = {
  stop(): Promise<void>;
};

export type TypingIndicatorSubscription = {
  stop(): Promise<SurfaceOperationResult<void>>;
};

export type AdapterEventHandler = (evt: AdapterEvent) => Promise<void> | void;

export interface SurfaceAdapterEventSource {
  subscribe(handler: AdapterEventHandler): Promise<AdapterSubscription>;
}

export interface SurfaceAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getSelf(): Promise<SurfaceSelf>;

  listSessions(): Promise<SurfaceOperationResult<SurfaceSession[]>>;
  listSessionParticipants(
    sessionRef: SessionRef,
    opts?: { limit?: number },
  ): Promise<SurfaceOperationResult<SurfaceSessionParticipantsResult>>;

  startOutput(
    sessionRef: SessionRef,
    opts?: StartOutputOpts,
  ): Promise<SurfaceOperationResult<SurfaceOutputStream>>;
  startTyping(sessionRef: SessionRef): Promise<SurfaceOperationResult<TypingIndicatorSubscription>>;

  sendMsg(
    sessionRef: SessionRef,
    content: ContentOpts,
    opts?: SendOpts,
  ): Promise<SurfaceOperationResult<MsgRef>>;
  readMsg(msgRef: MsgRef): Promise<SurfaceOperationResult<SurfaceMessage | null>>;
  listMsg(
    sessionRef: SessionRef,
    opts?: LimitOpts,
  ): Promise<SurfaceOperationResult<SurfaceMessage[]>>;
  editMsg(msgRef: MsgRef, content: ContentOpts): Promise<SurfaceOperationResult<void>>;
  deleteMsg(msgRef: MsgRef): Promise<SurfaceOperationResult<void>>;
  getReplyContext(
    msgRef: MsgRef,
    opts?: LimitOpts,
  ): Promise<SurfaceOperationResult<SurfaceMessage[]>>;
  planReplyChain(
    msgRef: MsgRef,
    opts?: SurfaceReplyChainPlanOptions,
  ): Promise<SurfaceOperationResult<readonly MsgRef[]>>;
  planMergeBlockEndingAt(
    msgRef: MsgRef,
    opts?: SurfaceMergeBlockPlanOptions,
  ): Promise<SurfaceOperationResult<readonly MsgRef[]>>;

  addReaction(msgRef: MsgRef, reaction: string): Promise<SurfaceOperationResult<void>>;
  removeReaction(msgRef: MsgRef, reaction: string): Promise<SurfaceOperationResult<void>>;
  listReactions(msgRef: MsgRef): Promise<SurfaceOperationResult<string[]>>;
  listReactionDetails(msgRef: MsgRef): Promise<SurfaceOperationResult<SurfaceReactionDetail[]>>;

  getUnRead(sessionRef: SessionRef): Promise<SurfaceOperationResult<SurfaceMessage[]>>;
  markRead(sessionRef: SessionRef, upToMsgRef?: MsgRef): Promise<SurfaceOperationResult<void>>;
}

export type SurfaceBurstCacheInput = {
  /** Prefer passing msgRef for targeted invalidation. */
  msgRef?: MsgRef;
  /** Used when msgRef is unknown (e.g. listing a session). */
  sessionRef?: SessionRef;
  /** Why the cache is being invalidated. */
  reason: "surface_tool" | "other";
};

/** Optional capability: invalidate in-memory provider caches for a "latest view" read. */
export interface SurfaceCacheBurstProvider {
  burstCache(input: SurfaceBurstCacheInput): Promise<void>;
}

export function hasCacheBurstProvider(
  adapter: SurfaceAdapter,
): adapter is SurfaceAdapter & SurfaceCacheBurstProvider {
  return "burstCache" in adapter && typeof adapter.burstCache === "function";
}
