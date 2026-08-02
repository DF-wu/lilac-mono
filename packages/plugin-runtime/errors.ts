import { TaggedError } from "better-result";

import type { PluginSource } from "./types";

export type PluginCapability =
  | "module"
  | "plugin"
  | "instance"
  | "level1"
  | "level2"
  | "package_json"
  | "hook_result";

export class ToolPluginCapabilityError extends TaggedError("ToolPluginCapabilityError")<{
  readonly capability: PluginCapability;
  readonly pluginId?: string;
  readonly issues: readonly string[];
  readonly cause?: unknown;
  readonly message: string;
}> {}

export class ToolPluginModuleLoadError extends TaggedError("ToolPluginModuleLoadError")<{
  readonly entrypointPath: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class ToolPluginDiscoveryError extends TaggedError("ToolPluginDiscoveryError")<{
  readonly operation: "read_plugins" | "fingerprint_plugins";
  readonly path: string;
  readonly code?: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export type ToolPluginHookName =
  | "plugin.create"
  | "instance.init"
  | "instance.destroy"
  | "level1.createTool"
  | "level1.isEnabled"
  | "level1.editTargets"
  | "level1.formatArgs"
  | "level1.summarizeFailure"
  | "level2.init"
  | "level2.destroy"
  | "level2.list"
  | "level2.call";

export class ToolPluginHookError extends TaggedError("ToolPluginHookError")<{
  readonly pluginId: string;
  readonly source: PluginSource;
  readonly hook: ToolPluginHookName;
  readonly itemId?: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class ToolPluginSkipped extends TaggedError("ToolPluginSkipped")<{
  readonly pluginId: string;
  readonly source: PluginSource;
  readonly reason: string;
  readonly message: string;
}> {}

export class ToolPluginManagerHookError extends TaggedError("ToolPluginManagerHookError")<{
  readonly hook:
    | "getDisabledPluginIds"
    | "getPluginConfig"
    | "getLevel1RegistrationKey"
    | "adaptLevel1Item"
    | "adaptLevel2Item";
  readonly pluginId?: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class ToolPluginRegistrationError extends TaggedError("ToolPluginRegistrationError")<{
  readonly pluginId: string;
  readonly source: PluginSource;
  readonly contribution: "plugin" | "level1" | "level2";
  readonly key: string;
  readonly priorPluginId?: string;
  readonly message: string;
}> {}

export type ToolPluginCleanupFailure =
  | ToolPluginHookError
  | ToolPluginCapabilityError
  | ToolPluginSkipped;

export class ToolPluginCleanupError extends TaggedError("ToolPluginCleanupError")<{
  readonly failures: readonly ToolPluginCleanupFailure[];
  readonly message: string;
}> {}

export type ToolPluginOperationError =
  | ToolPluginCapabilityError
  | ToolPluginModuleLoadError
  | ToolPluginDiscoveryError
  | ToolPluginHookError
  | ToolPluginSkipped
  | ToolPluginManagerHookError
  | ToolPluginRegistrationError;

export class ToolPluginOperationAndCleanupError extends TaggedError(
  "ToolPluginOperationAndCleanupError",
)<{
  readonly primary: ToolPluginOperationError;
  readonly cleanup: ToolPluginCleanupError;
  readonly message: string;
}> {}

export class ToolPluginReloadCommittedCleanupError extends TaggedError(
  "ToolPluginReloadCommittedCleanupError",
)<{
  readonly cleanup: ToolPluginCleanupError;
  readonly message: string;
}> {}

export type ToolPluginManagerError =
  | ToolPluginOperationError
  | ToolPluginCleanupError
  | ToolPluginOperationAndCleanupError
  | ToolPluginReloadCommittedCleanupError;

export class ToolPluginSkipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolPluginSkipError";
  }
}
