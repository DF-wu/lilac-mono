import { errorMessage } from "@stanley2058/lilac-utils";
import type { ServerToolFailure } from "@stanley2058/lilac-plugin-runtime";
import { Panic, Result, type Result as ResultType } from "better-result";
import type { DataContent } from "ai";

import {
  formatToolPathForRequestContext,
  resolveToolPathForRequestContext,
} from "../../../shared/attachment-utils";
import { preserveToolPanic } from "../../../tools/tool-result-adapters";
import type { RequestContext } from "../../types";
import {
  captureGenerateFailure,
  generateFailure,
  readImageDataFromPath,
  settleCapturedError,
} from "../generate";
import type { ImageGenerationPrompt } from "./input";

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
