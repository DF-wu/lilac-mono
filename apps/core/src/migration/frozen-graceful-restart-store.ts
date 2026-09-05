// Frozen decoder retained only by the offline blob migration.
import {
  adapterPlatformSchema,
  corePrimaryLineageV2Schema,
  decodeCorePrimaryLineageV2,
  requestOriginSchema,
  requestQueueModeSchema,
  requestRunPolicySchema,
  storedMessageV1Schema,
} from "@stanley2058/lilac-event-bus";
import {
  CorruptPersistedFields,
  isRecord,
  MalformedSerialization,
  UnsupportedVersion,
  type PersistedDataError,
} from "@stanley2058/lilac-utils";
import { Result, type Result as ResultType } from "better-result";
import SuperJSON from "superjson";
import { z } from "zod";

import { captureError } from "../shared/error-capture.js";
import { parseBufferedForActiveRequestIdFromRaw } from "../surface/bridge/bus-agent-runner/raw";
import {
  isAuthenticatedRequestProjectionSemanticallyValid,
  isPersistedRecoveryAuthenticatedRequestProjectionSemanticallyValid,
  type AuthenticatedRequestProjection,
} from "../surface/authenticated-request";
import type { SurfaceToolStatusUpdate } from "../surface/adapter";
import type { MsgRef, RegisteredSurfacePlatform } from "../surface/types";
import { preserveToolPanic } from "../tools/tool-result-adapters";

export type BusToAdapterRelaySnapshot = {
  requestId: string;
  sessionId: string;
  requestClient?: string;
  platform: RegisteredSurfacePlatform;
  requestStartedAtMs?: number;
  routerSessionMode?: "mention" | "active";
  replyTo?: MsgRef;
  createdOutputRefs: MsgRef[];
  activeOutputRefs?: MsgRef[];
  visibleText: string;
  totalTextChars?: number;
  streamTextPrefixChars?: number;
  streamPhaseBoundaryPrefixChars?: number;
  streamPhaseBoundaryOffsetChars?: number;
  streamPhaseBoundaryPrefix?: string;
  awaitingFinalPhaseBoundaryPrefix?: boolean;
  textPhase?: "commentary" | "final_answer";
  commentaryText?: string;
  finalAnswerText?: string;
  phaseSegmentsValid?: boolean;
  reasoning?: {
    startedAtMs: number;
    frozenAtMs?: number;
    detailText: string;
  };
  toolStatus: SurfaceToolStatusUpdate[];
  outCursor?: string;
};

export const GRACEFUL_RESTART_SNAPSHOT_VERSION = 5 as const;

const GRACEFUL_RESTART_TABLE = "graceful_restart_state";
const GRACEFUL_RESTART_RECORD_ID = "singleton";

export type OpaqueSuperJsonValue = null | undefined | boolean | number | string | bigint | object;

export type GracefulRestartRawValue = OpaqueSuperJsonValue;

export type AgentRunnerRecoveryIdentity =
  | {
      readonly state: "durable";
      readonly projection: AuthenticatedRequestProjection;
      readonly assertedSafetyMode: "trusted" | "restricted";
      readonly parkedEventIds: readonly string[];
      readonly delegationProof?: {
        readonly kind: "workflow";
        readonly runId: string;
        readonly operationId: string;
        readonly dispatchEpoch: string;
      };
    }
  | {
      readonly state: "restricted";
      readonly reason: "legacy-no-durable-proof" | "missing-cache-proof";
    };

export type AgentRunnerQueueAttempt = {
  readonly eventId: string;
  readonly controlRequestId: string;
  readonly controlRequestClient: z.output<typeof adapterPlatformSchema>;
  readonly sessionId: string;
  readonly kind: "queued-cancellation" | "buffered-absorption";
  readonly detail: string;
  readonly controlApplied: boolean;
  readonly controlIdentity: AgentRunnerRecoveryIdentity;
  readonly pendingGroups: readonly {
    readonly publicationIndex: number;
    readonly requestId: string;
    readonly requestClient: z.output<typeof adapterPlatformSchema>;
    readonly targetQueueEntryIds: readonly string[];
  }[];
};

