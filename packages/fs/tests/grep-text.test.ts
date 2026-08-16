import { describe, expect, it } from "bun:test";

import { grepText } from "../src";

describe("grepText", () => {
  it("searches stdin and reports the virtual resource path", async () => {
    const result = await grepText({
      content: "first\nneedle here\nlast\n",
      reportedPath: "tool-result://resource",
      pattern: "needle",
      maxMatches: 10,
    });

    expect(result.status).toBe("ok");
    if (result.status === "error") throw result.error;
    expect(result.value).toMatchObject({
      truncated: false,
      matches: [
        {
          file: "tool-result://resource",
          line: 2,
          column: 1,
          text: "needle here\n",
        },
      ],
    });
  });

  it("terminates a large stdin search cleanly after the result limit", async () => {
    const result = await grepText({
      content: Array.from({ length: 20_000 }, (_, index) => `needle ${index}\n`).join(""),
      reportedPath: "tool-result://large",
      pattern: "needle",
      maxMatches: 2,
    });

    expect(result.status).toBe("ok");
    if (result.status === "error") throw result.error;
    expect(result.value.truncated).toBe(true);
    expect(result.value.matches).toHaveLength(2);
  });

  it("returns invalid regex failures", async () => {
    const result = await grepText({
      content: "content\n",
      reportedPath: "tool-result://resource",
      pattern: "[",
      regex: true,
    });

    expect(result.status).toBe("error");
  });
});
