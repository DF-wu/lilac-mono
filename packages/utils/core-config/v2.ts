import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import { cloneDefaultWorkingIndicators } from "../working-indicators";
import { parseFriendlyByteSize, parseFriendlyDurationMs } from "../friendly-units";

import {
  coreConfigInputSchemaV1,
  agentRetrySchema,
  heartbeatSchema,
  jsonObjectSchema,
  modelCapabilityCostPatchSchema,
  modelCapabilityLimitPatchSchema,
  modelCapabilityModalitiesPatchSchema,
  migrateWebConfigValue,
  routerSchema,
  statsForNerdsSchema,
  webExtractConfigValueSchema,
  webFetchModeSchema,
} from "./v1";
import { collectUnknownConfigKeyPaths } from "./unknown-keys";
import {
  cloneDefaultTelegramSurface,
  IMAGE_GENERATION_MODEL_ALIASES,
  MODEL_REASONING_EFFORTS,
  TELEGRAM_SURFACE_DEFAULTS,
} from "./types";

import type {
  ConfigParser,
  CoreConfigParseOptions,
  CoreConfigVersion,
  SubagentProfileConfig,
  UniversalCoreConfig,
} from "./types";

export const V2_CORE_CONFIG_VERSION = 2 satisfies CoreConfigVersion;
export const CURRENT_CORE_CONFIG_VERSION = V2_CORE_CONFIG_VERSION;
export const DEFAULT_CORE_CONFIG_VERSION = 1 satisfies CoreConfigVersion;
export const SUPPORTED_CORE_CONFIG_VERSIONS = [
  1, 2,
] as const satisfies readonly CoreConfigVersion[];

const configVersionSchema = z.literal(V2_CORE_CONFIG_VERSION).default(V2_CORE_CONFIG_VERSION);

const pluginsSchemaV2 = z
  .object({
    disabled: z.array(z.string().min(1)).default([]),
    config: z.record(z.string(), z.unknown()).default({}),
  })
  .default({ disabled: [], config: {} });

const reasoningDisplaySchema = z.enum(["none", "simple", "detailed"]).default("detailed");

const modelReasoningEffortSchema = z.enum(MODEL_REASONING_EFFORTS);

const configuredModelChainEntrySchemaV2 = z.union([
  z.string().min(1),
  z.object({
    model: z.string().min(1),
    reasoning: modelReasoningEffortSchema.optional(),
    options: jsonObjectSchema.optional(),
  }),
]);

const modelFallbackSchemaV2 = z.array(configuredModelChainEntrySchemaV2).optional();

const profileNamesSchema = z.array(z.string().trim().min(1)).default([]);

const profileLevel1Schema = z.object({
  tools: profileNamesSchema,
  plugins: profileNamesSchema,
});

const profileLevel2Schema = z.object({
  callables: profileNamesSchema,
  plugins: profileNamesSchema,
});

const EXPLORE_PROFILE_DEFAULT: SubagentProfileConfig = {
  modelSlot: "main",
  level1: {
    tools: ["bash", "read", "glob", "grep", "fuzzy_search", "batch"],
    plugins: ["builtin-local-tools"],
  },
  level2: {
    callables: [
      "fetch",
      "search",
      "skills.list",
      "skills.brief",
      "skills.full",
      "content.inspect",
      "discovery.search",
      "conversation.thread.search",
      "surface.help",
      "surface.sessions.listParticipants",
      "surface.messages.list",
      "surface.messages.read",
      "surface.messages.search",
      "surface.reactions.list",
      "surface.reactions.listDetailed",
    ],
    plugins: ["web", "skills", "content.inspect", "discovery", "conversation.thread", "surface"],
  },
  network: true,
  workspaceWrites: false,
  execution: "restricted",
  delegation: false,
};

const GENERAL_PROFILE_DEFAULT: SubagentProfileConfig = {
  modelSlot: "main",
  level1: { tools: ["*"], plugins: ["*"] },
  level2: { callables: ["*"], plugins: ["*"] },
  network: true,
  workspaceWrites: true,
  execution: "native",
  delegation: false,
};

const SELF_PROFILE_DEFAULT: SubagentProfileConfig = {
  ...GENERAL_PROFILE_DEFAULT,
  delegation: true,
};

