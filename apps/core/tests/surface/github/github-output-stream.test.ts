import { describe, expect, it } from "bun:test";

import type { SurfaceOutputPart } from "../../../src/surface/adapter";
import { GithubOutputStream } from "../../../src/surface/github/output/github-output-stream";

describe("GithubOutputStream", () => {
  it("intentionally accepts every optional presentation part without creating output", async () => {
    const stream = new GithubOutputStream({
      platform: "github",
      channelId: "octo/repo#1",
    });
    const optionalParts = [
      {
        type: "reasoning.status",
        update: { startedAtMs: 1, frozenAtMs: 2, detailText: "thinking" },
      },
      {
        type: "tool.status",
        update: { toolCallId: "tool", display: "bash pwd", status: "start" },
      },
      { type: "meta.stats", line: "stats" },
      {
        type: "attachment.add",
        attachment: {
          kind: "file",
          mimeType: "text/plain",
          filename: "result.txt",
          bytes: new Uint8Array([1]),
        },
      },
    ] satisfies readonly SurfaceOutputPart[];

    for (const part of optionalParts) await expect(stream.push(part)).resolves.toBe("ignored");
    await expect(stream.abort("test")).resolves.toBeUndefined();
  });
});
