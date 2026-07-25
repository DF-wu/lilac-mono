import type { LilacToolPlugin, ServerTool } from "@stanley2058/lilac-plugin-runtime";
import { customMediaConfigSchema, type CustomMediaConfig } from "./config";
import { CustomMediaError, redactDiagnostic } from "./errors";
import { generateCustomImage } from "./image";
import { IMAGE_MODEL_ALIASES, VIDEO_MODEL_ALIASES } from "./models";
import { generateCustomVideo } from "./video";

export * from "./config";
export * from "./errors";
export * from "./models";
export * from "./paths";
export * from "./schemas";

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
      if (callableId === "custom-media.image") {
        return await generateCustomImage(input, config, options);
      }
      if (callableId === "custom-media.video") {
        return await generateCustomVideo(input, config, options);
      }
      throw new CustomMediaError("INVALID_INPUT", `Unknown callable '${callableId}'.`);
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
