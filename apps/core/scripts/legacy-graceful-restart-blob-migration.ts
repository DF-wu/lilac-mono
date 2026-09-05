import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import {
  adapterPlatformSchema,
  requestOriginSchema,
  requestQueueModeSchema,
  requestRunPolicySchema,
} from "@stanley2058/lilac-event-bus";
import {
  CorruptPersistedFields,
  isRecord,
  MalformedSerialization,
  runBunSqliteTransaction,
  UnsupportedVersion,
  type DecodedPersistedValue,
  type PersistedDataError,
} from "@stanley2058/lilac-utils";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";
import SuperJSON from "superjson";
import { z } from "zod";

import { captureError } from "../src/shared/error-capture";
import {
  type AgentRunnerQueueAttempt,
  type AgentRunnerRecoveryIdentity,
  decodeGracefulRestartSnapshot as decodeCurrentGracefulRestartSnapshot,
  GRACEFUL_RESTART_SNAPSHOT_VERSION,
  type BusToAdapterRelaySnapshot,
} from "../src/migration/frozen-graceful-restart-store";
import { parseBufferedForActiveRequestIdFromRaw } from "../src/surface/bridge/bus-agent-runner/raw";
import {
  isAuthenticatedRequestProjectionSemanticallyValid,
  isPersistedRecoveryAuthenticatedRequestProjectionSemanticallyValid,
  type AuthenticatedRequestProjection,
} from "../src/surface/authenticated-request";
import { preserveToolPanic } from "../src/tools/tool-result-adapters";

const TABLE = "graceful_restart_state";
const FORMER_GRACEFUL_RESTART_SNAPSHOT_VERSION = 4 as const;
const FORMER_GRACEFUL_RESTART_RECORD_ID = "singleton";

type FormerOpaqueSuperJsonValue = null | undefined | boolean | number | string | bigint | object;
type FormerGracefulRestartRawValue = FormerOpaqueSuperJsonValue;
type FormerPersistedGracefulRestartRow = {
  readonly status: string;
  readonly payload_json: string;
};

const finiteNonNegativeSchema = z.number().finite().nonnegative();
const finitePositiveSchema = z.number().finite().positive();
const nonemptyStringSchema = z.string().min(1);

