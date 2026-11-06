import type {
  LilacToolPlugin,
  ServerTool,
  ServerToolFailure,
} from "@stanley2058/lilac-plugin-runtime";
import { Result } from "better-result";
import { customMediaConfigSchema, type CustomMediaConfig } from "./config";
import type { ToolCallOptions } from "./contracts";
import { CustomMediaError, redactDiagnostic, type CustomMediaErrorCode } from "./errors";
import { generateCustomImage } from "./image";
import { IMAGE_MODEL_ALIASES, VIDEO_MODEL_ALIASES } from "./models";
import { generateCustomVideo } from "./video";

export * from "./config";
export * from "./errors";
export * from "./models";
export * from "./paths";
export * from "./schemas";

const FAILURE_POLICIES = {
  INVALID_CONFIG: { kind: "unavailable", retryable: false },
  MISSING_ENV: { kind: "unavailable", retryable: false },
  INVALID_INPUT: { kind: "usage", retryable: false },
  UNSUPPORTED_MODEL: { kind: "usage", retryable: false },
  UNSUPPORTED_CAPABILITY: { kind: "usage", retryable: false },
  UNSAFE_PATH: { kind: "denied", retryable: false },
  INVALID_MEDIA: { kind: "usage", retryable: false },
  MEDIA_TOO_LARGE: { kind: "usage", retryable: false },
  PROVIDER_ERROR: { kind: "unavailable", retryable: true },
  VIDEO_FAILED: { kind: "unavailable", retryable: true },
  DOWNLOAD_TOO_LARGE: { kind: "usage", retryable: false },
  TIMEOUT: { kind: "timeout", retryable: true },
  ABORTED: { kind: "cancelled", retryable: false },
  IO_ERROR: { kind: "internal", retryable: false },
} satisfies Record<CustomMediaErrorCode, Pick<ServerToolFailure, "kind" | "retryable">>;

function customMediaFailure(cause: unknown): ServerToolFailure {
  if (!(cause instanceof CustomMediaError)) throw cause;
  return {
    ...FAILURE_POLICIES[cause.code],
    code: cause.code,
    message: redactDiagnostic(cause),
  };
}

async function callCustomMedia(
  callableId: string,
  input: Record<string, unknown>,
  config: CustomMediaConfig,
  options?: ToolCallOptions,
) {
  if (callableId === "custom-media.image") {
    return generateCustomImage(input, config, options);
  }
  if (callableId === "custom-media.video") {
    return generateCustomVideo(input, config, options);
  }
  throw new CustomMediaError("INVALID_INPUT", `Unknown callable '${callableId}'.`);
}

export function createCustomMediaServerTool(config: CustomMediaConfig): ServerTool {
  return {
    id: "custom-media",
    async init() {},
    async destroy() {},
    async list() {
      return [
        {
          callableId: "custom-media.image",
          name: "Custom Media Image",
          description:
            "Generate or edit an image through one configured OpenAI-compatible endpoint. " +
            `Models: ${IMAGE_MODEL_ALIASES.join(", ")}.`,
          shortInput: ["prompt=<string>"],
          input: [
            "prompt: string (required)",
            `model?: ${IMAGE_MODEL_ALIASES.join(" | ")} (default: gpt-image-2)`,
            "outputDir?: string",
            "inputImages?: string | string[]",
            "maskImage?: string",
            "size?: <width>x<height>",
            "aspectRatio?: <width>:<height>",
            "timeoutMs?: 100-290000 (default: 240000)",
          ],
          primaryPositional: { field: "prompt" },
        },
        {
          callableId: "custom-media.video",
          name: "Custom Media Video",
          description:
            "Generate a video through the QuantumNous/new-api OpenAI-compatible video API. " +
            `Models: ${VIDEO_MODEL_ALIASES.join(", ")}.`,
          shortInput: ["prompt=<string>", "path=<string>"],
          input: [
            "prompt: string (required)",
            "path: string (required)",
            `model?: ${VIDEO_MODEL_ALIASES.join(" | ")} (default: grok-imagine-video)`,
            "inputImage?: string",
            "seconds?: 1-15",
            "size?: <width>x<height>",
            "pollIntervalMs?: 10-30000 (default: 2000)",
            "timeoutMs?: 100-290000 (default: 240000)",
            "maxDownloadBytes?: 1-536870912 (default: 268435456)",
          ],
        },
      ];
    },
    async call(callableId, input, options) {
      const captured = await Result.tryPromise({
        try: () => callCustomMedia(callableId, input, config, options),
        catch: (cause) => ({ restoreCause: () => cause }),
      });
      if (captured.isErr()) {
        return Result.err(customMediaFailure(captured.error.restoreCause()));
      }
      return captured;
    },
  };
}

const plugin: LilacToolPlugin<unknown, never, ServerTool> = {
  meta: {
    id: "custom-media",
    name: "Custom Media",
    version: "1.0.0",
  },
  create(context) {
    const parsed = customMediaConfigSchema.safeParse(context.pluginConfig ?? {});
    if (!parsed.success) {
      throw new CustomMediaError(
        "INVALID_CONFIG",
        `Plugin config is invalid: ${redactDiagnostic(parsed.error.issues.map((issue) => issue.message).join("; "))}`,
      );
    }
    return { level2: [createCustomMediaServerTool(parsed.data)] };
  },
};

export default plugin;
