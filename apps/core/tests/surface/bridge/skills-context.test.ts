import { expect, test } from "bun:test";
import { maybeBuildSkillsSectionForPrimary } from "../../../src/surface/bridge/bus-agent-runner/skills-context";

test("the skills index lists surface-scoped skills only for their clients", async () => {
  expect(await maybeBuildSkillsSectionForPrimary("native")).toContain("- visualize: ");
  const discord = await maybeBuildSkillsSectionForPrimary("discord");
  expect(discord).not.toContain("- visualize: ");
  expect(discord).toContain("- coding-agent: ");
});

test("delegated skill indexes use their authenticated originating surface", async () => {
  expect(await maybeBuildSkillsSectionForPrimary("unknown", "native")).toContain("- visualize: ");
  for (const origin of ["discord", undefined]) {
    const section = await maybeBuildSkillsSectionForPrimary("unknown", origin);
    expect(section).not.toContain("- visualize: ");
    expect(section).toContain("- coding-agent: ");
  }
});
