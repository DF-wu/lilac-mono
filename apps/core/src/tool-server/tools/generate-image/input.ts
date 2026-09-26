import type { DataContent } from "ai";
import { z } from "zod";

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

export type ImageGenerateInput = z.infer<typeof imageGenerateInputSchema>;

export type ImageGenerationPrompt =
  | string
  | {
      text: string;
      images: DataContent[];
      mask?: DataContent;
    };
