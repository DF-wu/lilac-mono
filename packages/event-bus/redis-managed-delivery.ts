import { createHash, randomUUID } from "node:crypto";

import type Redis from "ioredis";
import { Panic } from "better-result";

import type { EventDeadLetterReason } from "./event-dead-letter";
import {
  BEGIN_FRESH_SCRIPT,
  BEGIN_INVOCATION_SCRIPT,
  BEGIN_TERMINAL_SCRIPT,
  CLAIM_RECOVERABLE_SCRIPT,
  COMMIT_SCRIPT,
  FINALIZE_TERMINAL_SCRIPT,
  HEARTBEAT_SCRIPT,
  PARK_SCRIPT,
  SCHEDULE_RETRY_SCRIPT,
  STAGE_TERMINAL_SCRIPT,
} from "./redis-managed-delivery/lua";
import {
  decodeBeginFreshResponse,
  decodeBeginInvocationResponse,
  decodeBeginTerminalResponse,
  decodeClaimRecoverableResponse,
  decodeCommitResponse,
  decodeFinalizeTerminalResponse,
  decodeHeartbeatResponse,
  decodeParkResponse,
  decodeScheduleRetryResponse,
  decodeStageTerminalResponse,
  decodeStateCleanupDeleteResponse,
  decodeStateCleanupScanResponse,
  type DecodedRecoveryResponse,
} from "./redis-managed-delivery/responses";

export const MANAGED_REDIS_DELIVERY_VERSION = 2 as const;
export const MANAGED_REDIS_LEASE_MS = 60_000 as const;
export const MANAGED_REDIS_HEARTBEAT_MS = 15_000 as const;
export const MANAGED_REDIS_MAX_ATTEMPTS = 5 as const;
export const MANAGED_REDIS_INITIAL_RETRY_DELAY_MS = 1_000 as const;
export const MANAGED_REDIS_RETRY_MULTIPLIER = 2 as const;
export const MANAGED_REDIS_MAX_RETRY_DELAY_MS = 60_000 as const;

const EPHEMERAL_GROUP_PREFIX = "__lilac_ephemeral__:";
const PHYSICAL_GROUP_PREFIX = "__lilac_managed_v2__:";
const STATE_KEY_PREFIX = "lilac:event-bus:managed-delivery:v2";
const RECOVERY_SCAN_LIMIT = 64;
const RETRY_JITTER_DIVISOR = 5;
const MAX_FAILURE_CHARS = 512;
const MAX_REASON_ISSUES = 32;
const MAX_TERMINAL_INDEX_VALUES = 32;
const MAX_TERMINAL_INDEX_VALUE_CHARS = 1_024;
const STREAM_ID_PATTERN = /^\d+-\d+$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type ManagedAttempt = 1 | 2 | 3 | 4 | 5;
export type ManagedCompletedAttempts = 0 | ManagedAttempt;

export type ManagedClaim = {
  readonly completedAttempts: ManagedCompletedAttempts;
  readonly token: string;
  readonly deliveryId: string;
  readonly leaseDeadline: number;
};

export type ManagedLease = {
  readonly attempt: ManagedAttempt;
  readonly token: string;
  readonly deliveryId: string;
  readonly leaseDeadline: number;
};

export type ManagedRetryFailure = {
  readonly kind: "handler-error";
  readonly errorTag: string;
  readonly errorMessage: string;
};

export type ManagedExhaustionFailure = ManagedRetryFailure | { readonly kind: "lease-expired" };

export type ManagedTerminalMaterial = {
  readonly id: string;
  readonly record: {
    readonly key: string;
    readonly value: string;
  };
  readonly evidence?: {
    readonly key: string;
    readonly value: string;
  };
  readonly index: {
    readonly key: string;
    readonly fields: readonly string[];
    readonly score: number;
    readonly maxLen: number;
  };
  readonly ttlSeconds: number;
};

export type ManagedFreshResult =
  | { readonly status: "claimed"; readonly claim: ManagedClaim }
  | { readonly status: "stale" };

export type ManagedBeginInvocationResult =
  | { readonly status: "invoke"; readonly lease: ManagedLease }
  | { readonly status: "exhausted"; readonly lease: ManagedLease }
  | { readonly status: "stale" };