type AgentRunnerRetainedRequestDelivery = {
  readonly requestDeliveryId: string;
  readonly outcome: {
    readonly kind:
      | "completed"
      | "failed"
      | "cancelled"
      | "abandoned"
      | "publication-failed"
      | "upload-failed"
      | "upload-timeout";
    readonly code?: string;
  };
};

export type PersistedGracefulRestartRow = {
  readonly status: string;
  readonly updated_ts?: number;
  readonly payload_json: string;
};

type DecodedGracefulRestartSnapshot = {
  readonly value: GracefulRestartSnapshot | null;
  readonly provenance: "current" | "missing-defaulted";
};

const finiteNonNegativeSchema = z.number().finite().nonnegative();
const finitePositiveSchema = z.number().finite().positive();
const nonemptyStringSchema = z.string().min(1);

function isOpaqueSuperJsonValue(value: unknown): value is OpaqueSuperJsonValue {
  if (value === null) return true;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return false;
  switch (typeof value) {
    case "undefined":
    case "boolean":
    case "number":
    case "string":
    case "bigint":
    case "object":
      return true;
    case "function":
    case "symbol":
      return false;
  }
  return false;
}

function containsManagedOpaqueBytes(
  value: OpaqueSuperJsonValue,
  seen = new Set<object>(),
): boolean {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
  if (value === null || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (value instanceof Map) {
    for (const [key, entry] of value) {
      if (
        key instanceof ArrayBuffer ||
        ArrayBuffer.isView(key) ||
        entry instanceof ArrayBuffer ||
        ArrayBuffer.isView(entry) ||
        (isOpaqueSuperJsonValue(key) && containsManagedOpaqueBytes(key, seen)) ||
        (isOpaqueSuperJsonValue(entry) && containsManagedOpaqueBytes(entry, seen))
      )
        return true;
    }
    return false;
  }
  if (value instanceof Set) {
    for (const entry of value) {
      if (
        entry instanceof ArrayBuffer ||
        ArrayBuffer.isView(entry) ||
        (isOpaqueSuperJsonValue(entry) && containsManagedOpaqueBytes(entry, seen))
      )
        return true;
    }
    return false;
  }
  for (const key of Reflect.ownKeys(value)) {
    const entry = Reflect.get(value, key);
    if (
      entry instanceof ArrayBuffer ||
      ArrayBuffer.isView(entry) ||
      (isOpaqueSuperJsonValue(entry) && containsManagedOpaqueBytes(entry, seen))
    )
      return true;
  }
  return false;
}

const opaqueSuperJsonValueSchema = z.custom<OpaqueSuperJsonValue>(isOpaqueSuperJsonValue);

const registeredPlatformSchema = z.enum(["discord", "github"]);
const discordSessionRefSchema = z.strictObject({
  platform: z.literal("discord"),
  channelId: nonemptyStringSchema,
});
const githubSessionRefSchema = z.strictObject({
  platform: z.literal("github"),
  channelId: nonemptyStringSchema,
});
const persistedSessionRefSchema = z.discriminatedUnion("platform", [
  discordSessionRefSchema,
  githubSessionRefSchema,
]);
const discordMsgRefSchema = z.strictObject({
  platform: z.literal("discord"),
  channelId: nonemptyStringSchema,
  messageId: nonemptyStringSchema,
});
const githubMsgRefSchema = z.strictObject({
  platform: z.literal("github"),
  channelId: nonemptyStringSchema,
  messageId: nonemptyStringSchema,
});
const persistedMsgRefSchema = z.discriminatedUnion("platform", [
  discordMsgRefSchema,
  githubMsgRefSchema,
]);
const authenticatedSurfaceOriginSchema = z.discriminatedUnion("platform", [
  z.strictObject({
    platform: z.literal("discord"),
    userId: nonemptyStringSchema,
    sessionRef: discordSessionRefSchema,
    messageRef: discordMsgRefSchema.optional(),
  }),
  z.strictObject({
    platform: z.literal("github"),
    userId: nonemptyStringSchema,
    sessionRef: githubSessionRefSchema,
    messageRef: githubMsgRefSchema.optional(),
  }),
]);
const authenticatedRequestProjectionSchema = z.strictObject({
  requestId: nonemptyStringSchema,
  requestClient: adapterPlatformSchema,
  sessionId: nonemptyStringSchema,
  source: z.enum(["external", "internal-delegated"]),
  platform: registeredPlatformSchema.optional(),
  sessionRef: persistedSessionRefSchema.optional(),
  messageRef: persistedMsgRefSchema.optional(),
  authenticatedActor: z
    .strictObject({
      platform: registeredPlatformSchema,
      userId: nonemptyStringSchema,
    })
    .optional(),
  authenticatedOrigin: authenticatedSurfaceOriginSchema.optional(),
  authenticationMetadataKind: z.enum([
    "absent",
    "actor",
    "origin",
    "actor-origin",
    "github-trigger",
    "actor-github-trigger",
    "origin-github-trigger",
    "actor-origin-github-trigger",
  ]),
  githubTrigger: z
    .strictObject({
      kind: z.enum(["comment", "issue"]),
      targetKind: z.enum(["issue", "pull-request"]).optional(),
      repoFullName: nonemptyStringSchema.optional(),
      issueNumber: z.number().int().positive().optional(),
      messageId: nonemptyStringSchema,
    })
    .optional(),
  verifiedIngress: z.boolean(),
});
const recoveryIdentitySchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("durable"),
    projection: authenticatedRequestProjectionSchema,
    assertedSafetyMode: z.enum(["trusted", "restricted"]),
    parkedEventIds: z.array(nonemptyStringSchema),
    delegationProof: z
      .strictObject({
        kind: z.literal("workflow"),
        runId: nonemptyStringSchema,
        operationId: nonemptyStringSchema,
        dispatchEpoch: z.string().min(16),
      })
      .optional(),
  }),
  z.strictObject({
    state: z.literal("restricted"),
    reason: z.enum(["legacy-no-durable-proof", "missing-cache-proof"]),
  }),
]);
const queueAttemptGroupSchema = z.strictObject({
  publicationIndex: z.number().int().nonnegative(),
  requestId: nonemptyStringSchema,
  requestClient: adapterPlatformSchema,
  targetQueueEntryIds: z.array(nonemptyStringSchema).min(1),
});
const queueAttemptSchema = z.strictObject({
  eventId: nonemptyStringSchema,
  controlRequestId: nonemptyStringSchema,
  controlRequestClient: adapterPlatformSchema,
  sessionId: nonemptyStringSchema,
  kind: z.enum(["queued-cancellation", "buffered-absorption"]),
  detail: nonemptyStringSchema,
  controlApplied: z.boolean(),
  controlIdentity: recoveryIdentitySchema,
  pendingGroups: z.array(queueAttemptGroupSchema).min(1),
});
const currentAgentRecoveryEntrySchema = z.strictObject({
  queueEntryId: nonemptyStringSchema,
  requestDeliveryId: z.uuid().optional(),
  kind: z.enum(["active", "queued"]),
  requestId: nonemptyStringSchema,
  sessionId: nonemptyStringSchema,
  requestClient: adapterPlatformSchema,
  queue: requestQueueModeSchema,
  runPolicy: requestRunPolicySchema.optional(),
  origin: requestOriginSchema.optional(),
  messages: z.array(storedMessageV1Schema),
  corePrimaryLineage: corePrimaryLineageV2Schema.optional(),
  modelOverride: z.string().optional(),
  currentTurnUserId: nonemptyStringSchema.optional(),
  retainedRequestDeliveries: z
    .array(
      z.strictObject({
        requestDeliveryId: z.uuid(),
        outcome: z.strictObject({
          kind: z.enum([
            "completed",
            "failed",
            "cancelled",
            "abandoned",
            "publication-failed",
            "upload-failed",
            "upload-timeout",
          ]),
          code: z.string().optional(),
        }),
      }),
    )
    .optional(),
  raw: opaqueSuperJsonValueSchema.optional(),
  recovery: z
    .strictObject({
      checkpointMessages: z.array(storedMessageV1Schema),
      partialText: z.string(),
    })
    .optional(),
  identity: recoveryIdentitySchema,
});

