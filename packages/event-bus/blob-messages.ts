import {
  blobHandleV1Schema,
  blobRefV1Schema,
  type BlobHandleV1,
  type BlobRefV1,
} from "@stanley2058/lilac-blob-storage";
import { z } from "zod";

const nonemptyStringSchema = z.string().min(1);
const providerOptionsSchema = z.record(z.string(), z.record(z.string(), z.json()));
const resourceUriV1Schema = z.string().regex(/^resource:\/\/r1_[0-9a-f]{32}$/u);

const textPartSchema = z.strictObject({
  type: z.literal("text"),
  text: z.string(),
  providerOptions: providerOptionsSchema.optional(),
});

const reasoningPartSchema = z.strictObject({
  type: z.literal("reasoning"),
  text: z.string(),
  providerOptions: providerOptionsSchema.optional(),
});

const customPartSchema = z.strictObject({
  type: z.literal("custom"),
  kind: nonemptyStringSchema,
  providerOptions: providerOptionsSchema.optional(),
});

/** Stable capability reference for one retained Core ingress resource. */
export const storedResourcePartV1Schema = z.strictObject({
  type: z.literal("resource"),
  uri: resourceUriV1Schema,
  filename: z.string().optional(),
  mediaType: nonemptyStringSchema.optional(),
  size: z.number().int().nonnegative().optional(),
});

export type StoredResourcePartV1 = z.output<typeof storedResourcePartV1Schema>;

/** Byte-free resource part accepted on the current Redis request wire. */
export const busResourcePartV1Schema = storedResourcePartV1Schema;
export type BusResourcePartV1 = StoredResourcePartV1;

const toolCallPartSchema = z.strictObject({
  type: z.literal("tool-call"),
  toolCallId: nonemptyStringSchema,
  toolName: nonemptyStringSchema,
  input: z.json(),
  providerOptions: providerOptionsSchema.optional(),
  providerExecuted: z.boolean().optional(),
});

const toolApprovalRequestSchema = z.strictObject({
  type: z.literal("tool-approval-request"),
  approvalId: nonemptyStringSchema,
  toolCallId: nonemptyStringSchema,
});

const toolApprovalResponseSchema = z.strictObject({
  type: z.literal("tool-approval-response"),
  approvalId: nonemptyStringSchema,
  approved: z.boolean(),
  reason: z.string().optional(),
});

function createBlobMessageSchemas<TBlob>(blobSchema: z.ZodType<TBlob>) {
  const blobPartSchema = z.strictObject({
    type: z.literal("blob"),
    blob: blobSchema,
    mediaType: nonemptyStringSchema,
    filename: z.string().optional(),
  });

  const toolResultOutputSchema = z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("text"),
      value: z.string(),
      providerOptions: providerOptionsSchema.optional(),
    }),
    z.strictObject({
      type: z.literal("json"),
      value: z.json(),
      providerOptions: providerOptionsSchema.optional(),
    }),
    z.strictObject({
      type: z.literal("execution-denied"),
      reason: z.string().optional(),
      providerOptions: providerOptionsSchema.optional(),
    }),
    z.strictObject({
      type: z.literal("error-text"),
      value: z.string(),
      providerOptions: providerOptionsSchema.optional(),
    }),
    z.strictObject({
      type: z.literal("error-json"),
      value: z.json(),
      providerOptions: providerOptionsSchema.optional(),
    }),
    z.strictObject({
      type: z.literal("content"),
      value: z.array(
        z.union([textPartSchema, blobPartSchema, storedResourcePartV1Schema, customPartSchema]),
      ),
    }),
  ]);

  const toolResultPartSchema = z.strictObject({
    type: z.literal("tool-result"),
    toolCallId: nonemptyStringSchema,
    toolName: nonemptyStringSchema,
    output: toolResultOutputSchema,
    providerOptions: providerOptionsSchema.optional(),
  });

  const systemMessageSchema = z.strictObject({
    role: z.literal("system"),
    content: z.string(),
    providerOptions: providerOptionsSchema.optional(),
  });
  const userMessageSchema = z.strictObject({
    role: z.literal("user"),
    content: z.union([
      z.string(),
      z.array(z.union([textPartSchema, blobPartSchema, storedResourcePartV1Schema])),
    ]),
    providerOptions: providerOptionsSchema.optional(),
  });
  const assistantMessageSchema = z.strictObject({
    role: z.literal("assistant"),
    content: z.union([
      z.string(),
      z.array(
        z.union([
          textPartSchema,
          blobPartSchema,
          storedResourcePartV1Schema,
          reasoningPartSchema,
          customPartSchema,
          toolCallPartSchema,
          toolResultPartSchema,
          toolApprovalRequestSchema,
        ]),
      ),
    ]),
    providerOptions: providerOptionsSchema.optional(),
  });
  const toolMessageSchema = z.strictObject({
    role: z.literal("tool"),
    content: z.array(z.union([toolResultPartSchema, toolApprovalResponseSchema])),
    providerOptions: providerOptionsSchema.optional(),
  });

  return {
    blobPartSchema,
    messageSchema: z.discriminatedUnion("role", [
      systemMessageSchema,
      userMessageSchema,
      assistantMessageSchema,
      toolMessageSchema,
    ]),
  };
}

const busSchemas = createBlobMessageSchemas<BlobHandleV1>(blobHandleV1Schema);

/** Strict pending-upload file part accepted on the current Redis request wire. */
export const busFilePartV2Schema = busSchemas.blobPartSchema;
export type BusFilePartV2 = z.output<typeof busFilePartV2Schema>;

/** Strict handle-bearing message accepted on the current Redis request wire. */
export const busMessageV2Schema = busSchemas.messageSchema;
export type BusMessageV2 = z.output<typeof busMessageV2Schema>;

export const busMessagesV2Schema = z.array(busMessageV2Schema);

const storedSchemas = createBlobMessageSchemas<BlobRefV1>(blobRefV1Schema);

/** Strict resolved file part used for durable canonical message identity. */
export const storedFilePartV1Schema = storedSchemas.blobPartSchema;
export type StoredFilePartV1 = z.output<typeof storedFilePartV1Schema>;

/** Strict reference-bearing message used after request blob resolution. */
export const storedMessageV1Schema = storedSchemas.messageSchema;
export type StoredMessageV1 = z.output<typeof storedMessageV1Schema>;

export const storedMessagesV1Schema = z.array(storedMessageV1Schema);