export type ManagedHeartbeatResult =
  | { readonly status: "extended"; readonly lease: ManagedLease }
  | { readonly status: "stale" };

export type ManagedCommitResult = { readonly status: "committed" } | { readonly status: "stale" };

export type ManagedRetryResult =
  | { readonly status: "scheduled"; readonly dueAt: number }
  | {
      readonly status: "exhausted";
      readonly lease: ManagedLease;
      readonly finalFailure: ManagedRetryFailure;
    }
  | { readonly status: "stale" };

export type ManagedParkResult = { readonly status: "parked" } | { readonly status: "stale" };

export type ManagedRecoveryResult =
  | { readonly status: "none" }
  | { readonly status: "claimed"; readonly id: string; readonly claim: ManagedClaim }
  | {
      readonly status: "exhausted";
      readonly id: string;
      readonly lease: ManagedLease;
      readonly finalFailure: ManagedExhaustionFailure;
    }
  | {
      readonly status: "prepare-terminal";
      readonly id: string;
      readonly lease: ManagedLease;
      readonly reason: EventDeadLetterReason;
    }
  | {
      readonly status: "terminal";
      readonly id: string;
      readonly lease: ManagedLease;
      readonly material: ManagedTerminalMaterial;
    };

export type ManagedStageTerminalResult =
  | { readonly status: "staged" }
  | { readonly status: "stale" };

export type ManagedPrepareTerminalResult =
  | {
      readonly status: "preparing";
      readonly lease: ManagedLease;
      readonly reason: EventDeadLetterReason;
    }
  | { readonly status: "stale" };

export type ManagedFinalizeTerminalResult =
  | { readonly status: "finalized"; readonly id: string }
  | { readonly status: "stale" };

function appendIdentityPart(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.byteLength);
  hash.update(length);
  hash.update(bytes);
}

function canonicalIdentity(domain: string, parts: readonly string[]): string {
  const hash = createHash("sha256");
  hash.update(domain);
  hash.update(Uint8Array.of(MANAGED_REDIS_DELIVERY_VERSION));
  for (const part of parts) appendIdentityPart(hash, part);
  return hash.digest("hex");
}

export function managedRedisPhysicalGroup(
  mode: "work" | "fanout",
  subscriptionId: string,
  ephemeral = false,
  ephemeralIncarnation?: string,
): string {
  if (subscriptionId.length === 0) throw new Error("subscriptionId must not be empty");
  const physicalGroup = `${PHYSICAL_GROUP_PREFIX}${mode}:${subscriptionId}`;
  if (!ephemeral) return physicalGroup;
  if (!ephemeralIncarnation) throw new Error("ephemeralIncarnation must not be empty");
  return `${EPHEMERAL_GROUP_PREFIX}${physicalGroup}:${ephemeralIncarnation}`;
}

export function managedRedisGroupId(streamKey: string, physicalGroup: string): string {
  return canonicalIdentity("lilac:event-bus:managed-delivery:group", [streamKey, physicalGroup]);
}

export function managedRedisDeliveryId(
  streamKey: string,
  physicalGroup: string,
  messageId: string,
): string {
  return canonicalIdentity("lilac:event-bus:managed-delivery:delivery", [
    streamKey,
    physicalGroup,
    messageId,
  ]);
}

export function managedRedisRetryDelayMs(deliveryId: string, nextAttempt: ManagedAttempt): number {
  if (!SHA256_PATTERN.test(deliveryId)) throw new Error("deliveryId must be a SHA-256 digest");
  if (nextAttempt < 2) throw new Error("Retry delay requires a later attempt");
  const baseDelay = Math.min(
    MANAGED_REDIS_MAX_RETRY_DELAY_MS,
    MANAGED_REDIS_INITIAL_RETRY_DELAY_MS * MANAGED_REDIS_RETRY_MULTIPLIER ** (nextAttempt - 2),
  );
  const jitterBound = Math.floor(baseDelay / RETRY_JITTER_DIVISOR);
  const jitterHash = createHash("sha256")
    .update("lilac:event-bus:managed-delivery:retry-jitter")
    .update(Uint8Array.of(MANAGED_REDIS_DELIVERY_VERSION, nextAttempt))
    .update(deliveryId)
    .digest();
  const bucket = jitterHash.readUInt32BE(0) % (jitterBound * 2 + 1);
  return Math.min(MANAGED_REDIS_MAX_RETRY_DELAY_MS, baseDelay + bucket - jitterBound);
}

