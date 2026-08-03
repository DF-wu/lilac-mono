import type { Result } from "better-result";

export const executableTuiToolNames = [
  "apply_patch",
  "bash",
  "batch",
  "edit_file",
  "fuzzy_search",
  "glob",
  "grep",
  "read_file",
  "skill",
  "subagent_delegate",
  "todowrite",
  "webfetch",
  "websearch",
] as const;

export const transcriptTuiToolNames = ["subagent_result"] as const;

export const canonicalTuiToolNames = [
  ...executableTuiToolNames,
  ...transcriptTuiToolNames,
] as const;

export const duplicateCanonicalTuiToolNames = [
  "apply_patch",
  "bash",
  "bash",
  "batch",
  "edit_file",
  "fuzzy_search",
  "glob",
  "grep",
  "read_file",
  "skill",
  "subagent_delegate",
  "subagent_result",
  "todowrite",
  "webfetch",
  "websearch",
] as const;

export const broadCanonicalTuiToolNames: readonly string[] = [
  "apply_patch",
  "bash",
  "batch",
  "edit_file",
  "fuzzy_search",
  "glob",
  "grep",
  "read_file",
  "skill",
  "subagent_delegate",
  "subagent_result",
  "todowrite",
  "webfetch",
  "websearch",
];

declare const codec: { readonly decode: (value: unknown) => Result<string, DecodeFailure> };

export const completeToolCodecs = {
  apply_patch: codec,
  bash: codec,
  batch: codec,
  edit_file: codec,
  fuzzy_search: codec,
  glob: codec,
  grep: codec,
  read_file: codec,
  skill: codec,
  subagent_delegate: codec,
  subagent_result: codec,
  todowrite: codec,
  webfetch: codec,
  websearch: codec,
} as const;

export const completeToolCodecsAlias = completeToolCodecs;

const partialToolCodecs = { bash: codec, read_file: codec } as const;

export const spreadToolCodecs = {
  ...partialToolCodecs,
  apply_patch: codec,
} as const;

export const incompleteToolCodecs = {
  apply_patch: codec,
  bash: codec,
} as const;

export const invalidToolCodecsAlias = incompleteToolCodecs;

export const extraToolCodecs = {
  apply_patch: codec,
  bash: codec,
  batch: codec,
  edit_file: codec,
  fuzzy_search: codec,
  glob: codec,
  grep: codec,
  read_file: codec,
  skill: codec,
  subagent_delegate: codec,
  subagent_result: codec,
  todowrite: codec,
  webfetch: codec,
  websearch: codec,
  future_tool: codec,
} as const;

declare const broadToolName: string;

export const broadToolCodecs = {
  [broadToolName]: codec,
} as const;

export const broadTypedToolCodecs: Readonly<Record<string, typeof codec>> = {
  apply_patch: codec,
  bash: codec,
  batch: codec,
  edit_file: codec,
  fuzzy_search: codec,
  glob: codec,
  grep: codec,
  read_file: codec,
  skill: codec,
  subagent_delegate: codec,
  subagent_result: codec,
  todowrite: codec,
  webfetch: codec,
  websearch: codec,
};

export interface ToolObservation {
  readonly name: string;
  readonly input: unknown;
  readonly output?: unknown;
}

export interface DecodedToolObservation {
  readonly name: (typeof canonicalTuiToolNames)[number];
  readonly summary: string;
}

export interface DecodeFailure {
  readonly _tag: "DecodeFailure";
  readonly message: string;
}

declare const decodedResult: Result<DecodedToolObservation, DecodeFailure>;
declare const unknownSuccessResult: Result<unknown, DecodeFailure>;
declare const unknownErrorResult: Result<DecodedToolObservation, unknown>;

interface NestedUnknownFailure {
  readonly _tag: "NestedUnknownFailure";
  readonly details: { readonly cause: unknown };
}

interface NestedAnyFailure {
  readonly _tag: "NestedAnyFailure";
  readonly details: { readonly cause: ReturnType<typeof JSON.parse> };
}

interface NestedNeverFailure {
  readonly _tag: "NestedNeverFailure";
  readonly details: { readonly cause: never };
}

declare const nestedUnknownErrorResult: Result<DecodedToolObservation, NestedUnknownFailure>;
declare const nestedAnyErrorResult: Result<DecodedToolObservation, NestedAnyFailure>;
declare const nestedNeverErrorResult: Result<DecodedToolObservation, NestedNeverFailure>;

export function decodeKnownToolObservation(
  raw: ToolObservation,
): Result<DecodedToolObservation, DecodeFailure> {
  void raw;
  return decodedResult;
}

export function genericToolDecoder<T>(raw: ToolObservation): Result<T, DecodeFailure> {
  void raw;
  return decodedResult as Result<T, DecodeFailure>;
}

export function nonResultToolDecoder(raw: ToolObservation): DecodedToolObservation {
  void raw;
  return { name: "bash", summary: "Bash" };
}

export function unknownSuccessToolDecoder(raw: ToolObservation): Result<unknown, DecodeFailure> {
  void raw;
  return unknownSuccessResult;
}

export function unknownErrorToolDecoder(
  raw: ToolObservation,
): Result<DecodedToolObservation, unknown> {
  void raw;
  return unknownErrorResult;
}

export function nestedUnknownErrorToolDecoder(
  raw: ToolObservation,
): Result<DecodedToolObservation, NestedUnknownFailure> {
  void raw;
  return nestedUnknownErrorResult;
}

export function nestedAnyErrorToolDecoder(
  raw: ToolObservation,
): Result<DecodedToolObservation, NestedAnyFailure> {
  void raw;
  return nestedAnyErrorResult;
}

export function nestedNeverErrorToolDecoder(
  raw: ToolObservation,
): Result<DecodedToolObservation, NestedNeverFailure> {
  void raw;
  return nestedNeverErrorResult;
}

export function typedInputToolDecoder(
  raw: DecodedToolObservation,
): Result<DecodedToolObservation, DecodeFailure> {
  void raw;
  return decodedResult;
}

export type ToolProjection =
  | { readonly kind: "bash"; readonly command: string }
  | { readonly kind: "read"; readonly path: string }
  | { readonly kind: "malformed-known-tool"; readonly preview: string }
  | { readonly kind: "unknown-tool"; readonly preview: string };
