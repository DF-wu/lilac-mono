import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import MarkdownContent from "../src/components/MarkdownContent";
import MathExpression, { sanitizeMathTree } from "../src/components/rich-math";
import { highlightCode } from "../src/components/rich-code";
import { diagramSourceAllowed, markdownUrl } from "../src/components/markdown-policy";

describe("markdown", () => {
  test("retains extra blank lines between user paragraphs", () => {
    for (const count of [2, 3, 4]) {
      const text = `First${"\n".repeat(count)}Last`;
      const html = renderToStaticMarkup(<MarkdownContent text={text} preserveLineBreaks />);
      expect(html).toBe(`<p>First</p>\n<p>${"<br/>\n".repeat(count - 2)}Last</p>`);
    }
  });

  test("shows user line breaks without changing code or doubling Markdown hard breaks", () => {
    const text = "First paragraph\n\n**Next** line\nhttps://example.com\n\nHard\\\nbreak";
    const html = renderToStaticMarkup(<MarkdownContent text={text} preserveLineBreaks />);
    expect(html).toContain("<p>First paragraph</p>");
    expect(html).toContain("<strong>Next</strong> line<br/>");
    expect(html).toContain("<p>Hard<br/>\nbreak</p>");
    expect(html).not.toContain("\u200b");
    expect(renderToStaticMarkup(<MarkdownContent text={"one\ntwo"} />)).toContain(
      "<p>one\ntwo</p>",
    );
    expect(
      renderToStaticMarkup(<MarkdownContent text={"`one\ntwo`"} preserveLineBreaks />),
    ).not.toContain("<br");
  });

  test("keeps currency as prose while preserving Markdown and real math", () => {
    const text =
      "your $10 suggestion makes sense: your colleague shouldn’t have to assemble a miniature insurance claim over $7 just to **get paid**.";
    const html = renderToStaticMarkup(<MarkdownContent text={text} />);
    expect(html).toContain("$10 suggestion makes sense");
    expect(html).toContain("over $7 just to <strong>get paid</strong>");
    expect(html).not.toContain("<code");
    for (const prose of [
      "Pay $10 or $7",
      "Pay $10**each** and $7 later",
      "`$10 and $7`",
      "\\$10 and \\$7",
    ]) {
      const rendered = renderToStaticMarkup(<MarkdownContent text={prose} />);
      expect(rendered).not.toContain("markdown-math");
      expect(rendered).toContain("$10");
      expect(rendered).toContain("$7");
    }
    const formatted = renderToStaticMarkup(
      <MarkdownContent text="Pay $10 **now** and $7 later." />,
    );
    expect(formatted).toContain("$10 <strong>now</strong> and $7 later.");
    for (const text of ["Pay $10 and **$7** later.", "Pay **$10** and $7 later."]) {
      const rendered = renderToStaticMarkup(<MarkdownContent text={text} />);
      expect(rendered).toContain("<strong>$");
      expect(rendered).not.toContain("**");
    }
    const linked = renderToStaticMarkup(
      <MarkdownContent text="Pay $10 and [$7](https://example.com) later." />,
    );
    expect(linked).toContain('href="https://example.com"');
    expect(linked).toContain("$7");
    expect(linked).not.toContain("[$7]");
    const mixed = renderToStaticMarkup(
      <MarkdownContent text="Pay $10, then compute $x+1$ and pay $7." />,
    );
    expect(mixed).toContain("Pay $10, then compute");
    expect(mixed).toContain("x+1");
    expect(mixed).not.toContain("$x+1$");
    expect(mixed).toContain("and pay $7.");
    for (const math of ["$x^2$", "$10 + 7$", "$$x + y$$", "$$\n1 + 2\n$$"]) {
      const rendered = renderToStaticMarkup(<MarkdownContent text={math} />);
      expect(rendered).toMatch(/<code|markdown-math/);
      expect(rendered).not.toContain("$x");
    }
  });

  test("closes emphasis after CJK punctuation followed by CJK text", () => {
    const html = renderToStaticMarkup(<MarkdownContent text="**查核限制：**我讀到的" />);
    expect(html).toBe("<p><strong>查核限制：</strong>我讀到的</p>");
  });

  test("renders GFM and keeps embedded HTML and unsafe links inert", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent
        text={
          "| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n\n~~gone~~\n\n<script>alert(1)</script>\n\n[bad](javascript:alert) [safe](https://example.com)"
        }
      />,
    );
    expect(html).toContain("<table>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('aria-label="done"');
    expect(html).toContain("<del>gone</del>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('rel="noopener noreferrer"');
  });
  test("renders all five GitHub alerts with labeled icons and rich content", () => {
    for (const [kind, title] of [
      ["NOTE", "Note"],
      ["TIP", "Tip"],
      ["IMPORTANT", "Important"],
      ["WARNING", "Warning"],
      ["CAUTION", "Caution"],
    ]) {
      const html = renderToStaticMarkup(
        <MarkdownContent
          text={`> [!${kind}]\n> Keep **this** and [the guide](https://example.com).\n>\n> - First step\n> - Second step`}
        />,
      );
      expect(html).toContain(`data-alert="${kind!.toLowerCase()}"`);
      expect(html).toContain(`${title}</p>`);
      expect(html).toContain("<svg");
      expect(html).toContain('aria-hidden="true"');
      expect(html).toContain("<strong>this</strong>");
      expect(html).toContain("<ul>");
      expect(html).toContain("First step");
      expect(html).not.toContain(`[!${kind}]`);
    }
  });
  test("preserves alert body paragraphs and hard breaks", () => {
    for (const text of [
      "> [!NOTE]\n> First line  \n> Second line\n>\n> Another paragraph",
      "> [!NOTE]  \n> First line\n> Second line\n>\n> Another paragraph",
      "> [!note]\n>\n> First line\n> Second line\n>\n> Another paragraph",
    ]) {
      const html = renderToStaticMarkup(<MarkdownContent text={text} />);
      expect(html).toContain('data-alert="note"');
      expect(html).toContain("First line");
      expect(html).toContain("Second line");
      expect(html).toContain("<p>Another paragraph</p>");
    }
    const empty = renderToStaticMarkup(<MarkdownContent text="> [!TIP]" />);
    expect(empty).toContain('data-alert="tip"');
    expect(empty).not.toContain("<p></p>");
  });
  test("leaves quotes, code, unsupported markers, and inline or nested markers unchanged", () => {
    for (const text of [
      "> Ordinary quote",
      "> [!UNKNOWN]\n> Keep this",
      "> [!NOTE] same line",
      "> [!NOTE]**same line**",
      "> `[!NOTE]`\n> Code marker",
      "[!NOTE]\nPlain paragraph",
      "> Outer\n>\n> > [!NOTE]\n> > Nested quote",
      "- Item\n\n  > [!TIP]\n  > Nested in a list",
      "```md\n> [!NOTE]\n> Example\n```",
    ]) {
      const html = renderToStaticMarkup(<MarkdownContent text={text} />);
      expect(html).not.toContain("data-alert=");
    }
  });
  test("alerts preserve Markdown safety filtering", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent
        text={
          "> [!WARNING]\n> <script>alert(1)</script>\n>\n> [bad](javascript:alert) **Safe text**"
        }
      />,
    );
    expect(html).toContain('data-alert="warning"');
    expect(html).toContain("<strong>Safe text</strong>");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('href="javascript:');
  });
  test("malformed and unfinished fences keep source visible", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent text={'```typescript\nconst value = "<script>";\n'} />,
    );
    expect(html).toContain("const value");
    expect(html).toContain("&lt;script&gt;");
  });
  test("retained resource links and images use the authenticated resource endpoint", () => {
    const id = `r1_${"ab".repeat(16)}`;
    const uri = `resource://${id}`;
    expect(markdownUrl(uri)).toBe(`/api/resources/${id}`);
    const html = renderToStaticMarkup(
      <MarkdownContent text={`[report.txt](${uri})\n\n![Chart](${uri})`} />,
    );
    expect(html).toContain(`href="/api/resources/${id}"`);
    expect(html).toContain(`src="/api/resources/${id}"`);
    expect(html).toContain('aria-label="Preview Chart"');
    expect(html).not.toContain("resource://");
  });
  test("resource URLs reject transient IDs and noncanonical forms", () => {
    const id = `r1_${"ab".repeat(16)}`;
    for (const uri of [
      `resource://t1_${"ab".repeat(16)}`,
      `resource://${id}/file`,
      `resource://${id}?download=1`,
      `resource://${id}#fragment`,
      `resource://user@${id}`,
      `resource://${id}:443`,
      `resource://${id.toUpperCase()}`,
      `RESOURCE://${id}`,
      `resource://${id.slice(0, -1)}`,
      `resource://${id}a`,
      `resource://${id.replace("ab", "%61b")}`,
      "ssh://host/path.png",
    ])
      expect(markdownUrl(uri)).toBe("");
  });
  test("link protocols reject executable and ambiguous URLs", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:image/svg+xml,bad",
      "file:///etc/passwd",
      "vbscript:bad",
      "//external.invalid/x",
      "\\\\external.invalid",
      "java\nscript:bad",
    ])
      expect(markdownUrl(url)).toBe("");
    for (const url of [
      "https://example.com",
      "http://localhost",
      "mailto:a@example.com",
      "/api/resource/1",
      "#anchor",
    ])
      expect(markdownUrl(url)).toBe(url);
  });
});

