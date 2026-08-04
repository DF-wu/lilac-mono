import { cloneDefaultWorkingIndicators } from "../working-indicators";

export type JSONValue = null | string | number | boolean | JSONObject | JSONArray;
export type JSONArray = JSONValue[];
export type JSONObject = {
  [key: string]: JSONValue | undefined;
};

export type CoreConfigVersion = 1 | 2;

export type CoreConfigKeyPath = readonly (string | number)[];

export type CoreConfigModelOptionWarning = {
  namespace: string;
  option: string;
  suggestion?: string;
};

export type CoreConfigParseOptions = {
  onUnknownKey?: (path: CoreConfigKeyPath) => void;
  onUnknownModelOption?: (warning: CoreConfigModelOptionWarning, source: string) => void;
};

export type DiscordUserAliasConfig = {
  discord: string;
  comment?: string;
};

export type DiscordSessionAliasConfig =
  | string
  | {
      discord: string;
      comment?: string;
    };

export type ConfiguredModelRef = {
  /** Model ref in provider/model format or alias from models.def. */
  model: string;
  /** Optional portable AI SDK reasoning effort. */
  reasoning?: ModelReasoningEffort;
  /** Optional providerOptions override. */
  options?: JSONObject;
};

export type ConfiguredModelChainEntry = string | ConfiguredModelRef;

export type SubagentProfileConfig = {
  modelSlot: "main" | "fast";
  model?: string;
  reasoning?: ModelReasoningEffort;
  options?: JSONObject;
  fallback?: ConfiguredModelChainEntry[];
  promptOverlay?: string;
  level1: {
    tools: string[];
    plugins: string[];
  };
  level2: {
    callables: string[];
    plugins: string[];
  };
  /** Network behavior/tool-surface setting; not a trusted-Bash network boundary. */
  network: boolean;
  /** Write behavior/edit-tool setting; not a trusted-Bash filesystem boundary. */
  workspaceWrites: boolean;
  execution: boolean;
  delegation: boolean;
};

