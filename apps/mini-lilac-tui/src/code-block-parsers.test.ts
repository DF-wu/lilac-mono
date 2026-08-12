import { describe, expect, it } from "bun:test";

import { registerCodeBlockParsers } from "./code-block-parsers";

describe("code block parsers", () => {
  it("can be registered repeatedly without duplicating application setup", () => {
    expect(() => {
      registerCodeBlockParsers();
      registerCodeBlockParsers();
    }).not.toThrow();
  });
});
