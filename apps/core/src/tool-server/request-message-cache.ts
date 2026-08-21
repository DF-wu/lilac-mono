import { lilacEventTypes, type LilacMessageForTopic } from "@stanley2058/lilac-event-bus";
import { createLogger } from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";

import {
  AuthenticatedRequestIdentityConflict,
  AuthenticatedRequestProjectionInvalid,
  isAuthenticatedRequestProjectionSemanticallyValid,
  latchAuthenticatedRequest,
  projectAuthenticatedRequest,
  type AuthenticatedRequestProjection,
} from "../surface/authenticated-request";
import { getBuiltinSurfaceProtocol } from "../surface/builtin-surface-protocols";
import type { AuthenticatedSurfaceOrigin } from "../surface/types";

export {
  AuthenticatedRequestProjectionInvalid as RequestMessageCacheProjectionInvalid,
  projectAuthenticatedRequest as resolveAuthenticatedOrigin,
};
export type AuthenticatedRequestOrigin = AuthenticatedRequestProjection;

const messageWeightCache = new WeakMap<object, number>();

/**
 * Approximate retained size of one cached message, in bytes.
 *
 * Message-count clamping stops being a memory bound the moment attachment
 * bytes live inside messages (inline base64 file parts, typed arrays), so the
 * cache also clamps on this estimate. Weights are memoized per message object:
 * cached messages are treated as immutable once admitted.
 *
 * Registered boundary interpreter: cached messages are deliberately opaque
 * (`unknown`) and this walk is the one place their structure is inspected.
 */
export function estimateCachedMessageBytes(message: unknown): number {
  const memoizable = typeof message === "object" && message !== null;
  if (memoizable) {
    const cached = messageWeightCache.get(message);
    if (cached !== undefined) return cached;
  }

  let weight = 0;
  const pending: unknown[] = [message];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      weight += value.length;
    } else if (typeof value === "number" || typeof value === "boolean") {
      weight += 8;
    } else if (value === null || value === undefined) {
      weight += 4;
    } else if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      weight += value.byteLength;
    } else if (Array.isArray(value)) {
      weight += 2;
      for (const entry of value) pending.push(entry);
    } else if (typeof value === "object") {
      weight += 2;
      for (const [key, entry] of Object.entries(value)) {
        weight += key.length + 4;
        pending.push(entry);
      }
    } else {
      weight += 8;
    }
  }

  if (memoizable) messageWeightCache.set(message, weight);
  return weight;
}

export function projectCachedRequestMessageLineage(
  existing: readonly unknown[],
  incoming: readonly unknown[] = [],
  maxMessages = Number.POSITIVE_INFINITY,
  maxBytes = Number.POSITIVE_INFINITY,
): readonly unknown[] {
  const merged = [...existing, ...incoming];
  const clamped = merged.length > maxMessages ? merged.slice(merged.length - maxMessages) : merged;

  if (!Number.isFinite(maxBytes)) return clamped;

  let total = 0;
  // Walk newest-first so the byte clamp drops the oldest messages, mirroring
  // the count clamp. The newest message is always retained even when it alone
  // exceeds the budget: an empty lineage would break follow-up composition
  // outright, which is worse than one oversized entry.
  let firstKept = clamped.length;
  for (let index = clamped.length - 1; index >= 0; index -= 1) {
    const weight = estimateCachedMessageBytes(clamped[index]);
    if (index < clamped.length - 1 && total + weight > maxBytes) break;
    total += weight;
    firstKept = index;
  }
  return firstKept === 0 ? clamped : clamped.slice(firstKept);
}

export class RequestMessageCacheRequestIdMissing extends TaggedError(
  "RequestMessageCacheRequestIdMissing",
)<{
  readonly messageType: string;
  readonly message: string;
}> {}

export class RequestIdentitySourceMissing extends TaggedError("RequestIdentitySourceMissing")<{
  readonly requestId: string;
  readonly message: string;
}> {}

export class RequestIdentityAliasTargetOccupied extends TaggedError(
  "RequestIdentityAliasTargetOccupied",
)<{
  readonly requestId: string;
  readonly message: string;
}> {}

export type RequestMessageCacheAdmissionError =
  | RequestMessageCacheRequestIdMissing
  | AuthenticatedRequestProjectionInvalid
  | AuthenticatedRequestIdentityConflict;

