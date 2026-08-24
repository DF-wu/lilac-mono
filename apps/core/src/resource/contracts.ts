import { randomBytes as nodeRandomBytes } from "node:crypto";

import { blobRefV1Schema, type BlobRefV1 } from "@stanley2058/lilac-blob-storage";
import { Result, type Result as ResultType } from "better-result";
import { z } from "zod";

import { ResourceInvalidUri } from "./errors";

export const RESOURCE_MAX_BYTES = 512 * 1024 * 1024;
export const RESOURCE_MODEL_INLINE_MAX_BYTES = 25 * 1024 * 1024;
export const RESOURCE_MATERIALIZE_CALL_MAX_BYTES = 1024 * 1024 * 1024;
export const RESOURCE_MATERIALIZE_MAX_COUNT = 32;

export type ResourceLimits = {
  readonly maxBytes: number;
  readonly modelInlineMaxBytes: number;
  readonly materializeCallMaxBytes: number;
  readonly materializeMaxCount: number;
  readonly sniffBytes: number;
};

export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  maxBytes: RESOURCE_MAX_BYTES,
  modelInlineMaxBytes: RESOURCE_MODEL_INLINE_MAX_BYTES,
  materializeCallMaxBytes: RESOURCE_MATERIALIZE_CALL_MAX_BYTES,
  materializeMaxCount: RESOURCE_MATERIALIZE_MAX_COUNT,
  sniffBytes: 64 * 1024,
};

const resourceIdPattern = /^r1_[0-9a-f]{32}$/u;
const resourceUriPattern = /^resource:\/\/(r1_[0-9a-f]{32})$/u;
const nonNegativeSafeIntegerSchema = z.number().int().nonnegative().safe();
const normalizedMediaTypeSchema = z
  .string()
  .min(1)
  .refine((value) => value === value.trim().toLowerCase() && !value.includes(";"), {
    message: "Media type must be normalized lowercase without parameters",
  });

export const resourceIdSchema = z.string().regex(resourceIdPattern);
export type ResourceId = z.infer<typeof resourceIdSchema>;

export const resourceUriSchema = z.string().regex(resourceUriPattern);
export type ResourceUri = z.infer<typeof resourceUriSchema>;

export const discordResourceOriginV1Schema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("discord-attachment"),
  channelId: z.string().min(1),
  messageId: z.string().min(1),
  ordinal: nonNegativeSafeIntegerSchema,
  attachmentId: z.string().min(1).optional(),
});
export type DiscordResourceOriginV1 = z.infer<typeof discordResourceOriginV1Schema>;

export const resourceOriginV1Schema = z.discriminatedUnion("kind", [discordResourceOriginV1Schema]);
export type ResourceOriginV1 = z.infer<typeof resourceOriginV1Schema>;

export const resourceCacheV1Schema = z.strictObject({
  blob: blobRefV1Schema,
  cachedAt: nonNegativeSafeIntegerSchema,
});
export type ResourceCacheV1 = z.infer<typeof resourceCacheV1Schema>;

export const resourceRecordV1Schema = z.strictObject({
  version: z.literal(1),
  resourceId: resourceIdSchema,
  origin: resourceOriginV1Schema,
  filename: z.string().min(1).optional(),
  declaredMediaType: normalizedMediaTypeSchema.optional(),
  detectedMediaType: normalizedMediaTypeSchema.optional(),
  reportedByteLength: nonNegativeSafeIntegerSchema.optional(),
  createdAt: nonNegativeSafeIntegerSchema,
  cache: resourceCacheV1Schema.optional(),
});
export type ResourceRecordV1 = z.infer<typeof resourceRecordV1Schema>;

export type RegisterResourceInput = {
  readonly origin: ResourceOriginV1;
  readonly filename?: string;
  readonly declaredMediaType?: string;
  readonly reportedByteLength?: number;
};

export type ResourceDescriptor = {
  readonly uri: ResourceUri;
  readonly filename?: string;
  readonly declaredMediaType?: string;
  readonly detectedMediaType?: string;
  readonly reportedByteLength?: number;
  readonly cachedByteLength?: number;
};

export type MaterializedResource = {
  readonly uri: ResourceUri;
  readonly path: string;
  readonly filename: string;
  readonly mimeType?: string;
  readonly bytes: number;
  readonly sha256: string;
};

export function parseResourceUri(input: string): ResultType<ResourceId, ResourceInvalidUri> {
  const match = resourceUriPattern.exec(input);
  return match?.[1]
    ? Result.ok(match[1])
    : Result.err(
        new ResourceInvalidUri({
          uri: input,
          message: "Resource URI must use the exact resource://r1_<128-bit-id> format",
        }),
      );
}

export function formatResourceUri(resourceId: ResourceId): ResourceUri {
  return `resource://${resourceId}`;
}

export function createResourceId(
  randomBytes: (length: number) => Uint8Array = nodeRandomBytes,
): ResourceId {
  return `r1_${Buffer.from(randomBytes(16)).toString("hex")}`;
}

export function resourceDescriptorFromRecord(record: ResourceRecordV1): ResourceDescriptor {
  return {
    uri: formatResourceUri(record.resourceId),
    ...(record.filename === undefined ? {} : { filename: record.filename }),
    ...(record.declaredMediaType === undefined
      ? {}
      : { declaredMediaType: record.declaredMediaType }),
    ...(record.detectedMediaType === undefined
      ? {}
      : { detectedMediaType: record.detectedMediaType }),
    ...(record.reportedByteLength === undefined
      ? {}
      : { reportedByteLength: record.reportedByteLength }),
    ...(record.cache === undefined ? {} : { cachedByteLength: record.cache.blob.byteLength }),
  };
}

export type ResourceReadComplete = {
  readonly sha256: string;
  readonly byteLength: number;
};

export type ResourceBlobReference = BlobRefV1;
