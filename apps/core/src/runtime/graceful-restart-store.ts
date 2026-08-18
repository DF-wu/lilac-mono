import { captureError } from "../shared/error-capture.js";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  adapterPlatformSchema,
  decodeCorePrimaryLineageV1,
  requestOriginSchema,
  requestQueueModeSchema,
  requestRunPolicySchema,
} from "@stanley2058/lilac-event-bus";
import {
  classifyBunSqliteError,
  CorruptPersistedFields,
  isRecord,
  MalformedSerialization,
  runBunSqliteTransaction,
  UnsupportedVersion,
  type DecodedPersistedValue,
  type PersistedDataError,
  type PersistenceProvenance,
} from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import SuperJSON from "superjson";
import { z } from "zod";

import type {
  AgentRunnerQueueAttempt,
  AgentRunnerRecoveryEntry,
  AgentRunnerRecoveryIdentity,
} from "../surface/bridge/bus-agent-runner";
import { parseBufferedForActiveRequestIdFromRaw } from "../surface/bridge/bus-agent-runner/raw";
import {
  isAuthenticatedRequestProjectionSemanticallyValid,
  isPersistedRecoveryAuthenticatedRequestProjectionSemanticallyValid,
  type AuthenticatedRequestProjection,
} from "../surface/authenticated-request";
import type { BusToAdapterRelaySnapshot } from "../surface/bridge/subscribe-from-bus";
import { preserveToolPanic } from "../tools/tool-result-adapters";

export const GRACEFUL_RESTART_SNAPSHOT_VERSION = 4 as const;

const GRACEFUL_RESTART_TABLE = "graceful_restart_state";
const GRACEFUL_RESTART_RECORD_ID = "singleton";

export type OpaqueSuperJsonValue = null | undefined | boolean | number | string | bigint | object;

export type GracefulRestartRawValue = OpaqueSuperJsonValue;

export type PersistedGracefulRestartRow = {
  readonly status: string;
  readonly updated_ts?: number;
  readonly payload_json: string;
};

export type GracefulRestartRowToken = {
  readonly updatedAt: number;
  readonly payloadSha256: string;
};

export type GracefulRestartLoadOutcome =
  | {
      readonly state: "loaded";
      readonly snapshot: GracefulRestartSnapshot;
      readonly rowToken: GracefulRestartRowToken;
      readonly provenance: "current" | "migrated";
    }
  | {
      readonly state: "empty";
      readonly rowToken: GracefulRestartRowToken;
      readonly provenance: "current" | "migrated";
    }
  | {
      readonly state: "absent";
      readonly provenance: "missing-defaulted";
    }
  | {
      readonly state: "stale";
      readonly rowToken: GracefulRestartRowToken;
      readonly createdAt: number;
      readonly deadlineMs: number;
      readonly ageMs: number;
      readonly provenance: "current" | "migrated";
    };

export class GracefulRestartSqliteFailure extends TaggedError("GracefulRestartSqliteFailure")<{
  readonly operation: "clear" | "consume" | "read" | "save";
  readonly code: string;
  readonly message: string;
}> {}

export class GracefulRestartSerializationFailure extends TaggedError(
  "GracefulRestartSerializationFailure",
)<{
  readonly message: string;
}> {}

export class GracefulRestartDispositionConflict extends TaggedError(
  "GracefulRestartDispositionConflict",
)<{
  readonly message: string;
}> {}

export class OpaqueSuperJsonValueUnsupported extends TaggedError(
  "OpaqueSuperJsonValueUnsupported",
)<{
  readonly message: string;
}> {}

export type GracefulRestartSaveError =
  | CorruptPersistedFields
  | GracefulRestartSerializationFailure
  | GracefulRestartSqliteFailure;

export type GracefulRestartLoadError = PersistedDataError | GracefulRestartSqliteFailure;
export type GracefulRestartConsumeError =
  | GracefulRestartDispositionConflict
  | GracefulRestartSqliteFailure;

