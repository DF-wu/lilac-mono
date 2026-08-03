import SuperJSON from "superjson";
import {
  modelMessageSchema,
  type FilePart,
  type SystemModelMessage,
  type TextPart,
  type ToolApprovalRequest,
  type ToolModelMessage,
  type ToolResultPart,
  type UserModelMessage,
} from "ai";
import {
  hashCanonicalMessagesV1,
  historyProviderStateSchema,
  type HistoryProviderState,
} from "@stanley2058/lilac-agent";
import {
  coreLineageManifestV1Schema,
  computeCoreLineagePrefixDigestV1,
  decodeCorePrimaryLineageV1,
  type AdapterPlatform,
  type CoreLineageAtomV1,
  type CoreRequestAliasV1,
} from "@stanley2058/lilac-event-bus";
import {
  CorruptPersistedFields,
  MalformedSerialization,
  UnsupportedVersion,
  isRecord,
  normalizeReplayMessages,
  type DecodedPersistedValue,
  type PersistedDataError,
  type PersistedDataIssueCode,
  type PersistenceProvenance,
} from "@stanley2058/lilac-utils";
import { Panic, Result, type Result as ResultType } from "better-result";
import { z } from "zod";

export const TRANSCRIPT_PERSISTENCE_SCHEMA_VERSION = 5 as const;
export const COMPACTION_CHECKPOINT_FORMAT_VERSION = 1 as const;
export const CORE_SURFACE_PROJECTION_FORMAT_VERSION = 1 as const;
export const CORE_TRANSCRIPT_DIGEST_VERSION = 1 as const;

const TRANSCRIPT_TABLE = "request_transcripts";
const PROJECTION_TABLE = "core_surface_projections";
const LINEAGE_TABLE = "core_primary_lineage_manifests";

const adapterPlatformSchema = z.enum([
  "discord",
  "github",
  "whatsapp",
  "slack",
  "telegram",
  "web",
  "unknown",
]);
const modelMessagesSchema = z.array(modelMessageSchema);
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const nonNegativeIntegerSchema = z.number().int().nonnegative();
const compactionCheckpointMetaSchema = z.strictObject({
  type: z.literal("compaction"),
  formatVersion: z.literal(COMPACTION_CHECKPOINT_FORMAT_VERSION),
});

export type CompactionCheckpointMeta = z.output<typeof compactionCheckpointMetaSchema>;

interface CoreProjectionSourceFactObject extends Record<string, CoreProjectionSourceFact> {}

export type CoreProjectionSourceFact =
  | null
  | boolean
  | number
  | string
  | CoreProjectionSourceFact[]
  | CoreProjectionSourceFactObject;

interface DecodedProviderObject extends Record<string, DecodedProviderValue | undefined> {}
type DecodedProviderValue =
  | null
  | boolean
  | number
  | string
  | DecodedProviderValue[]
  | DecodedProviderObject;
type DecodedProviderOptions = Record<string, DecodedProviderObject>;

type DecodedToolCallPart = {
  readonly type: "tool-call";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: CoreProjectionSourceFact;
  readonly providerOptions?: DecodedProviderOptions;
  readonly providerExecuted?: boolean;
};
type DecodedCustomPart = {
  readonly type: "custom";
  readonly kind: `${string}.${string}`;
  readonly providerOptions?: DecodedProviderOptions;
};
type DecodedReasoningPart = {
  readonly type: "reasoning";
  readonly text: string;
  readonly providerOptions?: DecodedProviderOptions;
};
type DecodedReasoningFilePart = {
  readonly type: "reasoning-file";
  readonly data:
    | string
    | Uint8Array
    | ArrayBuffer
    | URL
    | { readonly type: "data"; readonly data: string | Uint8Array | ArrayBuffer }
    | { readonly type: "url"; readonly url: URL };
  readonly mediaType: string;
  readonly providerOptions?: DecodedProviderOptions;
};
type DecodedAssistantContentPart =
  | TextPart
  | DecodedCustomPart
  | FilePart
  | DecodedReasoningPart
  | DecodedReasoningFilePart
  | DecodedToolCallPart
  | ToolResultPart
  | ToolApprovalRequest;
