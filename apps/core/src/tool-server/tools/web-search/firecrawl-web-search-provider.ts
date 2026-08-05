import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import { normalizeBaseUrl } from "./shared";
import type { WebSearchInput, WebSearchProvider, WebSearchResult } from "./types";

const firecrawlSearchItemSchema = z.object({
  url: z.string().nullable().optional(),
  sourceURL: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  markdown: z.string().nullable().optional(),
  content: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  snippet: z.string().nullable().optional(),
  score: z.number().nullable().optional(),
  metadata: z
    .object({
      sourceURL: z.string().nullable().optional(),
      title: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

type FirecrawlSearchItemInput = z.output<typeof firecrawlSearchItemSchema>;

function decodeFirecrawlSearchItems(values: readonly unknown[]): FirecrawlSearchItemInput[] {
  return values.flatMap((value) => {
    const decoded = firecrawlSearchItemSchema.safeParse(value);
    return decoded.success ? [decoded.data] : [];
  });
}

const firecrawlSearchItemsSchema = z.array(z.unknown()).transform(decodeFirecrawlSearchItems);
const firecrawlSearchCollectionSchema = z.object({
  web: firecrawlSearchItemsSchema.optional(),
  news: firecrawlSearchItemsSchema.optional(),
  results: firecrawlSearchItemsSchema.optional(),
});
const firecrawlSearchDataSchema = z
  .union([firecrawlSearchItemsSchema, firecrawlSearchCollectionSchema])
  .nullable();
const firecrawlSearchResponseSchema = z.object({
  success: z.boolean().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
  data: firecrawlSearchDataSchema.optional(),
  web: firecrawlSearchItemsSchema.optional(),
  news: firecrawlSearchItemsSchema.optional(),
  results: firecrawlSearchItemsSchema.optional(),
});

type FirecrawlSearchResponse = z.output<typeof firecrawlSearchResponseSchema>;

export class FirecrawlSearchResponseInvalid extends TaggedError("FirecrawlSearchResponseInvalid")<{
  readonly message: string;
}> {}

class FirecrawlSearchFailure extends TaggedError("FirecrawlSearchFailure")<{
  readonly message: string;
}> {}

export function decodeFirecrawlSearchResponse(
  value: unknown,
): ResultType<FirecrawlSearchResponse, FirecrawlSearchResponseInvalid> {
  const decoded = firecrawlSearchResponseSchema.safeParse(value);
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(
    new FirecrawlSearchResponseInvalid({ message: "Firecrawl returned an invalid response" }),
  );
}

function adaptFirecrawlSearchResultToProviderHost<TValue>(
  result: ResultType<TValue, FirecrawlSearchFailure>,
): TValue {
  if (result.status === "ok") return result.value;
  throw new Error(result.error.message);
}

function decodeFirecrawlApiKey(
  apiKey: string | undefined,
): ResultType<string, FirecrawlSearchFailure> {
  if (apiKey) return Result.ok(apiKey);
  return Result.err(
    new FirecrawlSearchFailure({ message: "FIRECRAWL_API_KEY is not configured." }),
  );
}

async function captureFirecrawlResponseJson(
  response: Response,
): Promise<ResultType<unknown, FirecrawlSearchFailure>> {
  return Result.tryPromise({
    try: () => response.json(),
    catch: () =>
      new FirecrawlSearchFailure({
        message: `Firecrawl search failed (${response.status}): invalid JSON response.`,
      }),
  });
}

function decodeFirecrawlSearchOutcome(
  response: Response,
  payload: FirecrawlSearchResponse,
): ResultType<readonly WebSearchResult[], FirecrawlSearchFailure> {
  if (!response.ok || payload.success === false) {
    return Result.err(
      new FirecrawlSearchFailure({
        message: `Firecrawl search failed (${response.status}): ${response.statusText || "request failed"}`,
      }),
    );
  }
  return Result.ok(
    toFirecrawlItems(payload).map((item) => ({
      url: item.url,
      title: item.title,
      content: item.content,
      score: item.score,
    })),
  );
}

type FirecrawlSearchItem = {
  url: string;
  title: string;
  content: string;
  score: number | null;
};

function getString(
  record: FirecrawlSearchItemInput,
  key: keyof FirecrawlSearchItemInput,
): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function getNumber(record: FirecrawlSearchItemInput, key: "score"): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toUsDate(date: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date);
  if (!match) return null;
  return `${Number(match[2])}/${Number(match[3])}/${match[1]}`;
}

function buildFirecrawlTbs(input: WebSearchInput): string | undefined {
  if (input.startDate || input.endDate) {
    const minDate = input.startDate ? toUsDate(input.startDate) : null;
    const maxDate = input.endDate ? toUsDate(input.endDate) : null;
    if (minDate && maxDate) {
      return `cdr:1,cd_min:${minDate},cd_max:${maxDate}`;
    }
    if (minDate) {
      return `cdr:1,cd_min:${minDate}`;
    }
    if (maxDate) {
      return `cdr:1,cd_max:${maxDate}`;
    }
    return undefined;
  }

  switch (input.timeRange) {
    case "day":
    case "d":
      return "qdr:d";
    case "week":
    case "w":
      return "qdr:w";
    case "month":
    case "m":
      return "qdr:m";
    case "year":
    case "y":
      return "qdr:y";
    default:
      return undefined;
  }
}

function mapTopicToSources(topic: WebSearchInput["topic"]): readonly string[] | undefined {
  switch (topic) {
    case "news":
      return ["news"];
    case "general":
    case "finance":
      return undefined;
  }
}

function toFirecrawlItems(payload: FirecrawlSearchResponse): FirecrawlSearchItem[] {
  const items: FirecrawlSearchItem[] = [];

  const appendItem = (value: FirecrawlSearchItemInput) => {
    const url =
      getString(value, "url") ??
      getString(value, "sourceURL") ??
      (value.metadata?.sourceURL?.trim() || null);
    if (!url) return;

    const title = getString(value, "title") ?? (value.metadata?.title?.trim() || null) ?? url;
    const content =
      getString(value, "markdown") ??
      getString(value, "content") ??
      getString(value, "description") ??
      getString(value, "snippet") ??
      "";

    items.push({
      url,
      title,
      content,
      score: getNumber(value, "score"),
    });
  };

  const appendMany = (value: readonly FirecrawlSearchItemInput[] | undefined) => {
    if (!value) return;
    for (const entry of value) {
      appendItem(entry);
    }
  };

  if (Array.isArray(payload.data)) {
    appendMany(payload.data);
  } else if (payload.data) {
    appendMany(payload.data.web);
    appendMany(payload.data.news);
    appendMany(payload.data.results);
  }

  appendMany(payload.web);
  appendMany(payload.news);
  appendMany(payload.results);

  return items;
}

export class FirecrawlWebSearchProvider implements WebSearchProvider {
  readonly id = "firecrawl" as const;

  constructor(
    private readonly config: {
      apiKey?: string;
      apiBaseUrl?: string;
    },
  ) {}

  isConfigured(): boolean {
    return typeof this.config.apiKey === "string" && this.config.apiKey.length > 0;
  }

  private resolveApiUrl(pathname: string): string {
    const baseUrlRaw = this.config.apiBaseUrl?.trim();
    const baseUrl = baseUrlRaw ? normalizeBaseUrl(baseUrlRaw) : "https://api.firecrawl.dev";
    return `${baseUrl}${pathname}`;
  }

  async search(
    input: WebSearchInput,
    opts?: {
      signal?: AbortSignal;
    },
  ): Promise<readonly WebSearchResult[]> {
    const apiKey = adaptFirecrawlSearchResultToProviderHost(
      decodeFirecrawlApiKey(this.config.apiKey),
    );

    const body: {
      query: string;
      limit: number;
      sources?: readonly string[];
      tbs?: string;
    } = {
      query: input.query,
      limit: Math.min(20, Math.max(1, input.maxResults)),
    };

    const sources = mapTopicToSources(input.topic);
    if (sources) {
      body.sources = sources;
    }

    const tbs = buildFirecrawlTbs(input);
    if (tbs) {
      body.tbs = tbs;
    }

    const response = await fetch(this.resolveApiUrl("/v2/search"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: opts?.signal,
    });

    const rawPayload = adaptFirecrawlSearchResultToProviderHost(
      await captureFirecrawlResponseJson(response),
    );
    const payload = decodeFirecrawlSearchResponse(rawPayload);
    if (payload.status === "error") {
      return adaptFirecrawlSearchResultToProviderHost(
        Result.err(
          new FirecrawlSearchFailure({
            message: `Firecrawl search failed (${response.status}): invalid response contract.`,
          }),
        ),
      );
    }
    return adaptFirecrawlSearchResultToProviderHost(
      decodeFirecrawlSearchOutcome(response, payload.value),
    );
  }
}
