import { describe, expect, it } from "bun:test";
import type { DisplayPart } from "@stanley2058/lilac-client-protocol";
import {
  activityGroupSummary,
  activityRowTitle,
  commandProgramName,
  flattenMarkdown,
  formatDuration,
  liveActivityLabel,
} from "../src/activity-presentation";

type ActivityPart = Extract<DisplayPart, { type: "data-activity" }>;
function tool(label: string): ActivityPart {
  return {
    type: "data-activity",
    id: label.replace(/\W/g, "_"),
    data: { kind: "tool", label, state: "complete" },
  };
}

describe("activity presentation", () => {
  it("counts distinct edited files", () => {
    expect(activityGroupSummary([tool("edit a.ts"), tool("edit a.ts")])).toBe("Changed 1 file");
    expect(activityGroupSummary([tool("patch a.ts (+2)"), tool("edit b.ts")])).toBe(
      "Changed 4 files",
    );
  });
  it("counts every distinct path when edit details list them", () => {
    const edit = (label: string, detail: string): ActivityPart => ({
      ...tool(label),
      id: detail.replace(/\W/g, "_"),
      data: { kind: "tool", label, detail, state: "complete" },
    });
    expect(
      activityGroupSummary([
        edit("edit a.ts", "edit a.ts"),
        edit("apply_patch a.ts (+2)", "apply_patch a.ts\nb.ts\nc.ts"),
      ]),
    ).toBe("Changed 3 files");
    expect(
      activityGroupSummary([
        edit("apply_patch a.ts (+2)", "apply_patch a.ts\nb.ts\nc.ts"),
        edit("edit b.ts", "edit b.ts"),
      ]),
    ).toBe("Changed 3 files");
  });
  it("falls back to label counts for stored parts whose detail repeats the label", () => {
    const stored = (label: string): ActivityPart => ({
      ...tool(label),
      data: { kind: "tool", label, detail: label, state: "complete" },
    });
    expect(activityGroupSummary([stored("apply_patch a.ts (+2)"), stored("edit b.ts")])).toBe(
      "Changed 4 files",
    );
  });
  it("keeps compound commands that only start with a shell wrapper", () => {
    expect(activityRowTitle(tool("bash bash -lc 'echo one' && printf 'two'"))).toBe(
      "bash -lc 'echo one' && printf 'two'",
    );
    expect(activityRowTitle(tool("bash sh -c 'echo one'"))).toBe("echo one");
  });
  it("unwraps shell wrappers in titles and live labels", () => {
    const part = tool('bash /bin/bash -lc "bun test"');
    expect(activityRowTitle(part)).toBe("bun test");
    expect(liveActivityLabel(part)).toBe("Running bun");
  });
  it("summarizes the two most significant categories and counts the rest", () => {
    expect(activityGroupSummary([tool("bash ls"), tool("bash pwd")])).toBe("Ran 2 commands");
    expect(activityGroupSummary([tool("bash ls"), tool("weather.lookup {}")])).toBe(
      "Ran 1 command and used 1 tool",
    );
    expect(
      activityGroupSummary([tool("read a.md"), tool("bash ls"), tool("grep x"), tool("x.y")]),
    ).toBe("Read 1 file, ran 1 command, and performed 2 other actions");
  });
  it("does not count reasoning as an action", () => {
    const thought: ActivityPart = {
      type: "data-activity",
      id: "t",
      data: { kind: "thinking", label: "Thinking", state: "complete", detail: "**Plan** next" },
    };
    expect(activityGroupSummary([thought, tool("edit a.ts")])).toBe("Changed 1 file");
    expect(activityGroupSummary([thought, thought])).toBe("Thought (×2)");
    expect(activityRowTitle(thought)).toBe("Plan next");
  });
  it("titles commands by the command and live commands by the program", () => {
    const part = tool("bash @sd:~/repo FOO=1 /usr/local/bin/search.sh --since 1d");
    expect(activityRowTitle(part)).toBe("@sd:~/repo FOO=1 /usr/local/bin/search.sh --since 1d");
    expect(liveActivityLabel(part)).toBe("Running search.sh");
    expect(commandProgramName("cd apps/web && bun test")).toBe("bun");
  });
  it("flattens markdown and formats durations", () => {
    expect(flattenMarkdown("## Title\n\n- `code` and [link](http://x)")).toBe(
      "Title code and link",
    );
    expect(formatDuration(12_400)).toBe("12s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(3_720_000)).toBe("1h 2m");
  });
});
