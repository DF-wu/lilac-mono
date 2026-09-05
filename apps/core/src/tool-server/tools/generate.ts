import { captureError } from "../../shared/error-capture";
import { env, errorMessage, getModelProviders, type CoreConfig } from "@stanley2058/lilac-utils";
import {
  defineServerTool,
  type RequestContext,
  type ServerTool,
  type ServerToolCallOptions,
} from "../types";
import {
  serverToolFailure,
  type ServerToolFailure,
  type ServerToolResult,
} from "@stanley2058/lilac-plugin-runtime";
import { Panic, Result, type Result as ResultType } from "better-result";
import { preserveToolPanic } from "../../tools/tool-result-adapters";

function settleCapturedError<T, E>(
  result: ResultType<T, { readonly cause: Error | Panic }>,
  resolve: (cause: Error | Panic) => E,
): ResultType<T, E> {
  return result.mapError(({ cause }) => resolve(cause));
}

async function settleCapturedPromise<T, E>(
  result: Promise<ResultType<T, { readonly cause: Error | Panic }>>,
  resolve: (cause: Error | Panic) => E,
): Promise<ResultType<T, E>> {
  return settleCapturedError(await result, resolve);
}

function captureGenerateFailure(cause: unknown): { readonly cause: Error | Panic } {
  if (Panic.is(cause)) return { cause };
  if (cause instanceof Error) return { cause };
  return { cause: new Error("Unknown image generation failure", { cause }) };
}
import {
  experimental_generateVideo as generateVideo,
  generateImage,
  type DataContent,
  type GenerateVideoPrompt,
  type ImageModel,
} from "ai";
import { fileTypeFromBuffer } from "file-type";
import fs from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { z } from "zod";
import {
  formatToolPathForRequestContext,
  inferExtensionFromMimeType,
  inferMimeTypeFromFilename,
  resolveToolPathForRequestContext,
} from "../../shared/attachment-utils";
import { resolveImageRouting } from "./generate-image-routing";

function generateFailure(kind: ServerToolFailure["kind"], message: string): ServerToolFailure {
  return serverToolFailure({
    kind,
    code: `generate_${kind}`,
    message,
    retryable: kind === "unavailable" || kind === "timeout",
  });
}

type SupportedImageModelId =
  /**
   * - Recommended default
   * - Aspect ratio: 1:1, 3:2, 2:3
   * - Generation sizes: arbitrary dimensions within the model limits
   * - Edit sizes: 1024x1024, 1536x1024, 1024x1536
   */
  | "gpt-image-2"
  /**
   * - Aspect ratio: 1:1, 3:2, 2:3
   * - Sizes: 1024x1024 (1:1); 1536x1024 (3:2 landscape); 1024x1536 (2:3 portrait)
   */
  | "gpt-5-image"
  /**
   * - Aspect ratio: 21:9, 16:9, 3:2, 4:3, 5:4, 1:1, 4:5, 3:4, 2:3, 9:16
   */
  | "nanobanana"
  /**
   * - Provider/slug: openrouter/google/gemini-3.1-flash-image-preview
   * - Aspect ratio: 21:9, 16:9, 3:2, 4:3, 5:4, 1:1, 4:5, 3:4, 2:3, 9:16, 1:4, 4:1, 1:8, 8:1
   * - Supported resolution tiers: 1K, 2K, 4K
   */
  | "nanobanana-2"
  /**
   * - Provider/slug: openrouter/google/gemini-3.1-flash-lite-image
   * - Aspect ratio: 21:9, 16:9, 3:2, 4:3, 5:4, 1:1, 4:5, 3:4, 2:3, 9:16, 1:4, 4:1, 1:8, 8:1
   * - Resolution: 1K
   */
  | "nanobanana-2-lite"
  /**
   * - Aspect ratio: 21:9, 16:9, 3:2, 4:3, 5:4, 1:1, 4:5, 3:4, 2:3, 9:16
   * - Supported resolution tiers: 1K, 2K, 4K
   */
  | "nanobanana-pro"
  /**
   * - Aspect ratio: 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 2:1, 1:2, 19.5:9,
   *   9:19.5, 20:9, 9:20
   */
  | "grok-imagine-image"
  /**
   * - Aspect ratio: 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 2:1, 1:2, 19.5:9,
   *   9:19.5, 20:9, 9:20
   */
  | "grok-imagine-image-pro";

type SupportedVideoModelId =
  /**
   * - Modes: text-to-video, image-to-video
   * - Duration: 1-15s
   * - Aspect ratio: 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3
   * - Resolution: 1280x720, 854x480, 640x480
   */
  "grok-imagine-video";

const GPT_IMAGE_ALLOWED_ASPECT_RATIOS = ["1:1", "3:2", "2:3"] as const;
const GPT_IMAGE_STANDARD_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;
const GPT_IMAGE_2_MIN_PIXELS = 655_360;
const GPT_IMAGE_2_MAX_PIXELS = 8_294_400;
const GPT_IMAGE_2_MAX_EDGE = 3840;
const GPT_IMAGE_2_MAX_ASPECT_RATIO = 3;

const NANOBANANA_ALLOWED_ASPECT_RATIOS = [
  "21:9",
  "16:9",
  "3:2",
  "4:3",
  "5:4",
  "1:1",
  "4:5",
  "3:4",
  "2:3",
  "9:16",
] as const;

