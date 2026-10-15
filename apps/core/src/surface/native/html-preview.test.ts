import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import {
  HtmlPreviewReply,
  htmlPreviewPaths,
  injectHtmlPreviewBootstrap,
  inlineHtmlPreviewAssets,
} from "./html-preview";

const png = { bytes: new Uint8Array([137, 80, 78, 71]), mediaType: "image/png" };
const pngUri = "data:image/png;base64,iVBORw==";

function reader(files: Record<string, { bytes: Uint8Array; mediaType: string }>) {
  const reads: string[] = [];
  return {
    reads,
    read: async (target: string) => {
      reads.push(target);
      const file = files[target];
      return file ? Result.ok(file) : Result.err({ message: "missing" });
    },
  };
}

describe("html preview fences", () => {
  test("finds single-path fences at any depth and ignores other code", () => {
    const text = [
      "```html-preview-file\n/tmp/a.html\n```",
      "- item\n\n  ```html-preview-file\n  ./b.html\n  ```",
      "> ```html-preview-file\n> /tmp/a.html\n> ```",
      "```html\n<p>not a preview</p>\n```",
      "```html-preview-file\n/tmp/one.html\n/tmp/two.html\n```",
      "```html-preview-file\n```",
    ].join("\n\n");
    expect(htmlPreviewPaths([text])).toEqual(["/tmp/a.html", "./b.html"]);
  });

  test("parses each message on its own, as web renders them", () => {
    expect(htmlPreviewPaths(["```ts\nunclosed", "```html-preview-file\n/tmp/c.html\n```"])).toEqual(
      ["/tmp/c.html"],
    );
  });

  test("keeps the messages a reset leaves on screen", () => {
    const reply = new HtmlPreviewReply("a1");
    reply.start("p1", "step-1");
    reply.append("p1", "first");
    reply.start("p2", "step-2");
    reply.append("p2", "retried");
    reply.reset("a2", "step-2");
    reply.start("p3", "step-2");
    reply.append("p3", "second");
    expect(reply.texts()).toEqual(["first", "second"]);
    reply.reset("a3");
    expect(reply.texts()).toEqual(["first"]);
  });

  test("starts a new message when a step reuses a part ID", () => {
    const reply = new HtmlPreviewReply("a1");
    reply.start("text", "step-1");
    reply.append("text", "```ts\nunclosed");
    reply.endStep();
    reply.start("text", "step-2");
    reply.append("text", "```html-preview-file\n/tmp/d.html\n```");
    expect(htmlPreviewPaths(reply.texts())).toEqual(["/tmp/d.html"]);
    reply.reset("a2", "step-2");
    expect(reply.texts()).toEqual(["```ts\nunclosed"]);
  });
});

describe("html preview asset inlining", () => {
  test("inlines local files, resources, and stylesheet urls but keeps remote URLs", async () => {
    const css = new TextEncoder().encode("body{background:url('./bg.png')}");
    const files = reader({
      "/work/dot.png": png,
      "/work/assets/style.css": { bytes: css, mediaType: "text/css" },
      "/work/assets/bg.png": png,
      "resource://r1_0123456789abcdef0123456789abcdef": png,
    });
    const html = [
      '<html><head><link rel="stylesheet" href="assets/style.css">',
      '<script src="https://cdn.example.com/chart.js"></script>',
      "<style>.hero{background:url(dot.png?v=1)}</style></head><body>",
      '<img src="./dot.png"><img src="resource://r1_0123456789abcdef0123456789abcdef">',
      '<img src="data:image/gif;base64,R0lG"><a href="./other.html">next</a>',
      '<div style="background-image:url(&quot;/work/dot.png&quot;)"></div>',
      '<img src="file:///work/dot.png">',
      "</body></html>",
    ].join("");
    const inlined = (await inlineHtmlPreviewAssets(html, "/work", files.read)).unwrap();
    expect(inlined).toContain('<script src="https://cdn.example.com/chart.js">');
    expect(inlined).toContain(`.hero{background:url(${pngUri})}`);
    expect(inlined).toContain(`<img src="${pngUri}"><img src="${pngUri}">`);
    expect(inlined).toContain('<img src="data:image/gif;base64,R0lG">');
    expect(inlined).toContain('<a href="./other.html">');
    expect(inlined).toContain(`<img src="${pngUri}"></body>`);
    expect(inlined).not.toContain("/work/dot.png");
    const stylesheet = /<link rel="stylesheet" href="data:text\/css;base64,([^"]+)">/u.exec(
      inlined,
    )?.[1];
    expect(Buffer.from(stylesheet ?? "", "base64").toString()).toBe(
      `body{background:url(${pngUri})}`,
    );
    expect(files.reads.filter((target) => target === "/work/dot.png")).toHaveLength(1);
  });

  test("names every missing asset", async () => {
    const files = reader({});
    const result = await inlineHtmlPreviewAssets(
      '<img src="a.png"><img src="/abs/b.png">',
      "/work",
      files.read,
    );
    expect(result.match({ ok: () => "", err: (error) => error.message })).toBe(
      "Missing or unreadable assets: /work/a.png, /abs/b.png",
    );
  });
});

describe("html preview bootstrap", () => {
  test("goes first in the head, before the page's own styles", () => {
    const page = injectHtmlPreviewBootstrap(
      "<!doctype html><html><head><style>:root{--x:1}</style></head><body></body></html>",
    );
    expect(page.indexOf('<style id="lilac-theme">')).toBeLessThan(page.indexOf(":root{--x:1}"));
    expect(page.startsWith("<!doctype html><html><head><meta charset")).toBe(true);
  });

  test("adds a head to a fragment, after any doctype", () => {
    expect(injectHtmlPreviewBootstrap("<!doctype html><p>hi</p>")).toMatch(
      /^<!doctype html><head><meta charset="utf-8">.*<\/head><p>hi<\/p>$/su,
    );
    expect(injectHtmlPreviewBootstrap("<p>hi</p>")).toMatch(/^<head>.*<\/head><p>hi<\/p>$/su);
  });
});
