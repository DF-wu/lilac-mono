import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

import { normalizeBaseUrl } from "./shared";
import type { WebSearchInput, WebSearchProvider, WebSearchResult } from "./types";

/**
 * OpenAI Responses API `web_search` as a `web.search` provider.
 *
 * One non-streaming Responses call runs the hosted search and returns an
 * answer whose `url_citation` annotations point at the pages the model relied
 * on. Those citations, in answer order, become the search results; retrieved
 * sources that were not cited are appended afterwards so the caller still sees
 * what the search covered. The tool has no publish-date filter, so time
 * constraints are passed to the model as instructions rather than parameters.
 * This provider does not implement `web.extract`.
 */

export const OPENAI_WEB_SEARCH_CONTEXT_SIZES = ["low", "medium", "high"] as const;
export type OpenAIWebSearchContextSize = (typeof OPENAI_WEB_SEARCH_CONTEXT_SIZES)[number];

export const DEFAULT_OPENAI_WEB_SEARCH_MODEL = "gpt-5-mini";
const DEFAULT_OPENAI_WEB_SEARCH_CONTEXT_SIZE: OpenAIWebSearchContextSize = "medium";
const DEFAULT_OPENAI_API_BASE_URL = "https://api.openai.com/v1";

const urlCitationSchema = z.object({
  type: z.literal("url_citation"),
  url: z.string().min(1),
  title: z.string().nullable().optional(),
  start_index: z.number().int().nonnegative().optional(),
  end_index: z.number().int().nonnegative().optional(),
});

type UrlCitation = z.output<typeof urlCitationSchema>;

function decodeUrlCitations(values: readonly unknown[]): UrlCitation[] {
  return values.flatMap((value) => {
    const decoded = urlCitationSchema.safeParse(value);
    return decoded.success ? [decoded.data] : [];
  });
}

const outputTextSchema = z.object({
  type: z.literal("output_text"),
  text: z.string(),
  annotations: z.array(z.unknown()).transform(decodeUrlCitations).optional(),
});

type OutputText = z.output<typeof outputTextSchema>;

function decodeOutputTexts(values: readonly unknown[]): OutputText[] {
  return values.flatMap((value) => {
    const decoded = outputTextSchema.safeParse(value);
    return decoded.success ? [decoded.data] : [];
  });
}

const messageItemSchema = z.object({
  type: z.literal("message"),
  content: z.array(z.unknown()).transform(decodeOutputTexts),
});

const webSearchSourceSchema = z.object({
  type: z.literal("url"),
  url: z.string().min(1),
});

function decodeWebSearchSources(values: readonly unknown[]): string[] {
  return values.flatMap((value) => {
    const decoded = webSearchSourceSchema.safeParse(value);
    return decoded.success ? [decoded.data.url] : [];
  });
}

const webSearchCallItemSchema = z.object({
  type: z.literal("web_search_call"),
  status: z.string().optional(),
  action: z
    .object({
      sources: z.array(z.unknown()).transform(decodeWebSearchSources).optional(),
    })
    .nullable()
    .optional(),
});

type OutputItem = z.output<typeof messageItemSchema> | z.output<typeof webSearchCallItemSchema>;

function decodeOutputItems(values: readonly unknown[]): OutputItem[] {
  return values.flatMap((value): OutputItem[] => {
    const message = messageItemSchema.safeParse(value);
    if (message.success) return [message.data];
    const call = webSearchCallItemSchema.safeParse(value);
    return call.success ? [call.data] : [];
  });
}

const responseErrorSchema = z.object({ error: z.object({ message: z.string() }) });
const responseStatusSchema = z.object({
  status: z.enum(["failed", "cancelled", "incomplete"]),
  incomplete_details: z.object({ reason: z.string().optional() }).nullable().optional(),
});

const openaiResponseSchema = z.object({
  status: z.literal("completed"),
  output: z
    .array(z.unknown())
    .transform(decodeOutputItems)
    .refine((items) => items.some((item) => item.type === "web_search_call")),
});

type OpenAIResponse = z.output<typeof openaiResponseSchema>;
const responseEnvelopeSchema = z.union([
  responseErrorSchema.transform(({ error }) => ({
    kind: "api_error" as const,
    message: error.message,
  })),
  responseStatusSchema.transform(({ status, incomplete_details }) => ({
    kind: status,
    reason: incomplete_details?.reason,
  })),
  openaiResponseSchema.transform((payload) => ({ kind: "completed" as const, payload })),
]);
type OpenAIResponseEnvelope = z.output<typeof responseEnvelopeSchema>;

export class OpenAIWebSearchResponseInvalid extends TaggedError("OpenAIWebSearchResponseInvalid")<{
  readonly message: string;
}> {}

class OpenAIWebSearchFailure extends TaggedError("OpenAIWebSearchFailure")<{
  readonly message: string;
  readonly status?: number;
}> {}

