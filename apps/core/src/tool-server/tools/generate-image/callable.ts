import { errorMessage, type CoreConfig } from "@stanley2058/lilac-utils";
import type {
  ServerToolCallableDefinition,
  ServerToolResult,
} from "@stanley2058/lilac-plugin-runtime";
import { Panic, Result } from "better-result";
import { generateImage, type ImageModel } from "ai";
import fs from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  formatToolPathForRequestContext,
  inferExtensionFromMimeType,
  resolveToolPathForRequestContext,
} from "../../../shared/attachment-utils";
import { preserveToolPanic } from "../../../tools/tool-result-adapters";
import type { RegisteredSurfacePlatform } from "../../../surface/types";
import type { ServerToolCallOptions } from "../../types";
import {
  captureGenerateFailure,
  generateFailure,
  pickModel,
  settleCapturedError,
  settleCapturedPromise,
  writeFileWithUniqueName,
} from "../generate";
import {
  imageGenerateInputSchema,
  type ImageGenerateInput,
  type ImageGenerationPrompt,
} from "./input";
import {
  DEFAULT_IMAGE_MODEL_FALLBACK_ORDER,
  getAvailableImageModels,
  IMAGE_MODEL_DESCRIPTORS,
  orderImageModelIds,
  resolveImageDimensions,
  type SupportedImageModelId,
} from "./models";
import { buildImageGenerationPrompt } from "./prompt";
import { resolveImageRouting } from "./routing";

const DEFAULT_IMAGE_OUTPUT_BASENAME = "generated-image";

const IMAGE_CALLABLE_DESCRIPTION =
  "Generate or edit an image with a configured provider and write it to a local file in outputDir (or cwd). Returns absolute output path + MIME type. " +
  "Recommended/default: gpt-image-2 when available.";

/**
 * Reads `tools.generate.image` lazily so config changes apply without
 * rebuilding the tool. `undefined` means no config source is wired (direct
 * construction), in which case the default provider routing applies.
 */
export type GenerateImageConfigSource = () =>
  | Pick<CoreConfig, "tools">
  | undefined
  | Promise<Pick<CoreConfig, "tools"> | undefined>;

export type GenerateImageResult = {
  readonly ok: true;
  readonly path: string;
  readonly bytes: number;
  readonly mimeType: string;
  readonly model: SupportedImageModelId;
  readonly warnings: Awaited<ReturnType<typeof generateImage>>["warnings"];
};

export type GenerateImageCallableDefinition = ServerToolCallableDefinition<
  typeof imageGenerateInputSchema,
  GenerateImageResult,
  RegisteredSurfacePlatform
>;

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

async function resolveRouting(getConfig: GenerateImageConfigSource | undefined) {
  const config = await getConfig?.();
  const imageConfig = config?.tools.generate.image;
  return resolveImageRouting({
    imageConfig,
    descriptors: IMAGE_MODEL_DESCRIPTORS,
    resolveDefaultModels: getAvailableImageModels,
  });
}

async function runGenerateImage(
  payload: ImageGenerateInput,
  opts: ServerToolCallOptions | undefined,
  getConfig: GenerateImageConfigSource | undefined,
): Promise<ServerToolResult<GenerateImageResult>> {
  return Result.gen(async function* () {
    const routing = await resolveRouting(getConfig);
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

    const generationOptions = routing.generationOptions(resolveImageDimensions(picked.id, payload));
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
    const targetWithExt = join(resolvedOutputDir, `${DEFAULT_IMAGE_OUTPUT_BASENAME}${inferredExt}`);

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
    const outPath = yield* Result.await(writeFileWithUniqueName(targetWithExt, image.uint8Array));

    return Result.ok({
      ok: true as const,
      path: formatToolPathForRequestContext({ path: outPath, context: opts?.context }),
      bytes: image.uint8Array.byteLength,
      mimeType: image.mediaType,
      model: picked.id,
      warnings: res.warnings,
    });
  });
}

/**
 * The structured `generate.image` callable this fork keeps in place of
 * upstream's script runner. `Generate` in `../generate` registers it; every
 * other piece of the image contract lives in this directory.
 */
export function createGenerateImageCallable(input: {
  readonly getConfig?: GenerateImageConfigSource;
}): GenerateImageCallableDefinition {
  return {
    name: "Generate Image",
    description: IMAGE_CALLABLE_DESCRIPTION,
    inputSchema: imageGenerateInputSchema,
    validation: "zod",
    primaryPositional: "prompt",
    catalog: async () => {
      const routing = await resolveRouting(input.getConfig);
      const imageModels = orderImageModelIds(routing.catalogModelIds);
      if (imageModels.length === 0) return false;
      return {
        description: `${IMAGE_CALLABLE_DESCRIPTION} Available models: ${imageModels.join(", ")}`,
      };
    },
    run: (payload, opts) => runGenerateImage(payload, opts, input.getConfig),
  };
}
