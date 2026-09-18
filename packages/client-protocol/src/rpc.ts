import { eventIterator, oc } from "@orpc/contract";
import { z } from "zod";
import { identitySchema, replayCheckpointSchema, replayReplySchema } from "./replay.ts";

export const threadSyncInputSchema = z.strictObject({
  threadId: identitySchema,
  checkpoint: replayCheckpointSchema.optional(),
});

export const nativeSyncContract = {
  threads: {
    sync: oc.input(threadSyncInputSchema).output(replayReplySchema),
    watch: oc.input(threadSyncInputSchema).output(eventIterator(replayReplySchema)),
  },
};
