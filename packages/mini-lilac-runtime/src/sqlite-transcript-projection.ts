import {
  miniLilacUIMessageDataPartSchema,
  miniLilacUIMessageMetadataSchema,
} from "@stanley2058/mini-lilac-client";
import { z } from "zod";

const jsonValueSchema = z.json();
const providerOptionsSchema = z.record(z.string(), z.record(z.string(), jsonValueSchema));
const providerReferenceSchema = z.record(z.string(), z.string());
const modelInlineDataSchema = z.union([
  z.string(),
  z.instanceof(Uint8Array),
  z.instanceof(ArrayBuffer),
]);
const modelTaggedFileDataSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("data"), data: modelInlineDataSchema }),
  z.strictObject({ type: z.literal("url"), url: z.instanceof(URL) }),
  z.strictObject({ type: z.literal("reference"), reference: providerReferenceSchema }),
  z.strictObject({ type: z.literal("text"), text: z.string() }),
]);
const modelTaggedReasoningFileDataSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("data"), data: modelInlineDataSchema }),
  z.strictObject({ type: z.literal("url"), url: z.instanceof(URL) }),
]);

export type MiniLilacPersistedSuperJsonValue =
  | null
  | undefined
  | boolean
  | number
  | string
  | bigint
  | Date
  | RegExp
  | URL
  | Uint8Array
  | ArrayBuffer
  | MiniLilacPersistedSuperJsonValue[]
  | Map<MiniLilacPersistedSuperJsonValue, MiniLilacPersistedSuperJsonValue>
  | Set<MiniLilacPersistedSuperJsonValue>
  | { readonly [key: string]: MiniLilacPersistedSuperJsonValue };

export function validateMiniLilacPersistedSuperJsonValue(value: unknown): boolean {
  const seen = new WeakSet<object>();
  const validate = (candidate: unknown): boolean => {
    if (
      candidate === null ||
      candidate === undefined ||
      typeof candidate === "boolean" ||
      typeof candidate === "number" ||
      typeof candidate === "string" ||
      typeof candidate === "bigint"
    ) {
      return true;
    }
    if (typeof candidate !== "object") return false;
    if (
      candidate instanceof Date ||
      candidate instanceof RegExp ||
      candidate instanceof URL ||
      candidate instanceof Uint8Array ||
      candidate instanceof ArrayBuffer
    ) {
      return !(candidate instanceof Date) || !Number.isNaN(candidate.getTime());
    }
    if (seen.has(candidate)) return true;
    seen.add(candidate);
    if (Array.isArray(candidate)) return candidate.every(validate);
    if (candidate instanceof Map) {
      return [...candidate].every(([key, nestedValue]) => validate(key) && validate(nestedValue));
    }
    if (candidate instanceof Set) return [...candidate].every(validate);
    const prototype = Object.getPrototypeOf(candidate);
    return (
      (prototype === Object.prototype || prototype === null) &&
      Object.values(candidate).every(validate)
    );
  };
  return validate(value);
}

export const superJsonValueSchema: z.ZodType<MiniLilacPersistedSuperJsonValue> =
  z.custom<MiniLilacPersistedSuperJsonValue>(validateMiniLilacPersistedSuperJsonValue, {
    message: "Expected a recursively valid SuperJSON value",
  });

const modelTextPartSchema = z.strictObject({
  type: z.literal("text"),
  text: z.string(),
  providerOptions: providerOptionsSchema.optional(),
});
const modelImagePartSchema = z.strictObject({
  type: z.literal("image"),
  image: z.union([modelInlineDataSchema, z.instanceof(URL), providerReferenceSchema]),
  mediaType: z.string().optional(),
  providerOptions: providerOptionsSchema.optional(),
});
const modelFilePartSchema = z.strictObject({
  type: z.literal("file"),
  data: z.union([
    modelTaggedFileDataSchema,
    modelInlineDataSchema,
    z.instanceof(URL),
    providerReferenceSchema,
  ]),
  filename: z.string().optional(),
  mediaType: z.string(),
  providerOptions: providerOptionsSchema.optional(),
});
const modelReasoningPartSchema = z.strictObject({
  type: z.literal("reasoning"),
  text: z.string(),
  providerOptions: providerOptionsSchema.optional(),
});
const modelReasoningFilePartSchema = z.strictObject({
  type: z.literal("reasoning-file"),
  data: z.union([modelTaggedReasoningFileDataSchema, modelInlineDataSchema, z.instanceof(URL)]),
  mediaType: z.string(),
  providerOptions: providerOptionsSchema.optional(),
});
const modelCustomPartSchema = z.strictObject({
  type: z.literal("custom"),
  kind: z.templateLiteral([z.string(), ".", z.string()]),
  providerOptions: providerOptionsSchema.optional(),
});
const modelToolCallPartSchema = z.strictObject({
  type: z.literal("tool-call"),
  toolCallId: z.string(),
  toolName: z.string(),
  input: superJsonValueSchema,
  providerOptions: providerOptionsSchema.optional(),
  providerExecuted: z.boolean().optional(),
});

const modelToolOutputContentPartSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("text"),
    text: z.string(),
    providerOptions: providerOptionsSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("file"),
    data: modelTaggedFileDataSchema,
    mediaType: z.string(),
    filename: z.string().optional(),
    providerOptions: providerOptionsSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("file-data"),
    data: z.string(),
    mediaType: z.string(),
    filename: z.string().optional(),
    providerOptions: providerOptionsSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("file-url"),
    url: z.string(),
    mediaType: z.string().optional(),
    providerOptions: providerOptionsSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("file-id"),
    fileId: z.union([z.string(), providerReferenceSchema]),
    providerOptions: providerOptionsSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("file-reference"),
    providerReference: providerReferenceSchema,
    providerOptions: providerOptionsSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("image-data"),
    data: z.string(),
    mediaType: z.string(),
    providerOptions: providerOptionsSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("image-url"),
    url: z.string(),
    providerOptions: providerOptionsSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("image-file-id"),
    fileId: z.union([z.string(), providerReferenceSchema]),
    providerOptions: providerOptionsSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("image-file-reference"),
    providerReference: providerReferenceSchema,
    providerOptions: providerOptionsSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("custom"),
    providerOptions: providerOptionsSchema.optional(),
  }),
]);

const modelToolOutputSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("text"),
    value: z.string(),
    providerOptions: providerOptionsSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("json"),
    value: jsonValueSchema,
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
    value: jsonValueSchema,
    providerOptions: providerOptionsSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("content"),
    value: z.array(modelToolOutputContentPartSchema),
  }),
]);

const modelToolResultPartSchema = z.strictObject({
  type: z.literal("tool-result"),
  toolCallId: z.string(),
  toolName: z.string(),
  output: modelToolOutputSchema,
  providerOptions: providerOptionsSchema.optional(),
});
const modelToolApprovalRequestPartSchema = z.strictObject({
  type: z.literal("tool-approval-request"),
  approvalId: z.string(),
  toolCallId: z.string(),
});
const modelToolApprovalResponsePartSchema = z.strictObject({
  type: z.literal("tool-approval-response"),
  approvalId: z.string(),
  approved: z.boolean(),
  reason: z.string().optional(),
});

const modelMessageSchema = z.discriminatedUnion("role", [
  z.strictObject({
    role: z.literal("system"),
    content: z.string(),
    providerOptions: providerOptionsSchema.optional(),
  }),
  z.strictObject({
    role: z.literal("user"),
    content: z.union([
      z.string(),
      z.array(z.union([modelTextPartSchema, modelImagePartSchema, modelFilePartSchema])),
    ]),
    providerOptions: providerOptionsSchema.optional(),
  }),
  z.strictObject({
    role: z.literal("assistant"),
    content: z.union([
      z.string(),
      z.array(
        z.union([
          modelTextPartSchema,
          modelFilePartSchema,
          modelCustomPartSchema,
          modelReasoningPartSchema,
          modelReasoningFilePartSchema,
          modelToolCallPartSchema,
          modelToolResultPartSchema,
          modelToolApprovalRequestPartSchema,
        ]),
      ),
    ]),
    providerOptions: providerOptionsSchema.optional(),
  }),
  z.strictObject({
    role: z.literal("tool"),
    content: z.array(z.union([modelToolResultPartSchema, modelToolApprovalResponsePartSchema])),
    providerOptions: providerOptionsSchema.optional(),
  }),
]);

