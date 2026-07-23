import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { CustomMediaConfig } from "./config";
import { resolveCredentials } from "./config";
import type { ToolCallOptions } from "./contracts";
import { asCustomMediaError, CustomMediaError, parseWithSchema } from "./errors";
import {
  assertSuccessfulResponse,
  authorizationHeaders,
  providerURL,
  readProviderJson,
} from "./http";
import { readValidatedImage, videoExtensionForMime } from "./media";
import { validateVideoModelInput } from "./models";
import {
  formatToolPath,
  prepareOutputDirectory,
  reserveUniqueFile,
  resolveToolPath,
} from "./paths";
import { videoInputSchema, videoOutputSchema, type VideoOutput } from "./schemas";
import { abortableSleep, createCallSignal } from "./signal";

const videoTaskSchema = z
  .object({
    id: z.string().min(1),
    status: z.string().min(1),
    progress: z.number().optional(),
    error: z
      .union([z.string(), z.object({ message: z.string().optional() }).passthrough(), z.null()])
      .optional(),
  })
  .passthrough();

const SUCCEEDED_STATUSES = new Set(["succeeded", "completed"]);
const FAILED_STATUSES = new Set(["failed", "cancelled", "canceled", "expired"]);

function taskErrorMessage(task: z.infer<typeof videoTaskSchema>): string {
  if (typeof task.error === "string") return task.error;
  if (task.error && typeof task.error.message === "string") return task.error.message;
  return `Video task ended with status '${task.status}'.`;
}

async function createVideoTask(params: {
  baseURL: string;
  apiKey: string;
  route: string;
  input: z.infer<typeof videoInputSchema>;
  inputImage?: Awaited<ReturnType<typeof readValidatedImage>>;
  signal: AbortSignal;
}) {
  const form = new FormData();
  form.set("prompt", params.input.prompt);
  form.set("model", params.route);
  if (params.input.seconds !== undefined) form.set("seconds", String(params.input.seconds));
  if (params.input.size) form.set("size", params.input.size);
  if (params.inputImage) {
    form.set(
      "input_reference",
      new File([params.inputImage.bytes], params.inputImage.filename, {
        type: params.inputImage.mimeType,
      }),
    );
  }

  const response = await fetch(providerURL(params.baseURL, "videos"), {
    method: "POST",
    headers: authorizationHeaders(params.apiKey),
    body: form,
    signal: params.signal,
  });
  return parseWithSchema(
    videoTaskSchema,
    await readProviderJson(response, "Create video", params.apiKey),
    "Create video response",
  );
}

async function waitForVideoTask(params: {
  baseURL: string;
  apiKey: string;
  initialTask: z.infer<typeof videoTaskSchema>;
  pollIntervalMs: number;
  signal: AbortSignal;
}) {
  let task = params.initialTask;
  while (true) {
    const status = task.status.toLowerCase();
    if (SUCCEEDED_STATUSES.has(status)) return task;
    if (FAILED_STATUSES.has(status)) {
      throw new CustomMediaError("VIDEO_FAILED", taskErrorMessage(task));
    }
    await abortableSleep(params.pollIntervalMs, params.signal);
    const response = await fetch(
      providerURL(params.baseURL, `videos/${encodeURIComponent(task.id)}`),
      {
        headers: authorizationHeaders(params.apiKey),
        signal: params.signal,
      },
    );
    task = parseWithSchema(
      videoTaskSchema,
      await readProviderJson(response, "Poll video", params.apiKey),
      "Poll video response",
    );
  }
}

async function writeChunk(handle: FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await handle.write(chunk, offset, chunk.byteLength - offset, null);
    offset += result.bytesWritten;
  }
}

