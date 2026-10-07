/**
 * Markdown -> Telegram HTML.
 *
 * Telegram's `parse_mode: "HTML"` is not real HTML: it accepts a fixed, small
 * tag set and rejects the whole message (400 "can't parse entities") when it
 * sees anything else. The renderer therefore never passes source markup
 * through - it emits only tags it generates itself, always in balanced pairs,
 * and escapes every character that comes from user/model text.
 *
 * Supported tags: `b`, `i`, `u`, `s`, `tg-spoiler`, `a href`, `code`, `pre`,
 * `pre > code[class=language-*]`, `blockquote`.
 */

/** Tags this module is allowed to emit. */
export const TELEGRAM_SUPPORTED_TAGS = [
  "b",
  "i",
  "u",
  "s",
  "tg-spoiler",
  "a",
  "code",
  "pre",
  "blockquote",
] as const;

export type TelegramSupportedTag = (typeof TELEGRAM_SUPPORTED_TAGS)[number];

const TELEGRAM_SUPPORTED_TAG_SET: ReadonlySet<string> = new Set(TELEGRAM_SUPPORTED_TAGS);

export function isTelegramSupportedTag(name: string): name is TelegramSupportedTag {
  return TELEGRAM_SUPPORTED_TAG_SET.has(name.toLowerCase());
}

/**
 * Escape text for a Telegram HTML text node.
 *
 * Telegram only requires `&`, `<` and `>` to be escaped; leaving quotes alone
 * keeps prose readable. Attribute values use {@link escapeTelegramHtmlAttribute}.
 */
export function escapeTelegramHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Escape a value that will be placed inside a double-quoted attribute. */
export function escapeTelegramHtmlAttribute(value: string): string {
  return escapeTelegramHtml(value).replaceAll('"', "&quot;");
}

const MAX_INLINE_DEPTH = 8;
const MAX_LANGUAGE_CHARS = 24;
const SAFE_URL_RE = /^(?:https?:\/\/|tg:\/\/|mailto:)/iu;
const LANGUAGE_RE = /^[A-Za-z0-9_+#.-]+$/u;
const ALPHANUMERIC_RE = /[\p{L}\p{N}]/u;

type EmphasisRule = {
  readonly marker: string;
  readonly tag: TelegramSupportedTag;
};

// Order matters: longer markers must be attempted before their single-character
// prefixes so `**bold**` never degrades into two nested italics.
const EMPHASIS_RULES: readonly EmphasisRule[] = [
  { marker: "~~", tag: "s" },
  { marker: "||", tag: "tg-spoiler" },
  { marker: "**", tag: "b" },
  { marker: "__", tag: "b" },
  { marker: "*", tag: "i" },
  { marker: "_", tag: "i" },
];

function sanitizeLanguage(raw: string): string | undefined {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > MAX_LANGUAGE_CHARS) return undefined;
  return LANGUAGE_RE.test(trimmed) ? trimmed : undefined;
}

export function renderTelegramCodeBlock(input: {
  code: string;
  language?: string | undefined;
}): string {
  // The body is escaped wholesale, so no input can terminate the block early.
  const body = escapeTelegramHtml(input.code);
  const language = input.language ? sanitizeLanguage(input.language) : undefined;
  if (!language) return `<pre>${body}</pre>`;
  return `<pre><code class="language-${language}">${body}</code></pre>`;
}

function isSafeUrl(url: string): boolean {
  return SAFE_URL_RE.test(url.trim());
}

function countRun(text: string, start: number, char: string): number {
  let end = start;
  while (end < text.length && text[end] === char) end += 1;
  return end - start;
}

function findBacktickRun(text: string, from: number, length: number): number {
  let index = from;
  while (index < text.length) {
    const next = text.indexOf("`", index);
    if (next === -1) return -1;
    const run = countRun(text, next, "`");
    if (run === length) return next;
    index = next + run;
  }
  return -1;
}

/** CommonMark strips one leading/trailing space from a code span. */
function normalizeCodeSpan(inner: string): string {
  if (
    inner.length >= 2 &&
    inner.startsWith(" ") &&
    inner.endsWith(" ") &&
    inner.trim().length > 0
  ) {
    return inner.slice(1, -1);
  }
  return inner;
}

type LinkMatch = {
  readonly label: string;
  readonly url: string;
  readonly consumed: number;
};