function isFormerOpaqueSuperJsonValue(value: unknown): value is FormerOpaqueSuperJsonValue {
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

const opaqueSuperJsonValueSchema = z.custom<FormerOpaqueSuperJsonValue>(
  isFormerOpaqueSuperJsonValue,
);

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

const registeredPlatformSchema = z.enum(["discord", "github", "telegram"]);
const discordSessionRefSchema = z.strictObject({
  platform: z.literal("discord"),
  channelId: nonemptyStringSchema,
});
const githubSessionRefSchema = z.strictObject({
  platform: z.literal("github"),
  channelId: nonemptyStringSchema,
});
const telegramSessionRefSchema = z.strictObject({
  platform: z.literal("telegram"),
  channelId: nonemptyStringSchema,
});
const persistedSessionRefSchema = z.discriminatedUnion("platform", [
  discordSessionRefSchema,
  githubSessionRefSchema,
  telegramSessionRefSchema,
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
const telegramMsgRefSchema = z.strictObject({
  platform: z.literal("telegram"),
  channelId: nonemptyStringSchema,
  messageId: nonemptyStringSchema,
});
const persistedMsgRefSchema = z.discriminatedUnion("platform", [
  discordMsgRefSchema,
  githubMsgRefSchema,
  telegramMsgRefSchema,
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
  z.strictObject({
    platform: z.literal("telegram"),
    userId: nonemptyStringSchema,
    sessionRef: telegramSessionRefSchema,
    messageRef: telegramMsgRefSchema.optional(),
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

const FORMER_CORE_PRIMARY_LINEAGE_DOMAIN = "lilac:core-primary-lineage:v1";
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

type FormerCanonicalJson =
  | null
  | boolean
  | number
  | string
  | FormerCanonicalJson[]
  | { [key: string]: FormerCanonicalJson };

function canonicalizeFormerLineageJson(value: FormerCanonicalJson): FormerCanonicalJson {
  if (value === null || typeof value !== "object") {
    return typeof value === "number" && Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalizeFormerLineageJson);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalizeFormerLineageJson(value[key]!)]),
  );
}

function extendFormerLineageDigest(
  previousDigest: string,
  atomIndex: number,
  atom: z.output<typeof lineageAtomSchema>,
): string {
  const index = Buffer.alloc(8);
  index.writeBigUInt64BE(BigInt(atomIndex));
  return createHash("sha256")
    .update(FORMER_CORE_PRIMARY_LINEAGE_DOMAIN, "utf8")
    .update(index)
    .update(Buffer.from(previousDigest, "hex"))
    .update(JSON.stringify(canonicalizeFormerLineageJson(atom as FormerCanonicalJson)), "utf8")
    .digest("hex");
}

function formerLineageAtomSourceKey(atom: z.output<typeof lineageAtomSchema>): string {
  if (atom.kind === "surface") {
    return `surface\u0000${atom.requestClient}\u0000${atom.surfaceId}\u0000${atom.sessionId}\u0000${atom.messageId}`;
  }
  if (atom.kind === "request" || atom.kind === "checkpoint") {
    return `request\u0000${atom.requestId}`;
  }
  return `synthetic\u0000${atom.source}\u0000${atom.messageDigest}`;
}

function validateFormerCorePrimaryLineageV1(
  lineage: GracefulRestartCorePrimaryLineage,
  canonicalMessages: readonly GracefulRestartModelMessage[],
): boolean {
  if (lineage.currentCanonicalStart > canonicalMessages.length) return false;
  if (lineage.state === "fresh-only") return true;
  if (lineage.segments.length === 0) return false;

  let canonicalEnd = 0;
  let atomCount = 0;
  let digest = createHash("sha256").update(FORMER_CORE_PRIMARY_LINEAGE_DOMAIN).digest("hex");
  const claimedSources = new Set<string>();
  let currentStartIsSegmentBoundary = false;

  const claimSource = (key: string): boolean => {
    if (claimedSources.has(key)) return false;
    claimedSources.add(key);
    return true;
  };

  for (const segment of lineage.segments) {
    if (segment.atoms.length === 0 || segment.canonicalMessages.length === 0) return false;
    if (segment.canonicalStart === lineage.currentCanonicalStart) {
      currentStartIsSegmentBoundary = true;
    }
    if (segment.canonicalStart !== canonicalEnd) return false;
    canonicalEnd += segment.canonicalMessages.length;
    if (segment.canonicalEnd !== canonicalEnd) return false;

    const kinds = new Set(segment.atoms.map((atom) => atom.kind));
    const isSurface = kinds.size === 1 && kinds.has("surface");
    const isRequest = segment.atoms.length === 1 && segment.atoms[0]?.kind === "request";
    const isCheckpoint = segment.atoms.length === 1 && segment.atoms[0]?.kind === "checkpoint";
    const isSynthetic = segment.atoms.length === 1 && segment.atoms[0]?.kind === "synthetic";
    if (!isSurface && !isRequest && !isCheckpoint && !isSynthetic) return false;
    if (isRequest !== (segment.requestSource !== undefined)) return false;
    if (segment.requestSource && segment.requestSource.aliases.length === 0) return false;

    for (const atom of segment.atoms) {
      if (
        ((atom.kind === "request" || atom.kind === "checkpoint") &&
          !SHA256_HEX_PATTERN.test(atom.transcriptDigest)) ||
        (atom.kind === "synthetic" && !SHA256_HEX_PATTERN.test(atom.messageDigest))
      ) {
        return false;
      }
      if (!claimSource(formerLineageAtomSourceKey(atom))) return false;
      atomCount += 1;
      digest = extendFormerLineageDigest(digest, atomCount, atom);
    }
    for (const alias of segment.requestSource?.aliases ?? []) {
      if (
        !claimSource(
          `surface\u0000${alias.requestClient}\u0000${alias.surfaceId}\u0000${alias.sessionId}\u0000${alias.messageId}`,
        )
      ) {
        return false;
      }
    }
    if (segment.cumulativeAtomCount !== atomCount || segment.cumulativePrefixDigest !== digest) {
      return false;
    }
  }
  return (
    currentStartIsSegmentBoundary &&
    isDeepStrictEqual(
      lineage.segments.flatMap((segment) => segment.canonicalMessages),
      canonicalMessages,
    )
  );
}

type GracefulRestartAgentRecoveryEntry = {
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
  readonly raw?: FormerGracefulRestartRawValue;
  readonly recovery?: {
    readonly checkpointMessages: GracefulRestartModelMessage[];
    readonly partialText: string;
  };
  readonly identity: AgentRunnerRecoveryIdentity;
};

type GracefulRestartSnapshot = {
  version: typeof FORMER_GRACEFUL_RESTART_SNAPSHOT_VERSION;
  createdAt: number;
  deadlineMs: number;
  queueAttemptProof: "complete" | "legacy-ambiguous";
  agent: GracefulRestartAgentRecoveryEntry[];
  queueAttempts: AgentRunnerQueueAttempt[];
  relays: BusToAdapterRelaySnapshot[];
};

const relayMsgRefSchema = z.strictObject({
  platform: z.enum(["discord", "github", "telegram"]),
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
  version: z.literal(FORMER_GRACEFUL_RESTART_SNAPSHOT_VERSION),
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
    table: TABLE,
    field: input.field,
    version: input.version,
    issueCode: input.issueCode,
    recordId: FORMER_GRACEFUL_RESTART_RECORD_ID,
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
    {
      readonly platform: GracefulRestartSnapshot["relays"][number]["platform"];
      readonly sessionId: string;
    }
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
      if (!validateFormerCorePrimaryLineageV1(entry.corePrimaryLineage, entry.messages))
        return false;
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
    version: FORMER_GRACEFUL_RESTART_SNAPSHOT_VERSION,
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
    version: FORMER_GRACEFUL_RESTART_SNAPSHOT_VERSION,
    agent: decoded.agent.map((entry) => ({ ...entry, currentTurnUserId: undefined })),
  };
  if (!validateSnapshotCorrelation(snapshot, true)) {
    return Result.err(corruptSnapshot(decoded.version, "payload_json"));
  }
  return Result.ok(snapshot);
}

function decodeFormerGracefulRestartSnapshot(
  row: FormerPersistedGracefulRestartRow | null,
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
        version !== FORMER_GRACEFUL_RESTART_SNAPSHOT_VERSION
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

const expectedColumns = [
  { name: "singleton_id", type: "INTEGER", notnull: 0, pk: 1 },
  { name: "status", type: "TEXT", notnull: 1, pk: 0 },
  { name: "updated_ts", type: "INTEGER", notnull: 1, pk: 0 },
  { name: "payload_json", type: "TEXT", notnull: 1, pk: 0 },
] as const;

const columnSchema = z.strictObject({
  cid: z.number().int().nonnegative(),
  name: z.string(),
  type: z.string(),
  notnull: z.number().int(),
  dflt_value: z.null(),
  pk: z.number().int(),
});

const rowSchema = z.strictObject({
  singleton_id: z.literal(1),
  status: z.string(),
  updated_ts: z.number().int(),
  payload_json: z.string(),
});

export type LegacyGracefulRestartClassification = "absent" | "current" | "legacy-discard";

export type LegacyGracefulRestartMigrationReport = {
  readonly classification: LegacyGracefulRestartClassification;
  readonly rowCount: 0 | 1;
  readonly snapshotCount: 0 | 1;
  readonly sourceVersion: number | null;
  readonly discardedSnapshotCount: 0 | 1;
};

export type LegacyGracefulRestartMigrationPlan = {
  readonly classification: LegacyGracefulRestartClassification;
  readonly sourceRowSha256: string | null;
  readonly sourceVersion: number | null;
};

export type LegacyGracefulRestartPreflight = {
  readonly report: LegacyGracefulRestartMigrationReport;
  readonly plan: LegacyGracefulRestartMigrationPlan;
};

export class LegacyGracefulRestartMigrationFailed extends TaggedError(
  "LegacyGracefulRestartMigrationFailed",
)<{
  readonly stage: "preflight" | "rewrite";
  readonly code:
    | "database-unreadable"
    | "invalid-snapshot"
    | "invalid-table-layout"
    | "row-changed";
  readonly message: string;
}> {}

function failure(
  stage: LegacyGracefulRestartMigrationFailed["stage"],
  code: LegacyGracefulRestartMigrationFailed["code"],
  message: string,
): LegacyGracefulRestartMigrationFailed {
  return new LegacyGracefulRestartMigrationFailed({ stage, code, message });
}

function decodeGracefulRestartMigrationRow(
  input: unknown,
): ResultType<z.output<typeof rowSchema>, LegacyGracefulRestartMigrationFailed> {
  const decoded = rowSchema.safeParse(input);
  return decoded.success
    ? Result.ok(decoded.data)
    : Result.err(rewriteFailure("row-changed", "Graceful restart row changed after preflight"));
}

function emptyReport(
  classification: LegacyGracefulRestartClassification,
): LegacyGracefulRestartMigrationReport {
  return {
    classification,
    rowCount: 0,
    snapshotCount: 0,
    sourceVersion: null,
    discardedSnapshotCount: 0,
  };
}

function rowSha256(row: z.output<typeof rowSchema>): string {
  return createHash("sha256")
    .update(String(row.singleton_id))
    .update("\u0000")
    .update(row.status)
    .update("\u0000")
    .update(String(row.updated_ts))
    .update("\u0000")
    .update(row.payload_json)
    .digest("hex");
}

function parseVersion(payloadJson: string): number | null {
  const parsed = Result.try({
    try: () => SuperJSON.parse<unknown>(payloadJson),
    catch: captureError,
  });
  if (parsed.isErr()) {
    if (Panic.is(parsed.error.cause)) preserveToolPanic(parsed.error.cause);
    return null;
  }
  const value = parsed.value;
  if (value === null || typeof value !== "object" || !("version" in value)) return null;
  const version = Reflect.get(value, "version");
  return typeof version === "number" && Number.isInteger(version) ? version : null;
}

function classifyPersistedSnapshot(
  row: z.output<typeof rowSchema>,
  sourceVersion: number | null,
): ResultType<LegacyGracefulRestartClassification, LegacyGracefulRestartMigrationFailed> {
  if (
    sourceVersion === 1 ||
    sourceVersion === 2 ||
    sourceVersion === 3 ||
    sourceVersion === FORMER_GRACEFUL_RESTART_SNAPSHOT_VERSION
  ) {
    return decodeFormerGracefulRestartSnapshot({
      status: row.status,
      payload_json: row.payload_json,
    })
      .map((): LegacyGracefulRestartClassification => "legacy-discard")
      .mapError(() =>
        failure(
          "preflight",
          "invalid-snapshot",
          `Graceful restart snapshot v${sourceVersion} does not match its exact persisted contract`,
        ),
      );
  }
  if (sourceVersion === GRACEFUL_RESTART_SNAPSHOT_VERSION) {
    return decodeCurrentGracefulRestartSnapshot({
      status: row.status,
      payload_json: row.payload_json,
    })
      .map((): LegacyGracefulRestartClassification => "current")
      .mapError(() =>
        failure(
          "preflight",
          "invalid-snapshot",
          `Graceful restart snapshot v${sourceVersion} does not match its exact persisted contract`,
        ),
      );
  }
  return Result.err(
    failure(
      "preflight",
      "invalid-snapshot",
      sourceVersion === null
        ? "Graceful restart snapshot payload is malformed or has no integer version"
        : `Graceful restart snapshot version ${sourceVersion} is unsupported`,
    ),
  );
}

function preflightUnsafe(
  dbPath: string,
): ResultType<LegacyGracefulRestartPreflight, LegacyGracefulRestartMigrationFailed> {
  if (!existsSync(dbPath)) {
    return Result.ok({
      report: emptyReport("absent"),
      plan: { classification: "absent", sourceRowSha256: null, sourceVersion: null },
    });
  }

  using database = new Database(dbPath, { readonly: true, strict: true });
  const schemaObjects = database
    .query<{ type: string; name: string; tbl_name: string; sql: string | null }, []>(
      `SELECT type, name, tbl_name, sql
       FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%'
         AND type IN ('index', 'table', 'trigger', 'view')
       ORDER BY type, name`,
    )
    .all();
  const table = schemaObjects[0];
  if (
    schemaObjects.length !== 1 ||
    table?.type !== "table" ||
    table.name !== TABLE ||
    table.tbl_name !== TABLE ||
    table.sql === null ||
    createHash("sha256").update(table.sql.replace(/\s+/g, " ").trim()).digest("hex") !==
      "459439a28b0233cb0aa4263885ad13aae0ed893c010ef0f67c2629d96dde9345"
  ) {
    return Result.err(
      failure(
        "preflight",
        "invalid-table-layout",
        "Expected the exact graceful_restart_state SQLite object catalog and DDL",
      ),
    );
  }
  const columns = z
    .array(columnSchema)
    .safeParse(database.query<unknown, []>(`PRAGMA table_info(${TABLE})`).all());
  if (
    !columns.success ||
    columns.data.length !== expectedColumns.length ||
    columns.data.some((column, index) => {
      const expected = expectedColumns[index];
      return (
        !expected ||
        column.cid !== index ||
        column.name !== expected.name ||
        column.type.toUpperCase() !== expected.type ||
        column.notnull !== expected.notnull ||
        column.pk !== expected.pk ||
        column.dflt_value !== null
      );
    })
  ) {
    return Result.err(
      failure(
        "preflight",
        "invalid-table-layout",
        "Expected the exact graceful_restart_state table layout",
      ),
    );
  }

  const rows = database.query<unknown, []>(`SELECT * FROM ${TABLE} ORDER BY singleton_id`).all();
  if (rows.length === 0) {
    return Result.ok({
      report: emptyReport("current"),
      plan: { classification: "current", sourceRowSha256: null, sourceVersion: null },
    });
  }
  if (rows.length !== 1) {
    return Result.err(
      failure(
        "preflight",
        "invalid-table-layout",
        "Expected at most one graceful restart singleton row",
      ),
    );
  }
  const decodedRow = rowSchema.safeParse(rows[0]);
  if (!decodedRow.success) {
    return Result.err(
      failure(
        "preflight",
        "invalid-table-layout",
        "Expected the exact graceful restart singleton row fields",
      ),
    );
  }
  const row = decodedRow.data;
  if (row.status !== "completed") {
    return Result.err(
      failure(
        "preflight",
        "invalid-snapshot",
        "Graceful restart snapshot status must be completed",
      ),
    );
  }
  const sourceVersion = parseVersion(row.payload_json);
  return classifyPersistedSnapshot(row, sourceVersion).map((classification) => ({
    report: {
      classification,
      rowCount: 1,
      snapshotCount: 1,
      sourceVersion,
      discardedSnapshotCount: 0,
    },
    plan: {
      classification,
      sourceRowSha256: rowSha256(row),
      sourceVersion,
    },
  }));
}

export function preflightLegacyGracefulRestartMigration(
  dbPath: string,
): ResultType<LegacyGracefulRestartPreflight, LegacyGracefulRestartMigrationFailed> {
  const captured = Result.try({
    try: () => preflightUnsafe(dbPath),
    catch: captureError,
  });
  if (captured.isErr()) {
    if (Panic.is(captured.error.cause)) preserveToolPanic(captured.error.cause);
    return Result.err(
      failure(
        "preflight",
        "database-unreadable",
        "Could not inspect the graceful restart database",
      ),
    );
  }
  return captured.value;
}

function rewriteFailure(
  code: "database-unreadable" | "row-changed",
  message: string,
): LegacyGracefulRestartMigrationFailed {
  return failure("rewrite", code, message);
}

export function commitLegacyGracefulRestartMigration(input: {
  readonly dbPath: string;
  readonly plan: LegacyGracefulRestartMigrationPlan;
}): ResultType<LegacyGracefulRestartMigrationReport, LegacyGracefulRestartMigrationFailed> {
  if (input.plan.classification !== "legacy-discard") {
    return Result.ok(
      input.plan.sourceRowSha256
        ? {
            classification: "current",
            rowCount: 1,
            snapshotCount: 1,
            sourceVersion: GRACEFUL_RESTART_SNAPSHOT_VERSION,
            discardedSnapshotCount: 0,
          }
        : emptyReport(input.plan.classification),
    );
  }
  const expectedSha256 = input.plan.sourceRowSha256;
  if (!expectedSha256) {
    return Result.err(
      rewriteFailure("row-changed", "Graceful restart migration plan is incomplete"),
    );
  }

  const opened = Result.try({
    try: () => new Database(input.dbPath, { strict: true }),
    catch: captureError,
  });
  if (opened.isErr()) {
    if (Panic.is(opened.error.cause)) preserveToolPanic(opened.error.cause);
    return Result.err(
      rewriteFailure("database-unreadable", "Could not open the graceful restart database"),
    );
  }
  const database = opened.value;
  const discarded = runBunSqliteTransaction(
    database,
    () =>
      decodeGracefulRestartMigrationRow(
        database.query<unknown, []>(`SELECT * FROM ${TABLE} ORDER BY singleton_id`).get(),
      ).andThen((current) => {
        if (rowSha256(current) !== expectedSha256) {
          return Result.err(
            rewriteFailure("row-changed", "Graceful restart row changed after preflight"),
          );
        }
        const deleted = database.run(`DELETE FROM ${TABLE} WHERE singleton_id = ?`, [
          current.singleton_id,
        ]);
        return deleted.changes === 1
          ? Result.ok(undefined)
          : Result.err(
              rewriteFailure("row-changed", "Graceful restart row changed during discard"),
            );
      }),
    () =>
      rewriteFailure(
        "database-unreadable",
        "Could not transactionally discard the legacy graceful restart snapshot",
      ),
  );
  const closed = Result.try({ try: () => database.close(), catch: captureError });
  if (closed.isErr()) {
    if (Panic.is(closed.error.cause)) preserveToolPanic(closed.error.cause);
    return Result.err(
      rewriteFailure("database-unreadable", "Could not close the graceful restart database"),
    );
  }
  return discarded.map(() => ({
    classification: "current",
    rowCount: 0,
    snapshotCount: 0,
    sourceVersion: null,
    discardedSnapshotCount: 1,
  }));
}
