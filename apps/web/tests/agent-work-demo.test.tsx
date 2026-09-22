import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { readyTurnSlotSchema, type ReadyTurnSlot } from "@stanley2058/lilac-client-protocol";
import { agentWorkStages } from "../src/agent-work-fixtures";
import { MessageIdentityContext } from "../src/components/message-identity";
import { Turn } from "../src/components/Timeline";
import { MessageServicesContext } from "../src/components/message-services";

test("every demo frame is a valid native turn rendered by the production turn component", () => {
  for (const stage of agentWorkStages) {
    expect(stage.frames.length).toBeGreaterThan(0);
    for (const slot of stage.frames) expect(readyTurnSlotSchema.safeParse(slot).success).toBe(true);
    const html = renderToStaticMarkup(
      <MessageServicesContext
        value={{ canEdit: false, resourceUrl: () => "", onAction: () => {}, onReaction: () => {} }}
      >
        <Turn slot={stage.frames[0]!} onRewind={() => {}} onLoadMore={() => {}} />
      </MessageServicesContext>,
    );
    expect(html).toContain('data-turn-id="demo_turn"');
    if (stage.id === "complete" || stage.id === "failed" || stage.id === "canceled")
      expect(html).toContain("Worked for 12s");
  }
});

test("streaming frames preserve message identity and grow into the completed answer", () => {
  const streaming = agentWorkStages.find((stage) => stage.id === "streaming")!;
  const complete = agentWorkStages.find((stage) => stage.id === "complete")!.frames[0]!;
  const final = complete.messages.find((message) => message.metadata?.phase === "final")!;
  const fullText = final.parts.find((part) => part.type === "text")!.text;
  let previous = "";
  for (const slot of streaming.frames) {
    const message = slot.messages.find((entry) => entry.metadata?.phase === "final")!;
    const text = message.parts.find((part) => part.type === "text")!.text;
    expect(message.id).toBe(final.id);
    expect(text.startsWith(previous)).toBe(true);
    expect(fullText.startsWith(text)).toBe(true);
    expect(message.metadata?.incomplete).toBe(true);
    previous = text;
  }
  expect(previous).toBe(fullText);
});

function renderStage(id: string, override?: ReadyTurnSlot) {
  const slot = override ?? agentWorkStages.find((stage) => stage.id === id)!.frames[0]!;
  return renderToStaticMarkup(
    <MessageIdentityContext
      value={{
        viewerId: "demo_user",
        agent: { displayName: "Lilac" },
        users: new Map([
          ["demo_user", { displayName: "Alex Chen" }],
          ["demo_other_user", { displayName: "Morgan Lee" }],
        ]),
      }}
    >
      <MessageServicesContext
        value={{ canEdit: true, resourceUrl: () => "", onAction: () => {}, onReaction: () => {} }}
      >
        <Turn slot={slot} onRewind={() => {}} onLoadMore={() => {}} />
      </MessageServicesContext>
    </MessageIdentityContext>,
  );
}

test("live commentary shares one agent avatar and has no message action rows", () => {
  const html = renderStage("full-turn-working");
  expect(html.match(/aria-label="About Lilac"/gu)).toHaveLength(1);
  expect(html.match(/data-ui="message-controls"/gu)).toHaveLength(1);
  expect(html).toContain('data-message-id="demo_introduction"');
  expect(html).toContain('data-message-id="demo_commentary"');
});

