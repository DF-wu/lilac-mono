import { describe, expect, it } from "bun:test";

import type { SurfaceOutputPart } from "../../../src/surface/adapter";
import { GithubOutputStream } from "../../../src/surface/github/output/github-output-stream";

describe("GithubOutputStream", () => {
  it("distinguishes terminal-only parts from ignored presentation parts", async () => {
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

    const dispositions = [];
    for (const part of optionalParts) dispositions.push(await stream.push(part));
    expect(dispositions).toEqual(["ignored", "terminal", "ignored", "terminal"]);
    await expect(stream.abort("test")).resolves.toBeUndefined();
  });
});