export const miniLilacPersistedModelMessagesSchema = z.array(modelMessageSchema);
export type MiniLilacPersistedModelMessageProjection = z.output<typeof modelMessageSchema>;

const uiProviderMetadataSchema = z.record(z.string(), z.record(z.string(), jsonValueSchema));
const uiToolMetadataSchema = z.record(z.string(), jsonValueSchema.optional());
const uiStandardPartMetadataFields = {
  providerMetadata: uiProviderMetadataSchema.optional(),
};
const uiTextPartSchema = z.strictObject({
  type: z.literal("text"),
  text: z.string(),
  state: z.enum(["streaming", "done"]).optional(),
  ...uiStandardPartMetadataFields,
});
const uiReasoningPartSchema = z.strictObject({
  type: z.literal("reasoning"),
  text: z.string(),
  state: z.enum(["streaming", "done"]).optional(),
  ...uiStandardPartMetadataFields,
});
const uiFilePartSchema = z.strictObject({
  type: z.literal("file"),
  mediaType: z.string(),
  filename: z.string().optional(),
  url: z.string(),
  providerReference: providerReferenceSchema.optional(),
  ...uiStandardPartMetadataFields,
});
const uiSourceUrlPartSchema = z.strictObject({
  type: z.literal("source-url"),
  sourceId: z.string(),
  url: z.string(),
  title: z.string().optional(),
  ...uiStandardPartMetadataFields,
});
const uiSourceDocumentPartSchema = z.strictObject({
  type: z.literal("source-document"),
  sourceId: z.string(),
  mediaType: z.string(),
  title: z.string(),
  filename: z.string().optional(),
  ...uiStandardPartMetadataFields,
});
const uiReasoningFilePartSchema = z.strictObject({
  type: z.literal("reasoning-file"),
  mediaType: z.string(),
  url: z.string(),
  ...uiStandardPartMetadataFields,
});
const uiCustomPartSchema = z.strictObject({
  type: z.literal("custom"),
  kind: z.templateLiteral([z.string(), ".", z.string()]),
  ...uiStandardPartMetadataFields,
});
const uiStepStartPartSchema = z.strictObject({ type: z.literal("step-start") });

const uiToolPartBaseFields = {
  toolCallId: z.string(),
  title: z.string().optional(),
  toolMetadata: uiToolMetadataSchema.optional(),
  providerExecuted: z.boolean().optional(),
};
const uiToolApprovalMetadataFields = {
  isAutomatic: z.boolean().optional(),
  signature: z.string().optional(),
};
const absentUiToolFieldSchema = z.undefined().optional();

