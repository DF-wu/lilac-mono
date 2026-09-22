import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import {
  isPublicLinkAddress,
  linkPreviewUrl,
  parseLinkPreview,
  readPublicPage,
  resolveLinkPreview,
} from "./link-preview";

describe("link previews", () => {
  test("Metascraper extracts metadata, entities, and declared PNG/SVG icons", async () => {
    const preview = await parseLinkPreview(
      `<title>Fallback</title>
      <meta property="og:title" content="A &amp; B">
      <meta property="og:description" content="A useful description of this page.">
      <meta property="og:image" content="/share.png">
      <link rel="icon" href="/favicon.png">`,
      "https://example.com/page",
    );
    expect(preview).toEqual({
      title: "A & B",
      description: "A useful description of this page.",
      image: "https://example.com/share.png",
      icon: "https://example.com/favicon.png",
    });
    expect(
      (
        await parseLinkPreview(
          '<title>Lilac</title><link rel="icon" type="image/svg+xml" href="/assets/logo-hash.svg">',
          "https://lilac.example.com/",
        )
      ).icon,
    ).toBe("https://lilac.example.com/assets/logo-hash.svg");
  });
  test("uses HTML title and description without requiring an image", async () => {
    expect(
      await parseLinkPreview(
        '<title>Plain page</title><meta name="description" content="Just a plain page.">',
        "https://example.com/a",
      ),
    ).toEqual({
      title: "Plain page",
      description: "Just a plain page.",
      image: undefined,
      icon: "https://example.com/favicon.ico",
    });
  });
  test("resolves icons against the page base and ignores executable URLs", async () => {
    const preview = await parseLinkPreview(
      '<base href="https://cdn.example.com/assets/"><link rel="icon" href="javascript:alert(1)"><link rel="icon" href="logo.svg"><meta property="og:image" content="data:text/html,bad">',
      "https://example.com",
    );
    expect(preview.icon).toBe("https://cdn.example.com/assets/logo.svg");
    expect(preview.image).toBeUndefined();
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://user:secret@example.com",
      "not a url",
    ])
      expect(linkPreviewUrl(url)).toBeUndefined();
    expect(linkPreviewUrl("https://example.com/page?q=1#part")?.href).toBe(
      "https://example.com/page?q=1",
    );
  });
  test("rejects private, mapped, reserved, and non-address destinations", () => {
    for (const ip of [
      "127.0.0.1",
      "10.2.3.4",
      "172.16.1.1",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "198.18.0.1",
      "224.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
      "2002:7f00:1::",
      "localhost",
    ])
      expect(isPublicLinkAddress(ip)).toBe(false);
    for (const ip of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])
      expect(isPublicLinkAddress(ip)).toBe(true);
  });
  test("never connects to local servers", async () => {
    let requests = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        requests++;
        return new Response("private");
      },
    });
    const result = await readPublicPage(new URL(server.url), AbortSignal.timeout(1000));
    expect(result.isErr()).toBe(true);
    expect(requests).toBe(0);
    server.stop(true);
  });
  test("resolves relative redirects and metadata against the final page", async () => {
    const visited: string[] = [];
    const result = await resolveLinkPreview("https://example.com/start", undefined, async (url) => {
      visited.push(url.href);
      if (visited.length === 1) return Result.ok({ html: "", location: "/news/page" });
      return Result.ok({ html: '<title>News</title><link rel="icon" href="logo.png">' });
    });
    expect(visited).toEqual(["https://example.com/start", "https://example.com/news/page"]);
    expect(result.icon).toBe("https://example.com/news/logo.png");
  });
  test("bounds redirect loops and rejects redirects to non-HTTP schemes", async () => {
    let requests = 0;
    expect(
      await resolveLinkPreview("https://example.com", undefined, async () => {
        requests++;
        return Result.ok({ html: "", location: "/loop" });
      }),
    ).toEqual({});
    expect(requests).toBe(4);
    expect(
      await resolveLinkPreview("https://example.com", undefined, async () =>
        Result.ok({ html: "", location: "file:///etc/passwd" }),
      ),
    ).toEqual({});
  });
  test("an aborted request settles without fetching", async () => {
    expect(await resolveLinkPreview("https://example.com", AbortSignal.abort())).toEqual({});
  });
});