const finiteNonNegativeSchema = z.number().finite().nonnegative();
const finitePositiveSchema = z.number().finite().positive();
const nonemptyStringSchema = z.string().min(1);

function isOpaqueSuperJsonValue(value: unknown): value is OpaqueSuperJsonValue {
  if (value === null) return true;
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

export function decodeOpaqueSuperJsonValue(
  value: unknown,
): ResultType<OpaqueSuperJsonValue, OpaqueSuperJsonValueUnsupported> {
  if (!isOpaqueSuperJsonValue(value)) {
    return Result.err(
      new OpaqueSuperJsonValueUnsupported({
        message: "Opaque graceful restart value is not supported by SuperJSON",
      }),
    );
  }
  {
    const captured = Result.try({
      try: () => {
        const serialized = SuperJSON.stringify(value);
        const roundTripped: unknown = SuperJSON.parse(serialized);
        if (!isOpaqueSuperJsonValue(roundTripped) || !isDeepStrictEqual(roundTripped, value)) {
          return Result.err(
            new OpaqueSuperJsonValueUnsupported({
              message: "Opaque graceful restart value cannot be preserved exactly by SuperJSON",
            }),
          );
        }
        return Result.ok(value);
      },
      catch: captureError,
    });

    if (captured.isErr()) {
      const cause = captured.error.cause;
      preserveToolPanic(cause);
      return Result.err(
        new OpaqueSuperJsonValueUnsupported({
          message: "Opaque graceful restart value cannot be serialized safely by SuperJSON",
        }),
      );
    }
    return captured.value;
  }
}

const opaqueSuperJsonValueSchema = z.custom<OpaqueSuperJsonValue>(isOpaqueSuperJsonValue);

type GracefulRestartJsonValue =
  | null
  | boolean
  | number
  | string
  | GracefulRestartJsonValue[]
  | { [key: string]: GracefulRestartJsonValue | undefined };

const jsonValueSchema: z.ZodType<GracefulRestartJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema.optional()),
  ]),
);
const providerOptionsSchema = z.record(
  z.string(),
  z.record(z.string(), jsonValueSchema.optional()),
);
const providerReferenceSchema = z.record(z.string(), z.string());
const dataContentSchema = z.union([
  z.string(),
  z.instanceof(Uint8Array),
  z.instanceof(ArrayBuffer),
]);
const providerDataSchema = z.union([dataContentSchema, z.instanceof(URL), providerReferenceSchema]);
const partProviderOptions = { providerOptions: providerOptionsSchema.optional() };
const textPartSchema = z.strictObject({
  type: z.literal("text"),
  text: z.string(),
  ...partProviderOptions,
});
const imagePartSchema = z.strictObject({
  type: z.literal("image"),
  image: providerDataSchema,
  mediaType: z.string().optional(),
  ...partProviderOptions,
});
const filePartSchema = z.strictObject({
  type: z.literal("file"),
  data: providerDataSchema,
  filename: z.string().optional(),
  mediaType: z.string(),
  ...partProviderOptions,
});
const reasoningPartSchema = z.strictObject({
  type: z.literal("reasoning"),
  text: z.string(),
  ...partProviderOptions,
});
const reasoningFilePartSchema = z.strictObject({
  type: z.literal("reasoning-file"),
  data: z.union([dataContentSchema, z.instanceof(URL)]),
  mediaType: z.string(),
  ...partProviderOptions,
});
const customPartSchema = z.strictObject({
  type: z.literal("custom"),
  kind: z.templateLiteral([z.string(), ".", z.string()]),
  ...partProviderOptions,
});
const toolCallPartSchema = z.strictObject({
  type: z.literal("tool-call"),
  toolCallId: z.string(),
  toolName: z.string(),
  input: opaqueSuperJsonValueSchema,
  providerExecuted: z.boolean().optional(),
  ...partProviderOptions,
});
const toolOutputContentPartSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string(), ...partProviderOptions }),
  z.strictObject({
    type: z.literal("file-data"),
    data: z.string(),
    mediaType: z.string(),
    filename: z.string().optional(),
    ...partProviderOptions,
  }),
  z.strictObject({ type: z.literal("file-url"), url: z.string(), ...partProviderOptions }),
  z.strictObject({
    type: z.literal("file-id"),
    fileId: z.union([z.string(), providerReferenceSchema]),
    ...partProviderOptions,
  }),
  z.strictObject({
    type: z.literal("file-reference"),
    providerReference: providerReferenceSchema,
    ...partProviderOptions,
  }),
  z.strictObject({
    type: z.literal("image-data"),
    data: z.string(),
    mediaType: z.string(),
    ...partProviderOptions,
  }),
  z.strictObject({ type: z.literal("image-url"), url: z.string(), ...partProviderOptions }),
  z.strictObject({
    type: z.literal("image-file-id"),
    fileId: z.union([z.string(), providerReferenceSchema]),
    ...partProviderOptions,
  }),
  z.strictObject({
    type: z.literal("image-file-reference"),
    providerReference: providerReferenceSchema,
    ...partProviderOptions,
  }),
  z.strictObject({ type: z.literal("custom"), ...partProviderOptions }),
]);
const toolResultOutputSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), value: z.string(), ...partProviderOptions }),
  z.strictObject({ type: z.literal("json"), value: jsonValueSchema, ...partProviderOptions }),
  z.strictObject({
    type: z.literal("execution-denied"),
    reason: z.string().optional(),
    ...partProviderOptions,
  }),
  z.strictObject({ type: z.literal("error-text"), value: z.string(), ...partProviderOptions }),
  z.strictObject({
    type: z.literal("error-json"),
    value: jsonValueSchema,
    ...partProviderOptions,
  }),
  z.strictObject({
    type: z.literal("content"),
    value: z.array(toolOutputContentPartSchema),
  }),
]);
const toolResultPartSchema = z.strictObject({
  type: z.literal("tool-result"),
  toolCallId: z.string(),
  toolName: z.string(),
  output: toolResultOutputSchema,
  ...partProviderOptions,
});
const toolApprovalRequestSchema = z.strictObject({
  type: z.literal("tool-approval-request"),
  approvalId: z.string(),
  toolCallId: z.string(),
});
const toolApprovalResponseSchema = z.strictObject({
  type: z.literal("tool-approval-response"),
  approvalId: z.string(),
  approved: z.boolean(),
  reason: z.string().optional(),
});
const messageProviderOptions = { providerOptions: providerOptionsSchema.optional() };
const persistedModelMessageSchema = z.discriminatedUnion("role", [
  z.strictObject({ role: z.literal("system"), content: z.string(), ...messageProviderOptions }),
  z.strictObject({
    role: z.literal("user"),
    content: z.union([
      z.string(),
      z.array(z.union([textPartSchema, imagePartSchema, filePartSchema])),
    ]),
    ...messageProviderOptions,
  }),
  z.strictObject({
    role: z.literal("assistant"),
    content: z.union([
      z.string(),
      z.array(
        z.union([
          textPartSchema,
          customPartSchema,
          filePartSchema,
          reasoningPartSchema,
          reasoningFilePartSchema,
          toolCallPartSchema,
          toolResultPartSchema,
          toolApprovalRequestSchema,
        ]),
      ),
    ]),
    ...messageProviderOptions,
  }),
  z.strictObject({
    role: z.literal("tool"),
    content: z.array(z.union([toolResultPartSchema, toolApprovalResponseSchema])),
    ...messageProviderOptions,
  }),
]);

const lineageAtomSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("surface"),
    requestClient: nonemptyStringSchema,
    surfaceId: nonemptyStringSchema,
    sessionId: nonemptyStringSchema,
    messageId: nonemptyStringSchema,
  }),
  z.strictObject({
    kind: z.literal("request"),
    requestId: nonemptyStringSchema,
    transcriptDigest: nonemptyStringSchema,
    providerFamily: z.enum(["claude-code", "ai-sdk"]),
    containsCrossFamilyTurns: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("synthetic"),
    source: nonemptyStringSchema,
    messageDigest: nonemptyStringSchema,
  }),
  z.strictObject({
    kind: z.literal("checkpoint"),
    requestId: nonemptyStringSchema,
    transcriptDigest: nonemptyStringSchema,
  }),
]);
const lineageAliasSchema = z.strictObject({
  requestClient: nonemptyStringSchema,
  surfaceId: nonemptyStringSchema,
  sessionId: nonemptyStringSchema,
  messageId: nonemptyStringSchema,
});
const closedCorePrimaryLineageSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("complete"),
    lineageVersion: z.literal(1),
    currentCanonicalStart: z.number().int().nonnegative(),
    segments: z.array(
      z.strictObject({
        atoms: z.array(lineageAtomSchema),
        canonicalMessages: z.array(persistedModelMessageSchema),
        requestSource: z.strictObject({ aliases: z.array(lineageAliasSchema) }).optional(),
        canonicalStart: z.number().int().nonnegative(),
        canonicalEnd: z.number().int().positive(),
        cumulativeAtomCount: z.number().int().positive(),
        cumulativePrefixDigest: nonemptyStringSchema,
      }),
    ),
  }),
  z.strictObject({
    state: z.literal("fresh-only"),
    lineageVersion: z.literal(1),
    currentCanonicalStart: z.number().int().nonnegative(),
    reason: nonemptyStringSchema,
  }),
]);
const persistedCorePrimaryLineageSchema = closedCorePrimaryLineageSchema;

