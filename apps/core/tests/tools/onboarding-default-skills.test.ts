import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import { Onboarding } from "../../src/tool-server/tools/onboarding";

describe("onboarding default skills", () => {
  let dataDir: string | undefined;

  afterEach(async () => {
    if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  it("seeds the MCP management skill without network access", async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-onboarding-skills-"));
    const result = z
      .object({
        ok: z.literal(true),
        steps: z.array(z.object({ id: z.string(), status: z.string() })),
      })
      .parse(
        await new Onboarding().call("onboarding.defaults", {
          dataDir,
          network: false,
        }),
      );
    const skillPath = path.join(dataDir, "skills", "mcp-management", "SKILL.md");

    expect(result.steps).toContainEqual({ id: "skills.mcp-management", status: "installed" });
    expect(await fs.readFile(skillPath, "utf8")).toContain("name: mcp-management");
  });

  it("reports each bundled skill failure outside a workspace in non-strict mode", async () => {
    const originalCwd = process.cwd();
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-onboarding-no-workspace-"));

    let result: unknown;
    try {
      process.chdir(dataDir);
      result = await new Onboarding().call("onboarding.defaults", {
        dataDir: path.join(dataDir, "data"),
        network: false,
      });
    } finally {
      process.chdir(originalCwd);
    }

    const parsed = z
      .object({
        ok: z.literal(true),
        steps: z.array(
          z.object({
            id: z.string(),
            status: z.string(),
            error: z.string().optional(),
          }),
        ),
      })
      .parse(result);
    const bundledSkillSteps = parsed.steps.filter((step) => step.id.startsWith("skills."));

    expect(bundledSkillSteps.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "skills.coding-agent", status: "failed" },
      { id: "skills.mcp-management", status: "failed" },
      { id: "skills.mcporter", status: "failed" },
      { id: "skills.gog", status: "failed" },
    ]);
    for (const step of bundledSkillSteps) {
      expect(step.error).toContain("Workspace root not found");
    }
  });
});