const NANOBANANA_2_ALLOWED_ASPECT_RATIOS = [
  ...NANOBANANA_ALLOWED_ASPECT_RATIOS,
  "1:4",
  "4:1",
  "1:8",
  "8:1",
] as const;

const GROK_IMAGE_ALLOWED_ASPECT_RATIOS = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "2:1",
  "1:2",
  "19.5:9",
  "9:19.5",
  "20:9",
  "9:20",
] as const;

export const DEFAULT_IMAGE_MODEL_FALLBACK_ORDER: readonly SupportedImageModelId[] = [
  "gpt-image-2",
  "nanobanana-2",
  "nanobanana-pro",
  "gpt-5-image",
  "grok-imagine-image-pro",
  "grok-imagine-image",
  "nanobanana-2-lite",
  "nanobanana",
];

const GROK_VIDEO_ALLOWED_ASPECT_RATIOS = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
] as const;
const GROK_VIDEO_ALLOWED_RESOLUTIONS = ["1280x720", "854x480", "640x480"] as const;
const DEFAULT_VIDEO_MODEL_FALLBACK_ORDER: readonly SupportedVideoModelId[] = ["grok-imagine-video"];
const DEFAULT_IMAGE_OUTPUT_BASENAME = "generated-image";

const optionalNonEmptyStringListInputSchema = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .optional()
  .transform((value) => {
    if (value === undefined) return undefined;
    return Array.isArray(value) ? value : [value];
  });

export const imageGenerateInputSchema = z
  .object({
    outputDir: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional output directory. Defaults to current working directory. File extension is inferred from returned MIME type.",
      ),

    prompt: z.string().min(1).describe("Text prompt for image generation/editing"),

    inputImages: optionalNonEmptyStringListInputSchema.describe(
      "Optional local input image path(s) for image editing/variations.",
    ),

    maskImage: z
      .string()
      .min(1)
      .optional()
      .describe("Optional local mask image path for inpainting (applies to first input image)."),

    model: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Image model to use. Recommended/default: gpt-image-2 when available; otherwise picks the first configured fallback.",
      ),

    size: z
      .string()
      .regex(/^\d+x\d+$/)
      .optional()
      .describe(
        [
          "Optional output size as '{width}x{height}'. (Use only one of --size or --aspect-ratio)",
          "- For gpt-image-2 generation: both edges must be multiples of 16 and <=3840, ratio <=3:1, and total pixels 655360-8294400. Edits use 1024x1024 | 1536x1024 | 1024x1536.",
          "- For gpt-5-image: 1024x1024 | 1536x1024 | 1024x1536.",
          "- For nanobanana(-2|-pro): calculate based-on 1K, 2K, 4K. E.g.,",
          "  - 1:1 @ 1K/2K/4K: 1024^2 / 2048^2 / 4096^2",
          "  - 16:9 @ 4K: about 7282 x 4096",
          "  - 9:16 @ 4K: about 4096 x 7282",
        ].join("\n"),
      ),

    aspectRatio: z
      .string()
      .min(1)
      .optional()
      .describe(
        [
          "Optional aspect ratio. (Use only one of --size or --aspect-ratio)",
          "- For gpt-image-2/gpt-5-image: 1:1 | 3:2 | 2:3.",
          "- For nanobanana/nanobanana-pro: 21:9 | 16:9 | 3:2 | 4:3 | 5:4 | 1:1 | 4:5 | 3:4 | 2:3 | 9:16.",
          "- For nanobanana-2/nanobanana-2-lite: 21:9 | 16:9 | 3:2 | 4:3 | 5:4 | 1:1 | 4:5 | 3:4 | 2:3 | 9:16 | 1:4 | 4:1 | 1:8 | 8:1.",
          "- For grok-imagine-image(-pro): 1:1 | 16:9 | 9:16 | 4:3 | 3:4 | 3:2 | 2:3 | 2:1 | 1:2 | 19.5:9 | 9:19.5 | 20:9 | 9:20.",
        ].join("\n"),
      ),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.size && input.aspectRatio) {
      ctx.addIssue({
        code: "custom",
        message: "Provide only one of size or aspectRatio (not both).",
      });
    }

    if (input.maskImage && (!input.inputImages || input.inputImages.length === 0)) {
      ctx.addIssue({
        code: "custom",
        path: ["maskImage"],
        message: "maskImage requires inputImages.",
      });
    }
  });

export const videoGenerateInputSchema = z.object({
  path: z.string().min(1).describe("Output file path to write the generated video"),

  prompt: z.string().min(1).describe("Text prompt for video generation"),

  inputImage: z
    .string()
    .min(1)
    .optional()
    .describe("Optional local input image path for image-to-video generation."),

  model: z
    .string()
    .min(1)
    .optional()
    .describe("Video model to use. If omitted, picks first configured model in fallback order."),

  aspectRatio: z
    .string()
    .regex(/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/)
    .optional()
    .describe("Optional output aspect ratio (text-to-video and image-to-video)."),

  resolution: z
    .string()
    .regex(/^\d+x\d+$/)
    .optional()
    .describe("Optional output resolution. For grok-imagine-video: 1280x720 | 854x480 | 640x480."),

  duration: z.coerce
    .number()
    .int()
    .min(1)
    .max(15)
    .optional()
    .describe("Optional duration in seconds. For grok-imagine-video: 1-15."),
});

