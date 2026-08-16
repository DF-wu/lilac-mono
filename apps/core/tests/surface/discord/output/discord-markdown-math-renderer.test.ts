import { describe, expect, it } from "bun:test";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

import { renderDiscordMarkdownMath } from "../../../../src/surface/discord/output/discord-markdown-math-renderer";
import { chunkMarkdownForEmbeds } from "../../../../src/surface/discord/output/markdown-chunker";

function render(markdown: string): string {
  return renderDiscordMarkdownMath(markdown);
}

function parse(markdown: string) {
  return fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
}

describe("renderDiscordMarkdownMath rendering", () => {
  it("renders exact inline output in a dynamic code span", () => {
    expect(render("before \\(x+1\\) after")).toBe("before `x + 1` after");
    expect(render("\\(x^2 + y_1\\)")).toBe("`x² + y₁`");
  });

  it("always fences display output, including a one-line layout", () => {
    expect(render("$$x+1$$")).toBe("```text\nx + 1\n```");
    expect(render("\\[x^2\\]")).toBe("```text\nx²\n```");
  });

  it("uses a text block for a whole-paragraph multiline inline layout", () => {
    expect(render("\\(\\frac{a}{b}\\)")).toBe("```text\n a\n───\n b\n```");
    expect(render("  \\(\\frac{a}{b}\\)\t")).toBe("  ```text\n a\n───\n b\n```\t");
  });

  it("falls back instead of inserting a block into surrounding inline content", () => {
    expect(render("before \\(\\frac{a}{b}\\) after")).toBe("before `\\(\\frac{a}{b}\\)` after");
    expect(
      renderDiscordMarkdownMath("before \\(\\frac{a}{b}\\) after", {
        fallbackMode: "passthrough",
      }),
    ).toBe("before \\(\\frac{a}{b}\\) after");
  });

  it("never recognizes single-dollar math", () => {
    const input = "$x+1$ and USD $5 and $$not standalone$$ text";
    expect(render(input)).toBe(input);
  });

  it("preserves formatting while rendering inside emphasis, strong, and delete", () => {
    const output = render("*\\(x\\)* **\\(y\\)** ~~\\(z\\)~~");
    expect(output).toBe("*`x`* **`y`** ~~`z`~~");

    const tree = parse(output);
    const paragraph = tree.children[0];
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type !== "paragraph") throw new Error("expected paragraph");
    expect(paragraph.children.map((node) => node.type)).toEqual([
      "emphasis",
      "text",
      "strong",
      "text",
      "delete",
    ]);
    expect(
      paragraph.children[0]?.type === "emphasis" && paragraph.children[0].children[0]?.type,
    ).toBe("inlineCode");
  });

  it("renders inline math in lists and blockquotes", () => {
    expect(render("- item \\(x+1\\)\n- **\\(y\\)**\n\n> quote \\(z\\)")).toBe(
      "- item `x + 1`\n- **`y`**\n\n> quote `z`",
    );
  });

  it("renders adjacent inline expressions independently", () => {
    const output = render("\\(x\\)\\(y+1\\)");
    expect(output).toBe("`x`\u200b`y + 1`");
    const paragraph = parse(output).children[0];
    expect(paragraph?.type === "paragraph" && paragraph.children.map((node) => node.type)).toEqual([
      "inlineCode",
      "text",
      "inlineCode",
    ]);
  });
});

describe("renderDiscordMarkdownMath display eligibility", () => {
  it("requires display math to occupy a direct-root paragraph", () => {
    expect(render("  $$x$$\t")).toBe("  ```text\nx\n```\t");
    expect(render("text $$x$$")).toBe("text $$x$$");
    expect(render("$$x$$ tail")).toBe("$$x$$ tail");
    expect(render("prefix \\[x\\]")).toBe("prefix \\[x\\]");
  });

  it("leaves display syntax in lists, blockquotes, and tables untouched", () => {
    const inputs = ["- $$x$$", "> $$x$$", "| value |\n| --- |\n| $$x$$ |", "1. \\[x\\]"];
    for (const input of inputs) expect(render(input)).toBe(input);
  });

  it("rejects ambiguous adjacent dollar runs", () => {
    const inputs = ["$$$x$$$", "$$$$x$$$$", "$$x$$$", "$$$x$$", "$$x$$$$"];
    for (const input of inputs) expect(render(input)).toBe(input);
  });
});