function normalizeProfileToolNames(profile: SubagentProfileConfig): SubagentProfileConfig {
  return {
    ...profile,
    level1: {
      ...profile.level1,
      tools: profile.level1.tools.map((name) => {
        switch (name) {
          case "read_file":
            return "read";
          case "edit_file":
            return "edit";
          case "apply_patch":
            return "patch";
          default:
            return name;
        }
      }),
    },
  };
}

function subagentProfileSchemaV2(defaults: SubagentProfileConfig) {
  return z
    .object({
      modelSlot: z.enum(["main", "fast"]).default("main"),
      /** Optional direct model ref (provider/model or alias from models.def). */
      model: z.string().min(1).optional(),
      /** Optional portable AI SDK reasoning effort. */
      reasoning: modelReasoningEffortSchema.optional(),
      /** Optional providerOptions override merged onto models.def.<alias>.options. */
      options: jsonObjectSchema.optional(),
      /** Optional ordered model fallback chain. */
      fallback: modelFallbackSchemaV2,
      promptOverlay: z.string().min(1).optional(),
      level1: profileLevel1Schema.default(defaults.level1),
      level2: profileLevel2Schema.default(defaults.level2),
      network: z.boolean().default(defaults.network),
      workspaceWrites: z.boolean().default(defaults.workspaceWrites),
      execution: z
        .union([z.literal(false), z.enum(["restricted", "native"])])
        .default(defaults.execution),
      delegation: z.boolean().default(defaults.delegation),
    })
    .superRefine((input, ctx) => {
      if (input.options && !input.model) {
        ctx.addIssue({
          code: "custom",
          path: ["options"],
          message: "options requires model to be set",
        });
      }
    });
}

const modelCapabilityOverrideSchemaV2 = z
  .object({
    /** Optional base model capability spec to inherit from (provider/model). */
    inherit: z.string().trim().min(1).optional(),
    /** Optional partial cost patch merged onto inherited/base cost. */
    cost: modelCapabilityCostPatchSchema.optional(),
    /** Optional partial limit patch merged onto inherited/base limits. */
    limit: modelCapabilityLimitPatchSchema.optional(),
    /** Optional attachment input support patch merged onto inherited/base capability. */
    attachment: z.boolean().optional(),
    /** Optional partial modalities patch merged onto inherited/base modalities. */
    modalities: modelCapabilityModalitiesPatchSchema.optional(),
  })
  .superRefine((input, ctx) => {
    if (
      !input.inherit &&
      !input.cost &&
      !input.limit &&
      input.attachment === undefined &&
      !input.modalities
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "override must set at least one of inherit, cost, limit, attachment, or modalities",
      });
    }

    if (!input.inherit) {
      if (input.limit?.context === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["limit", "context"],
          message: "limit.context is required when inherit is not set",
        });
      }

      if (input.cost && (input.cost.input === undefined || input.cost.output === undefined)) {
        ctx.addIssue({
          code: "custom",
          path: ["cost"],
          message: "cost.input and cost.output are required when inherit is not set",
        });
      }

      if (input.modalities && input.modalities.input === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["modalities", "input"],
          message: "modalities.input is required when inherit is not set",
        });
      }
    }
  });

const modelCapabilitySchemaV2 = z
  .object({
    /** Providers to always treat as unknown/unresolved capability. */
    forceUnknownProviders: z.array(z.string().trim().min(1)).default(["openai-compatible"]),
    /** Optional capability overrides keyed by provider/model spec. */
    overrides: z.record(z.string().trim().min(1), modelCapabilityOverrideSchemaV2).default({}),
  })
  .default({
    forceUnknownProviders: ["openai-compatible"],
    overrides: {},
  });

const subagentsSchemaV2 = z.object({
  enabled: z.boolean().default(true),
  maxDepth: z.number().int().min(0).max(2).default(2),
  delegatePromptOverlay: z.string().trim().min(1).optional(),
  profiles: z
    .object({
      explore: subagentProfileSchemaV2(EXPLORE_PROFILE_DEFAULT).default(EXPLORE_PROFILE_DEFAULT),
      general: subagentProfileSchemaV2(GENERAL_PROFILE_DEFAULT).default(GENERAL_PROFILE_DEFAULT),
      self: subagentProfileSchemaV2(SELF_PROFILE_DEFAULT).default(SELF_PROFILE_DEFAULT),
    })
    .default({
      explore: EXPLORE_PROFILE_DEFAULT,
      general: GENERAL_PROFILE_DEFAULT,
      self: SELF_PROFILE_DEFAULT,
    }),
});