type ImageGenerateInput = z.infer<typeof imageGenerateInputSchema>;
type VideoGenerateInput = z.infer<typeof videoGenerateInputSchema>;

type ImageGenerationPrompt =
  | string
  | {
      text: string;
      images: DataContent[];
      mask?: DataContent;
    };

type VideoModelObject = Exclude<Parameters<typeof generateVideo>[0]["model"], string>;
type GenerationProvider = "openai" | "openrouter" | "xai" | "vercel";

type ModelDescriptor<TId extends string, TModel, TInput> = {
  id: TId;
  createModel: (providers: ReturnType<typeof getModelProviders>) => TModel | undefined;
  validateInput: (input: TInput) => ResultType<void, ServerToolFailure>;
};

type ImageModelDescriptor = ModelDescriptor<SupportedImageModelId, ImageModel, ImageGenerateInput>;
type VideoModelDescriptor = ModelDescriptor<
  SupportedVideoModelId,
  VideoModelObject,
  VideoGenerateInput
>;

function hasConfiguredProviderValue(config: {
  readonly apiKey: string | undefined;
  readonly baseUrl: string | undefined;
}): boolean {
  return Boolean(config.apiKey?.trim() || config.baseUrl?.trim());
}

function isConfiguredProvider(provider: GenerationProvider): boolean {
  switch (provider) {
    case "openai":
      return hasConfiguredProviderValue(env.providers.openai);
    case "openrouter":
      return hasConfiguredProviderValue(env.providers.openrouter);
    case "xai":
      return hasConfiguredProviderValue(env.providers.xai);
    case "vercel":
      return hasConfiguredProviderValue(env.providers.vercel);
  }
}

function isOneOf<const T extends readonly string[]>(allowed: T, value: string): value is T[number] {
  return (allowed as readonly string[]).includes(value);
}

function validateGptImageInput(
  input: ImageGenerateInput,
  modelId: "gpt-image-2" | "gpt-5-image",
): ResultType<void, ServerToolFailure> {
  if (input.aspectRatio && !isOneOf(GPT_IMAGE_ALLOWED_ASPECT_RATIOS, input.aspectRatio)) {
    return Result.err(
      generateFailure(
        "usage",
        `Unsupported aspectRatio '${input.aspectRatio}' for ${modelId}. Allowed: ${GPT_IMAGE_ALLOWED_ASPECT_RATIOS.join(", ")}.`,
      ),
    );
  }

  if (!input.size) return Result.ok(undefined);

  if (modelId === "gpt-5-image" || (input.inputImages?.length ?? 0) > 0) {
    if (isOneOf(GPT_IMAGE_STANDARD_SIZES, input.size)) return Result.ok(undefined);

    const context = modelId === "gpt-image-2" ? " image edits" : "";
    return Result.err(
      generateFailure(
        "usage",
        `Unsupported size '${input.size}' for ${modelId}${context}. Allowed: ${GPT_IMAGE_STANDARD_SIZES.join(" | ")}.`,
      ),
    );
  }

  const separatorIndex = input.size.indexOf("x");
  const width = Number(input.size.slice(0, separatorIndex));
  const height = Number(input.size.slice(separatorIndex + 1));
  const pixels = width * height;
  if (
    width % 16 !== 0 ||
    height % 16 !== 0 ||
    width > GPT_IMAGE_2_MAX_EDGE ||
    height > GPT_IMAGE_2_MAX_EDGE ||
    Math.max(width, height) / Math.min(width, height) > GPT_IMAGE_2_MAX_ASPECT_RATIO ||
    pixels < GPT_IMAGE_2_MIN_PIXELS ||
    pixels > GPT_IMAGE_2_MAX_PIXELS
  ) {
    return Result.err(
      generateFailure(
        "usage",
        `Unsupported size '${input.size}' for gpt-image-2. Both edges must be multiples of 16 and at most ${GPT_IMAGE_2_MAX_EDGE}px, the aspect ratio must not exceed 3:1, and total pixels must be ${GPT_IMAGE_2_MIN_PIXELS}-${GPT_IMAGE_2_MAX_PIXELS}.`,
      ),
    );
  }
  return Result.ok(undefined);
}

function validateNanobananaInput(
  input: ImageGenerateInput,
  modelId: "nanobanana" | "nanobanana-2" | "nanobanana-2-lite" | "nanobanana-pro",
): ResultType<void, ServerToolFailure> {
  const allowedAspectRatios =
    modelId === "nanobanana-2" || modelId === "nanobanana-2-lite"
      ? NANOBANANA_2_ALLOWED_ASPECT_RATIOS
      : NANOBANANA_ALLOWED_ASPECT_RATIOS;

  if (input.aspectRatio && !isOneOf(allowedAspectRatios, input.aspectRatio)) {
    return Result.err(
      generateFailure(
        "usage",
        `Unsupported aspectRatio '${input.aspectRatio}' for ${modelId}. Allowed: ${allowedAspectRatios.join(", ")}.`,
      ),
    );
  }

  if (modelId === "nanobanana-2-lite" && input.size) {
    return Result.err(
      generateFailure(
        "usage",
        "nanobanana-2-lite produces 1K output; use aspectRatio instead of size.",
      ),
    );
  }

  if (modelId === "nanobanana-2-lite" && input.maskImage) {
    return Result.err(generateFailure("usage", "nanobanana-2-lite does not support maskImage."));
  }
  return Result.ok(undefined);
}

