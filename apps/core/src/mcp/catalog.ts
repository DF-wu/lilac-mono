import { tool } from "ai";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";
import type { ClaudeCodeToolCatalogMetadataMap } from "@stanley2058/lilac-claude-code-bridge";
import type { AdapterPlatform } from "@stanley2058/lilac-event-bus";

import type { TranscriptStore } from "../transcript/transcript-store";
import {
  assignCatalogToolNames,
  catalogToolStableId,
  type CatalogToolIdentity,
} from "./catalog-identity";

export type CatalogToolCandidate = {
  readonly identity: CatalogToolIdentity;
  readonly title?: string;
  readonly description?: string;
  readonly tool: unknown;
};

export type CatalogToolEntry = {
  readonly source: CatalogToolIdentity["source"];
  readonly sourceId: string;
  readonly rawName: string;
  readonly modelName: string;
  readonly title?: string;
  /** The complete source-provided description, without catalog truncation. */
  readonly description?: string;
  readonly identity: CatalogToolIdentity;
  readonly stableId: string;
  readonly tool: unknown;
};

export type UnifiedToolCatalog = {
  readonly entries: readonly CatalogToolEntry[];
  readonly byStableId: ReadonlyMap<string, CatalogToolEntry>;
  readonly byModelName: ReadonlyMap<string, CatalogToolEntry>;
  readonly catalogMetadata: ClaudeCodeToolCatalogMetadataMap;
};

export class UnifiedToolCatalogInvalid extends TaggedError("UnifiedToolCatalogInvalid")<{
  readonly reason: "duplicate-identity" | "name-collision" | "name-missing";
  readonly message: string;
}> {}

export class PortableToolSearchInvalid extends TaggedError("PortableToolSearchInvalid")<{
  readonly message: string;
}> {}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function catalogCandidateExecutable(candidate: CatalogToolCandidate): unknown {
  return candidate.tool;
}

export function buildUnifiedToolCatalogResult(params: {
  candidates: readonly CatalogToolCandidate[];
  reservedNames?: ReadonlySet<string>;
}): ResultType<UnifiedToolCatalog, UnifiedToolCatalogInvalid> {
  const candidatesByStableId = new Map<string, CatalogToolCandidate>();
  for (const candidate of params.candidates) {
    const stableId = catalogToolStableId(candidate.identity);
    if (candidatesByStableId.has(stableId)) {
      return Result.err(
        new UnifiedToolCatalogInvalid({
          reason: "duplicate-identity",
          message: `Duplicate deferred catalog tool identity: ${stableId}`,
        }),
      );
    }
    candidatesByStableId.set(stableId, candidate);
  }

  const assignment = assignCatalogToolNames(
    params.candidates.map((candidate) => candidate.identity),
    params.reservedNames,
  );
  if (assignment.collisions.length > 0) {
    const details = assignment.collisions
      .map(
        (collision) =>
          `${collision.modelName} (${collision.reserved ? "reserved name" : "multiple tools"}): ${collision.identities
            .map((identity) => catalogToolStableId(identity))
            .join(", ")}`,
      )
      .join("; ");
    return Result.err(
      new UnifiedToolCatalogInvalid({
        reason: "name-collision",
        message: `Unable to assign unique deferred catalog tool names: ${details}`,
      }),
    );
  }

  const entries: CatalogToolEntry[] = [];
  const byStableId = new Map<string, CatalogToolEntry>();
  const byModelName = new Map<string, CatalogToolEntry>();
  const catalogMetadata: Record<string, ClaudeCodeToolCatalogMetadataMap[string]> = {};

  for (const [stableId, candidate] of [...candidatesByStableId.entries()].sort(([left], [right]) =>
    compareText(left, right),
  )) {
    const modelName = assignment.byStableId.get(stableId);
    if (!modelName) {
      return Result.err(
        new UnifiedToolCatalogInvalid({
          reason: "name-missing",
          message: `Deferred catalog tool did not receive a model name: ${stableId}`,
        }),
      );
    }
    const identity = Object.freeze({ ...candidate.identity });
    const entry = Object.freeze({
      source: identity.source,
      sourceId: identity.sourceId,
      rawName: identity.rawToolName,
      modelName,
      ...(candidate.title === undefined ? {} : { title: candidate.title }),
      ...(candidate.description === undefined ? {} : { description: candidate.description }),
      identity,
      stableId,
      tool: catalogCandidateExecutable(candidate),
    } satisfies CatalogToolEntry);
    entries.push(entry);
    byStableId.set(stableId, entry);
    byModelName.set(modelName, entry);
    catalogMetadata[modelName] = Object.freeze({
      sourceId: entry.sourceId,
      rawName: entry.rawName,
      ...(entry.title === undefined ? {} : { title: entry.title }),
      ...(entry.description === undefined ? {} : { description: entry.description }),
    });
  }

  return Result.ok(
    Object.freeze({
      entries: Object.freeze(entries),
      byStableId,
      byModelName,
      catalogMetadata: Object.freeze(catalogMetadata),
    }),
  );
}

const toolSearchInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .describe(
      "Keywords to rank, select:name,... for exact names, or +term to require a tool-name term.",
    ),
  max_results: z.number().int().positive().optional().default(5).describe("Maximum matches."),
});

type ParsedToolSearchQuery =
  | { readonly type: "select"; readonly names: readonly string[] }
  | {
      readonly type: "ranked";
      readonly requiredNameTerms: readonly string[];
      readonly keywords: readonly string[];
    };

type RankedCatalogEntry = {
  readonly entry: CatalogToolEntry;
  readonly score: number;
};

function uniqueNormalizedTerms(values: readonly string[]): string[] {
  const terms = new Set<string>();
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (normalized) terms.add(normalized);
  }
  return [...terms];
}

function parseToolSearchQuery(query: string): ParsedToolSearchQuery {
  const trimmed = query.trim();
  if (/^select:/i.test(trimmed)) {
    const names = trimmed.slice(trimmed.indexOf(":") + 1).split(",");
    return { type: "select", names: uniqueNormalizedTerms(names) };
  }

  const requiredNameTerms: string[] = [];
  const keywords: string[] = [];
  for (const token of trimmed.split(/\s+/)) {
    if (token.startsWith("+") && token.length > 1) {
      requiredNameTerms.push(token.slice(1));
    } else if (token !== "+") {
      keywords.push(token);
    }
  }
  return {
    type: "ranked",
    requiredNameTerms: uniqueNormalizedTerms(requiredNameTerms),
    keywords: uniqueNormalizedTerms(keywords),
  };
}

function isSubsequence(needle: string, haystack: string): boolean {
  let needleIndex = 0;
  for (const character of haystack) {
    if (character === needle[needleIndex]) needleIndex += 1;
    if (needleIndex === needle.length) return true;
  }
  return false;
}

function textMatchScore(
  value: string | undefined,
  term: string,
  weights: {
    readonly exact: number;
    readonly word: number;
    readonly prefix: number;
    readonly substring: number;
    readonly subsequence?: number;
  },
): number {
  if (!value) return 0;
  const normalized = value.toLowerCase();
  if (normalized === term) return weights.exact;
  if (normalized.split(/[^a-z0-9]+/).includes(term)) return weights.word;
  if (normalized.startsWith(term)) return weights.prefix;
  if (normalized.includes(term)) return weights.substring;
  return weights.subsequence && isSubsequence(term, normalized) ? weights.subsequence : 0;
}

function keywordScore(entry: CatalogToolEntry, term: string): number {
  return Math.max(
    textMatchScore(entry.modelName, term, {
      exact: 220,
      word: 170,
      prefix: 145,
      substring: 110,
      subsequence: 35,
    }),
    textMatchScore(entry.rawName, term, {
      exact: 210,
      word: 160,
      prefix: 135,
      substring: 100,
      subsequence: 30,
    }),
    textMatchScore(entry.title, term, {
      exact: 150,
      word: 120,
      prefix: 100,
      substring: 75,
      subsequence: 20,
    }),
    textMatchScore(entry.sourceId, term, {
      exact: 140,
      word: 110,
      prefix: 90,
      substring: 65,
      subsequence: 15,
    }),
    textMatchScore(entry.description, term, {
      exact: 80,
      word: 55,
      prefix: 45,
      substring: 30,
    }),
  );
}

function requiredNameScore(entry: CatalogToolEntry, term: string): number {
  const modelName = entry.modelName.toLowerCase();
  const rawName = entry.rawName.toLowerCase();
  if (!modelName.includes(term) && !rawName.includes(term)) return 0;
  return Math.max(
    textMatchScore(entry.modelName, term, {
      exact: 220,
      word: 170,
      prefix: 145,
      substring: 110,
    }),
    textMatchScore(entry.rawName, term, {
      exact: 210,
      word: 160,
      prefix: 135,
      substring: 100,
    }),
  );
}

