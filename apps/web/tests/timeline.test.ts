import { describe, expect, it } from "bun:test";
import type { DisplayMessage, DisplayPart } from "@stanley2058/lilac-client-protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Message,
  groupActivityMessages,
  groupParts,
  messageArrivalIds,
} from "../src/components/Timeline";
import {
  Activity,
  ActivityItem,
  LiveTailContext,
  RequestActiveContext,
} from "../src/components/ActivityLog";

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
        label: "bash ls -la",
        state: "complete",
        detail: "bash ls -la",
        output: "total 0",
        exitCode: 0,
        durationMs: 2200,
      },
    },
  ];
  it("summarizes several activities and keeps the group collapsed on initial render", () => {
    const html = renderToStaticMarkup(createElement(Activity, { parts }));
    expect(html).toContain("Ran 1 command");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Reasoning detail");
    expect(html).not.toContain("total 0");
  });
  it("renders a single visible activity as its own row", () => {
    const empty = { ...parts[0]!, data: { ...parts[0]!.data, detail: undefined } };
    const html = renderToStaticMarkup(createElement(Activity, { parts: [empty, parts[1]!] }));
    expect(html).toContain("ls -la");
    expect(html).not.toContain("Ran 1 command");
    expect(html).not.toContain("Thought");
  });
  it("keeps each command result collapsed", () => {
    const html = renderToStaticMarkup(createElement(ActivityItem, { part: parts[1]! }));
    expect(html).toContain("ls -la");
    expect(html).not.toContain("bash ls");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Process exited");
  });
  it("shows a running command by its program name", () => {
    const running = {
      ...parts[1]!,
      data: {
        ...parts[1]!.data,
        label: "bash cd /tmp && ./search.sh --since 1d",
        detail: "bash cd /tmp && ./search.sh --since 1d",
        state: "running" as const,
      },
    };
    const html = renderToStaticMarkup(createElement(Activity, { parts: [parts[0]!, running] }));
    expect(html).toContain("Running search.sh");
    expect(html).toContain("working-text");
  });
  it("keeps the Thinking fallback when a settled subagent ends a running turn", () => {
    const agent: (typeof parts)[number] = {
      type: "data-activity",
      id: "agent",
      data: { kind: "tool", label: "subagent (explore) Check hours", state: "complete" },
    };
    const html = renderToStaticMarkup(
      createElement(
        RequestActiveContext,
        { value: true },
        createElement(
          LiveTailContext,
          { value: "agent" },
          createElement(Activity, { parts: [parts[1]!, agent] }),
        ),
      ),
    );
    expect(html).toContain(
      '>Thinking<span aria-hidden="true" class="working-text-shine">Thinking</span>',
    );
  });
  it("marks failures on the icon without a badge", () => {
    const failed = {
      ...parts[1]!,
      data: {
        ...parts[1]!.data,
        state: "failed" as const,
        detail: undefined,
        output: undefined,
        exitCode: undefined,
      },
    };
    const html = renderToStaticMarkup(createElement(ActivityItem, { part: failed }));
    expect(html).toContain("text-danger");
    expect(html).not.toContain("<button");
  });
});

describe("streaming block arrivals", () => {
  it("does not consume an empty placeholder before its first streamed text", () => {
    const message: DisplayMessage = {
      id: "stream",
      role: "assistant",
      parts: [{ type: "text", text: "" }],
    };
    expect(messageArrivalIds(message)).toEqual([]);
    message.parts[0] = { type: "text", text: "First token" };
    expect(messageArrivalIds(message)).toEqual(["stream:content:0"]);
  });
  it("keeps text tokens stable while identifying appended blocks", () => {
    const message: DisplayMessage = {
      id: "stream",
      role: "assistant",
      parts: [{ type: "text", text: "First" }],
    };
    const original = messageArrivalIds(message);
    message.parts[0] = { type: "text", text: "First block with more tokens" };
    expect(messageArrivalIds(message)).toEqual(original);
    message.parts.push(...activity("tool").parts, { type: "text", text: "Second block" });
    expect(messageArrivalIds(message)).toEqual([
      "stream:content:0",
      "activity:tool",
      "activity-item:tool",
      "stream:content:2",
    ]);
  });

  it("retains unique tool identities when adjacent work messages are grouped", () => {
    const grouped = groupActivityMessages([activity("first"), activity("second")]);
    expect(grouped.flatMap(messageArrivalIds)).toEqual([
      "activity:first",
      "activity-item:first",
      "activity:second",
      "activity-item:second",
    ]);
  });
});

it("caps user message previews before layout measurement without clamping assistant responses", () => {
  const render = (role: "user" | "assistant") =>
    renderToStaticMarkup(
      createElement(Message, {
        message: {
          id: "long",
          role,
          parts: [{ type: "text", text: "A long paragraph.\n\n".repeat(100) }],
        },
        canEdit: false,
        resourceUrl: (id) => id,
        onAction: () => {},
        onReaction: () => {},
      }),
    );
  expect(render("user")).toContain('data-collapsed="true"');
  expect(render("assistant")).toContain('data-collapsed="false"');
});

it("omits batch wrappers without losing their child tool calls", () => {
  const grouped = groupActivityMessages([activity("bash"), activity("batch"), activity("glob")]);
  expect(grouped).toHaveLength(1);
  expect(
    grouped[0]!.parts.map((part) => (part.type === "data-activity" ? part.data.label : "")),
  ).toEqual(["bash", "glob"]);
});