type GracefulRestartModelMessage = z.output<typeof storedMessageV1Schema>;
type GracefulRestartCorePrimaryLineage = z.output<typeof corePrimaryLineageV2Schema>;

export type GracefulRestartAgentRecoveryEntry = {
  readonly queueEntryId: string;
  readonly requestDeliveryId?: string;
  readonly kind: "active" | "queued";
  readonly requestId: string;
  readonly sessionId: string;
  readonly requestClient: z.output<typeof adapterPlatformSchema>;
  readonly queue: z.output<typeof requestQueueModeSchema>;
  readonly runPolicy?: z.output<typeof requestRunPolicySchema>;
  readonly origin?: z.output<typeof requestOriginSchema>;
  readonly messages: GracefulRestartModelMessage[];
  readonly corePrimaryLineage?: GracefulRestartCorePrimaryLineage;
  readonly modelOverride?: string;
  readonly currentTurnUserId?: string;
  readonly retainedRequestDeliveries?: readonly AgentRunnerRetainedRequestDelivery[];
  readonly raw?: GracefulRestartRawValue;
  readonly recovery?: {
    readonly checkpointMessages: GracefulRestartModelMessage[];
    readonly partialText: string;
  };
  readonly identity: AgentRunnerRecoveryIdentity;
};

export type GracefulRestartSnapshot = {
  version: typeof GRACEFUL_RESTART_SNAPSHOT_VERSION;
  createdAt: number;
  deadlineMs: number;
  queueAttemptProof: "complete" | "legacy-ambiguous";
  agent: GracefulRestartAgentRecoveryEntry[];
  queueAttempts: AgentRunnerQueueAttempt[];
  relays: BusToAdapterRelaySnapshot[];
};

