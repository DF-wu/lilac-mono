import { Result } from "better-result";

export function threadIdFromUrl(url: URL): string | undefined {
  const match = /^\/threads\/([^/]+)\/?$/.exec(url.pathname);
  if (match)
    return Result.try({
      try: () => decodeURIComponent(match[1]!),
      catch: () => "Invalid thread path",
    }).match({ ok: (id) => id, err: () => undefined });
  if (url.pathname === "/") return url.searchParams.get("thread") || undefined;
  return undefined;
}