export function validateImageGenerationInputForModel(
  modelId: SupportedImageModelId,
  input: ImageGenerateInput,
): ResultType<void, ServerToolFailure> {
  switch (modelId) {
    case "gpt-image-2":
    case "gpt-5-image":
      return validateGptImageInput(input, modelId);
    case "nanobanana":
    case "nanobanana-2":
    case "nanobanana-2-lite":
    case "nanobanana-pro":
      return validateNanobananaInput(input, modelId);
    case "grok-imagine-image":
    case "grok-imagine-image-pro":
      return validateGrokImagineInput(input, modelId);
  }
}

function validateGrokImagineInput(
  input: ImageGenerateInput,
  modelId: "grok-imagine-image" | "grok-imagine-image-pro",
): ResultType<void, ServerToolFailure> {
  if (input.size) {
    return Result.err(
      generateFailure("usage", `${modelId} does not support size. Use aspectRatio instead.`),
    );
  }

  if (input.aspectRatio && !isOneOf(GROK_IMAGE_ALLOWED_ASPECT_RATIOS, input.aspectRatio)) {
    return Result.err(
      generateFailure(
        "usage",
        `Unsupported aspectRatio '${input.aspectRatio}' for ${modelId}. Allowed: ${GROK_IMAGE_ALLOWED_ASPECT_RATIOS.join(", ")}.`,
      ),
    );
  }

  if (input.maskImage) {
    return Result.err(generateFailure("usage", `${modelId} does not support maskImage.`));
  }

  if ((input.inputImages?.length ?? 0) > 1) {
    return Result.err(generateFailure("usage", `${modelId} supports only one input image.`));
  }
  return Result.ok(undefined);
}

const IMAGE_MODEL_DESCRIPTORS: readonly ImageModelDescriptor[] = [
  {
    id: "gpt-image-2",
    createModel: (providers) => {
      if (isConfiguredProvider("openai")) {
        const model = providers.openai?.image("gpt-image-2");
        if (model) return model;
      }

      if (isConfiguredProvider("openrouter")) {
        return providers.openrouter?.imageModel("openai/gpt-image-2");
      }

      return undefined;
    },
    validateInput: (input) => validateImageGenerationInputForModel("gpt-image-2", input),
  },
  {
    id: "gpt-5-image",
    createModel: (providers) => {
      if (isConfiguredProvider("openai")) {
        const model = providers.openai?.image("gpt-image-1.5");
        if (model) return model;
      }

      if (isConfiguredProvider("openrouter")) {
        return providers.openrouter?.imageModel("openai/gpt-5-image");
      }

      return undefined;
    },
    validateInput: (input) => validateImageGenerationInputForModel("gpt-5-image", input),
  },
  {
    id: "nanobanana",
    createModel: (providers) => {
      if (isConfiguredProvider("openrouter")) {
        return providers.openrouter?.imageModel("google/gemini-2.5-flash-image");
      }
      return undefined;
    },
    validateInput: (input) => validateImageGenerationInputForModel("nanobanana", input),
  },
  {
    id: "nanobanana-2",
    createModel: (providers) => {
      if (isConfiguredProvider("openrouter")) {
        return providers.openrouter?.imageModel("google/gemini-3.1-flash-image-preview");
      }
      return undefined;
    },
    validateInput: (input) => validateImageGenerationInputForModel("nanobanana-2", input),
  },
  {
    id: "nanobanana-2-lite",
    createModel: (providers) => {
      if (isConfiguredProvider("openrouter")) {
        return providers.openrouter?.imageModel("google/gemini-3.1-flash-lite-image");
      }
      return undefined;
    },
    validateInput: (input) => validateImageGenerationInputForModel("nanobanana-2-lite", input),
  },
  {
    id: "nanobanana-pro",
    createModel: (providers) => {
      if (isConfiguredProvider("openrouter")) {
        return providers.openrouter?.imageModel("google/gemini-3-pro-image-preview");
      }
      return undefined;
    },
    validateInput: (input) => validateImageGenerationInputForModel("nanobanana-pro", input),
  },
  {
    id: "grok-imagine-image",
    createModel: (providers) => {
      if (!isConfiguredProvider("xai")) {
        return undefined;
      }
      return providers.xai?.image("grok-imagine-image");
    },
    validateInput: (input) => validateImageGenerationInputForModel("grok-imagine-image", input),
  },
  {
    id: "grok-imagine-image-pro",
    createModel: (providers) => {
      if (!isConfiguredProvider("xai")) {
        return undefined;
      }
      return providers.xai?.image("grok-imagine-image-pro");
    },
    validateInput: (input) => validateImageGenerationInputForModel("grok-imagine-image-pro", input),
  },
];