const uiToolTypeSchema = z.templateLiteral(["tool-", z.string().min(1)]);
const uiToolTypeFields = {
  type: uiToolTypeSchema,
  ...uiToolPartBaseFields,
};
const uiDynamicToolTypeFields = {
  type: z.literal("dynamic-tool"),
  toolName: z.string(),
  ...uiToolPartBaseFields,
};
const uiToolPartSchema = z.discriminatedUnion("state", [
  z.strictObject({
    ...uiToolTypeFields,
    state: z.literal("input-streaming"),
    input: superJsonValueSchema.optional(),
    rawInput: absentUiToolFieldSchema,
    output: absentUiToolFieldSchema,
    errorText: absentUiToolFieldSchema,
    preliminary: absentUiToolFieldSchema,
    callProviderMetadata: uiProviderMetadataSchema.optional(),
    approval: absentUiToolFieldSchema,
  }),
  z.strictObject({
    ...uiToolTypeFields,
    state: z.literal("input-available"),
    input: superJsonValueSchema,
    rawInput: absentUiToolFieldSchema,
    output: absentUiToolFieldSchema,
    errorText: absentUiToolFieldSchema,
    preliminary: absentUiToolFieldSchema,
    callProviderMetadata: uiProviderMetadataSchema.optional(),
    approval: absentUiToolFieldSchema,
  }),
  z.strictObject({
    ...uiToolTypeFields,
    state: z.literal("approval-requested"),
    input: superJsonValueSchema,
    rawInput: absentUiToolFieldSchema,
    output: absentUiToolFieldSchema,
    errorText: absentUiToolFieldSchema,
    preliminary: absentUiToolFieldSchema,
    callProviderMetadata: uiProviderMetadataSchema.optional(),
    approval: z.strictObject({
      id: z.string(),
      approved: absentUiToolFieldSchema,
      reason: absentUiToolFieldSchema,
      ...uiToolApprovalMetadataFields,
    }),
  }),
  z.strictObject({
    ...uiToolTypeFields,
    state: z.literal("approval-responded"),
    input: superJsonValueSchema,
    rawInput: absentUiToolFieldSchema,
    output: absentUiToolFieldSchema,
    errorText: absentUiToolFieldSchema,
    preliminary: absentUiToolFieldSchema,
    callProviderMetadata: uiProviderMetadataSchema.optional(),
    approval: z.strictObject({
      id: z.string(),
      approved: z.boolean(),
      reason: z.string().optional(),
      ...uiToolApprovalMetadataFields,
    }),
  }),
  z.strictObject({
    ...uiToolTypeFields,
    state: z.literal("output-available"),
    input: superJsonValueSchema,
    rawInput: absentUiToolFieldSchema,
    output: superJsonValueSchema,
    errorText: absentUiToolFieldSchema,
    callProviderMetadata: uiProviderMetadataSchema.optional(),
    resultProviderMetadata: uiProviderMetadataSchema.optional(),
    preliminary: z.boolean().optional(),
    approval: z
      .strictObject({
        id: z.string(),
        approved: z.literal(true),
        reason: z.string().optional(),
        ...uiToolApprovalMetadataFields,
      })
      .optional(),
  }),
  z.strictObject({
    ...uiToolTypeFields,
    state: z.literal("output-error"),
    input: superJsonValueSchema,
    rawInput: superJsonValueSchema.optional(),
    output: absentUiToolFieldSchema,
    errorText: z.string(),
    callProviderMetadata: uiProviderMetadataSchema.optional(),
    resultProviderMetadata: uiProviderMetadataSchema.optional(),
    preliminary: z.boolean().optional(),
    approval: z
      .strictObject({
        id: z.string(),
        approved: z.literal(true),
        reason: z.string().optional(),
        ...uiToolApprovalMetadataFields,
      })
      .optional(),
  }),
  z.strictObject({
    ...uiToolTypeFields,
    state: z.literal("output-denied"),
    input: superJsonValueSchema,
    rawInput: absentUiToolFieldSchema,
    output: absentUiToolFieldSchema,
    errorText: absentUiToolFieldSchema,
    preliminary: absentUiToolFieldSchema,
    callProviderMetadata: uiProviderMetadataSchema.optional(),
    approval: z.strictObject({
      id: z.string(),
      approved: z.literal(false),
      reason: z.string().optional(),
      ...uiToolApprovalMetadataFields,
    }),
  }),
]);
const uiDynamicToolPartSchema = z.discriminatedUnion("state", [
  z.strictObject({
    ...uiDynamicToolTypeFields,
    state: z.literal("input-streaming"),
    input: superJsonValueSchema.optional(),
    rawInput: absentUiToolFieldSchema,
    output: absentUiToolFieldSchema,
    errorText: absentUiToolFieldSchema,
    preliminary: absentUiToolFieldSchema,
    callProviderMetadata: uiProviderMetadataSchema.optional(),
    approval: absentUiToolFieldSchema,
  }),
  z.strictObject({
    ...uiDynamicToolTypeFields,
    state: z.literal("input-available"),
    input: superJsonValueSchema,
    rawInput: absentUiToolFieldSchema,
    output: absentUiToolFieldSchema,
    errorText: absentUiToolFieldSchema,
    preliminary: absentUiToolFieldSchema,
    callProviderMetadata: uiProviderMetadataSchema.optional(),
    approval: absentUiToolFieldSchema,
  }),
  z.strictObject({
    ...uiDynamicToolTypeFields,
    state: z.literal("approval-requested"),
    input: superJsonValueSchema,
    rawInput: absentUiToolFieldSchema,
    output: absentUiToolFieldSchema,
    errorText: absentUiToolFieldSchema,
    preliminary: absentUiToolFieldSchema,
    callProviderMetadata: uiProviderMetadataSchema.optional(),
    approval: z.strictObject({
      id: z.string(),
      approved: absentUiToolFieldSchema,
      reason: absentUiToolFieldSchema,
      ...uiToolApprovalMetadataFields,
    }),
  }),
  z.strictObject({
    ...uiDynamicToolTypeFields,
    state: z.literal("approval-responded"),
    input: superJsonValueSchema,
    rawInput: absentUiToolFieldSchema,
    output: absentUiToolFieldSchema,
    errorText: absentUiToolFieldSchema,
    preliminary: absentUiToolFieldSchema,
    callProviderMetadata: uiProviderMetadataSchema.optional(),
    approval: z.strictObject({
      id: z.string(),
      approved: z.boolean(),
      reason: z.string().optional(),
      ...uiToolApprovalMetadataFields,
    }),
  }),
  z.strictObject({
    ...uiDynamicToolTypeFields,
    state: z.literal("output-available"),
    input: superJsonValueSchema,
    rawInput: absentUiToolFieldSchema,
    output: superJsonValueSchema,
    errorText: absentUiToolFieldSchema,
    callProviderMetadata: uiProviderMetadataSchema.optional(),
    resultProviderMetadata: uiProviderMetadataSchema.optional(),
    preliminary: z.boolean().optional(),
    approval: z
      .strictObject({
        id: z.string(),
        approved: z.literal(true),
        reason: z.string().optional(),
        ...uiToolApprovalMetadataFields,
      })
      .optional(),
  }),
  z.strictObject({
    ...uiDynamicToolTypeFields,
    state: z.literal("output-error"),
    input: superJsonValueSchema,
    rawInput: superJsonValueSchema.optional(),
    output: absentUiToolFieldSchema,
    errorText: z.string(),
    callProviderMetadata: uiProviderMetadataSchema.optional(),
    resultProviderMetadata: uiProviderMetadataSchema.optional(),
    preliminary: z.boolean().optional(),
    approval: z
      .strictObject({
        id: z.string(),
        approved: z.literal(true),
        reason: z.string().optional(),
        ...uiToolApprovalMetadataFields,
      })
      .optional(),
  }),
  z.strictObject({
    ...uiDynamicToolTypeFields,
    state: z.literal("output-denied"),
    input: superJsonValueSchema,
    rawInput: absentUiToolFieldSchema,
    output: absentUiToolFieldSchema,
    errorText: absentUiToolFieldSchema,
    preliminary: absentUiToolFieldSchema,
    callProviderMetadata: uiProviderMetadataSchema.optional(),
    approval: z.strictObject({
      id: z.string(),
      approved: z.literal(false),
      reason: z.string().optional(),
      ...uiToolApprovalMetadataFields,
    }),
  }),
]);
const uiMessagePartSchema = z.union([
  uiTextPartSchema,
  uiReasoningPartSchema,
  uiFilePartSchema,
  uiSourceUrlPartSchema,
  uiSourceDocumentPartSchema,
  uiReasoningFilePartSchema,
  uiCustomPartSchema,
  uiStepStartPartSchema,
  uiToolPartSchema,
  uiDynamicToolPartSchema,
  miniLilacUIMessageDataPartSchema,
]);
type MiniLilacPersistedUiProviderMetadata = z.output<typeof uiProviderMetadataSchema>;
type MiniLilacPersistedUiToolBase =
  | {
      readonly type: `tool-${string}`;
      readonly toolCallId: string;
      readonly title?: string;
      readonly toolMetadata?: Record<string, z.output<typeof jsonValueSchema> | undefined>;
      readonly providerExecuted?: boolean;
    }
  | {
      readonly type: "dynamic-tool";
      readonly toolName: string;
      readonly toolCallId: string;
      readonly title?: string;
      readonly toolMetadata?: Record<string, z.output<typeof jsonValueSchema> | undefined>;
      readonly providerExecuted?: boolean;
    };