export function panic(failure: Panic): never;
export function panic(message: string): never;
export function panic(failure: Panic | string): never {
  if (typeof failure !== "string") throw failure;
  throw new Panic({ message: `Managed Redis delivery state is invalid: ${failure}` });
}

function boundReasonText(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= MAX_FAILURE_CHARS) return value;
  let bounded = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > MAX_FAILURE_CHARS) break;
    bounded += character;
    bytes += characterBytes;
  }
  return bounded;
}

function boundTerminalReason(reason: EventDeadLetterReason): EventDeadLetterReason {
  switch (reason.kind) {
    case "contract-invalid":
      return {
        kind: "contract-invalid",
        diagnostic: "event_bus.contract_invalid",
        stage: reason.stage,
        ...(reason.eventType === undefined ? {} : { eventType: boundReasonText(reason.eventType) }),
        issues: reason.issues.slice(0, MAX_REASON_ISSUES).map(boundReasonText),
      };
    case "handler-error":
      return {
        kind: "handler-error",
        errorTag: boundReasonText(reason.errorTag),
        errorMessage: boundReasonText(reason.errorMessage),
      };
    case "attempts-exhausted":
      return {
        kind: "attempts-exhausted",
        finalFailure:
          reason.finalFailure.kind === "lease-expired"
            ? { kind: "lease-expired" }
            : {
                kind: "handler-error",
                errorTag: boundReasonText(reason.finalFailure.errorTag),
                errorMessage: boundReasonText(reason.finalFailure.errorMessage),
              },
      };
  }
}

function assertId(id: string): void {
  if (!STREAM_ID_PATTERN.test(id)) throw new Error("id must be a Redis stream entry ID");
}

function assertLeaseForId(
  lease: ManagedLease | ManagedClaim,
  streamKey: string,
  physicalGroup: string,
  id: string,
): void {
  assertId(id);
  if (lease.deliveryId !== managedRedisDeliveryId(streamKey, physicalGroup, id)) {
    throw new Error("lease does not belong to this delivery");
  }
}

function assertTerminalMaterial(material: ManagedTerminalMaterial): void {
  if (
    material.id.length === 0 ||
    material.record.key.length === 0 ||
    material.record.value.length === 0 ||
    material.index.key.length === 0 ||
    material.index.fields.length === 0 ||
    material.index.fields.length > MAX_TERMINAL_INDEX_VALUES ||
    material.index.fields.length % 2 !== 0
  ) {
    throw new Error("terminal material contains an empty or incomplete identity");
  }
  if (
    material.index.fields.some(
      (value, index) =>
        typeof value !== "string" ||
        Buffer.byteLength(value, "utf8") > MAX_TERMINAL_INDEX_VALUE_CHARS ||
        (index % 2 === 0 && value.length === 0),
    )
  ) {
    throw new Error("terminal index fields must contain bounded string pairs");
  }
  if (
    !Number.isSafeInteger(material.ttlSeconds) ||
    material.ttlSeconds < 1 ||
    !Number.isSafeInteger(material.index.score) ||
    material.index.score < 0 ||
    !Number.isSafeInteger(material.index.maxLen) ||
    material.index.maxLen < 1
  ) {
    throw new Error("terminal TTL and index maxLen must be positive safe integers");
  }
  if (material.evidence?.key.length === 0 || material.evidence?.value.length === 0) {
    throw new Error("terminal evidence must not be empty");
  }
}

export class RedisManagedDelivery {
  private readonly groupId: string;
  private readonly statePrefix: string;
  private readonly dueKey: string;
  private readonly leaseKey: string;
  private readonly terminalKey: string;
  private readonly pelCursorKey: string;

