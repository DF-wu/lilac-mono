import { describe, expect, it } from "bun:test";
import type { DisplayMessage, DisplayPart } from "@stanley2058/lilac-client-protocol";
import { groupActivityMessages, groupParts } from "../src/components/Timeline";

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
