import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createToolResultArtifactStore } from "../../src/artifacts/tool-result-artifact-store";
import { createToolResultOutputNormalizer } from "../../src/artifacts/tool-result-output-normalizer";

describe("Core read output normalization", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "lilac-core-read-normalizer-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("does not create overflow artifacts for direct or settled trusted reads", async () => {
    const artifacts = createToolResultArtifactStore(path.join(root, "tool-results"));
    await artifacts.init();
    const normalize = createToolResultOutputNormalizer({
      artifacts,
      owner: { requestId: "request-a", scopeId: "session-a" },
      getOutputConfig: () => ({
        maxPreviewBytes: 10,
        artifactTtlMs: 60_000,
        artifactMaxBytesPerSession: 1024 * 1024,
      }),
    });
    const readOutput = {
      type: "json" as const,
      value: {
        success: true,
        content: "x".repeat(100),
        nextStart: { type: "offset", offset: 100 },
      },
    };
    const trustedContext = {
      toolCallId: "read-a",
      toolName: "read",
      bypassGenericOutputNormalizer: true,
      aggregateOutputBudgetExempt: true,
    };

    expect(await normalize(readOutput, trustedContext)).toEqual(readOutput);
    expect(
      await normalize.normalizeSettled([
        { output: readOutput, context: trustedContext },
        {
          output: readOutput,
          context: { ...trustedContext, toolCallId: "read-b" },
        },
      ]),
    ).toEqual([readOutput, readOutput]);
    expect(await readdir(artifacts.rootDir)).toEqual([]);
  });
});
