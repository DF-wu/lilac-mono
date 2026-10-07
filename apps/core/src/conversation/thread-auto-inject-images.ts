import { Buffer } from "node:buffer";
import { createDownload, type UserContent } from "ai";
import { fileTypeFromBuffer } from "file-type";
import { Result, type Result as ResultType } from "better-result";
import { opaqueErrorMessage } from "@stanley2058/lilac-utils";

import { DecisionAutoInjectEvaluationFailed } from "./thread-auto-inject-decision";

const IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
// The OpenAI Decisions endpoint rejects requests with more images than this.
const MAX_DECISION_IMAGES = 128;

type UserContentPart = Exclude<UserContent, string>[number];
type ImageData = string | URL | Uint8Array | ArrayBuffer;
type Download = ReturnType<typeof createDownload>;

function imagePartData(part: UserContentPart): ImageData | undefined {
  let data;
  if (part.type === "image") data = part.image;
  else if (part.type === "file" && part.mediaType.startsWith("image/")) data = part.data;
  else return undefined;
  if (
    typeof data !== "object" ||
    data instanceof URL ||
    data instanceof Uint8Array ||
    data instanceof ArrayBuffer
  ) {
    return data;
  }
  switch (data.type) {
    case "data":
      return data.data;
    case "url":
      return data.url;
    default:
      return undefined;
  }
}

async function readImageBytes(data: ImageData, download: Download): Promise<Uint8Array> {
  if (data instanceof URL || (typeof data === "string" && /^https?:\/\//u.test(data))) {
    const url = data instanceof URL ? data : new URL(data);
    return (await download({ url, abortSignal: undefined })).data;
  }
  if (typeof data === "string") {
    const encoded = data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
    return Buffer.from(encoded, "base64");
  }
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

async function readImage(
  data: ImageData,
  download: Download,
): Promise<
  ResultType<{ bytes: Uint8Array; mediaType?: string }, DecisionAutoInjectEvaluationFailed>
> {
  return Result.tryPromise({
    try: async () => {
      const bytes = await readImageBytes(data, download);
      return { bytes, mediaType: (await fileTypeFromBuffer(bytes))?.mime };
    },
    catch: (cause) =>
      new DecisionAutoInjectEvaluationFailed({
        message: opaqueErrorMessage(cause, "Decision image preparation failed"),
      }),
  });
}

function imagePreparationFailed(message: string) {
  return Result.err(new DecisionAutoInjectEvaluationFailed({ message }));
}

export async function collectDecisionAutoInjectImages(input: {
  content: UserContent;
  maxBytesPerPart: number;
  maxBytesTotal: number;
}): Promise<ResultType<string[], DecisionAutoInjectEvaluationFailed>> {
  const content = input.content;
  if (typeof content === "string") return Result.ok([]);
  const download = createDownload({ maxBytes: input.maxBytesPerPart });
  return Result.gen(async function* () {
    const images: string[] = [];
    let totalBytes = 0;
    for (const part of content) {
      const data = imagePartData(part);
      if (data === undefined) continue;
      const { bytes, mediaType } = yield* Result.await(readImage(data, download));
      totalBytes += bytes.byteLength;
      if (bytes.byteLength > input.maxBytesPerPart || totalBytes > input.maxBytesTotal) {
        return imagePreparationFailed("Decision images exceed configured inline media limits");
      }
      if (!mediaType || !IMAGE_MEDIA_TYPES.has(mediaType)) continue;
      images.push(`data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`);
      if (images.length > MAX_DECISION_IMAGES) {
        return imagePreparationFailed(
          `Decision requests support at most ${MAX_DECISION_IMAGES} images`,
        );
      }
    }
    return Result.ok(images);
  });
}
