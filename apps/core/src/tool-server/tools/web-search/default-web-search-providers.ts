import { ExaWebSearchProvider } from "./exa-web-search-provider";
import { FirecrawlWebSearchProvider } from "./firecrawl-web-search-provider";
import {
  OpenAIWebSearchProvider,
  type OpenAIWebSearchContextSize,
} from "./openai-web-search-provider";
import { TavilyWebSearchProvider } from "./tavily-web-search-provider";
import type { WebSearchProvider } from "./types";

export function createDefaultWebSearchProviders(config: {
  firecrawl: {
    apiKey?: string;
    apiBaseUrl?: string;
  };
  exa: {
    baseUrl?: string;
    apiKey?: string;
  };
  tavilyApiKey?: string;
  tavilyApiBaseUrl?: string;
  openai: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    searchContextSize?: OpenAIWebSearchContextSize;
  };
}): readonly WebSearchProvider[] {
  return [
    new FirecrawlWebSearchProvider({
      apiKey: config.firecrawl.apiKey,
      apiBaseUrl: config.firecrawl.apiBaseUrl,
    }),
    new ExaWebSearchProvider({
      baseUrl: config.exa.baseUrl,
      apiKey: config.exa.apiKey,
    }),
    new TavilyWebSearchProvider({
      apiBaseUrl: config.tavilyApiBaseUrl,
      apiKey: config.tavilyApiKey,
    }),
    new OpenAIWebSearchProvider({
      apiKey: config.openai.apiKey,
      baseUrl: config.openai.baseUrl,
      model: config.openai.model,
      searchContextSize: config.openai.searchContextSize,
    }),
  ];
}
