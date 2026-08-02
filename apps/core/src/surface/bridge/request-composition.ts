import { isDeepStrictEqual } from "node:util";

import type { ModelMessage, UserContent } from "ai";
import { hashCanonicalMessagesV1 } from "@stanley2058/lilac-agent";
import {
  buildCoreLineageManifestV1,
  createCorePrimaryLineageFreshOnlyV1,
  type CoreLineageAtomV1,
  type CoreLineageSegmentInputV1,
  type CorePrimaryLineageV1,
} from "@stanley2058/lilac-event-bus";
import type { SurfaceAdapter } from "../adapter";
import type { MsgRef, RoutedSurfacePlatform, SessionRef, SurfaceMessage } from "../types";

import {
  parseLeadingContinueDirective,
  stripLeadingContinueDirective,
  isRoutedSurfacePlatform,
} from "./bus-request-router/common";
import {
  isDiscordSessionDividerSurfaceMessageAnyAuthor,
  isDiscordSessionDividerSurfaceMessage,
  isDiscordSessionDividerText,
} from "../discord/discord-session-divider";

import {
  CORE_SURFACE_PROJECTION_FORMAT_VERSION,
  type CoreOwnedBlobReference,
  type CoreSurfaceProjection,
  type TranscriptSnapshot,
  type TranscriptStore,
} from "../../transcript/transcript-store";
import {
  appendDiscordAttachmentsToUserContent,
  createDiscordAttachmentState,
  getDiscordOwnedBlobReferences,
  takeDiscordCurrentBlobReferences,
} from "./request-composition/attachments";
import { selectNewestReachableCheckpoint } from "./request-composition/checkpoint-selection";
import {
  formatSurfaceAttributionHeader,
  normalizeAssistantContextText,
  normalizeText,
} from "./request-composition/normalization";
import { escapeSurfaceMetadataTags } from "./surface-metadata";
import {
  fetchMentionThreadContext,
  fetchReplyChainFrom,
  findEarliestReplyAnchor,
  getForwardSnapshotTextFromRaw,
  hasReplyTargetInRaw,
  mergeChainByDiscordWindow,
  resolveMergeBlockEndingAt,
  toReplyChainMessage,
} from "./request-composition/reply-chain";
import type {
  ComposeRecentChannelMessagesOpts,
  ComposeRequestOpts,
  ComposeSingleMessageOpts,
  ReplyChainMessage,
  RequestCompositionResult,
} from "./request-composition/types";

export type {
  ComposeRecentChannelMessagesOpts,
  ComposeRequestOpts,
  ComposeSingleMessageOpts,
  ReplyChainMessage,
  RequestCompositionResult,
} from "./request-composition/types";

type ProjectionCapableStore = TranscriptStore &
  Required<
    Pick<
      TranscriptStore,
      | "admitCoreSurfaceProjection"
      | "getCoreSurfaceProjection"
      | "putCoreOwnedBlob"
      | "getCoreOwnedBlob"
      | "deleteCoreOwnedBlobIfUnreferenced"
    >
  >;

function isProjectionCapableStore(
  store: TranscriptStore | undefined,
): store is ProjectionCapableStore {
  return Boolean(
    store?.admitCoreSurfaceProjection &&
    store.getCoreSurfaceProjection &&
    store.putCoreOwnedBlob &&
    store.getCoreOwnedBlob &&
    store.deleteCoreOwnedBlobIfUnreferenced,
  );
}

function surfaceIdForSession(platform: RoutedSurfacePlatform, sessionId: string): string {
  return `${platform}:${sessionId}`;
}

function surfaceProjectionKey(
  platform: RoutedSurfacePlatform,
  sessionId: string,
  messageId: string,
) {
  return {
    requestClient: platform,
    surfaceId: surfaceIdForSession(platform, sessionId),
    sessionId,
    messageId,
    projectionFormatVersion: CORE_SURFACE_PROJECTION_FORMAT_VERSION,
  };
}

function mergeProjectedSurfaceMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  if (messages.length <= 1) return [...messages];
  const role = messages[0]?.role;
  if (role === "assistant" && messages.every((message) => message.role === "assistant")) {
    const content = messages
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n\n"),
      )
      .filter(Boolean)
      .join("\n\n");
    return [{ role: "assistant", content }];
  }
  if (role !== "user" || !messages.every((message) => message.role === "user")) {
    return [...messages];
  }

  const multipart = messages.some((message) => typeof message.content !== "string");
  if (!multipart) {
    return [
      {
        role: "user",
        content: messages
          .map((message) => (typeof message.content === "string" ? message.content : ""))
          .join("\n\n"),
      },
    ];
  }

  const parts: UserContent = [];
  for (const [index, message] of messages.entries()) {
    if (index > 0) parts.push({ type: "text", text: "\n\n" });
    if (typeof message.content === "string") parts.push({ type: "text", text: message.content });
    else parts.push(...message.content);
  }
  return [{ role: "user", content: parts }];
}

function storedProjectionSegmentIds(projection: CoreSurfaceProjection | null): string[] | null {
  const value = projection?.sourceFacts["segmentMessageIds"];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  return value;
}

function storedStringFact(
  projection: CoreSurfaceProjection | null,
  key: string,
  fallback: string,
): string {
  const value = projection?.sourceFacts[key];
  return typeof value === "string" ? value : fallback;
}

function storedNumberFact(
  projection: CoreSurfaceProjection | null,
  key: string,
  fallback: number,
): number {
  const value = projection?.sourceFacts[key];
  return typeof value === "number" ? value : fallback;
}

function collectStoredBoundaryBreaks(input: {
  platform: RoutedSurfacePlatform;
  chain: readonly ReplyChainMessage[];
  sessionId: string;
  projections: ReadonlyMap<string, CoreSurfaceProjection | null>;
  transcriptStore?: TranscriptStore;
}): Set<string> {
  const boundaryKeys = input.chain.map((message) => {
    const stored = input.transcriptStore?.getLatestCoreSurfaceSegment?.(
      surfaceProjectionKey(input.platform, input.sessionId, message.messageId),
    );
    if (stored) return `${stored.requestId}:${stored.segmentIndex}`;
    const admittedIds = storedProjectionSegmentIds(
      input.projections.get(message.messageId) ?? null,
    );
    return admittedIds ? `admitted:${admittedIds.join("\u0000")}` : null;
  });
  const breaks = new Set<string>();
  for (let index = 1; index < input.chain.length; index += 1) {
    const previous = boundaryKeys[index - 1];
    const current = boundaryKeys[index];
    if ((previous || current) && previous !== current) {
      breaks.add(input.chain[index]!.messageId);
    }
  }
  return breaks;
}

