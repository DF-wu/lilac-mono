import type { OpenAICompatibleServerConfig } from "./core-config/types";

export type OpenAICompatibleServers = Readonly<Record<string, OpenAICompatibleServerConfig>>;

let activeOpenAICompatibleServers: OpenAICompatibleServers = {};

/** Sets the servers used when a caller passes no config snapshot. */
export function configureOpenAICompatibleServers(servers: OpenAICompatibleServers): void {
  activeOpenAICompatibleServers = servers;
}

export function getActiveOpenAICompatibleServers(): OpenAICompatibleServers {
  return activeOpenAICompatibleServers;
}

/** Shared named selection for Chat Completions and protocol-specific clients. */
export function selectOpenAICompatibleServer(modelId: string, servers: OpenAICompatibleServers) {
  const slash = modelId.indexOf("/");
  const name = slash > 0 ? modelId.slice(0, slash) : "";
  const server = Object.hasOwn(servers, name) ? servers[name] : undefined;
  if (!server) return undefined;
  return { name, server, modelId: modelId.slice(slash + 1) };
}
