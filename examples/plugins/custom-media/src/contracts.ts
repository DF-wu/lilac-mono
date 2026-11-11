import type { RequestContext } from "@stanley2058/lilac-plugin-runtime";

export type ToolCallOptions = {
  signal?: AbortSignal;
  context?: RequestContext;
  messages?: readonly unknown[];
};

export type ResolvedCredentials = {
  baseURL: string;
  apiKey: string;
};
