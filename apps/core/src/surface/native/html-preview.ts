import { basename, posix } from "node:path";
import {
  HTML_PREVIEW_BOOTSTRAP_MARKUP,
  HTML_PREVIEW_LANGUAGE,
  HTML_PREVIEW_ROUTE,
  htmlPreviewPath,
  parseHtmlPreviewHref,
} from "@stanley2058/lilac-client-protocol";
import { Result, type Result as ResultType } from "better-result";
import type { Root, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { nativeFailure } from "./errors";
import type { NativeLiveFileService } from "./resources-live";
import type { NativeResourceService } from "./resources";
import type { NativeStore } from "./store";

const MAX_PREVIEWS_PER_TURN = 8;
const MAX_PAGE_BYTES = 16 * 1024 * 1024;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

type Failure = { readonly message: string };
type Asset = { readonly bytes: Uint8Array; readonly mediaType: string };
type AssetReader = (target: string) => Promise<ResultType<Asset, Failure>>;

function fencePath(node: Root | RootContent): string | undefined {
  if (node.type !== "code" || node.lang !== HTML_PREVIEW_LANGUAGE) return undefined;
  return htmlPreviewPath(node.value);
}

export function htmlPreviewPaths(texts: readonly string[]): string[] {
  const paths = new Set<string>();
  function inspect(node: Root | RootContent): void {
    const path = fencePath(node);
    if (path !== undefined) paths.add(path);
    if ("children" in node) for (const child of node.children) inspect(child);
  }
  for (const text of texts) inspect(fromMarkdown(text));
  return [...paths];
}

// A local file or retained resource to inline; remote and data URLs load as they are.
function assetTarget(value: string, baseDir: string | undefined): string | undefined {
  const reference = value.trim();
  if (!reference || reference.startsWith("#") || reference.startsWith("//")) return undefined;
  if (reference.startsWith("resource://")) return reference;
  if (reference.startsWith("file:///")) return fileUrlPath(reference);
  if (/^[a-z][a-z\d+.-]*:/iu.test(reference) || baseDir === undefined) return undefined;
  const path = reference.replace(/[?#].*$/su, "");
  const decoded = Result.try({ try: () => decodeURIComponent(path), catch: () => path }).match({
    ok: (value) => value,
    err: () => path,
  });
  return posix.resolve(baseDir, decoded);
}

function fileUrlPath(reference: string): string | undefined {
  if (!URL.canParse(reference)) return undefined;
  const pathname = new URL(reference).pathname;
  return Result.try({ try: () => decodeURIComponent(pathname), catch: () => pathname }).match({
    ok: (value) => value,
    err: () => undefined,
  });
}

const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/giu;

function cssTargets(css: string, baseDir: string | undefined): string[] {
  return [...css.matchAll(CSS_URL)].flatMap((match) => {
    const target = assetTarget(match[1] ?? match[2] ?? match[3] ?? "", baseDir);
    return target === undefined ? [] : [target];
  });
}

function rewriteCss(css: string, baseDir: string | undefined, uris: ReadonlyMap<string, string>) {
  return css.replace(CSS_URL, (whole, double?: string, single?: string, bare?: string) => {
    const target = assetTarget(double ?? single ?? bare ?? "", baseDir);
    const uri = target === undefined ? undefined : uris.get(target);
    // Base64 data URIs contain no quotes or parentheses, so they stay valid inside style attributes.
    return uri === undefined ? whole : `url(${uri})`;
  });
}

const ATTRIBUTE_ASSETS = [
  ["[src]", "src"],
  ["video[poster]", "poster"],
  ["link[href]", "href"],
  ["image[href]", "href"],
] as const;

const NAMED_ENTITIES: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };

// HTMLRewriter returns attribute values as written, entities included; setAttribute escapes quotes.
function decodeAttribute(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/giu,
    (whole, decimal?: string, hex?: string, name?: string) => {
      if (decimal !== undefined) return String.fromCodePoint(Number(decimal));
      if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
      return NAMED_ENTITIES[name?.toLowerCase() ?? ""] ?? whole;
    },
  );
}

// Visits every inlinable reference in a page. One pass collects them; a second rewrites them.
function visitHtml(
  html: string,
  visit: {
    attribute: (value: string) => string | undefined;
    css: (css: string) => string | undefined;
  },
): ResultType<string, Failure> {
  let rewriter = new HTMLRewriter();
  for (const [selector, name] of ATTRIBUTE_ASSETS)
    rewriter = rewriter.on(selector, {
      element(element) {
        const next = visit.attribute(decodeAttribute(element.getAttribute(name) ?? ""));
        if (next !== undefined) element.setAttribute(name, next);
      },
    });
  let styleText = "";
  rewriter = rewriter
    .on("[style]", {
      element(element) {
        const next = visit.css(decodeAttribute(element.getAttribute("style") ?? ""));
        if (next !== undefined) element.setAttribute("style", next);
      },
    })
    .on("style", {
      text(chunk) {
        styleText += chunk.text;
        if (!chunk.lastInTextNode) {
          chunk.remove();
          return;
        }
        const css = styleText;
        styleText = "";
        chunk.replace(visit.css(css) ?? css, { html: true });
      },
    });
  return Result.try({
    try: () => rewriter.transform(html),
    catch: () => ({ message: "The HTML file could not be parsed" }),
  });
}

function dataUri(asset: Asset): string {
  return `data:${asset.mediaType};base64,${Buffer.from(asset.bytes).toString("base64")}`;
}

/**
 * Replaces local files and `resource://` references with data URIs, so the stored page shows
 * what the agent saw. Stylesheets have their own `url()` references inlined one level deep.
 */
export async function inlineHtmlPreviewAssets(
  html: string,
  baseDir: string,
  read: AssetReader,
): Promise<ResultType<string, Failure>> {
  const uris = new Map<string, string>();
  const missing = new Set<string>();
  async function load(target: string, nested: boolean): Promise<void> {
    if (uris.has(target) || missing.has(target)) return;
    const asset = (await read(target)).match({ ok: (value) => value, err: () => undefined });
    if (!asset) {
      missing.add(target);
      return;
    }
    if (asset.mediaType !== "text/css" || nested) {
      uris.set(target, dataUri(asset));
      return;
    }
    const css = decoder.decode(asset.bytes);
    const cssDir = target.startsWith("resource://") ? undefined : posix.dirname(target);
    for (const nestedTarget of cssTargets(css, cssDir)) await load(nestedTarget, true);
    const bytes = encoder.encode(rewriteCss(css, cssDir, uris));
    uris.set(target, dataUri({ bytes, mediaType: "text/css" }));
  }
  const targets: string[] = [];
  return Result.gen(async function* () {
    yield* visitHtml(html, {
      attribute: (value) => {
        const target = assetTarget(value, baseDir);
        if (target !== undefined) targets.push(target);
        return undefined;
      },
      css: (css) => {
        targets.push(...cssTargets(css, baseDir));
        return undefined;
      },
    });
    for (const target of targets) await load(target, false);
    if (missing.size > 0)
      return Result.err({ message: `Missing or unreadable assets: ${[...missing].join(", ")}` });
    return visitHtml(html, {
      attribute: (value) => {
        const target = assetTarget(value, baseDir);
        return target === undefined ? undefined : uris.get(target);
      },
      css: (css) => rewriteCss(css, baseDir, uris),
    });
  });
}

export function injectHtmlPreviewBootstrap(html: string): string {
  let injected = false;
  const rewritten = Result.try({
    try: () =>
      new HTMLRewriter()
        .on("head", {
          element(element) {
            if (injected) return;
            injected = true;
            element.prepend(HTML_PREVIEW_BOOTSTRAP_MARKUP, { html: true });
          },
        })
        .transform(html),
    catch: () => html,
  }).match({ ok: (value) => value, err: () => html });
  if (injected) return rewritten;
  const doctype = /^\s*<!doctype[^>]*>/iu.exec(html)?.[0] ?? "";
  return `${doctype}<head>${HTML_PREVIEW_BOOTSTRAP_MARKUP}</head>${html.slice(doctype.length)}`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (character) => `&#${character.charCodeAt(0)};`);
}