export function decodeOpenAIWebSearchResponse(
  value: unknown,
): ResultType<OpenAIResponseEnvelope, OpenAIWebSearchResponseInvalid> {
  const decoded = responseEnvelopeSchema.safeParse(value);
  if (decoded.success) return Result.ok(decoded.data);
  return Result.err(
    new OpenAIWebSearchResponseInvalid({ message: "OpenAI returned an invalid response" }),
  );
}

function adaptOpenAIWebSearchResultToHost<TValue>(
  result: ResultType<TValue, OpenAIWebSearchFailure>,
): TValue {
  return result.match({
    ok: (value) => () => value,
    err: (error) => () => {
      throw Object.assign(new Error(error.message), { status: error.status });
    },
  })();
}

function decodeOpenAIApiKey(
  apiKey: string | undefined,
): ResultType<string, OpenAIWebSearchFailure> {
  if (apiKey) return Result.ok(apiKey);
  return Result.err(new OpenAIWebSearchFailure({ message: "OPENAI_API_KEY is not configured." }));
}

async function captureOpenAIResponseJson(
  response: Response,
): Promise<ResultType<unknown, OpenAIWebSearchFailure>> {
  return Result.tryPromise({
    try: () => response.json(),
    catch: () =>
      new OpenAIWebSearchFailure({
        message: `OpenAI web search failed (${response.status}): invalid JSON response.`,
        status: response.status,
      }),
  });
}

function describeTimeConstraint(input: WebSearchInput): string | null {
  if (input.startDate && input.endDate) {
    return `Only rely on sources published between ${input.startDate} and ${input.endDate}.`;
  }
  if (input.startDate) return `Only rely on sources published on or after ${input.startDate}.`;
  if (input.endDate) return `Only rely on sources published on or before ${input.endDate}.`;

  switch (input.timeRange) {
    case "day":
    case "d":
      return "Only rely on sources published within the last day.";
    case "week":
    case "w":
      return "Only rely on sources published within the last week.";
    case "month":
    case "m":
      return "Only rely on sources published within the last month.";
    case "year":
    case "y":
      return "Only rely on sources published within the last year.";
    case undefined:
      return null;
  }
}

function describeTopic(topic: WebSearchInput["topic"]): string | null {
  switch (topic) {
    case "news":
      return "Prefer recent news coverage.";
    case "finance":
      return "Prefer financial and market sources.";
    case "general":
      return null;
  }
}

export function buildOpenAIWebSearchInstructions(input: WebSearchInput): string {
  const lines = [
    "Search the web for the query below and answer it briefly.",
    `Cite every source you rely on, and use up to ${input.maxResults} distinct sources.`,
    describeTopic(input.topic),
    describeTimeConstraint(input),
    "",
    `Query: ${input.query}`,
  ];
  return lines.filter((line): line is string => line !== null).join("\n");
}

const CITATION_MARKER_RE = /\s*\((?:\s*\[[^\]]*\]\([^)]*\)\s*,?)+\s*\)/gu;
const MAX_SNIPPET_CHARS = 600;
const GENERATED_SUMMARY_LABEL = "OpenAI-generated summary (may combine cited sources): ";

/** Removes the inline `([site](url))` markers the model appends for citations. */
export function stripCitationMarkers(text: string): string {
  return text.replaceAll(CITATION_MARKER_RE, "").replaceAll(/\s+/gu, " ").trim();
}

/**
 * The annotation range covers only the `([site](url))` marker, which the
 * model places at the end of the paragraph it supports, so the snippet is
 * that paragraph with markers removed rather than the marker itself.
 */
function citationSnippet(text: string, citation: UrlCitation): string {
  if (citation.start_index === undefined || citation.end_index === undefined) return "";
  if (citation.end_index <= citation.start_index || citation.end_index > text.length) return "";
  const previousBreak = text.lastIndexOf("\n\n", citation.start_index);
  const paragraphStart = previousBreak === -1 ? 0 : previousBreak + 2;
  const nextBreak = text.indexOf("\n\n", citation.end_index);
  const paragraphEnd = nextBreak === -1 ? text.length : nextBreak;
  return stripCitationMarkers(text.slice(paragraphStart, paragraphEnd)).slice(0, MAX_SNIPPET_CHARS);
}

/** Drops the `utm_source=openai` tag the hosted search appends to cited URLs. */
export function normalizeCitedUrl(url: string): string {
  const parsed = URL.parse(url);
  if (!parsed || parsed.searchParams.get("utm_source") !== "openai") return url;
  parsed.searchParams.delete("utm_source");
  return parsed.toString();
}