function matchLink(text: string, start: number): LinkMatch | null {
  if (text[start] !== "[") return null;

  let depth = 0;
  let labelEnd = -1;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        labelEnd = index;
        break;
      }
    }
  }
  if (labelEnd === -1 || text[labelEnd + 1] !== "(") return null;

  let parenDepth = 0;
  let destEnd = -1;
  for (let index = labelEnd + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "(") parenDepth += 1;
    else if (char === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) {
        destEnd = index;
        break;
      }
    }
  }
  if (destEnd === -1) return null;

  const destination = text.slice(labelEnd + 2, destEnd).trim();
  // `(url "title")` - the title is dropped; Telegram links carry no title.
  const titleIndex = destination.search(/\s+["'(]/u);
  const url = titleIndex === -1 ? destination : destination.slice(0, titleIndex);

  return {
    label: text.slice(start + 1, labelEnd),
    url,
    consumed: destEnd - start + 1,
  };
}

function findEmphasisCloser(text: string, from: number, marker: string): number {
  let index = from;
  while (index < text.length) {
    const next = text.indexOf(marker, index);
    if (next === -1) return -1;
    // A single-character marker must not match one half of a doubled marker.
    if (marker.length === 1 && text[next + 1] === marker) {
      index = next + 2;
      continue;
    }
    return next;
  }
  return -1;
}

type EmphasisMatch = {
  readonly tag: TelegramSupportedTag;
  readonly inner: string;
  readonly consumed: number;
};

function matchEmphasis(text: string, start: number): EmphasisMatch | null {
  for (const rule of EMPHASIS_RULES) {
    const { marker, tag } = rule;
    if (!text.startsWith(marker, start)) continue;

    // Underscores never open emphasis inside a word, so `snake_case_name`
    // survives verbatim.
    const isUnderscore = marker.startsWith("_");
    const before = start > 0 ? (text[start - 1] ?? "") : "";
    if (isUnderscore && before.length > 0 && ALPHANUMERIC_RE.test(before)) continue;

    const closer = findEmphasisCloser(text, start + marker.length, marker);
    if (closer === -1) continue;

    const inner = text.slice(start + marker.length, closer);
    if (inner.length === 0) continue;
    if (marker.length === 1 && (/^\s/u.test(inner) || /\s$/u.test(inner))) continue;

    const after = text[closer + marker.length] ?? "";
    if (isUnderscore && after.length > 0 && ALPHANUMERIC_RE.test(after)) continue;

    return { tag, inner, consumed: closer + marker.length - start };
  }
  return null;
}

function renderInline(text: string, depth = 0): string {
  let out = "";
  let index = 0;

  while (index < text.length) {
    const char = text[index] ?? "";

    if (char === "\\") {
      const next = text[index + 1];
      if (next !== undefined && /[\\`*_~|[\]()#>!-]/u.test(next)) {
        out += escapeTelegramHtml(next);
        index += 2;
        continue;
      }
    }

    if (char === "`") {
      const run = countRun(text, index, "`");
      const closer = findBacktickRun(text, index + run, run);
      if (closer !== -1) {
        const inner = normalizeCodeSpan(text.slice(index + run, closer));
        out += `<code>${escapeTelegramHtml(inner)}</code>`;
        index = closer + run;
        continue;
      }
      out += escapeTelegramHtml("`".repeat(run));
      index += run;
      continue;
    }

    // Images have no Telegram inline equivalent: degrade to the alt text.
    if (char === "!" && text[index + 1] === "[") {
      const link = matchLink(text, index + 1);
      if (link) {
        const alt = link.label.trim();
        out += escapeTelegramHtml(alt.length > 0 ? alt : link.url);
        index += link.consumed + 1;
        continue;
      }
    }

    if (char === "[") {
      const link = matchLink(text, index);
      if (link) {
        const label = depth < MAX_INLINE_DEPTH ? renderInline(link.label, depth + 1) : "";
        if (isSafeUrl(link.url)) {
          const href = escapeTelegramHtmlAttribute(link.url.trim());
          out += `<a href="${href}">${label || escapeTelegramHtml(link.url.trim())}</a>`;
        } else {
          out += label;
        }
        index += link.consumed;
        continue;
      }
    }

    if (depth < MAX_INLINE_DEPTH) {
      const emphasis = matchEmphasis(text, index);
      if (emphasis) {
        out += `<${emphasis.tag}>${renderInline(emphasis.inner, depth + 1)}</${emphasis.tag}>`;
        index += emphasis.consumed;
        continue;
      }
    }

    out += escapeTelegramHtml(char);
    index += 1;
  }

  return out;
}

/** Render a single line of markdown inline syntax as Telegram HTML. */
export function renderTelegramInline(text: string): string {
  return renderInline(text);
}

type FenceOpen = {
  readonly marker: string;
  readonly language: string | undefined;
};

function matchFenceOpen(line: string): FenceOpen | null {
  const match = /^ {0,3}(`{3,}|~{3,})\s*(\S*)\s*$/u.exec(line);
  if (!match) return null;
  const marker = match[1];
  if (!marker) return null;
  // An info string containing a backtick is not a valid fence opener.
  if (marker.startsWith("`") && (match[2] ?? "").includes("`")) return null;
  return { marker, language: match[2] || undefined };
}

function isFenceClose(line: string, marker: string): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})\s*$/u.exec(line);
  const closer = match?.[1];
  if (!closer) return false;
  return closer[0] === marker[0] && closer.length >= marker.length;
}

const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*)$/u;
const HR_RE = /^ {0,3}([-*_])[ \t]*(?:\1[ \t]*){2,}$/u;
const BLOCKQUOTE_RE = /^ {0,3}>[ \t]?(.*)$/u;
const UNORDERED_LIST_RE = /^([ \t]*)([-*+])[ \t]+(.*)$/u;
const ORDERED_LIST_RE = /^([ \t]*)(\d{1,9}[.)])[ \t]+(.*)$/u;

/**
 * Convert markdown to Telegram HTML.
 *
 * Block handling: fenced code, headings (rendered bold - Telegram has no
 * headings), blockquotes, thematic breaks and lists. Anything else - tables
 * included - degrades to escaped plain text with its original characters
 * intact.
 */
export function markdownToTelegramHtml(markdown: string): string {
  if (markdown.length === 0) return "";

  const lines = markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const out: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";

    const fence = matchFenceOpen(line);
    if (fence) {
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !isFenceClose(lines[index] ?? "", fence.marker)) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      // An unterminated fence still closes cleanly; balance is non-negotiable.
      if (index < lines.length) index += 1;
      out.push(renderTelegramCodeBlock({ code: body.join("\n"), language: fence.language }));
      continue;
    }

    const quote = BLOCKQUOTE_RE.exec(line);
    if (quote) {
      const quoted: string[] = [quote[1] ?? ""];
      index += 1;
      while (index < lines.length) {
        const nextQuote = BLOCKQUOTE_RE.exec(lines[index] ?? "");
        if (!nextQuote) break;
        quoted.push(nextQuote[1] ?? "");
        index += 1;
      }
      const inner = quoted.map((entry) => renderInline(entry)).join("\n");
      out.push(`<blockquote>${inner}</blockquote>`);
      continue;
    }

    index += 1;

    if (HR_RE.test(line)) {
      out.push("———");
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      const content = (heading[2] ?? "").replace(/\s+#+\s*$/u, "").trim();
      out.push(content.length > 0 ? `<b>${renderInline(content)}</b>` : "");
      continue;
    }

    const unordered = UNORDERED_LIST_RE.exec(line);
    if (unordered) {
      // Keep the author's indentation and bullet character; only the item body
      // goes through inline rendering so the marker can't be read as emphasis.
      out.push(`${unordered[1] ?? ""}${unordered[2] ?? "-"} ${renderInline(unordered[3] ?? "")}`);
      continue;
    }

    const ordered = ORDERED_LIST_RE.exec(line);
    if (ordered) {
      out.push(`${ordered[1] ?? ""}${ordered[2] ?? "1."} ${renderInline(ordered[3] ?? "")}`);
      continue;
    }

    out.push(renderInline(line));
  }

  return out.join("\n");
}

const HTML_TAG_RE = /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>]*)?>/gu;

const NAMED_ENTITIES: ReadonlyArray<readonly [string, string]> = [
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&#39;", "'"],
  ["&apos;", "'"],
  ["&nbsp;", " "],
  // `&amp;` must be decoded last so `&amp;lt;` round-trips to `&lt;`.
  ["&amp;", "&"],
];

/**
 * Plain-text fallback used when Telegram rejects the entity payload.
 *
 * Drops every tag and decodes the entities this module can produce, so the
 * result is safe to send with no `parse_mode`.
 */
export function stripTelegramHtml(html: string): string {
  let out = html.replace(HTML_TAG_RE, "");
  for (const [entity, replacement] of NAMED_ENTITIES) {
    out = out.replaceAll(entity, replacement);
  }
  return out;
}
