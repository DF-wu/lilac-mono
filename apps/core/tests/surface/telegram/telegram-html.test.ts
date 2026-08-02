import { describe, expect, it } from "bun:test";

import {
  escapeTelegramHtml,
  escapeTelegramHtmlAttribute,
  isTelegramSupportedTag,
  markdownToTelegramHtml,
  renderTelegramCodeBlock,
  renderTelegramInline,
  stripTelegramHtml,
} from "../../../src/surface/telegram/output/telegram-html";

const ALLOWED_TAGS = new Set(["b", "i", "u", "s", "tg-spoiler", "a", "code", "pre", "blockquote"]);

type TagOccurrence = { readonly name: string; readonly closing: boolean };

function readTags(html: string): TagOccurrence[] {
  const out: TagOccurrence[] = [];
  const re = /<(\/?)([A-Za-z][A-Za-z0-9-]*)(?:\s[^>]*)?>/gu;
  for (const match of html.matchAll(re)) {
    out.push({ name: (match[2] ?? "").toLowerCase(), closing: match[1] === "/" });
  }
  return out;
}

function expectBalancedAndSupported(html: string): void {
  const stack: string[] = [];
  for (const tag of readTags(html)) {
    expect(ALLOWED_TAGS.has(tag.name)).toBe(true);
    if (tag.closing) {
      expect(stack.pop()).toBe(tag.name);
    } else {
      stack.push(tag.name);
    }
  }
  expect(stack).toEqual([]);
}

describe("escapeTelegramHtml", () => {
  it("escapes only the three characters Telegram requires", () => {
    expect(escapeTelegramHtml(`<b>&"'`)).toBe(`&lt;b&gt;&amp;"'`);
  });

  it("escapes ampersands before angle brackets so entities are not double-encoded", () => {
    expect(escapeTelegramHtml("&lt;")).toBe("&amp;lt;");
  });

  it("escapes quotes for attribute values", () => {
    expect(escapeTelegramHtmlAttribute(`https://x/?a="1"&b=2`)).toBe(
      "https://x/?a=&quot;1&quot;&amp;b=2",
    );
  });
});

describe("isTelegramSupportedTag", () => {
  it("accepts the documented tag set and rejects everything else", () => {
    expect(isTelegramSupportedTag("tg-spoiler")).toBe(true);
    expect(isTelegramSupportedTag("PRE")).toBe(true);
    expect(isTelegramSupportedTag("script")).toBe(false);
    expect(isTelegramSupportedTag("h1")).toBe(false);
  });
});

describe("renderTelegramCodeBlock", () => {
  it("emits a language class for a valid info string", () => {
    expect(renderTelegramCodeBlock({ code: "const x = 1;", language: "ts" })).toBe(
      '<pre><code class="language-ts">const x = 1;</code></pre>',
    );
  });

  it("drops an unsafe info string rather than emitting a broken attribute", () => {
    const html = renderTelegramCodeBlock({ code: "x", language: 'ts" onload="alert(1)' });
    expect(html).toBe("<pre>x</pre>");
    expectBalancedAndSupported(html);
  });
});

describe("markdownToTelegramHtml fenced code", () => {
  it("converts a fenced block with a language", () => {
    const html = markdownToTelegramHtml("```python\nprint(1)\n```");
    expect(html).toBe('<pre><code class="language-python">print(1)</code></pre>');
    expectBalancedAndSupported(html);
  });

  it("converts a fenced block without a language", () => {
    expect(markdownToTelegramHtml("```\nplain\n```")).toBe("<pre>plain</pre>");
  });

  it("closes an unterminated fence", () => {
    const html = markdownToTelegramHtml("```js\nlet a = 1;");
    expect(html).toBe('<pre><code class="language-js">let a = 1;</code></pre>');
    expectBalancedAndSupported(html);
  });

  it("supports tilde fences", () => {
    expect(markdownToTelegramHtml("~~~\nbody\n~~~")).toBe("<pre>body</pre>");
  });

  it("does not interpret markdown inside a code block", () => {
    const html = markdownToTelegramHtml(
      "```\n**not bold** and [not](https://a.example) a link\n```",
    );
    expect(html).toBe("<pre>**not bold** and [not](https://a.example) a link</pre>");
    expectBalancedAndSupported(html);
  });
});

describe("markdownToTelegramHtml code-block breakout attempts", () => {
  it("escapes a closing pre tag inside the code body", () => {
    const html = markdownToTelegramHtml("```\n</pre><b>escaped</b>\n```");
    expect(html).toBe("<pre>&lt;/pre&gt;&lt;b&gt;escaped&lt;/b&gt;</pre>");
    expectBalancedAndSupported(html);
  });

  it("escapes a closing code tag inside a language-tagged block", () => {
    const html = markdownToTelegramHtml("```ts\n</code></pre><script>x</script>\n```");
    expect(html).toBe(
      '<pre><code class="language-ts">&lt;/code&gt;&lt;/pre&gt;&lt;script&gt;x&lt;/script&gt;</code></pre>',
    );
    expectBalancedAndSupported(html);
  });

  it("escapes tags inside an inline code span", () => {
    const html = markdownToTelegramHtml("use `</code><i>x</i>` here");
    expect(html).toBe("use <code>&lt;/code&gt;&lt;i&gt;x&lt;/i&gt;</code> here");
    expectBalancedAndSupported(html);
  });
});

