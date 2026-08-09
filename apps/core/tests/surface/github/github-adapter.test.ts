import { describe, expect, it } from "bun:test";

import { GithubAdapter } from "../../../src/surface/github/github-adapter";

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
