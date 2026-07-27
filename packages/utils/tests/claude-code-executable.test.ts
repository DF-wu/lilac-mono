import { describe, expect, it } from "bun:test";

import { claudeCodeExecutableSettings } from "../model-provider";

describe("claudeCodeExecutableSettings", () => {
  it("points the SDK at the resolved Claude installation", () => {
    expect(claudeCodeExecutableSettings(() => "/usr/local/bin/claude")).toEqual({
      pathToClaudeCodeExecutable: "/usr/local/bin/claude",
    });
  });

  it("stays empty when no claude is installed", () => {
    // The Agent SDK's own resolution and diagnostic must survive untouched
    // rather than being overridden with an empty path.
    expect(claudeCodeExecutableSettings(() => null)).toEqual({});
  });

  it("resolves from PATH by default", () => {
    const claudePath = Bun.which("claude");
    expect(claudeCodeExecutableSettings()).toEqual(
      claudePath === null ? {} : { pathToClaudeCodeExecutable: claudePath },
    );
  });
});