function appendPersistedSyntheticSuffix(input: {
  segmentInputs: CoreLineageSegmentInputV1[];
  requestId: string;
  transcriptStore?: TranscriptStore;
}): boolean {
  const manifest = input.transcriptStore?.getCorePrimaryLineageManifest?.({
    requestId: input.requestId,
  });
  if (!manifest || !manifest.segments.some((segment) => segment.atoms[0]?.kind === "synthetic")) {
    return true;
  }
  if (input.segmentInputs.length > manifest.segments.length) return false;

  const prefixMatches = input.segmentInputs.every((segment, index) => {
    const stored = manifest.segments[index];
    return (
      stored !== undefined &&
      isDeepStrictEqual(segment.atoms, stored.atoms) &&
      isDeepStrictEqual(segment.canonicalMessages, stored.canonicalMessages) &&
      isDeepStrictEqual(segment.requestSource, stored.requestSource)
    );
  });
  const suffix = manifest.segments.slice(input.segmentInputs.length);
  if (!prefixMatches || suffix.some((segment) => segment.atoms[0]?.kind !== "synthetic")) {
    return false;
  }

  input.segmentInputs.push(
    ...suffix.map((segment) => ({
      atoms: segment.atoms,
      canonicalMessages: segment.canonicalMessages,
    })),
  );
  return true;
}

async function renderSurfaceProjectionCandidate(input: {
  platform: RoutedSurfacePlatform;
  message: ReplyChainMessage;
  isBot: boolean;
  sessionId: string;
  reactions: readonly string[];
  discordUserAliasById?: ReadonlyMap<string, string>;
  attachmentState: ReturnType<typeof createDiscordAttachmentState>;
}): Promise<{ messages: ModelMessage[]; ownedBlobs: CoreOwnedBlobReference[] }> {
  const normalized = normalizeText(input.message.text, {});
  if (input.isBot) {
    return {
      messages: [
        {
          role: "assistant",
          content: normalizeAssistantContextText(normalized),
        },
      ],
      ownedBlobs: [],
    };
  }

  const header = formatSurfaceAttributionHeader({
    platform: input.platform,
    authorId: input.message.authorId,
    authorName: input.message.authorName,
    userAlias:
      input.platform === "discord"
        ? input.discordUserAliasById?.get(input.message.authorId)
        : undefined,
    messageId: input.message.messageId,
    messageTs: input.message.ts,
    reactions: input.reactions,
  });
  const mainText = `${header}\n${escapeSurfaceMetadataTags(normalized)}`.trimEnd();
  if (input.message.attachments.length === 0) {
    return { messages: [{ role: "user", content: mainText }], ownedBlobs: [] };
  }

  const parts: UserContent = [{ type: "text", text: mainText }];
  await appendDiscordAttachmentsToUserContent(
    parts,
    input.message.attachments,
    input.attachmentState,
  );
  return {
    messages: [{ role: "user", content: parts }],
    ownedBlobs: takeDiscordCurrentBlobReferences(input.attachmentState),
  };
}