const recoverySchema = z.strictObject({
  checkpointMessages: z.array(persistedModelMessageSchema),
  partialText: z.string(),
});

const legacyAgentRecoveryEntrySchema = z.strictObject({
  kind: z.enum(["active", "queued"]),
  requestId: nonemptyStringSchema,
  sessionId: nonemptyStringSchema,
  requestClient: adapterPlatformSchema,
  queue: requestQueueModeSchema,
  runPolicy: requestRunPolicySchema.optional(),
  origin: requestOriginSchema.optional(),
  messages: z.array(persistedModelMessageSchema),
  corePrimaryLineage: persistedCorePrimaryLineageSchema.optional(),
  modelOverride: z.string().optional(),
  raw: opaqueSuperJsonValueSchema.optional(),
  recovery: recoverySchema.optional(),
});

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
const agentRecoveryEntryV3Schema = legacyAgentRecoveryEntrySchema.extend({
  queueEntryId: nonemptyStringSchema,
  identity: recoveryIdentitySchema,
});
const currentAgentRecoveryEntrySchema = agentRecoveryEntryV3Schema.extend({
  currentTurnUserId: nonemptyStringSchema.optional(),
});

type GracefulRestartModelMessage = z.output<typeof persistedModelMessageSchema>;
type GracefulRestartCorePrimaryLineage =
  | {
      readonly state: "fresh-only";
      readonly lineageVersion: 1;
      readonly currentCanonicalStart: number;
      readonly reason: string;
    }
  | {
      readonly state: "complete";
      readonly lineageVersion: 1;
      readonly currentCanonicalStart: number;
      readonly segments: Array<{
        readonly atoms: z.output<typeof lineageAtomSchema>[];
        readonly canonicalMessages: GracefulRestartModelMessage[];
        readonly requestSource?: { readonly aliases: z.output<typeof lineageAliasSchema>[] };
        readonly canonicalStart: number;
        readonly canonicalEnd: number;
        readonly cumulativeAtomCount: number;
        readonly cumulativePrefixDigest: string;
      }>;
    };

