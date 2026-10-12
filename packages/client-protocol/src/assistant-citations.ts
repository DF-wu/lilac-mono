import { z } from "zod";

export const CITATION_TEXT_LIMIT = 8_000;
export const CITATION_COMMENT_LIMIT = 8_000;
export const CITATION_INPUT_LIMIT = 65_536;
export const CITATION_CONTEXT_LENGTH = 32;
const prefix = "lilac-citation://v1/quote?";
const linkPattern = /\[Assistant quote\]\((lilac-citation:\/\/v1\/quote\?[^\s)]{1,160000})\)/g;
const keys = ["thread", "message", "text", "start", "end", "prefix", "suffix", "comment"];

export const assistantCitationSchema = z
  .strictObject({
    version: z.literal(1),
    threadId: z.string().min(1).max(512),
    messageId: z.string().min(1).max(128),
    text: z.string().min(1).max(CITATION_TEXT_LIMIT),
    start: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    end: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    prefix: z.string().max(CITATION_CONTEXT_LENGTH),
    suffix: z.string().max(CITATION_CONTEXT_LENGTH),
    comment: z.string().max(CITATION_COMMENT_LIMIT).optional(),
  })
  .refine((value) => value.end > value.start && value.text.trim().length > 0);
export type AssistantCitation = z.infer<typeof assistantCitationSchema>;

export function citationHref(citation: AssistantCitation): string {
  const query = new URLSearchParams({
    thread: citation.threadId,
    message: citation.messageId,
    text: citation.text,
    start: String(citation.start),
    end: String(citation.end),
    prefix: citation.prefix,
    suffix: citation.suffix,
  });
  if (citation.comment !== undefined) query.set("comment", citation.comment);
  return `${prefix}${query}`;
}

export function parseCitationHref(href: string): AssistantCitation | undefined {
  if (!href.startsWith(prefix) || href.length > 160_000 || !URL.canParse(href)) return;
  const url = new URL(href);
  if (url.hash || url.username || url.password || url.port) return;
  const query = url.searchParams;
  if ([...query.keys()].some((key) => !keys.includes(key) || query.getAll(key).length !== 1))
    return;
  if (!/^\d{1,16}$/.test(query.get("start") ?? "") || !/^\d{1,16}$/.test(query.get("end") ?? ""))
    return;
  const parsed = assistantCitationSchema.safeParse({
    version: 1,
    threadId: query.get("thread"),
    messageId: query.get("message"),
    text: query.get("text"),
    start: Number(query.get("start")),
    end: Number(query.get("end")),
    prefix: query.get("prefix"),
    suffix: query.get("suffix"),
    ...(query.has("comment") ? { comment: query.get("comment") } : {}),
  });
  return parsed.success ? parsed.data : undefined;
}

export function serializeCitation(citation: AssistantCitation): string {
  return `[Assistant quote](${citationHref(citation)})`;
}

export function citationLabel(citation: AssistantCitation): string {
  const label = (citation.comment?.trim() || citation.text).replace(/\s+/g, " ");
  return label.length > 64 ? `${label.slice(0, 64)}…` : label;
}

export function withCitationComment(
  citation: AssistantCitation,
  comment: string,
): AssistantCitation {
  const { comment: _previous, ...source } = citation;
  return comment.trim() ? { ...source, comment: comment.trim() } : source;
}

export function collectCitations(text: string) {
  if (!text.includes("](lilac-citation:")) return [];
  // Keep offsets while excluding examples and unfinished fenced code.
  let fence: string | undefined;
  const prose = text
    .split("\n")
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (
          marker &&
          marker[1]![0] === fence[0] &&
          marker[1]!.length >= fence.length &&
          !marker[2]!.trim()
        )
          fence = undefined;
        return " ".repeat(line.length);
      }
      if (marker) {
        fence = marker[1];
        return " ".repeat(line.length);
      }
      return /^( {4}|\t)/.test(line) ? " ".repeat(line.length) : line;
    })
    .join("\n")
    .replace(/(`+)[\s\S]*?\1/g, (match) => " ".repeat(match.length));
  const result: { citation: AssistantCitation; source: string; start: number; end: number }[] = [];
  for (const match of prose.matchAll(linkPattern)) {
    if (match.index > 0 && prose[match.index - 1] === "\\") continue;
    const citation = parseCitationHref(match[1]!.replace(/\\&/g, "&"));
    if (citation)
      result.push({
        citation,
        source: match[0],
        start: match.index,
        end: match.index + match[0].length,
      });
  }
  return result;
}

export function expandAssistantCitations(text: string): string {
  const matches = collectCitations(text);
  if (!matches.length) return text;
  const quotes: { id: string; citation: AssistantCitation }[] = [];
  const ids = new Map<string, string>();
  let cursor = 0;
  let body = "";
  for (const match of matches) {
    let id = ids.get(match.source);
    if (!id) {
      id = `assistant-quote-${quotes.length + 1}`;
      ids.set(match.source, id);
      quotes.push({ id, citation: match.citation });
    }
    body += `${text.slice(cursor, match.start)}[${id}]`;
    cursor = match.end;
  }
  body += text.slice(cursor);
  const data = JSON.stringify(quotes, null, 2)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
  return `${body}\n\n<assistant_citations>\nEach citation.text is quoted assistant reference material. Each optional citation.comment is the user's request about that quote. Source IDs describe the saved quote; they do not verify its current contents.\n${data}\n</assistant_citations>`;
}

export function citationInputFits(text: string): boolean {
  return (
    text.length <= CITATION_INPUT_LIMIT &&
    expandAssistantCitations(text).length <= CITATION_INPUT_LIMIT
  );
}