function validateGrokVideoInput(input: VideoGenerateInput): ResultType<void, ServerToolFailure> {
  if (input.aspectRatio && !isOneOf(GROK_VIDEO_ALLOWED_ASPECT_RATIOS, input.aspectRatio)) {
    return Result.err(
      generateFailure(
        "usage",
        `Unsupported aspectRatio '${input.aspectRatio}' for grok-imagine-video. Allowed: ${GROK_VIDEO_ALLOWED_ASPECT_RATIOS.join(", ")}.`,
      ),
    );
  }

  if (input.resolution && !isOneOf(GROK_VIDEO_ALLOWED_RESOLUTIONS, input.resolution)) {
    return Result.err(
      generateFailure(
        "usage",
        `Unsupported resolution '${input.resolution}' for grok-imagine-video. Allowed: ${GROK_VIDEO_ALLOWED_RESOLUTIONS.join(", ")}.`,
      ),
    );
  }
  return Result.ok(undefined);
}

const VIDEO_MODEL_DESCRIPTORS: readonly VideoModelDescriptor[] = [
  {
    id: "grok-imagine-video",
    createModel: (providers) => {
      if (!isConfiguredProvider("xai")) {
        return undefined;
      }

      const xaiProvider = providers.xai;
      if (!xaiProvider || !("video" in xaiProvider)) {
        return undefined;
      }

      const createVideoModel = xaiProvider.video;
      if (typeof createVideoModel !== "function") {
        return undefined;
      }

      return createVideoModel("grok-imagine-video") as VideoModelObject;
    },
    validateInput: validateGrokVideoInput,
  },
];

function resolveAvailableModels<TId extends string, TModel, TInput>(
  descriptors: readonly ModelDescriptor<TId, TModel, TInput>[],
  providers: ReturnType<typeof getModelProviders>,
): {
  available: Partial<Record<TId, TModel>>;
  byId: Map<TId, ModelDescriptor<TId, TModel, TInput>>;
  ids: TId[];
} {
  const available: Partial<Record<TId, TModel>> = {};
  const byId = new Map<TId, ModelDescriptor<TId, TModel, TInput>>();
  const ids: TId[] = [];

  for (const descriptor of descriptors) {
    const model = descriptor.createModel(providers);
    if (!model) continue;
    available[descriptor.id] = model;
    byId.set(descriptor.id, descriptor);
    ids.push(descriptor.id);
  }

  return {
    available,
    byId,
    ids,
  };
}

function getAvailableImageModels() {
  const providers = getModelProviders();
  return resolveAvailableModels(IMAGE_MODEL_DESCRIPTORS, providers);
}

function getAvailableVideoModels() {
  const providers = getModelProviders();
  return resolveAvailableModels(VIDEO_MODEL_DESCRIPTORS, providers);
}

function pickModel<TId extends string, TModel>(
  available: Partial<Record<TId, TModel>>,
  requested: string | undefined,
  fallbackOrder: readonly TId[],
  modalityLabel: string,
): ResultType<{ id: TId; model: TModel }, ServerToolFailure> {
  if (requested) {
    const model = available[requested as TId];
    if (!model) {
      return Result.err(
        generateFailure(
          "unavailable",
          `Requested model '${requested}' is not available for ${modalityLabel} generation (configured: ${Object.keys(available).join(", ") || "none"}).`,
        ),
      );
    }

    return Result.ok({
      id: requested as TId,
      model,
    });
  }

  for (const id of fallbackOrder) {
    const model = available[id];
    if (model) {
      return Result.ok({ id, model });
    }
  }

  return Result.err(
    generateFailure(
      "unavailable",
      `No ${modalityLabel} generation models are configured. Configure at least one provider for ${modalityLabel} generation.`,
    ),
  );
}

export function gptAspectRatioToSize(
  aspectRatio: (typeof GPT_IMAGE_ALLOWED_ASPECT_RATIOS)[number],
): (typeof GPT_IMAGE_STANDARD_SIZES)[number] {
  switch (aspectRatio) {
    case "1:1":
      return "1024x1024";
    case "3:2":
      return "1536x1024";
    case "2:3":
      return "1024x1536";
  }
}

export function orderImageModelIds(ids: readonly SupportedImageModelId[]): SupportedImageModelId[] {
  const available = new Set(ids);
  return DEFAULT_IMAGE_MODEL_FALLBACK_ORDER.filter((id) => available.has(id));
}

export function resolveImageDimensions(
  modelId: SupportedImageModelId,
  input: Pick<ImageGenerateInput, "size" | "aspectRatio">,
): {
  size?: `${number}x${number}`;
  aspectRatio?: `${number}:${number}`;
} {
  if (input.size) {
    return { size: input.size as `${number}x${number}` };
  }

  if (!input.aspectRatio) return {};

  if (modelId === "gpt-image-2" || modelId === "gpt-5-image") {
    return {
      size: gptAspectRatioToSize(
        input.aspectRatio as (typeof GPT_IMAGE_ALLOWED_ASPECT_RATIOS)[number],
      ),
    };
  }

  return { aspectRatio: input.aspectRatio as `${number}:${number}` };
}

function looksLikeSvg(bytes: Buffer): boolean {
  const prefix = bytes.subarray(0, 1024).toString("utf8").trimStart().toLowerCase();
  return prefix.startsWith("<svg") || prefix.startsWith("<?xml");
}