  constructor(
    private readonly redis: Redis,
    private readonly streamKey: string,
    private readonly physicalGroup: string,
    private readonly consumerId: string,
    private readonly ownerId: string,
  ) {
    if (
      streamKey.length === 0 ||
      physicalGroup.length === 0 ||
      consumerId.length === 0 ||
      ownerId.length === 0
    ) {
      throw new Error("Managed Redis delivery identities must not be empty");
    }
    this.groupId = managedRedisGroupId(streamKey, physicalGroup);
    const groupPrefix = `${STATE_KEY_PREFIX}:${this.groupId}`;
    this.statePrefix = `${groupPrefix}:message:`;
    this.dueKey = `${groupPrefix}:due`;
    this.leaseKey = `${groupPrefix}:lease`;
    this.terminalKey = `${groupPrefix}:terminal`;
    this.pelCursorKey = `${groupPrefix}:pel-cursor`;
  }

  private stateKey(id: string): string {
    assertId(id);
    return `${this.statePrefix}${id}`;
  }

  private keys(id: string): readonly [string, string, string, string, string] {
    return [this.streamKey, this.stateKey(id), this.dueKey, this.leaseKey, this.terminalKey];
  }

  async beginFresh(id: string): Promise<ManagedFreshResult> {
    const deliveryId = managedRedisDeliveryId(this.streamKey, this.physicalGroup, id);
    const token = randomUUID();
    const response = decodeBeginFreshResponse(
      await this.redis.eval(
        BEGIN_FRESH_SCRIPT,
        5,
        ...this.keys(id),
        id,
        this.physicalGroup,
        this.consumerId,
        deliveryId,
        token,
        this.ownerId,
        String(MANAGED_REDIS_LEASE_MS),
      ),
    );
    if (response.status === "panic") return panic(response.message);
    if (response.status === "stale") return { status: "stale" };
    if (response.claim.deliveryId !== deliveryId)
      panic("beginFresh returned another delivery identity");
    return { status: "claimed", claim: response.claim };
  }

  async beginInvocation(id: string, claim: ManagedClaim): Promise<ManagedBeginInvocationResult> {
    assertLeaseForId(claim, this.streamKey, this.physicalGroup, id);
    const response = decodeBeginInvocationResponse(
      await this.redis.eval(
        BEGIN_INVOCATION_SCRIPT,
        5,
        ...this.keys(id),
        id,
        claim.token,
        claim.deliveryId,
        this.physicalGroup,
        this.consumerId,
      ),
    );
    if (response.status === "panic") return panic(response.message);
    if (response.status === "stale") return { status: "stale" };
    if (response.lease.deliveryId !== claim.deliveryId) {
      panic("beginInvocation returned another delivery identity");
    }
    return { status: response.status, lease: response.lease };
  }

  async heartbeat(id: string, lease: ManagedLease): Promise<ManagedHeartbeatResult> {
    assertLeaseForId(lease, this.streamKey, this.physicalGroup, id);
    const response = decodeHeartbeatResponse(
      await this.redis.eval(
        HEARTBEAT_SCRIPT,
        5,
        ...this.keys(id),
        id,
        lease.token,
        lease.deliveryId,
        this.physicalGroup,
        this.consumerId,
        String(MANAGED_REDIS_LEASE_MS),
      ),
    );
    if (response.status === "panic") return panic(response.message);
    if (response.status === "stale") return { status: "stale" };
    if (response.lease.deliveryId !== lease.deliveryId) {
      panic("heartbeat returned another delivery identity");
    }
    return { status: "extended", lease: response.lease };
  }

  async commit(id: string, lease: ManagedLease): Promise<ManagedCommitResult> {
    assertLeaseForId(lease, this.streamKey, this.physicalGroup, id);
    const response = decodeCommitResponse(
      await this.redis.eval(
        COMMIT_SCRIPT,
        5,
        ...this.keys(id),
        id,
        lease.token,
        lease.deliveryId,
        this.physicalGroup,
        this.consumerId,
      ),
    );
    if (response.status === "panic") return panic(response.message);
    return { status: response.status };
  }

