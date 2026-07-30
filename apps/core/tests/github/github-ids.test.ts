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

  it("links the issue or pull request when the message id is the thread number", () => {
    expect(
      githubMessageUrl({
        sessionId: "DF-wu/lilac-mono#47",
        messageId: "47",
      }),
    ).toBe("https://github.com/DF-wu/lilac-mono/issues/47");
  });
});