export type RequestMessageCacheOwnerError =
  | RequestIdentitySourceMissing
  | RequestIdentityAliasTargetOccupied
  | AuthenticatedRequestProjectionInvalid;

export type RequestMessageCacheOwner = {
  readonly requestId: string;
  readonly ownerId: string;
};

export type RequestMessageCacheAliasOwner = RequestMessageCacheOwner & {
  readonly projection: AuthenticatedRequestProjection;
  readonly selfAlias: boolean;
};

type CacheEntry = {
  messages: readonly unknown[];
  projection: AuthenticatedRequestProjection;
  readonly intakeEventIds: Set<string>;
  readonly parkedEventIds: Set<string>;
  readonly owners: Set<string>;
  expiresAt: number;
  updatedAt: number;
};

export type RequestMessageCacheOptions = {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  /** Byte-weighted clamp for one request's retained lineage. */
  readonly maxBytesPerRequest?: number;
  /** Byte-weighted clamp across every cached request, including retained ones. */
  readonly maxBytesTotal?: number;
  readonly now?: () => number;
};

export type RequestMessageCacheRestoreAttempt = {
  apply(): ResultType<void, AuthenticatedRequestIdentityConflict>;
  rollback(): void;
};

export type RequestMessageCache = {
  get(requestId: string): readonly unknown[] | undefined;
  getOrigin(requestId: string): AuthenticatedRequestOrigin | undefined;
  cacheMessage(
    msg: LilacMessageForTopic<"cmd.request">,
    projection?: AuthenticatedRequestProjection,
  ): ResultType<AuthenticatedRequestOrigin | undefined, RequestMessageCacheAdmissionError>;
  prepareRestore(
    input: readonly {
      readonly projection: AuthenticatedRequestProjection;
      readonly parkedEventIds: readonly string[];
    }[],
  ): ResultType<RequestMessageCacheRestoreAttempt, AuthenticatedRequestIdentityConflict>;
  acquireOwner(
    requestId: string,
  ): ResultType<RequestMessageCacheOwner, RequestIdentitySourceMissing>;
  createAliasOwner(input: {
    readonly sourceRequestId: string;
    readonly aliasRequestId: string;
    readonly requestClient: AuthenticatedRequestProjection["requestClient"];
    readonly sessionId: string;
  }): ResultType<RequestMessageCacheAliasOwner, RequestMessageCacheOwnerError>;
  releaseOwner(owner: RequestMessageCacheOwner): boolean;
  finishDelivery(input: {
    readonly requestId: string;
    readonly eventId: string;
    readonly disposition: "release" | "park";
  }): void;
  snapshot(requestId: string):
    | {
        readonly ownerCount: number;
        readonly eventIdCount: number;
        readonly intakeEventCount: number;
        readonly parkedEventIds: readonly string[];
      }
    | undefined;
  stop(): Promise<void>;
};

