import { describe, expect, it } from "bun:test";

import {
  MINI_LILAC_EXECUTABLE_TOOL_NAMES,
  MINI_LILAC_SYNTHETIC_TOOL_NAMES,
  MINI_LILAC_TOOL_NAMES,
} from "./tool-catalog";

describe("Mini Lilac tool catalog", () => {
  it("owns one unique canonical 14-name catalog", () => {
    expect(MINI_LILAC_TOOL_NAMES).toHaveLength(14);
    expect(new Set(MINI_LILAC_TOOL_NAMES).size).toBe(MINI_LILAC_TOOL_NAMES.length);
    expect(MINI_LILAC_EXECUTABLE_TOOL_NAMES).toHaveLength(13);
    expect(MINI_LILAC_SYNTHETIC_TOOL_NAMES).toEqual(["subagent_result"]);
    expect(new Set(MINI_LILAC_TOOL_NAMES)).toEqual(
      new Set([...MINI_LILAC_EXECUTABLE_TOOL_NAMES, ...MINI_LILAC_SYNTHETIC_TOOL_NAMES]),
    );
  });
});
