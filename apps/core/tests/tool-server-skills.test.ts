import { describe, expect, it, spyOn } from "bun:test";
import fs from "node:fs/promises";
import { Panic } from "better-result";

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

  it("returns semantic usage failures for invalid input", async () => {
    expect(await new Skills().call("skills.list", { limit: 0 })).toMatchObject({
      status: "error",
      error: { kind: "usage", code: "invalid_input", retryable: false },
    });
  });

  it("preserves Panic from skill discovery", async () => {
    const panic = new Panic({ message: "skill discovery invariant failed" });
    const access = spyOn(fs, "access").mockRejectedValue(panic);
    try {
      const [settled] = await Promise.allSettled([new Skills().call("skills.list", {})]);

      expect(settled?.status).toBe("rejected");
      if (settled?.status === "rejected") expect(Panic.is(settled.reason)).toBe(true);
    } finally {
      access.mockRestore();
    }
  });

  it("preserves Panic from skill file reads", async () => {
    const panic = new Panic({ message: "skill file invariant failed" });
    const file = spyOn(Bun, "file").mockImplementation(() => {
      throw panic;
    });
    try {
      const [settled] = await Promise.allSettled([
        new Skills().call("skills.brief", { name: "coding-agent" }),
      ]);

      expect(settled?.status).toBe("rejected");
      if (settled?.status === "rejected") expect(Panic.is(settled.reason)).toBe(true);
    } finally {
      file.mockRestore();
    }
  });

  it("preserves Panic from skill resource listing", async () => {
    const panic = new Panic({ message: "skill resource invariant failed" });
    const readdir = spyOn(fs, "readdir").mockRejectedValueOnce(panic);
    try {
      const [settled] = await Promise.allSettled([
        new Skills().call("skills.full", { name: "coding-agent" }),
      ]);

      expect(settled?.status).toBe("rejected");
      if (settled?.status === "rejected") expect(Panic.is(settled.reason)).toBe(true);
    } finally {
      readdir.mockRestore();
    }
  });
});
