import { lookup } from "node:dns/promises";
import { get as getHttp } from "node:http";
import { get as getHttps } from "node:https";
import { BlockList, isIP } from "node:net";
import { Result, TaggedError } from "better-result";

export class PublicResourceFailure extends TaggedError("PublicResourceFailure")<{
  message: string;
}> {}
const unavailable = () => new PublicResourceFailure({ message: "Remote resource unavailable" });
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

export type PublicResourceReply = { bytes: Buffer; mediaType: string; location?: string };
export type PublicResourceKind = "page" | "image";
const imageTypes = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/bmp",
]);
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_PAGE_BYTES = 1_048_576;
export function requestPublicResource(
  url: URL,
  address: { address: string; family: number },
  signal: AbortSignal,
  kind: PublicResourceKind,
): Promise<Result<PublicResourceReply, PublicResourceFailure>> {
  const maxBytes = kind === "image" ? MAX_IMAGE_BYTES : MAX_PAGE_BYTES;
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
              accept:
                kind === "image" ? [...imageTypes].join(", ") : "text/html, application/xhtml+xml",
              "accept-encoding": "identity",
            },
            agent: false,
            signal,
          },
          (response) => {
            const status = response.statusCode ?? 0;
            if ([301, 302, 303, 307, 308].includes(status)) {
              const location = response.headers.location;
              resolve(
                location
                  ? Result.ok({ bytes: Buffer.alloc(0), mediaType: "", location })
                  : Result.err(unavailable()),
              );
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
              !contentType ||
              !(kind === "image"
                ? imageTypes.has(contentType)
                : ["text/html", "application/xhtml+xml"].includes(contentType))
            ) {
              resolve(Result.err(unavailable()));
              response.destroy();
              return;
            }
            if (kind === "image" && Number(response.headers["content-length"]) > maxBytes) {
              resolve(Result.err(unavailable()));
              response.destroy();
              return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on("data", (chunk: Buffer) => {
              if (kind === "image" && bytes + chunk.length > maxBytes) {
                resolve(Result.err(unavailable()));
                response.destroy();
                return;
              }
              const remaining = maxBytes - bytes;
              if (remaining <= 0) return;
              chunks.push(chunk.subarray(0, remaining));
              bytes += chunk.length;
              if (kind === "page" && bytes >= maxBytes) {
                resolve(Result.ok({ bytes: Buffer.concat(chunks), mediaType: contentType }));
                response.destroy();
              }
            });
            response.on("end", () =>
              resolve(Result.ok({ bytes: Buffer.concat(chunks), mediaType: contentType })),
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

export async function readPublicResource(url: URL, signal: AbortSignal, kind: PublicResourceKind) {
  return Result.gen(async function* () {
    if (signal.aborted) return Result.err(unavailable());
    const hostname = url.hostname.replace(/^\[|\]$/gu, "");
    let cancelLookup = () => {};
    const addressesResult = await Result.tryPromise({
      try: () =>
        Promise.race([
          lookup(hostname, { all: true }),
          new Promise<undefined>((resolve) => {
            cancelLookup = () => resolve(undefined);
            signal.addEventListener("abort", cancelLookup, { once: true });
            if (signal.aborted) cancelLookup();
          }),
        ]),
      catch: unavailable,
    });
    signal.removeEventListener("abort", cancelLookup);
    const addresses = yield* addressesResult;
    if (!addresses?.length || addresses.some(({ address }) => !isPublicLinkAddress(address)))
      return Result.err(unavailable());
    const page = yield* Result.await(requestPublicResource(url, addresses[0]!, signal, kind));
    return Result.ok(page);
  });
}