async function composeSelectedSurfaceChain(input: {
  adapter: SurfaceAdapter;
  platform: RoutedSurfacePlatform;
  sessionId: string;
  botUserId: string;
  chain: readonly ReplyChainMessage[];
  checkpointSelection: ReturnType<typeof selectNewestReachableCheckpoint<ReplyChainMessage>>;
  currentMessageIds: readonly string[];
  transcriptStore?: TranscriptStore;
  discordUserAliasById?: ReadonlyMap<string, string>;
}): Promise<{
  messages: ModelMessage[];
  mergedGroups: Array<{ authorId: string; messageIds: string[] }>;
  corePrimaryLineage: CorePrimaryLineageV1;
}> {
  const projectionStore = isProjectionCapableStore(input.transcriptStore)
    ? input.transcriptStore
    : undefined;
  const attachmentState = createDiscordAttachmentState({
    ownBlob: projectionStore
      ? ({ bytes, mediaType, filename }) =>
          projectionStore.putCoreOwnedBlob({ bytes, mediaType, filename })
      : undefined,
  });
  try {
    const projections = new Map<string, CoreSurfaceProjection | null>();
    for (const message of input.chain) {
      projections.set(
        message.messageId,
        projectionStore?.getCoreSurfaceProjection(
          surfaceProjectionKey(input.platform, input.sessionId, message.messageId),
        ) ?? null,
      );
    }
    const immutableChain = input.chain.map((message) => {
      const projection = projections.get(message.messageId) ?? null;
      if (!projection) return message;
      return {
        ...message,
        authorId: storedStringFact(projection, "authorId", message.authorId),
        authorName: storedStringFact(projection, "authorName", message.authorName),
        ts: storedNumberFact(projection, "messageTs", message.ts),
      };
    });
    const hardBreaks = collectStoredBoundaryBreaks({
      platform: input.platform,
      chain: immutableChain,
      sessionId: input.sessionId,
      projections,
      transcriptStore: input.transcriptStore,
    });
    const currentMessageIds = new Set(input.currentMessageIds);
    const firstCurrentMessage = immutableChain.find((message) =>
      currentMessageIds.has(message.messageId),
    );
    if (firstCurrentMessage) hardBreaks.add(firstCurrentMessage.messageId);
    const merged = mergeChainByDiscordWindow(immutableChain, hardBreaks);
    const messageById = new Map(immutableChain.map((message) => [message.messageId, message]));
    const unknownUserRefs = immutableChain
      .filter(
        (message) => message.authorId !== input.botUserId && !projections.get(message.messageId),
      )
      .map(
        (message) =>
          ({
            platform: input.platform,
            channelId: input.sessionId,
            messageId: message.messageId,
          }) satisfies MsgRef,
      );
    const reactionsByMessageId = await getReactionsByMessageId({
      adapter: input.adapter,
      refs: unknownUserRefs,
    });
    const projectedByMessageId = new Map<string, readonly ModelMessage[]>();
    const candidateOwnedBlobsByMessageId = new Map<string, readonly CoreOwnedBlobReference[]>();
    let lineageComplete = Boolean(projectionStore);
    const transcriptSnapshotByMessageId = new Map<string, TranscriptSnapshot>();
    const aliasMessageIdsByRequestId = new Map<string, string[]>();
    if (input.transcriptStore) {
      for (const message of immutableChain) {
        if (message.authorId !== input.botUserId) continue;
        const snapshot = resolveTranscriptSnapshot({
          platform: input.platform,
          channelId: input.sessionId,
          messageId: message.messageId,
          transcriptStore: input.transcriptStore,
          resolvedSnapshotsBySurfaceMessageId:
            input.checkpointSelection.resolvedSnapshotsBySurfaceMessageId,
        });
        if (!snapshot) continue;
        if (snapshot.requestClient !== input.platform || snapshot.sessionId !== input.sessionId) {
          lineageComplete = false;
          continue;
        }
        transcriptSnapshotByMessageId.set(message.messageId, snapshot);
        const aliases = aliasMessageIdsByRequestId.get(snapshot.requestId) ?? [];
        aliases.push(message.messageId);
        aliasMessageIdsByRequestId.set(snapshot.requestId, aliases);
      }
    }

    for (const chunk of merged) {
      for (const messageId of chunk.messageIds) {
        const stored = projections.get(messageId);
        if (stored) {
          projectedByMessageId.set(messageId, stored.canonicalMessages);
          continue;
        }
        const source = messageById.get(messageId);
        if (!source)
          throw new Error(`Selected ${input.platform} message '${messageId}' was not found`);
        const candidate = await renderSurfaceProjectionCandidate({
          platform: input.platform,
          message: source,
          isBot: source.authorId === input.botUserId,
          sessionId: input.sessionId,
          reactions: reactionsByMessageId.get(messageId) ?? [],
          discordUserAliasById: input.discordUserAliasById,
          attachmentState,
        });
        if (!projectionStore) {
          projectedByMessageId.set(messageId, candidate.messages);
          continue;
        }
        projectedByMessageId.set(messageId, candidate.messages);
        candidateOwnedBlobsByMessageId.set(messageId, candidate.ownedBlobs);
      }

      const projectionSegmentIdsByMessageId = new Map<string, readonly string[]>();
      if (chunk.authorId !== input.botUserId) {
        for (const messageId of chunk.messageIds) {
          projectionSegmentIdsByMessageId.set(messageId, chunk.messageIds);
        }
      } else {
        let unresolvedIds: string[] = [];
        const flushUnresolved = (): void => {
          for (const unresolvedId of unresolvedIds) {
            projectionSegmentIdsByMessageId.set(unresolvedId, unresolvedIds);
          }
          unresolvedIds = [];
        };
        for (const messageId of chunk.messageIds) {
          if (transcriptSnapshotByMessageId.has(messageId)) {
            flushUnresolved();
            projectionSegmentIdsByMessageId.set(messageId, [messageId]);
          } else {
            unresolvedIds.push(messageId);
          }
        }
        flushUnresolved();
      }
      for (const messageId of chunk.messageIds) {
        if (projections.get(messageId) || !projectionStore) continue;
        const source = messageById.get(messageId);
        if (!source)
          throw new Error(`Selected ${input.platform} message '${messageId}' was not found`);
        const segmentMessageIds = projectionSegmentIdsByMessageId.get(messageId) ?? [messageId];
        const segmentMessages = mergeProjectedSurfaceMessages(
          segmentMessageIds.flatMap((id) => projectedByMessageId.get(id) ?? []),
        );
        const admitted = projectionStore.admitCoreSurfaceProjection({
          ...surfaceProjectionKey(input.platform, input.sessionId, messageId),
          canonicalMessages: projectedByMessageId.get(messageId) ?? [],
          sourceFacts: {
            authorId: source.authorId,
            authorName: source.authorName,
            messageTs: source.ts,
            reactions: [...(reactionsByMessageId.get(messageId) ?? [])],
            attachments: source.attachments.map((attachment) => ({ ...attachment })),
            segmentMessageIds: [...segmentMessageIds],
            segmentDigest: hashCanonicalMessagesV1(segmentMessages).hash,
          },
          ownedBlobs: candidateOwnedBlobsByMessageId.get(messageId) ?? [],
        });
        projectedByMessageId.set(messageId, admitted.canonicalMessages);
      }
    }

    const segmentInputs: CoreLineageSegmentInputV1[] = [];
    if (input.checkpointSelection.checkpoint) {
      const checkpoint = input.checkpointSelection.checkpoint;
      const digest =
        checkpoint.transcriptDigest ?? hashCanonicalMessagesV1(checkpoint.messages).hash;
      segmentInputs.push({
        atoms: [{ kind: "checkpoint", requestId: checkpoint.requestId, transcriptDigest: digest }],
        canonicalMessages: checkpoint.messages,
      });
    }

    const seenRequestIds = new Set<string>(
      input.checkpointSelection.checkpoint ? [input.checkpointSelection.checkpoint.requestId] : [],
    );
    for (const chunk of merged) {
      const appendSurfaceSegment = (messageIds: readonly string[]): void => {
        if (messageIds.length === 0) return;
        const atoms = messageIds.map(
          (messageId) =>
            ({
              kind: "surface",
              requestClient: input.platform,
              surfaceId: surfaceIdForSession(input.platform, input.sessionId),
              sessionId: input.sessionId,
              messageId,
            }) satisfies CoreLineageAtomV1,
        );
        const canonicalMessages = mergeProjectedSurfaceMessages(
          messageIds.flatMap((messageId) => projectedByMessageId.get(messageId) ?? []),
        );
        segmentInputs.push({ atoms, canonicalMessages });
      };

      const pendingSurfaceIds: string[] = [];
      for (const messageId of chunk.messageIds) {
        const snapshot = transcriptSnapshotByMessageId.get(messageId);
        if (!snapshot) {
          pendingSurfaceIds.push(messageId);
          continue;
        }
        appendSurfaceSegment(pendingSurfaceIds.splice(0));
        if (seenRequestIds.has(snapshot.requestId)) continue;

        seenRequestIds.add(snapshot.requestId);
        if (
          !appendPersistedSyntheticSuffix({
            segmentInputs,
            requestId: snapshot.requestId,
            transcriptStore: input.transcriptStore,
          })
        ) {
          lineageComplete = false;
        }
        const metadata = input.transcriptStore?.getCoreRequestAtomMetadata?.({
          requestId: snapshot.requestId,
        });
        if (!metadata) lineageComplete = false;
        const requestAtom: CoreLineageAtomV1 = {
          kind: "request",
          requestId: snapshot.requestId,
          transcriptDigest:
            metadata?.transcriptDigest ??
            snapshot.transcriptDigest ??
            hashCanonicalMessagesV1(snapshot.messages).hash,
          providerFamily:
            metadata?.providerFamily ?? snapshot.providerState?.lastFamily ?? "ai-sdk",
          containsCrossFamilyTurns:
            metadata?.containsCrossFamilyTurns ??
            snapshot.providerState?.containsCrossFamilyTurns ??
            true,
        };
        const aliases = [...new Set(aliasMessageIdsByRequestId.get(snapshot.requestId) ?? [])].map(
          (aliasMessageId) => ({
            requestClient: input.platform,
            surfaceId: surfaceIdForSession(input.platform, input.sessionId),
            sessionId: input.sessionId,
            messageId: aliasMessageId,
          }),
        );
        segmentInputs.push({
          atoms: [requestAtom],
          canonicalMessages: snapshot.messages,
          requestSource: { aliases },
        });
      }
      appendSurfaceSegment(pendingSurfaceIds);
    }

    const messages = segmentInputs.flatMap((segment) => segment.canonicalMessages);
    const currentSegmentIndex = segmentInputs.findIndex((segment) =>
      segment.atoms.some(
        (atom) => atom.kind === "surface" && currentMessageIds.has(atom.messageId),
      ),
    );
    if (currentSegmentIndex < 0) lineageComplete = false;
    const currentCanonicalStart =
      currentSegmentIndex < 0
        ? Math.max(
            0,
            messages.findLastIndex((message) => message.role === "user"),
          )
        : segmentInputs
            .slice(0, currentSegmentIndex)
            .reduce((count, segment) => count + segment.canonicalMessages.length, 0);
    const corePrimaryLineage =
      lineageComplete && segmentInputs.length > 0
        ? buildCoreLineageManifestV1(segmentInputs, { currentSegmentIndex })
        : createCorePrimaryLineageFreshOnlyV1(
            currentSegmentIndex < 0
              ? "current-input-boundary-unreachable"
              : projectionStore
                ? "incomplete-request-metadata"
                : "projection-store-unavailable",
            currentCanonicalStart,
          );
    return {
      messages,
      mergedGroups: merged.map((chunk) => ({
        authorId: chunk.authorId,
        messageIds: [...chunk.messageIds],
      })),
      corePrimaryLineage,
    };
  } finally {
    if (projectionStore) {
      for (const reference of getDiscordOwnedBlobReferences(attachmentState)) {
        projectionStore.deleteCoreOwnedBlobIfUnreferenced({ sha256: reference.sha256 });
      }
    }
  }
}

