import { describe, expect, it } from "bun:test";

import {
  conversationThreadSummaryRowCodecCases,
  decodeConversationThreadAboutness,
  decodeConversationThreadImportance,
  decodeConversationThreadStringArray,
  decodeConversationThreadSummaryRow,
} from "../../src/conversation/thread-summary-persistence-codec";

describe("conversation thread summary persistence codecs", () => {
  it("executes every exported six-case row compatibility assertion", () => {
    expect(Object.keys(conversationThreadSummaryRowCodecCases).sort()).toEqual([
      "corrupt-fields",
      "current",
      "legacy",
      "malformed-serialization",
      "missing-defaulted",
      "unsupported-version",
    ]);

    for (const fixture of Object.values(conversationThreadSummaryRowCodecCases)) {
      const result = decodeConversationThreadSummaryRow(fixture.input);
      expect(result.status).toBe(fixture.outcome);
      if (fixture.outcome === "ok") {
        if (result.status === "ok") expect(result.value.provenance).toBe(fixture.provenance);
        continue;
      }
      if (result.status === "error") {
        expect(result.error._tag).toBe(fixture.errorTag);
        expect(result.error.issueCode).toBe(fixture.issueCode);
      }
    }
  });

  it("decodes current v1 and both implicit and explicit v0 rows", () => {
    const current = decodeConversationThreadSummaryRow(
      conversationThreadSummaryRowCodecCases.current.input,
    );
    expect(current.status).toBe("ok");
    if (current.status === "ok") {
      expect(current.value.provenance).toBe("current");
      expect(current.value.value.topics).toEqual(["runtime"]);
    }

    const unversioned = decodeConversationThreadSummaryRow(
      conversationThreadSummaryRowCodecCases.legacy.input,
    );
    expect(unversioned.status).toBe("ok");
    if (unversioned.status === "ok") expect(unversioned.value.provenance).toBe("migrated");

    const explicitV0 = decodeConversationThreadSummaryRow({
      ...conversationThreadSummaryRowCodecCases.legacy.input,
      summary_format_version: 0,
    });
    expect(explicitV0.status).toBe("ok");
    if (explicitV0.status === "ok") expect(explicitV0.value.provenance).toBe("migrated");
  });

  it("defaults only contractually optional persisted fields", () => {
    const defaulted = decodeConversationThreadSummaryRow(
      conversationThreadSummaryRowCodecCases["missing-defaulted"].input,
    );
    expect(defaulted.status).toBe("ok");
    if (defaulted.status === "ok") {
      expect(defaulted.value.provenance).toBe("missing-defaulted");
      expect(defaulted.value.value.retrievalHints).toEqual([]);
    }

    const requiredTopics = decodeConversationThreadStringArray({
      raw: null,
      version: 1,
      field: "topics_json",
      recordId: "required-topics",
    });
    expect(requiredTopics.status).toBe("error");
    if (requiredTopics.status === "error") {
      expect(requiredTopics.error._tag).toBe("CorruptPersistedFields");
      expect(requiredTopics.error.issueCode).toBe("missing-required-field");
    }
  });

  it("classifies malformed JSON separately from valid JSON with corrupt fields", () => {
    const malformed = decodeConversationThreadSummaryRow(
      conversationThreadSummaryRowCodecCases["malformed-serialization"].input,
    );
    expect(malformed.status).toBe("error");
    if (malformed.status === "error") {
      expect(malformed.error._tag).toBe("MalformedSerialization");
      expect(malformed.error.issueCode).toBe("malformed-json");
    }

    const corrupt = decodeConversationThreadSummaryRow(
      conversationThreadSummaryRowCodecCases["corrupt-fields"].input,
    );
    expect(corrupt.status).toBe("error");
    if (corrupt.status === "error") {
      expect(corrupt.error._tag).toBe("CorruptPersistedFields");
      expect(corrupt.error.issueCode).toBe("mixed-string-array");
    }
  });

  it("classifies invalid scalar importance as corruption, never malformed serialization", () => {
    for (const raw of ["urgent", "{"]) {
      const importance = decodeConversationThreadImportance({
        raw,
        version: 1,
        recordId: `invalid-importance-${raw}`,
      });
      expect(importance.status).toBe("error");
      if (importance.status === "error") {
        expect(importance.error._tag).toBe("CorruptPersistedFields");
        expect(importance.error.issueCode).toBe("invalid-importance");
      }
    }
  });

  it("supports legacy partial aboutness without accepting mixed arrays", () => {
    const legacy = decodeConversationThreadAboutness({
      raw: '{"domains":["runtime"]}',
      version: null,
      recordId: "legacy-aboutness",
    });
    expect(legacy.status).toBe("ok");
    if (legacy.status === "ok") {
      expect(legacy.value.provenance).toBe("migrated");
      expect(legacy.value.value).toEqual({
        domains: ["runtime"],
        situations: [],
        complaintTargets: [],
        entities: [],
        userWouldAskForThisAs: [],
      });
    }

    const corrupt = decodeConversationThreadAboutness({
      raw: '{"domains":["runtime",1],"situations":[],"complaintTargets":[],"entities":[],"userWouldAskForThisAs":[]}',
      version: 1,
      recordId: "corrupt-aboutness",
    });
    expect(corrupt.status).toBe("error");
    if (corrupt.status === "error") {
      expect(corrupt.error._tag).toBe("CorruptPersistedFields");
      expect(corrupt.error.issueCode).toBe("invalid-aboutness");
    }
  });
});