export function collectOpenAIWebSearchResults(
  payload: OpenAIResponse,
  maxResults: number,
): WebSearchResult[] {
  const byUrl = new Map<string, WebSearchResult>();
  const sources: string[] = [];

  for (const item of payload.output) {
    if (item.type === "web_search_call") {
      sources.push(...(item.action?.sources ?? []));
      continue;
    }
    for (const part of item.content) {
      for (const citation of part.annotations ?? []) {
        const url = normalizeCitedUrl(citation.url);
        const snippet = citationSnippet(part.text, citation);
        const content = snippet ? `${GENERATED_SUMMARY_LABEL}${snippet}` : "";
        const existing = byUrl.get(url);
        if (existing) {
          if (existing.content.length === 0 && content.length > 0) {
            byUrl.set(url, { ...existing, content });
          }
          continue;
        }
        byUrl.set(url, {
          url,
          title: citation.title?.trim() || url,
          content,
          score: null,
        });
      }
    }
  }

  for (const source of sources) {
    const url = normalizeCitedUrl(source);
    if (byUrl.has(url)) continue;
    byUrl.set(url, { url, title: url, content: "", score: null });
  }

  return [...byUrl.values()].slice(0, Math.max(1, maxResults));
}

function decodeOpenAIWebSearchOutcome(
  response: Response,
  envelope: OpenAIResponseEnvelope,
  maxResults: number,
): ResultType<readonly WebSearchResult[], OpenAIWebSearchFailure> {
  if (!response.ok) {
    return Result.err(
      new OpenAIWebSearchFailure({
        message: `OpenAI web search failed (${response.status}): ${envelope.kind === "api_error" ? envelope.message : response.statusText || "request failed"}`,
        status: response.status,
      }),
    );
  }
  if (envelope.kind === "api_error") {
    return Result.err(
      new OpenAIWebSearchFailure({
        message: `OpenAI web search failed (${response.status}): ${envelope.message}`,
        status: response.status,
      }),
    );
  }
  if (envelope.kind === "failed" || envelope.kind === "cancelled") {
    return Result.err(
      new OpenAIWebSearchFailure({
        message: `OpenAI web search failed (${response.status}): response status '${envelope.kind}'.`,
        status: response.status,
      }),
    );
  }
  if (envelope.kind === "incomplete") {
    return Result.err(
      new OpenAIWebSearchFailure({
        message: `OpenAI web search failed (${response.status}): response incomplete (${envelope.reason ?? "unknown reason"}).`,
        status: response.status,
      }),
    );
  }
  if (envelope.kind === "completed") {
    return Result.ok(collectOpenAIWebSearchResults(envelope.payload, maxResults));
  }
  return Result.err(
    new OpenAIWebSearchFailure({
      message: `OpenAI web search failed (${response.status}): invalid response contract.`,
      status: response.status,
    }),
  );
}

export class OpenAIWebSearchProvider implements WebSearchProvider {
  readonly id = "openai" as const;

  constructor(
    private readonly config: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
      searchContextSize?: OpenAIWebSearchContextSize;
    },
  ) {}

  isConfigured(): boolean {
    return typeof this.config.apiKey === "string" && this.config.apiKey.length > 0;
  }

  private resolveApiUrl(pathname: string): string {
    const baseUrlRaw = this.config.baseUrl?.trim();
    const baseUrl = baseUrlRaw ? normalizeBaseUrl(baseUrlRaw) : DEFAULT_OPENAI_API_BASE_URL;
    return `${baseUrl}${pathname}`;
  }

  async search(
    input: WebSearchInput,
    opts?: {
      signal?: AbortSignal;
    },
  ): Promise<readonly WebSearchResult[]> {
    const apiKey = adaptOpenAIWebSearchResultToHost(decodeOpenAIApiKey(this.config.apiKey));

    const body = {
      model: this.config.model?.trim() || DEFAULT_OPENAI_WEB_SEARCH_MODEL,
      input: buildOpenAIWebSearchInstructions(input),
      tools: [
        {
          type: "web_search",
          search_context_size:
            this.config.searchContextSize ?? DEFAULT_OPENAI_WEB_SEARCH_CONTEXT_SIZE,
        },
      ],
      // The hosted search is the only tool offered, so "required" forces a
      // real search instead of an answer from model memory.
      tool_choice: "required",
      include: ["web_search_call.action.sources"],
      store: false,
    };

    const response = await fetch(this.resolveApiUrl("/responses"), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: opts?.signal,
    });

    const rawPayload = adaptOpenAIWebSearchResultToHost(await captureOpenAIResponseJson(response));
    const envelope = decodeOpenAIWebSearchResponse(rawPayload);
    return adaptOpenAIWebSearchResultToHost(
      envelope
        .mapError(
          () =>
            new OpenAIWebSearchFailure({
              message: `OpenAI web search failed (${response.status}): invalid response contract.`,
              status: response.status,
            }),
        )
        .andThen((value) => decodeOpenAIWebSearchOutcome(response, value, input.maxResults)),
    );
  }
}
