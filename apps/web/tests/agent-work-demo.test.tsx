import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { readyTurnSlotSchema } from "@stanley2058/lilac-client-protocol";
import { agentWorkStages } from "../src/agent-work-fixtures";
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
