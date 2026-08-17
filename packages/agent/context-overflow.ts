const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /request_too_large/i,
  /context\s*(length|window).*(exceed|exceeded|overflow|too\s*long)/i,
  /maximum\s+context\s+length/i,
  /prompt\s+is\s+too\s+long/i,
  /input\s+is\s+too\s+long(?:\s+for\s+(?:the\s+)?requested\s+model)?/i,
  /exceeds\s+(?:the\s+)?(?:model'?s\s+)?maximum\s+context\s+length/i,
  /input\s+token\s+count.*exceeds\s+the\s+maximum/i,
  /tokens\s+in\s+request\s+more\s+than\s+max\s+tokens\s+allowed/i,
  /maximum\s+prompt\s+length\s+is\s+[\d,]+/i,
  /reduce\s+the\s+length\s+of\s+the\s+messages/i,
  /exceeds\s+(?:the\s+)?maximum\s+allowed\s+input\s+length/i,
  /input\s*\([\d,]+\s+tokens?\)\s+is\s+longer\s+than\s+the\s+model'?s\s+context\s+length/i,
  /exceeds\s+the\s+available\s+context\s+size/i,
  /greater\s+than\s+the\s+context\s+length/i,
  /context\s+window\s+exceeds\s+limit/i,
  /exceeded\s+model\s+token\s+limit/i,
  /request\s+entity\s+too\s+large/i,
  /input\s+length.*exceeds.*context\s+length/i,
  /prompt\s+too\s+long;\s+exceeded\s+(?:max\s+)?context\s+length/i,
  /too\s+large\s+for\s+model\s+with\s+[\d,]+\s+maximum\s+context\s+length/i,
  /prompt\s+has\s+[\d,]+\s+tokens?,\s+but\s+the\s+configured\s+context\s+size\s+is\s+[\d,]+\s+tokens?/i,
  /model_context_window_exceeded/i,
  /too\s+many\s+tokens/i,
  /token\s+limit\s+(exceed|exceeded|reached)/i,
  /prompt\s+token.*(exceed|exceeded)/i,
  /context[_\s-]*length[_\s-]*exceeded/i,
  /context[_\s-]*overflow/i,
];

const CONTEXT_OVERFLOW_EXCLUSION_PATTERNS: readonly RegExp[] = [
  /^(?:throttling\s+error|service\s+unavailable):/i,
  /throttling[_\s-]*error/i,
  /rate[_\s-]*limit/i,
  /too[_\s-]*many[_\s-]*requests/i,
];

function hasOverflowHint(text: string): boolean {
  const s = text.trim();
  if (!s) return false;
  return CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(s));
}

function hasOverflowExclusion(text: string): boolean {
  const s = text.trim();
  if (!s) return false;
  return CONTEXT_OVERFLOW_EXCLUSION_PATTERNS.some((p) => p.test(s));
}

function visit(
  value: unknown,
  seen: Set<unknown>,
  depth: number,
  matches: (text: string) => boolean,
): boolean {
  if (depth > 8) return false;
  if (value === null || value === undefined) return false;

  if (typeof value === "string") {
    return matches(value);
  }

  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return false;
  }

  if (value instanceof Error) {
    if (matches(value.message)) return true;
    const withCause = value as Error & { cause?: unknown };
    if (withCause.cause !== undefined && visit(withCause.cause, seen, depth + 1, matches)) {
      return true;
    }
  }

  if (seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      if (visit(item, seen, depth + 1, matches)) return true;
    }
    return false;
  }

  if (typeof value !== "object" || value === null) return false;

  const objectValue = value as Record<string, unknown>;

  const keysToInspect = [
    "message",
    "error",
    "errorMessage",
    "details",
    "detail",
    "responseBody",
    "body",
    "statusText",
    "name",
    "code",
    "type",
    "cause",
  ] as const;

  for (const key of keysToInspect) {
    if (!(key in objectValue)) continue;
    if (visit(objectValue[key], seen, depth + 1, matches)) return true;
  }

  for (const [k, v] of Object.entries(objectValue)) {
    if (keysToInspect.includes(k as (typeof keysToInspect)[number])) continue;
    if (
      typeof v === "string" &&
      (k.toLowerCase().includes("context") || k.toLowerCase().includes("token"))
    ) {
      if (matches(v)) return true;
    }
  }

  return false;
}

export function isLikelyContextOverflowError(error: unknown): boolean {
  if (visit(error, new Set<unknown>(), 0, hasOverflowExclusion)) return false;
  return visit(error, new Set<unknown>(), 0, hasOverflowHint);
}
