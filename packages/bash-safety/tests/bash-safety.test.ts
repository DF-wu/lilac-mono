import { describe, expect, it } from "bun:test";

import { analyzeBashCommand } from "../src";

describe("analyzeBashCommand", () => {
  it("allows benign commands and workspace-contained cleanup", () => {
    const cwd = "/tmp/lilac-project";

    expect(analyzeBashCommand("git status", { cwd })).toBeNull();
    expect(analyzeBashCommand("rm -rf build", { cwd })).toBeNull();
    expect(analyzeBashCommand("rm -rf /tmp/lilac-cache", { cwd })).toBeNull();
  });

  it("blocks destructive commands and expansion-sensitive deletion", () => {
    const cwd = "/tmp/lilac-project";

    expect(analyzeBashCommand("git reset --hard", { cwd })).not.toBeNull();
    expect(analyzeBashCommand("rm -rf /", { cwd })).not.toBeNull();
    expect(analyzeBashCommand('rm -rf "$target"', { cwd })?.reason).toContain("dynamic target");
    expect(analyzeBashCommand("cd .. && rm -rf build", { cwd })).not.toBeNull();
  });

  it("analyzes nested static commands", () => {
    expect(analyzeBashCommand("bash -c 'git reset --hard'")).not.toBeNull();
    expect(analyzeBashCommand("find . -exec rm -rf {} \\;")).not.toBeNull();
    expect(analyzeBashCommand("xargs -I{} rm -rf {}")).not.toBeNull();
  });
});
