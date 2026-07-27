import { z } from "zod";
import { IMAGE_MODEL_ALIASES, VIDEO_MODEL_ALIASES } from "./models";

const optionalPathListSchema = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(16)])
  .optional()
  .transform((value) => (typeof value === "string" ? [value] : value));

const timeoutSchema = z.coerce.number().int().min(100).max(290_000).default(240_000);

export const imageInputSchema = z
  .object({
    prompt: z.string().trim().min(1).max(32_000),
    model: z.enum(IMAGE_MODEL_ALIASES).default("gpt-image-2"),
    outputDir: z.string().min(1).optional(),
    inputImages: optionalPathListSchema,
    maskImage: z.string().min(1).optional(),
    size: z
      .string()
      .regex(/^\d+x\d+$/u)
      .optional(),
    aspectRatio: z
      .string()
      .regex(/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/u)
      .optional(),
    timeoutMs: timeoutSchema,
  })
  .strict()
  .superRefine((input, context) => {
    if (input.size && input.aspectRatio) {
      context.addIssue({ code: "custom", message: "Provide only one of size or aspectRatio." });
    }
    if (input.maskImage && !input.inputImages?.length) {
      context.addIssue({
        code: "custom",
        path: ["maskImage"],
        message: "maskImage requires at least one inputImages entry.",
      });
    }
  });

export const videoInputSchema = z
  .object({
    prompt: z.string().trim().min(1).max(32_000),
    model: z.enum(VIDEO_MODEL_ALIASES).default("grok-imagine-video"),
    path: z.string().min(1),
    inputImage: z.string().min(1).optional(),
    seconds: z.coerce.number().int().min(1).max(15).optional(),
    size: z
      .string()
      .regex(/^\d+x\d+$/u)
      .optional(),
    pollIntervalMs: z.coerce.number().int().min(10).max(30_000).default(2_000),
    timeoutMs: timeoutSchema,
    maxDownloadBytes: z.coerce
      .number()
      .int()
      .min(1)
      .max(512 * 1024 * 1024)
      .default(256 * 1024 * 1024),
  })
  .strict();

export const imageOutputSchema = z
  .object({
    ok: z.literal(true),
    path: z.string(),
    bytes: z.number().int().nonnegative(),
    mimeType: z.string(),
    model: z.enum(IMAGE_MODEL_ALIASES),
    route: z.string(),
    warnings: z.array(z.unknown()),
  })
  .strict();

export const videoOutputSchema = z
  .object({
    ok: z.literal(true),
    path: z.string(),
    bytes: z.number().int().nonnegative(),
    mimeType: z.string(),
    model: z.enum(VIDEO_MODEL_ALIASES),
    route: z.string(),
    videoId: z.string(),
  })
  .strict();

export type ImageInput = z.infer<typeof imageInputSchema>;
export type VideoInput = z.infer<typeof videoInputSchema>;
export type ImageOutput = z.infer<typeof imageOutputSchema>;
export type VideoOutput = z.infer<typeof videoOutputSchema>;