const relayMsgRefSchema = z.strictObject({
  platform: z.enum(["discord", "github"]),
  channelId: nonemptyStringSchema,
  messageId: nonemptyStringSchema,
});

const toolStatusSchema = z.strictObject({
  toolCallId: nonemptyStringSchema,
  display: z.string(),
  status: z.enum(["start", "update", "end"]),
  ok: z.boolean().optional(),
  error: z.string().optional(),
});

const relaySnapshotShape = {
  requestId: nonemptyStringSchema,
  sessionId: nonemptyStringSchema,
  platform: registeredPlatformSchema,
  requestStartedAtMs: finiteNonNegativeSchema.optional(),
  routerSessionMode: z.enum(["mention", "active"]).optional(),
  replyTo: relayMsgRefSchema.optional(),
  createdOutputRefs: z.array(relayMsgRefSchema),
  activeOutputRefs: z.array(relayMsgRefSchema).optional(),
  visibleText: z.string(),
  totalTextChars: finiteNonNegativeSchema.optional(),
  streamTextPrefixChars: finiteNonNegativeSchema.optional(),
  streamPhaseBoundaryPrefixChars: finiteNonNegativeSchema.optional(),
  streamPhaseBoundaryOffsetChars: finiteNonNegativeSchema.optional(),
  streamPhaseBoundaryPrefix: z.string().optional(),
  awaitingFinalPhaseBoundaryPrefix: z.boolean().optional(),
  textPhase: z.enum(["commentary", "final_answer"]).optional(),
  commentaryText: z.string().optional(),
  finalAnswerText: z.string().optional(),
  phaseSegmentsValid: z.boolean().optional(),
  reasoning: z
    .strictObject({
      startedAtMs: finiteNonNegativeSchema,
      frozenAtMs: finiteNonNegativeSchema.optional(),
      detailText: z.string(),
    })
    .optional(),
  toolStatus: z.array(toolStatusSchema),
  outCursor: z.string().optional(),
};
const currentRelaySnapshotSchema = z.strictObject({
  ...relaySnapshotShape,
  requestClient: registeredPlatformSchema,
});

