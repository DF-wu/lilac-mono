/**
 * Splitting for Telegram's per-message character limit.
 *
 * Telegram rejects any message longer than 4096 characters and rejects
 * malformed entities, so a naive `slice()` can produce a chunk with a dangling
 * `<pre>` or a tag cut in half. The chunker is therefore tag-aware: it
 * tokenizes the HTML, tracks the open-tag stack, closes it at every break and
 * reopens it at the start of the next chunk. Every emitted chunk is
 * independently valid Telegram HTML and within the limit.
 */

export const TELEGRAM_MAX_MESSAGE_CHARS = 4096;

export type ChunkTelegramHtmlOptions = {
  maxChars?: number;
};

type TagToken = {
  readonly kind: "tag";
  readonly raw: string;
  readonly name: string;
  readonly closing: boolean;
};

type TextToken = {
  readonly kind: "text";
  readonly raw: string;
};

type Token = TagToken | TextToken;

const TAG_RE = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:\s[^>]*)?)>/u;

function tokenizeTelegramHtml(html: string): Token[] {
  const tokens: Token[] = [];
  let text = "";
  let index = 0;

  const pushText = () => {
    if (text.length > 0) {
      tokens.push({ kind: "text", raw: text });
      text = "";
    }
  };

  while (index < html.length) {
    if (html[index] !== "<") {
      text += html[index] ?? "";
      index += 1;
      continue;
    }

    const match = TAG_RE.exec(html.slice(index));
    if (!match) {
      // A bare "<" is not a tag; keep it in the text lane so it is never split.
      text += "<";
      index += 1;
      continue;
    }

    pushText();
    const raw = match[0];
    tokens.push({
      kind: "tag",
      raw,
      name: (match[2] ?? "").toLowerCase(),
      closing: match[1] === "/",
    });
    index += raw.length;
  }

  pushText();
  return tokens;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Never cut between a surrogate pair or in the middle of an HTML entity. */
function safeHardCut(text: string, limit: number): number {
  let cut = Math.min(limit, text.length);
  if (cut <= 0) return 0;

  if (isLowSurrogate(text.charCodeAt(cut))) cut -= 1;

  const MAX_ENTITY_CHARS = 12;
  const from = Math.max(0, cut - MAX_ENTITY_CHARS);
  const tail = text.slice(from, cut);
  const ampersand = tail.lastIndexOf("&");
  if (ampersand !== -1) {
    const candidate = tail.slice(ampersand);
    if (!candidate.includes(";") && !/\s/u.test(candidate)) {
      cut = from + ampersand;
    }
  }

  return Math.max(0, cut);
}

type SplitPoint = {
  /** Characters kept in the current chunk. */
  readonly end: number;
  /** Offset the next chunk resumes from (separator characters are dropped). */
  readonly next: number;
};

/**
 * Best boundary at or before `budget`, or `null` when the run has none.
 *
 * `preserveSeparator` keeps the separator characters instead of dropping them.
 * Between prose messages a dangling space or newline is noise, but inside a
 * `<pre>`/`<code>` block the text is literal content: dropping a separator
 * there silently corrupts the code, joining `alpha beta` into `alphabeta`
 * across the split.
 */
function findSoftSplitPoint(
  text: string,
  budget: number,
  preserveSeparator = false,
): SplitPoint | null {
  if (preserveSeparator) {
    // Search one character earlier so the retained separator still fits.
    const limit = budget - 1;
    if (limit < 1) return null;

    const paragraph = text.lastIndexOf("\n\n", limit - 1);
    if (paragraph > 0) {
      const end = paragraph + 2;
      return { end, next: end };
    }

    const line = text.lastIndexOf("\n", limit);
    if (line > 0) {
      const end = line + 1;
      return { end, next: end };
    }

    const word = text.lastIndexOf(" ", limit);
    if (word > 0) {
      const end = word + 1;
      return { end, next: end };
    }

    return null;
  }

  const paragraph = text.lastIndexOf("\n\n", budget);
  if (paragraph > 0) {
    let next = paragraph + 2;
    while (text[next] === "\n") next += 1;
    return { end: paragraph, next };
  }

  const line = text.lastIndexOf("\n", budget);
  if (line > 0) return { end: line, next: line + 1 };

  const word = text.lastIndexOf(" ", budget);
  if (word > 0) return { end: word, next: word + 1 };

  return null;
}

/** Inside these tags the text is literal content, not prose. */
function isLiteralContext(open: readonly { readonly name: string }[]): boolean {
  return open.some((tag) => tag.name === "pre" || tag.name === "code");
}

function hardSplitPoint(text: string, budget: number): SplitPoint {
  const hard = safeHardCut(text, budget);
  // Always make progress, even for pathological inputs (one long entity-like
  // run with no boundary at all).
  const end = hard > 0 ? hard : Math.min(budget, text.length);
  return { end, next: end };
}

function hasVisibleContent(chunk: string): boolean {
  return chunk.replace(/<[^>]*>/gu, "").trim().length > 0;
}

/**
 * Split Telegram HTML into chunks that each fit `maxChars` and parse on their
 * own. Returns `[]` for empty input.
 */
export function chunkTelegramHtml(html: string, opts?: ChunkTelegramHtmlOptions): string[] {
  if (html.length === 0) return [];

  const maxChars = Math.max(1, opts?.maxChars ?? TELEGRAM_MAX_MESSAGE_CHARS);
  const tokens = tokenizeTelegramHtml(html);
  const chunks: string[] = [];
  const open: TagToken[] = [];
  let current = "";

  const closeSuffix = (): string => {
    let suffix = "";
    for (let i = open.length - 1; i >= 0; i -= 1) {
      const tag = open[i];
      if (tag) suffix += `</${tag.name}>`;
    }
    return suffix;
  };

  const reopenPrefix = (): string => open.map((tag) => tag.raw).join("");

  const flush = (): void => {
    const candidate = current + closeSuffix();
    if (hasVisibleContent(candidate)) chunks.push(candidate);
    current = reopenPrefix();
  };

  for (const token of tokens) {
    if (token.kind === "tag") {
      if (!token.closing) {
        const projected =
          current.length + token.raw.length + closeSuffix().length + token.name.length + 3;
        if (projected > maxChars && hasVisibleContent(current)) flush();
        current += token.raw;
        open.push(token);
        continue;
      }

      const openIndex = open.findLastIndex((tag) => tag.name === token.name);
      // An unmatched closer would unbalance the chunk, so it is dropped.
      if (openIndex === -1) continue;

      while (open.length > openIndex + 1) {
        const stray = open.pop();
        if (stray) current += `</${stray.name}>`;
      }
      open.pop();
      current += token.raw;
      continue;
    }

    let rest = token.raw;
    while (rest.length > 0) {
      const budget = maxChars - current.length - closeSuffix().length;
      if (budget <= 0) {
        const before = current;
        flush();
        // No headroom even on a fresh chunk: emitting more would break the
        // limit, so stop rather than loop forever.
        if (current === before) return chunks;
        continue;
      }

      if (rest.length <= budget) {
        current += rest;
        break;
      }

      const literal = isLiteralContext(open);
      let split = findSoftSplitPoint(rest, budget, literal);
      if (!split && hasVisibleContent(current)) {
        // No boundary fits in what is left of this chunk, but a fresh chunk has
        // the full budget and may well contain one. Flushing first keeps words
        // intact instead of hard-cutting prematurely.
        const before = current;
        flush();
        if (current !== before) continue;
      }
      split ??= hardSplitPoint(rest, budget);

      current += rest.slice(0, split.end);
      rest = rest.slice(Math.max(split.next, split.end, 1));
      flush();
    }
  }

  const tail = current + closeSuffix();
  if (hasVisibleContent(tail)) chunks.push(tail);

  return chunks;
}
