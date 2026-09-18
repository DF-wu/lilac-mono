import { z } from "zod";

const id = z.string().min(1);
const position = z.number().int().nonnegative();

export const nativeOutputFrontierSchema = z.strictObject({ ordinal: position, position });
export type NativeOutputFrontier = z.output<typeof nativeOutputFrontierSchema>;

export const nativeOutputPayloadSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("text"),
    partId: id,
    stepId: id,
    position,
    phase: z.enum(["commentary", "final_answer", "unspecified"]),
    text: z.string(),
    incomplete: z.boolean(),
  }),
  z.strictObject({
    type: z.literal("activity"),
    activityId: id,
    stepId: id,
    position,
    kind: z.enum(["thinking", "tool"]),
    state: z.enum(["start", "complete", "failed"]),
    label: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("compaction"),
    compactionId: id,
    position,
    state: z.enum(["start", "complete", "failed"]),
    beforeCount: position.optional(),
    afterCount: position.optional(),
    boundary: z.string().optional(),
  }),
  z.strictObject({
    type: z.literal("reset"),
    previousAttemptId: id,
    stepId: id.optional(),
    retainThroughOrdinal: position.optional(),
  }),
  z.strictObject({
    type: z.literal("terminal"),
    state: z.enum(["complete", "failed", "canceled"]),
  }),
]);

export const nativeOutputEventSchema = z.strictObject({
  threadId: id,
  turnId: id,
  generation: position,
  requestId: id,
  attemptId: id,
  sequence: z.number().int().positive(),
  ordinal: z.number().int().positive(),
  eventId: id,
  occurredAt: z.number().nonnegative(),
  payload: nativeOutputPayloadSchema,
});

export type NativeOutputPayload = z.output<typeof nativeOutputPayloadSchema>;
export type NativeOutputEvent = z.output<typeof nativeOutputEventSchema>;