const discordMarkdownTableRenderSchema = z
  .object({
    enabled: z.boolean().default(true),
    style: z.enum(["unicode", "ascii"]).default("unicode"),
    maxWidth: z.number().int().min(40).max(240).default(50),
    fallbackMode: z.enum(["list", "passthrough"]).default("list"),
  })
  .default({
    enabled: true,
    style: "unicode",
    maxWidth: 50,
    fallbackMode: "list",
  });

const discordMarkdownMathRenderSchema = z
  .object({
    enabled: z.boolean().default(false),
    maxWidth: z.number().int().min(40).max(240).default(50),
    fallbackMode: z.enum(["source", "passthrough"]).default("source"),
  })
  .default({
    enabled: false,
    maxWidth: 50,
    fallbackMode: "source",
  });

const discordSurfaceSchema = z
  .object({
    tokenEnv: z.string().min(1).default("DISCORD_TOKEN"),
    allowedChannelIds: z.array(z.string().min(1)).default([]),
    allowedGuildIds: z.array(z.string().min(1)).default([]),
    dbPath: z.string().min(1).optional(),
    botName: z
      .string()
      .min(1)
      .refine((s) => !/\s/u.test(s), "botName must not contain spaces")
      .default("lilac"),
    statusMessage: z.string().optional(),
    memberPresence: z.boolean().optional(),
    outputMode: z.enum(["inline", "preview"]).default("preview"),
    outputPreviewModeFinalStyle: z.enum(["embed", "plain"]).default("plain"),
    outputNotification: z.boolean().default(true),
    workingIndicators: z
      .array(z.string().trim().min(1))
      .min(1)
      .default(cloneDefaultWorkingIndicators()),
    markdownTableRender: discordMarkdownTableRenderSchema,
    markdownMathRender: discordMarkdownMathRenderSchema,
  })
  .default({
    tokenEnv: "DISCORD_TOKEN",
    allowedChannelIds: [],
    allowedGuildIds: [],
    botName: "lilac",
    outputMode: "preview",
    outputPreviewModeFinalStyle: "plain",
    outputNotification: true,
    workingIndicators: cloneDefaultWorkingIndicators(),
    markdownTableRender: {
      enabled: true,
      style: "unicode",
      maxWidth: 50,
      fallbackMode: "list",
    },
    markdownMathRender: {
      enabled: false,
      maxWidth: 50,
      fallbackMode: "source",
    },
  });

const telegramSurfaceSchema = z
  .object({
    enabled: z.boolean().default(TELEGRAM_SURFACE_DEFAULTS.enabled),
    token: z.string().trim().min(1).optional(),
    tokenEnv: z
      .never({
        error:
          "surface.telegram.tokenEnv was removed; copy the token to surface.telegram.token and remove tokenEnv",
      })
      .optional(),
    botName: z
      .string()
      .min(1)
      .refine((s) => !/\s/u.test(s), "botName must not contain spaces")
      .default(TELEGRAM_SURFACE_DEFAULTS.botName),
    botUsername: z
      .string()
      .min(1)
      .refine((s) => !s.startsWith("@"), "botUsername must not include a leading '@'")
      .optional(),
    // Lazy defaults: a literal default is evaluated once at schema construction
    // and would then be shared (and mutable) across every parsed config.
    allowedChatIds: z.array(z.string().min(1)).default(() => []),
    allowedUserIds: z.array(z.string().min(1)).default(() => []),
    dbPath: z.string().min(1).optional(),
    apiRoot: z.string().url().optional(),
    outputMode: z.enum(["inline", "preview"]).default(TELEGRAM_SURFACE_DEFAULTS.outputMode),
    parseMode: z.enum(["html", "plain"]).default(TELEGRAM_SURFACE_DEFAULTS.parseMode),
    // Telegram throttles edits at roughly one per second per chat; going below
    // this reliably trips 429 retry_after responses during streaming.
    streamEditIntervalMs: z
      .number()
      .int()
      .min(500)
      .max(60_000)
      .default(TELEGRAM_SURFACE_DEFAULTS.streamEditIntervalMs),
    outputNotification: z.boolean().default(TELEGRAM_SURFACE_DEFAULTS.outputNotification),
    workingIndicators: z
      .array(z.string().trim().min(1))
      .min(1)
      .default(() => cloneDefaultWorkingIndicators()),
    commandMenu: z.boolean().default(TELEGRAM_SURFACE_DEFAULTS.commandMenu),
    markdownTableRender: discordMarkdownTableRenderSchema,
  })
  .default(() => cloneDefaultTelegramSurface());

