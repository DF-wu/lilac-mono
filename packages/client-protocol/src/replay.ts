import type { UIMessage } from "ai";
import { z } from "zod";

const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const MAX_REPLAY_SLOTS = 128;
export const MAX_REPLAY_TEXT_LENGTH = 65_536;
export const MAX_REPLAY_BATCH_BYTES = 262_144;
const encoder = new TextEncoder();
export const identitySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const replayCheckpointSchema = z.strictObject({
  protocolVersion: z.literal(1),
  historyGeneration: revisionSchema,
  projectionRevision: revisionSchema,
  cursor: identitySchema,
});

export const displayMessageSchema = z.strictObject({
  id: identitySchema,
  role: z.enum(["user", "assistant", "system"]),
  parts: z
    .array(
      z.strictObject({ type: z.literal("text"), text: z.string().max(MAX_REPLAY_TEXT_LENGTH) }),
    )
    .max(128),
}) satisfies z.ZodType<Pick<UIMessage, "id" | "role" | "parts">>;

export const readyTurnSlotSchema = z.strictObject({
  kind: z.literal("ready"),
  slotId: identitySchema,
  position: revisionSchema,
  turnId: identitySchema,
  messages: z.array(displayMessageSchema).max(128),
});

export const deferredTurnSlotSchema = z
  .strictObject({
    kind: z.literal("deferred"),
    slotId: identitySchema,
    position: revisionSchema,
    endPosition: revisionSchema,
  })
  .refine((slot) => slot.endPosition > slot.position, {
    message: "A deferred slot must cover at least one turn position",
  });

export const failedTurnSlotSchema = z
  .strictObject({
    kind: z.literal("failed"),
    slotId: identitySchema,
    position: revisionSchema,
    endPosition: revisionSchema,
    message: z.string().min(1).max(512),
    retryable: z.literal(true),
  })
  .refine((slot) => slot.endPosition > slot.position, {
    message: "A failed slot must retain its unresolved turn range",
  });

export const turnSlotSchema = z.discriminatedUnion("kind", [
  readyTurnSlotSchema,
  deferredTurnSlotSchema,
  failedTurnSlotSchema,
]);

export const replayReplySchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("unchanged"),
      checkpoint: replayCheckpointSchema,
    }),
    z.strictObject({
      kind: z.literal("window"),
      checkpoint: replayCheckpointSchema,
      slots: z.array(turnSlotSchema).max(MAX_REPLAY_SLOTS),
    }),
  ])
  .refine((reply) => encoder.encode(JSON.stringify(reply)).byteLength <= MAX_REPLAY_BATCH_BYTES, {
    message: "Replay reply exceeds the batch byte budget",
  });

export const hydrationSchema = z
  .strictObject({
    historyGeneration: revisionSchema,
    projectionRevision: revisionSchema,
    slotId: identitySchema,
    slots: z.array(turnSlotSchema).min(1).max(MAX_REPLAY_SLOTS),
  })
  .refine(
    (hydration) => encoder.encode(JSON.stringify(hydration)).byteLength <= MAX_REPLAY_BATCH_BYTES,
    {
      message: "Hydration exceeds the batch byte budget",
    },
  );

export const liveUpdateSchema = z
  .strictObject({
    checkpoint: replayCheckpointSchema,
    changes: z
      .array(
        z.discriminatedUnion("kind", [
          z.strictObject({
            kind: z.literal("insert"),
            slot: readyTurnSlotSchema,
          }),
          z.strictObject({
            kind: z.literal("append-text"),
            turnId: identitySchema,
            position: revisionSchema,
            messageId: identitySchema,
            partIndex: revisionSchema,
            text: z.string().max(MAX_REPLAY_TEXT_LENGTH),
          }),
          z.strictObject({
            kind: z.literal("remove"),
            turnId: identitySchema,
            position: revisionSchema,
          }),
        ]),
      )
      .max(128),
  })
  .refine((update) => encoder.encode(JSON.stringify(update)).byteLength <= MAX_REPLAY_BATCH_BYTES, {
    message: "Live update exceeds the batch byte budget",
  });

export type ReplayCheckpoint = z.infer<typeof replayCheckpointSchema>;
export type DisplayMessage = z.infer<typeof displayMessageSchema>;
export type ReadyTurnSlot = z.infer<typeof readyTurnSlotSchema>;
export type TurnSlot = z.infer<typeof turnSlotSchema>;
export type ReplayReply = z.infer<typeof replayReplySchema>;
export type Hydration = z.infer<typeof hydrationSchema>;
export type LiveUpdate = z.infer<typeof liveUpdateSchema>;