async function readImageDataFromPath(
  path: string,
  displayPath = path,
): Promise<ResultType<Buffer, ServerToolFailure>> {
  const read = await settleCapturedPromise(
    Result.tryPromise({
      try: () => fs.readFile(path),
      catch: captureGenerateFailure,
    }),
    (cause) => {
      if (Panic.is(cause)) return preserveToolPanic(cause);
      return generateFailure(
        typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"
          ? "not_found"
          : "unavailable",
        errorMessage(cause),
      );
    },
  );
  return Result.gen(async function* () {
    const bytes = yield* read;
    const typeFromBytes = yield* Result.await(
      settleCapturedPromise(
        Result.tryPromise({
          try: () => fileTypeFromBuffer(bytes),
          catch: captureGenerateFailure,
        }),
        (cause) => {
          if (Panic.is(cause)) return preserveToolPanic(cause);
          return generateFailure("unavailable", errorMessage(cause));
        },
      ),
    );

    if (typeFromBytes?.mime?.startsWith("image/")) {
      return Result.ok(bytes);
    }

    const mimeFromExtension = inferMimeTypeFromFilename(path);
    if (mimeFromExtension === "image/svg+xml" && looksLikeSvg(bytes)) {
      return Result.ok(bytes);
    }

    return Result.err(
      generateFailure("usage", `Input file '${displayPath}' is not a valid image file.`),
    );
  });
}

export async function resolveImageEditInputs(
  cwd: string,
  input: {
    inputImages?: readonly string[];
    maskImage?: string;
  },
  context?: RequestContext,
): Promise<
  ResultType<
    | {
        images: DataContent[];
        mask?: DataContent;
      }
    | undefined,
    ServerToolFailure
  >
> {
  if (!input.inputImages || input.inputImages.length === 0) {
    return Result.ok(undefined);
  }

  return Result.gen(async function* () {
    const images: DataContent[] = [];
    for (const imagePath of input.inputImages ?? []) {
      const resolved = yield* settleCapturedError(
        Result.try({
          try: () => resolveToolPathForRequestContext({ cwd, inputPath: imagePath, context }),
          catch: captureGenerateFailure,
        }),
        (cause) => {
          if (Panic.is(cause)) return preserveToolPanic(cause);
          return generateFailure("denied", errorMessage(cause));
        },
      );
      images.push(
        yield* Result.await(
          readImageDataFromPath(
            resolved,
            formatToolPathForRequestContext({ path: resolved, context }),
          ),
        ),
      );
    }

    if (!input.maskImage) return Result.ok({ images });

    const resolvedMask = yield* settleCapturedError(
      Result.try({
        try: () =>
          resolveToolPathForRequestContext({
            cwd,
            inputPath: input.maskImage!,
            context,
          }),
        catch: captureGenerateFailure,
      }),
      (cause) => {
        if (Panic.is(cause)) return preserveToolPanic(cause);
        return generateFailure("denied", errorMessage(cause));
      },
    );
    const mask = yield* Result.await(
      readImageDataFromPath(
        resolvedMask,
        formatToolPathForRequestContext({ path: resolvedMask, context }),
      ),
    );
    return Result.ok({ images, mask });
  });
}

export async function buildImageGenerationPrompt(
  cwd: string,
  input: {
    prompt: string;
    inputImages?: readonly string[];
    maskImage?: string;
  },
  context?: RequestContext,
): Promise<ResultType<ImageGenerationPrompt, ServerToolFailure>> {
  return (await resolveImageEditInputs(cwd, input, context)).map((editInputs) =>
    editInputs
      ? { text: input.prompt, images: editInputs.images, mask: editInputs.mask }
      : input.prompt,
  );
}

export async function buildVideoGenerationPrompt(
  cwd: string,
  input: {
    prompt: string;
    inputImage?: string;
  },
  context?: RequestContext,
): Promise<ResultType<GenerateVideoPrompt, ServerToolFailure>> {
  if (!input.inputImage) {
    return Result.ok(input.prompt);
  }

  return Result.gen(async function* () {
    const resolvedImage = yield* settleCapturedError(
      Result.try({
        try: () =>
          resolveToolPathForRequestContext({
            cwd,
            inputPath: input.inputImage!,
            context,
          }),
        catch: captureGenerateFailure,
      }),
      (cause) => {
        if (Panic.is(cause)) return preserveToolPanic(cause);
        return generateFailure("denied", errorMessage(cause));
      },
    );
    const image = yield* Result.await(
      readImageDataFromPath(
        resolvedImage,
        formatToolPathForRequestContext({ path: resolvedImage, context }),
      ),
    );
    return Result.ok({ text: input.prompt, image });
  });
}

async function writeFileWithUniqueName(
  targetPath: string,
  bytes: Uint8Array,
): Promise<ResultType<string, ServerToolFailure>> {
  const ext = extname(targetPath);
  const base = ext ? targetPath.slice(0, -ext.length) : targetPath;

  for (let i = 0; i < 10_000; i++) {
    const candidate = i === 0 ? targetPath : `${base} (${i})${ext}`;
    {
      const attempt = await Result.tryPromise({
        try: async () => {
          await fs.writeFile(candidate, bytes, { flag: "wx" });
          return Result.ok(candidate);
        },
        catch: captureError,
      });

      if (attempt.isErr()) {
        const error = attempt.error.cause;
        if (Panic.is(error)) return preserveToolPanic(error);
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? (error.code as string | undefined)
            : undefined;
        if (code === "EEXIST") {
          continue;
        }
        return Result.err(generateFailure("unavailable", errorMessage(error)));
      }
      return attempt.value;
    }
  }

  return Result.err(
    generateFailure("conflict", `Failed to find an available filename for: ${targetPath}`),
  );
}

