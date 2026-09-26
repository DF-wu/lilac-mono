import { lilacEventTypes, type LilacMessageForTopic } from "@stanley2058/lilac-event-bus";
import { createLogger } from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import { Buffer } from "node:buffer";

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
      weight += Buffer.byteLength(value, "utf8");
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
        weight += Buffer.byteLength(key, "utf8") + 4;
        pending.push(entry);
      }
    } else {
      weight += 8;
    }
  }

  if (memoizable) messageWeightCache.set(message, weight);
  return weight;
}

export function estimateCachedMessagesBytes(messages: readonly unknown[]): number {
  return messages.reduce<number>(
    (total, message) => total + estimateCachedMessageBytes(message),
    0,
  );
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
  // the count clamp. Admission validates incoming lineage before this projection,
  // so an oversized newest message is not retained speculatively.
  let firstKept = clamped.length;
  for (let index = clamped.length - 1; index >= 0; index -= 1) {
    const weight = estimateCachedMessageBytes(clamped[index]);
    if (total + weight > maxBytes) break;
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

export class RequestMessageCacheRequestTooLarge extends TaggedError(
  "RequestMessageCacheRequestTooLarge",
)<{
  readonly requestId: string;
  readonly estimatedBytes: number;
  readonly maxBytesPerRequest: number;
  readonly message: string;
}> {}

export class RequestMessageCacheCapacityExceeded extends TaggedError(
  "RequestMessageCacheCapacityExceeded",
)<{
  readonly requestId: string;
  readonly estimatedTotalBytes: number;
  readonly maxTotalBytes: number;
  readonly message: string;
}> {}

export class RequestMessageCacheConfigurationInvalid extends TaggedError(
  "RequestMessageCacheConfigurationInvalid",
)<{
  readonly maxBytesPerRequest: number;
  readonly maxTotalBytes: number;
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
  | RequestMessageCacheRequestTooLarge
  | RequestMessageCacheCapacityExceeded
  | AuthenticatedRequestProjectionInvalid
  | AuthenticatedRequestIdentityConflict;

export type RequestMessageCacheOwnerError =
  | RequestIdentitySourceMissing
  | RequestIdentityAliasTargetOccupied
  | RequestMessageCacheCapacityExceeded
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
  estimatedBytes: number;
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
  /** Hard byte bound across all retained request and alias lineages. */
  readonly maxTotalBytes?: number;
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
    maxTotalBytes = 128 * 1024 * 1024,
    now = Date.now,
  } = options;
  if (
    !Number.isFinite(maxBytesPerRequest) ||
    maxBytesPerRequest < 0 ||
    !Number.isFinite(maxTotalBytes) ||
    maxTotalBytes < 0 ||
    maxBytesPerRequest > maxTotalBytes
  ) {
    throw new RequestMessageCacheConfigurationInvalid({
      maxBytesPerRequest,
      maxTotalBytes,
      message: "request message cache byte limits must be finite, non-negative, and ordered",
    });
  }
  const maxMessagesPerRequest = 512;
  const logger = createLogger({ module: "tool-server:request-message-cache" });
  const entries = new Map<string, CacheEntry>();

  function estimateEntriesBytes(target: ReadonlyMap<string, CacheEntry>): number {
    let total = 0;
    for (const entry of target.values()) total += entry.estimatedBytes;
    return total;
  }

  function isRetained(entry: CacheEntry): boolean {
    return entry.owners.size > 0 || entry.intakeEventIds.size > 0 || entry.parkedEventIds.size > 0;
  }

  function deleteIfUnowned(requestId: string, entry: CacheEntry): void {
    if (!isRetained(entry)) entries.delete(requestId);
  }

  function pruneExpiredMap(
    target: Map<string, CacheEntry>,
    at: number,
  ): readonly { readonly requestId: string; readonly expiresAt: number }[] {
    const expired: { readonly requestId: string; readonly expiresAt: number }[] = [];
    for (const [requestId, entry] of target) {
      if (entry.expiresAt > at || isRetained(entry)) continue;
      target.delete(requestId);
      expired.push({ requestId, expiresAt: entry.expiresAt });
    }
    return expired;
  }

  function logExpired(
    expired: readonly { readonly requestId: string; readonly expiresAt: number }[],
  ): void {
    for (const entry of expired) {
      logger.debug("request_message_cache.expired", {
        requestId: entry.requestId,
        expiresAt: entry.expiresAt,
      });
    }
  }

  function pruneExpired(at = now()): void {
    logExpired(pruneExpiredMap(entries, at));
  }

  function findOldestEvictable(
    target: ReadonlyMap<string, CacheEntry>,
    protectedRequestIds: ReadonlySet<string>,
  ): readonly [string, CacheEntry] | undefined {
    let oldest: readonly [string, CacheEntry] | undefined;
    let oldestUpdatedAt = Infinity;
    for (const [requestId, entry] of target) {
      if (
        protectedRequestIds.has(requestId) ||
        isRetained(entry) ||
        entry.updatedAt >= oldestUpdatedAt
      ) {
        continue;
      }
      oldestUpdatedAt = entry.updatedAt;
      oldest = [requestId, entry];
    }
    return oldest;
  }

  function pruneMapToEntryCapacity(
    target: Map<string, CacheEntry>,
    protectedRequestIds: ReadonlySet<string> = new Set(),
  ): string[] {
    const evicted: string[] = [];
    while (target.size > maxEntries) {
      const oldest = findOldestEvictable(target, protectedRequestIds);
      if (!oldest) break;
      target.delete(oldest[0]);
      evicted.push(oldest[0]);
    }
    return evicted;
  }

  function planAggregateCapacity(input: {
    readonly target: Map<string, CacheEntry>;
    readonly protectedRequestIds: ReadonlySet<string>;
    readonly requestId: string;
  }): ResultType<readonly string[], RequestMessageCacheCapacityExceeded> {
    const evicted: string[] = [];
    let estimatedTotalBytes = estimateEntriesBytes(input.target);
    while (estimatedTotalBytes > maxTotalBytes) {
      const oldest = findOldestEvictable(input.target, input.protectedRequestIds);
      if (!oldest) {
        return Result.err(
          new RequestMessageCacheCapacityExceeded({
            requestId: input.requestId,
            estimatedTotalBytes,
            maxTotalBytes,
            message: "request message cache aggregate byte capacity is retained",
          }),
        );
      }
      input.target.delete(oldest[0]);
      estimatedTotalBytes -= oldest[1].estimatedBytes;
      evicted.push(oldest[0]);
    }
    return Result.ok(evicted);
  }

  function logCapacityEvictions(
    evicted: readonly string[],
    sizeAfter: number,
    reason: "max_entries" | "max_total_bytes",
  ): void {
    for (const requestId of evicted) {
      logger.info("request_message_cache.evicted", {
        requestId,
        reason,
        maxEntries,
        maxTotalBytes,
        sizeAfter,
      });
    }
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
    const projectionError = projected.match({ err: (error) => error, ok: () => null });
    if (projectionError) return Result.err(projectionError);
    const projection = projected.match({ err: () => undefined, ok: (value) => value });
    if (!projection) return Result.ok(undefined);

    const at = now();
    const staged = cloneEntries(entries);
    const expired = pruneExpiredMap(staged, at);
    const existing = staged.get(requestId);
    let nextProjection = projection;
    let nextMessages: readonly unknown[];
    let intakeEventIds: Set<string>;
    let parkedEventIds: Set<string>;
    let owners: Set<string>;
    if (existing) {
      const trustedDelegatedUpgrade =
        trustedProjection?.source === "internal-delegated" &&
        existing.projection.source === "external" &&
        existing.projection.requestId === trustedProjection.requestId &&
        existing.projection.requestClient === "unknown" &&
        existing.projection.requestClient === trustedProjection.requestClient &&
        existing.projection.sessionId === trustedProjection.sessionId;
      if (trustedDelegatedUpgrade) {
        nextProjection = trustedProjection;
      } else {
        const latched = latchAuthenticatedRequest(existing.projection, projection, msg.type);
        const latchError = latched.match({ err: (error) => error, ok: () => null });
        if (latchError) return Result.err(latchError);
        nextProjection = latched.match({
          err: () => existing.projection,
          ok: (value) => value,
        });
      }
      intakeEventIds = new Set(existing.intakeEventIds);
      parkedEventIds = new Set(existing.parkedEventIds);
      owners = new Set(existing.owners);
      const alreadyPending = intakeEventIds.has(msg.id) || parkedEventIds.has(msg.id);
      if (alreadyPending) {
        nextMessages = existing.messages;
      } else {
        const incomingBytes = estimateCachedMessagesBytes(msg.data.messages);
        if (incomingBytes > maxBytesPerRequest) {
          return Result.err(
            new RequestMessageCacheRequestTooLarge({
              requestId,
              estimatedBytes: incomingBytes,
              maxBytesPerRequest,
              message: "request message lineage exceeds the per-request byte limit",
            }),
          );
        }
        nextMessages = projectCachedRequestMessageLineage(
          existing.messages,
          msg.data.messages,
          maxMessagesPerRequest,
          maxBytesPerRequest,
        );
      }
      intakeEventIds.add(msg.id);
    } else {
      const incomingBytes = estimateCachedMessagesBytes(msg.data.messages);
      if (incomingBytes > maxBytesPerRequest) {
        return Result.err(
          new RequestMessageCacheRequestTooLarge({
            requestId,
            estimatedBytes: incomingBytes,
            maxBytesPerRequest,
            message: "request message lineage exceeds the per-request byte limit",
          }),
        );
      }
      nextMessages = projectCachedRequestMessageLineage(
        [],
        msg.data.messages,
        maxMessagesPerRequest,
        maxBytesPerRequest,
      );
      intakeEventIds = new Set([msg.id]);
      parkedEventIds = new Set();
      owners = new Set();
    }
    staged.set(requestId, {
      messages: nextMessages,
      estimatedBytes: estimateCachedMessagesBytes(nextMessages),
      projection: nextProjection,
      intakeEventIds,
      parkedEventIds,
      owners,
      expiresAt: at + ttlMs,
      updatedAt: at,
    });
    const protectedRequestIds = new Set([requestId]);
    const entryEvictions = pruneMapToEntryCapacity(staged, protectedRequestIds);
    const aggregatePlan = planAggregateCapacity({
      target: staged,
      protectedRequestIds,
      requestId,
    });
    const aggregateError = aggregatePlan.match({ err: (error) => error, ok: () => null });
    if (aggregateError) return Result.err(aggregateError);
    const aggregateEvictions = aggregatePlan.match<readonly string[]>({
      err: () => [],
      ok: (evicted) => evicted,
    });

    replaceEntries(staged);
    logExpired(expired);
    logCapacityEvictions(entryEvictions, entries.size, "max_entries");
    logCapacityEvictions(aggregateEvictions, entries.size, "max_total_bytes");
    return Result.ok(nextProjection);
  }

  function cloneCacheEntry(entry: CacheEntry): CacheEntry {
    return {
      messages: entry.messages,
      estimatedBytes: entry.estimatedBytes,
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
                estimatedBytes: 0,
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
                const evicted = pruneMapToEntryCapacity(staged);
                before = cloneEntries(entries);
                replaceEntries(staged);
                applied = true;
                logCapacityEvictions(evicted, entries.size, "max_entries");
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
      const aliasMessages = projectCachedRequestMessageLineage(source.messages);
      const staged = cloneEntries(entries);
      staged.set(input.aliasRequestId, {
        messages: aliasMessages,
        estimatedBytes: estimateCachedMessagesBytes(aliasMessages),
        projection,
        intakeEventIds: new Set(),
        parkedEventIds: new Set(),
        owners: new Set([ownerId]),
        expiresAt: source.expiresAt,
        updatedAt: source.updatedAt,
      });
      const protectedRequestIds = new Set([input.sourceRequestId, input.aliasRequestId]);
      const entryEvictions = pruneMapToEntryCapacity(staged, protectedRequestIds);
      const aggregatePlan = planAggregateCapacity({
        target: staged,
        protectedRequestIds,
        requestId: input.aliasRequestId,
      });
      const aggregateError = aggregatePlan.match({ err: (error) => error, ok: () => null });
      if (aggregateError) return Result.err(aggregateError);
      const aggregateEvictions = aggregatePlan.match<readonly string[]>({
        err: () => [],
        ok: (evicted) => evicted,
      });
      replaceEntries(staged);
      logCapacityEvictions(entryEvictions, entries.size, "max_entries");
      logCapacityEvictions(aggregateEvictions, entries.size, "max_total_bytes");
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