const currentSnapshotSchema = z.strictObject({
  version: z.literal(GRACEFUL_RESTART_SNAPSHOT_VERSION),
  createdAt: finiteNonNegativeSchema,
  deadlineMs: finitePositiveSchema,
  queueAttemptProof: z.literal("complete"),
  agent: z.array(currentAgentRecoveryEntrySchema),
  queueAttempts: z.array(queueAttemptSchema),
  relays: z.array(currentRelaySnapshotSchema),
});

function persistenceContext(input: {
  readonly field: "payload_json" | "status";
  readonly version: number;
  readonly issueCode: "invalid-row-field" | "malformed-json" | "unsupported-version";
}) {
  return {
    table: GRACEFUL_RESTART_TABLE,
    field: input.field,
    version: input.version,
    issueCode: input.issueCode,
    recordId: GRACEFUL_RESTART_RECORD_ID,
    message: `Persisted graceful restart snapshot ${input.issueCode}`,
  };
}

function corruptSnapshot(version: number, field: "payload_json" | "status") {
  return new CorruptPersistedFields(
    persistenceContext({ field, version, issueCode: "invalid-row-field" }),
  );
}

function parsePersistedPayload(payloadJson: string): ResultType<unknown, MalformedSerialization> {
  {
    const captured = Result.try({
      try: () => {
        const parsed: unknown = SuperJSON.parse(payloadJson);
        return Result.ok(parsed);
      },
      catch: captureError,
    });

    if (captured.isErr()) {
      const cause = captured.error.cause;
      preserveToolPanic(cause);
      return Result.err(
        new MalformedSerialization(
          persistenceContext({
            field: "payload_json",
            version: -1,
            issueCode: "malformed-json",
          }),
        ),
      );
    }
    return captured.value;
  }
}

function validateRelayCorrelation(relay: BusToAdapterRelaySnapshot): boolean {
  if (relay.requestClient !== relay.platform) return false;
  const refs = [
    ...(relay.replyTo ? [relay.replyTo] : []),
    ...relay.createdOutputRefs,
    ...(relay.activeOutputRefs ?? []),
  ];
  return refs.every((ref) => ref.platform === relay.platform && ref.channelId === relay.sessionId);
}

function validateAuthenticatedProjection(
  entry: Pick<GracefulRestartAgentRecoveryEntry, "requestId" | "requestClient" | "sessionId">,
  projection: AuthenticatedRequestProjection,
  requireDurableProof: boolean,
): boolean {
  if (
    projection.requestId !== entry.requestId ||
    projection.requestClient !== entry.requestClient ||
    projection.sessionId !== entry.sessionId
  ) {
    return false;
  }
  return requireDurableProof
    ? isPersistedRecoveryAuthenticatedRequestProjectionSemanticallyValid(projection)
    : isAuthenticatedRequestProjectionSemanticallyValid(projection);
}

function validateRecoveryIdentity(
  route: {
    readonly requestId: string;
    readonly requestClient: z.output<typeof adapterPlatformSchema>;
    readonly sessionId: string;
  },
  identity: AgentRunnerRecoveryIdentity,
  requireDurableProof: boolean,
): boolean {
  if (identity.state === "restricted") return true;
  if (!validateAuthenticatedProjection(route, identity.projection, requireDurableProof))
    return false;
  if (new Set(identity.parkedEventIds).size !== identity.parkedEventIds.length) return false;
  if (identity.projection.source === "internal-delegated") {
    return (
      identity.delegationProof?.kind === "workflow" && identity.assertedSafetyMode === "restricted"
    );
  }
  return identity.delegationProof === undefined;
}

