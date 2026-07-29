import { describe, expect, it } from "bun:test";

import { Skills } from "../src/tool-server/tools/skills";

describe("tool-server skills", () => {
  it("declares concise positional inputs", async () => {
    const entries = await new Skills().list();

    expect(
      entries.map(({ callableId, primaryPositional }) => ({ callableId, primaryPositional })),
    ).toEqual([
      { callableId: "skills.list", primaryPositional: { field: "query" } },
      { callableId: "skills.brief", primaryPositional: { field: "name" } },
      { callableId: "skills.full", primaryPositional: { field: "name" } },
    ]);
  });
});