function previewResponse(html: string, status = 200): Response {
  return new Response(injectHtmlPreviewBootstrap(html), {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      // Scripts and remote assets such as CDN chart libraries run, but in an opaque origin
      // without the app's cookies or storage.
      "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups",
    },
  });
}

function unavailable(message: string, status: number): Response {
  return previewResponse(
    `<!doctype html><html><head></head><body><p style="margin:0;padding:8px 0;color:var(--muted-foreground)">Preview unavailable: ${escapeHtml(message)}</p></body></html>`,
    status,
  );
}

function failureStatus(error: Failure & { readonly code?: string }): number {
  switch (error.code) {
    case "forbidden":
      return 403;
    case "not-found":
      return 404;
    case "invalid":
      return 422;
    default:
      return 503;
  }
}

/**
 * Mirrors the output publisher's text parts, one entry per displayed message: a part ID names a
 * new message once its earlier part ended. A reset drops what the projection removes, which is the
 * previous attempt's messages or only its retried step's.
 */
export class HtmlPreviewReply {
  readonly #entries: { attemptId: string; stepId: string; text: string }[] = [];
  readonly #active = new Map<string, { attemptId: string; stepId: string; text: string }>();

  constructor(private attemptId: string) {}

  start(partId: string, stepId: string): void {
    if (this.#active.has(partId)) return;
    const entry = { attemptId: this.attemptId, stepId, text: "" };
    this.#entries.push(entry);
    this.#active.set(partId, entry);
  }

  append(partId: string, delta: string): void {
    const entry = this.#active.get(partId);
    if (entry) entry.text += delta;
  }

  end(partId: string): void {
    this.#active.delete(partId);
  }

  endStep(): void {
    this.#active.clear();
  }

  reset(nextAttemptId: string, stepId?: string): void {
    if (nextAttemptId === this.attemptId) return;
    const removed = (entry: { attemptId: string; stepId: string }) =>
      entry.attemptId === this.attemptId && (stepId === undefined || entry.stepId === stepId);
    const kept = this.#entries.filter((entry) => !removed(entry));
    this.#entries.splice(0, this.#entries.length, ...kept);
    this.#active.clear();
    this.attemptId = nextAttemptId;
  }

  texts(): string[] {
    return this.#entries.map((entry) => entry.text);
  }
}

export class NativeHtmlPreviews {
  constructor(
    private readonly dependencies: {
      store: Pick<
        NativeStore,
        "getThreadRecord" | "saveHtmlPreview" | "readHtmlPreview" | "publishUpload"
      >;
      files: Pick<NativeLiveFileService, "readThreadFile">;
      resources: Pick<NativeResourceService, "ingest" | "get" | "readBytes">;
    },
  ) {}