function rankedToolMatches(
  catalog: readonly CatalogToolEntry[],
  query: Extract<ParsedToolSearchQuery, { readonly type: "ranked" }>,
): CatalogToolEntry[] {
  const matches: RankedCatalogEntry[] = [];
  for (const entry of catalog) {
    const requiredScores = query.requiredNameTerms.map((term) => requiredNameScore(entry, term));
    if (requiredScores.some((score) => score === 0)) continue;

    const keywordScores = query.keywords.map((term) => keywordScore(entry, term));
    const matchedKeywordCount = keywordScores.filter((score) => score > 0).length;
    if (requiredScores.length === 0 && matchedKeywordCount === 0) continue;

    const allKeywordsMatched =
      keywordScores.length > 0 && matchedKeywordCount === keywordScores.length;
    matches.push({
      entry,
      score:
        requiredScores.reduce((total, score) => total + score, 0) +
        keywordScores.reduce((total, score) => total + score, 0) +
        (allKeywordsMatched ? 50 * keywordScores.length : 0),
    });
  }

  return matches
    .sort(
      (left, right) =>
        right.score - left.score || compareText(left.entry.modelName, right.entry.modelName),
    )
    .map(({ entry }) => entry);
}

function exactToolMatches(
  catalog: readonly CatalogToolEntry[],
  names: readonly string[],
): { readonly matches: CatalogToolEntry[]; readonly missing: string[] } {
  const byName = new Map(catalog.map((entry) => [entry.modelName.toLowerCase(), entry]));
  const matches: CatalogToolEntry[] = [];
  const missing: string[] = [];
  for (const name of names) {
    const entry = byName.get(name);
    if (entry) matches.push(entry);
    else missing.push(name);
  }
  return { matches, missing };
}

function portableRequestClient(value: string): AdapterPlatform | null {
  switch (value) {
    case "discord":
    case "github":
    case "slack":
    case "telegram":
    case "unknown":
    case "web":
    case "whatsapp":
      return value;
    default:
      return null;
  }
}

export function createPortableToolSearchResult(params: {
  catalog: readonly CatalogToolEntry[];
  transcriptStore?: Pick<TranscriptStore, "selectSessionToolIds">;
  requestContext?: {
    readonly requestClient: string;
    readonly sessionId: string;
  };
}) {
  const requestClient = params.requestContext
    ? portableRequestClient(params.requestContext.requestClient)
    : null;
  if (params.requestContext && !requestClient) {
    return Result.err(
      new PortableToolSearchInvalid({
        message: "Unsupported portable tool search request client",
      }),
    );
  }
  const requestContext =
    params.requestContext && requestClient
      ? {
          requestClient,
          sessionId: params.requestContext.sessionId,
        }
      : undefined;

  return Result.ok(
    tool({
      description:
        "Search deferred plugin and MCP tools. Use keywords for ranked search, select:name,... for exact model-facing names, or +term to require a term in tool names. Returned tools become available on the next model step.",
      inputSchema: toolSearchInputSchema,
      execute: ({ query, max_results }) => {
        const parsedQuery = parseToolSearchQuery(query);
        const exact =
          parsedQuery.type === "select"
            ? exactToolMatches(params.catalog, parsedQuery.names)
            : undefined;
        const allMatches =
          parsedQuery.type === "select"
            ? (exact?.matches ?? [])
            : rankedToolMatches(params.catalog, parsedQuery);
        const matches = allMatches.slice(0, max_results ?? 5);

        if (requestContext) {
          params.transcriptStore?.selectSessionToolIds?.({
            requestClient: requestContext.requestClient,
            sessionId: requestContext.sessionId,
            catalogIds: matches.map((entry) => entry.stableId),
          });
        }

        return {
          query,
          queryType: parsedQuery.type,
          matches: matches.map((entry) => ({
            name: entry.modelName,
            stableId: entry.stableId,
            source: entry.source,
            sourceId: entry.sourceId,
            rawName: entry.rawName,
            ...(entry.title === undefined ? {} : { title: entry.title }),
          })),
          ...(exact?.missing.length ? { missing: exact.missing } : {}),
        };
      },
    }),
  );
}
