import { describe, expect, it } from "bun:test";

import {
  decodeToolResultArtifactMetadata,
  ToolResultArtifactMetadataAbsent,
  ToolResultArtifactMetadataCorrupt,
  ToolResultArtifactMetadataMalformed,
  ToolResultArtifactMetadataStorageKeyMismatch,
  ToolResultArtifactMetadataUnsupportedVersion,
  toolResultArtifactMetadataCodecCases,
} from "../src/tool-result-artifact-metadata-codec";

describe("tool result artifact metadata codec", () => {
  it("executes the complete compatibility fixture catalog", () => {
    const current = decodeToolResultArtifactMetadata(
      toolResultArtifactMetadataCodecCases.current.input,
    );
    const legacy = decodeToolResultArtifactMetadata(
      toolResultArtifactMetadataCodecCases.legacy.input,
    );
    const defaulted = decodeToolResultArtifactMetadata(
      toolResultArtifactMetadataCodecCases["missing-defaulted"].input,
    );
    const unsupported = decodeToolResultArtifactMetadata(
      toolResultArtifactMetadataCodecCases["unsupported-version"].input,
    );
    const malformed = decodeToolResultArtifactMetadata(
      toolResultArtifactMetadataCodecCases["malformed-serialization"].input,
    );
    const corrupt = decodeToolResultArtifactMetadata(
      toolResultArtifactMetadataCodecCases["corrupt-fields"].input,
    );

    expect(current.status === "ok" && current.value.provenance).toBe("current");
    expect(legacy.status === "ok" && legacy.value.provenance).toBe("migrated");
    expect(defaulted.status === "ok" && defaulted.value.provenance).toBe("missing-defaulted");
    expect(unsupported.status === "error" && unsupported.error).toBeInstanceOf(
      ToolResultArtifactMetadataUnsupportedVersion,
    );
    expect(malformed.status === "error" && malformed.error).toBeInstanceOf(
      ToolResultArtifactMetadataMalformed,
    );
    expect(corrupt.status === "error" && corrupt.error).toBeInstanceOf(
      ToolResultArtifactMetadataCorrupt,
    );
  });

  it("classifies absent metadata separately from malformed data", () => {
    const result = decodeToolResultArtifactMetadata({
      serialized: null,
      expectedStorageKey: "not-materialized",
    });

    expect(result.status === "error" && result.error).toBeInstanceOf(
      ToolResultArtifactMetadataAbsent,
    );
  });

  it("rejects metadata moved to a different storage key without exposing either key", () => {
    const input = toolResultArtifactMetadataCodecCases.current.input;
    const result = decodeToolResultArtifactMetadata({
      ...input,
      expectedStorageKey: "00000000-0000-4000-8000-000000000099",
    });

    expect(result.status === "error" && result.error).toBeInstanceOf(
      ToolResultArtifactMetadataStorageKeyMismatch,
    );
    expect(JSON.stringify(result)).not.toContain(input.expectedStorageKey);
    expect(JSON.stringify(result)).not.toContain("00000000-0000-4000-8000-000000000099");
  });
});