test("steering stays in order and starts a fresh agent group for each participant", () => {
  const html = renderStage("steering-other");
  expect(html.match(/aria-label="About Lilac"/gu)).toHaveLength(3);
  expect(html.match(/data-ui="message-controls"/gu)).toHaveLength(3);
  expect(html).toContain('aria-label="About Morgan Lee"');
  const ids = [
    "demo_introduction",
    "demo_first_work",
    "demo_own_steer",
    "demo_steer_thought",
    "demo_steer_commentary",
    "demo_steer_work",
    "demo_other_steer",
    "demo_cafe_thought",
    "demo_cafe_commentary",
  ];
  for (let index = 1; index < ids.length; index++)
    expect(html.indexOf(`data-message-id="${ids[index - 1]}"`)).toBeLessThan(
      html.indexOf(`data-message-id="${ids[index]}"`),
    );
  expect(html).toMatch(/data-align="end"[^>]+data-message-id="demo_own_steer"/u);
  expect(html).toMatch(/data-align="start"[^>]+data-message-id="demo_other_steer"/u);
});

test("completed turns collapse steering and work under the avatar above the final answer", () => {
  const html = renderStage("steering-complete");
  expect(html.match(/aria-label="About Lilac"/gu)).toHaveLength(1);
  expect(html.match(/data-ui="message-controls"/gu)).toHaveLength(2);
  expect(html).not.toContain('data-message-id="demo_own_steer"');
  expect(html).not.toContain('data-message-id="demo_other_steer"');
  expect(html).not.toContain('data-message-id="demo_introduction"');
  expect(html).toContain('data-message-id="demo_steered_final"');
  expect(html.indexOf('aria-label="About Lilac"')).toBeLessThan(html.indexOf("Worked for 4m"));
  expect(html.indexOf("Worked for 4m")).toBeLessThan(
    html.indexOf('data-message-id="demo_steered_final"'),
  );
});

test("streaming answers have no action row until the turn settles", () => {
  expect(renderStage("streaming").match(/data-ui="message-controls"/gu)).toHaveLength(1);
  expect(renderStage("complete").match(/data-ui="message-controls"/gu)).toHaveLength(2);
});

test("subagents retain activity identity as results arrive and settle under the parent", () => {
  const stages = ["subagents-working", "subagents-results", "subagents-complete"];
  const expectedStates: ("running" | "complete")[][] = [
    ["running", "running"],
    ["complete", "running"],
    ["complete", "complete"],
  ];
  let previousIds: string[] = [];
  for (const [index, id] of stages.entries()) {
    const slot = agentWorkStages.find((stage) => stage.id === id)!.frames[0]!;
    const ids = slot.messages.map((message) => message.id);
    expect(ids.slice(0, previousIds.length)).toEqual(previousIds);
    previousIds = ids;
    const activities = slot.messages
      .filter((message) => ["demo_subagent_weather", "demo_subagent_museum"].includes(message.id))
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "data-activity");
    expect(activities.map((part) => part.id)).toEqual([
      "demo_subagent_weather",
      "demo_subagent_museum",
    ]);
    expect(activities.map((part) => part.data.state)).toEqual(expectedStates[index]!);
    for (const part of activities) {
      expect(part.data.kind).toBe("tool");
      expect(part.data.detail).toBeUndefined();
      expect(part.data.label.length).toBeLessThanOrEqual(256);
    }
    const html = renderStage(id);
    expect(html.match(/aria-label="About Lilac"/gu)).toHaveLength(1);
    expect(html).not.toContain('data-ui="work-participation"');
    if (slot.state === "complete") {
      expect(html).toContain("Worked for 1m");
      expect(html).toContain('data-message-id="demo_final"');
      expect(html).not.toContain('data-message-id="demo_subagent_weather"');
      expect(html.match(/data-ui="message-controls"/gu)).toHaveLength(2);
      continue;
    }
    expect(html).toContain("Used 1 tool and spawned 2 agents");
    expect(html).not.toContain('data-message-id="demo_final"');
    expect(html.match(/data-ui="message-controls"/gu)).toHaveLength(1);
  }
});

