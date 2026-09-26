import { lookup } from "node:dns/promises";
import { get as getHttp } from "node:http";
import { get as getHttps } from "node:https";
import { BlockList, isIP } from "node:net";
import metascraper from "metascraper";
import metascraperTitle from "metascraper-title";
import metascraperDescription from "metascraper-description";
import metascraperImage from "metascraper-image";
import metascraperLogo from "metascraper-logo";
import { Result, TaggedError } from "better-result";
import type { NativeRpcOutputs } from "@stanley2058/lilac-client-protocol";

export type LinkPreview = NativeRpcOutputs["links"]["preview"];
class LinkPreviewFailure extends TaggedError("LinkPreviewFailure")<{ message: string }> {}
const unavailable = () => new LinkPreviewFailure({ message: "Link preview unavailable" });
const MAX_BYTES = 1_048_576;
const excluded = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const)
  excluded.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
excluded.addSubnet("2001::", 23, "ipv6");
excluded.addSubnet("2001:db8::", 32, "ipv6");
excluded.addSubnet("2002::", 16, "ipv6");
excluded.addSubnet("3fff::", 20, "ipv6");

export function isPublicLinkAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !excluded.check(address, "ipv4");
  if (family === 6) return globalV6.check(address, "ipv6") && !excluded.check(address, "ipv6");
  return false;
}

export function linkPreviewUrl(value: string, base?: string): URL | undefined {
  if (!URL.canParse(value, base)) return undefined;
  const url = new URL(value, base);
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username || url.password || url.href.length > 8192) return undefined;
  url.hash = "";
  return url;
}

function cleanText(value: string | null | undefined, limit: number): string | undefined {
  return value?.replace(/\s+/gu, " ").trim().slice(0, limit) || undefined;
}

const scrape = metascraper([
  metascraperTitle(),
  metascraperDescription(),
  metascraperImage(),
  metascraperLogo(),
  {
    // The favicon plugin probes URLs itself; keep all network access in the guarded fetcher.
    icon: ({ htmlDom, url }) => {
      const base =
        linkPreviewUrl(htmlDom("base[href]").first().attr("href") ?? "", url)?.href ?? url;
      for (const selector of ['link[rel~="icon" i]', 'link[rel="apple-touch-icon" i]']) {
        for (const element of htmlDom(selector).toArray()) {
          const href = htmlDom(element).attr("href");
          const icon = href ? linkPreviewUrl(href, base) : undefined;
          if (icon) return icon.href;
        }
      }
      return undefined;
    },
  },
]);

export async function parseLinkPreview(html: string, href: string): Promise<LinkPreview> {
  const metadata = await scrape({ html, url: href });
  return {
    title: cleanText(metadata.title, 512),
    description: cleanText(metadata.description, 2048),
    image: metadata.image ? linkPreviewUrl(metadata.image, href)?.href : undefined,
    icon: linkPreviewUrl(metadata.icon ?? metadata.logo ?? "/favicon.ico", href)?.href,
  };
}

type PageReply = { html: string; location?: string };
function requestPublicPage(
  url: URL,
  address: { address: string; family: number },
  signal: AbortSignal,
): Promise<Result<PageReply, LinkPreviewFailure>> {
  return new Promise((resolve) => {
    const started = Result.try({
      try: () => {
        const get = url.protocol === "https:" ? getHttps : getHttp;
        // Pin the checked IP so DNS cannot rebind between validation and connection.
        return get(
          {
            protocol: url.protocol,
            hostname: address.address,
            family: address.family,
            port: url.port || undefined,
            path: `${url.pathname}${url.search}`,
            servername: url.hostname.replace(/^\[|\]$/gu, ""),
            headers: {
              host: url.host,
              accept: "text/html, application/xhtml+xml",
              "accept-encoding": "identity",
            },
            agent: false,
            signal,
          },
          (response) => {
            const status = response.statusCode ?? 0;
            if ([301, 302, 303, 307, 308].includes(status)) {
              resolve(Result.ok({ html: "", location: response.headers.location }));
              response.destroy();
              return;
            }
            const contentType = response.headers["content-type"]
              ?.split(";", 1)[0]
              ?.trim()
              .toLowerCase();
            if (
              status < 200 ||
              status >= 300 ||
              (contentType !== "text/html" && contentType !== "application/xhtml+xml")
            ) {
              resolve(Result.err(unavailable()));
              response.destroy();
              return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on("data", (chunk: Buffer) => {
              const remaining = MAX_BYTES - bytes;
              if (remaining <= 0) return;
              chunks.push(chunk.subarray(0, remaining));
              bytes += chunk.length;
              if (bytes >= MAX_BYTES) {
                resolve(Result.ok({ html: Buffer.concat(chunks).toString("utf8") }));
                response.destroy();
              }
            });
            response.on("end", () =>
              resolve(Result.ok({ html: Buffer.concat(chunks).toString("utf8") })),
            );
            response.on("error", () => resolve(Result.err(unavailable())));
            response.on("aborted", () => resolve(Result.err(unavailable())));
          },
        );
      },
      catch: unavailable,
    });
    if (started.isErr()) {
      resolve(started);
      return;
    }
    started.value.on("error", () => resolve(Result.err(unavailable())));
  });
}

export async function readPublicPage(url: URL, signal: AbortSignal) {
  return Result.gen(async function* () {
    if (signal.aborted) return Result.err(unavailable());
    const hostname = url.hostname.replace(/^\[|\]$/gu, "");
    const addresses = yield* Result.await(
      Result.tryPromise({
        try: () =>
          Promise.race([
            lookup(hostname, { all: true }),
            new Promise<undefined>((resolve) => {
              signal.addEventListener("abort", () => resolve(undefined), { once: true });
            }),
          ]),
        catch: unavailable,
      }),
    );
    if (!addresses?.length || addresses.some(({ address }) => !isPublicLinkAddress(address)))
      return Result.err(unavailable());
    const page = yield* Result.await(requestPublicPage(url, addresses[0]!, signal));
    return Result.ok(page);
  });
}

export async function resolveLinkPreview(
  href: string,
  signal?: AbortSignal,
  readPage = readPublicPage,
): Promise<LinkPreview> {
  let url = linkPreviewUrl(href);
  if (!url) return {};
  const timeout = AbortSignal.timeout(5000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const page = await readPage(url, deadline);
    const reply = page.match({ ok: (value) => value, err: () => undefined });
    if (!reply) return {};
    if (reply.location) {
      url = linkPreviewUrl(reply.location, url.href);
      if (!url) return {};
      continue;
    }
    const pageUrl = url.href;
    const parsed = await Result.tryPromise({
      try: () => parseLinkPreview(reply.html, pageUrl),
      catch: unavailable,
    });
    return parsed.match({ ok: (value) => value, err: () => ({}) });
  }
  return {};
}
