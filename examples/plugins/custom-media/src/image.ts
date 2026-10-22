import path from "node:path";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateImage } from "ai";
import type { CustomMediaConfig } from "./config";
import { resolveCredentials } from "./config";
import type { ToolCallOptions } from "./contracts";
import { asCustomMediaError, CustomMediaError } from "./errors";
import { imageExtensionForMime, readValidatedImage } from "./media";
import { resolveImageDimensions, validateImageModelInput } from "./models";
import { formatToolPath, prepareOutputDirectory, resolveToolPath, writeUniqueFile } from "./paths";
import { imageInputSchema, imageOutputSchema, type ImageOutput } from "./schemas";
import { createCallSignal } from "./signal";
import { parseWithSchema } from "./errors";

type GenerateImagePrompt = Parameters<typeof generateImage>[0]["prompt"];

async function buildPrompt(
  input: ReturnType<typeof imageInputSchema.parse>,
  cwd: string,
  options?: ToolCallOptions,
): Promise<GenerateImagePrompt> {
  if (!input.inputImages?.length) return input.prompt;
  const images: Uint8Array[] = [];
  for (const imagePath of input.inputImages) {
    const resolved = resolveToolPath({ cwd, inputPath: imagePath, context: options?.context });
    images.push(
      (await readValidatedImage({ filePath: resolved, context: options?.context })).bytes,
    );
  }
  let mask: Uint8Array | undefined;
  if (input.maskImage) {
    const resolved = resolveToolPath({
      cwd,
      inputPath: input.maskImage,
      context: options?.context,
    });
    mask = (await readValidatedImage({ filePath: resolved, context: options?.context })).bytes;
  }
  return { text: input.prompt, images, mask };
}

export async function generateCustomImage(
  rawInput: Record<string, unknown>,
  config: CustomMediaConfig,
  options?: ToolCallOptions,
): Promise<ImageOutput> {
  const input = parseWithSchema(imageInputSchema, rawInput, "custom-media.image input");
  const registration = validateImageModelInput(input);
  const credentials = resolveCredentials(config);
  const cwd = options?.context?.cwd ?? process.cwd();
  const callSignal = createCallSignal(options?.signal, input.timeoutMs);

  try {
    const prompt = await buildPrompt(input, cwd, options);
    const dimensions = resolveImageDimensions(input);
    const provider = createOpenAICompatible({
      name: "customMedia",
      baseURL: credentials.baseURL,
      apiKey: credentials.apiKey,
    });
    const result = await generateImage({
      model: provider.imageModel(registration.route),
      prompt,
      size: dimensions.size,
      providerOptions: dimensions.aspectRatio
        ? { customMedia: { aspect_ratio: dimensions.aspectRatio } }
        : undefined,
      maxRetries: 0,
      abortSignal: callSignal.signal,
    });

    const bytes = result.image.uint8Array;
    const extension = imageExtensionForMime(result.image.mediaType, bytes);
    const outputDir = resolveToolPath({
      cwd,
      inputPath: input.outputDir ?? (options?.context?.safetyMode === "restricted" ? "/tmp" : "."),
      context: options?.context,
    });
    const realOutputDir = await prepareOutputDirectory(outputDir, options?.context);
    const outputPath = await writeUniqueFile(
      path.join(realOutputDir, `custom-media-image${extension}`),
      bytes,
    );
    return imageOutputSchema.parse({
      ok: true,
      path: formatToolPath(outputPath, options?.context),
      bytes: bytes.byteLength,
      mimeType: result.image.mediaType,
      model: input.model,
      route: registration.route,
      warnings: result.warnings,
    });
  } catch (error) {
    if (callSignal.signal.aborted) callSignal.mapAbort(error);
    if (error instanceof CustomMediaError) throw error;
    throw asCustomMediaError(error, "PROVIDER_ERROR", "Image generation failed", [
      credentials.apiKey,
    ]);
  } finally {
    callSignal.cleanup();
  }
}
