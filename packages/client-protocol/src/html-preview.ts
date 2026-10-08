import { z } from "zod";

export const HTML_PREVIEW_LANGUAGE = "html-preview-file";
export const HTML_PREVIEW_ROUTE = "/api/html-previews";
export const HTML_PREVIEW_MIN_HEIGHT = 80;
export const HTML_PREVIEW_MAX_HEIGHT = 2000;

export type HtmlPreviewTarget = {
  readonly threadId: string;
  readonly messageId: string;
  readonly path: string;
};

export function htmlPreviewPath(source: string): string | undefined {
  const path = source.trim();
  if (!path || path.length > 4096 || /[\r\n]/u.test(path) || path.includes("\u0000"))
    return undefined;
  return path;
}

export function htmlPreviewHref(target: HtmlPreviewTarget): string {
  const query = new URLSearchParams({
    thread: target.threadId,
    message: target.messageId,
    path: target.path,
  });
  return `${HTML_PREVIEW_ROUTE}?${query}`;
}

export function parseHtmlPreviewHref(url: URL): HtmlPreviewTarget | undefined {
  if (url.pathname !== HTML_PREVIEW_ROUTE) return undefined;
  const threadId = url.searchParams.get("thread");
  const messageId = url.searchParams.get("message");
  const path = htmlPreviewPath(url.searchParams.get("path") ?? "");
  if (!threadId || !messageId || path === undefined) return undefined;
  return { threadId, messageId, path };
}

export type HtmlPreviewTheme = {
  readonly appearance: "light" | "dark";
  readonly variables: Readonly<Record<string, string>>;
};

// The frame bridge follows the MCP Apps JSON-RPC notifications so pages written for T3 Code or
// other MCP Apps hosts keep working: https://github.com/modelcontextprotocol/ext-apps
export const HTML_PREVIEW_THEME_KEY = "lilac-theme";
export const HTML_PREVIEW_HOST_CONTEXT_METHOD = "ui/notifications/host-context-changed";
export const HTML_PREVIEW_SIZE_METHOD = "ui/notifications/size-changed";
export const HTML_PREVIEW_OPEN_LINK_METHOD = "ui/open-link";

// The frame scrolls a page taller than itself, but a scrollbar inside the reply reads as a box
// within the thread, so it stays hidden.
const BASE_CSS =
  "html{background:transparent;color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;scrollbar-width:none}" +
  "html::-webkit-scrollbar{display:none}body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}";

// Runs in <head> before the page's own styles, so the first paint already has the theme from the
// URL fragment. It rewrites its own <style> element, so a page's later :root rules still win.
// Links open through the host instead of replacing the page, and the page reports its height so
// the host can fit the frame to it.
const BOOTSTRAP_SCRIPT = `(function () {
  var themeStyle = document.getElementById("lilac-theme");
  var linkRequests = 0;
  if (!themeStyle) return;
  var baseCss = ${JSON.stringify(BASE_CSS)};
  function applyTheme(theme) {
    if (!theme || typeof theme !== "object" || !theme.variables || typeof theme.variables !== "object") return;
    var css = ":root{color-scheme:" + (theme.appearance === "light" ? "light" : "dark") + ";";
    for (var name in theme.variables) {
      if (!/^--[a-z0-9-]+$/.test(name)) continue;
      css += name + ":" + String(theme.variables[name]).replace(/[;{}<>]/g, "") + ";";
    }
    themeStyle.textContent = css + "}" + baseCss;
  }
  try {
    var fragment = /[#&]${HTML_PREVIEW_THEME_KEY}=([^&]*)/.exec(location.hash);
    if (fragment) {
      applyTheme(JSON.parse(decodeURIComponent(fragment[1])));
      history.replaceState(history.state, "", location.pathname + location.search);
    }
  } catch (error) {}
  window.addEventListener("message", function (event) {
    var message = event.data;
    var params = message && message.params;
    if (event.source !== window.parent || !message || message.jsonrpc !== "2.0") return;
    if (message.method !== ${JSON.stringify(HTML_PREVIEW_HOST_CONTEXT_METHOD)} || !params || !params.styles) return;
    applyTheme({ appearance: params.theme, variables: params.styles.variables });
  });
  document.addEventListener("click", function (event) {
    var link = event.isTrusted
      ? event.composedPath().find(function (target) { return target && target.matches && target.matches("a[href]"); })
      : null;
    var url;
    if (!link) return;
    try { url = new URL(link.getAttribute("href"), document.baseURI); } catch (error) { return; }
    if (!/^https?:$/.test(url.protocol) || url.href.split("#")[0] === location.href.split("#")[0]) return;
    if (window.parent === window) {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener");
      return;
    }
    event.preventDefault();
    window.parent.postMessage({ jsonrpc: "2.0", id: "lilac-link-" + ++linkRequests, method: ${JSON.stringify(HTML_PREVIEW_OPEN_LINK_METHOD)}, params: { url: url.href } }, "*");
  }, true);
  if (window.parent === window) return;
  var reportedHeight;
  var observer;
  function reportHeight() {
    var root = document.documentElement;
    var height = Math.ceil(root.scrollHeight > root.clientHeight ? root.scrollHeight : root.getBoundingClientRect().height);
    if (height === reportedHeight) return;
    reportedHeight = height;
    window.parent.postMessage({ jsonrpc: "2.0", method: ${JSON.stringify(HTML_PREVIEW_SIZE_METHOD)}, params: { height: height } }, "*");
  }
  if (window.ResizeObserver) {
    observer = new ResizeObserver(reportHeight);
    observer.observe(document.documentElement);
  }
  document.addEventListener("DOMContentLoaded", function () {
    if (observer && document.body) observer.observe(document.body);
    reportHeight();
  });
  window.addEventListener("load", reportHeight);
})();`;

export const HTML_PREVIEW_BOOTSTRAP_MARKUP =
  '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
  `<style id="lilac-theme">${BASE_CSS}</style><script>${BOOTSTRAP_SCRIPT}</script>`;

export function htmlPreviewThemeFragment(theme: HtmlPreviewTheme): string {
  return `#${HTML_PREVIEW_THEME_KEY}=${encodeURIComponent(JSON.stringify(theme))}`;
}

export function htmlPreviewThemeMessage(theme: HtmlPreviewTheme) {
  return {
    jsonrpc: "2.0",
    method: HTML_PREVIEW_HOST_CONTEXT_METHOD,
    params: { theme: theme.appearance, styles: { variables: theme.variables } },
  } as const;
}

const frameMessageSchema = z.union([
  z.object({
    jsonrpc: z.literal("2.0"),
    method: z.literal(HTML_PREVIEW_SIZE_METHOD),
    params: z.object({ height: z.number().positive() }),
  }),
  z.object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number()]),
    method: z.literal(HTML_PREVIEW_OPEN_LINK_METHOD),
    params: z.object({ url: z.string().regex(/^https?:\/\//iu) }),
  }),
]);

export type HtmlPreviewFrameMessage =
  | { readonly kind: "size"; readonly height: number }
  | { readonly kind: "link"; readonly id: string | number; readonly url: string };

export function decodeHtmlPreviewFrameMessage(data: unknown): HtmlPreviewFrameMessage | undefined {
  const parsed = frameMessageSchema.safeParse(data);
  if (!parsed.success) return undefined;
  const message = parsed.data;
  return "id" in message
    ? { kind: "link", id: message.id, url: message.params.url }
    : { kind: "size", height: message.params.height };
}

export function htmlPreviewResult(id: string | number) {
  return { jsonrpc: "2.0", id, result: {} } as const;
}
