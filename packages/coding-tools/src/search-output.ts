const GREP_TRUNCATION_HINT =
  "Search output reached the inline limit. Narrow the query or inspect the source with read_file.";

type GrepOutputEntry = {
  file: string;
  line: number;
  text: string;
  column?: number;
  resolvedPath?: string;
  fileHash?: string;
  submatches?: { match: string; start: number; end: number }[];
};

export type BoundedGrepOutput = {
  mode: "default" | "detailed" | "hashline";
  truncated: boolean;
  results: GrepOutputEntry[];
  warnings?: unknown[];
  degradedFromHashline?: boolean;
  error?: string;
  truncationHint?: string;
};

function serializedBytes(value: BoundedGrepOutput): number {
  return Buffer.byteLength(JSON.stringify(value, null, 2), "utf8");
}

function truncateUnicode(value: string, maxCharacters: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxCharacters) return value;
  const marker = "...[truncated]";
  if (maxCharacters <= marker.length) return characters.slice(0, maxCharacters).join("");
  return `${characters.slice(0, maxCharacters - marker.length).join("")}${marker}`;
}

function truncateText(value: string, maxCharacters: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxCharacters) return value;
  const marker = "...[truncated]...";
  if (maxCharacters <= marker.length) return characters.slice(0, maxCharacters).join("");
  const retained = maxCharacters - marker.length;
  const prefixLength = Math.ceil(retained / 2);
  const suffixLength = Math.floor(retained / 2);
  return `${characters.slice(0, prefixLength).join("")}${marker}${characters.slice(-suffixLength).join("")}`;
}

function truncateEntry(entry: GrepOutputEntry, maxCharacters: number): GrepOutputEntry {
  return {
    ...entry,
    text: truncateText(entry.text, maxCharacters),
    ...(entry.submatches
      ? {
          submatches: entry.submatches.map((match) => ({
            ...match,
            match: truncateUnicode(match.match, maxCharacters),
          })),
        }
      : {}),
  };
}

export function boundGrepOutput<T extends BoundedGrepOutput>(output: T, maxBytes: number): T {
  const configuredMaxBytes = Math.max(1, Math.floor(maxBytes));
  if (serializedBytes(output) <= configuredMaxBytes) return output;

  const next = structuredClone(output);
  next.truncated = true;
  next.truncationHint = GREP_TRUNCATION_HINT;
  delete next.warnings;
  delete next.degradedFromHashline;

  const minimum: BoundedGrepOutput = {
    mode: next.mode,
    truncated: true,
    results: [],
    truncationHint: GREP_TRUNCATION_HINT,
    ...(typeof next.error === "string" ? { error: truncateUnicode(next.error, 160) } : {}),
  };
  const effectiveMaxBytes = Math.max(configuredMaxBytes, serializedBytes(minimum));

  while (next.results.length > 1 && serializedBytes(next) > effectiveMaxBytes) {
    next.results.pop();
  }

  if (next.results.length === 1 && serializedBytes(next) > effectiveMaxBytes) {
    delete next.results[0]!.submatches;
    let maxCharacters = Math.max(1, Math.floor(effectiveMaxBytes / 4));
    while (serializedBytes(next) > effectiveMaxBytes && maxCharacters > 1) {
      next.results[0] = truncateEntry(next.results[0]!, maxCharacters);
      maxCharacters = Math.max(1, Math.floor(maxCharacters / 2));
    }
    maxCharacters = Array.from(next.results[0]!.file).length;
    while (serializedBytes(next) > effectiveMaxBytes && maxCharacters > 1) {
      maxCharacters = Math.max(1, Math.floor(maxCharacters / 2));
      next.results[0]!.file = truncateUnicode(next.results[0]!.file, maxCharacters);
    }
    if (serializedBytes(next) > effectiveMaxBytes) next.results.pop();
  }

  if (typeof next.error === "string" && serializedBytes(next) > effectiveMaxBytes) {
    let maxCharacters = Array.from(next.error).length;
    while (serializedBytes(next) > effectiveMaxBytes && maxCharacters > 1) {
      maxCharacters = Math.max(1, Math.floor(maxCharacters / 2));
      next.error = truncateUnicode(next.error, maxCharacters);
    }
  }

  if (serializedBytes(next) > effectiveMaxBytes) return minimum as T;
  return next;
}