const byteSizeSchema = z.preprocess(parseFriendlyByteSize, z.number().int().positive());
const durationMsSchema = z.preprocess(parseFriendlyDurationMs, z.number().int().positive());

const webConfigSchemaV2 = z
  .preprocess(
    migrateWebConfigValue,
    z.object({
      extract: webExtractConfigValueSchema.default({
        providers: ["tavily"],
      }),
      fetch: z
        .object({
          mode: webFetchModeSchema,
        })
        .default({
          mode: "auto",
        }),
      firecrawl: z
        .object({
          maxConcurrency: z.number().int().positive().default(2),
          queueTtl: durationMsSchema.default(3_000),
        })
        .optional(),
    }),
  )
  .default({
    extract: {
      providers: ["tavily"],
    },
    fetch: {
      mode: "auto",
    },
  });

const imageGenerationAliasSchema = z.enum(IMAGE_GENERATION_MODEL_ALIASES, {
  error: `Unknown generate.image alias. Valid aliases: ${IMAGE_GENERATION_MODEL_ALIASES.join(", ")}.`,
});

const generateImageOpenAICompatibleSchema = z
  .object({
    models: z.array(imageGenerationAliasSchema).min(1).optional(),
    modelIds: z
      .partialRecord(imageGenerationAliasSchema, z.string().trim().min(1), {
        error: (issue) =>
          issue.code === "invalid_key"
            ? `Unknown generate.image alias in modelIds. Valid aliases: ${IMAGE_GENERATION_MODEL_ALIASES.join(", ")}.`
            : undefined,
      })
      .default({}),
  })
  .default({ modelIds: {} });

const toolsSchema = z
  .object({
    fsBackend: z.enum(["fff", "node-rg"]).default("fff"),
    generate: z
      .object({
        image: z
          .object({
            provider: z.enum(["default", "openai-compatible"]).default("default"),
            openaiCompatible: generateImageOpenAICompatibleSchema,
          })
          .default({ provider: "default", openaiCompatible: { modelIds: {} } }),
      })
      .default({ image: { provider: "default", openaiCompatible: { modelIds: {} } } }),
    web: webConfigSchemaV2,
    inspect: z
      .object({
        model: z.string().trim().min(1).default("google/gemini-3.5-flash"),
      })
      .default({
        model: "google/gemini-3.5-flash",
      }),
    editFile: z
      .object({
        hashline: z.boolean().default(true),
      })
      .default({
        hashline: true,
      }),
    output: z
      .object({
        maxPreviewBytes: byteSizeSchema.default(40 * 1024),
        artifactTtl: durationMsSchema.default(7 * 24 * 60 * 60 * 1000),
        artifactMaxBytesPerSession: byteSizeSchema.default(50 * 1024 * 1024),
      })
      .default({
        maxPreviewBytes: 40 * 1024,
        artifactTtl: 7 * 24 * 60 * 60 * 1000,
        artifactMaxBytesPerSession: 50 * 1024 * 1024,
      }),
    historicalResultPruning: z
      .object({
        enabled: z.boolean().default(false),
        protectTokens: z.number().int().nonnegative().default(40_000),
        minimumTokens: z.number().int().nonnegative().default(20_000),
      })
      .default({
        enabled: false,
        protectTokens: 40_000,
        minimumTokens: 20_000,
      }),
    batch: z
      .object({
        maxCalls: z.number().int().positive().max(8).default(8),
      })
      .default({ maxCalls: 8 }),
    media: z
      .object({
        maxInlineBytesPerPart: byteSizeSchema.default(10 * 1024 * 1024),
        maxInlineBytesTotal: byteSizeSchema.default(20 * 1024 * 1024),
      })
      .default({
        maxInlineBytesPerPart: 10 * 1024 * 1024,
        maxInlineBytesTotal: 20 * 1024 * 1024,
      }),
  })
  .default({
    fsBackend: "fff",
    generate: {
      image: {
        provider: "default",
        openaiCompatible: { modelIds: {} },
      },
    },
    web: {
      extract: {
        providers: ["tavily"],
      },
      fetch: {
        mode: "auto",
      },
    },
    inspect: {
      model: "google/gemini-3.5-flash",
    },
    editFile: {
      hashline: true,
    },
    output: {
      maxPreviewBytes: 40 * 1024,
      artifactTtl: 7 * 24 * 60 * 60 * 1000,
      artifactMaxBytesPerSession: 50 * 1024 * 1024,
    },
    historicalResultPruning: {
      enabled: false,
      protectTokens: 40_000,
      minimumTokens: 20_000,
    },
    batch: { maxCalls: 8 },
    media: {
      maxInlineBytesPerPart: 10 * 1024 * 1024,
      maxInlineBytesTotal: 20 * 1024 * 1024,
    },
  });