type DecodedAssistantModelMessage = {
  readonly role: "assistant";
  readonly content: string | DecodedAssistantContentPart[];
  readonly providerOptions?: DecodedProviderOptions;
};
export type DecodedModelMessage =
  | SystemModelMessage
  | UserModelMessage
  | ToolModelMessage
  | DecodedAssistantModelMessage;

const coreProjectionSourceFactSchema: z.ZodType<CoreProjectionSourceFact> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(coreProjectionSourceFactSchema),
    z.record(z.string(), coreProjectionSourceFactSchema),
  ]),
);
const coreProjectionSourceFactsSchema = z.record(z.string(), coreProjectionSourceFactSchema);

export type PersistedTranscriptRow = {
  readonly request_id: string;
  readonly session_id: string;
  readonly request_client: string;
  readonly created_ts: number;
  readonly updated_ts: number;
  readonly model_label: string | null;
  readonly final_text: string | null;
  readonly messages_json: string;
  readonly context_meta_json: string | null;
  readonly provider_state_json: string | null;
  readonly stable_named_request_client: string | null;
  readonly transcript_digest: string | null;
};

export type DecodedTranscriptRow = {
  readonly requestId: string;
  readonly sessionId: string;
  readonly requestClient: AdapterPlatform;
  readonly createdTs: number;
  readonly updatedTs: number;
  readonly messages: DecodedModelMessage[];
  readonly finalText?: string;
  readonly modelLabel?: string;
  readonly contextMeta?: CompactionCheckpointMeta;
  readonly providerState: HistoryProviderState | null;
  readonly stableNamedRequestClient?: AdapterPlatform;
  readonly canonicalHashVersion: typeof CORE_TRANSCRIPT_DIGEST_VERSION;
  readonly transcriptDigest: string;
};

export type PersistedCoreSurfaceProjectionRow = {
  readonly request_client: string;
  readonly surface_id: string;
  readonly session_id: string;
  readonly message_id: string;
  readonly projection_format_version: number;
  readonly canonical_messages_json: string;
  readonly source_facts_json: string;
  readonly created_ts: number;
};

export type DecodedCoreSurfaceProjectionRow = {
  readonly requestClient: AdapterPlatform;
  readonly surfaceId: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly projectionFormatVersion: typeof CORE_SURFACE_PROJECTION_FORMAT_VERSION;
  readonly canonicalMessages: DecodedModelMessage[];
  readonly sourceFacts: Record<string, CoreProjectionSourceFact>;
  readonly createdAt: number;
};

export type PersistedCoreLineageManifestRow = {
  readonly request_id: string;
  readonly lineage_version: number;
  readonly manifest_json: string;
};

type DecodedCoreLineageSegmentV1 = {
  readonly atoms: CoreLineageAtomV1[];
  readonly canonicalMessages: DecodedModelMessage[];
  readonly requestSource?: {
    readonly aliases: CoreRequestAliasV1[];
  };
  readonly canonicalStart: number;
  readonly canonicalEnd: number;
  readonly cumulativeAtomCount: number;
  readonly cumulativePrefixDigest: string;
};

export type DecodedCoreLineageManifestV1 = {
  readonly state: "complete";
  readonly lineageVersion: 1;
  readonly currentCanonicalStart: number;
  readonly segments: DecodedCoreLineageSegmentV1[];
};

type DecodedSchemaVersion = {
  readonly version: 1 | 2 | 3 | 4 | 5;
  readonly provenance: "current" | "migrated";
};

function context(input: {
  readonly table: string;
  readonly field: string;
  readonly version: number;
  readonly issueCode: PersistedDataIssueCode;
  readonly recordId: string;
}) {
  return {
    ...input,
    message: `Persisted transcript ${input.issueCode}`,
  };
}

