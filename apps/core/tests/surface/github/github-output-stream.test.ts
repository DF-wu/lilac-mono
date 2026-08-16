import { describe, expect, it } from "bun:test";
import { Result } from "better-result";

import {
  type SurfaceOutputPart,
  type SurfaceOutputPartDisposition,
  SurfaceUnavailable,
} from "../../../src/surface/adapter";
import { GithubOutputStream } from "../../../src/surface/github/output/github-output-stream";

describe("GithubOutputStream", () => {
  it("hydrates restored state without provider calls and publishes only on finish", async () => {
    const comments: string[] = [];
    const stream = new GithubOutputStream(
      { platform: "github", channelId: "octo/repo#1" },
      {
        createComment: async (body) => {
          comments.push(body);
          return Result.ok({ id: 1 });
        },
        getIssue: async () => Result.ok({ id: 100 }),
      },
    );

    expect(stream.hydrateRecovery([{ type: "text.set", text: "restored" }])).toBe("visible");
    expect(comments).toEqual([]);
    await expect(stream.push({ type: "text.delta", delta: " live" })).resolves.toEqual(
      Result.ok("visible"),
    );
    expect(comments).toEqual([]);

    const finished = await stream.finish();
    expect(finished.status).toBe("ok");
    expect(comments).toHaveLength(1);
    expect(comments[0]).toContain("restored live");
  });

  it("distinguishes visible, terminal-only, and ignored presentation parts", async () => {
    const stream = new GithubOutputStream(
      {
        platform: "github",
        channelId: "octo/repo#1",
      },
      {
        createComment: async () => Result.ok({ id: 1 }),
        getIssue: async () => Result.ok({ id: 100 }),
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

  it("links issue and pull request body replies to the body anchor", async () => {
    const comments: string[] = [];
    const stream = new GithubOutputStream(
      { platform: "github", channelId: "octo/repo#47" },
      {
        createComment: async (body) => {
          comments.push(body);
          return Result.ok({ id: 1 });
        },
        getIssue: async (input) => {
          expect(input).toEqual({ owner: "octo", repo: "repo", number: 47 });
          return Result.ok({ id: 5_014_377_739 });
        },
      },
      {
        replyTo: { platform: "github", channelId: "octo/repo#47", messageId: "47" },
      },
    );

    await stream.finish();

    expect(comments[0]).toContain(
      "In reply to https://github.com/octo/repo/issues/47#issue-5014377739",
    );
  });

  it("links comment replies without looking up the issue", async () => {
    const comments: string[] = [];
    const stream = new GithubOutputStream(
      { platform: "github", channelId: "octo/repo#47" },
      {
        createComment: async (body) => {
          comments.push(body);
          return Result.ok({ id: 1 });
        },
        getIssue: async () => {
          throw new Error("comment replies must not look up the issue");
        },
      },
      {
        replyTo: { platform: "github", channelId: "octo/repo#47", messageId: "4152921803" },
      },
    );

    await stream.finish();

    expect(comments[0]).toContain(
      "In reply to https://github.com/octo/repo/issues/47#issuecomment-4152921803",
    );
  });

  it("falls back to the thread URL when the body lookup fails", async () => {
    const comments: string[] = [];
    const stream = new GithubOutputStream(
      { platform: "github", channelId: "octo/repo#47" },
      {
        createComment: async (body) => {
          comments.push(body);
          return Result.ok({ id: 1 });
        },
        getIssue: async () =>
          Result.err(
            new SurfaceUnavailable({
              platform: "github",
              operation: "read-message",
              message: "unavailable",
            }),
          ),
      },
      {
        replyTo: { platform: "github", channelId: "octo/repo#47", messageId: "47" },
      },
    );

    await stream.finish();

    expect(comments[0]).toContain("In reply to https://github.com/octo/repo/issues/47:");
  });
});