const conversationSchemaV2 = z
  .object({
    thread: z
      .object({
        summarization: z
          .object({
            enabled: z.boolean().default(false),
            model: z.string().trim().min(1).default("fast"),
            concurrency: z.number().int().min(1).max(128).default(1),
            batchSize: z.number().int().min(1).max(10_000).default(32),
            includePromptContext: z.boolean().default(false),
          })
          .default({
            enabled: false,
            model: "fast",
            concurrency: 1,
            batchSize: 32,
            includePromptContext: false,
          }),
        embedding: z
          .object({
            enabled: z.boolean().default(false),
            model: z.string().trim().min(1).default("openai/text-embedding-3-small"),
          })
          .default({ enabled: false, model: "openai/text-embedding-3-small" }),
        autoInject: z
          .object({
            enabled: z.boolean().default(false),
            plannerModel: z.string().trim().min(1).optional(),
            textPlannerModel: z.string().trim().min(1).optional(),
            minTextUnits: z.number().int().positive().default(80),
            followUpMinTextUnits: z.number().int().positive().default(110),
            limit: z.number().int().positive().max(10).default(3),
            minScore: z.number().nonnegative().default(0.1),
            mode: z.enum(["hybrid", "semantic", "lexical"]).default("hybrid"),
            filterCurrentParticipants: z.boolean().default(false),
          })
          .default({
            enabled: false,
            minTextUnits: 80,
            followUpMinTextUnits: 110,
            limit: 3,
            minScore: 0.1,
            mode: "hybrid",
            filterCurrentParticipants: false,
          }),
      })
      .default({
        summarization: {
          enabled: false,
          model: "fast",
          concurrency: 1,
          batchSize: 32,
          includePromptContext: false,
        },
        embedding: { enabled: false, model: "openai/text-embedding-3-small" },
        autoInject: {
          enabled: false,
          minTextUnits: 80,
          followUpMinTextUnits: 110,
          limit: 3,
          minScore: 0.1,
          mode: "hybrid",
          filterCurrentParticipants: false,
        },
      }),
  })
  .default({
    thread: {
      summarization: {
        enabled: false,
        model: "fast",
        concurrency: 1,
        batchSize: 32,
        includePromptContext: false,
      },
      embedding: { enabled: false, model: "openai/text-embedding-3-small" },
      autoInject: {
        enabled: false,
        minTextUnits: 80,
        followUpMinTextUnits: 110,
        limit: 3,
        minScore: 0.1,
        mode: "hybrid",
        filterCurrentParticipants: false,
      },
    },
  });

const workflowsSchemaV2 = z
  .object({
    maxActiveRuns: z.number().int().positive().default(64),
  })
  .default({ maxActiveRuns: 64 });

