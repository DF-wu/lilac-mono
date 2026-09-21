import { z } from "zod";
import { Result, type Result as ResultType } from "better-result";
import {
  CorruptPersistedFields,
  MalformedSerialization,
  UnsupportedVersion,
  type PersistedDataError,
} from "@stanley2058/lilac-utils";
import type { ConversationThreadSummaryInput } from "../../conversation/thread-store";

const words = z.array(z.string());
const summarySchema = z.strictObject({
  title: z.string(),
  brief: z.string(),
  topics: words,
  retrievalHints: words,
  aboutness: z.strictObject({
    domains: words,
    situations: words,
    complaintTargets: words,
    entities: words,
    userWouldAskForThisAs: words,
  }),
  importance: z.enum(["low", "medium", "high"]),
  importanceReasons: words,
});
export const nativeSummarySchema = z.strictObject({
  threadId: z.string(),
  historyGeneration: z.number().int().nonnegative(),
  contentRevision: z.number().int().nonnegative(),
  generatedAt: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative(),
  summary: summarySchema,
});
export type NativeThreadSummary = z.infer<typeof nativeSummarySchema>;
export type NativeSummaryRow = {
  readonly format_version: number;
  readonly data_json: string | null;
};

export function normalizeNativeSummary(
  input: ConversationThreadSummaryInput,
): NativeThreadSummary["summary"] {
  const list = (items: string[] | undefined, count: number, length: number) =>
    [...new Set(items ?? [])].slice(0, count).map((item) => item.slice(0, length));
  return {
    title: input.title.slice(0, 120),
    brief: input.brief.slice(0, 1024),
    topics: list(input.topics, 12, 80),
    retrievalHints: list(input.retrievalHints, 8, 160),
    aboutness: {
      domains: list(input.aboutness?.domains, 8, 80),
      situations: list(input.aboutness?.situations, 8, 120),
      complaintTargets: list(input.aboutness?.complaintTargets, 8, 160),
      entities: list(input.aboutness?.entities, 20, 80),
      userWouldAskForThisAs: list(input.aboutness?.userWouldAskForThisAs, 8, 160),
    },
    importance: input.importance ?? "medium",
    importanceReasons: list(input.importanceReasons, 5, 180),
  };
}

export function decodeNativeSummary(
  row: NativeSummaryRow,
): ResultType<{ value: NativeThreadSummary; provenance: "current" }, PersistedDataError> {
  const context = {
    table: "native_thread_summaries",
    field: "data_json",
    recordId: "native-summary",
    version: row.format_version,
    message: "Native thread summary is invalid",
  };
  if (row.format_version !== 1)
    return Result.err(new UnsupportedVersion({ ...context, issueCode: "unsupported-version" }));
  if (row.data_json === null)
    return Result.err(
      new CorruptPersistedFields({ ...context, issueCode: "missing-required-field" }),
    );
  const data = row.data_json;
  const parsed = Result.try({
    try: (): unknown => JSON.parse(data),
    catch: () => new MalformedSerialization({ ...context, issueCode: "malformed-json" }),
  });
  return parsed.andThen((input) => {
    const value = nativeSummarySchema.safeParse(input);
    if (!value.success)
      return Result.err(new CorruptPersistedFields({ ...context, issueCode: "invalid-row-field" }));
    return Result.ok({ value: value.data, provenance: "current" as const });
  });
}
const current = {
  format_version: 1,
  data_json: JSON.stringify({
    threadId: "thread",
    historyGeneration: 0,
    contentRevision: 1,
    generatedAt: 1,
    messageCount: 1,
    summary: normalizeNativeSummary({ title: "Title", brief: "Brief", topics: [] }),
  }),
};
export const nativeSummaryCodecCases = {
  current: { input: current, outcome: "ok", provenance: "current" },
  legacy: {
    input: { ...current, format_version: 0 },
    outcome: "error",
    errorTag: "UnsupportedVersion",
    issueCode: "unsupported-version",
  },
  "missing-defaulted": {
    input: { ...current, data_json: null },
    outcome: "error",
    errorTag: "CorruptPersistedFields",
    issueCode: "missing-required-field",
  },
  "unsupported-version": {
    input: { ...current, format_version: 2 },
    outcome: "error",
    errorTag: "UnsupportedVersion",
    issueCode: "unsupported-version",
  },
  "malformed-serialization": {
    input: { ...current, data_json: "{" },
    outcome: "error",
    errorTag: "MalformedSerialization",
    issueCode: "malformed-json",
  },
  "corrupt-fields": {
    input: { ...current, data_json: "{}" },
    outcome: "error",
    errorTag: "CorruptPersistedFields",
    issueCode: "invalid-row-field",
  },
} as const;