describe("renderDiscordMarkdownMath protected Markdown", () => {
  it("protects one- and multi-backtick code spans", () => {
    const input = "`\\(x\\)` and ``a ` \\(y\\)`` and \\(z\\)";
    expect(render(input)).toBe("`\\(x\\)` and ``a ` \\(y\\)`` and `z`");
  });

  it("protects unmatched backtick spans through the paragraph end", () => {
    const inputs = ["` code \\(x\\)", "`` code \\(x\\)", "text ` code \\(x\\)"];
    for (const input of inputs) expect(render(input)).toBe(input);
  });

  it("protects backtick, tilde, and unclosed fenced code", () => {
    const inputs = [
      "```tex\n\\(x\\)\n```",
      "~~~~\n$$x$$\n~~~~",
      "`````md\n\\[x\\]\n```\nstill \\(y\\)",
      "~~~txt\n\\(x\\)",
    ];
    for (const input of inputs) expect(render(input)).toBe(input);
  });

  it("protects indented code", () => {
    const input = "    \\(x\\)\n\nnormal \\(y\\)";
    expect(render(input)).toBe("    \\(x\\)\n\nnormal `y`");
  });

  it("protects links, references, images, and definitions", () => {
    const input = [
      "[label \\(a\\)](https://example.test/\\(b\\))",
      "[reference \\(c\\)][id]",
      "![image \\(d\\)](https://example.test/\\(e\\).png)",
      "![image ref \\(f\\)][img]",
      "[id]: https://example.test/\\(g\\) 'title \\(h\\)'",
      "[img]: /asset/\\(i\\).png",
      "outside \\(j\\)",
    ].join("\n\n");
    expect(render(input)).toBe(input.replace("outside \\(j\\)", "outside `j`"));
  });

  it("leaves candidates split across Markdown nodes byte-for-byte unchanged", () => {
    const inputs = ["\\(x*y*z\\)", "\\(x [label](url) z\\)"];
    for (const input of inputs) {
      expect(renderDiscordMarkdownMath(input, {}, "streaming")).toBe(input);
      expect(render(input)).toBe(input);
    }
  });

  it("protects autolinks and bare GFM URLs", () => {
    const input = [
      "<https://example.test/\\(x\\)>",
      "https://example.test/\\(y\\)",
      "www.example.test/\\(z\\)",
      "outside \\(a\\)",
    ].join("\n\n");
    expect(render(input)).toBe(input.replace("outside \\(a\\)", "outside `a`"));
  });

  it("leaves any paragraph containing HTML untouched", () => {
    const input = [
      "<b>\\(x\\)</b> and \\(y\\)",
      "text <span title='\\(z\\)'>html</span> \\(a\\)",
      "<div>\n\\(b\\)\n</div>",
      "outside \\(c\\)",
    ].join("\n\n");
    expect(render(input)).toBe(input.replace("outside \\(c\\)", "outside `c`"));
  });
});

describe("renderDiscordMarkdownMath delimiters", () => {
  it("requires an odd slash run and uses its final slash as the delimiter", () => {
    expect(render(String.raw`\\(x\\) \\\(y\\\)`)).toBe(String.raw`\\(x\\) \\` + "`y`");
  });

  it("handles escaped closers", () => {
    expect(render(String.raw`\(a \\) b\)`)).toBe("`a)b`");
  });

  it("uses fallback for nested active openers", () => {
    expect(render("\\(outer \\(inner\\)")).toBe("`\\(outer \\(inner\\)`");
    expect(renderDiscordMarkdownMath("\\(outer \\(inner\\)", { fallbackMode: "passthrough" })).toBe(
      "\\(outer \\(inner\\)",
    );
  });

  it("balances nested same-type delimiters over the full outer candidate", () => {
    const complete = "\\(outer \\(inner\\) outer\\)";
    expect(render(complete)).toBe(`\`${complete}\``);
    expect(renderDiscordMarkdownMath(complete, { fallbackMode: "passthrough" })).toBe(complete);
    expect(renderDiscordMarkdownMath(complete, {}, "streaming")).toBe(`\`${complete}\``);

    const incomplete = "before \\(outer \\(inner\\) outer";
    expect(render(incomplete)).toBe("before `\\(outer \\(inner\\) outer`");
    expect(renderDiscordMarkdownMath(incomplete, {}, "streaming")).toBe("before ");
  });
});

