import { describe, expect, it } from "bun:test";
import crypto from "node:crypto";
import { Panic } from "better-result";

import {
  decodeGithubWebhookEvent,
  superviseGithubWebhookHandler,
  verifyGithubWebhookSignature,
} from "../../src/github/webhook/github-webhook-server";

describe("github webhook signature", () => {
  it("verifies sha256 signature", () => {
    const secret = "shh";
    const raw = new TextEncoder().encode(JSON.stringify({ hello: "world" }));
    const digest = crypto.createHmac("sha256", secret).update(raw).digest("hex");

    expect(
      verifyGithubWebhookSignature({
        secret,
        signature256: `sha256=${digest}`,
        rawBody: raw,
      }),
    ).toBe(true);
  });

  it("rejects invalid signature", () => {
    const secret = "shh";
    const raw = new TextEncoder().encode("x");
    expect(
      verifyGithubWebhookSignature({
        secret,
        signature256: "sha256=0000000000000000000000000000000000000000000000000000000000000000",
        rawBody: raw,
      }),
    ).toBe(false);
  });

  it("projects supported payloads and bounds malformed or hostile payloads", () => {
    expect(
      decodeGithubWebhookEvent("issue_comment", {
        action: "created",
        repository: { full_name: "owner/repo" },
        issue: { number: 7 },
        comment: { id: 9, body: "/lilac inspect", user: { login: "octocat" } },
        private_future_field: "ignored",
      }),
    ).toMatchObject({
      kind: "issue-comment-created",
      payload: { repository: { full_name: "owner/repo" }, issue: { number: 7 } },
    });
    expect(decodeGithubWebhookEvent("issue_comment", { action: "created" })).toEqual({
      kind: "unsupported",
      reason: "unsupported_event",
      action: "created",
    });

    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("private payload getter");
        },
      },
    );
    expect(decodeGithubWebhookEvent("issue_comment", hostile)).toEqual({
      kind: "unsupported",
      reason: "payload_invalid",
    });

    const panic = new Panic({ message: "webhook decoder invariant failed" });
    const panicPayload = new Proxy(
      {},
      {
        get() {
          throw panic;
        },
      },
    );
    expect(() => decodeGithubWebhookEvent("issue_comment", panicPayload)).toThrow(panic);
  });

  it("reports handler Panic to fatal supervision and preserves its identity", async () => {
    const panic = new Panic({ message: "webhook invariant failed" });
    const reported: Error[] = [];

    await expect(
      superviseGithubWebhookHandler({
        run: async () => {
          throw panic;
        },
        reportFatalError: (error) => reported.push(error),
      }),
    ).rejects.toBe(panic);
    expect(reported).toEqual([panic]);
  });
});
