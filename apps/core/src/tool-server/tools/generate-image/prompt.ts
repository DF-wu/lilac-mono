import type { ServerToolFailure } from "@stanley2058/lilac-plugin-runtime";
import { Result, type Result as ResultType } from "better-result";
import type { DataContent } from "ai";

import {
  formatToolPathForRequestContext,
  resolveToolPathForRequestContext,
} from "../../../shared/attachment-utils";
import type { RequestContext } from "../../types";
import { captureGenerateFailure, readImageDataFromPath, settleCapturedError } from "../generate";
import { generateFailureFromCause } from "./failures";
import type { ImageGenerationPrompt } from "./input";

/** Resolves a caller path against the request context and reads it as image bytes. */
function readImageInput(
  cwd: string,
  inputPath: string,
  context: RequestContext | undefined,
): Promise<ResultType<Buffer, ServerToolFailure>> {
  return Result.gen(async function* () {
    const resolved = yield* settleCapturedError(
      Result.try({
        try: () => resolveToolPathForRequestContext({ cwd, inputPath, context }),
        catch: captureGenerateFailure,
      }),
      generateFailureFromCause("denied"),
    );
    return await readImageDataFromPath(
      resolved,
      formatToolPathForRequestContext({ path: resolved, context }),
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
  const inputImages = input.inputImages ?? [];
  if (inputImages.length === 0) return Result.ok(undefined);

  return Result.gen(async function* () {
    const images: DataContent[] = [];
    for (const imagePath of inputImages) {
      images.push(yield* Result.await(readImageInput(cwd, imagePath, context)));
    }

    if (!input.maskImage) return Result.ok({ images });

    const mask = yield* Result.await(readImageInput(cwd, input.maskImage, context));
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
