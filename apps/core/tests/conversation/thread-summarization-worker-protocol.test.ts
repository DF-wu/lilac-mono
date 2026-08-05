import { describe, expect, it } from "bun:test";

import {
  decodeThreadSummarizationWorkerRequest,
  decodeThreadSummarizationWorkerResponse,
  type ThreadSummarizationResult,
} from "../../src/conversation/thread-summarization-worker-protocol";

function resultFixture(): ThreadSummarizationResult {
  return {
    dryRun: false,
    refreshed: { channels: 2, threads: 3, messages: 5 },
    eligible: 2,
    eligibleTotal: 4,
    eligibility: {
      summary: 1,
      embeddingOnly: 1,
      reasons: { "never-summarized": 1, "embedding-missing": 1 },
    },
    cleared: 0,
    summarized: 1,
    failed: 1,
    failures: [{ threadId: "thread-failed", error: "provider unavailable" }],
    threadIds: ["thread-ok", "thread-failed"],
  };
}

describe("conversation thread summarization worker protocol", () => {
  it("decodes the complete existing request envelope", () => {
    const request = {
      id: "job-1",
      input: {
        jobId: "caller-job",
        trigger: "periodic" as const,
        dryRun: true,
        wait: true,
        force: true,
        clear: true,
        limit: 25,
        threadId: "thread-1",
        beforeTs: 20,
        afterTs: 10,
        now: 30,
      },
      searchDbPath: "/data/search.sqlite",
      surfaceDbPath: "/data/surface.sqlite",
    };

    const decoded = decodeThreadSummarizationWorkerRequest(request);

    expect(decoded.status).toBe("ok");
    if (decoded.status === "ok") expect(decoded.value).toEqual(request);
  });

  it("rejects malformed nested request fields", () => {
    const decoded = decodeThreadSummarizationWorkerRequest({
      id: "job-1",
      input: { trigger: "scheduled", limit: "25" },
      searchDbPath: "/data/search.sqlite",
    });

    expect(decoded.status).toBe("error");
    if (decoded.status === "error") {
      expect(decoded.error._tag).toBe("ThreadSummarizationWorkerRequestDecodeError");
      expect(decoded.error.issues.some((issue) => issue.startsWith("input.trigger:"))).toBe(true);
      expect(decoded.error.issues.some((issue) => issue.startsWith("input.limit:"))).toBe(true);
    }
  });

  it("rejects blank request identifiers and paths, non-finite numbers, and extra fields", () => {
    const base = {
      id: "job-1",
      input: {},
      searchDbPath: "/data/search.sqlite",
    };
    const malformedRequests = [
      { ...base, id: "" },
      { ...base, searchDbPath: "" },
      { ...base, surfaceDbPath: "" },
      { ...base, input: { threadId: "" } },
      { ...base, input: { now: Number.POSITIVE_INFINITY } },
      { ...base, extra: true },
      { ...base, input: { extra: true } },
    ];

    for (const request of malformedRequests) {
      expect(decodeThreadSummarizationWorkerRequest(request).status).toBe("error");
    }
  });

  it("decodes both existing response envelopes", () => {
    const success = { id: "job-1", ok: true as const, result: resultFixture() };
    const failure = { id: "job-2", ok: false as const, error: "summarization failed" };

    const decodedSuccess = decodeThreadSummarizationWorkerResponse(success);
    const decodedFailure = decodeThreadSummarizationWorkerResponse(failure);

    expect(decodedSuccess.status).toBe("ok");
    if (decodedSuccess.status === "ok") expect(decodedSuccess.value).toEqual(success);
    expect(decodedFailure.status).toBe("ok");
    if (decodedFailure.status === "ok") expect(decodedFailure.value).toEqual(failure);
  });

  it("rejects incomplete and malformed nested response payloads", () => {
    const incomplete = decodeThreadSummarizationWorkerResponse({
      id: "job-1",
      ok: true,
      result: { eligible: 1 },
    });
    const malformed = decodeThreadSummarizationWorkerResponse({
      id: "job-2",
      ok: true,
      result: { ...resultFixture(), failures: [{ threadId: 42, error: "failed" }] },
    });

    expect(incomplete.status).toBe("error");
    expect(malformed.status).toBe("error");
    if (malformed.status === "error") {
      expect(
        malformed.error.issues.some((issue) => issue.startsWith("result.failures.0.threadId:")),
      ).toBe(true);
    }
  });

  it("rejects blank response identifiers and errors and extra envelope fields", () => {
    const malformedResponses = [
      { id: "", ok: false, error: "failed" },
      { id: "job-1", ok: false, error: "" },
      { id: "job-1", ok: false, error: "failed", extra: true },
      { id: "job-1", ok: true, result: { ...resultFixture(), extra: true } },
      {
        id: "job-1",
        ok: true,
        result: {
          ...resultFixture(),
          refreshed: { ...resultFixture().refreshed, extra: true },
        },
      },
      {
        id: "job-1",
        ok: true,
        result: {
          ...resultFixture(),
          eligibility: {
            ...resultFixture().eligibility,
            reasons: { ...resultFixture().eligibility.reasons, unexpected: 1 },
          },
        },
      },
    ];

    for (const response of malformedResponses) {
      expect(decodeThreadSummarizationWorkerResponse(response).status).toBe("error");
    }
  });

  it("requires finite nonnegative integer result counts and nonempty result strings", () => {
    const malformedResults = [
      { ...resultFixture(), eligible: -1 },
      { ...resultFixture(), eligibleTotal: 1.5 },
      { ...resultFixture(), summarized: Number.POSITIVE_INFINITY },
      {
        ...resultFixture(),
        refreshed: { ...resultFixture().refreshed, messages: -1 },
      },
      {
        ...resultFixture(),
        eligibility: { ...resultFixture().eligibility, summary: 0.5 },
      },
      {
        ...resultFixture(),
        eligibility: {
          ...resultFixture().eligibility,
          reasons: { "never-summarized": -1 },
        },
      },
      { ...resultFixture(), failures: [{ threadId: "", error: "failed" }] },
      { ...resultFixture(), failures: [{ threadId: "thread-1", error: "" }] },
      { ...resultFixture(), threadIds: [""] },
      { ...resultFixture(), jobId: "" },
    ];

    for (const result of malformedResults) {
      expect(
        decodeThreadSummarizationWorkerResponse({ id: "job-1", ok: true, result }).status,
      ).toBe("error");
    }
  });
});
