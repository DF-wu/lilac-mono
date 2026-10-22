import { describe, expect, it } from "bun:test";

import {
  TELEGRAM_MAX_MESSAGE_CHARS,
  chunkTelegramHtml,
} from "../../../src/surface/telegram/output/telegram-chunker";
import { markdownToTelegramHtml } from "../../../src/surface/telegram/output/telegram-html";

const ALLOWED_TAGS = new Set(["b", "i", "u", "s", "tg-spoiler", "a", "code", "pre", "blockquote"]);

function expectValidChunk(chunk: string, maxChars: number): void {
  expect(chunk.length).toBeLessThanOrEqual(maxChars);

  const stack: string[] = [];
  const re = /<(\/?)([A-Za-z][A-Za-z0-9-]*)(?:\s[^>]*)?>/gu;
  for (const match of chunk.matchAll(re)) {
    const name = (match[2] ?? "").toLowerCase();
    expect(ALLOWED_TAGS.has(name)).toBe(true);
    if (match[1] === "/") expect(stack.pop()).toBe(name);
    else stack.push(name);
  }
  expect(stack).toEqual([]);

  // A chunk must never end mid-tag.
  expect(chunk.lastIndexOf("<")).toBeLessThanOrEqual(chunk.lastIndexOf(">"));
}

function expectAllValid(chunks: readonly string[], maxChars: number): void {
  for (const chunk of chunks) expectValidChunk(chunk, maxChars);
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/gu, "");
}

describe("chunkTelegramHtml basics", () => {
  it("exposes Telegram's documented message limit", () => {
    expect(TELEGRAM_MAX_MESSAGE_CHARS).toBe(4096);
  });

  it("returns an empty array for empty input", () => {
    expect(chunkTelegramHtml("")).toEqual([]);
  });

  it("returns a single chunk when the input already fits", () => {
    expect(chunkTelegramHtml("<b>short</b>")).toEqual(["<b>short</b>"]);
  });

  it("drops whitespace-only input rather than sending a blank message", () => {
    expect(chunkTelegramHtml("   \n  ")).toEqual([]);
  });

  it("defaults to the 4096-character budget", () => {
    const chunks = chunkTelegramHtml("x".repeat(5000));
    expect(chunks.length).toBe(2);
    expectAllValid(chunks, TELEGRAM_MAX_MESSAGE_CHARS);
  });
});

describe("chunkTelegramHtml boundary preference", () => {
  it("prefers a paragraph boundary and drops the blank line", () => {
    const html = `${"a".repeat(30)}\n\n${"b".repeat(30)}`;
    const chunks = chunkTelegramHtml(html, { maxChars: 40 });
    expect(chunks).toEqual(["a".repeat(30), "b".repeat(30)]);
  });

  it("falls back to a line boundary when no paragraph break fits", () => {
    const html = `${"a".repeat(30)}\n${"b".repeat(30)}`;
    const chunks = chunkTelegramHtml(html, { maxChars: 40 });
    expect(chunks).toEqual(["a".repeat(30), "b".repeat(30)]);
  });

  it("falls back to a word boundary when no line break fits", () => {
    const html = `${"a".repeat(30)} ${"b".repeat(30)}`;
    const chunks = chunkTelegramHtml(html, { maxChars: 40 });
    expect(chunks).toEqual(["a".repeat(30), "b".repeat(30)]);
  });

  it("hard-cuts a single unbroken run", () => {
    const chunks = chunkTelegramHtml("a".repeat(90), { maxChars: 40 });
    expect(chunks).toEqual(["a".repeat(40), "a".repeat(40), "a".repeat(10)]);
  });

  it("prefers the paragraph break even when a later line break also fits", () => {
    const html = `${"a".repeat(10)}\n\n${"b".repeat(10)}\n${"c".repeat(10)}`;
    const chunks = chunkTelegramHtml(html, { maxChars: 30 });
    expect(chunks[0]).toBe("a".repeat(10));
  });

  it("never splits inside an html tag", () => {
    const html = `${"a".repeat(38)}<b>${"b".repeat(60)}</b>`;
    const chunks = chunkTelegramHtml(html, { maxChars: 40 });
    expectAllValid(chunks, 40);
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/<[a-z-]*$/iu);
      expect(chunk).not.toMatch(/^[a-z-]*>/iu);
    }
  });

  it("never splits a surrogate pair", () => {
    const chunks = chunkTelegramHtml("😀".repeat(40), { maxChars: 21 });
    expectAllValid(chunks, 21);
    for (const chunk of chunks) {
      expect(chunk).toBe([...chunk].join(""));
      expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/u);
    }
  });

  it("never splits an html entity", () => {
    const html = `${"a".repeat(18)}&amp;${"b".repeat(30)}`;
    const chunks = chunkTelegramHtml(html, { maxChars: 20 });
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/&[a-z]*$/u);
    }
    expect(chunks.join("")).toContain("&amp;");
  });
});

