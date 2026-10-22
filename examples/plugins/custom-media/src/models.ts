import type { ImageInput, VideoInput } from "./schemas";
import { CustomMediaError } from "./errors";

export const IMAGE_MODEL_ALIASES = [
  "gpt-image-2",
  "gpt-5-image",
  "nanobanana",
  "nanobanana-2",
  "nanobanana-2-lite",
  "nanobanana-pro",
  "grok-imagine-image",
  "grok-imagine-image-pro",
] as const;

export const VIDEO_MODEL_ALIASES = ["grok-imagine-video"] as const;

export type ImageModelAlias = (typeof IMAGE_MODEL_ALIASES)[number];
export type VideoModelAlias = (typeof VIDEO_MODEL_ALIASES)[number];

type ImageProfile = {
  supportsEdit: boolean;
  supportsMask: boolean;
  maxInputImages: number;
  validate(input: ImageInput): void;
};

type VideoProfile = {
  supportsInputImage: boolean;
  validate(input: VideoInput): void;
};

type ModelRegistration<TAlias extends string, TProfile> = {
  alias: TAlias;
  route: string;
  profile: TProfile;
};

const GPT_ASPECT_RATIOS = ["1:1", "3:2", "2:3"] as const;
const GPT_STANDARD_SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;
const NANO_ASPECT_RATIOS = [
  "21:9",
  "16:9",
  "3:2",
  "4:3",
  "5:4",
  "1:1",
  "4:5",
  "3:4",
  "2:3",
  "9:16",
] as const;
const NANO_WIDE_ASPECT_RATIOS = [...NANO_ASPECT_RATIOS, "1:4", "4:1", "1:8", "8:1"] as const;
const GROK_IMAGE_ASPECT_RATIOS = [
  "1:1",
  "16:9",
  "9:16",
  "4:3",
  "3:4",
  "3:2",
  "2:3",
  "2:1",
  "1:2",
  "19.5:9",
  "9:19.5",
  "20:9",
  "9:20",
] as const;
const GROK_VIDEO_SIZES = [
  "1280x720",
  "720x1280",
  "854x480",
  "480x854",
  "640x480",
  "480x640",
  "640x640",
  "960x640",
  "640x960",
] as const;

function assertAllowed(label: string, value: string | undefined, allowed: readonly string[]): void {
  if (value && !allowed.includes(value)) {
    throw new CustomMediaError(
      "UNSUPPORTED_CAPABILITY",
      `Unsupported ${label} '${value}'. Allowed: ${allowed.join(", ")}.`,
    );
  }
}

function validateGptImage(input: ImageInput, isGptImage2: boolean): void {
  assertAllowed("aspectRatio", input.aspectRatio, GPT_ASPECT_RATIOS);
  if (!input.size) return;

  if (!isGptImage2 || input.inputImages?.length) {
    assertAllowed("size", input.size, GPT_STANDARD_SIZES);
    return;
  }

  const [width, height] = input.size.split("x").map(Number);
  const pixels = width! * height!;
  if (
    width! % 16 !== 0 ||
    height! % 16 !== 0 ||
    width! > 3840 ||
    height! > 3840 ||
    Math.max(width!, height!) / Math.min(width!, height!) > 3 ||
    pixels < 655_360 ||
    pixels > 8_294_400
  ) {
    throw new CustomMediaError(
      "UNSUPPORTED_CAPABILITY",
      "gpt-image-2 generation sizes require edges divisible by 16 and <=3840, ratio <=3:1, and 655360-8294400 total pixels.",
    );
  }
}

function gptProfile(isGptImage2: boolean): ImageProfile {
  return {
    supportsEdit: true,
    supportsMask: true,
    maxInputImages: 16,
    validate: (input) => validateGptImage(input, isGptImage2),
  };
}

function nanoProfile(params: { wide?: boolean; lite?: boolean } = {}): ImageProfile {
  return {
    supportsEdit: true,
    supportsMask: !params.lite,
    maxInputImages: 4,
    validate(input) {
      assertAllowed(
        "aspectRatio",
        input.aspectRatio,
        params.wide ? NANO_WIDE_ASPECT_RATIOS : NANO_ASPECT_RATIOS,
      );
      if (params.lite && input.size) {
        throw new CustomMediaError(
          "UNSUPPORTED_CAPABILITY",
          "nanobanana-2-lite produces 1K output; use aspectRatio instead of size.",
        );
      }
    },
  };
}