  /**
   * Stores a copy of each page a turn's reply previews, with its local assets inlined. A page
   * that cannot be read records why, and the preview route shows that reason instead.
   */
  async snapshot(input: { threadId: string; turnId: string; texts: readonly string[] }) {
    const paths = htmlPreviewPaths(input.texts);
    if (paths.length === 0) return;
    const starterId = this.dependencies.store
      .getThreadRecord(input.threadId)
      .match({ ok: (thread) => thread.starterId, err: () => undefined });
    if (starterId === undefined) return;
    for (const [index, path] of paths.entries()) {
      const captured =
        index < MAX_PREVIEWS_PER_TURN
          ? await this.capture(starterId, input.threadId, path)
          : Result.err(
              nativeFailure(
                "invalid",
                `Only ${MAX_PREVIEWS_PER_TURN} previews are saved per reply`,
              ),
            );
      const outcome = captured.match<{ uploadId: string } | { error: string }>({
        ok: (uploadId) => ({ uploadId }),
        err: (error) => ({ error: error.message.slice(0, 1024) }),
      });
      this.dependencies.store
        .saveHtmlPreview({ threadId: input.threadId, turnId: input.turnId, path, ...outcome })
        .match({ ok: () => undefined, err: () => undefined });
    }
  }

  private async capture(
    actorId: string,
    threadId: string,
    path: string,
  ): Promise<ResultType<string, Failure>> {
    return Result.gen(async function* () {
      const file = yield* Result.await(
        this.dependencies.files.readThreadFile(actorId, threadId, path),
      );
      const html = yield* Result.await(
        inlineHtmlPreviewAssets(decoder.decode(file.bytes), posix.dirname(file.path), (target) =>
          this.readAsset(actorId, threadId, target),
        ),
      );
      const bytes = encoder.encode(html);
      if (bytes.byteLength > MAX_PAGE_BYTES)
        return Result.err(nativeFailure("invalid", "The page is over 16 MiB with its assets"));
      const upload = yield* Result.await(
        this.dependencies.resources.ingest(actorId, threadId, {
          filename: basename(file.path),
          mediaType: "text/html",
          bytes,
        }),
      );
      yield* this.dependencies.store.publishUpload(actorId, upload.id);
      return Result.ok(upload.id);
    }, this);
  }

  private async readAsset(
    actorId: string,
    threadId: string,
    target: string,
  ): Promise<ResultType<Asset, Failure>> {
    if (target.startsWith("resource://"))
      return this.dependencies.resources.readBytes(actorId, target);
    const read = await this.dependencies.files.readThreadFile(actorId, threadId, target);
    return read.map((file) => ({ bytes: file.bytes, mediaType: file.mediaType }));
  }

  async handle(request: Request, actorId: string): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (url.pathname !== HTML_PREVIEW_ROUTE) return undefined;
    if (request.method !== "GET") return new Response(null, { status: 405 });
    const target = parseHtmlPreviewHref(url);
    if (!target) return unavailable("the preview link is invalid", 400);
    const page = await Result.gen(async function* () {
      const record = yield* this.dependencies.store.readHtmlPreview(actorId, target);
      if (record.uploadId === undefined)
        return Result.err(nativeFailure("invalid", record.error ?? "the page was not saved"));
      const upload = yield* this.dependencies.resources.get(actorId, record.uploadId);
      if (upload.state !== "ready" || !upload.resourceUri)
        return Result.err(nativeFailure("not-found", "the saved page is unavailable"));
      const file = yield* Result.await(
        this.dependencies.resources.readBytes(actorId, upload.resourceUri),
      );
      return Result.ok(decoder.decode(file.bytes));
    }, this);
    return page.match({
      ok: (html) => previewResponse(html),
      err: (error) => unavailable(error.message, failureStatus(error)),
    });
  }
}