type MiniLilacPersistedUiToolApprovalMetadata = {
  readonly isAutomatic?: boolean;
  readonly signature?: string;
};
type MiniLilacPersistedUiToolState =
  | {
      readonly state: "input-streaming";
      readonly input?: MiniLilacPersistedSuperJsonValue;
      readonly callProviderMetadata?: MiniLilacPersistedUiProviderMetadata;
    }
  | {
      readonly state: "input-available";
      readonly input: MiniLilacPersistedSuperJsonValue;
      readonly callProviderMetadata?: MiniLilacPersistedUiProviderMetadata;
    }
  | {
      readonly state: "approval-requested";
      readonly input: MiniLilacPersistedSuperJsonValue;
      readonly callProviderMetadata?: MiniLilacPersistedUiProviderMetadata;
      readonly approval: { readonly id: string } & MiniLilacPersistedUiToolApprovalMetadata;
    }
  | {
      readonly state: "approval-responded";
      readonly input: MiniLilacPersistedSuperJsonValue;
      readonly callProviderMetadata?: MiniLilacPersistedUiProviderMetadata;
      readonly approval: {
        readonly id: string;
        readonly approved: boolean;
        readonly reason?: string;
      } & MiniLilacPersistedUiToolApprovalMetadata;
    }
  | {
      readonly state: "output-available";
      readonly input: MiniLilacPersistedSuperJsonValue;
      readonly output: MiniLilacPersistedSuperJsonValue;
      readonly callProviderMetadata?: MiniLilacPersistedUiProviderMetadata;
      readonly resultProviderMetadata?: MiniLilacPersistedUiProviderMetadata;
      readonly preliminary?: boolean;
      readonly approval?: {
        readonly id: string;
        readonly approved: true;
        readonly reason?: string;
      } & MiniLilacPersistedUiToolApprovalMetadata;
    }
  | {
      readonly state: "output-error";
      readonly input: MiniLilacPersistedSuperJsonValue;
      readonly rawInput?: MiniLilacPersistedSuperJsonValue;
      readonly errorText: string;
      readonly callProviderMetadata?: MiniLilacPersistedUiProviderMetadata;
      readonly resultProviderMetadata?: MiniLilacPersistedUiProviderMetadata;
      readonly preliminary?: boolean;
      readonly approval?: {
        readonly id: string;
        readonly approved: true;
        readonly reason?: string;
      } & MiniLilacPersistedUiToolApprovalMetadata;
    }
  | {
      readonly state: "output-denied";
      readonly input: MiniLilacPersistedSuperJsonValue;
      readonly callProviderMetadata?: MiniLilacPersistedUiProviderMetadata;
      readonly approval: {
        readonly id: string;
        readonly approved: false;
        readonly reason?: string;
      } & MiniLilacPersistedUiToolApprovalMetadata;
    };