function corrupt(input: {
  readonly table: string;
  readonly field: string;
  readonly version: number;
  readonly issueCode: PersistedDataIssueCode;
  readonly recordId: string;
}): CorruptPersistedFields {
  return new CorruptPersistedFields(context(input));
}

function decodeSchemaVersion(
  version: number,
  table: string,
  recordId: string,
): ResultType<DecodedSchemaVersion, UnsupportedVersion | CorruptPersistedFields> {
  if (!Number.isInteger(version) || version < 1) {
    return Result.err(
      corrupt({
        table,
        field: "schema_version",
        version,
        issueCode: "invalid-row-version",
        recordId,
      }),
    );
  }
  if (version > TRANSCRIPT_PERSISTENCE_SCHEMA_VERSION) {
    return Result.err(
      new UnsupportedVersion(
        context({
          table,
          field: "schema_version",
          version,
          issueCode: "unsupported-version",
          recordId,
        }),
      ),
    );
  }
  switch (version) {
    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
      return Result.ok({
        version,
        provenance: version === TRANSCRIPT_PERSISTENCE_SCHEMA_VERSION ? "current" : "migrated",
      });
  }
  return Result.err(
    corrupt({
      table,
      field: "schema_version",
      version,
      issueCode: "invalid-row-version",
      recordId,
    }),
  );
}

function decodeSerialized(input: {
  readonly raw: string;
  readonly table: string;
  readonly field: string;
  readonly version: number;
  readonly recordId: string;
}): ResultType<unknown, MalformedSerialization> {
  try {
    const json: unknown = globalThis.JSON.parse(input.raw);
    const isSuperJsonEnvelope =
      isRecord(json) &&
      "json" in json &&
      Object.keys(json).every((key) => key === "json" || key === "meta");
    if (!isSuperJsonEnvelope) return Result.ok(json);
    const deserialized: unknown = SuperJSON.parse(input.raw);
    return Result.ok(deserialized);
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(
      new MalformedSerialization(
        context({
          table: input.table,
          field: input.field,
          version: input.version,
          issueCode: "malformed-json",
          recordId: input.recordId,
        }),
      ),
    );
  }
}

function decodeNormalizedMessagesValue(
  value: unknown,
  input: {
    readonly table: string;
    readonly field: string;
    readonly version: number;
    readonly recordId: string;
  },
): ResultType<DecodedModelMessage[], CorruptPersistedFields> {
  const messages = modelMessagesSchema.safeParse(value);
  if (!messages.success) {
    return Result.err(corrupt({ ...input, issueCode: "invalid-transcript-messages" }));
  }
  const normalized = modelMessagesSchema.safeParse(normalizeReplayMessages(messages.data));
  if (!normalized.success) {
    return Result.err(corrupt({ ...input, issueCode: "invalid-transcript-messages" }));
  }
  const decodedMessages: DecodedModelMessage[] = [];
  for (const message of normalized.data) {
    if (message.role !== "assistant") {
      decodedMessages.push(message);
      continue;
    }
    if (typeof message.content === "string") {
      decodedMessages.push({
        role: "assistant",
        content: message.content,
        ...(message.providerOptions === undefined
          ? {}
          : { providerOptions: message.providerOptions }),
      });
      continue;
    }
    const content: DecodedAssistantContentPart[] = [];
    for (const part of message.content) {
      if (part.type !== "tool-call") {
        content.push(part);
        continue;
      }
      const toolInput = coreProjectionSourceFactSchema.safeParse(part.input);
      if (!toolInput.success) {
        return Result.err(corrupt({ ...input, issueCode: "invalid-transcript-messages" }));
      }
      content.push({ ...part, input: toolInput.data });
    }
    decodedMessages.push({ ...message, content });
  }
  return Result.ok(decodedMessages);
}

