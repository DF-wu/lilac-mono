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
  expect(html.match(/class="message-controls"/gu)).toHaveLength(1);
  expect(html).toContain('data-message-id="demo_introduction"');
  expect(html).toContain('data-message-id="demo_commentary"');
});

test("steering stays in order and starts a fresh agent group for each participant", () => {
  const html = renderStage("steering-other");
  expect(html.match(/aria-label="About Lilac"/gu)).toHaveLength(3);
  expect(html.match(/class="message-controls"/gu)).toHaveLength(3);
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
  expect(html.match(/class="message-controls"/gu)).toHaveLength(2);
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
  expect(renderStage("streaming").match(/class="message-controls"/gu)).toHaveLength(1);
  expect(renderStage("complete").match(/class="message-controls"/gu)).toHaveLength(2);
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
  expect(html.match(/class="message-controls"/gu)).toHaveLength(2);
});