const modelsSchemaV2 = z
  .object({
    /** Optional registry of reusable model presets, referenced by alias. */
    def: z
      .record(
        z.string().min(1),
        z.object({
          /** Canonical model spec in provider/model format. */
          model: z.string().min(1),
          /** Portable AI SDK reasoning effort. */
          reasoning: modelReasoningEffortSchema.optional(),
          /** AI SDK providerOptions-style object (nested JSON allowed). */
          options: jsonObjectSchema.optional(),
          /** Optional ordered model fallback chain. */
          fallback: modelFallbackSchemaV2,
          /** Optional parent-agent guidance shown alongside this model alias. */
          comment: z.string().trim().min(1).optional(),
          /** Whether subagent_delegate may dynamically select this alias. */
          agentCanSelect: z.boolean().default(false),
        }),
      )
      .default({}),

    main: z
      .object({
        /** Model spec in provider/model format OR an alias from models.def. */
        model: z.string().min(1).default("openrouter/openai/gpt-4o"),
        /** Portable AI SDK reasoning effort. */
        reasoning: modelReasoningEffortSchema.optional(),
        /** Provider-specific model options. */
        options: jsonObjectSchema.optional(),
        /** Optional ordered model fallback chain. */
        fallback: modelFallbackSchemaV2,
      })
      .default({
        model: "openrouter/openai/gpt-4o",
      }),

    /** Fast/cheap model for lightweight features (router gate, etc.). */
    fast: z
      .object({
        model: z.string().min(1).default("openrouter/openai/gpt-4o-mini"),
        reasoning: modelReasoningEffortSchema.optional(),
        options: jsonObjectSchema.optional(),
        fallback: modelFallbackSchemaV2,
      })
      .default({
        model: "openrouter/openai/gpt-4o-mini",
      }),

    capability: modelCapabilitySchemaV2,
  })
  .superRefine((models, ctx) => {
    for (const [alias, preset] of Object.entries(models.def)) {
      if (alias.includes("/")) {
        ctx.addIssue({
          code: "custom",
          path: ["def", alias],
          message: "model alias must not contain '/'",
        });
      }
      if (!/^[^/]+\/.+/u.test(preset.model)) {
        ctx.addIssue({
          code: "custom",
          path: ["def", alias, "model"],
          message: "models.def model must use provider/model format",
        });
      }
    }
  })
  .default({
    def: {},
    main: { model: "openrouter/openai/gpt-4o" },
    fast: { model: "openrouter/openai/gpt-4o-mini" },
    capability: {
      forceUnknownProviders: ["openai-compatible"],
      overrides: {},
    },
  });

export const coreConfigInputSchemaV2 = z.object({
  configVersion: configVersionSchema,

  tools: toolsSchema,
  plugins: pluginsSchemaV2,
  conversation: conversationSchemaV2,
  workflows: workflowsSchemaV2,

  surface: z
    .object({
      router: routerSchema,
      discord: discordSurfaceSchema,
      telegram: telegramSurfaceSchema,
      heartbeat: heartbeatSchema,
    })
    // Lazy: a literal default object is built once at module load and handed
    // out by reference, so every config would share the same nested arrays.
    .default(() => ({
      router: {
        defaultMode: "mention" as const,
        sessionModes: {},
        activeDebounceMs: 3000,
        activeGate: { enabled: false, timeoutMs: 2500 },
      },
      discord: {
        tokenEnv: "DISCORD_TOKEN",
        allowedChannelIds: [] as string[],
        allowedGuildIds: [] as string[],
        botName: "lilac",
        outputMode: "preview" as const,
        outputPreviewModeFinalStyle: "plain" as const,
        outputNotification: true,
        workingIndicators: cloneDefaultWorkingIndicators(),
        markdownTableRender: {
          enabled: true,
          style: "unicode" as const,
          maxWidth: 50,
          fallbackMode: "list" as const,
        },
        markdownMathRender: {
          enabled: false,
          maxWidth: 50,
          fallbackMode: "source" as const,
        },
      },
      telegram: cloneDefaultTelegramSurface(),
      heartbeat: {
        enabled: false,
        cron: "*/30 * * * *",
        quietAfterActivityMs: 5 * 60 * 1000,
        retryBusyMs: 60 * 1000,
        defaultOutputSession: undefined,
        softQuietHours: undefined,
      },
    })),

  agent: z
    .object({
      statsForNerds: statsForNerdsSchema,
      reasoningDisplay: reasoningDisplaySchema,
      idleTimeoutMs: z
        .number()
        .int()
        .min(1_500)
        .default(15 * 60 * 1000),
      retry: agentRetrySchema,
      subagents: subagentsSchemaV2.default({
        enabled: true,
        maxDepth: 2,
        profiles: {
          explore: EXPLORE_PROFILE_DEFAULT,
          general: GENERAL_PROFILE_DEFAULT,
          self: SELF_PROFILE_DEFAULT,
        },
      }),
    })
    .default({
      statsForNerds: false,
      reasoningDisplay: "detailed",
      idleTimeoutMs: 15 * 60 * 1000,
      retry: {
        enabled: true,
        maxRetries: 3,
        baseDelayMs: 2_000,
        maxDelayMs: 30_000,
      },
      subagents: {
        enabled: true,
        maxDepth: 2,
        profiles: {
          explore: EXPLORE_PROFILE_DEFAULT,
          general: GENERAL_PROFILE_DEFAULT,
          self: SELF_PROFILE_DEFAULT,
        },
      },
    }),

  models: modelsSchemaV2,
  entity: coreConfigInputSchemaV1.shape.entity,
  basePrompt: z.string().optional(),
});