function resolveTranscriptSnapshot(input: {
  messageId: string;
  platform: RoutedSurfacePlatform;
  channelId: string;
  transcriptStore: TranscriptStore;
  resolvedSnapshotsBySurfaceMessageId: ReadonlyMap<string, TranscriptSnapshot | null>;
}): TranscriptSnapshot | null {
  if (input.resolvedSnapshotsBySurfaceMessageId.has(input.messageId)) {
    return input.resolvedSnapshotsBySurfaceMessageId.get(input.messageId) ?? null;
  }

  return input.transcriptStore.getTranscriptBySurfaceMessage({
    platform: input.platform,
    channelId: input.channelId,
    messageId: input.messageId,
  });
}

function getDiscordIsChatFromRaw(raw: unknown): boolean | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  const discord =
    "discord" in o && o.discord && typeof o.discord === "object"
      ? (o.discord as Record<string, unknown>)
      : null;
  if (!discord) return undefined;
  const isChat = discord["isChat"];
  return typeof isChat === "boolean" ? isChat : undefined;
}

function shouldIncludeInModelContext(msg: SurfaceMessage): boolean {
  // Listing and surface tools may include platform/system messages (e.g. Discord
  // thread-created notices). By default, do not send those to the model.
  if (msg.session.platform !== "discord") return true;

  const isChat = getDiscordIsChatFromRaw(msg.raw);
  return isChat ?? true;
}

function applyUserTextTransformToReplyChainMessage(input: {
  message: ReplyChainMessage;
  transformUserText?: (text: string) => string;
  shouldTransform: boolean;
}): ReplyChainMessage {
  const { message, transformUserText, shouldTransform } = input;
  if (!shouldTransform || !transformUserText) return message;

  const text = transformUserText(message.text);

  return {
    ...message,
    text,
  };
}

function toReplyChainMessageForModelContext(input: {
  message: SurfaceMessage;
  botUserId: string;
  triggerMessageId?: string;
  transformUserText?: (text: string) => string;
}): ReplyChainMessage {
  const base = toReplyChainMessage(input.message);
  return applyUserTextTransformToReplyChainMessage({
    message: base,
    transformUserText: input.transformUserText,
    shouldTransform:
      input.message.userId !== input.botUserId &&
      typeof input.triggerMessageId === "string" &&
      input.message.ref.messageId === input.triggerMessageId,
  });
}

function getSurfaceMessageContextText(message: SurfaceMessage): string {
  return message.text.trim().length > 0
    ? message.text
    : (getForwardSnapshotTextFromRaw(message.raw) ?? message.text);
}

function shouldApplyContinueDirectiveToSurfaceMessage(message: SurfaceMessage): boolean {
  return !hasReplyTargetInRaw(message.raw);
}

function stripContinueDirectiveFromReplyChainMessage(input: {
  message: ReplyChainMessage;
  botUserId: string;
  botMentionNames: readonly string[];
}): ReplyChainMessage {
  if (input.message.authorId === input.botUserId) return input.message;

  const stripped = stripLeadingContinueDirective({
    text: input.message.text,
    botNames: input.botMentionNames,
  });
  if (stripped === input.message.text) return input.message;

  return {
    ...input.message,
    text: stripped,
  };
}

function findVisibleContinueDirectives(input: {
  selected: readonly SurfaceMessage[];
  selectedStartIndex: number;
  botUserId: string;
  botMentionNames: readonly string[];
}): VisibleContinueDirectives | null {
  let desiredFloorIndex: number | null = null;

  for (let i = 0; i < input.selected.length; i++) {
    const message = input.selected[i]!;
    if (message.userId === input.botUserId) continue;
    if (!shouldApplyContinueDirectiveToSurfaceMessage(message)) continue;

    const count = parseLeadingContinueDirective({
      text: getSurfaceMessageContextText(message),
      botNames: input.botMentionNames,
    });
    if (count === undefined) continue;

    const messageAbsoluteIndex = input.selectedStartIndex + i;
    const messageDesiredFloorIndex = messageAbsoluteIndex - count;
    desiredFloorIndex =
      desiredFloorIndex === null
        ? messageDesiredFloorIndex
        : Math.min(desiredFloorIndex, messageDesiredFloorIndex);
  }

  return desiredFloorIndex === null ? null : { desiredFloorIndex };
}