function validateSnapshotCorrelation(
  snapshot: GracefulRestartSnapshot,
  requireDurableProof: boolean,
): boolean {
  const routeByRequestId = new Map<
    string,
    {
      readonly requestClient: z.output<typeof adapterPlatformSchema>;
      readonly sessionId: string;
    }
  >();
  const registerRoute = (
    requestId: string,
    requestClient: z.output<typeof adapterPlatformSchema>,
    sessionId: string,
  ): boolean => {
    const existing = routeByRequestId.get(requestId);
    if (
      existing &&
      (existing.requestClient !== requestClient || existing.sessionId !== sessionId)
    ) {
      return false;
    }
    routeByRequestId.set(requestId, { requestClient, sessionId });
    return true;
  };
  const relayByRequestId = new Map<
    string,
    { readonly platform: "discord" | "github" | "telegram"; readonly sessionId: string }
  >();
  const relayIdentities = new Set<string>();
  for (const relay of snapshot.relays) {
    if (!validateRelayCorrelation(relay)) return false;
    if (!registerRoute(relay.requestId, relay.platform, relay.sessionId)) return false;
    const identity = `${relay.requestId}\u0000${relay.platform}\u0000${relay.sessionId}`;
    if (relayIdentities.has(identity)) return false;
    relayIdentities.add(identity);
    const previous = relayByRequestId.get(relay.requestId);
    if (
      previous &&
      (previous.platform !== relay.platform || previous.sessionId !== relay.sessionId)
    ) {
      return false;
    }
    relayByRequestId.set(relay.requestId, {
      platform: relay.platform,
      sessionId: relay.sessionId,
    });
  }

  const queueEntries = new Map<string, GracefulRestartAgentRecoveryEntry>();
  const activeSessions = new Set<string>();
  const sessionsWithQueuedEntries = new Set<string>();
  for (const entry of snapshot.agent) {
    if (queueEntries.has(entry.queueEntryId)) return false;
    if (!registerRoute(entry.requestId, entry.requestClient, entry.sessionId)) return false;
    if (entry.kind === "active") {
      if (activeSessions.has(entry.sessionId) || sessionsWithQueuedEntries.has(entry.sessionId)) {
        return false;
      }
      activeSessions.add(entry.sessionId);
    } else {
      sessionsWithQueuedEntries.add(entry.sessionId);
    }
    queueEntries.set(entry.queueEntryId, entry);
    const relay = relayByRequestId.get(entry.requestId);
    if (relay && (entry.requestClient !== relay.platform || entry.sessionId !== relay.sessionId)) {
      return false;
    }
    if (!validateRecoveryIdentity(entry, entry.identity, requireDurableProof)) return false;
    if (entry.corePrimaryLineage) {
      const lineage = decodeCorePrimaryLineageV2(entry.corePrimaryLineage, entry.messages);
      if (!lineage.match({ ok: () => true, err: () => false })) return false;
    }
  }

  const attemptEventIds = new Set<string>();
  const reservedEntryIds = new Set<string>();
  for (const attempt of snapshot.queueAttempts) {
    if (attemptEventIds.has(attempt.eventId) || queueEntries.has(attempt.eventId)) return false;
    attemptEventIds.add(attempt.eventId);
    if (!registerRoute(attempt.controlRequestId, attempt.controlRequestClient, attempt.sessionId)) {
      return false;
    }
    if (
      (attempt.kind === "queued-cancellation" && !attempt.controlApplied) ||
      attempt.controlIdentity.state !== "durable" ||
      !attempt.controlIdentity.parkedEventIds.includes(attempt.eventId) ||
      !validateRecoveryIdentity(
        {
          requestId: attempt.controlRequestId,
          requestClient: attempt.controlRequestClient,
          sessionId: attempt.sessionId,
        },
        attempt.controlIdentity,
        requireDurableProof,
      )
    ) {
      return false;
    }
    const publicationIndexes = new Set<number>();
    for (const group of attempt.pendingGroups) {
      if (publicationIndexes.has(group.publicationIndex)) return false;
      if (!registerRoute(group.requestId, group.requestClient, attempt.sessionId)) return false;
      publicationIndexes.add(group.publicationIndex);
      for (const queueEntryId of group.targetQueueEntryIds) {
        if (reservedEntryIds.has(queueEntryId)) return false;
        reservedEntryIds.add(queueEntryId);
        const target = queueEntries.get(queueEntryId);
        if (
          !target ||
          target.kind !== "queued" ||
          target.requestId !== group.requestId ||
          target.requestClient !== group.requestClient ||
          target.sessionId !== attempt.sessionId ||
          (attempt.kind === "buffered-absorption" &&
            parseBufferedForActiveRequestIdFromRaw(target.raw) !== attempt.controlRequestId) ||
          (target.requestId !== attempt.controlRequestId &&
            target.identity.state === "durable" &&
            target.identity.parkedEventIds.includes(attempt.eventId))
        ) {
          return false;
        }
      }
    }
  }
  return true;
}

