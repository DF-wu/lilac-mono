import { expect, it } from "bun:test";
import { LILAC_EVENTS } from "../lilac-spec";
import { nativeOutputEventSchema } from "../native-output";

it("uses a fixed native output topic with strict identity and fenced text payload", () => {
  const value = {
    threadId: "thread",
    turnId: "turn",
    generation: 0,
    requestId: "run",
    attemptId: "attempt",
    sequence: 1,
    ordinal: 1,
    eventId: "event",
    occurredAt: 1,
    payload: {
      type: "text",
      partId: "part",
      stepId: "step",
      position: 0,
      phase: "commentary",
      text: "hello",
      incomplete: false,
    },
  };
  expect(nativeOutputEventSchema.safeParse(value).success).toBe(true);
  expect(nativeOutputEventSchema.safeParse({ ...value, generation: -1 }).success).toBe(false);
  expect(nativeOutputEventSchema.safeParse({ ...value, sequence: 0 }).success).toBe(false);
  expect(nativeOutputEventSchema.safeParse({ ...value, hiddenPrompt: "private" }).success).toBe(
    false,
  );
  expect(LILAC_EVENTS.EvtNativeOutput.topic.kind).toBe("fixed");
  expect(LILAC_EVENTS.EvtNativeOutput.topic.topic).toBe("evt.native.output");
});