async function listRecentMessagesEndingAt(params: {
  adapter: SurfaceAdapter;
  sessionId: string;
  anchor: SurfaceMessage;
  maxPreviousMessages: number;
  previousMessageTargets?: readonly number[];
  shouldContinue?: (input: {
    collected: readonly SurfaceMessage[];
    exhausted: boolean;
    fetchedPreviousMessages: number;
  }) => boolean;
}): Promise<SurfaceMessage[]> {
  // The anchor already carries the session it belongs to; rebuilding a ref
  // here would hardcode a platform.
  const sessionRef = params.anchor.session;

  const previousMessageTargets = (() => {
    const requested = params.previousMessageTargets ?? [params.maxPreviousMessages];
    const normalized = requested
      .map((target) => Math.min(params.maxPreviousMessages, Math.max(0, Math.floor(target))))
      .filter((target, index, list) => target > 0 && list.indexOf(target) === index)
      .sort((a, b) => a - b);

    if (
      normalized.length === 0 ||
      normalized[normalized.length - 1] !== params.maxPreviousMessages
    ) {
      normalized.push(params.maxPreviousMessages);
    }

    return normalized;
  })();

  const seen = new Set<string>([params.anchor.ref.messageId]);
  const collected: SurfaceMessage[] = [params.anchor];
  let cursor: string | undefined = params.anchor.ref.messageId;
  let remaining = Math.max(0, params.maxPreviousMessages);
  let fetchedPreviousMessages = 0;
  let exhausted = false;

  const getSortedCollected = () =>
    collected
      .slice()
      .sort((a, b) =>
        compareDiscordMsgPosition(
          { ts: a.ts, messageId: a.ref.messageId },
          { ts: b.ts, messageId: b.ref.messageId },
        ),
      );

  for (const target of previousMessageTargets) {
    while (cursor && fetchedPreviousMessages < target && remaining > 0) {
      const page = await params.adapter.listMsg(sessionRef, {
        limit: Math.min(100, remaining, target - fetchedPreviousMessages),
        beforeMessageId: cursor,
      });
      if (!page || page.length === 0) {
        exhausted = true;
        cursor = undefined;
        break;
      }

      let oldestInPage: SurfaceMessage | null = null;
      let addedAny = false;

      for (const message of page) {
        if (message.session.channelId !== params.sessionId) continue;
        if (seen.has(message.ref.messageId)) continue;
        seen.add(message.ref.messageId);
        collected.push(message);
        addedAny = true;
        fetchedPreviousMessages += 1;
        remaining -= 1;

        if (
          !oldestInPage ||
          compareDiscordMsgPosition(
            { ts: message.ts, messageId: message.ref.messageId },
            { ts: oldestInPage.ts, messageId: oldestInPage.ref.messageId },
          ) < 0
        ) {
          oldestInPage = message;
        }

        if (remaining <= 0 || fetchedPreviousMessages >= target) break;
      }

      if (!addedAny || !oldestInPage) {
        exhausted = true;
        cursor = undefined;
        break;
      }
      if (oldestInPage.ref.messageId === cursor) {
        exhausted = true;
        cursor = undefined;
        break;
      }
      cursor = oldestInPage.ref.messageId;
    }

    if (
      params.shouldContinue &&
      !params.shouldContinue({
        collected: getSortedCollected(),
        exhausted,
        fetchedPreviousMessages,
      })
    ) {
      return getSortedCollected();
    }

    if (exhausted || remaining <= 0) break;
  }

  return getSortedCollected();
}

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

function compareDiscordMsgPosition(
  a: { ts: number; messageId: string },
  b: { ts: number; messageId: string },
): number {
  if (a.ts !== b.ts) return a.ts - b.ts;
  return compareDiscordSnowflakeLike(a.messageId, b.messageId);
}

const ACTIVE_BURST_HISTORY_CAP = 200;
const ACTIVE_BURST_HISTORY_TARGETS = [16, 48, 112, ACTIVE_BURST_HISTORY_CAP] as const;
const ACTIVE_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const ACTIVE_MAX_GAP_MS = 2 * 60 * 60 * 1000;

type ActiveBurstSelection = {
  selected: SurfaceMessage[];
  dividerBoundaryReached: boolean;
  hitAgeCutoff: boolean;
  hitGapCutoff: boolean;
  hasVisibleContinue: boolean;
  unresolvedContinue: boolean;
};

type VisibleContinueDirectives = {
  desiredFloorIndex: number;
};

function filterMessagesUpToAnchor(input: {
  list: readonly SurfaceMessage[];
  anchor: SurfaceMessage;
}): SurfaceMessage[] {
  const anchorTs = input.anchor.ts;
  const anchorId = input.anchor.ref.messageId;

  return input.list.filter((message) => {
    if (message.ts < anchorTs) return true;
    if (message.ts > anchorTs) return false;
    return compareDiscordSnowflakeLike(message.ref.messageId, anchorId) <= 0;
  });
}

function selectActiveBurstMessages(input: {
  contextList: readonly SurfaceMessage[];
  activeAnchor: SurfaceMessage;
  limit: number;
  botUserId: string;
  botMentionNames: readonly string[];
}): ActiveBurstSelection {
  const eligibleToAnchor = filterMessagesUpToAnchor({
    list: input.contextList,
    anchor: input.activeAnchor,
  });

  const eligible = applyDiscordSessionDividerCutoff({
    listOldestToNewest: eligibleToAnchor,
    botUserId: input.botUserId,
  });

  const dividerBoundaryReached = eligible.length !== eligibleToAnchor.length;
  const anchorId = input.activeAnchor.ref.messageId;
  const anchorTs = input.activeAnchor.ts;
  const anchorIndex = eligible.findIndex((message) => message.ref.messageId === anchorId);
  const startIndex = anchorIndex >= 0 ? anchorIndex : eligible.length - 1;

  if (startIndex < 0) {
    return {
      selected: [],
      dividerBoundaryReached,
      hitAgeCutoff: false,
      hitGapCutoff: false,
      hasVisibleContinue: false,
      unresolvedContinue: false,
    };
  }

  const pickedNewestToOldest: SurfaceMessage[] = [];
  let hitAgeCutoff = false;
  let hitGapCutoff = false;

  let prev = eligible[startIndex] ?? null;
  if (prev) pickedNewestToOldest.push(prev);

  for (let i = startIndex - 1; i >= 0 && pickedNewestToOldest.length < input.limit; i--) {
    const cur = eligible[i]!;

    const ageMs = anchorTs - cur.ts;
    if (ageMs > ACTIVE_MAX_AGE_MS) {
      hitAgeCutoff = true;
      break;
    }

    const gapMs = (prev?.ts ?? anchorTs) - cur.ts;
    if (gapMs > ACTIVE_MAX_GAP_MS) {
      hitGapCutoff = true;
      break;
    }

    pickedNewestToOldest.push(cur);
    prev = cur;
  }

  const provisionalSelected = pickedNewestToOldest.reverse();
  const provisionalStartIndex = Math.max(0, startIndex - (provisionalSelected.length - 1));
  let selected = provisionalSelected;
  let selectedStartIndex = provisionalStartIndex;
  let hasVisibleContinue = false;
  let unresolvedContinue = false;

  while (selected.length > 0) {
    const visibleContinueDirectives = findVisibleContinueDirectives({
      selected,
      selectedStartIndex,
      botUserId: input.botUserId,
      botMentionNames: input.botMentionNames,
    });

    if (!visibleContinueDirectives) break;

    hasVisibleContinue = true;
    unresolvedContinue ||= visibleContinueDirectives.desiredFloorIndex < 0;

    const nextSelectedStartIndex = Math.max(0, visibleContinueDirectives.desiredFloorIndex);
    if (nextSelectedStartIndex === selectedStartIndex) break;

    selectedStartIndex = nextSelectedStartIndex;
    selected = eligible.slice(selectedStartIndex, startIndex + 1);
  }

  if (!hasVisibleContinue) {
    return {
      selected: provisionalSelected,
      dividerBoundaryReached,
      hitAgeCutoff,
      hitGapCutoff,
      hasVisibleContinue: false,
      unresolvedContinue: false,
    };
  }

  return {
    selected,
    dividerBoundaryReached,
    hitAgeCutoff,
    hitGapCutoff,
    hasVisibleContinue,
    unresolvedContinue,
  };
}

