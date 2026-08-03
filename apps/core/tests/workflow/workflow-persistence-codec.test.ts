import { describe, expect, it } from "bun:test";

import {
  decodeWorkflowPersistenceRow,
  workflowPersistenceRowFamilyFixtures,
  workflowPersistenceRowCodecCases,
} from "../../src/workflow/workflow-persistence-codec";

describe("workflow persistence row codec catalog", () => {
  it("executes all six outcomes for every persisted row family", () => {
    for (const fixtures of Object.values(workflowPersistenceRowFamilyFixtures)) {
      for (const [outcome, fixture] of Object.entries(fixtures)) {
        const result = (() => {
          switch (fixture.input.kind) {
            case "revision":
              return decodeWorkflowPersistenceRow(fixture.input);
            case "run":
              return decodeWorkflowPersistenceRow(fixture.input);
            case "operation":
              return decodeWorkflowPersistenceRow(fixture.input);
            case "wait":
              return decodeWorkflowPersistenceRow(fixture.input);
            case "trigger":
              return decodeWorkflowPersistenceRow(fixture.input);
            case "binding":
              return decodeWorkflowPersistenceRow(fixture.input);
            case "action":
              return decodeWorkflowPersistenceRow(fixture.input);
            case "dispatch":
              return decodeWorkflowPersistenceRow(fixture.input);
            case "receipt":
              return decodeWorkflowPersistenceRow(fixture.input);
            case "outbox":
              return decodeWorkflowPersistenceRow(fixture.input);
            case "legacy-audit":
              return decodeWorkflowPersistenceRow(fixture.input);
          }
          throw new Error("Unhandled workflow persistence fixture family");
        })();
        const successful =
          outcome === "current" || outcome === "legacy" || outcome === "missing-defaulted";
        expect(result.status).toBe(successful ? "ok" : "error");
        if ("value" in result) {
          let provenance: "current" | "migrated" | "missing-defaulted";
          if (outcome === "current") provenance = "current";
          else if (outcome === "legacy") provenance = "migrated";
          else provenance = "missing-defaulted";
          expect(result.value.provenance).toBe(provenance);
        }
      }
    }
  });

  it("covers current, legacy, missing, unsupported, malformed, and corrupt rows", () => {
    const current = decodeWorkflowPersistenceRow(workflowPersistenceRowCodecCases.current.input);
    expect(current.status).toBe("ok");
    if (current.status === "ok") expect(current.value.provenance).toBe("current");

    const legacy = decodeWorkflowPersistenceRow(workflowPersistenceRowCodecCases.legacy.input);
    expect(legacy.status).toBe("ok");
    if (legacy.status === "ok") expect(legacy.value.provenance).toBe("migrated");

    const missing = decodeWorkflowPersistenceRow(
      workflowPersistenceRowCodecCases["missing-defaulted"].input,
    );
    expect(missing.status).toBe("ok");
    if (missing.status === "ok") expect(missing.value.provenance).toBe("missing-defaulted");

    const unsupported = decodeWorkflowPersistenceRow(
      workflowPersistenceRowCodecCases["unsupported-version"].input,
    );
    expect(unsupported.status).toBe("error");
    if (unsupported.status === "error") expect(unsupported.error._tag).toBe("UnsupportedVersion");

    const malformed = decodeWorkflowPersistenceRow(
      workflowPersistenceRowCodecCases["malformed-serialization"].input,
    );
    expect(malformed.status).toBe("error");
    if (malformed.status === "error") {
      expect(malformed.error._tag).toBe("MalformedSerialization");
    }

    const corrupt = decodeWorkflowPersistenceRow(
      workflowPersistenceRowCodecCases["corrupt-fields"].input,
    );
    expect(corrupt.status).toBe("error");
    if (corrupt.status === "error") expect(corrupt.error._tag).toBe("CorruptPersistedFields");
  });
});