  async scheduleRetry(
    id: string,
    lease: ManagedLease,
    failure: ManagedRetryFailure,
  ): Promise<ManagedRetryResult> {
    assertLeaseForId(lease, this.streamKey, this.physicalGroup, id);
    if (
      failure.kind !== "handler-error" ||
      typeof failure.errorTag !== "string" ||
      typeof failure.errorMessage !== "string"
    ) {
      throw new Error("Unsupported managed retry failure");
    }
    const boundedFailure: ManagedRetryFailure = {
      kind: "handler-error",
      errorTag: failure.errorTag.slice(0, MAX_FAILURE_CHARS),
      errorMessage: failure.errorMessage.slice(0, MAX_FAILURE_CHARS),
    };
    const nextAttempt = Math.min(MANAGED_REDIS_MAX_ATTEMPTS, lease.attempt + 1) as ManagedAttempt;
    const delay = managedRedisRetryDelayMs(lease.deliveryId, nextAttempt);
    const response = decodeScheduleRetryResponse(
      await this.redis.eval(
        SCHEDULE_RETRY_SCRIPT,
        5,
        ...this.keys(id),
        id,
        lease.token,
        lease.deliveryId,
        this.physicalGroup,
        this.consumerId,
        boundedFailure.errorTag,
        boundedFailure.errorMessage,
        String(delay),
      ),
    );
    if (response.status === "panic") return panic(response.message);
    if (response.status === "stale") return { status: "stale" };
    if (response.status === "scheduled") return response;
    if (response.lease.deliveryId !== lease.deliveryId) {
      panic("scheduleRetry returned another delivery identity");
    }
    return { status: "exhausted", lease: response.lease, finalFailure: boundedFailure };
  }

  async park(id: string, lease: ManagedLease): Promise<ManagedParkResult> {
    assertLeaseForId(lease, this.streamKey, this.physicalGroup, id);
    const response = decodeParkResponse(
      await this.redis.eval(
        PARK_SCRIPT,
        5,
        ...this.keys(id),
        id,
        lease.token,
        lease.deliveryId,
        this.physicalGroup,
        this.consumerId,
      ),
    );
    if (response.status === "panic") return panic(response.message);
    return { status: response.status };
  }

  async claimRecoverable(): Promise<ManagedRecoveryResult> {
    const token = randomUUID();
    const claim = async (orphanDeliveryIds: readonly string[]): Promise<unknown> =>
      this.redis.eval(
        CLAIM_RECOVERABLE_SCRIPT,
        5,
        this.streamKey,
        this.dueKey,
        this.leaseKey,
        this.terminalKey,
        this.pelCursorKey,
        this.physicalGroup,
        this.consumerId,
        this.ownerId,
        token,
        this.statePrefix,
        String(MANAGED_REDIS_LEASE_MS),
        String(RECOVERY_SCAN_LIMIT),
        ...orphanDeliveryIds,
      );
    let response: DecodedRecoveryResponse = decodeClaimRecoverableResponse(
      await claim([]),
      "discover",
    );
    if (response.status === "panic") return panic(response.message);
    if (response.status === "orphans") {
      const orphanDeliveryIds: string[] = [];
      for (const id of response.orphanIds) {
        orphanDeliveryIds.push(id, managedRedisDeliveryId(this.streamKey, this.physicalGroup, id));
      }
      response = decodeClaimRecoverableResponse(await claim(orphanDeliveryIds), "resolve-orphans");
      if (response.status === "panic") return panic(response.message);
      if (response.status === "orphans") return { status: "none" };
    }
    if (response.status === "none") return { status: "none" };
    assertId(response.id);
    if (response.status === "claimed") {
      if (
        response.claim.deliveryId !==
        managedRedisDeliveryId(this.streamKey, this.physicalGroup, response.id)
      ) {
        panic("recovery returned another delivery identity");
      }
      return response;
    }
    if (response.status === "exhausted") {
      if (
        response.lease.deliveryId !==
        managedRedisDeliveryId(this.streamKey, this.physicalGroup, response.id)
      ) {
        panic("recovery returned another delivery identity");
      }
      return response;
    }
    if (response.status === "prepare-terminal") {
      if (
        response.lease.deliveryId !==
        managedRedisDeliveryId(this.streamKey, this.physicalGroup, response.id)
      ) {
        panic("terminal recovery returned another delivery identity");
      }
      return response;
    }
    if (
      response.lease.deliveryId !==
      managedRedisDeliveryId(this.streamKey, this.physicalGroup, response.id)
    ) {
      panic("terminal recovery returned another delivery identity");
    }
    assertTerminalMaterial(response.material);
    return response;
  }