function shouldContinueLoadingActiveBurstHistory(input: {
  selection: ActiveBurstSelection;
  exhausted: boolean;
  limit: number;
}): boolean {
  if (input.exhausted) return false;
  if (input.selection.dividerBoundaryReached) return false;
  if (input.selection.unresolvedContinue) return true;
  if (input.selection.hasVisibleContinue) return false;
  if (input.selection.selected.length >= input.limit) return false;
  if (input.selection.hitAgeCutoff || input.selection.hitGapCutoff) return false;
  return true;
}

function applyDiscordSessionDividerCutoff(params: {
  listOldestToNewest: readonly SurfaceMessage[];
  botUserId: string;
}): SurfaceMessage[] {
  const { listOldestToNewest, botUserId } = params;

  let lastDividerIndex = -1;
  for (let i = 0; i < listOldestToNewest.length; i++) {
    const m = listOldestToNewest[i]!;
    if (isDiscordSessionDividerSurfaceMessage(m, botUserId)) {
      lastDividerIndex = i;
    }
  }

  if (lastDividerIndex < 0) return [...listOldestToNewest];
  return listOldestToNewest.slice(lastDividerIndex + 1);
}

function applyDiscordSessionDividerCutoffToReplyChain(params: {
  chainOldestToNewest: readonly ReplyChainMessage[];
  botUserId: string;
}): ReplyChainMessage[] {
  const { chainOldestToNewest, botUserId } = params;

  let lastDividerIndex = -1;
  for (let i = 0; i < chainOldestToNewest.length; i++) {
    const m = chainOldestToNewest[i]!;
    if (m.authorId === botUserId && isDiscordSessionDividerText(m.text)) {
      lastDividerIndex = i;
    }
  }
  if (lastDividerIndex < 0) return [...chainOldestToNewest];
  return chainOldestToNewest.slice(lastDividerIndex + 1);
}

