import { Database } from "bun:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  adapterPlatformSchema,
  corePrimaryLineageV1Schema,
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

import type { AgentRunnerRecoveryEntry } from "../surface/bridge/bus-agent-runner";
import type { BusToAdapterRelaySnapshot } from "../surface/bridge/subscribe-from-bus";

export const GRACEFUL_RESTART_SNAPSHOT_VERSION = 2 as const;

const GRACEFUL_RESTART_TABLE = "graceful_restart_state";
const GRACEFUL_RESTART_RECORD_ID = "singleton";

export type OpaqueSuperJsonValue = null | undefined | boolean | number | string | bigint | object;

export type GracefulRestartRawValue = OpaqueSuperJsonValue;

export type PersistedGracefulRestartRow = {
  readonly status: string;
  readonly payload_json: string;
};

export type GracefulRestartLoadOutcome =
  | {
      readonly state: "loaded";
      readonly snapshot: GracefulRestartSnapshot;
      readonly provenance: "current" | "migrated";
    }
  | {
      readonly state: "empty";
      readonly provenance: "current" | "migrated";
    }
  | {
      readonly state: "absent";
      readonly provenance: "missing-defaulted";
    }
  | {
      readonly state: "stale";
      readonly createdAt: number;
      readonly deadlineMs: number;
      readonly ageMs: number;
      readonly provenance: "current" | "migrated";
    };

export class GracefulRestartSqliteFailure extends TaggedError("GracefulRestartSqliteFailure")<{
  readonly operation: "clear" | "load-and-consume" | "save";
  readonly code: string;
  readonly message: string;
}> {}