export function generateImageWithModel(
  model: ImageModel,
  prompt: ImageGenerationPrompt,
  opts?: {
    abortSignal?: AbortSignal;
    size?: `${number}x${number}`;
    aspectRatio?: `${number}:${number}`;
    maxRetries?: number;
    providerOptions?: Parameters<typeof generateImage>[0]["providerOptions"];
  },
) {
  return generateImage({
    model,
    prompt,
    abortSignal: opts?.abortSignal,
    size: opts?.size,
    aspectRatio: opts?.aspectRatio,
    maxRetries: opts?.maxRetries,
    providerOptions: opts?.providerOptions,
  });
}

export function generateVideoWithModel(
  model: VideoModelObject,
  prompt: GenerateVideoPrompt,
  opts?: {
    abortSignal?: AbortSignal;
    aspectRatio?: `${number}:${number}`;
    resolution?: `${number}x${number}`;
    duration?: number;
  },
) {
  return generateVideo({
    model,
    prompt,
    abortSignal: opts?.abortSignal,
    aspectRatio: opts?.aspectRatio,
    resolution: opts?.resolution,
    duration: opts?.duration,
  });
}

export class Generate implements ServerTool {
  id = "generate";

  constructor(
    private readonly options: {
      readonly getConfig?: () => Pick<CoreConfig, "tools"> | Promise<Pick<CoreConfig, "tools">>;
    } = {},
  ) {}

  private readonly tool = defineServerTool({
    id: this.id,
    callables: ({ callable }) => ({
      "generate.image": callable({
        name: "Generate Image",
        description:
          "Generate or edit an image with a configured provider and write it to a local file in outputDir (or cwd). Returns absolute output path + MIME type. " +
          "Recommended/default: gpt-image-2 when available.",
        inputSchema: imageGenerateInputSchema,
        validation: "zod",
        primaryPositional: "prompt",
        catalog: async () => {
          const config = await this.options.getConfig?.();
          const imageConfig = config?.tools.generate.image;
          const routing = resolveImageRouting({
            imageConfig,
            descriptors: IMAGE_MODEL_DESCRIPTORS,
            resolveDefaultModels: getAvailableImageModels,
          });
          const imageModels = orderImageModelIds(routing.catalogModelIds);
          if (imageModels.length === 0) return false;
          return {
            description:
              "Generate or edit an image with a configured provider and write it to a local file in outputDir (or cwd). Returns absolute output path + MIME type. " +
              "Recommended/default: gpt-image-2 when available. " +
              `Available models: ${imageModels.join(", ")}`,
          };
        },
        run: (input, opts) => this.callGenerateImage(input, opts),
      }),
      "generate.video": callable({
        name: "Generate Video",
        description: "Generate a video with a configured provider and write it to a local file.",
        inputSchema: videoGenerateInputSchema,
        validation: "zod",
        catalog: () => {
          const videoModels = getAvailableVideoModels().ids;
          if (videoModels.length === 0) return false;
          return {
            description:
              "Generate a video with a configured provider and write it to a local file. " +
              `Available models: ${videoModels.join(", ")}`,
          };
        },
        run: (input, opts) => this.callGenerateVideo(input, opts),
      }),
    }),
  });

  async init(): Promise<void> {
    await this.tool.init();
  }

  async destroy(): Promise<void> {
    await this.tool.destroy();
  }

  async list() {
    return this.tool.list();
  }

  async call(
    callableId: string,
    input: Record<string, unknown>,
    opts?: ServerToolCallOptions,
  ): Promise<ServerToolResult> {
    return this.tool.call(callableId, input, opts);
  }