test("an earlier final answer becomes intermediate when steering continues the turn", () => {
  const original = agentWorkStages.find((stage) => stage.id === "steering-complete")!.frames[0]!;
  const messages = [...original.messages];
  const index = messages.findIndex((message) => message.id === "demo_own_steer");
  messages.splice(index, 0, {
    id: "earlier_answer",
    role: "assistant",
    metadata: { phase: "final" },
    parts: [{ type: "text", text: "An earlier answer before steering." }],
  });
  const html = renderStage("steering-complete", { ...original, messages });
  expect(html).not.toContain("An earlier answer before steering.");
  expect(html).toContain('data-message-id="demo_steered_final"');
  expect(html.match(/data-ui="message-controls"/gu)).toHaveLength(2);
});

test("the settled work summary lists distinct participating users without the agent", () => {
  const html = renderStage("steering-complete");
  const summary = html.slice(
    html.indexOf('data-ui="work-participation"'),
    html.indexOf('data-ui="expanded-work"') > 0
      ? html.indexOf('data-ui="expanded-work"')
      : html.indexOf('data-message-id="demo_steered_final"'),
  );
  expect(summary).toContain(">with</span>");
  expect(summary.match(/data-ui="work-participant"/gu)).toHaveLength(2);
  expect(summary).toContain('aria-label="Alex Chen"');
  expect(summary).toContain('aria-label="Morgan Lee"');
  expect(summary).not.toContain('aria-label="Lilac"');
});

test("one participant is omitted even when they steer repeatedly", () => {
  const original = agentWorkStages.find((stage) => stage.id === "steering-complete")!.frames[0]!;
  const messages = original.messages.map((message) =>
    message.role === "user"
      ? { ...message, metadata: { ...message.metadata, authorId: "demo_user" } }
      : message,
  );
  const html = renderStage("steering-complete", { ...original, messages });
  expect(html).not.toContain('data-ui="work-participation"');
  expect(html).toContain("Worked for 4m");
  expect(renderStage("complete")).not.toContain('data-ui="work-participation"');
});

test("rewind stays between time and copy and is disabled for an active agent", () => {
  const slot = agentWorkStages.find((stage) => stage.id === "complete")!.frames[0]!;
  for (const rewindDisabled of [false, true]) {
    const html = renderToStaticMarkup(
      <MessageIdentityContext
        value={{ viewerId: "demo_user", agent: { displayName: "Lilac" }, users: new Map() }}
      >
        <MessageServicesContext
          value={{
            canEdit: true,
            rewindDisabled,
            resourceUrl: () => "",
            onAction: () => {},
            onReaction: () => {},
          }}
        >
          <Turn slot={slot} onRewind={() => {}} onLoadMore={() => {}} />
        </MessageServicesContext>
      </MessageIdentityContext>,
    );
    const controls = html.slice(html.indexOf('data-ui="message-controls"'));
    expect(controls.indexOf("<time")).toBeLessThan(
      controls.indexOf('aria-label="Rewind to this turn"'),
    );
    expect(controls.indexOf('aria-label="Rewind to this turn"')).toBeLessThan(
      controls.indexOf('aria-label="Copy message"'),
    );
    const rewind = controls.match(/<button[^>]*aria-label="Rewind to this turn"[^>]*>/)?.[0];
    expect(rewind).toBeDefined();
    expect(/\sdisabled(?:=|\s|>)/.test(rewind!)).toBe(rewindDisabled);
  }
});

test("a sent prompt immediately shows thinking and suppresses the queue marker", () => {
  const html = renderStage("sent");
  expect(html).toContain("activity-summary");
  expect(html).toContain("animate-spin");
  expect(html).toContain("working-text");
  expect(html).toContain('aria-expanded="false"');
  expect(html).toContain("Thinking…");
  expect(html).not.toContain(">queued<");
  expect(html.match(/aria-label="About Lilac"/gu)).toHaveLength(1);
});

test("work duration uses the prompt timestamp for older turns without a start timestamp", () => {
  const complete = agentWorkStages.find((stage) => stage.id === "complete")!.frames[0]!;
  expect(renderStage("complete", { ...complete, startedAt: undefined })).toContain(
    "Worked for 12s",
  );
});
