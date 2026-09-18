export function markdownUrl(url: string): string {
  const clean = url.trim();
  if (
    [...clean].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)
  )
    return "";
  if (clean.startsWith("//") || clean.includes("\\")) return "";
  if (/^(?:https?:|mailto:)/iu.test(clean)) return clean;
  if (/^[a-z][a-z\d+.-]*:/iu.test(clean)) return "";
  return clean;
}

export function diagramSourceAllowed(source: string): boolean {
  return source.length <= 32 * 1024 && !/%%\s*\{/u.test(source) && !/^\s*---/u.test(source);
}