  private async callGenerateImage(
    payload: ImageGenerateInput,
    opts?: ServerToolCallOptions,
  ): Promise<ServerToolResult> {
    return Result.gen(
      async function* (this: Generate) {
        const config = await this.options.getConfig?.();
        const imageConfig = config?.tools.generate.image;
        const routing = resolveImageRouting({
          imageConfig,
          descriptors: IMAGE_MODEL_DESCRIPTORS,
          resolveDefaultModels: getAvailableImageModels,
        });
        if (routing.configurationError) {
          return Result.err(generateFailure("usage", routing.configurationError));
        }
        const availableModels = routing.availableModels();
        const picked = yield* pickModel(
          availableModels.available,
          payload.model,
          DEFAULT_IMAGE_MODEL_FALLBACK_ORDER,
          "image",
        );

        const descriptor = availableModels.byId.get(picked.id);
        if (!descriptor) {
          return Result.err(
            generateFailure("internal", `Model descriptor not found for '${picked.id}'.`),
          );
        }
        yield* descriptor.validateInput(payload);

        const cwd = opts?.context?.cwd ?? process.cwd();
        const resolvedOutputDir = yield* settleCapturedError(
          Result.try({
            try: () =>
              resolveToolPathForRequestContext({
                cwd,
                inputPath:
                  payload.outputDir ?? (opts?.context?.safetyMode === "restricted" ? "/tmp" : "."),
                context: opts?.context,
              }),
            catch: captureGenerateFailure,
          }),
          (cause) => {
            if (Panic.is(cause)) return preserveToolPanic(cause);
            return generateFailure("denied", errorMessage(cause));
          },
        );

        const generationOptions = routing.generationOptions(
          resolveImageDimensions(picked.id, payload),
        );
        const prompt = yield* Result.await(buildImageGenerationPrompt(cwd, payload, opts?.context));

        const res = yield* Result.await(
          settleCapturedPromise(
            Result.tryPromise({
              try: () =>
                generateImageWithModel(picked.model, prompt, {
                  abortSignal: opts?.signal,
                  ...generationOptions,
                }),
              catch: captureGenerateFailure,
            }),
            (cause) => {
              if (Panic.is(cause)) return preserveToolPanic(cause);
              return generateFailure(
                opts?.signal?.aborted ? "cancelled" : "unavailable",
                errorMessage(cause),
              );
            },
          ),
        );

        const image = res.image;
        const inferredExt = inferExtensionFromMimeType(image.mediaType) || ".png";
        const targetWithExt = join(
          resolvedOutputDir,
          `${DEFAULT_IMAGE_OUTPUT_BASENAME}${inferredExt}`,
        );

        yield* Result.await(
          settleCapturedPromise(
            Result.tryPromise({
              try: () => fs.mkdir(dirname(targetWithExt), { recursive: true }),
              catch: captureGenerateFailure,
            }),
            (cause) => {
              if (Panic.is(cause)) return preserveToolPanic(cause);
              return generateFailure("unavailable", errorMessage(cause));
            },
          ),
        );
        const outPath = yield* Result.await(
          writeFileWithUniqueName(targetWithExt, image.uint8Array),
        );

        return Result.ok({
          ok: true as const,
          path: formatToolPathForRequestContext({ path: outPath, context: opts?.context }),
          bytes: image.uint8Array.byteLength,
          mimeType: image.mediaType,
          model: picked.id,
          warnings: res.warnings,
        });
      }.bind(this),
    );
  }

  private async callGenerateVideo(
    payload: VideoGenerateInput,
    opts?: ServerToolCallOptions,
  ): Promise<ServerToolResult> {
    return Result.gen(
      async function* (this: Generate) {
        const availableModels = getAvailableVideoModels();
        const picked = yield* pickModel(
          availableModels.available,
          payload.model,
          DEFAULT_VIDEO_MODEL_FALLBACK_ORDER,
          "video",
        );

        const descriptor = availableModels.byId.get(picked.id);
        if (!descriptor) {
          return Result.err(
            generateFailure("internal", `Model descriptor not found for '${picked.id}'.`),
          );
        }
        yield* descriptor.validateInput(payload);

        const cwd = opts?.context?.cwd ?? process.cwd();
        const resolvedTarget = yield* settleCapturedError(
          Result.try({
            try: () =>
              resolveToolPathForRequestContext({
                cwd,
                inputPath: payload.path,
                context: opts?.context,
              }),
            catch: captureGenerateFailure,
          }),
          (cause) => {
            if (Panic.is(cause)) return preserveToolPanic(cause);
            return generateFailure("denied", errorMessage(cause));
          },
        );

        const prompt = yield* Result.await(
          buildVideoGenerationPrompt(
            cwd,
            {
              prompt: payload.prompt,
              inputImage: payload.inputImage,
            },
            opts?.context,
          ),
        );

        const res = yield* Result.await(
          settleCapturedPromise(
            Result.tryPromise({
              try: () =>
                generateVideoWithModel(picked.model, prompt, {
                  abortSignal: opts?.signal,
                  aspectRatio: payload.aspectRatio as `${number}:${number}` | undefined,
                  resolution: payload.resolution as `${number}x${number}` | undefined,
                  duration: payload.duration,
                }),
              catch: captureGenerateFailure,
            }),
            (cause) => {
              if (Panic.is(cause)) return preserveToolPanic(cause);
              return generateFailure(
                opts?.signal?.aborted ? "cancelled" : "unavailable",
                errorMessage(cause),
              );
            },
          ),
        );

        const video = res.video;
        const originalExt = extname(resolvedTarget);
        const inferredExt = inferExtensionFromMimeType(video.mediaType) || ".mp4";
        const targetWithExt =
          originalExt.length > 0 ? resolvedTarget : `${resolvedTarget}${inferredExt}`;
        yield* Result.await(
          settleCapturedPromise(
            Result.tryPromise({
              try: () => fs.mkdir(dirname(targetWithExt), { recursive: true }),
              catch: captureGenerateFailure,
            }),
            (cause) => {
              if (Panic.is(cause)) return preserveToolPanic(cause);
              return generateFailure("unavailable", errorMessage(cause));
            },
          ),
        );
        const outPath = yield* Result.await(
          writeFileWithUniqueName(targetWithExt, video.uint8Array),
        );

        return Result.ok({
          ok: true as const,
          path: formatToolPathForRequestContext({ path: outPath, context: opts?.context }),
          bytes: video.uint8Array.byteLength,
          mimeType: video.mediaType,
          model: picked.id,
          warnings: res.warnings,
          providerMetadata: res.providerMetadata,
        });
      }.bind(this),
    );
  }
}