export type GracefulRestartAgentRecoveryEntry = {
  readonly queueEntryId: string;
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

export type GracefulRestartSnapshotInput = Omit<GracefulRestartSnapshot, "agent"> & {
  readonly agent: AgentRunnerRecoveryEntry[];
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
const legacyRelaySnapshotSchema = z.strictObject({
  ...relaySnapshotShape,
  requestClient: z.string().optional(),
});
const currentRelaySnapshotSchema = z.strictObject({
  ...relaySnapshotShape,
  requestClient: registeredPlatformSchema,
});

const legacySnapshotPayloadShape = {
  createdAt: finiteNonNegativeSchema,
  deadlineMs: finitePositiveSchema,
  agent: z.array(legacyAgentRecoveryEntrySchema),
  relays: z.array(legacyRelaySnapshotSchema),
};

const currentSnapshotSchema = z.strictObject({
  version: z.literal(GRACEFUL_RESTART_SNAPSHOT_VERSION),
  createdAt: finiteNonNegativeSchema,
  deadlineMs: finitePositiveSchema,
  queueAttemptProof: z.literal("complete"),
  agent: z.array(currentAgentRecoveryEntrySchema),
  queueAttempts: z.array(queueAttemptSchema),
  relays: z.array(currentRelaySnapshotSchema),
});

const snapshotV3Schema = z.strictObject({
  version: z.literal(3),
  createdAt: finiteNonNegativeSchema,
  deadlineMs: finitePositiveSchema,
  queueAttemptProof: z.literal("complete"),
  agent: z.array(agentRecoveryEntryV3Schema),
  queueAttempts: z.array(queueAttemptSchema),
  relays: z.array(currentRelaySnapshotSchema),
});

const legacySnapshotV1Schema = z.strictObject({
  version: z.literal(1),
  ...legacySnapshotPayloadShape,
});

const legacySnapshotV2Schema = z.strictObject({
  version: z.literal(2),
  ...legacySnapshotPayloadShape,
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
          persistenceContext({ field: "payload_json", version: -1, issueCode: "malformed-json" }),
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
    { readonly requestClient: z.output<typeof adapterPlatformSchema>; readonly sessionId: string }
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
    { readonly platform: "discord" | "github"; readonly sessionId: string }
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
      const lineage = decodeCorePrimaryLineageV1(entry.corePrimaryLineage, entry.messages);
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

function normalizeLegacySnapshot(
  decoded: z.output<typeof legacySnapshotV1Schema> | z.output<typeof legacySnapshotV2Schema>,
): ResultType<GracefulRestartSnapshot, CorruptPersistedFields> {
  const relays: BusToAdapterRelaySnapshot[] = [];
  for (const relay of decoded.relays) {
    if (relay.requestClient !== undefined && relay.requestClient !== relay.platform) {
      return Result.err(corruptSnapshot(decoded.version, "payload_json"));
    }
    relays.push({ ...relay, requestClient: relay.platform });
  }
  const snapshot: GracefulRestartSnapshot = {
    version: GRACEFUL_RESTART_SNAPSHOT_VERSION,
    createdAt: decoded.createdAt,
    deadlineMs: decoded.deadlineMs,
    queueAttemptProof: decoded.agent.some((entry) => entry.kind === "queued")
      ? "legacy-ambiguous"
      : "complete",
    agent: decoded.agent.map((entry, index) => ({
      ...entry,
      queueEntryId: `legacy:${index}:${entry.requestId}`,
      currentTurnUserId: undefined,
      identity: { state: "restricted", reason: "legacy-no-durable-proof" },
    })),
    queueAttempts: [],
    relays,
  };
  if (!validateSnapshotCorrelation(snapshot, false)) {
    return Result.err(corruptSnapshot(decoded.version, "payload_json"));
  }
  return Result.ok(snapshot);
}

function normalizeSnapshotV3(
  decoded: z.output<typeof snapshotV3Schema>,
): ResultType<GracefulRestartSnapshot, CorruptPersistedFields> {
  const snapshot: GracefulRestartSnapshot = {
    ...decoded,
    version: GRACEFUL_RESTART_SNAPSHOT_VERSION,
    agent: decoded.agent.map((entry) => ({ ...entry, currentTurnUserId: undefined })),
  };
  if (!validateSnapshotCorrelation(snapshot, true)) {
    return Result.err(corruptSnapshot(decoded.version, "payload_json"));
  }
  return Result.ok(snapshot);
}

export function decodeGracefulRestartSnapshot(
  row: PersistedGracefulRestartRow | null,
): ResultType<DecodedPersistedValue<GracefulRestartSnapshot | null>, PersistedDataError> {
  if (row === null) {
    return Result.ok<DecodedPersistedValue<GracefulRestartSnapshot | null>>({
      value: null,
      provenance: "missing-defaulted",
    });
  }
  if (row.status !== "completed") return Result.err(corruptSnapshot(-1, "status"));

  const parsedResult = parsePersistedPayload(row.payload_json);
  const continueParsed = parsedResult.match<
    () => ResultType<DecodedPersistedValue<GracefulRestartSnapshot | null>, PersistedDataError>
  >({
    err: (error) => () => Result.err(error),
    ok: (parsed) => () => {
      const versionValue = isRecord(parsed) ? parsed["version"] : undefined;
      const version =
        typeof versionValue === "number" && Number.isInteger(versionValue)
          ? versionValue
          : undefined;
      if (version === undefined) return Result.err(corruptSnapshot(-1, "payload_json"));
      if (
        version !== 1 &&
        version !== 2 &&
        version !== 3 &&
        version !== GRACEFUL_RESTART_SNAPSHOT_VERSION
      ) {
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

      if (version === 1 || version === 2) {
        const decoded =
          version === 1
            ? legacySnapshotV1Schema.safeParse(parsed)
            : legacySnapshotV2Schema.safeParse(parsed);
        if (!decoded.success) return Result.err(corruptSnapshot(version, "payload_json"));
        const normalizedResult = normalizeLegacySnapshot(decoded.data);
        const continueNormalized = normalizedResult.match<
          () => ResultType<
            DecodedPersistedValue<GracefulRestartSnapshot | null>,
            PersistedDataError
          >
        >({
          err: (error) => () => Result.err(error),
          ok: (value) => () => Result.ok({ value, provenance: "migrated" }),
        });
        return continueNormalized();
      }

      if (version === 3) {
        const decoded = snapshotV3Schema.safeParse(parsed);
        if (!decoded.success) return Result.err(corruptSnapshot(version, "payload_json"));
        const normalizedResult = normalizeSnapshotV3(decoded.data);
        const continueNormalized = normalizedResult.match<
          () => ResultType<
            DecodedPersistedValue<GracefulRestartSnapshot | null>,
            PersistedDataError
          >
        >({
          err: (error) => () => Result.err(error),
          ok: (value) => () => Result.ok({ value, provenance: "migrated" }),
        });
        return continueNormalized();
      }

      const decoded = currentSnapshotSchema.safeParse(parsed);
      if (!decoded.success) return Result.err(corruptSnapshot(version, "payload_json"));
      if (!validateSnapshotCorrelation(decoded.data, true)) {
        return Result.err(corruptSnapshot(version, "payload_json"));
      }
      return Result.ok<DecodedPersistedValue<GracefulRestartSnapshot | null>>({
        value: decoded.data,
        provenance: "current",
      });
    },
  });
  return continueParsed();
}

function encodeGracefulRestartSnapshot(
  snapshot: GracefulRestartSnapshotInput,
): ResultType<string, CorruptPersistedFields | GracefulRestartSerializationFailure> {
  {
    const captured = Result.try({
      try: () => {
        for (const entry of snapshot.agent) {
          if (entry.raw === undefined) continue;
          const opaque = decodeOpaqueSuperJsonValue(entry.raw);
          if (!opaque.match({ ok: () => true, err: () => false })) {
            return {
              kind: "result",
              result: Result.err(
                corruptSnapshot(GRACEFUL_RESTART_SNAPSHOT_VERSION, "payload_json"),
              ),
            } as const;
          }
        }
        const payloadJson = SuperJSON.stringify(snapshot);
        const validated = decodeGracefulRestartSnapshot({
          status: "completed",
          payload_json: payloadJson,
        });
        return validated.match<
          | { readonly kind: "result"; readonly result: ResultType<string, CorruptPersistedFields> }
          | {
              readonly kind: "panic";
              readonly error: import("better-result").InferErr<typeof validated>;
            }
        >({
          err: (error) =>
            error instanceof CorruptPersistedFields
              ? ({ kind: "result", result: Result.err(error) } as const)
              : ({ kind: "panic", error } as const),
          ok: (value) => ({
            kind: "result",
            result: isDeepStrictEqual(value.value, snapshot)
              ? Result.ok(payloadJson)
              : Result.err(corruptSnapshot(GRACEFUL_RESTART_SNAPSHOT_VERSION, "payload_json")),
          }),
        });
      },
      catch: captureError,
    });

    if (captured.isErr()) {
      const cause = captured.error.cause;
      preserveToolPanic(cause);
      return Result.err(
        new GracefulRestartSerializationFailure({
          message: "Graceful restart snapshot serialization failed",
        }),
      );
    }
    const encoded = captured.value;
    if (encoded.kind === "panic") {
      preserveToolPanic(
        new Panic({
          message: "Graceful restart current snapshot encoding produced an invalid envelope",
          cause: encoded.error,
        }),
      );
    }
    return encoded.result;
  }
}

function classifySqliteFailure(
  operation: GracefulRestartSqliteFailure["operation"],
  cause: Error,
): GracefulRestartSqliteFailure | undefined {
  const sqliteError = classifyBunSqliteError(cause);
  if (sqliteError === undefined) return undefined;
  return new GracefulRestartSqliteFailure({
    operation,
    code: sqliteError.code,
    message: `Graceful restart SQLite ${operation} failed`,
  });
}

function loadOutcome(
  decoded: DecodedPersistedValue<GracefulRestartSnapshot | null>,
  nowMs: number,
  rowToken?: GracefulRestartRowToken,
): GracefulRestartLoadOutcome {
  if (decoded.value === null) {
    return { state: "absent", provenance: "missing-defaulted" };
  }

  const { value: snapshot } = decoded;
  if (!rowToken) {
    signalMissingGracefulRestartDispositionToken();
  }
  const provenance: Exclude<PersistenceProvenance, "missing-defaulted"> =
    decoded.provenance === "migrated" ? "migrated" : "current";
  const ageMs = Math.max(0, nowMs - snapshot.createdAt);
  if (nowMs - snapshot.createdAt > snapshot.deadlineMs) {
    return {
      state: "stale",
      rowToken,
      createdAt: snapshot.createdAt,
      deadlineMs: snapshot.deadlineMs,
      ageMs,
      provenance,
    };
  }
  if (snapshot.agent.length === 0 && snapshot.relays.length === 0) {
    return { state: "empty", rowToken, provenance };
  }
  return { state: "loaded", snapshot, rowToken, provenance };
}

function signalMissingGracefulRestartDispositionToken(): never {
  throw new Panic({ message: "Decoded graceful restart row is missing its disposition token" });
}

function rowToken(row: PersistedGracefulRestartRow): GracefulRestartRowToken | null {
  if (row.updated_ts === undefined || !Number.isSafeInteger(row.updated_ts)) return null;
  return {
    updatedAt: row.updated_ts,
    payloadSha256: createHash("sha256")
      .update(row.status)
      .update("\u0000")
      .update(row.payload_json)
      .digest("hex"),
  };
}

export class SqliteGracefulRestartStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  clear(): ResultType<void, GracefulRestartSqliteFailure> {
    return runBunSqliteTransaction(
      this.db,
      () => {
        this.db.run("DELETE FROM graceful_restart_state");
        return Result.ok(undefined);
      },
      (cause) => classifySqliteFailure("clear", cause),
    );
  }

  saveCompletedSnapshot(
    snapshot: GracefulRestartSnapshotInput,
  ): ResultType<void, GracefulRestartSaveError> {
    return encodeGracefulRestartSnapshot(snapshot).andThen((encoded) =>
      runBunSqliteTransaction(
        this.db,
        () => {
          this.db.run(
            `
          INSERT INTO graceful_restart_state (
            singleton_id,
            status,
            updated_ts,
            payload_json
          ) VALUES (?, ?, ?, ?)
          ON CONFLICT(singleton_id) DO UPDATE SET
            status=excluded.status,
            updated_ts=excluded.updated_ts,
            payload_json=excluded.payload_json
          `,
            [1, "completed", Date.now(), encoded],
          );
          return Result.ok(undefined);
        },
        (cause) => classifySqliteFailure("save", cause),
      ),
    );
  }

  readCompletedSnapshot(
    nowMs: number = Date.now(),
  ): ResultType<GracefulRestartLoadOutcome, GracefulRestartLoadError> {
    const read = runBunSqliteTransaction(
      this.db,
      () => {
        const row = this.db
          .query<PersistedGracefulRestartRow, [number]>(
            "SELECT status, updated_ts, payload_json FROM graceful_restart_state WHERE singleton_id = ?",
          )
          .get(1);
        return Result.ok(row);
      },
      (cause) => classifySqliteFailure("read", cause),
    );
    const continueRead = read.match<
      () => ResultType<GracefulRestartLoadOutcome, GracefulRestartLoadError>
    >({
      err: (error) => () => Result.err(error),
      ok: (row) => () => {
        const token = row ? rowToken(row) : undefined;
        if (row && !token) return Result.err(corruptSnapshot(-1, "payload_json"));
        const decoded = decodeGracefulRestartSnapshot(row);
        const continueDecoded = decoded.match<
          () => ResultType<GracefulRestartLoadOutcome, GracefulRestartLoadError>
        >({
          err: (error) => () => Result.err(error),
          ok: (value) => () => Result.ok(loadOutcome(value, nowMs, token ?? undefined)),
        });
        return continueDecoded();
      },
    });
    return continueRead();
  }

  consumeCompletedSnapshot(
    token: GracefulRestartRowToken,
  ): ResultType<void, GracefulRestartConsumeError> {
    return runBunSqliteTransaction(
      this.db,
      () => {
        const current = this.db
          .query<PersistedGracefulRestartRow, [number]>(
            "SELECT status, updated_ts, payload_json FROM graceful_restart_state WHERE singleton_id = ?",
          )
          .get(1);
        const currentToken = current ? rowToken(current) : null;
        if (
          !currentToken ||
          currentToken.updatedAt !== token.updatedAt ||
          currentToken.payloadSha256 !== token.payloadSha256
        ) {
          return Result.err(
            new GracefulRestartDispositionConflict({
              message: "Graceful restart row changed before disposition",
            }),
          );
        }
        const deleted = this.db.run(
          "DELETE FROM graceful_restart_state WHERE singleton_id = ? AND updated_ts = ?",
          [1, token.updatedAt],
        );
        if (deleted.changes !== 1) {
          return Result.err(
            new GracefulRestartDispositionConflict({
              message: "Graceful restart row changed during disposition",
            }),
          );
        }
        return Result.ok(undefined);
      },
      (cause) => classifySqliteFailure("consume", cause),
    );
  }

  private migrate(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS graceful_restart_state (
        singleton_id INTEGER PRIMARY KEY,
        status TEXT NOT NULL,
        updated_ts INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      )
    `);
  }
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
    input: { status: "completed", payload_json: SuperJSON.stringify(fixtureSnapshot) },
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
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: null,
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": {
    input: {
      status: "completed",
      payload_json: SuperJSON.stringify({ ...fixtureSnapshot, version: 5 }),
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
