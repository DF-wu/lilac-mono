import { describe, expect, it } from "bun:test";

import {
  GithubAdapter,
  isGithubCommentAuthoredByActor,
} from "../../../src/surface/github/github-adapter";

describe("GitHub authoritative actor projection", () => {
  it("matches user and app identities without exposing raw protocol data", () => {
    expect(
      isGithubCommentAuthoredByActor(
        { user: { login: "Lilac-Bot", id: 12 } },
        { source: "user", login: "lilac-bot" },
      ),
    ).toBe(true);
    expect(
      isGithubCommentAuthoredByActor(
        { performed_via_github_app: { id: 91 } },
        { source: "app", appId: 91 },
      ),
    ).toBe(true);
  });

  it("uses the closed false fallback for malformed and future wire variants", () => {
    expect(
      isGithubCommentAuthoredByActor(
        { user: { login: ["future"], id: "12" }, extra: { hostile: true } },
        { source: "user", login: "lilac-bot" },
      ),
    ).toBe(false);
    expect(isGithubCommentAuthoredByActor(null, { source: "app", appId: 91 })).toBe(false);
  });
});

describe("GitHub adapter contract failures", () => {
  it("signals a typed host failure for a mismatched session platform", async () => {
    const adapter = new GithubAdapter();

    await expect(
      adapter.startOutput({ platform: "discord", channelId: "channel-1" }),
    ).rejects.toMatchObject({
      _tag: "GithubAdapterContractFailed",
      reason: "wrong-session-platform",
    });
  });

  it("rejects empty messages before invoking the GitHub SDK", async () => {
    const adapter = new GithubAdapter();

    await expect(
      adapter.sendMsg({ platform: "github", channelId: "owner/repo#1" }, { text: "   " }),
    ).rejects.toMatchObject({
      _tag: "GithubAdapterContractFailed",
      reason: "empty-message",
    });
  });
});