  async beginTerminal(
    id: string,
    ownership: ManagedLease | ManagedClaim,
    reason: EventDeadLetterReason,
  ): Promise<ManagedPrepareTerminalResult> {
    assertLeaseForId(ownership, this.streamKey, this.physicalGroup, id);
    const boundedReason = boundTerminalReason(reason);
    const response = decodeBeginTerminalResponse(
      await this.redis.eval(
        BEGIN_TERMINAL_SCRIPT,
        5,
        ...this.keys(id),
        id,
        ownership.token,
        ownership.deliveryId,
        this.physicalGroup,
        this.consumerId,
        JSON.stringify(boundedReason),
      ),
    );
    if (response.status === "panic") return panic(response.message);
    if (response.status === "stale") return { status: "stale" };
    if (response.lease.deliveryId !== ownership.deliveryId) {
      panic("beginTerminal returned another delivery identity");
    }
    return {
      status: "preparing",
      lease: response.lease,
      reason: response.reason,
    };
  }

  async stageTerminal(
    id: string,
    lease: ManagedLease,
    material: ManagedTerminalMaterial,
  ): Promise<ManagedStageTerminalResult> {
    assertLeaseForId(lease, this.streamKey, this.physicalGroup, id);
    assertTerminalMaterial(material);
    const response = decodeStageTerminalResponse(
      await this.redis.eval(
        STAGE_TERMINAL_SCRIPT,
        5,
        ...this.keys(id),
        id,
        lease.token,
        lease.deliveryId,
        this.physicalGroup,
        this.consumerId,
        material.id,
        material.record.key,
        material.record.value,
        material.evidence ? "1" : "0",
        material.evidence?.key ?? "",
        material.evidence?.value ?? "",
        material.index.key,
        JSON.stringify(material.index.fields),
        String(material.index.score),
        String(material.index.maxLen),
        String(material.ttlSeconds),
      ),
    );
    if (response.status === "panic") return panic(response.message);
    return { status: response.status };
  }

  async finalizeTerminal(id: string, lease: ManagedLease): Promise<ManagedFinalizeTerminalResult> {
    assertLeaseForId(lease, this.streamKey, this.physicalGroup, id);
    const response = decodeFinalizeTerminalResponse(
      await this.redis.eval(
        FINALIZE_TERMINAL_SCRIPT,
        5,
        ...this.keys(id),
        id,
        lease.token,
        lease.deliveryId,
        this.physicalGroup,
        this.consumerId,
      ),
    );
    if (response.status === "panic") return panic(response.message);
    if (response.status === "stale") return { status: "stale" };
    return { status: "finalized", id: response.id };
  }

  async clearAllState(): Promise<void> {
    let cursor = "0";
    do {
      const scanned = decodeStateCleanupScanResponse(
        await this.redis.scan(
          cursor,
          "MATCH",
          `${this.statePrefix}*`,
          "COUNT",
          String(RECOVERY_SCAN_LIMIT),
        ),
        this.statePrefix,
      );
      if (scanned.status === "panic") return panic(scanned.message);
      cursor = scanned.cursor;
      if (scanned.keys.length > 0) {
        const deleted = decodeStateCleanupDeleteResponse(
          await this.redis.del(...scanned.keys),
          scanned.keys.length,
        );
        if (deleted.status === "panic") return panic(deleted.message);
      }
    } while (cursor !== "0");
    const indexKeys = [this.dueKey, this.leaseKey, this.terminalKey, this.pelCursorKey] as const;
    const deleted = decodeStateCleanupDeleteResponse(
      await this.redis.del(...indexKeys),
      indexKeys.length,
    );
    if (deleted.status === "panic") return panic(deleted.message);
  }
}
