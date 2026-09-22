import { mergeSubagentTranscript, type SubagentTranscriptPage } from "../src/queries";
import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { agentWorkStages, demoSubagents, demoSubagentTranscript } from "../src/agent-work-fixtures";
import { SubagentPanelView } from "../src/components/SubagentPanel";
import { SubagentContext } from "../src/components/subagent-context";
import { ActivityItem } from "../src/components/Timeline";
import { createPanelStore, defaultRightPanel } from "../src/panel-store";

const actions = { onSelect: () => {}, onBack: () => {} };
const slot = agentWorkStages.find((stage) => stage.id === "subagents-working")!.frames[0]!;
const agents = demoSubagents(slot);

test("agents panel starts closed and retains its selected transcript across close and reopen", () => {
  const store = createPanelStore();
  expect((store.getState().threads.get("thread") ?? defaultRightPanel).open).toBe(false);
  store.getState().select("thread", agents[0]!.id);
  expect((store.getState().threads.get("thread") ?? defaultRightPanel).open).toBe(true);
  store.getState().toggle("thread");
  expect(store.getState().selection).toEqual({ threadId: "thread", agentId: agents[0]!.id });
  store.getState().toggle("thread");
  expect((store.getState().threads.get("thread") ?? defaultRightPanel).open).toBe(true);
  store.getState().back();
  expect(store.getState().selection).toBeUndefined();
});

test("agent preview uses a bot and readable profile and work title, with no raw tool tree", () => {
  const agent = agents[0]!;
  const part = slot.messages
    .flatMap((message) => message.parts)
    .find((part) => part.type === "data-activity" && part.id === agent.activityId)!;
  if (part.type !== "data-activity") throw new Error("Missing agent activity");
  const html = renderToStaticMarkup(
    <SubagentContext value={{ agents: new Map([[agent.activityId, agent]]), open: () => {} }}>
      <ActivityItem part={part} />
    </SubagentContext>,
  );
  expect(html).toContain("lucide-bot");
  expect(html).toContain("Explore Agent");
  expect(html).toContain(agent.title);
  expect(html).not.toContain("subagent (explore;");
  expect(html).not.toMatch(/\sdisabled(?:=|\s|>)/);
  const unresolved = renderToStaticMarkup(<ActivityItem part={part} />);
  expect(unresolved).not.toMatch(/\sdisabled(?:=|\s|>)/);
});

test("shared panel shows agent status and production messages without editing controls", () => {
  for (const state of ["running", "complete"] as const) {
    const selected = {
      ...agents[0]!,
      state,
      title: state === "running" ? "Thinking…" : "Completed",
    };
    const messages = demoSubagentTranscript(selected);
    const html = renderToStaticMarkup(
      <SubagentPanelView items={agents} selected={selected} messages={messages} {...actions} />,
    );
    expect(html).toContain("Subagent transcript");
    expect(html).toContain("Read-only");
    expect(html).toContain(selected.title);
    for (const message of messages) expect(html).toContain(`data-message-id="${message.id}"`);
    expect(html).not.toContain('contenteditable="true"');
    expect(html).not.toContain("Rewind to this turn");
    expect(html).toContain("Copy message");
  }
  const empty = renderToStaticMarkup(<SubagentPanelView items={[]} {...actions} />);
  expect(empty).toContain("No subagents yet");
});

test("live refresh retains loaded tail messages and catches up without gaps after reopening", () => {
  const page = (offset: number, end: number, total = end): SubagentTranscriptPage => ({
    agent: agents[0]!,
    offset,
    total,
    unavailable: false,
    nextBefore: offset || undefined,
    messages: Array.from({ length: end - offset }, (_, i) => ({
      id: `message_${offset + i}`,
      role: "assistant",
      parts: [{ type: "text", text: String(offset + i) }],
    })),
  });
  const initial = page(80, 100);
  const update = mergeSubagentTranscript(initial, page(80, 120, 150));
  expect(update.messages).toHaveLength(40);
  expect(update.offset).toBe(80);
  expect(update.nextBefore).toBe(80);
  const caughtUp = mergeSubagentTranscript(update, page(100, 140, 150));
  const complete = mergeSubagentTranscript(caughtUp, page(120, 150));
  expect(complete.messages.map((message) => message.id)).toEqual(
    page(80, 150).messages.map((message) => message.id),
  );
  const older = page(60, 80).messages;
  expect([...older, ...complete.messages]).toHaveLength(90);
  expect(complete.total).toBe(150);
  const reset = mergeSubagentTranscript(complete, page(10, 30));
  expect(reset).toEqual(page(10, 30));
});
