import { describe, expect, it, spyOn } from "bun:test";
import { Panic } from "better-result";

import {
  createGithubRelayPolicy,
  type GithubAcknowledgementApi,
} from "../../../src/surface/github/github-runtime-descriptor";
import {
  clearGithubAck,
  getGithubAck,
  setGithubAck,
  type GithubAckState,
} from "../../../src/github/github-state";

function acknowledgementCleanup(input: {
  readonly requestId: string;
  readonly target: GithubAckState["target"];
  readonly api: GithubAcknowledgementApi;
}) {
  setGithubAck(input.requestId, { target: input.target, reactionId: 42 });
  const cleanup = createGithubRelayPolicy({
    acknowledgementApi: input.api,
  }).finalization?.clearIngressAcknowledgement;
  if (!cleanup) throw new Error("GitHub acknowledgement cleanup is unavailable");
  return cleanup({ requestId: input.requestId, sessionId: "octo/repo#12" });
}

describe("GitHub relay acknowledgement finalization", () => {
  it.each([
    [{ kind: "issue", issueNumber: 12 }, "issue"],
    [{ kind: "comment", commentId: 55, issueNumber: 12 }, "comment"],
  ] as const)("deletes and clears a GitHub %s acknowledgement", async (target, expectedKind) => {
    const requestId = `github-ack-${crypto.randomUUID()}`;
    const calls: string[] = [];
    const api: GithubAcknowledgementApi = {
      deleteIssueReactionById: async (input) => {
        calls.push(`issue:${input.owner}/${input.repo}#${input.issueNumber}:${input.reactionId}`);
      },
      deleteIssueCommentReactionById: async (input) => {
        calls.push(`comment:${input.owner}/${input.repo}:${input.commentId}:${input.reactionId}`);
      },
    };

    try {
      const cleaned = await acknowledgementCleanup({ requestId, target, api });
      expect(cleaned.status).toBe("ok");
      expect(calls).toEqual([
        expectedKind === "issue" ? "issue:octo/repo#12:42" : "comment:octo/repo:55:42",
      ]);
      expect(getGithubAck(requestId)).toBeUndefined();
    } finally {
      clearGithubAck(requestId);
    }
  });

  it("treats a GitHub 404 deletion as completed cleanup", async () => {
    const requestId = `github-ack-404-${crypto.randomUUID()}`;
    const api: GithubAcknowledgementApi = {
      deleteIssueReactionById: async () => {
        throw new Error("GitHub API returned 404");
      },
      deleteIssueCommentReactionById: async () => undefined,
    };

    try {
      const cleaned = await acknowledgementCleanup({
        requestId,
        target: { kind: "issue", issueNumber: 12 },
        api,
      });
      expect(cleaned.status).toBe("ok");
      expect(getGithubAck(requestId)).toBeUndefined();
    } finally {
      clearGithubAck(requestId);
    }
  });

  it("returns a narrow failure without logging when deletion fails", async () => {
    const requestId = `github-ack-failure-${crypto.randomUUID()}`;
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    const api: GithubAcknowledgementApi = {
      deleteIssueReactionById: async () => {
        throw new Error("GitHub API unavailable");
      },
      deleteIssueCommentReactionById: async () => undefined,
    };

    try {
      const cleaned = await acknowledgementCleanup({
        requestId,
        target: { kind: "issue", issueNumber: 12 },
        api,
      });
      expect(cleaned.status).toBe("error");
      if (cleaned.status === "error") {
        expect(cleaned.error._tag).toBe("SurfaceIngressAcknowledgementCleanupFailed");
        expect(cleaned.error.cause).toMatchObject({
          errorTag: "GithubAcknowledgementDeleteFailed",
          errorMessage: "Failed to delete GitHub acknowledgement reaction",
        });
        expect(JSON.stringify(cleaned.error.cause)).not.toContain("GitHub API unavailable");
      }
      expect(getGithubAck(requestId)).toBeUndefined();
      expect(warning).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
      clearGithubAck(requestId);
    }
  });

  it("preserves Panic while still clearing acknowledgement state", async () => {
    const requestId = `github-ack-panic-${crypto.randomUUID()}`;
    const panic = new Panic({ message: "GitHub acknowledgement invariant failed" });
    const api: GithubAcknowledgementApi = {
      deleteIssueReactionById: async () => {
        throw panic;
      },
      deleteIssueCommentReactionById: async () => undefined,
    };

    try {
      await expect(
        acknowledgementCleanup({
          requestId,
          target: { kind: "issue", issueNumber: 12 },
          api,
        }),
      ).rejects.toBe(panic);
      expect(getGithubAck(requestId)).toBeUndefined();
    } finally {
      clearGithubAck(requestId);
    }
  });
});
