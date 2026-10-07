import type { DataContent } from "ai";
import { z } from "zod";

import {
  DEFAULT_IMAGE_MODEL_FALLBACK_ORDER,
  GPT_IMAGE_2_MAX_EDGE,
  GPT_IMAGE_2_MAX_PIXELS,
  GPT_IMAGE_2_MIN_PIXELS,
  GPT_IMAGE_STANDARD_SIZES,
  IMAGE_MODEL_CATALOG,
  IMAGE_MODEL_IDS,
  type SupportedImageModelId,
} from "./catalog";

type AspectRatioGroup = {
  readonly aliases: SupportedImageModelId[];
  readonly ratios: readonly string[];
};

/** Groups aliases that accept the same ratios, in catalog order, for the help text. */
function aspectRatioGroups(): AspectRatioGroup[] {
  const groups = new Map<string, AspectRatioGroup>();
  for (const modelId of IMAGE_MODEL_IDS) {
    const ratios = IMAGE_MODEL_CATALOG[modelId].aspectRatios;
    const group = groups.get(ratios.join("|"));
    if (group) {
      group.aliases.push(modelId);
      continue;
    }
    groups.set(ratios.join("|"), { aliases: [modelId], ratios });
  }
  return [...groups.values()];
}

const SIZE_ONLY_BY_RATIO_ALIASES = IMAGE_MODEL_IDS.filter(
  (modelId) => IMAGE_MODEL_CATALOG[modelId].size.kind === "unsupported",
);

const SIZE_DESCRIPTION = [
  "Optional output size as '{width}x{height}'. (Use only one of --size or --aspect-ratio)",
  `- For gpt-image-2 generation: both edges must be multiples of 16 and <=${GPT_IMAGE_2_MAX_EDGE}, ratio <=3:1, and total pixels ${GPT_IMAGE_2_MIN_PIXELS}-${GPT_IMAGE_2_MAX_PIXELS}. Edits use ${GPT_IMAGE_STANDARD_SIZES.join(" | ")}.`,
  `- For gpt-5-image: ${GPT_IMAGE_STANDARD_SIZES.join(" | ")}.`,
  "- For nanobanana(-2|-pro): calculate based-on 1K, 2K, 4K. E.g.,",
  "  - 1:1 @ 1K/2K/4K: 1024^2 / 2048^2 / 4096^2",
  "  - 16:9 @ 4K: about 7282 x 4096",
  "  - 9:16 @ 4K: about 4096 x 7282",
  `- ${SIZE_ONLY_BY_RATIO_ALIASES.join(", ")}: not supported; use --aspect-ratio instead.`,
].join("\n");

const ASPECT_RATIO_DESCRIPTION = [
  "Optional aspect ratio. (Use only one of --size or --aspect-ratio)",
  ...aspectRatioGroups().map(
    ({ aliases, ratios }) => `- For ${aliases.join("/")}: ${ratios.join(" | ")}.`,
  ),
].join("\n");

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
        `Image model to use. Recommended/default: ${DEFAULT_IMAGE_MODEL_FALLBACK_ORDER[0]} when available; otherwise picks the first configured fallback.`,
      ),

    size: z
      .string()
      .regex(/^\d+x\d+$/)
      .optional()
      .describe(SIZE_DESCRIPTION),

    aspectRatio: z.string().min(1).optional().describe(ASPECT_RATIO_DESCRIPTION),
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

export type ImageGenerateInput = z.infer<typeof imageGenerateInputSchema>;

export type ImageGenerationPrompt =
  | string
  | {
      text: string;
      images: DataContent[];
      mask?: DataContent;
    };
