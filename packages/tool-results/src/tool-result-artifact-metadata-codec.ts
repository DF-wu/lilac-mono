import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

export const TOOL_RESULT_ARTIFACT_METADATA_VERSION = 1 as const;

const artifactMetadataSchema = z.strictObject({
  id: z.string().uuid(),
  storageKey: z.string().uuid(),
  scopeId: z.string().optional(),
  sessionId: z.string().optional(),
  requestId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  createdAt: z.number().finite(),
  expiresAt: z.number().finite(),
  bytes: z.number().int().nonnegative(),
});

const currentEnvelopeSchema = z.strictObject({
  version: z.literal(TOOL_RESULT_ARTIFACT_METADATA_VERSION),
  metadata: artifactMetadataSchema,
});

const envelopeVersionSchema = z.object({ version: z.number().int() }).passthrough();

type PersistedToolResultArtifactMetadata = z.output<typeof artifactMetadataSchema>;

export type ToolResultArtifactMetadata = Omit<PersistedToolResultArtifactMetadata, "scopeId"> & {
  readonly scopeId: string;
};

export type DecodedToolResultArtifactMetadata = {
  readonly value: ToolResultArtifactMetadata;
  readonly provenance: "current" | "migrated" | "missing-defaulted";
};

export type ToolResultArtifactMetadataIssueCode =
  | "metadata-absent"
  | "unsupported-version"
  | "malformed-serialization"
  | "corrupt-fields"
  | "storage-key-mismatch";

type MetadataErrorContext = {
  readonly issueCode: ToolResultArtifactMetadataIssueCode;
  readonly message: string;
};

export class ToolResultArtifactMetadataAbsent extends TaggedError(
  "ToolResultArtifactMetadataAbsent",
)<MetadataErrorContext> {}

export class ToolResultArtifactMetadataUnsupportedVersion extends TaggedError(
  "ToolResultArtifactMetadataUnsupportedVersion",
)<MetadataErrorContext & { readonly version: number }> {}

export class ToolResultArtifactMetadataMalformed extends TaggedError(
  "ToolResultArtifactMetadataMalformed",
)<MetadataErrorContext> {}

export class ToolResultArtifactMetadataCorrupt extends TaggedError(
  "ToolResultArtifactMetadataCorrupt",
)<MetadataErrorContext> {}

export class ToolResultArtifactMetadataStorageKeyMismatch extends TaggedError(
  "ToolResultArtifactMetadataStorageKeyMismatch",
)<MetadataErrorContext> {}

export type ToolResultArtifactMetadataCodecError =
  | ToolResultArtifactMetadataAbsent
  | ToolResultArtifactMetadataUnsupportedVersion
  | ToolResultArtifactMetadataMalformed
  | ToolResultArtifactMetadataCorrupt
  | ToolResultArtifactMetadataStorageKeyMismatch;

export type ToolResultArtifactMetadataCodecInput = {
  readonly serialized: string | null;
  readonly expectedStorageKey: string;
};

function validateMetadata(
  metadata: PersistedToolResultArtifactMetadata,
  expectedStorageKey: string,
): ResultType<ToolResultArtifactMetadata, ToolResultArtifactMetadataCodecError> {
  const scopeId = metadata.scopeId ?? metadata.sessionId;
  if (scopeId === undefined) {
    return Result.err(
      new ToolResultArtifactMetadataCorrupt({
        issueCode: "corrupt-fields",
        message: "Tool result artifact metadata has corrupt fields",
      }),
    );
  }
  if (metadata.storageKey !== expectedStorageKey) {
    return Result.err(
      new ToolResultArtifactMetadataStorageKeyMismatch({
        issueCode: "storage-key-mismatch",
        message: "Tool result artifact metadata does not match its storage location",
      }),
    );
  }
  return Result.ok({ ...metadata, scopeId });
}

