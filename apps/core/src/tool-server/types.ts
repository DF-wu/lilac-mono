import type {
  RequestContext as PluginRequestContext,
  ServerTool as PluginServerTool,
  ServerToolCallOptions as PluginServerToolCallOptions,
} from "@stanley2058/lilac-plugin-runtime";
import {
  defineServerTool as definePluginServerTool,
  type ServerToolDefinition,
} from "@stanley2058/lilac-plugin-runtime";

import type { RegisteredSurfacePlatform } from "../surface/types";

export type RequestContext = PluginRequestContext<RegisteredSurfacePlatform>;
export type ServerTool = PluginServerTool<RegisteredSurfacePlatform>;
export type ServerToolCallOptions = PluginServerToolCallOptions<RegisteredSurfacePlatform>;
export function defineServerTool(
  definition: ServerToolDefinition<RegisteredSurfacePlatform>,
): ServerTool {
  return definePluginServerTool<RegisteredSurfacePlatform>(definition);
}
export type {
  ServerToolHelpEntry,
  ServerToolPrimaryPositional,
  ServerToolListResult,
} from "@stanley2058/lilac-plugin-runtime";
