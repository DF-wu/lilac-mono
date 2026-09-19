import { describe, expect, it } from "bun:test";
import type { DisplayMessage, DisplayPart } from "@stanley2058/lilac-client-protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Activity,
  ActivityItem,
  activitySummary,
  groupActivityMessages,
  groupParts,
} from "../src/components/Timeline";

function activity(id: string): DisplayMessage {
  return {
    id,
    role: "assistant",
    parts: [{ type: "data-activity", id, data: { kind: "tool", label: id, state: "complete" } }],
  };
}
describe("native conversation grouping", () => {
  it("folds adjacent work across published messages while commentary keeps separate blocks", () => {
    const commentary: DisplayMessage = {
      id: "commentary",
      role: "assistant",
      metadata: { phase: "commentary" },
      parts: [{ type: "text", text: "Checking the result." }],
    };
    const messages = [activity("tool1"), activity("tool2"), commentary, activity("tool3")];
    const grouped = groupActivityMessages(messages);
    expect(grouped).toHaveLength(3);
    expect(grouped[0]?.parts).toHaveLength(2);
    expect(grouped[1]).toBe(commentary);
    expect(grouped[2]?.parts).toHaveLength(1);
    expect(messages[0]?.parts).toHaveLength(1);
  });
  it("joins adjacent publication fragments before rendering Markdown", () => {
    const parts: DisplayPart[] = [
      { type: "text", text: "```ts\nconst x =" },
      { type: "text", text: " 1;\n```" },
      {
        type: "data-activity",
        id: "tool",
        data: { kind: "tool", label: "Checked", state: "complete" },
      },
      { type: "text", text: "Done." },
    ];
    expect(groupParts(parts)).toEqual([
      { kind: "text", text: "```ts\nconst x = 1;\n```" },
      {
        kind: "activity",
        parts: [
          {
            type: "data-activity",
            id: "tool",
            data: { kind: "tool", label: "Checked", state: "complete" },
          },
        ],
      },
      { kind: "text", text: "Done." },
    ]);
  });
});

describe("native turn activity disclosure", () => {
  const parts: Extract<DisplayPart, { type: "data-activity" }>[] = [
    {
      type: "data-activity",
      id: "thinking",
      data: { kind: "thinking", label: "Thinking", state: "complete", detail: "Reasoning detail" },
    },
    {
      type: "data-activity",
      id: "tool",
      data: {
        kind: "tool",
        label: "Searched the workspace",
        state: "complete",
        detail: "Tool result detail",
        durationMs: 2200,
      },
    },
  ];
  it("summarizes the work and keeps its rows collapsed on initial render", () => {
    const html = renderToStaticMarkup(createElement(Activity, { parts }));
    expect(html).toContain("Thought and used 1 tool");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Searched the workspace");
    expect(html).not.toContain("Reasoning detail");
    expect(html).not.toContain("Tool result detail");
    expect(html).not.toContain("activities");
  });
  it("keeps each tool result collapsed when its group becomes visible", () => {
    const html = renderToStaticMarkup(createElement(ActivityItem, { part: parts[1]! }));
    expect(html).toContain("Searched the workspace");
    expect(html).toContain("2s");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Tool result detail");
    expect(html).not.toContain(">complete<");
  });
  it("shows the current running label and preserves failures without a success badge", () => {
    const running = { ...parts[1]!, data: { ...parts[1]!.data, state: "running" as const } };
    expect(activitySummary([parts[0]!, running])).toBe("Searched the workspace");
    const failed = {
      ...parts[1]!,
      data: { ...parts[1]!.data, state: "failed" as const, detail: undefined },
    };
    const html = renderToStaticMarkup(createElement(ActivityItem, { part: failed }));
    expect(html).toContain("Failed");
    expect(html).not.toContain("<button");
  });
});