describe("markdownToTelegramHtml inline formatting", () => {
  it("renders bold, italic, strikethrough and spoilers", () => {
    expect(markdownToTelegramHtml("**b** *i* ~~s~~ ||sp||")).toBe(
      "<b>b</b> <i>i</i> <s>s</s> <tg-spoiler>sp</tg-spoiler>",
    );
  });

  it("prefers the doubled marker over its single-character prefix", () => {
    const html = markdownToTelegramHtml("**bold**");
    expect(html).toBe("<b>bold</b>");
    expectBalancedAndSupported(html);
  });

  it("keeps underscores inside identifiers literal", () => {
    expect(markdownToTelegramHtml("snake_case_name")).toBe("snake_case_name");
  });

  it("renders nested emphasis without unbalancing tags", () => {
    const html = markdownToTelegramHtml("**bold with *italic* inside**");
    expect(html).toBe("<b>bold with <i>italic</i> inside</b>");
    expectBalancedAndSupported(html);
  });

  it("leaves an unclosed marker as literal text", () => {
    const html = markdownToTelegramHtml("**dangling bold");
    expect(html).toBe("**dangling bold");
    expectBalancedAndSupported(html);
  });

  it("honours backslash escapes", () => {
    expect(markdownToTelegramHtml("\\*not italic\\*")).toBe("*not italic*");
  });
});

describe("markdownToTelegramHtml links", () => {
  it("renders a safe http link", () => {
    const html = markdownToTelegramHtml("[label](https://example.com/a?b=1&c=2)");
    expect(html).toBe('<a href="https://example.com/a?b=1&amp;c=2">label</a>');
    expectBalancedAndSupported(html);
  });

  it("drops a javascript: destination but keeps the label", () => {
    const html = markdownToTelegramHtml("[click](javascript:alert(1))");
    expect(html).toBe("click");
    expectBalancedAndSupported(html);
  });

  it("prevents an injected quote from escaping the href attribute", () => {
    const html = markdownToTelegramHtml('[x](https://a.example/")');
    expect(html).toContain("&quot;");
    expect(html).not.toContain('/""');
    expectBalancedAndSupported(html);
  });

  it("degrades an image to its alt text", () => {
    expect(markdownToTelegramHtml("![a picture](https://a.example/x.png)")).toBe("a picture");
  });

  it("renders inline formatting inside the link label", () => {
    const html = markdownToTelegramHtml("[**bold** label](https://a.example)");
    expect(html).toBe('<a href="https://a.example"><b>bold</b> label</a>');
    expectBalancedAndSupported(html);
  });
});

describe("markdownToTelegramHtml blocks", () => {
  it("renders headings as bold since Telegram has none", () => {
    expect(markdownToTelegramHtml("## Title here")).toBe("<b>Title here</b>");
    expect(markdownToTelegramHtml("###### Deep")).toBe("<b>Deep</b>");
  });

  it("renders a blockquote and merges consecutive quote lines", () => {
    const html = markdownToTelegramHtml("> one\n> two");
    expect(html).toBe("<blockquote>one\ntwo</blockquote>");
    expectBalancedAndSupported(html);
  });

  it("keeps list bullets and numbering prefixes", () => {
    expect(markdownToTelegramHtml("- alpha\n* beta\n1. one\n2) two")).toBe(
      "- alpha\n* beta\n1. one\n2) two",
    );
  });

  it("renders inline markup inside list items", () => {
    const html = markdownToTelegramHtml("- **item** with `code`");
    expect(html).toBe("- <b>item</b> with <code>code</code>");
    expectBalancedAndSupported(html);
  });

  it("keeps indented list markers", () => {
    expect(markdownToTelegramHtml("- top\n  - nested")).toBe("- top\n  - nested");
  });

  it("degrades a table to escaped plain text", () => {
    const html = markdownToTelegramHtml("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(html).toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expectBalancedAndSupported(html);
  });

  it("renders a thematic break without emitting an unsupported tag", () => {
    const html = markdownToTelegramHtml("a\n\n---\n\nb");
    expect(html).toBe("a\n\n———\n\nb");
    expectBalancedAndSupported(html);
  });

  it("returns an empty string for empty input", () => {
    expect(markdownToTelegramHtml("")).toBe("");
  });

  it("normalizes CRLF line endings", () => {
    expect(markdownToTelegramHtml("a\r\nb")).toBe("a\nb");
  });
});

describe("markdownToTelegramHtml never emits unsupported markup", () => {
  const hostile = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "<h1>heading</h1>",
    "<b>unclosed",
    "</b></i></pre>",
    "<a href='javascript:alert(1)'>x</a>",
    "text with < and > and & mixed",
    "```\n</pre>\n```\n</pre>",
    "**a *b** c*",
    "`unclosed code span",
  ];

  for (const input of hostile) {
    it(`stays balanced and supported for ${JSON.stringify(input)}`, () => {
      const html = markdownToTelegramHtml(input);
      expectBalancedAndSupported(html);
    });
  }

  it("escapes raw html so no source tag survives", () => {
    const html = markdownToTelegramHtml("<script>alert(1)</script>");
    expect(html).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(readTags(html)).toEqual([]);
  });
});

describe("renderTelegramInline", () => {
  it("renders a single line without block handling", () => {
    expect(renderTelegramInline("# not a heading **bold**")).toBe("# not a heading <b>bold</b>");
  });
});

describe("stripTelegramHtml", () => {
  it("removes tags and decodes entities", () => {
    expect(stripTelegramHtml('<b>bold</b> &amp; <a href="https://a.example">link</a>')).toBe(
      "bold & link",
    );
  });

  it("decodes ampersands last so encoded entities survive", () => {
    expect(stripTelegramHtml("&amp;lt;")).toBe("&lt;");
  });

  it("round-trips a rendered code block back to its source text", () => {
    const html = markdownToTelegramHtml("```\n<b>x</b> && y\n```");
    expect(stripTelegramHtml(html)).toBe("<b>x</b> && y");
  });

  it("leaves plain text untouched", () => {
    expect(stripTelegramHtml("no markup here")).toBe("no markup here");
  });
});
