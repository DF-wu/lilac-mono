import { describe, expect, it } from "bun:test";
import { Result } from "better-result";

import type { SurfaceOutputPart, SurfaceOutputPartDisposition } from "../../../src/surface/adapter";
import { GithubOutputStream } from "../../../src/surface/github/output/github-output-stream";

describe("GithubOutputStream", () => {
  it("distinguishes visible, terminal-only, and ignored presentation parts", async () => {
    const stream = new GithubOutputStream(
      {
        platform: "github",
        channelId: "octo/repo#1",
      },
      {
        createComment: async () => Result.ok({ id: 1 }),
      },
    );
    const optionalParts = [
      { type: "text.delta", delta: "Visible text" },
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

    const dispositions: SurfaceOutputPartDisposition[] = [];
    for (const part of optionalParts) {
      const result = await stream.push(part);
      if (result.status === "error") throw result.error;
      dispositions.push(result.value);
    }
    expect(dispositions).toEqual(["visible", "ignored", "terminal", "ignored", "terminal"]);
    await expect(stream.abort("test")).resolves.toEqual(Result.ok(undefined));
  });
});