export function decodeGracefulRestartSnapshot(
  row: PersistedGracefulRestartRow | null,
): ResultType<DecodedGracefulRestartSnapshot, PersistedDataError> {
  if (row === null) {
    return Result.ok<DecodedGracefulRestartSnapshot>({
      value: null,
      provenance: "missing-defaulted",
    });
  }
  if (row.status !== "completed") return Result.err(corruptSnapshot(-1, "status"));

  const parsedResult = parsePersistedPayload(row.payload_json);
  const continueParsed = parsedResult.match<
    () => ResultType<DecodedGracefulRestartSnapshot, PersistedDataError>
  >({
    err: (error) => () => Result.err(error),
    ok: (parsed) => () => {
      const versionValue = isRecord(parsed) ? parsed["version"] : undefined;
      const version =
        typeof versionValue === "number" && Number.isInteger(versionValue)
          ? versionValue
          : undefined;
      if (version === undefined) return Result.err(corruptSnapshot(-1, "payload_json"));
      if (version !== GRACEFUL_RESTART_SNAPSHOT_VERSION) {
        return Result.err(
          new UnsupportedVersion(
            persistenceContext({
              field: "payload_json",
              version,
              issueCode: "unsupported-version",
            }),
          ),
        );
      }

      if (isRecord(parsed) && Array.isArray(parsed["agent"])) {
        for (const entry of parsed["agent"]) {
          if (
            isRecord(entry) &&
            entry["raw"] !== undefined &&
            (!isOpaqueSuperJsonValue(entry["raw"]) || containsManagedOpaqueBytes(entry["raw"]))
          ) {
            return Result.err(corruptSnapshot(version, "payload_json"));
          }
        }
      }
      const decoded = currentSnapshotSchema.safeParse(parsed);
      if (!decoded.success) return Result.err(corruptSnapshot(version, "payload_json"));
      if (!validateSnapshotCorrelation(decoded.data, true)) {
        return Result.err(corruptSnapshot(version, "payload_json"));
      }
      return Result.ok<DecodedGracefulRestartSnapshot>({
        value: decoded.data,
        provenance: "current",
      });
    },
  });
  return continueParsed();
}

const fixtureSnapshot = {
  version: GRACEFUL_RESTART_SNAPSHOT_VERSION,
  createdAt: 1,
  deadlineMs: 1_000,
  queueAttemptProof: "complete",
  agent: [],
  queueAttempts: [],
  relays: [],
} as const satisfies GracefulRestartSnapshot;

export const gracefulRestartSnapshotCodecCases = {
  current: {
    input: {
      status: "completed",
      payload_json: SuperJSON.stringify(fixtureSnapshot),
    },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: {
      status: "completed",
      payload_json: SuperJSON.stringify({
        version: 2,
        createdAt: fixtureSnapshot.createdAt,
        deadlineMs: fixtureSnapshot.deadlineMs,
        agent: [],
        relays: [],
      }),
    },
    outcome: "error",
  },
  "missing-defaulted": {
    input: null,
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": {
    input: {
      status: "completed",
      payload_json: SuperJSON.stringify({ ...fixtureSnapshot, version: 6 }),
    },
    outcome: "error",
  },
  "malformed-serialization": {
    input: { status: "completed", payload_json: "{" },
    outcome: "error",
  },
  "corrupt-fields": {
    input: {
      status: "completed",
      payload_json: SuperJSON.stringify({ ...fixtureSnapshot, agent: [{}] }),
    },
    outcome: "error",
  },
} as const;
