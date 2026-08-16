import { describe, expect, it } from "bun:test";

import {
  MINI_LILAC_EXECUTABLE_TOOL_NAMES,
  MINI_LILAC_SYNTHETIC_TOOL_NAMES,
  MINI_LILAC_TOOL_NAMES,
  normalizeMiniLilacToolName,
} from "./tool-catalog";

describe("Mini Lilac tool catalog", () => {
  it("owns one unique canonical catalog", () => {
    expect(new Set(MINI_LILAC_TOOL_NAMES).size).toBe(MINI_LILAC_TOOL_NAMES.length);
    expect(new Set(MINI_LILAC_TOOL_NAMES)).toEqual(
      new Set([...MINI_LILAC_EXECUTABLE_TOOL_NAMES, ...MINI_LILAC_SYNTHETIC_TOOL_NAMES]),
    );
    expect(MINI_LILAC_EXECUTABLE_TOOL_NAMES).toEqual(
      expect.arrayContaining(["read", "edit", "patch"]),
    );
    expect(MINI_LILAC_EXECUTABLE_TOOL_NAMES).not.toEqual(
      expect.arrayContaining(["read_file", "edit_file", "apply_patch"]),
    );
  });

  it("normalizes legacy tool names without adding them to the catalog", () => {
    expect(normalizeMiniLilacToolName("read_file")).toBe("read");
    expect(normalizeMiniLilacToolName("edit_file")).toBe("edit");
    expect(normalizeMiniLilacToolName("apply_patch")).toBe("patch");
  });
});