export type ParsedCoreConfigV2 = z.infer<typeof coreConfigInputSchemaV2>;

export class CoreConfigV2Invalid extends TaggedError("CoreConfigV2Invalid")<{
  readonly cause: z.ZodError;
  readonly message: string;
}> {}

export function decodeCoreConfigV2(
  raw: unknown,
): ResultType<ParsedCoreConfigV2, CoreConfigV2Invalid> {
  const parsed = coreConfigInputSchemaV2.safeParse(raw);
  return parsed.success
    ? Result.ok(parsed.data)
    : Result.err(
        new CoreConfigV2Invalid({
          cause: parsed.error,
          message: parsed.error.issues.map((issue) => issue.message).join("; "),
        }),
      );
}

export function parseCoreConfigV2(raw: unknown): ParsedCoreConfigV2 {
  return coreConfigInputSchemaV2.parse(raw);
}

function coreConfigV2ToUniversal(
  parsed: ParsedCoreConfigV2,
  raw: unknown,
  options?: CoreConfigParseOptions,
): UniversalCoreConfig {
  if (options?.onUnknownKey) {
    for (const path of collectUnknownConfigKeyPaths(raw, parsed)) {
      options.onUnknownKey(path);
    }
  }
  const { artifactTtl, ...output } = parsed.tools.output;
  const { firecrawl, ...web } = parsed.tools.web;

  return {
    ...parsed,
    tools: {
      ...parsed.tools,
      web: firecrawl
        ? {
            ...web,
            firecrawl: {
              maxConcurrency: firecrawl.maxConcurrency,
              queueTtlMs: firecrawl.queueTtl,
            },
          }
        : web,
      output: {
        ...output,
        artifactTtlMs: artifactTtl,
      },
    },
    agent: {
      ...parsed.agent,
      subagents: {
        ...parsed.agent.subagents,
        profiles: {
          explore: normalizeProfileToolNames(parsed.agent.subagents.profiles.explore),
          general: normalizeProfileToolNames(parsed.agent.subagents.profiles.general),
          self: normalizeProfileToolNames(parsed.agent.subagents.profiles.self),
        },
      },
      systemPrompt: "",
    },
  };
}

export function decodeCoreConfigV2ToUniversal(
  raw: unknown,
  options?: CoreConfigParseOptions,
): ResultType<UniversalCoreConfig, CoreConfigV2Invalid> {
  const parsed = decodeCoreConfigV2(raw);
  const continueDecode = parsed.match<() => ResultType<UniversalCoreConfig, CoreConfigV2Invalid>>({
    ok: (value) => () => Result.ok(coreConfigV2ToUniversal(value, raw, options)),
    err: (error) => () => Result.err(error),
  });
  return continueDecode();
}

export function parseCoreConfigV2ToUniversal(
  raw: unknown,
  options?: CoreConfigParseOptions,
): UniversalCoreConfig {
  const result = decodeCoreConfigV2ToUniversal(raw, options);
  const resolved = result.match<
    { readonly value: UniversalCoreConfig } | { readonly error: CoreConfigV2Invalid }
  >({
    ok: (value) => ({ value }),
    err: (error) => ({ error }),
  });
  if ("error" in resolved) throw resolved.error.cause;
  return resolved.value;
}

export class V2CoreConfigParser implements ConfigParser {
  readonly version = V2_CORE_CONFIG_VERSION;

  async parse(input: object, options?: CoreConfigParseOptions): Promise<UniversalCoreConfig> {
    return parseCoreConfigV2ToUniversal(input, options);
  }
}
