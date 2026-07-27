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

  it("blocks static protected-path access but does not claim process isolation", () => {
    const options = {
      cwd: "/data/workspace",
      protectedPaths: ["/data/secret"],
    };

    expect(analyzeBashCommand("cat /data/secret/mcp-oauth/docs.json", options)?.reason).toBe(
      "access to a configured protected path",
    );
    expect(analyzeBashCommand("cat ../secret/mcp-oauth/docs.json", options)).not.toBeNull();
    expect(
      analyzeBashCommand("printf nope > /data/secret/mcp-oauth/docs.json", options),
    ).not.toBeNull();
    expect(analyzeBashCommand('cat "$credential_path"', options)).toBeNull();
  });

  it("derives the reason from the protected path that matched", () => {
    const result = analyzeBashCommand("cat /srv/lilac/credentials/token.json", {
      cwd: "/srv/lilac/workspace",
      protectedPaths: ["/srv/other/private", "/srv/lilac/credentials"],
    });

    expect(result?.reason).toBe("access to a configured protected path");
  });
});