export function createRequestMessageCache(
  options: RequestMessageCacheOptions = {},
): RequestMessageCache {
  const {
    ttlMs = 30 * 60 * 1000,
    maxEntries = 256,
    maxBytesPerRequest = 32 * 1024 * 1024,
    maxBytesTotal = 256 * 1024 * 1024,
    now = Date.now,
  } = options;
  const maxMessagesPerRequest = 512;
  const logger = createLogger({ module: "tool-server:request-message-cache" });
  const entries = new Map<string, CacheEntry>();

  function isRetained(entry: CacheEntry): boolean {
    return entry.owners.size > 0 || entry.intakeEventIds.size > 0 || entry.parkedEventIds.size > 0;
  }

  function deleteIfUnowned(requestId: string, entry: CacheEntry): void {
    if (!isRetained(entry)) entries.delete(requestId);
  }

  function pruneExpired(at = now()): void {
    for (const [requestId, entry] of entries) {
      if (entry.expiresAt > at || isRetained(entry)) continue;
      entries.delete(requestId);
      logger.debug("request_message_cache.expired", {
        requestId,
        expiresAt: entry.expiresAt,
      });
    }
  }

  function entryWeight(entry: CacheEntry): number {
    let total = 0;
    for (const message of entry.messages) total += estimateCachedMessageBytes(message);
    return total;
  }

  function mapBytes(target: ReadonlyMap<string, CacheEntry>): number {
    let total = 0;
    for (const entry of target.values()) total += entryWeight(entry);
    return total;
  }

  function oldestEvictableKey(
    target: ReadonlyMap<string, CacheEntry>,
    allowRetained: boolean,
  ): string | undefined {
    let oldestKey: string | undefined;
    let oldestUpdatedAt = Infinity;
    for (const [requestId, entry] of target) {
      if (!allowRetained && isRetained(entry)) continue;
      if (entry.updatedAt >= oldestUpdatedAt) continue;
      oldestUpdatedAt = entry.updatedAt;
      oldestKey = requestId;
    }
    return oldestKey;
  }

  function pruneMapToCapacity(target: Map<string, CacheEntry>): string[] {
    const evicted: string[] = [];
    while (target.size > maxEntries) {
      const oldestKey = oldestEvictableKey(target, false) ?? oldestEvictableKey(target, true);
      if (!oldestKey) break;
      target.delete(oldestKey);
      evicted.push(oldestKey);
    }
    return evicted;
  }

  function pruneMapToByteBudget(target: Map<string, CacheEntry>): string[] {
    if (!Number.isFinite(maxBytesTotal)) return [];
    const evicted: string[] = [];
    while (mapBytes(target) > maxBytesTotal && target.size > 0) {
      const oldestKey = oldestEvictableKey(target, false) ?? oldestEvictableKey(target, true);
      if (!oldestKey) break;
      target.delete(oldestKey);
      evicted.push(oldestKey);
    }
    return evicted;
  }

  function logCapacityEvictions(evicted: readonly string[], sizeAfter: number): void {
    for (const requestId of evicted) {
      logger.info("request_message_cache.evicted", {
        requestId,
        reason: "max_entries",
        maxEntries,
        sizeAfter,
      });
    }
  }

  function logByteEvictions(evicted: readonly string[], sizeAfter: number): void {
    for (const requestId of evicted) {
      logger.info("request_message_cache.evicted", {
        requestId,
        reason: "max_bytes_total",
        maxBytesTotal,
        sizeAfter,
      });
    }
  }

  function pruneMax(): void {
    logCapacityEvictions(pruneMapToCapacity(entries), entries.size);
    logByteEvictions(pruneMapToByteBudget(entries), entries.size);
  }

  function cacheMessage(
    msg: LilacMessageForTopic<"cmd.request">,
    trustedProjection?: AuthenticatedRequestProjection,
  ): ResultType<AuthenticatedRequestOrigin | undefined, RequestMessageCacheAdmissionError> {
    if (msg.type !== lilacEventTypes.CmdRequestMessage) return Result.ok(undefined);
    const requestId = msg.headers?.request_id;
    if (!requestId) {
      return Result.err(
        new RequestMessageCacheRequestIdMissing({
          messageType: msg.type,
          message: "cmd.request.message missing headers.request_id",
        }),
      );
    }
    if (
      trustedProjection &&
      (trustedProjection.requestId !== requestId ||
        trustedProjection.requestClient !== (msg.headers?.request_client ?? "unknown") ||
        trustedProjection.sessionId !== msg.headers?.session_id ||
        (trustedProjection.source === "internal-delegated" &&
          trustedProjection.requestClient !== "unknown"))
    ) {
      return Result.err(
        new AuthenticatedRequestIdentityConflict({
          messageType: msg.type,
          message: "trusted request projection conflicts with the decoded request route",
        }),
      );
    }
    const projected = trustedProjection
      ? Result.ok(trustedProjection)
      : projectAuthenticatedRequest(msg);
    const continueProjected = projected.match<
      () => ResultType<AuthenticatedRequestOrigin | undefined, RequestMessageCacheAdmissionError>
    >({
      err: (error) => () => Result.err(error),
      ok: (projection) => () => {
        if (!projection) return Result.ok(undefined);

        pruneExpired();
        const at = now();
        const existing = entries.get(requestId);
        if (existing) {
          const updateExisting = (
            nextProjection: AuthenticatedRequestProjection,
          ): ResultType<
            AuthenticatedRequestOrigin | undefined,
            RequestMessageCacheAdmissionError
          > => {
            existing.projection = nextProjection;
            const alreadyPending =
              existing.intakeEventIds.has(msg.id) || existing.parkedEventIds.has(msg.id);
            existing.intakeEventIds.add(msg.id);
            if (!alreadyPending) {
              existing.messages = projectCachedRequestMessageLineage(
                existing.messages,
                msg.data.messages,
                maxMessagesPerRequest,
                maxBytesPerRequest,
              );
            }
            existing.expiresAt = at + ttlMs;
            existing.updatedAt = at;
            return Result.ok(existing.projection);
          };
          const trustedDelegatedUpgrade =
            trustedProjection?.source === "internal-delegated" &&
            existing.projection.source === "external" &&
            existing.projection.requestId === trustedProjection.requestId &&
            existing.projection.requestClient === "unknown" &&
            existing.projection.requestClient === trustedProjection.requestClient &&
            existing.projection.sessionId === trustedProjection.sessionId;
          if (trustedDelegatedUpgrade) return updateExisting(trustedProjection);
          const latched = latchAuthenticatedRequest(existing.projection, projection, msg.type);
          const continueLatched = latched.match<
            () => ResultType<
              AuthenticatedRequestOrigin | undefined,
              RequestMessageCacheAdmissionError
            >
          >({
            err: (error) => () => Result.err(error),
            ok: (nextProjection) => () => updateExisting(nextProjection),
          });
          return continueLatched();
        }

        const entry: CacheEntry = {
          messages: projectCachedRequestMessageLineage(
            msg.data.messages,
            [],
            maxMessagesPerRequest,
            maxBytesPerRequest,
          ),
          projection,
          intakeEventIds: new Set([msg.id]),
          parkedEventIds: new Set(),
          owners: new Set(),
          expiresAt: at + ttlMs,
          updatedAt: at,
        };
        entries.set(requestId, entry);
        pruneMax();
        return Result.ok(entry.projection);
      },
    });
    return continueProjected();
  }

  function cloneCacheEntry(entry: CacheEntry): CacheEntry {
    return {
      messages: entry.messages,
      projection: entry.projection,
      intakeEventIds: new Set(entry.intakeEventIds),
      parkedEventIds: new Set(entry.parkedEventIds),
      owners: new Set(entry.owners),
      expiresAt: entry.expiresAt,
      updatedAt: entry.updatedAt,
    };
  }

  function cloneEntries(source: ReadonlyMap<string, CacheEntry>): Map<string, CacheEntry> {
    return new Map([...source].map(([requestId, entry]) => [requestId, cloneCacheEntry(entry)]));
  }

  function replaceEntries(source: ReadonlyMap<string, CacheEntry>): void {
    entries.clear();
    for (const [requestId, entry] of source) entries.set(requestId, cloneCacheEntry(entry));
  }

  function prepareRestore(
    input: readonly {
      readonly projection: AuthenticatedRequestProjection;
      readonly parkedEventIds: readonly string[];
    }[],
  ): ResultType<RequestMessageCacheRestoreAttempt, AuthenticatedRequestIdentityConflict> {
    const proposed = new Map<
      string,
      { projection: AuthenticatedRequestProjection; parkedEventIds: Set<string> }
    >();
    const mergeInputAt = (
      index: number,
    ): ResultType<void, AuthenticatedRequestIdentityConflict> => {
      const record = input[index];
      if (!record) return Result.ok(undefined);
      const current = proposed.get(record.projection.requestId);
      if (current) {
        const latched = latchAuthenticatedRequest(
          current.projection,
          record.projection,
          "graceful-restart",
        );
        const continueLatched = latched.match<
          () => ResultType<void, AuthenticatedRequestIdentityConflict>
        >({
          err: (error) => () => Result.err(error),
          ok: (projection) => () => {
            current.projection = projection;
            for (const eventId of record.parkedEventIds) current.parkedEventIds.add(eventId);
            return mergeInputAt(index + 1);
          },
        });
        return continueLatched();
      }
      proposed.set(record.projection.requestId, {
        projection: record.projection,
        parkedEventIds: new Set(record.parkedEventIds),
      });
      return mergeInputAt(index + 1);
    };
    const proposedEntries = () => [...proposed];
    const mergeExistingAt = (
      records: ReturnType<typeof proposedEntries>,
      index: number,
    ): ResultType<void, AuthenticatedRequestIdentityConflict> => {
      const pair = records[index];
      if (!pair) return Result.ok(undefined);
      const [requestId, record] = pair;
      const existing = entries.get(requestId);
      if (!existing) return mergeExistingAt(records, index + 1);
      const latched = latchAuthenticatedRequest(
        existing.projection,
        record.projection,
        "graceful-restart",
      );
      const continueLatched = latched.match<
        () => ResultType<void, AuthenticatedRequestIdentityConflict>
      >({
        err: (error) => () => Result.err(error),
        ok: (projection) => () => {
          record.projection = projection;
          return mergeExistingAt(records, index + 1);
        },
      });
      return continueLatched();
    };

    let before = new Map<string, CacheEntry>();
    let applied = false;
    const merged = mergeInputAt(0).andThen(() => mergeExistingAt(proposedEntries(), 0));
    const continueMerged = merged.match<
      () => ResultType<RequestMessageCacheRestoreAttempt, AuthenticatedRequestIdentityConflict>
    >({
      err: (error) => () => Result.err(error),
      ok: () => () =>
        Result.ok({
          apply: () => {
            if (applied) return Result.ok(undefined);
            const at = now();
            const staged = cloneEntries(entries);
            const stagedRecords = proposedEntries();
            const stageAt = (
              index: number,
            ): ResultType<void, AuthenticatedRequestIdentityConflict> => {
              const pair = stagedRecords[index];
              if (!pair) return Result.ok(undefined);
              const [requestId, record] = pair;
              const existing = staged.get(requestId);
              if (existing) {
                const latched = latchAuthenticatedRequest(
                  existing.projection,
                  record.projection,
                  "graceful-restart",
                );
                const continueLatched = latched.match<
                  () => ResultType<void, AuthenticatedRequestIdentityConflict>
                >({
                  err: (error) => () => Result.err(error),
                  ok: (projection) => () => {
                    const next = cloneCacheEntry(existing);
                    next.projection = projection;
                    for (const eventId of record.parkedEventIds) next.parkedEventIds.add(eventId);
                    next.expiresAt = at + ttlMs;
                    next.updatedAt = at;
                    staged.set(requestId, next);
                    return stageAt(index + 1);
                  },
                });
                return continueLatched();
              }
              staged.set(requestId, {
                messages: [],
                projection: record.projection,
                intakeEventIds: new Set(),
                parkedEventIds: new Set(record.parkedEventIds),
                owners: new Set(),
                expiresAt: at + ttlMs,
                updatedAt: at,
              });
              return stageAt(index + 1);
            };
            const stagedResult = stageAt(0);
            const continueStaged = stagedResult.match<
              () => ResultType<void, AuthenticatedRequestIdentityConflict>
            >({
              err: (error) => () => Result.err(error),
              ok: () => () => {
                const evicted = pruneMapToCapacity(staged);
                const byteEvicted = pruneMapToByteBudget(staged);
                before = cloneEntries(entries);
                replaceEntries(staged);
                applied = true;
                logCapacityEvictions(evicted, entries.size);
                logByteEvictions(byteEvicted, entries.size);
                return Result.ok(undefined);
              },
            });
            return continueStaged();
          },
          rollback: () => {
            if (!applied) return;
            replaceEntries(before);
            applied = false;
          },
        }),
    });
    return continueMerged();
  }

  return {
    get: (requestId) => {
      pruneExpired();
      return entries.get(requestId)?.messages;
    },
    getOrigin: (requestId) => {
      pruneExpired();
      return entries.get(requestId)?.projection;
    },
    cacheMessage,
    prepareRestore,
    acquireOwner: (requestId) => {
      const entry = entries.get(requestId);
      if (!entry) {
        return Result.err(
          new RequestIdentitySourceMissing({
            requestId,
            message: "request cache owner source is not active",
          }),
        );
      }
      const ownerId = crypto.randomUUID();
      entry.owners.add(ownerId);
      return Result.ok({ requestId, ownerId });
    },
    createAliasOwner: (input) => {
      const source = entries.get(input.sourceRequestId);
      if (!source) {
        return Result.err(
          new RequestIdentitySourceMissing({
            requestId: input.sourceRequestId,
            message: "request cache alias source is not active",
          }),
        );
      }
      if (input.aliasRequestId === input.sourceRequestId) {
        const ownerId = crypto.randomUUID();
        source.owners.add(ownerId);
        return Result.ok({
          requestId: input.sourceRequestId,
          ownerId,
          projection: source.projection,
          selfAlias: true,
        });
      }
      if (entries.has(input.aliasRequestId)) {
        return Result.err(
          new RequestIdentityAliasTargetOccupied({
            requestId: input.aliasRequestId,
            message: "request cache alias target is already occupied",
          }),
        );
      }
      const protocol = getBuiltinSurfaceProtocol(input.requestClient);
      const platform = protocol?.platform;
      let aliasActorUserId: string | undefined;
      const authenticatedActor = source.projection.authenticatedActor;
      const authenticatedOrigin = source.projection.authenticatedOrigin;
      if (
        source.projection.source === "external" &&
        platform !== undefined &&
        authenticatedActor?.platform === platform
      ) {
        aliasActorUserId = authenticatedActor.userId;
      } else if (
        source.projection.source === "external" &&
        platform !== undefined &&
        authenticatedOrigin?.platform === platform
      ) {
        aliasActorUserId = authenticatedOrigin.userId;
      }
      let projection: AuthenticatedRequestProjection;
      if (protocol) {
        const registeredPlatform = protocol.platform;
        const sessionRef = protocol.refs.createSessionRef(input.sessionId);
        projection = aliasActorUserId
          ? {
              requestId: input.aliasRequestId,
              requestClient: registeredPlatform,
              sessionId: input.sessionId,
              source: "external",
              platform: registeredPlatform,
              sessionRef,
              authenticatedActor: { platform: registeredPlatform, userId: aliasActorUserId },
              authenticatedOrigin: {
                platform: registeredPlatform,
                userId: aliasActorUserId,
                sessionRef,
              } as AuthenticatedSurfaceOrigin,
              authenticationMetadataKind: "actor",
              verifiedIngress: false,
            }
          : {
              requestId: input.aliasRequestId,
              requestClient: registeredPlatform,
              sessionId: input.sessionId,
              source: "external",
              platform: registeredPlatform,
              sessionRef,
              authenticationMetadataKind: "absent",
              verifiedIngress: false,
            };
      } else {
        projection = {
          requestId: input.aliasRequestId,
          requestClient: input.requestClient,
          sessionId: input.sessionId,
          source: "external",
          authenticationMetadataKind: "absent",
          verifiedIngress: false,
        };
      }
      if (!isAuthenticatedRequestProjectionSemanticallyValid(projection)) {
        return Result.err(
          new AuthenticatedRequestProjectionInvalid({
            messageType: "request-cache-alias",
            message: "request cache alias projection is semantically invalid",
          }),
        );
      }
      const ownerId = crypto.randomUUID();
      entries.set(input.aliasRequestId, {
        messages: projectCachedRequestMessageLineage(source.messages),
        projection,
        intakeEventIds: new Set(),
        parkedEventIds: new Set(),
        owners: new Set([ownerId]),
        expiresAt: source.expiresAt,
        updatedAt: source.updatedAt,
      });
      return Result.ok({
        requestId: input.aliasRequestId,
        ownerId,
        projection,
        selfAlias: false,
      });
    },
    releaseOwner: (owner) => {
      const entry = entries.get(owner.requestId);
      if (!entry || !entry.owners.delete(owner.ownerId)) return false;
      deleteIfUnowned(owner.requestId, entry);
      return true;
    },
    finishDelivery: ({ requestId, eventId, disposition }) => {
      const entry = entries.get(requestId);
      if (!entry) return;
      entry.intakeEventIds.delete(eventId);
      if (disposition === "park") entry.parkedEventIds.add(eventId);
      if (disposition === "release") entry.parkedEventIds.delete(eventId);
      deleteIfUnowned(requestId, entry);
    },
    snapshot: (requestId) => {
      const entry = entries.get(requestId);
      if (!entry) return undefined;
      return {
        ownerCount: entry.owners.size,
        eventIdCount: new Set([...entry.intakeEventIds, ...entry.parkedEventIds]).size,
        intakeEventCount: entry.intakeEventIds.size,
        parkedEventIds: [...entry.parkedEventIds],
      };
    },
    stop: async () => {
      entries.clear();
    },
  };
}
