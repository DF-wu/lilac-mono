import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_DM_TIMESTAMP_GAP_MS,
  type ReadyTurnSlot,
} from "@stanley2058/lilac-client-protocol";
import { joinMessageTurns, lastTurnMessageTime } from "../src/message-grouping";
import { agentWorkStages } from "../src/agent-work-fixtures";
import { Turn } from "../src/components/Timeline";
import { MessageServicesContext } from "../src/components/message-services";

const time = new Date(2026, 9, 19, 12).getTime();
function post(
  position: number,
  authorId = "lilac",
  role: "assistant" | "user" = "assistant",
): ReadyTurnSlot {
  return {
    kind: "ready",
    slotId: `slot-${position}`,
    turnId: `turn-${position}`,
    position,
    state: "complete",
    messages: [
      {
        id: `message-${position}`,
        role,
        metadata: { authorId, createdAt: time + position * 1000, phase: "final" },
        parts: [{ type: "text", text: `Post ${position}` }],
      },
    ],
  };
}

test("consecutive posts group by author and stop at context, time, and intervening authors", () => {
  expect(joinMessageTurns(post(0), post(1))).toBe(true);
  expect(joinMessageTurns(post(0, "owner", "user"), post(1, "owner", "user"))).toBe(true);
  expect(joinMessageTurns(post(0), post(1, "other"))).toBe(false);
  expect(joinMessageTurns(post(0), post(1, "owner", "user"))).toBe(false);
  expect(joinMessageTurns(post(0), post(1), 1)).toBe(false);
  expect(joinMessageTurns(post(0), post(1), undefined, 1000)).toBe(false);
  const later = post(1);
  later.messages[0]!.metadata!.createdAt = time + DEFAULT_DM_TIMESTAMP_GAP_MS;
  expect(joinMessageTurns(post(0), later)).toBe(false);
  expect(joinMessageTurns({ ...post(0), state: "running" }, post(1))).toBe(false);
  expect(joinMessageTurns(undefined, post(1))).toBe(false);
});

test("completed work and following posts share one avatar and leave controls on the last bubble", () => {
  const first = agentWorkStages.find((stage) => stage.id === "grouped-messages")!.frames[0]!;
  const second = first.following!;
  expect(joinMessageTurns(first, second)).toBe(true);
  const html = renderToStaticMarkup(
    <MessageServicesContext
      value={{ canEdit: true, resourceUrl: () => "", onAction: () => {}, onReaction: () => {} }}
    >
      <Turn slot={first} joinedAfter onRewind={() => {}} onLoadMore={() => {}} />
      <Turn slot={second} joinedBefore onRewind={() => {}} onLoadMore={() => {}} />
    </MessageServicesContext>,
  );
  expect(html.match(/data-slot="message-avatar"/g)).toHaveLength(1);
  expect(html.match(/data-ui="message-controls"/g)).toHaveLength(1);
  expect(html).toContain('data-ui="work-summary"');
  expect(html).toContain("The forecast is ready");
  expect(html).toContain("Bring a light jacket");
});

test("a post immediately after a long run uses the last message for both grouping and timestamps", () => {
  const first = post(0);
  first.messages.unshift({
    id: "prompt",
    role: "user",
    metadata: { authorId: "owner", createdAt: time - DEFAULT_DM_TIMESTAMP_GAP_MS },
    parts: [{ type: "text", text: "Long task" }],
  });
  const next = post(1);
  expect(lastTurnMessageTime(first)).toBe(time);
  expect(next.messages[0]!.metadata!.createdAt! - lastTurnMessageTime(first)!).toBeLessThan(
    DEFAULT_DM_TIMESTAMP_GAP_MS,
  );
  expect(joinMessageTurns(first, next)).toBe(true);
});

test("a completed incoming post joins the following bubble without its old bottom margin", () => {
  const first = post(0);
  first.messages[0]!.metadata = {
    ...first.messages[0]!.metadata,
    inputId: "surface-input",
    inputMode: "prompt",
  };
  const html = renderToStaticMarkup(
    <MessageServicesContext
      value={{ canEdit: true, resourceUrl: () => "", onAction: () => {}, onReaction: () => {} }}
    >
      <Turn slot={first} joinedAfter onRewind={() => {}} onLoadMore={() => {}} />
      <Turn slot={post(1)} joinedBefore onRewind={() => {}} onLoadMore={() => {}} />
    </MessageServicesContext>,
  );
  expect(html).not.toContain('class="mb-6"');
  expect(html.match(/data-slot="message-avatar"/g)).toHaveLength(1);
  expect(html.match(/data-ui="message-controls"/g)).toHaveLength(1);
});