describe("renderDiscordMarkdownMath fallback and safety", () => {
  it("falls back for malformed, unknown, and empty formulas", () => {
    const inputs = ["\\(\\frac{a}\\)", "\\(\\unknown{x}\\)", "\\(   \\)"];
    for (const input of inputs) expect(render(input)).toBe(`\`${input}\``);
  });

  it("supports source and passthrough fallback modes", () => {
    expect(render("bad \\(\\unknown{x}\\)")).toBe("bad `\\(\\unknown{x}\\)`");
    expect(
      renderDiscordMarkdownMath("bad \\(\\unknown{x}\\)", { fallbackMode: "passthrough" }),
    ).toBe("bad \\(\\unknown{x}\\)");
    expect(render("$$\\unknown{x}$$")).toBe("```latex\n$$\\unknown{x}$$\n```");
  });

  it("uses adaptive inline markers and CommonMark-safe padding for source fallback", () => {
    const output = render(String.raw`\(\text{\`} \unknown\)`);
    expect(output).toBe("``\\(\\text{\\`} \\unknown\\)``");
    const tree = parse(output);
    expect(tree.children[0]?.type === "paragraph" && tree.children[0].children[0]).toMatchObject({
      type: "inlineCode",
      value: "\\(\\text{\\`} \\unknown\\)",
    });
  });

  it("uses a fence longer than backtick runs in source fallback", () => {
    const input = "$$\\text{``` inside} \\unknown$$";
    expect(render(input)).toBe("````latex\n$$\\text{``` inside} \\unknown$$\n````");
  });

  it("passes through unsafe multiline inline source fallback", () => {
    const input = "before \\(a\n\\unknown\\) after";
    expect(render(input)).toBe(input);
    expect(renderDiscordMarkdownMath(input, { fallbackMode: "passthrough" })).toBe(input);
  });

  it("enforces width including the exact boundary and clamps maxWidth to one", () => {
    expect(renderDiscordMarkdownMath("\\(x+1\\)", { maxWidth: 5 })).toBe("`x + 1`");
    expect(renderDiscordMarkdownMath("\\(x+1\\)", { maxWidth: 4 })).toBe("`\\(x+1\\)`");
    expect(renderDiscordMarkdownMath("\\(x\\)", { maxWidth: 0 })).toBe("`x`");
  });

  it("falls back when the fixed renderer source ceiling is exceeded", () => {
    const input = `\\(${"x".repeat(2001)}\\)`;
    expect(render(input)).toBe(`\`${input}\``);
  });

  it("renders at most 32 candidates", () => {
    const input = Array.from({ length: 34 }, () => "\\(x\\)").join(" ");
    const expected = [...Array.from({ length: 32 }, () => "`x`"), "\\(x\\)", "\\(x\\)"].join(" ");
    expect(render(input)).toBe(expected);
  });

  it("applies the aggregate source/body budget before rendering later candidates", () => {
    const large = `\\(x${" ".repeat(1998)}\\)`;
    const input = [large, large, "\\(y\\)"].join(" ");
    expect(render(input)).toBe(["`x`", large, "\\(y\\)"].join(" "));
  });

  it("leaves markdown over the whole-source ceiling unchanged in both phases", () => {
    const input = `${"a".repeat(100_000)}\\(x\\)`;
    expect(renderDiscordMarkdownMath(input, {}, "streaming")).toBe(input);
    expect(render(input)).toBe(input);
  });

  it("leaves pathologically deep Markdown unchanged without throwing", () => {
    const input = `${"> ".repeat(20_000)}\\(x\\)`;
    expect(renderDiscordMarkdownMath(input, {}, "streaming")).toBe(input);
    expect(render(input)).toBe(input);
  });

  it("bounds collection when thousands of candidates are present", () => {
    const input = Array.from({ length: 5000 }, () => "\\(x\\)").join(" ");
    const expectedPrefix = Array.from({ length: 32 }, () => "`x`").join(" ");
    const output = render(input);
    expect(output.startsWith(`${expectedPrefix} \\(x\\)`)).toBe(true);
    expect(output.slice(expectedPrefix.length + 1)).toBe(
      Array.from({ length: 4968 }, () => "\\(x\\)").join(" "),
    );
  });
});

