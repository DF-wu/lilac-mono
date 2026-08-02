import { describe, expect, it } from "bun:test";

import {
  decodeBundledRemoteRunnerRequestJson,
  decodeRemoteFsDaemonRequest,
  decodeRemoteGlobResponseJson,
  decodeRemoteReadTextResponseJson,
} from "../src/remote-runner-protocol";

describe("remote runner request protocol", () => {
  it("accepts the legacy edit fixture without an explicit mode or deny paths", () => {
    const decoded = decodeBundledRemoteRunnerRequestJson(
      JSON.stringify({
        op: "fs.edit",
        input: {
          path: "src/index.ts",
          edits: [{ type: "insert_at", line: 1, newText: "// fixture\n" }],
        },
      }),
    );

    expect(decoded.status).toBe("ok");
    if (decoded.status === "error") throw new Error(decoded.error.message);
    expect(decoded.value).toEqual({
      op: "fs.edit",
      denyPaths: [],
      input: {
        path: "src/index.ts",
        edits: [{ type: "insert_at", line: 1, newText: "// fixture\n" }],
      },
    });
  });

  it("distinguishes malformed JSON, envelopes, operations, and operation payloads", () => {
    const malformedJson = decodeBundledRemoteRunnerRequestJson("{");
    const malformedEnvelope = decodeBundledRemoteRunnerRequestJson(
      JSON.stringify({ op: 42, input: {} }),
    );
    const unknownOperation = decodeBundledRemoteRunnerRequestJson(
      JSON.stringify({ op: "fs.future", input: {} }),
    );
    const malformedPayload = decodeBundledRemoteRunnerRequestJson(
      JSON.stringify({
        op: "fs.edit",
        input: { path: "a.ts", mode: "hashline", edits: [{ op: "future", pos: "1#aaaa" }] },
      }),
    );

    expect(malformedJson.status === "error" ? malformedJson.error._tag : "ok").toBe(
      "RemoteRunnerMalformedJsonError",
    );
    expect(malformedEnvelope.status === "error" ? malformedEnvelope.error._tag : "ok").toBe(
      "RemoteRunnerRequestEnvelopeError",
    );
    expect(unknownOperation.status === "error" ? unknownOperation.error._tag : "ok").toBe(
      "RemoteRunnerUnknownOperationError",
    );
    expect(malformedPayload.status === "error" ? malformedPayload.error._tag : "ok").toBe(
      "RemoteRunnerRequestPayloadError",
    );
  });

  it("keeps fuzzy search daemon-only", () => {
    const decoded = decodeBundledRemoteRunnerRequestJson(
      JSON.stringify({ op: "fs.fuzzy_search", input: { query: "index" } }),
    );

    expect(decoded.status === "error" ? decoded.error._tag : "ok").toBe(
      "RemoteRunnerUnknownOperationError",
    );
  });

  it("normalizes an omitted daemon cwd for wire compatibility", () => {
    const decoded = decodeRemoteFsDaemonRequest({ op: "health", input: {} });

    expect(decoded.status).toBe("ok");
    if (decoded.status === "error") throw new Error(decoded.error.message);
    expect(decoded.value.cwd).toBe(process.cwd());
  });
});

describe("remote runner response protocol", () => {
  it("accepts existing successful and operation-specific failure fixtures", () => {
    const success = decodeRemoteReadTextResponseJson(
      JSON.stringify({
        ok: true,
        value: {
          success: true,
          resolvedPath: "/workspace/a.ts",
          fileHash: "abc",
          startLine: 1,
          endLine: 1,
          totalLines: 1,
          hasMoreLines: false,
          truncatedByChars: false,
          format: "raw",
          content: "hello",
        },
      }),
    );
    const innerFailure = decodeRemoteReadTextResponseJson(
      JSON.stringify({
        ok: true,
        value: {
          success: false,
          resolvedPath: "/workspace/missing.ts",
          error: { code: "NOT_FOUND", message: "missing" },
        },
      }),
    );

    expect(success.status).toBe("ok");
    expect(innerFailure.status).toBe("ok");
    if (innerFailure.status === "ok") expect(innerFailure.value.success).toBeFalse();
  });

  it("rejects malformed JSON, envelopes, payloads, and unknown response variants", () => {
    const malformedJson = decodeRemoteGlobResponseJson("not-json");
    const malformedEnvelope = decodeRemoteGlobResponseJson(JSON.stringify({ ok: true }));
    const malformedPayload = decodeRemoteGlobResponseJson(
      JSON.stringify({ ok: true, value: { mode: "default", truncated: false, paths: [42] } }),
    );
    const unknownVariant = decodeRemoteGlobResponseJson(
      JSON.stringify({ ok: true, value: { mode: "future", truncated: false, paths: [] } }),
    );

    expect(malformedJson.status === "error" ? malformedJson.error._tag : "ok").toBe(
      "RemoteRunnerMalformedJsonError",
    );
    expect(malformedEnvelope.status === "error" ? malformedEnvelope.error._tag : "ok").toBe(
      "RemoteRunnerResponseEnvelopeError",
    );
    expect(malformedPayload.status === "error" ? malformedPayload.error._tag : "ok").toBe(
      "RemoteRunnerResponsePayloadError",
    );
    expect(unknownVariant.status === "error" ? unknownVariant.error._tag : "ok").toBe(
      "RemoteRunnerResponsePayloadError",
    );
  });
});
