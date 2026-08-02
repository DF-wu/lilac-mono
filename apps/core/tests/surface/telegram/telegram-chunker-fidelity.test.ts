import { describe, expect, it } from "bun:test";

import {
  chunkTelegramHtml,
  TELEGRAM_MAX_MESSAGE_CHARS,
} from "../../../src/surface/telegram/output/telegram-chunker";

const stripTags = (html: string) => html.replaceAll(/<[^>]+>/gu, "");

function isBalanced(html: string): boolean {
  const stack: string[] = [];
  for (const match of html.matchAll(/<(\/?)([a-z-]+)[^>]*>/gu)) {
    const tag = match[2] ?? "";
    if (match[1] === "/") {
      if (stack.pop() !== tag) return false;
    } else {
      stack.push(tag);
    }
  }
  return stack.length === 0;
}

describe("chunking preserves code block content exactly", () => {
  // Between prose messages a dropped separator is invisible, but inside a code
  // block the text is literal: losing the space that a word split consumed
  // silently joins `alpha beta` into `alphabeta` across two messages.
  const bodies: Array<readonly [string, string]> = [
    ["space-separated words", "alpha beta gamma ".repeat(500)],
    ["newline-separated lines", "const a = 1;\n".repeat(900)],
    ["blank-line-separated blocks", "block\n\n".repeat(900)],
    ["indented code with blank lines", "def f():\n    return 1\n\n".repeat(400)],
    ["a single unbreakable run", "x".repeat(10_000)],
  ];

  for (const [name, body] of bodies) {
    it(`${name} round-trips byte-for-byte`, () => {
      const chunks = chunkTelegramHtml(`<pre><code>${body}</code></pre>`);

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.map(stripTags).join("")).toBe(stripTags(body));
    });
  }

  it("keeps the separator at the end of the preceding chunk, not the start of the next", () => {
    const chunks = chunkTelegramHtml(`<pre><code>${"alpha beta ".repeat(600)}</code></pre>`);
    const [first, second] = chunks;

    expect(stripTags(first ?? "").endsWith(" ")).toBe(true);
    expect(stripTags(second ?? "").startsWith(" ")).toBe(false);
  });
});

describe("chunking structural invariants", () => {
  const inputs: Array<readonly [string, string]> = [
    ["a huge fenced block", `<pre><code class="language-ts">${"x".repeat(12_000)}</code></pre>`],
    [
      "prose followed by code",
      `${"word ".repeat(1200)}<pre><code>${"y".repeat(6000)}</code></pre>`,
    ],
    [
      "escaped markup inside code",
      `<pre><code>${"&lt;b&gt;text&lt;/b&gt; ".repeat(400)}</code></pre>`,
    ],
    ["one unbreakable token", "z".repeat(10_000)],
    ["many small inline tags", "<b>hi</b> ".repeat(2000)],
  ];

  for (const [name, input] of inputs) {
    it(`${name}: every chunk is valid on its own`, () => {
      const chunks = chunkTelegramHtml(input);
      expect(chunks.length).toBeGreaterThan(0);

      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_CHARS);
        expect(isBalanced(chunk)).toBe(true);
        // A chunk must never end part-way through a tag.
        expect(chunk).not.toMatch(/<[a-z/][^>]*$/iu);
      }
    });
  }

  it("reopens the fenced language on the next chunk", () => {
    const chunks = chunkTelegramHtml(
      `<pre><code class="language-ts">${"x".repeat(12_000)}</code></pre>`,
    );

    for (const chunk of chunks.slice(1)) {
      expect(chunk.startsWith('<pre><code class="language-ts">')).toBe(true);
    }
  });
});