describe("renderDiscordMarkdownMath streaming", () => {
  it("omits unmatched eligible inline and display suffixes while streaming", () => {
    expect(renderDiscordMarkdownMath("before \\(partial", {}, "streaming")).toBe("before ");
    expect(renderDiscordMarkdownMath("  $$partial", {}, "streaming")).toBe("  ");
    expect(renderDiscordMarkdownMath(" \\[partial", {}, "streaming")).toBe(" ");
  });

  it("uses terminal fallback for unmatched candidates", () => {
    expect(render("before \\(partial")).toBe("before `\\(partial`");
    expect(render("$$partial")).toBe("```latex\n$$partial\n```");
    expect(renderDiscordMarkdownMath("\\(partial", { fallbackMode: "passthrough" })).toBe(
      "\\(partial",
    );
  });

  it("does not hide unmatched delimiters in protected and unsupported contexts", () => {
    const inputs = ["`\\(partial", "```txt\n\\(partial", "[\\(partial](url)", "> $$partial"];
    for (const input of inputs) {
      expect(renderDiscordMarkdownMath(input, {}, "streaming")).toBe(input);
    }
  });

  it("leaves cross-paragraph display delimiters unchanged", () => {
    for (const input of ["$$a\n\nb$$", "\\[a\n\nb\\]"]) {
      expect(renderDiscordMarkdownMath(input, {}, "streaming")).toBe(input);
      expect(render(input)).toBe(input);
    }
  });

  it("renders a complete candidate before hiding a later unmatched one", () => {
    expect(renderDiscordMarkdownMath("\\(x\\) then \\(partial", {}, "streaming")).toBe("`x` then ");
    expect(render("\\(x\\) then \\(partial")).toBe("`x` then `\\(partial`");
  });
});

describe("renderDiscordMarkdownMath preservation", () => {
  it("preserves CRLF outside replacements and uses it in generated fences", () => {
    const input = "alpha\r\n\r\n$$\\frac{a}{b}$$\r\n\r\nomega \\(x\\)";
    expect(render(input)).toBe("alpha\r\n\r\n```text\r\n a\r\n───\r\n b\r\n```\r\n\r\nomega `x`");
  });

  it("preserves every original slice outside source ranges", () => {
    const prefix = "  alpha\t**";
    const middle = "**  \r\nnext ";
    const suffix = " !  ";
    const input = `${prefix}\\(x+1\\)${middle}\\(y\\)${suffix}`;
    expect(render(input)).toBe(`${prefix}\`x + 1\`${middle}\`y\`${suffix}`);
  });

  it("produces parseable display code blocks and inline code ancestry", () => {
    const output = render("**value \\(x\\)**\n\n$$y+1$$");
    const tree = parse(output);
    expect(tree.children.map((node) => node.type)).toEqual(["paragraph", "code"]);
    expect(tree.children[1]).toMatchObject({ type: "code", lang: "text", value: "y + 1" });
    const paragraph = tree.children[0];
    expect(paragraph?.type === "paragraph" && paragraph.children[0]).toMatchObject({
      type: "strong",
      children: [
        { type: "text", value: "value " },
        { type: "inlineCode", value: "x" },
      ],
    });
  });

  it("keeps generated fences valid through the existing chunker", () => {
    const rendered = render("$$\\frac{a}{b}$$");
    const chunks = chunkMarkdownForEmbeds(rendered, {
      maxChunkLength: 15,
      maxLastChunkLength: 15,
      useSmartSplitting: true,
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.startsWith("```text\n"))).toBe(true);
    expect(chunks.every((chunk) => chunk.endsWith("\n```"))).toBe(true);
  });

  it.each([2000, 4096])(
    "keeps tall generated math complete through the %i-character Discord limit",
    (hardMaxChunkLength) => {
      let formula = `\\text{${"x".repeat(140)}}`;
      for (let depth = 0; depth < 20; depth++) formula = `\\frac{1}{${formula}}`;

      const rendered = renderDiscordMarkdownMath(`$$${formula}$$`, { maxWidth: 240 });
      expect(rendered.startsWith("```text\n")).toBe(true);
      expect(rendered.length).toBeGreaterThan(hardMaxChunkLength);

      const chunks = chunkMarkdownForEmbeds(rendered, {
        maxChunkLength: hardMaxChunkLength - 10,
        maxLastChunkLength: hardMaxChunkLength - 10,
        hardMaxChunkLength,
        useSmartSplitting: true,
      });

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.every((chunk) => chunk.length <= hardMaxChunkLength)).toBe(true);
      expect(chunks.every((chunk) => chunk.startsWith("```text\n"))).toBe(true);
      expect(chunks.every((chunk) => chunk.endsWith("\n```"))).toBe(true);
      const recovered = chunks.map((chunk) => chunk.slice(8, -4)).join("");
      expect(recovered.replaceAll(/\s/gu, "")).toBe(rendered.slice(8, -4).replaceAll(/\s/gu, ""));
    },
  );
});