export function decodeToolResultArtifactMetadata(
  input: ToolResultArtifactMetadataCodecInput,
): ResultType<DecodedToolResultArtifactMetadata, ToolResultArtifactMetadataCodecError> {
  if (input.serialized === null) {
    return Result.err(
      new ToolResultArtifactMetadataAbsent({
        issueCode: "metadata-absent",
        message: "Tool result artifact metadata is absent",
      }),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.serialized);
  } catch {
    return Result.err(
      new ToolResultArtifactMetadataMalformed({
        issueCode: "malformed-serialization",
        message: "Tool result artifact metadata is not valid JSON",
      }),
    );
  }

  const versioned = envelopeVersionSchema.safeParse(parsed);
  if (versioned.success && versioned.data.version !== TOOL_RESULT_ARTIFACT_METADATA_VERSION) {
    return Result.err(
      new ToolResultArtifactMetadataUnsupportedVersion({
        issueCode: "unsupported-version",
        version: versioned.data.version,
        message: "Tool result artifact metadata version is unsupported",
      }),
    );
  }

  if (versioned.success) {
    const envelope = currentEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      return Result.err(
        new ToolResultArtifactMetadataCorrupt({
          issueCode: "corrupt-fields",
          message: "Tool result artifact metadata has corrupt fields",
        }),
      );
    }
    const validated = validateMetadata(envelope.data.metadata, input.expectedStorageKey);
    if (validated.status === "error") return Result.err(validated.error);
    return Result.ok({
      value: validated.value,
      provenance: envelope.data.metadata.scopeId === undefined ? "missing-defaulted" : "current",
    });
  }

  const legacy = artifactMetadataSchema.safeParse(parsed);
  if (!legacy.success) {
    return Result.err(
      new ToolResultArtifactMetadataCorrupt({
        issueCode: "corrupt-fields",
        message: "Tool result artifact metadata has corrupt fields",
      }),
    );
  }
  const validated = validateMetadata(legacy.data, input.expectedStorageKey);
  if (validated.status === "error") return Result.err(validated.error);
  return Result.ok({ value: validated.value, provenance: "migrated" });
}

export function encodeToolResultArtifactMetadata(metadata: ToolResultArtifactMetadata): string {
  return JSON.stringify({
    version: TOOL_RESULT_ARTIFACT_METADATA_VERSION,
    metadata,
  });
}

const fixtureStorageKey = "00000000-0000-4000-8000-000000000001";
const fixtureMetadata = {
  id: "00000000-0000-4000-8000-000000000002",
  storageKey: fixtureStorageKey,
  scopeId: "fixture-scope",
  requestId: "fixture-request",
  toolCallId: "fixture-call",
  toolName: "fixture-tool",
  createdAt: 1,
  expiresAt: 2,
  bytes: 3,
} as const satisfies ToolResultArtifactMetadata;

export const toolResultArtifactMetadataCodecCases = {
  current: {
    input: {
      serialized: JSON.stringify({ version: 1, metadata: fixtureMetadata }),
      expectedStorageKey: fixtureStorageKey,
    },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: { serialized: JSON.stringify(fixtureMetadata), expectedStorageKey: fixtureStorageKey },
    outcome: "ok",
    provenance: "migrated",
  },
  "missing-defaulted": {
    input: {
      serialized: JSON.stringify({
        version: 1,
        metadata: { ...fixtureMetadata, scopeId: undefined, sessionId: "fixture-scope" },
      }),
      expectedStorageKey: fixtureStorageKey,
    },
    outcome: "ok",
    provenance: "missing-defaulted",
  },
  "unsupported-version": {
    input: {
      serialized: JSON.stringify({ version: 2, metadata: fixtureMetadata }),
      expectedStorageKey: fixtureStorageKey,
    },
    outcome: "error",
  },
  "malformed-serialization": {
    input: { serialized: "{", expectedStorageKey: fixtureStorageKey },
    outcome: "error",
  },
  "corrupt-fields": {
    input: {
      serialized: JSON.stringify({
        version: 1,
        metadata: { ...fixtureMetadata, bytes: "three" },
      }),
      expectedStorageKey: fixtureStorageKey,
    },
    outcome: "error",
  },
} as const;