describe("chunkTelegramHtml tag continuity", () => {
  it("closes and reopens a pre block across a split", () => {
    const html = `<pre>${"x".repeat(120)}</pre>`;
    const chunks = chunkTelegramHtml(html, { maxChars: 50 });

    expect(chunks.length).toBeGreaterThan(1);
    expectAllValid(chunks, 50);
    for (const chunk of chunks) {
      expect(chunk.startsWith("<pre>")).toBe(true);
      expect(chunk.endsWith("</pre>")).toBe(true);
    }
    expect(chunks.map(stripTags).join("")).toBe("x".repeat(120));
  });

  it("preserves the language attribute when reopening a code block", () => {
    const html = `<pre><code class="language-ts">${"y".repeat(200)}</code></pre>`;
    const chunks = chunkTelegramHtml(html, { maxChars: 80 });

    expect(chunks.length).toBeGreaterThan(1);
    expectAllValid(chunks, 80);
    for (const chunk of chunks) {
      expect(chunk.startsWith('<pre><code class="language-ts">')).toBe(true);
      expect(chunk.endsWith("</code></pre>")).toBe(true);
    }
    expect(chunks.map(stripTags).join("")).toBe("y".repeat(200));
  });

  it("closes and reopens nested inline tags across a split", () => {
    const html = `<b><i>${"z".repeat(120)}</i></b>`;
    const chunks = chunkTelegramHtml(html, { maxChars: 50 });

    expect(chunks.length).toBeGreaterThan(1);
    expectAllValid(chunks, 50);
    for (const chunk of chunks) {
      expect(chunk.startsWith("<b><i>")).toBe(true);
      expect(chunk.endsWith("</i></b>")).toBe(true);
    }
  });

  it("moves an opening tag to the next chunk when its pair would not fit", () => {
    const html = `${"a".repeat(45)}<pre>${"b".repeat(45)}</pre>`;
    const chunks = chunkTelegramHtml(html, { maxChars: 60 });
    expectAllValid(chunks, 60);
    expect(chunks.some((chunk) => chunk.includes("<pre>"))).toBe(true);
  });

  it("drops an unmatched closing tag rather than unbalancing a chunk", () => {
    const chunks = chunkTelegramHtml("text</b>more", { maxChars: 100 });
    expect(chunks).toEqual(["textmore"]);
  });

  it("keeps a bare angle bracket as text", () => {
    expect(chunkTelegramHtml("a < b", { maxChars: 100 })).toEqual(["a < b"]);
  });

  it("preserves all visible text across chunks", () => {
    const html = markdownToTelegramHtml(
      Array.from({ length: 40 }, (_, i) => `paragraph **${i}** with some filler text`).join("\n\n"),
    );
    const chunks = chunkTelegramHtml(html, { maxChars: 200 });
    expectAllValid(chunks, 200);

    // The whitespace a split lands on is consumed by the message boundary, so
    // chunks rejoin with a separator rather than edge-to-edge.
    const rejoined = chunks.map(stripTags).join(" ").replace(/\s+/gu, " ").trim();
    const expected = stripTags(html).replace(/\s+/gu, " ").trim();
    expect(rejoined).toBe(expected);
  });
});

describe("chunkTelegramHtml robustness", () => {
  it("respects a tiny budget without looping forever", () => {
    const chunks = chunkTelegramHtml("<b>abcdefghij</b>", { maxChars: 8 });
    expectAllValid(chunks, 8);
  });

  it("terminates when a tag pair alone exceeds the budget", () => {
    const chunks = chunkTelegramHtml("<blockquote>abc</blockquote>", { maxChars: 5 });
    expectAllValid(chunks, 5);
  });

  it("handles a realistic long markdown document", () => {
    const markdown = [
      "# Report",
      "",
      "Some **bold** intro with a [link](https://example.com/path).",
      "",
      "```ts",
      Array.from({ length: 300 }, (_, i) => `const value${i} = ${i};`).join("\n"),
      "```",
      "",
      "- item one",
      "- item two",
      "",
      "> quoted conclusion",
    ].join("\n");

    const chunks = chunkTelegramHtml(markdownToTelegramHtml(markdown));
    expect(chunks.length).toBeGreaterThan(1);
    expectAllValid(chunks, TELEGRAM_MAX_MESSAGE_CHARS);
  });
});
