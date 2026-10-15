import { expect, test } from "bun:test";
import {
  htmlPreviewHref,
  htmlPreviewPath,
  parseHtmlPreviewHref,
  decodeHtmlPreviewFrameMessage,
} from "../src/html-preview";

test("preview links round-trip the message and exact path", () => {
  const target = { threadId: "thread-1", messageId: "np_1", path: "/work/my chart?.html" };
  expect(parseHtmlPreviewHref(new URL(htmlPreviewHref(target), "https://chat.example"))).toEqual(
    target,
  );
  expect(parseHtmlPreviewHref(new URL("https://chat.example/api/html-previews?thread=t"))).toBe(
    undefined,
  );
});

test("a fence holds one path line", () => {
  expect(htmlPreviewPath("  ./chart.html \n")).toBe("./chart.html");
  expect(htmlPreviewPath("a.html\nb.html")).toBeUndefined();
  expect(htmlPreviewPath("   ")).toBeUndefined();
});

test("frame messages accept only well-formed heights and http links", () => {
  const size = (height: unknown) => ({
    jsonrpc: "2.0",
    method: "ui/notifications/size-changed",
    params: { height },
  });
  expect(decodeHtmlPreviewFrameMessage(size(320.5))).toEqual({ kind: "size", height: 320.5 });
  expect(decodeHtmlPreviewFrameMessage(size(-1))).toBeUndefined();
  expect(
    decodeHtmlPreviewFrameMessage({ method: "ui/notifications/size-changed" }),
  ).toBeUndefined();
  const link = (url: string) => ({
    jsonrpc: "2.0",
    id: 1,
    method: "ui/open-link",
    params: { url },
  });
  expect(decodeHtmlPreviewFrameMessage(link("https://example.com"))).toEqual({
    kind: "link",
    id: 1,
    url: "https://example.com",
  });
  expect(decodeHtmlPreviewFrameMessage(link("javascript:alert(1)"))).toBeUndefined();
});
