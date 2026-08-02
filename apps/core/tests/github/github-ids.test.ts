import { describe, expect, it } from "bun:test";

import { githubMessageUrl } from "../../src/github/github-ids";

describe("githubMessageUrl", () => {
  it("links an issue comment from its session and message ids", () => {
    expect(
      githubMessageUrl({
        sessionId: "DF-wu/lilac-mono#47",
        messageId: "5124469595",
      }),
    ).toBe("https://github.com/DF-wu/lilac-mono/issues/47#issuecomment-5124469595");
  });

  it("links an issue or pull request body by its database id", () => {
    expect(
      githubMessageUrl({
        sessionId: "DF-wu/lilac-mono#47",
        messageId: "47",
        issueId: 5014377739,
      }),
    ).toBe("https://github.com/DF-wu/lilac-mono/issues/47#issue-5014377739");
  });

  it("falls back to the thread URL when an issue database id is unavailable", () => {
    expect(
      githubMessageUrl({
        sessionId: "DF-wu/lilac-mono#47",
        messageId: "47",
      }),
    ).toBe("https://github.com/DF-wu/lilac-mono/issues/47");
  });
});
