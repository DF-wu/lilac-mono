import { blobRefV1Schema, type BlobRefV1 } from "@stanley2058/lilac-blob-storage";
import { Result, type Result as ResultType } from "better-result";
import { z } from "zod";

import {
  ToolResultArtifactMetadataAbsent,
  ToolResultArtifactMetadataCorrupt,
  ToolResultArtifactMetadataMalformed,
  ToolResultArtifactMetadataStorageKeyMismatch,
  ToolResultArtifactMetadataUnsupportedVersion,
  type ToolResultArtifactMetadataCodecError,
} from "./tool-result-artifact-metadata-codec";

export const BLOB_TOOL_RESULT_ARTIFACT_METADATA_VERSION = 2 as const;

const metadataSchema = z.strictObject({
  id: z.string().uuid(),
  storageKey: z.string().uuid(),
  scopeId: z.string(),
  requestId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  createdAt: z.number().int().nonnegative().safe(),
  expiresAt: z.number().int(),
  bytes: z.number().int().nonnegative().safe(),
  blob: blobRefV1Schema,
});

const envelopeSchema = z.strictObject({
  version: z.literal(BLOB_TOOL_RESULT_ARTIFACT_METADATA_VERSION),
  metadata: metadataSchema,
});

const envelopeVersionSchema = z.object({ version: z.number().int() }).passthrough();

export type BlobToolResultArtifactMetadata = Omit<z.output<typeof metadataSchema>, "blob"> & {
  readonly blob: BlobRefV1;
};

export type DecodedBlobToolResultArtifactMetadata = {
  readonly value: BlobToolResultArtifactMetadata;
  readonly provenance: "current";
};

export type BlobToolResultArtifactMetadataCodecInput = {
  readonly serialized: string | null;
  readonly expectedStorageKey: string;
};

export function decodeBlobToolResultArtifactMetadata(
  input: BlobToolResultArtifactMetadataCodecInput,
): ResultType<DecodedBlobToolResultArtifactMetadata, ToolResultArtifactMetadataCodecError> {
  if (input.serialized === null) {
    return Result.err(
      new ToolResultArtifactMetadataAbsent({
        issueCode: "metadata-absent",
        message: "Tool result artifact metadata is absent",
      }),
    );
  }

  const serialized = input.serialized;
  const parsed = Result.try({
    try: () => JSON.parse(serialized) as unknown,
    catch: () => undefined,
  }).match<{ value: unknown } | { error: ToolResultArtifactMetadataMalformed }>({
    ok: (value) => ({ value }),
    err: () => ({
      error: new ToolResultArtifactMetadataMalformed({
        issueCode: "malformed-serialization",
        message: "Tool result artifact metadata is not valid JSON",
      }),
    }),
  });
  if ("error" in parsed) return Result.err(parsed.error);

  const versioned = envelopeVersionSchema.safeParse(parsed.value);
  if (versioned.success && versioned.data.version !== BLOB_TOOL_RESULT_ARTIFACT_METADATA_VERSION) {
    return Result.err(
      new ToolResultArtifactMetadataUnsupportedVersion({
        issueCode: "unsupported-version",
        version: versioned.data.version,
        message: "Tool result artifact metadata version is unsupported",
      }),
    );
  }

  const envelope = envelopeSchema.safeParse(parsed.value);
  if (
    !envelope.success ||
    envelope.data.metadata.expiresAt !== envelope.data.metadata.blob.expiresAt ||
    envelope.data.metadata.bytes + 28 !== envelope.data.metadata.blob.byteLength
  ) {
    return Result.err(
      new ToolResultArtifactMetadataCorrupt({
        issueCode: "corrupt-fields",
        message: "Tool result artifact metadata has corrupt fields",
      }),
    );
  }
  if (envelope.data.metadata.storageKey !== input.expectedStorageKey) {
    return Result.err(
      new ToolResultArtifactMetadataStorageKeyMismatch({
        issueCode: "storage-key-mismatch",
        message: "Tool result artifact metadata does not match its storage location",
      }),
    );
  }
  return Result.ok({ value: envelope.data.metadata, provenance: "current" });
}

export function encodeBlobToolResultArtifactMetadata(
  metadata: BlobToolResultArtifactMetadata,
): string {
  return JSON.stringify({
    version: BLOB_TOOL_RESULT_ARTIFACT_METADATA_VERSION,
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
  blob: {
    version: 1,
    objectId: "b1_00000000000000000000000000000001",
    sha256: "0".repeat(64),
    byteLength: 31,
    expiresAt: 2,
  },
} as const satisfies BlobToolResultArtifactMetadata;

export const blobToolResultArtifactMetadataCodecCases = {
  current: {
    input: {
      serialized: encodeBlobToolResultArtifactMetadata(fixtureMetadata),
      expectedStorageKey: fixtureStorageKey,
    },
    outcome: "ok",
    provenance: "current",
  },
  legacy: {
    input: {
      serialized: JSON.stringify({
        id: fixtureMetadata.id,
        storageKey: fixtureStorageKey,
        scopeId: fixtureMetadata.scopeId,
        requestId: fixtureMetadata.requestId,
        toolCallId: fixtureMetadata.toolCallId,
        toolName: fixtureMetadata.toolName,
        createdAt: fixtureMetadata.createdAt,
        expiresAt: fixtureMetadata.expiresAt,
        bytes: fixtureMetadata.bytes,
      }),
      expectedStorageKey: fixtureStorageKey,
    },
    outcome: "error",
  },
  "missing-defaulted": {
    input: { serialized: null, expectedStorageKey: fixtureStorageKey },
    outcome: "error",
  },
  "unsupported-version": {
    input: {
      serialized: JSON.stringify({ version: 1, metadata: fixtureMetadata }),
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
        version: BLOB_TOOL_RESULT_ARTIFACT_METADATA_VERSION,
        metadata: { ...fixtureMetadata, bytes: "three" },
      }),
      expectedStorageKey: fixtureStorageKey,
    },
    outcome: "error",
  },
} as const;
