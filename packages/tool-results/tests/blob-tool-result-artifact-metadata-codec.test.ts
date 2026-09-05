import { describe, expect, it } from "bun:test";

import {
  decodeBlobToolResultArtifactMetadata,
  encodeBlobToolResultArtifactMetadata,
  type BlobToolResultArtifactMetadata,
} from "../src/blob-tool-result-artifact-metadata-codec";
import {
  ToolResultArtifactMetadataCorrupt,
  ToolResultArtifactMetadataUnsupportedVersion,
} from "../src/tool-result-artifact-metadata-codec";

const storageKey = "00000000-0000-4000-8000-000000000001";
const metadata = {
  id: "00000000-0000-4000-8000-000000000002",
  storageKey,
  scopeId: "scope-a",
  requestId: "request-a",
  toolCallId: "call-a",
  toolName: "tool-a",
  createdAt: 100,
  expiresAt: 1_100,
  bytes: 5,
  blob: {
    version: 1,
    objectId: "b1_00000000000000000000000000000001",
    sha256: "0".repeat(64),
    byteLength: 33,
    expiresAt: 1_100,
  },
} as const satisfies BlobToolResultArtifactMetadata;

describe("blob-backed tool result artifact metadata codec", () => {
  it("round-trips the strict reference-backed version", () => {
    const decoded = decodeBlobToolResultArtifactMetadata({
      serialized: encodeBlobToolResultArtifactMetadata(metadata),
      expectedStorageKey: storageKey,
    });

    expect(decoded).toMatchObject({
      status: "ok",
      value: { value: metadata, provenance: "current" },
    });
  });

  it("rejects legacy metadata without a blob reference", () => {
    const decoded = decodeBlobToolResultArtifactMetadata({
      serialized: JSON.stringify({ version: 1, metadata: { ...metadata, blob: undefined } }),
      expectedStorageKey: storageKey,
    });

    expect(decoded.status === "error" && decoded.error).toBeInstanceOf(
      ToolResultArtifactMetadataUnsupportedVersion,
    );
  });

  it("rejects domain and blob retention or size disagreement", () => {
    const expiryMismatch = decodeBlobToolResultArtifactMetadata({
      serialized: encodeBlobToolResultArtifactMetadata({
        ...metadata,
        blob: { ...metadata.blob, expiresAt: 1_101 },
      }),
      expectedStorageKey: storageKey,
    });

    expect(expiryMismatch.status === "error" && expiryMismatch.error).toBeInstanceOf(
      ToolResultArtifactMetadataCorrupt,
    );

    const sizeMismatch = decodeBlobToolResultArtifactMetadata({
      serialized: encodeBlobToolResultArtifactMetadata({
        ...metadata,
        blob: { ...metadata.blob, byteLength: 34 },
      }),
      expectedStorageKey: storageKey,
    });
    expect(sizeMismatch.status === "error" && sizeMismatch.error).toBeInstanceOf(
      ToolResultArtifactMetadataCorrupt,
    );
  });
});