export function decodeTranscriptMessages(input: {
  readonly raw: string;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<DecodedPersistedValue<DecodedModelMessage[]>, PersistedDataError> {
  const version = decodeSchemaVersion(input.schemaVersion, TRANSCRIPT_TABLE, input.recordId);
  if (version.status === "error") return Result.err(version.error);
  if (typeof input.raw !== "string") {
    return Result.err(
      corrupt({
        table: TRANSCRIPT_TABLE,
        field: "messages_json",
        version: version.value.version,
        issueCode: "missing-required-field",
        recordId: input.recordId,
      }),
    );
  }
  const serialized = decodeSerialized({
    raw: input.raw,
    table: TRANSCRIPT_TABLE,
    field: "messages_json",
    version: version.value.version,
    recordId: input.recordId,
  });
  if (serialized.status === "error") return Result.err(serialized.error);
  const messages = decodeNormalizedMessagesValue(serialized.value, {
    table: TRANSCRIPT_TABLE,
    field: "messages_json",
    version: version.value.version,
    recordId: input.recordId,
  });
  if (messages.status === "error") return Result.err(messages.error);
  return Result.ok({ value: messages.value, provenance: version.value.provenance });
}

export function decodeTranscriptCompactionContext(input: {
  readonly raw: string | null;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<DecodedPersistedValue<CompactionCheckpointMeta | undefined>, PersistedDataError> {
  const version = decodeSchemaVersion(input.schemaVersion, TRANSCRIPT_TABLE, input.recordId);
  if (version.status === "error") return Result.err(version.error);
  if (input.raw === null) return Result.ok({ value: undefined, provenance: "missing-defaulted" });
  const serialized = decodeSerialized({
    raw: input.raw,
    table: TRANSCRIPT_TABLE,
    field: "context_meta_json",
    version: version.value.version,
    recordId: input.recordId,
  });
  if (serialized.status === "error") return Result.err(serialized.error);
  const decoded = compactionCheckpointMetaSchema.safeParse(serialized.value);
  if (!decoded.success) {
    return Result.err(
      corrupt({
        table: TRANSCRIPT_TABLE,
        field: "context_meta_json",
        version: version.value.version,
        issueCode: "invalid-compaction-context",
        recordId: input.recordId,
      }),
    );
  }
  return Result.ok({ value: decoded.data, provenance: version.value.provenance });
}

export function decodeTranscriptProviderState(input: {
  readonly raw: string | null;
  readonly schemaVersion: number;
  readonly recordId: string;
}): ResultType<DecodedPersistedValue<HistoryProviderState | null>, PersistedDataError> {
  const version = decodeSchemaVersion(input.schemaVersion, TRANSCRIPT_TABLE, input.recordId);
  if (version.status === "error") return Result.err(version.error);
  if (input.raw === null) return Result.ok({ value: null, provenance: "missing-defaulted" });
  const serialized = decodeSerialized({
    raw: input.raw,
    table: TRANSCRIPT_TABLE,
    field: "provider_state_json",
    version: version.value.version,
    recordId: input.recordId,
  });
  if (serialized.status === "error") return Result.err(serialized.error);
  const decoded = historyProviderStateSchema.safeParse(serialized.value);
  if (!decoded.success) {
    return Result.err(
      corrupt({
        table: TRANSCRIPT_TABLE,
        field: "provider_state_json",
        version: version.value.version,
        issueCode: "invalid-provider-state",
        recordId: input.recordId,
      }),
    );
  }
  return Result.ok({ value: decoded.data, provenance: version.value.provenance });
}

function aggregateProvenance(
  version: DecodedSchemaVersion,
  values: readonly DecodedPersistedValue<unknown>[],
): PersistenceProvenance {
  if (version.provenance === "migrated") return "migrated";
  return values.some((value) => value.provenance === "missing-defaulted")
    ? "missing-defaulted"
    : "current";
}

export function decodeTranscriptRow(input: {
  readonly row: PersistedTranscriptRow;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<DecodedTranscriptRow>, PersistedDataError> {
  const recordId =
    typeof input.row.request_id === "string" ? input.row.request_id : "unknown-record";
  const version = decodeSchemaVersion(input.schemaVersion, TRANSCRIPT_TABLE, recordId);
  if (version.status === "error") return Result.err(version.error);
  const rowSchema = z
    .object({
      request_id: z.string().min(1),
      session_id: z.string().min(1),
      request_client: adapterPlatformSchema,
      created_ts: nonNegativeIntegerSchema,
      updated_ts: nonNegativeIntegerSchema,
      model_label: z.string().nullable(),
      final_text: z.string().nullable(),
      messages_json: z.string(),
      context_meta_json: z.string().nullable(),
      provider_state_json: z.string().nullable(),
      stable_named_request_client: adapterPlatformSchema.nullable(),
      transcript_digest: z.string().nullable(),
    })
    .safeParse(input.row);
  if (!rowSchema.success) {
    return Result.err(
      corrupt({
        table: TRANSCRIPT_TABLE,
        field: "row",
        version: version.value.version,
        issueCode: "invalid-transcript-row",
        recordId,
      }),
    );
  }
  const messages = decodeTranscriptMessages({
    raw: rowSchema.data.messages_json,
    schemaVersion: version.value.version,
    recordId,
  });
  if (messages.status === "error") return Result.err(messages.error);
  const contextMeta = decodeTranscriptCompactionContext({
    raw: rowSchema.data.context_meta_json,
    schemaVersion: version.value.version,
    recordId,
  });
  if (contextMeta.status === "error") return Result.err(contextMeta.error);
  const providerState = decodeTranscriptProviderState({
    raw: rowSchema.data.provider_state_json,
    schemaVersion: version.value.version,
    recordId,
  });
  if (providerState.status === "error") return Result.err(providerState.error);
  const computedDigest = hashCanonicalMessagesV1(messages.value.value).hash;
  if (rowSchema.data.transcript_digest !== null) {
    const digest = sha256HexSchema.safeParse(rowSchema.data.transcript_digest);
    if (!digest.success || digest.data !== computedDigest) {
      return Result.err(
        corrupt({
          table: TRANSCRIPT_TABLE,
          field: "transcript_digest",
          version: version.value.version,
          issueCode: "digest-mismatch",
          recordId,
        }),
      );
    }
  }
  return Result.ok({
    value: {
      requestId: rowSchema.data.request_id,
      sessionId: rowSchema.data.session_id,
      requestClient: rowSchema.data.request_client,
      createdTs: rowSchema.data.created_ts,
      updatedTs: rowSchema.data.updated_ts,
      messages: messages.value.value,
      ...(rowSchema.data.final_text === null ? {} : { finalText: rowSchema.data.final_text }),
      ...(rowSchema.data.model_label === null ? {} : { modelLabel: rowSchema.data.model_label }),
      ...(contextMeta.value.value === undefined ? {} : { contextMeta: contextMeta.value.value }),
      providerState: providerState.value.value,
      ...(rowSchema.data.stable_named_request_client === null
        ? {}
        : { stableNamedRequestClient: rowSchema.data.stable_named_request_client }),
      canonicalHashVersion: CORE_TRANSCRIPT_DIGEST_VERSION,
      transcriptDigest: computedDigest,
    },
    provenance: aggregateProvenance(version.value, [
      messages.value,
      contextMeta.value,
      providerState.value,
    ]),
  });
}

export function decodeCoreSurfaceProjectionRow(input: {
  readonly row: PersistedCoreSurfaceProjectionRow;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<DecodedCoreSurfaceProjectionRow>, PersistedDataError>;
export function decodeCoreSurfaceProjectionRow(input: {
  readonly row: null;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<null>, PersistedDataError>;
export function decodeCoreSurfaceProjectionRow(input: {
  readonly row: PersistedCoreSurfaceProjectionRow | null;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<DecodedCoreSurfaceProjectionRow | null>, PersistedDataError> {
  if (input.row === null) return Result.ok({ value: null, provenance: "missing-defaulted" });
  const recordId = `${input.row.request_client}:${input.row.surface_id}:${input.row.session_id}:${input.row.message_id}`;
  const version = decodeSchemaVersion(input.schemaVersion, PROJECTION_TABLE, recordId);
  if (version.status === "error") return Result.err(version.error);
  const row = z
    .object({
      request_client: adapterPlatformSchema,
      surface_id: z.string().min(1),
      session_id: z.string().min(1),
      message_id: z.string().min(1),
      projection_format_version: z.literal(CORE_SURFACE_PROJECTION_FORMAT_VERSION),
      canonical_messages_json: z.string(),
      source_facts_json: z.string(),
      created_ts: nonNegativeIntegerSchema,
    })
    .safeParse(input.row);
  if (!row.success) {
    return Result.err(
      corrupt({
        table: PROJECTION_TABLE,
        field: "row",
        version: version.value.version,
        issueCode: "invalid-surface-projection",
        recordId,
      }),
    );
  }
  const canonicalSerialized = decodeSerialized({
    raw: row.data.canonical_messages_json,
    table: PROJECTION_TABLE,
    field: "canonical_messages_json",
    version: version.value.version,
    recordId,
  });
  if (canonicalSerialized.status === "error") return Result.err(canonicalSerialized.error);
  const canonicalMessages = decodeNormalizedMessagesValue(canonicalSerialized.value, {
    table: PROJECTION_TABLE,
    field: "canonical_messages_json",
    version: version.value.version,
    recordId,
  });
  if (canonicalMessages.status === "error") return Result.err(canonicalMessages.error);
  const factsSerialized = decodeSerialized({
    raw: row.data.source_facts_json,
    table: PROJECTION_TABLE,
    field: "source_facts_json",
    version: version.value.version,
    recordId,
  });
  if (factsSerialized.status === "error") return Result.err(factsSerialized.error);
  const sourceFacts = coreProjectionSourceFactsSchema.safeParse(factsSerialized.value);
  if (!sourceFacts.success) {
    return Result.err(
      corrupt({
        table: PROJECTION_TABLE,
        field: "source_facts_json",
        version: version.value.version,
        issueCode: "invalid-surface-projection",
        recordId,
      }),
    );
  }
  return Result.ok({
    value: {
      requestClient: row.data.request_client,
      surfaceId: row.data.surface_id,
      sessionId: row.data.session_id,
      messageId: row.data.message_id,
      projectionFormatVersion: row.data.projection_format_version,
      canonicalMessages: canonicalMessages.value,
      sourceFacts: sourceFacts.data,
      createdAt: row.data.created_ts,
    },
    provenance: version.value.provenance,
  });
}

export function decodeCoreLineageManifestRow(input: {
  readonly row: PersistedCoreLineageManifestRow;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<DecodedCoreLineageManifestV1>, PersistedDataError>;
export function decodeCoreLineageManifestRow(input: {
  readonly row: null;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<null>, PersistedDataError>;
export function decodeCoreLineageManifestRow(input: {
  readonly row: PersistedCoreLineageManifestRow | null;
  readonly schemaVersion: number;
}): ResultType<DecodedPersistedValue<DecodedCoreLineageManifestV1 | null>, PersistedDataError> {
  if (input.row === null) return Result.ok({ value: null, provenance: "missing-defaulted" });
  const recordId =
    typeof input.row.request_id === "string" ? input.row.request_id : "unknown-record";
  const version = decodeSchemaVersion(input.schemaVersion, LINEAGE_TABLE, recordId);
  if (version.status === "error") return Result.err(version.error);
  if (input.row.lineage_version !== 1 || typeof input.row.manifest_json !== "string") {
    return Result.err(
      corrupt({
        table: LINEAGE_TABLE,
        field: "row",
        version: version.value.version,
        issueCode: "invalid-lineage-manifest",
        recordId,
      }),
    );
  }
  const serialized = decodeSerialized({
    raw: input.row.manifest_json,
    table: LINEAGE_TABLE,
    field: "manifest_json",
    version: version.value.version,
    recordId,
  });
  if (serialized.status === "error") return Result.err(serialized.error);
  const parsed = coreLineageManifestV1Schema.safeParse(serialized.value);
  if (!parsed.success) {
    return Result.err(
      corrupt({
        table: LINEAGE_TABLE,
        field: "manifest_json",
        version: version.value.version,
        issueCode: "invalid-lineage-manifest",
        recordId,
      }),
    );
  }
  const segments: DecodedCoreLineageSegmentV1[] = [];
  for (const segment of parsed.data.segments) {
    const canonicalMessages = decodeNormalizedMessagesValue(segment.canonicalMessages, {
      table: LINEAGE_TABLE,
      field: "manifest_json",
      version: version.value.version,
      recordId,
    });
    if (canonicalMessages.status === "error") return Result.err(canonicalMessages.error);
    segments.push({ ...segment, canonicalMessages: canonicalMessages.value });
  }
  const decodedManifest: DecodedCoreLineageManifestV1 = { ...parsed.data, segments };
  const canonicalMessages = decodedManifest.segments.flatMap(
    (segment) => segment.canonicalMessages,
  );
  const lineage = decodeCorePrimaryLineageV1(decodedManifest, canonicalMessages);
  if (lineage.status === "error" || lineage.value.state !== "complete") {
    return Result.err(
      corrupt({
        table: LINEAGE_TABLE,
        field: "manifest_json",
        version: version.value.version,
        issueCode: "invalid-lineage-manifest",
        recordId,
      }),
    );
  }
  return Result.ok({ value: decodedManifest, provenance: version.value.provenance });
}

const fixtureMessages = '[{"role":"assistant","content":"fixture"}]';
const fixtureDigest = hashCanonicalMessagesV1([{ role: "assistant", content: "fixture" }]).hash;
const fixtureTranscriptRow = {
  request_id: "fixture",
  session_id: "session",
  request_client: "discord",
  created_ts: 1,
  updated_ts: 2,
  model_label: null,
  final_text: null,
  messages_json: fixtureMessages,
  context_meta_json: null,
  provider_state_json: null,
  stable_named_request_client: null,
  transcript_digest: fixtureDigest,
} as const satisfies PersistedTranscriptRow;

export const transcriptCompactionContextCodecCases = {
  current: {
    input: {
      raw: '{"type":"compaction","formatVersion":1}',
      schemaVersion: 5,
      recordId: "current",
    },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: { raw: '{"type":"compaction","formatVersion":1}', schemaVersion: 1, recordId: "legacy" },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { raw: null, schemaVersion: 5, recordId: "missing" },
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": {
    input: { raw: null, schemaVersion: 6, recordId: "unsupported" },
    outcome: "error",
  },
  "malformed-serialization": {
    input: { raw: "{", schemaVersion: 5, recordId: "malformed" },
    outcome: "error",
  },
  "corrupt-fields": {
    input: {
      raw: '{"type":"compaction","formatVersion":2}',
      schemaVersion: 5,
      recordId: "corrupt",
    },
    outcome: "error",
  },
} as const;

export const transcriptProviderStateCodecCases = {
  current: {
    input: {
      raw: '{"lastFamily":"ai-sdk","containsCrossFamilyTurns":false}',
      schemaVersion: 5,
      recordId: "current",
    },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: {
      raw: '{"lastFamily":"ai-sdk","containsCrossFamilyTurns":false}',
      schemaVersion: 1,
      recordId: "legacy",
    },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { raw: null, schemaVersion: 5, recordId: "missing" },
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": {
    input: { raw: null, schemaVersion: 6, recordId: "unsupported" },
    outcome: "error",
  },
  "malformed-serialization": {
    input: { raw: "{", schemaVersion: 5, recordId: "malformed" },
    outcome: "error",
  },
  "corrupt-fields": {
    input: { raw: '{"lastFamily":"future"}', schemaVersion: 5, recordId: "corrupt" },
    outcome: "error",
  },
} as const;

export const transcriptRowCodecCases = {
  current: {
    input: {
      row: {
        ...fixtureTranscriptRow,
        context_meta_json: '{"type":"compaction","formatVersion":1}',
        provider_state_json: '{"lastFamily":"ai-sdk","containsCrossFamilyTurns":false}',
      },
      schemaVersion: 5,
    },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: { row: { ...fixtureTranscriptRow, transcript_digest: null }, schemaVersion: 1 },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { row: fixtureTranscriptRow, schemaVersion: 5 },
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": {
    input: { row: fixtureTranscriptRow, schemaVersion: 6 },
    outcome: "error",
  },
  "malformed-serialization": {
    input: { row: { ...fixtureTranscriptRow, messages_json: "{" }, schemaVersion: 5 },
    outcome: "error",
  },
  "corrupt-fields": {
    input: {
      row: { ...fixtureTranscriptRow, transcript_digest: "00".repeat(32) },
      schemaVersion: 5,
    },
    outcome: "error",
  },
} as const;

const fixtureProjectionRow = {
  request_client: "discord",
  surface_id: "discord:session",
  session_id: "session",
  message_id: "message",
  projection_format_version: 1,
  canonical_messages_json: fixtureMessages,
  source_facts_json: "{}",
  created_ts: 1,
} as const satisfies PersistedCoreSurfaceProjectionRow;

export const coreSurfaceProjectionRowCodecCases = {
  current: {
    input: { row: fixtureProjectionRow, schemaVersion: 5 },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: { row: fixtureProjectionRow, schemaVersion: 2 },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { row: null, schemaVersion: 5 },
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": {
    input: { row: fixtureProjectionRow, schemaVersion: 6 },
    outcome: "error",
  },
  "malformed-serialization": {
    input: { row: { ...fixtureProjectionRow, source_facts_json: "{" }, schemaVersion: 5 },
    outcome: "error",
  },
  "corrupt-fields": {
    input: {
      row: {
        ...fixtureProjectionRow,
        source_facts_json: '{"bad":null,"nested":{"bad":null}}',
        projection_format_version: 2,
      },
      schemaVersion: 5,
    },
    outcome: "error",
  },
} as const;

const fixtureLineageAtom = {
  kind: "synthetic",
  source: "fixture",
  messageDigest: fixtureDigest,
} as const;
const fixtureManifest = {
  state: "complete",
  lineageVersion: 1,
  currentCanonicalStart: 0,
  segments: [
    {
      atoms: [fixtureLineageAtom],
      canonicalMessages: [{ role: "assistant", content: "fixture" }],
      canonicalStart: 0,
      canonicalEnd: 1,
      cumulativeAtomCount: 1,
      cumulativePrefixDigest: computeCoreLineagePrefixDigestV1([fixtureLineageAtom]),
    },
  ],
} as const;
const fixtureLineageRow = {
  request_id: "fixture",
  lineage_version: 1,
  manifest_json: JSON.stringify(fixtureManifest),
} as const;

export const coreLineageManifestRowCodecCases = {
  current: {
    input: { row: fixtureLineageRow, schemaVersion: 5 },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: { row: fixtureLineageRow, schemaVersion: 2 },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: { row: null, schemaVersion: 5 },
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": { input: { row: fixtureLineageRow, schemaVersion: 6 }, outcome: "error" },
  "malformed-serialization": {
    input: { row: { ...fixtureLineageRow, manifest_json: "{" }, schemaVersion: 5 },
    outcome: "error",
  },
  "corrupt-fields": {
    input: { row: { ...fixtureLineageRow, manifest_json: "{}" }, schemaVersion: 5 },
    outcome: "error",
  },
} as const;