type MiniLilacPersistedUiMessagePartProjection =
  | z.output<typeof uiTextPartSchema>
  | z.output<typeof uiReasoningPartSchema>
  | z.output<typeof uiFilePartSchema>
  | z.output<typeof uiSourceUrlPartSchema>
  | z.output<typeof uiSourceDocumentPartSchema>
  | z.output<typeof uiReasoningFilePartSchema>
  | z.output<typeof uiCustomPartSchema>
  | z.output<typeof uiStepStartPartSchema>
  | (MiniLilacPersistedUiToolBase & MiniLilacPersistedUiToolState)
  | z.output<typeof miniLilacUIMessageDataPartSchema>;

export type MiniLilacPersistedUiMessageProjection = {
  readonly id: string;
  readonly role: "system" | "user" | "assistant";
  readonly metadata?: z.output<typeof miniLilacUIMessageMetadataSchema>;
  readonly parts: MiniLilacPersistedUiMessagePartProjection[];
};
export type MiniLilacPersistedUserUiMessageProjection = Omit<
  MiniLilacPersistedUiMessageProjection,
  "role"
> & {
  readonly role: "user";
};
const uiMessageSchema = z.strictObject({
  id: z.string().trim().min(1),
  role: z.enum(["system", "user", "assistant"]),
  metadata: miniLilacUIMessageMetadataSchema.optional(),
  parts: z.array(uiMessagePartSchema).nonempty(),
});
export const miniLilacPersistedUserUiMessageSchema: z.ZodType<MiniLilacPersistedUserUiMessageProjection> =
  uiMessageSchema.extend({ role: z.literal("user") });

export const miniLilacPersistedUiMessagesSchema: z.ZodType<
  MiniLilacPersistedUiMessageProjection[]
> = z.array(uiMessageSchema);