describe("rich renderers", () => {
  test("MathJax outputs sanitized SVG for block and inline math", () => {
    for (const display of [true, false]) {
      const html = renderToStaticMarkup(
        <MathExpression source={"\\frac{1}{2}"} display={display} />,
      );
      expect(html).toContain("<svg");
      expect(html).toContain('aria-label="\\frac{1}{2}"');
      expect(html).toContain("<path");
      expect(html).not.toContain("<script");
    }
  });
  test("malformed math preserves a visible error instead of failing the message", () => {
    const html = renderToStaticMarkup(<MathExpression source={"\\frac{"} display />);
    expect(html.length).toBeGreaterThan(100);
    expect(html).toContain("markdown-math");
  });
  test("math sanitizer rejects active nodes, event handlers and CSS URLs", () => {
    const tree: Parameters<ReturnType<typeof sanitizeMathTree>>[0] = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "script",
          properties: {},
          children: [{ type: "text", value: "alert(1)" }],
        },
        {
          type: "element",
          tagName: "svg",
          properties: {
            onLoad: "alert(1)",
            style: "background:url(https://evil)",
            fill: "url(https://evil)",
            viewBox: "0 0 1 1",
          },
          children: [],
        },
      ],
    };
    sanitizeMathTree()(tree);
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0]).toMatchObject({ tagName: "svg", properties: { viewBox: "0 0 1 1" } });
    expect(JSON.stringify(tree)).not.toContain("evil");
    expect(JSON.stringify(tree)).not.toContain("alert");
  });
  test("Mermaid cannot override rendering security or inject configuration", () => {
    expect(diagramSourceAllowed("graph TD; A-->B")).toBe(true);
    expect(diagramSourceAllowed('%%{init: {"securityLevel":"loose"}}%%\ngraph TD; A-->B')).toBe(
      false,
    );
    expect(diagramSourceAllowed("---\nconfig:\n  themeCSS: unsafe\n---\ngraph TD; A-->B")).toBe(
      false,
    );
    expect(diagramSourceAllowed("x".repeat(33 * 1024))).toBe(false);
  });
  test("Shiki highlights bundled and deferred grammars without changing source", async () => {
    for (const language of ["typescript", "rust", "unknown-language"]) {
      const source = 'const value = "<script>";';
      const tokens = await highlightCode(source, language);
      expect(tokens.map((line) => line.map((token) => token.content).join("")).join("\n")).toBe(
        source,
      );
      if (language !== "unknown-language")
        expect(tokens.flat().some((token) => token.color?.includes("var(--syntax-"))).toBe(true);
    }
  });
  test("identical code reuses its tokenization promise", () => {
    expect(highlightCode("let cached = true", "typescript")).toBe(
      highlightCode("let cached = true", "typescript"),
    );
  });
});