export const MODEL_REASONING_EFFORTS = [
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

export type ModelReasoningEffort = (typeof MODEL_REASONING_EFFORTS)[number];

export type ModelCapabilityOverride = {
  inherit?: string;
  cost?: {
    input?: number;
    output?: number;
    cache_read?: number;
    cache_write?: number;
    input_audio?: number;
    output_audio?: number;
    context_over_200k?: {
      input: number;
      output: number;
      cache_read?: number;
      cache_write?: number;
    };
  };
  limit?: {
    context?: number;
    output?: number;
  };
  attachment?: boolean;
  modalities?: {
    input?: Array<"text" | "image" | "audio" | "video" | "pdf">;
    output?: Array<"text" | "image" | "audio" | "video" | "pdf">;
  };
};

export const TELEGRAM_SURFACE_DEFAULTS = {
  enabled: false,
  botName: "lilac",
  outputMode: "preview",
  parseMode: "html",
  streamEditIntervalMs: 1500,
  outputNotification: true,
  commandMenu: true,
  markdownTableRender: {
    enabled: true,
    style: "unicode",
    maxWidth: 50,
    fallbackMode: "list",
  },
} as const;

/**
 * Shared by the v2 schema and by the v1 fallback so both config versions
 * produce an identical `surface.telegram` shape. The core-config drift test
 * asserts this equivalence.
 */
export function cloneDefaultTelegramSurface(): UniversalCoreConfig["surface"]["telegram"] {
  return {
    ...TELEGRAM_SURFACE_DEFAULTS,
    allowedChatIds: [],
    allowedUserIds: [],
    workingIndicators: cloneDefaultWorkingIndicators(),
    markdownTableRender: { ...TELEGRAM_SURFACE_DEFAULTS.markdownTableRender },
  };
}

export type UniversalCoreConfig = {
  configVersion: CoreConfigVersion;

  tools: {
    fsBackend: "fff" | "node-rg";
    generate: {
      image: {
        provider: "default" | "openai-compatible";
      };
    };
    web: {
      extract: {
        providers: Array<"tavily" | "exa" | "firecrawl">;
      };
      fetch: {
        mode: "auto" | "fetch" | "browser" | "extract" | "provider-only";
      };
    };
    inspect: {
      model: string;
    };
    editFile: {
      hashline: boolean;
    };
    output: {
      maxPreviewBytes: number;
      artifactTtlMs: number;
      artifactMaxBytesPerSession: number;
    };
    historicalResultPruning: {
      enabled: boolean;
      protectTokens: number;
      minimumTokens: number;
    };
    batch: {
      maxCalls: number;
    };
    media: {
      maxInlineBytesPerPart: number;
      maxInlineBytesTotal: number;
    };
  };

  plugins: {
    disabled: string[];
    config: Record<string, unknown>;
  };

  conversation: {
    thread: {
      summarization: {
        enabled: boolean;
        model: string;
        concurrency: number;
        batchSize: number;
        includePromptContext: boolean;
      };
      embedding: {
        enabled: boolean;
        model: string;
      };
      autoInject: {
        enabled: boolean;
        plannerModel?: string;
        minTextUnits: number;
        followUpMinTextUnits: number;
        limit: number;
        minScore: number;
        mode: "hybrid" | "semantic" | "lexical";
        filterCurrentParticipants: boolean;
      };
    };
  };

  workflows: {
    maxActiveRuns: number;
  };

  surface: {
    router: {
      defaultMode: "mention" | "active";
      sessionModes: Record<
        string,
        {
          mode?: "mention" | "active";
          gate?: boolean;
          model?: string;
          safetyMode?: "trusted" | "restricted";
          additionalPrompts?: string[];
        }
      >;
      activeDebounceMs: number;
      activeGate: {
        enabled: boolean;
        timeoutMs: number;
      };
    };

    discord: {
      tokenEnv: string;
      allowedChannelIds: string[];
      allowedGuildIds: string[];
      dbPath?: string;
      botName: string;
      statusMessage?: string;
      memberPresence?: boolean;
      outputMode: "inline" | "preview";
      outputPreviewModeFinalStyle: "embed" | "plain";
      outputNotification?: boolean;
      workingIndicators: string[];
      markdownTableRender: {
        enabled: boolean;
        style: "unicode" | "ascii";
        maxWidth: number;
        fallbackMode: "list" | "passthrough";
      };
    };

    telegram: {
      /** Telegram surface is opt-in; when false the adapter is never constructed. */
      enabled: boolean;
      /** Bot API token. Keep core-config.yaml private because this is a secret. */
      token?: string;
      /** Identity used for mention detection and prompt attribution. */
      botName: string;
      /** Resolved from getMe at connect time when omitted. */
      botUsername?: string;
      /** Empty means "deny all": the surface fails closed. */
      allowedChatIds: string[];
      /** Empty means "no user-level restriction" (chat allowlist still applies). */
      allowedUserIds: string[];
      dbPath?: string;
      /**
       * Bot API endpoint. Telegram supports self-hosted Bot API servers, which
       * raise the file-size limits; this also lets a verification run point at
       * a local endpoint. Defaults to https://api.telegram.org.
       */
      apiRoot?: string;
      /**
       * Telegram edits the streamed message in place, so on a successful run
       * both modes produce the same result. The mode only changes what happens
       * on cancellation: `preview` removes the streamed messages, `inline`
       * leaves the partial answer visible.
       */
      outputMode: "inline" | "preview";
      parseMode: "html" | "plain";
      /** Minimum gap between streaming editMessageText calls, per Bot API rate limits. */
      streamEditIntervalMs: number;
      outputNotification: boolean;
      workingIndicators: string[];
      /** Register the bot command menu via setMyCommands on connect. */
      commandMenu: boolean;
      markdownTableRender: {
        enabled: boolean;
        style: "unicode" | "ascii";
        maxWidth: number;
        fallbackMode: "list" | "passthrough";
      };
    };

    heartbeat: {
      enabled: boolean;
      cron: string;
      quietAfterActivityMs: number;
      retryBusyMs: number;
      defaultOutputSession?: string;
      softQuietHours?: {
        start: string;
        end: string;
        timezone?: string;
      };
    };
  };

  agent: {
    systemPrompt: string;
    statsForNerds: boolean | { verbose: boolean };
    reasoningDisplay: "none" | "simple" | "detailed";
    idleTimeoutMs: number;
    retry: {
      enabled: boolean;
      maxRetries: number;
      baseDelayMs: number;
      maxDelayMs: number;
    };
    subagents: {
      enabled: boolean;
      maxDepth: number;
      idleTimeoutMs: number;
      delegatePromptOverlay?: string;
      profiles: {
        explore: SubagentProfileConfig;
        general: SubagentProfileConfig;
        self: SubagentProfileConfig;
      };
    };
  };

  models: {
    def: Record<
      string,
      {
        model: string;
        reasoning?: ModelReasoningEffort;
        options?: JSONObject;
        fallback?: ConfiguredModelChainEntry[];
        comment?: string;
        agentCanSelect?: boolean;
      }
    >;
    main: {
      model: string;
      reasoning?: ModelReasoningEffort;
      options?: JSONObject;
      fallback?: ConfiguredModelChainEntry[];
    };
    fast: {
      model: string;
      reasoning?: ModelReasoningEffort;
      options?: JSONObject;
      fallback?: ConfiguredModelChainEntry[];
    };
    capability: {
      forceUnknownProviders: string[];
      overrides: Record<string, ModelCapabilityOverride>;
    };
  };

  entity?: {
    users: Record<string, DiscordUserAliasConfig>;
    sessions: {
      discord: Record<string, DiscordSessionAliasConfig>;
    };
  };

  basePrompt?: string;
};

export type CoreConfig = UniversalCoreConfig;

export interface ConfigParser {
  readonly version: CoreConfigVersion;
  parse(input: object, options?: CoreConfigParseOptions): Promise<UniversalCoreConfig>;
}
