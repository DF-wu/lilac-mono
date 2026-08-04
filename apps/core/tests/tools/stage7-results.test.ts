import { describe, expect, it } from "bun:test";
import { Panic, Result } from "better-result";

import {
  ApplyPatchCancelled,
  applyHunks,
  applyHunksResult,
} from "../../src/tools/apply-patch/apply-patch-core";
import {
  BashOutputStreamError,
  readSanitizedStreamTextCappedResult,
} from "../../src/tools/bash-output-sanitizer";
import { parseToolEnv, parseToolEnvResult } from "../../src/tools/tool-env";
import { adaptToolResultToHost, preserveToolPanic } from "../../src/tools/tool-result-adapters";

describe("Core tool Result boundaries", () => {
  it("returns cancellation as a value while preserving applyHunks rejection compatibility", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop patch"));

    const result = await applyHunksResult("/tmp", [], { signal: controller.signal });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(ApplyPatchCancelled.is(result.error)).toBe(true);

    await expect(applyHunks("/tmp", [], { signal: controller.signal })).rejects.toThrow(
      "apply_patch was cancelled",
    );
  });

  it("returns malformed tool environment roots as typed errors", () => {
    const result = parseToolEnvResult(["not", "an", "object"]);
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error._tag).toBe("ToolEnvInvalidError");
    expect(() => parseToolEnv(["not", "an", "object"])).toThrow(
      "Tool environment file must contain an object",
    );
  });

  it("returns stream rejection as a typed terminal error", async () => {
    const failure = new Error("stream failed");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(failure);
      },
    });

    const result = await readSanitizedStreamTextCappedResult(stream, 100);
    expect(result.status).toBe("error");
    if (result.status === "error") expect(BashOutputStreamError.is(result.error)).toBe(true);
  });

  it("keeps host rejection and Panic propagation exact", () => {
    const expected = new Error("host failure");
    expect(() => adaptToolResultToHost(Result.err(expected))).toThrow(expected);

    const panic = new Panic({ message: "tool invariant" });
    expect(() => preserveToolPanic(panic)).toThrow(panic);
  });
});
