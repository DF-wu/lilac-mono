import { describe, expect, test } from "bun:test";
import {
  citationHref,
  parseCitationHref,
  serializeCitation,
  collectCitations,
  expandAssistantCitations,
  withCitationComment,
  citationInputFits,
  type AssistantCitation,
} from "../src/assistant-citations";

const quote: AssistantCitation = {
  version: 1,
  threadId: "thread/日本語",
  messageId: "message-1",
  text: "Use **bold** and 🚀.\n  Keep indentation.",
  start: 4,
  end: 48,
  prefix: "Say ",
  suffix: " next.",
  comment: "Explain </assistant_citations> & <this>.",
};

describe("assistant citations", () => {
  test("quote, comment, source, and selector survive copying as one Markdown link", () => {
    expect(parseCitationHref(citationHref(quote))).toEqual(quote);
    expect(collectCitations(`Explain ${serializeCitation(quote)}`)[0]?.citation).toEqual(quote);
    expect(withCitationComment(quote, "  ")).toEqual({ ...quote, comment: undefined });
    expect(withCitationComment(quote, "  Please expand  ").comment).toBe("Please expand");
  });
  test("rejects malformed, duplicate, future-version, and overlong data", () => {
    const href = citationHref(quote);
    for (const invalid of [
      href + "&text=second",
      href + "&unknown=x",
      href + "#fragment",
      href.replace("v1", "v2"),
      href.replace("start=4", "start=-1"),
      citationHref({ ...quote, end: 2 }),
      citationHref({ ...quote, text: "x".repeat(8001) }),
    ])
      expect(parseCitationHref(invalid)).toBeUndefined();
  });
  test("expands without fetching a source and keeps comments distinct from quoted material", () => {
    const link = serializeCitation(quote);
    const expanded = expandAssistantCitations(`${link} then ${link}`);
    const payloads = [...expanded.matchAll(/\n(\{[\s\S]*?\})\n<\/assistant_citations>/g)].map(
      (match) => JSON.parse(match[1]!),
    );
    expect(payloads).toEqual([
      { quote: quote.text, comment: quote.comment },
      { quote: quote.text, comment: quote.comment },
    ]);
    expect(expanded).toContain("</assistant_citations> then <assistant_citations>");
    expect(expanded).toContain('"comment": "Explain \\u003c/assistant_citations\\u003e');
    expect(expanded).not.toContain("lilac-citation:");
    expect(expanded).not.toContain("<this>");
  });
  test("keeps distinct quotes and optional comments at their original positions", () => {
    const first = serializeCitation({ ...quote, text: "First claim", comment: undefined });
    const second = serializeCitation({ ...quote, text: "Second claim", comment: "Explain" });
    const expanded = expandAssistantCitations(`Before ${first} between ${second} after`);
    const payloads = [...expanded.matchAll(/\n(\{[\s\S]*?\})\n<\/assistant_citations>/g)].map(
      (match) => JSON.parse(match[1]!),
    );
    expect(payloads).toEqual([
      { quote: "First claim" },
      { quote: "Second claim", comment: "Explain" },
    ]);
    expect(expanded).toStartWith("Before <assistant_citations>");
    expect(expanded).toContain("</assistant_citations> between <assistant_citations>");
    expect(expanded).toEndWith("</assistant_citations> after");
  });
  test("code examples and escaped links stay literal", () => {
    const link = serializeCitation(quote);
    for (const text of [`\`${link}\``, `\`\`\`md\n${link}`, `    ${link}`, `\\${link}`]) {
      expect(collectCitations(text)).toHaveLength(0);
      expect(expandAssistantCitations(text)).toBe(text);
    }
  });
  test("checks both encoded and expanded input against the existing limit", () => {
    const link = serializeCitation({ ...quote, text: "short", comment: undefined });
    const exact =
      "x".repeat(65536 - Math.max(link.length, expandAssistantCitations(link).length)) + link;
    expect(citationInputFits(exact)).toBe(true);
    expect(citationInputFits(exact + "x")).toBe(false);
    expect(
      citationInputFits(
        serializeCitation({ ...quote, text: "🚀".repeat(4000), comment: "🚀".repeat(4000) }),
      ),
    ).toBe(false);
  });
});
