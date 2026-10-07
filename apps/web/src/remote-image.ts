export function remoteImageUrl(href: string): string {
  if (!URL.canParse(href)) return href;
  const url = new URL(href);
  if (url.protocol !== "http:" && url.protocol !== "https:") return href;
  if (typeof location !== "undefined" && url.origin === location.origin) return href;
  return `/api/remote-image?url=${encodeURIComponent(href)}`;
}