function grokImageProfile(): ImageProfile {
  return {
    supportsEdit: true,
    supportsMask: false,
    maxInputImages: 1,
    validate(input) {
      if (input.size) {
        throw new CustomMediaError(
          "UNSUPPORTED_CAPABILITY",
          "Grok image models do not support size; use aspectRatio.",
        );
      }
      assertAllowed("aspectRatio", input.aspectRatio, GROK_IMAGE_ASPECT_RATIOS);
    },
  };
}

export const IMAGE_MODEL_REGISTRY: Readonly<
  Record<ImageModelAlias, ModelRegistration<ImageModelAlias, ImageProfile>>
> = {
  "gpt-image-2": { alias: "gpt-image-2", route: "gpt-image-2", profile: gptProfile(true) },
  "gpt-5-image": {
    alias: "gpt-5-image",
    route: "gpt-image-1.5",
    profile: gptProfile(false),
  },
  nanobanana: {
    alias: "nanobanana",
    route: "google/gemini-2.5-flash-image",
    profile: nanoProfile(),
  },
  "nanobanana-2": {
    alias: "nanobanana-2",
    route: "google/gemini-3.1-flash-image-preview",
    profile: nanoProfile({ wide: true }),
  },
  "nanobanana-2-lite": {
    alias: "nanobanana-2-lite",
    route: "google/gemini-3.1-flash-lite-image",
    profile: nanoProfile({ wide: true, lite: true }),
  },
  "nanobanana-pro": {
    alias: "nanobanana-pro",
    route: "google/gemini-3-pro-image-preview",
    profile: nanoProfile(),
  },
  "grok-imagine-image": {
    alias: "grok-imagine-image",
    route: "grok-imagine-image",
    profile: grokImageProfile(),
  },
  "grok-imagine-image-pro": {
    alias: "grok-imagine-image-pro",
    route: "grok-imagine-image-pro",
    profile: grokImageProfile(),
  },
};

export const VIDEO_MODEL_REGISTRY: Readonly<
  Record<VideoModelAlias, ModelRegistration<VideoModelAlias, VideoProfile>>
> = {
  "grok-imagine-video": {
    alias: "grok-imagine-video",
    route: "grok-imagine-video",
    profile: {
      supportsInputImage: true,
      validate(input) {
        assertAllowed("size", input.size, GROK_VIDEO_SIZES);
      },
    },
  },
};

export function validateImageModelInput(input: ImageInput) {
  const registration = IMAGE_MODEL_REGISTRY[input.model];
  const imageCount = input.inputImages?.length ?? 0;
  if (imageCount > 0 && !registration.profile.supportsEdit) {
    throw new CustomMediaError(
      "UNSUPPORTED_CAPABILITY",
      `${input.model} does not support image editing.`,
    );
  }
  if (imageCount > registration.profile.maxInputImages) {
    throw new CustomMediaError(
      "UNSUPPORTED_CAPABILITY",
      `${input.model} accepts at most ${registration.profile.maxInputImages} input image(s).`,
    );
  }
  if (input.maskImage && !registration.profile.supportsMask) {
    throw new CustomMediaError(
      "UNSUPPORTED_CAPABILITY",
      `${input.model} does not support maskImage.`,
    );
  }
  registration.profile.validate(input);
  return registration;
}

export function validateVideoModelInput(input: VideoInput) {
  const registration = VIDEO_MODEL_REGISTRY[input.model];
  if (input.inputImage && !registration.profile.supportsInputImage) {
    throw new CustomMediaError(
      "UNSUPPORTED_CAPABILITY",
      `${input.model} does not support image-to-video.`,
    );
  }
  registration.profile.validate(input);
  return registration;
}

export function resolveImageDimensions(input: ImageInput): {
  size?: `${number}x${number}`;
  aspectRatio?: string;
} {
  if (input.size) return { size: input.size as `${number}x${number}` };
  if (!input.aspectRatio) return {};
  if (input.model === "gpt-image-2" || input.model === "gpt-5-image") {
    const sizes: Record<string, `${number}x${number}`> = {
      "1:1": "1024x1024",
      "3:2": "1536x1024",
      "2:3": "1024x1536",
    };
    return { size: sizes[input.aspectRatio] };
  }
  return { aspectRatio: input.aspectRatio };
}
