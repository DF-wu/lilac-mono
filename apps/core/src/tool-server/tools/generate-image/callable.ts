import type { CoreConfig } from "@stanley2058/lilac-utils";
import type {
  ServerToolCallableDefinition,
  ServerToolResult,
} from "@stanley2058/lilac-plugin-runtime";
import { Result } from "better-result";
import { generateImage } from "ai";
import fs from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  formatToolPathForRequestContext,
  inferExtensionFromMimeType,
  resolveToolPathForRequestContext,
} from "../../../shared/attachment-utils";
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
  DEFAULT_IMAGE_MODEL_FALLBACK_ORDER,
  resolveImageDimensions,
  type SupportedImageModelId,
} from "./catalog";
import { generateFailureFromCause } from "./failures";
import { imageGenerateInputSchema, type ImageGenerateInput } from "./input";
import { buildImageGenerationPrompt } from "./prompt";
import { resolveImageRoute, type ImageRoute } from "./routing";
import { validateImageGenerationInputForModel } from "./validation";

const DEFAULT_IMAGE_OUTPUT_BASENAME = "generated-image";

const IMAGE_CALLABLE_DESCRIPTION =
  "Generate or edit an image with a configured provider and write it to a local file in outputDir (or cwd). Returns absolute output path + MIME type. " +
  `Recommended/default: ${DEFAULT_IMAGE_MODEL_FALLBACK_ORDER[0]} when available.`;

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

async function resolveRoute(getConfig: GenerateImageConfigSource | undefined): Promise<ImageRoute> {
  const config = await getConfig?.();
  return resolveImageRoute(config?.tools.generate.image);
}

async function runGenerateImage(
  payload: ImageGenerateInput,
  opts: ServerToolCallOptions | undefined,
  getConfig: GenerateImageConfigSource | undefined,
): Promise<ServerToolResult<GenerateImageResult>> {
  return Result.gen(async function* () {
    const route = await resolveRoute(getConfig);
    if (route.configurationError) {
      return Result.err(generateFailure("usage", route.configurationError));
    }
    const picked = yield* pickModel(
      route.resolveModels().models,
      payload.model,
      DEFAULT_IMAGE_MODEL_FALLBACK_ORDER,
      "image",
    );
    yield* validateImageGenerationInputForModel(picked.id, payload);

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
      generateFailureFromCause("denied"),
    );

    const prompt = yield* Result.await(buildImageGenerationPrompt(cwd, payload, opts?.context));
    const requestOptions = route.requestOptions(resolveImageDimensions(picked.id, payload));
    const res = yield* Result.await(
      settleCapturedPromise(
        Result.tryPromise({
          try: () =>
            generateImage({
              model: picked.model,
              prompt,
              abortSignal: opts?.signal,
              ...requestOptions,
            }),
          catch: captureGenerateFailure,
        }),
        generateFailureFromCause(() => (opts?.signal?.aborted ? "cancelled" : "unavailable")),
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
        generateFailureFromCause("unavailable"),
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
      const route = await resolveRoute(input.getConfig);
      const imageModels = route.catalogModelIds();
      if (imageModels.length === 0) return false;
      return {
        description: `${IMAGE_CALLABLE_DESCRIPTION} Available models: ${imageModels.join(", ")}`,
      };
    },
    run: (payload, opts) => runGenerateImage(payload, opts, input.getConfig),
  };
}