export class GracefulRestartSerializationFailure extends TaggedError(
  "GracefulRestartSerializationFailure",
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
  try {
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
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(
      new OpaqueSuperJsonValueUnsupported({
        message: "Opaque graceful restart value cannot be serialized safely by SuperJSON",
      }),
    );
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

const agentRecoveryEntrySchema = z.strictObject({
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
  readonly raw?: GracefulRestartRawValue;
  readonly recovery?: {
    readonly checkpointMessages: GracefulRestartModelMessage[];
    readonly partialText: string;
  };
};

export type GracefulRestartSnapshot = {
  version: typeof GRACEFUL_RESTART_SNAPSHOT_VERSION;
  createdAt: number;
  deadlineMs: number;
  agent: GracefulRestartAgentRecoveryEntry[];
  relays: BusToAdapterRelaySnapshot[];
};

export type GracefulRestartSnapshotInput = Omit<GracefulRestartSnapshot, "agent"> & {
  readonly agent: AgentRunnerRecoveryEntry[];
};

const msgRefSchema = z.strictObject({
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

const relaySnapshotSchema: z.ZodType<BusToAdapterRelaySnapshot> = z.strictObject({
  requestId: nonemptyStringSchema,
  sessionId: nonemptyStringSchema,
  requestClient: z.string().optional(),
  platform: z.enum(["discord", "github"]),
  requestStartedAtMs: finiteNonNegativeSchema.optional(),
  routerSessionMode: z.enum(["mention", "active"]).optional(),
  replyTo: msgRefSchema.optional(),
  createdOutputRefs: z.array(msgRefSchema),
  activeOutputRefs: z.array(msgRefSchema).optional(),
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
});

const snapshotPayloadShape = {
  createdAt: finiteNonNegativeSchema,
  deadlineMs: finitePositiveSchema,
  agent: z.array(agentRecoveryEntrySchema),
  relays: z.array(relaySnapshotSchema),
};

const currentSnapshotSchema = z.strictObject({
  version: z.literal(GRACEFUL_RESTART_SNAPSHOT_VERSION),
  ...snapshotPayloadShape,
});

const legacySnapshotSchema = z.strictObject({
  version: z.literal(1),
  ...snapshotPayloadShape,
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
  try {
    const parsed: unknown = SuperJSON.parse(payloadJson);
    return Result.ok(parsed);
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(
      new MalformedSerialization(
        persistenceContext({ field: "payload_json", version: -1, issueCode: "malformed-json" }),
      ),
    );
  }
}

export function decodeGracefulRestartSnapshot(
  row: PersistedGracefulRestartRow | null,
): ResultType<DecodedPersistedValue<GracefulRestartSnapshot | null>, PersistedDataError> {
  if (row === null) return Result.ok({ value: null, provenance: "missing-defaulted" });
  if (row.status !== "completed") return Result.err(corruptSnapshot(-1, "status"));

  const parsed = parsePersistedPayload(row.payload_json);
  if (parsed.status === "error") return Result.err(parsed.error);

  const versionValue = isRecord(parsed.value) ? parsed.value["version"] : undefined;
  const version =
    typeof versionValue === "number" && Number.isInteger(versionValue) ? versionValue : undefined;
  if (version === undefined) return Result.err(corruptSnapshot(-1, "payload_json"));
  if (version !== 1 && version !== GRACEFUL_RESTART_SNAPSHOT_VERSION) {
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

  if (version === 1) {
    const decoded = legacySnapshotSchema.safeParse(parsed.value);
    if (!decoded.success) return Result.err(corruptSnapshot(version, "payload_json"));
    for (const entry of decoded.data.agent) {
      if (
        entry.corePrimaryLineage !== undefined &&
        !corePrimaryLineageV1Schema.safeParse(entry.corePrimaryLineage).success
      ) {
        return Result.err(corruptSnapshot(version, "payload_json"));
      }
    }
    return Result.ok({
      value: { ...decoded.data, version: GRACEFUL_RESTART_SNAPSHOT_VERSION },
      provenance: "migrated",
    });
  }

  const decoded = currentSnapshotSchema.safeParse(parsed.value);
  if (!decoded.success) return Result.err(corruptSnapshot(version, "payload_json"));
  for (const entry of decoded.data.agent) {
    if (
      entry.corePrimaryLineage !== undefined &&
      !corePrimaryLineageV1Schema.safeParse(entry.corePrimaryLineage).success
    ) {
      return Result.err(corruptSnapshot(version, "payload_json"));
    }
  }
  return Result.ok({ value: decoded.data, provenance: "current" });
}

function encodeGracefulRestartSnapshot(
  snapshot: GracefulRestartSnapshotInput,
): ResultType<string, CorruptPersistedFields | GracefulRestartSerializationFailure> {
  try {
    for (const entry of snapshot.agent) {
      if (entry.raw === undefined) continue;
      const opaque = decodeOpaqueSuperJsonValue(entry.raw);
      if (opaque.status === "error") {
        return Result.err(corruptSnapshot(GRACEFUL_RESTART_SNAPSHOT_VERSION, "payload_json"));
      }
    }
    const payloadJson = SuperJSON.stringify(snapshot);
    const validated = decodeGracefulRestartSnapshot({
      status: "completed",
      payload_json: payloadJson,
    });
    if (validated.status === "error") {
      if (validated.error instanceof CorruptPersistedFields) return Result.err(validated.error);
      throw new Panic({
        message: "Graceful restart current snapshot encoding produced an invalid envelope",
        cause: validated.error,
      });
    }
    if (!isDeepStrictEqual(validated.value.value, snapshot)) {
      return Result.err(corruptSnapshot(GRACEFUL_RESTART_SNAPSHOT_VERSION, "payload_json"));
    }
    return Result.ok(payloadJson);
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    if (!(cause instanceof Error)) throw cause;
    return Result.err(
      new GracefulRestartSerializationFailure({
        message: "Graceful restart snapshot serialization failed",
      }),
    );
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
): GracefulRestartLoadOutcome {
  if (decoded.value === null) {
    return { state: "absent", provenance: "missing-defaulted" };
  }

  const { value: snapshot } = decoded;
  const provenance: Exclude<PersistenceProvenance, "missing-defaulted"> =
    decoded.provenance === "migrated" ? "migrated" : "current";
  const ageMs = Math.max(0, nowMs - snapshot.createdAt);
  if (nowMs - snapshot.createdAt > snapshot.deadlineMs) {
    return {
      state: "stale",
      createdAt: snapshot.createdAt,
      deadlineMs: snapshot.deadlineMs,
      ageMs,
      provenance,
    };
  }
  if (snapshot.agent.length === 0 && snapshot.relays.length === 0) {
    return { state: "empty", provenance };
  }
  return { state: "loaded", snapshot, provenance };
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
    const encoded = encodeGracefulRestartSnapshot(snapshot);
    if (encoded.status === "error") return Result.err(encoded.error);

    return runBunSqliteTransaction(
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
          [1, "completed", Date.now(), encoded.value],
        );
        return Result.ok(undefined);
      },
      (cause) => classifySqliteFailure("save", cause),
    );
  }

  /** The row is committed as deleted before decoding, including malformed payloads. */
  loadAndConsumeCompletedSnapshot(
    nowMs: number = Date.now(),
  ): ResultType<GracefulRestartLoadOutcome, GracefulRestartLoadError> {
    const consumed = runBunSqliteTransaction(
      this.db,
      () => {
        const row = this.db
          .query<PersistedGracefulRestartRow, [number]>(
            "SELECT status, payload_json FROM graceful_restart_state WHERE singleton_id = ?",
          )
          .get(1);
        this.db.run("DELETE FROM graceful_restart_state WHERE singleton_id = ?", [1]);
        return Result.ok(row);
      },
      (cause) => classifySqliteFailure("load-and-consume", cause),
    );
    if (consumed.status === "error") return Result.err(consumed.error);

    const decoded = decodeGracefulRestartSnapshot(consumed.value);
    if (decoded.status === "error") return Result.err(decoded.error);
    return Result.ok(loadOutcome(decoded.value, nowMs));
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
  agent: [],
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
      payload_json: SuperJSON.stringify({ ...fixtureSnapshot, version: 1 }),
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
      payload_json: SuperJSON.stringify({ ...fixtureSnapshot, version: 3 }),
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
