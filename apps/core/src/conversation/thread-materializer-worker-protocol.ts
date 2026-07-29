import { z } from "zod";

export const threadMaterializerRepairKindSchema = z.enum(["content", "topology"]);

const workerRequestBaseSchema = z.object({
  id: z.string().min(1),
  searchDbPath: z.string().min(1),
  surfaceDbPath: z.string().min(1).optional(),
});

export const threadMaterializerWorkerRequestSchema = z.discriminatedUnion("type", [
  workerRequestBaseSchema.extend({ type: z.literal("list-channels") }),
  workerRequestBaseSchema.extend({
    type: z.literal("repair-channel"),
    channelId: z.string().min(1),
    kind: threadMaterializerRepairKindSchema,
    messageIds: z.array(z.string().min(1)).optional(),
  }),
]);

export type ThreadMaterializerWorkerRequest = z.infer<typeof threadMaterializerWorkerRequestSchema>;

export const threadMaterializerWorkerResponseSchema = z.union([
  z.object({
    id: z.string().min(1),
    ok: z.literal(true),
    type: z.literal("list-channels"),
    channelIds: z.array(z.string()),
  }),
  z.object({
    id: z.string().min(1),
    ok: z.literal(true),
    type: z.literal("repair-channel"),
  }),
  z.object({
    id: z.string().min(1),
    ok: z.literal(false),
    error: z.string(),
  }),
]);

export type ThreadMaterializerWorkerResponse = z.infer<
  typeof threadMaterializerWorkerResponseSchema
>;