async function downloadVideo(params: {
  response: Response;
  targetPath: string;
  maxBytes: number;
  context?: ToolCallOptions["context"];
}): Promise<{ path: string; bytes: number; mimeType: string }> {
  const lengthHeader = params.response.headers.get("content-length");
  if (lengthHeader) {
    const length = Number(lengthHeader);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new CustomMediaError("PROVIDER_ERROR", "Video response has an invalid Content-Length.");
    }
    if (length > params.maxBytes) {
      throw new CustomMediaError(
        "DOWNLOAD_TOO_LARGE",
        `Video Content-Length ${length} exceeds the ${params.maxBytes}-byte limit.`,
      );
    }
  }
  const mimeType = params.response.headers.get("content-type") ?? "application/octet-stream";
  const extension = videoExtensionForMime(mimeType);
  const requestedExtension = path.extname(params.targetPath).toLowerCase();
  if (requestedExtension && !new Set([".mp4", ".webm", ".mov"]).has(requestedExtension)) {
    throw new CustomMediaError(
      "INVALID_INPUT",
      "Video output path must use .mp4, .webm, or .mov, or omit the extension.",
    );
  }
  const targetPath = requestedExtension ? params.targetPath : `${params.targetPath}${extension}`;
  const realDirectory = await prepareOutputDirectory(path.dirname(targetPath), params.context);
  const reserved = await reserveUniqueFile(path.join(realDirectory, path.basename(targetPath)));
  let bytes = 0;

  try {
    if (!params.response.body) {
      throw new CustomMediaError("PROVIDER_ERROR", "Video response did not include a body.");
    }
    const reader = params.response.body.getReader();
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > params.maxBytes) {
          await reader.cancel();
          throw new CustomMediaError(
            "DOWNLOAD_TOO_LARGE",
            `Video stream exceeded the ${params.maxBytes}-byte limit.`,
          );
        }
        await writeChunk(reserved.handle, item.value);
      }
    } finally {
      reader.releaseLock();
    }
    await reserved.handle.close();
    return { path: reserved.path, bytes, mimeType: mimeType.split(";")[0]!.trim() };
  } catch (error) {
    await reserved.handle.close().catch(() => undefined);
    await fs.unlink(reserved.path).catch(() => undefined);
    throw error;
  }
}

export async function generateCustomVideo(
  rawInput: Record<string, unknown>,
  config: CustomMediaConfig,
  options?: ToolCallOptions,
): Promise<VideoOutput> {
  const input = parseWithSchema(videoInputSchema, rawInput, "custom-media.video input");
  const registration = validateVideoModelInput(input);
  const credentials = resolveCredentials(config);
  const cwd = options?.context?.cwd ?? process.cwd();
  const targetPath = resolveToolPath({ cwd, inputPath: input.path, context: options?.context });
  const callSignal = createCallSignal(options?.signal, input.timeoutMs);

  try {
    let inputImage: Awaited<ReturnType<typeof readValidatedImage>> | undefined;
    if (input.inputImage) {
      const imagePath = resolveToolPath({
        cwd,
        inputPath: input.inputImage,
        context: options?.context,
      });
      inputImage = await readValidatedImage({ filePath: imagePath, context: options?.context });
    }
    const created = await createVideoTask({
      baseURL: credentials.baseURL,
      apiKey: credentials.apiKey,
      route: registration.route,
      input,
      inputImage,
      signal: callSignal.signal,
    });
    const completed = await waitForVideoTask({
      baseURL: credentials.baseURL,
      apiKey: credentials.apiKey,
      initialTask: created,
      pollIntervalMs: input.pollIntervalMs,
      signal: callSignal.signal,
    });
    const contentResponse = await fetch(
      providerURL(credentials.baseURL, `videos/${encodeURIComponent(completed.id)}/content`),
      {
        headers: authorizationHeaders(credentials.apiKey),
        signal: callSignal.signal,
      },
    );
    await assertSuccessfulResponse(contentResponse, "Download video", credentials.apiKey);
    const downloaded = await downloadVideo({
      response: contentResponse,
      targetPath,
      maxBytes: input.maxDownloadBytes,
      context: options?.context,
    });
    return videoOutputSchema.parse({
      ok: true,
      path: formatToolPath(downloaded.path, options?.context),
      bytes: downloaded.bytes,
      mimeType: downloaded.mimeType,
      model: input.model,
      route: registration.route,
      videoId: completed.id,
    });
  } catch (error) {
    if (callSignal.signal.aborted) callSignal.mapAbort(error);
    if (error instanceof CustomMediaError) throw error;
    throw asCustomMediaError(error, "PROVIDER_ERROR", "Video generation failed", [
      credentials.apiKey,
    ]);
  } finally {
    callSignal.cleanup();
  }
}