async function findLastDiscordSessionDividerBefore(params: {
  adapter: SurfaceAdapter;
  platform: RoutedSurfacePlatform;
  channelId: string;
  botUserId: string;
  beforeMessageId: string;
  /** Optional: stop scanning once we see this message id. */
  stopAtMessageId?: string;
}): Promise<{ ts: number; messageId: string } | null> {
  const { adapter, platform, channelId, botUserId, beforeMessageId, stopAtMessageId } = params;

  const sessionRef: SessionRef = { platform, channelId };

  let cursor: string | undefined = beforeMessageId;
  let scanned = 0;
  const MAX_MESSAGES = 2000;
  const PAGE_SIZE = 200;

  while (cursor && scanned < MAX_MESSAGES) {
    const page = await adapter.listMsg(sessionRef, {
      limit: Math.min(PAGE_SIZE, MAX_MESSAGES - scanned),
      beforeMessageId: cursor,
    });

    if (!page || page.length === 0) return null;
    scanned += page.length;

    // listMsg order is adapter-specific; treat it as an unordered window for detection.
    let newestDivider: { ts: number; messageId: string } | null = null;
    for (const m of page) {
      if (!isDiscordSessionDividerSurfaceMessage(m, botUserId)) continue;
      const pos = { ts: m.ts, messageId: m.ref.messageId };
      if (!newestDivider || compareDiscordMsgPosition(newestDivider, pos) < 0) {
        newestDivider = pos;
      }
    }
    if (newestDivider) return newestDivider;

    if (stopAtMessageId && page.some((m) => m.ref.messageId === stopAtMessageId)) {
      return null;
    }

    // Advance cursor to the oldest message id we saw.
    let oldest = page[0]!;
    for (const m of page) {
      if (
        compareDiscordMsgPosition(
          { ts: m.ts, messageId: m.ref.messageId },
          { ts: oldest.ts, messageId: oldest.ref.messageId },
        ) < 0
      ) {
        oldest = m;
      }
    }

    // Prevent infinite loops if the adapter returns a stable page.
    if (oldest.ref.messageId === cursor) return null;
    cursor = oldest.ref.messageId;
  }

  return null;
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

async function safeListReactions(adapter: SurfaceAdapter, msgRef: MsgRef): Promise<string[]> {
  try {
    return await adapter.listReactions(msgRef);
  } catch {
    return [];
  }
}

async function getReactionsByMessageId(input: {
  adapter: SurfaceAdapter;
  refs: readonly MsgRef[];
  concurrency?: number;
}): Promise<Map<string, readonly string[]>> {
  const out = new Map<string, readonly string[]>();
  if (input.refs.length === 0) return out;

  const rows = await mapWithConcurrency({
    items: input.refs,
    concurrency: input.concurrency ?? 8,
    run: async (ref) => {
      const reactions = await safeListReactions(input.adapter, ref);
      return { messageId: ref.messageId, reactions };
    },
  });

  for (const row of rows) {
    out.set(row.messageId, row.reactions);
  }

  return out;
}

/**
 * Build request `ModelMessage[]` with reply-chain + merge-window parity.
 *
 * This intentionally uses the adapter interface so the router does not need
 * direct Discord API access.
 */
export async function composeRequestMessages(
  adapter: SurfaceAdapter,
  opts: ComposeRequestOpts,
): Promise<RequestCompositionResult> {
  if (!isRoutedSurfacePlatform(opts.platform)) {
    throw new Error(`Unsupported platform '${opts.platform}'`);
  }

  // Step 1: fetch reply chain from the adapter store / platform.
  // Mention triggers get merge-window parity even if messages are not linked via reply references.
  const triggerMsg = await adapter.readMsg(opts.trigger.msgRef);
  if (!triggerMsg) {
    return {
      messages: [],
      chainMessageIds: [],
      mergedGroups: [],
      corePrimaryLineage: createCorePrimaryLineageFreshOnlyV1("empty-selection"),
    };
  }

  const chain =
    opts.trigger.type === "mention"
      ? await fetchMentionThreadContext(adapter, {
          platform: opts.platform,
          botUserId: opts.botUserId,
          botName: opts.botName,
          triggerMsg,
          maxDepth: opts.maxDepth,
        })
      : await fetchReplyChainFrom(adapter, {
          platform: opts.platform,
          botUserId: opts.botUserId,
          botName: opts.botName,
          trigger: opts.trigger,
          startMsgRef: opts.trigger.msgRef,
          maxDepth: opts.maxDepth,
        });

  const filteredChain = chain.filter((m) => {
    const isChat = getDiscordIsChatFromRaw(m.raw);
    if (!(isChat ?? true)) return false;
    return !isDiscordSessionDividerText(m.text);
  });

  const transformedChain = filteredChain.map((m) => {
    const targetMessageId = opts.transformUserTextForMessageId ?? opts.trigger.msgRef.messageId;
    const transformed = applyUserTextTransformToReplyChainMessage({
      message: m,
      transformUserText: opts.transformUserText,
      shouldTransform: m.authorId !== opts.botUserId && m.messageId === targetMessageId,
    });

    return stripContinueDirectiveFromReplyChainMessage({
      message: transformed,
      botUserId: opts.botUserId,
      botMentionNames: [opts.botName],
    });
  });

  // IMPORTANT: session divider cutoff intentionally does NOT apply to explicit reply/mention
  // chains. If the user replies to (or mentions within) an assistant message after a divider,
  // they are explicitly re-opening that thread; we keep the full linked chain.
  // Divider markers are still always excluded from model context.

  const checkpointSelection = selectNewestReachableCheckpoint({
    chainOldestToNewest: transformedChain,
    botUserId: opts.botUserId,
    platform: opts.platform,
    channelId: opts.trigger.msgRef.channelId,
    transcriptStore: opts.transcriptStore,
    currentRequestId: opts.currentRequestId,
    getAuthorId: (message) => message.authorId,
    getMessageId: (message) => message.messageId,
  });

  const composed = await composeSelectedSurfaceChain({
    adapter,
    platform: opts.platform,
    sessionId: opts.trigger.msgRef.channelId,
    botUserId: opts.botUserId,
    chain: checkpointSelection.descendants,
    checkpointSelection,
    currentMessageIds: opts.currentMessageIds ?? [opts.trigger.msgRef.messageId],
    transcriptStore: opts.transcriptStore,
    discordUserAliasById: opts.discordUserAliasById,
  });

  return {
    messages: composed.messages,
    chainMessageIds: transformedChain.map((m) => m.messageId),
    mergedGroups: composed.mergedGroups,
    corePrimaryLineage: composed.corePrimaryLineage,
  };
}

export async function composeRecentChannelMessages(
  adapter: SurfaceAdapter,
  opts: ComposeRecentChannelMessagesOpts,
): Promise<RequestCompositionResult> {
  if (!isRoutedSurfacePlatform(opts.platform)) {
    throw new Error(`Unsupported platform '${opts.platform}'`);
  }

  // Reply precedence: if the trigger is a Discord reply (even when the router
  // classified it as a "mention" trigger because it wasn't a reply-to-bot),
  // treat it as an explicit reply-chain continuation.
  //
  // IMPORTANT: this bypasses active-burst guardrails (age/gap/transcript-age).
  // A reply is a strong "continue" signal.
  if (opts.triggerMsgRef && opts.triggerType === "mention") {
    const triggerMsg = await adapter.readMsg(opts.triggerMsgRef);
    if (triggerMsg) {
      // "Merge block" = a user's short burst of consecutive messages.
      // If ANY message in the burst is a reply, treat the entire burst as a
      // continuation of that reply thread.
      const block = await resolveMergeBlockEndingAt(adapter, triggerMsg);
      const anchor = findEarliestReplyAnchor(block);
      if (anchor) {
        const anchored = await fetchMentionThreadContext(adapter, {
          platform: opts.platform,
          botUserId: opts.botUserId,
          botName: opts.botName,
          triggerMsg,
        });

        const oldestAnchoredMessageId = anchored[0]?.messageId;

        const divider = oldestAnchoredMessageId
          ? await findLastDiscordSessionDividerBefore({
              adapter,
              platform: opts.platform,
              channelId: opts.sessionId,
              botUserId: opts.botUserId,
              beforeMessageId: triggerMsg.ref.messageId,
              stopAtMessageId: oldestAnchoredMessageId,
            }).catch(() => null)
          : null;

        const anchoredAfterDivider = divider
          ? anchored.filter(
              (m) => compareDiscordMsgPosition({ ts: m.ts, messageId: m.messageId }, divider) > 0,
            )
          : anchored;

        const anchoredCutChain = applyDiscordSessionDividerCutoffToReplyChain({
          chainOldestToNewest: anchoredAfterDivider,
          botUserId: opts.botUserId,
        });

        const anchoredNoDivider = anchoredCutChain.filter(
          (m) => !isDiscordSessionDividerText(m.text),
        );

        const transformedAnchored = anchoredNoDivider.map((m) => {
          const targetMessageId = opts.transformUserTextForMessageId ?? triggerMsg.ref.messageId;
          const transformed = applyUserTextTransformToReplyChainMessage({
            message: m,
            transformUserText: opts.transformUserText,
            shouldTransform: m.authorId !== opts.botUserId && m.messageId === targetMessageId,
          });

          return stripContinueDirectiveFromReplyChainMessage({
            message: transformed,
            botUserId: opts.botUserId,
            botMentionNames: opts.botMentionNames ?? [opts.botName],
          });
        });

        const checkpointSelection = selectNewestReachableCheckpoint({
          chainOldestToNewest: transformedAnchored,
          botUserId: opts.botUserId,
          platform: opts.platform,
          channelId: opts.sessionId,
          transcriptStore: opts.transcriptStore,
          currentRequestId: opts.currentRequestId,
          getAuthorId: (message) => message.authorId,
          getMessageId: (message) => message.messageId,
        });
        const composed = await composeSelectedSurfaceChain({
          adapter,
          platform: opts.platform,
          sessionId: opts.sessionId,
          botUserId: opts.botUserId,
          chain: checkpointSelection.descendants,
          checkpointSelection,
          currentMessageIds: opts.currentMessageIds ?? [triggerMsg.ref.messageId],
          transcriptStore: opts.transcriptStore,
          discordUserAliasById: opts.discordUserAliasById,
        });

        return {
          messages: composed.messages,
          chainMessageIds: transformedAnchored.map((m) => m.messageId),
          mergedGroups: composed.mergedGroups,
          corePrimaryLineage: composed.corePrimaryLineage,
        };
      }
    }
  }

  const sessionRef: SessionRef = {
    platform: opts.platform,
    channelId: opts.sessionId,
  };
  const continueDirectiveBotNames = opts.botMentionNames ?? [opts.botName];

  // Active-burst rules are intended for "latest view" prompts, including
  // fresh @mentions that are not replies. They prevent stale context when a
  // channel has been idle.
  const shouldApplyActiveBurstRules = Boolean(opts.triggerMsgRef && opts.triggerType !== "reply");

  let orderedList: SurfaceMessage[];

  if (shouldApplyActiveBurstRules && opts.triggerMsgRef) {
    const triggerMsg = await adapter.readMsg(opts.triggerMsgRef);
    orderedList = triggerMsg
      ? await listRecentMessagesEndingAt({
          adapter,
          sessionId: opts.sessionId,
          anchor: triggerMsg,
          maxPreviousMessages: ACTIVE_BURST_HISTORY_CAP,
          previousMessageTargets: ACTIVE_BURST_HISTORY_TARGETS,
          shouldContinue: ({ collected, exhausted }) => {
            const activeContextList = collected.filter(shouldIncludeInModelContext);
            const activeTriggerMsg =
              activeContextList.find(
                (message) => message.ref.messageId === opts.triggerMsgRef!.messageId,
              ) ?? null;
            const activeAnchor =
              activeTriggerMsg ??
              (activeContextList.length > 0
                ? activeContextList[activeContextList.length - 1]!
                : null);

            if (!activeAnchor) return !exhausted;

            return shouldContinueLoadingActiveBurstHistory({
              selection: selectActiveBurstMessages({
                contextList: activeContextList,
                activeAnchor,
                limit: opts.limit,
                botUserId: opts.botUserId,
                botMentionNames: continueDirectiveBotNames,
              }),
              exhausted,
              limit: opts.limit,
            });
          },
        })
      : [];
  } else {
    orderedList = [...(await adapter.listMsg(sessionRef, { limit: opts.limit }))];

    if (opts.triggerMsgRef) {
      const exists = orderedList.some((m) => m.ref.messageId === opts.triggerMsgRef!.messageId);
      if (!exists) {
        const fetchedTrigger = await adapter.readMsg(opts.triggerMsgRef);
        if (fetchedTrigger) orderedList.push(fetchedTrigger);
      }
    }

    orderedList.sort((a, b) => {
      if (a.ts !== b.ts) return a.ts - b.ts;
      return compareDiscordSnowflakeLike(a.ref.messageId, b.ref.messageId);
    });
  }

  // The surface layer can include Discord system/notification messages (e.g.
  // thread-created). Keep them listable via surface tools, but exclude them from
  // the default model context.
  const contextList = orderedList.filter(shouldIncludeInModelContext);

  const triggerMsg = opts.triggerMsgRef
    ? (contextList.find((m) => m.ref.messageId === opts.triggerMsgRef!.messageId) ?? null)
    : null;

  const activeAnchor = shouldApplyActiveBurstRules
    ? (triggerMsg ?? (contextList.length > 0 ? contextList[contextList.length - 1]! : null))
    : null;

  const dividerCutContextList =
    shouldApplyActiveBurstRules && activeAnchor
      ? applyDiscordSessionDividerCutoff({
          listOldestToNewest: filterMessagesUpToAnchor({
            list: contextList,
            anchor: activeAnchor,
          }),
          botUserId: opts.botUserId,
        })
      : applyDiscordSessionDividerCutoff({
          listOldestToNewest: contextList,
          botUserId: opts.botUserId,
        });

  let selected: SurfaceMessage[];

  if (shouldApplyActiveBurstRules && activeAnchor) {
    selected = selectActiveBurstMessages({
      contextList,
      activeAnchor,
      limit: opts.limit,
      botUserId: opts.botUserId,
      botMentionNames: continueDirectiveBotNames,
    }).selected;
  } else {
    selected = dividerCutContextList.slice(Math.max(0, dividerCutContextList.length - opts.limit));
  }

  // Safety: exclude divider messages from context even if they are chat-like.
  const selectedNoDivider = selected.filter(
    (m) => !isDiscordSessionDividerSurfaceMessageAnyAuthor(m),
  );

  const chain: ReplyChainMessage[] = selectedNoDivider.map((m) => {
    const transformed = toReplyChainMessageForModelContext({
      message: m,
      botUserId: opts.botUserId,
      triggerMessageId: opts.triggerMsgRef
        ? (opts.transformUserTextForMessageId ?? opts.triggerMsgRef.messageId)
        : undefined,
      transformUserText: opts.transformUserText,
    });

    return stripContinueDirectiveFromReplyChainMessage({
      message: transformed,
      botUserId: opts.botUserId,
      botMentionNames: continueDirectiveBotNames,
    });
  });

  const checkpointSelection = selectNewestReachableCheckpoint({
    chainOldestToNewest: chain,
    botUserId: opts.botUserId,
    platform: opts.platform,
    channelId: opts.sessionId,
    transcriptStore: opts.transcriptStore,
    currentRequestId: opts.currentRequestId,
    getAuthorId: (message) => message.authorId,
    getMessageId: (message) => message.messageId,
  });
  const composed = await composeSelectedSurfaceChain({
    adapter,
    platform: opts.platform,
    sessionId: opts.sessionId,
    botUserId: opts.botUserId,
    chain: checkpointSelection.descendants,
    checkpointSelection,
    currentMessageIds:
      opts.currentMessageIds ??
      (opts.triggerMsgRef
        ? [opts.triggerMsgRef.messageId]
        : selectedNoDivider.length > 0
          ? [selectedNoDivider[selectedNoDivider.length - 1]!.ref.messageId]
          : []),
    transcriptStore: opts.transcriptStore,
    discordUserAliasById: opts.discordUserAliasById,
  });

  return {
    messages: composed.messages,
    chainMessageIds: chain.map((m) => m.messageId),
    mergedGroups: composed.mergedGroups,
    corePrimaryLineage: composed.corePrimaryLineage,
  };
}

export async function composeSingleMessage(
  adapter: SurfaceAdapter,
  opts: ComposeSingleMessageOpts,
): Promise<ModelMessage | null> {
  const composed = await composeSingleMessageWithLineage(adapter, opts);
  return composed?.messages[0] ?? null;
}

export async function composeSingleMessageWithLineage(
  adapter: SurfaceAdapter,
  opts: ComposeSingleMessageOpts,
): Promise<RequestCompositionResult | null> {
  if (!isRoutedSurfacePlatform(opts.platform)) {
    throw new Error(`Unsupported platform '${opts.platform}'`);
  }

  const m = await adapter.readMsg(opts.msgRef);
  if (!m) return null;

  if (!shouldIncludeInModelContext(m)) return null;

  // Never include session divider markers in model context.
  if (isDiscordSessionDividerSurfaceMessageAnyAuthor(m)) return null;

  let text = m.text.trim().length > 0 ? m.text : (getForwardSnapshotTextFromRaw(m.raw) ?? m.text);
  const contentTransform = m.userId !== opts.botUserId ? opts.transformUserText : undefined;

  if (contentTransform) {
    text = contentTransform(text);
  }

  const chain = [
    toReplyChainMessage(m, {
      overrideText: text,
      authorNameFallback: `user_${m.userId}`,
    }),
  ];
  const checkpointSelection = selectNewestReachableCheckpoint({
    chainOldestToNewest: chain,
    botUserId: opts.botUserId,
    platform: opts.platform,
    channelId: opts.msgRef.channelId,
    transcriptStore: opts.transcriptStore,
    getAuthorId: (message) => message.authorId,
    getMessageId: (message) => message.messageId,
  });
  const composed = await composeSelectedSurfaceChain({
    adapter,
    platform: opts.platform,
    sessionId: opts.msgRef.channelId,
    botUserId: opts.botUserId,
    chain: checkpointSelection.descendants,
    checkpointSelection,
    currentMessageIds: opts.currentMessageIds ?? [m.ref.messageId],
    transcriptStore: opts.transcriptStore,
    discordUserAliasById: opts.discordUserAliasById,
  });
  return {
    messages: composed.messages,
    chainMessageIds: [m.ref.messageId],
    mergedGroups: composed.mergedGroups,
    corePrimaryLineage: composed.corePrimaryLineage,
  };
}
