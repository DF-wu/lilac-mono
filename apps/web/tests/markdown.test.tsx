import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import MarkdownContent from "../src/components/MarkdownContent";
import MathExpression, { sanitizeMathTree } from "../src/components/rich-math";
import { highlightCode } from "../src/components/rich-code";
import { diagramSourceAllowed, markdownUrl } from "../src/components/markdown-policy";

describe("markdown", () => {
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
  test("malformed and unfinished fences keep source visible", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent text={'```typescript\nconst value = "<script>";\n'} />,
    );
    expect(html).toContain("const value");
    expect(html).toContain("&lt;script&gt;");
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
