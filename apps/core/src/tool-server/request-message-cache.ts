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

export {
  AuthenticatedRequestProjectionInvalid as RequestMessageCacheProjectionInvalid,
  projectAuthenticatedRequest as resolveAuthenticatedOrigin,
};
export type AuthenticatedRequestOrigin = AuthenticatedRequestProjection;

export function projectCachedRequestMessageLineage(
  existing: readonly unknown[],
  incoming: readonly unknown[] = [],
  maxMessages = Number.POSITIVE_INFINITY,
): readonly unknown[] {
  const merged = [...existing, ...incoming];
  return merged.length > maxMessages ? merged.slice(merged.length - maxMessages) : merged;
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
  const { ttlMs = 30 * 60 * 1000, maxEntries = 256, now = Date.now } = options;
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

  function pruneMapToCapacity(target: Map<string, CacheEntry>): string[] {
    const evicted: string[] = [];
    while (target.size > maxEntries) {
      let oldestKey: string | undefined;
      let oldestUpdatedAt = Infinity;
      for (const [requestId, entry] of target) {
        if (isRetained(entry) || entry.updatedAt >= oldestUpdatedAt) continue;
        oldestUpdatedAt = entry.updatedAt;
        oldestKey = requestId;
      }
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

  function pruneMax(): void {
    logCapacityEvictions(pruneMapToCapacity(entries), entries.size);
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
    if (projected.status === "error") return Result.err(projected.error);
    if (!projected.value) return Result.ok(undefined);

    pruneExpired();
    const at = now();
    const existing = entries.get(requestId);
    if (existing) {
      const trustedDelegatedUpgrade =
        trustedProjection?.source === "internal-delegated" &&
        existing.projection.source === "external" &&
        existing.projection.requestId === trustedProjection.requestId &&
        existing.projection.requestClient === "unknown" &&
        existing.projection.requestClient === trustedProjection.requestClient &&
        existing.projection.sessionId === trustedProjection.sessionId;
      if (trustedDelegatedUpgrade) {
        existing.projection = trustedProjection;
      } else {
        const latched = latchAuthenticatedRequest(existing.projection, projected.value, msg.type);
        if (latched.status === "error") return Result.err(latched.error);
        existing.projection = latched.value;
      }
      const alreadyPending =
        existing.intakeEventIds.has(msg.id) || existing.parkedEventIds.has(msg.id);
      existing.intakeEventIds.add(msg.id);
      if (!alreadyPending) {
        existing.messages = projectCachedRequestMessageLineage(
          existing.messages,
          msg.data.messages,
          maxMessagesPerRequest,
        );
      }
      existing.expiresAt = at + ttlMs;
      existing.updatedAt = at;
      return Result.ok(existing.projection);
    }

    const entry: CacheEntry = {
      messages: projectCachedRequestMessageLineage(msg.data.messages, [], maxMessagesPerRequest),
      projection: projected.value,
      intakeEventIds: new Set([msg.id]),
      parkedEventIds: new Set(),
      owners: new Set(),
      expiresAt: at + ttlMs,
      updatedAt: at,
    };
    entries.set(requestId, entry);
    pruneMax();
    return Result.ok(entry.projection);
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
    for (const record of input) {
      const current = proposed.get(record.projection.requestId);
      if (current) {
        const latched = latchAuthenticatedRequest(
          current.projection,
          record.projection,
          "graceful-restart",
        );
        if (latched.status === "error") return Result.err(latched.error);
        current.projection = latched.value;
        for (const eventId of record.parkedEventIds) current.parkedEventIds.add(eventId);
      } else {
        proposed.set(record.projection.requestId, {
          projection: record.projection,
          parkedEventIds: new Set(record.parkedEventIds),
        });
      }
    }
    for (const [requestId, record] of proposed) {
      const existing = entries.get(requestId);
      if (!existing) continue;
      const latched = latchAuthenticatedRequest(
        existing.projection,
        record.projection,
        "graceful-restart",
      );
      if (latched.status === "error") return Result.err(latched.error);
      record.projection = latched.value;
    }

    let before = new Map<string, CacheEntry>();
    let applied = false;
    return Result.ok({
      apply: () => {
        if (applied) return Result.ok(undefined);
        const at = now();
        const staged = cloneEntries(entries);
        for (const [requestId, record] of proposed) {
          const existing = staged.get(requestId);
          if (existing) {
            const latched = latchAuthenticatedRequest(
              existing.projection,
              record.projection,
              "graceful-restart",
            );
            if (latched.status === "error") return Result.err(latched.error);
            const next = cloneCacheEntry(existing);
            next.projection = latched.value;
            for (const eventId of record.parkedEventIds) next.parkedEventIds.add(eventId);
            next.expiresAt = at + ttlMs;
            next.updatedAt = at;
            staged.set(requestId, next);
          } else {
            staged.set(requestId, {
              messages: [],
              projection: record.projection,
              intakeEventIds: new Set(),
              parkedEventIds: new Set(record.parkedEventIds),
              owners: new Set(),
              expiresAt: at + ttlMs,
              updatedAt: at,
            });
          }
        }
        const evicted = pruneMapToCapacity(staged);
        before = cloneEntries(entries);
        replaceEntries(staged);
        applied = true;
        logCapacityEvictions(evicted, entries.size);
        return Result.ok(undefined);
      },
      rollback: () => {
        if (!applied) return;
        replaceEntries(before);
        applied = false;
      },
    });
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
      const platform =
        input.requestClient === "discord" || input.requestClient === "github"
          ? input.requestClient
          : undefined;
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
      switch (platform) {
        case "discord": {
          const sessionRef = { platform, channelId: input.sessionId } as const;
          projection = aliasActorUserId
            ? {
                requestId: input.aliasRequestId,
                requestClient: platform,
                sessionId: input.sessionId,
                source: "external",
                platform,
                sessionRef,
                authenticatedActor: { platform, userId: aliasActorUserId },
                authenticatedOrigin: { platform, userId: aliasActorUserId, sessionRef },
                authenticationMetadataKind: "actor",
                verifiedIngress: false,
              }
            : {
                requestId: input.aliasRequestId,
                requestClient: platform,
                sessionId: input.sessionId,
                source: "external",
                platform,
                sessionRef,
                authenticationMetadataKind: "absent",
                verifiedIngress: false,
              };
          break;
        }
        case "github": {
          const sessionRef = { platform, channelId: input.sessionId } as const;
          projection = aliasActorUserId
            ? {
                requestId: input.aliasRequestId,
                requestClient: platform,
                sessionId: input.sessionId,
                source: "external",
                platform,
                sessionRef,
                authenticatedActor: { platform, userId: aliasActorUserId },
                authenticatedOrigin: { platform, userId: aliasActorUserId, sessionRef },
                authenticationMetadataKind: "actor",
                verifiedIngress: false,
              }
            : {
                requestId: input.aliasRequestId,
                requestClient: platform,
                sessionId: input.sessionId,
                source: "external",
                platform,
                sessionRef,
                authenticationMetadataKind: "absent",
                verifiedIngress: false,
              };
          break;
        }
        default:
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
