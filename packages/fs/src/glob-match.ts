import { matchesGlob, normalize } from "node:path";

const SEGMENT_PREFIX = "\u0001";

// Prefixing segments leaves their characters intact, including negated classes and ranges.
function prefixSegments(value: string, pattern: boolean): string {
  return normalize(value).replace(/[^/]+/gu, (segment) =>
    pattern && segment === "**" ? segment : `${SEGMENT_PREFIX}${segment}`,
  );
}

function braceAlternatives(pattern: string): string[] {
  const braces: Array<{ start: number; commas: number[] }> = [];
  let inClass = false;
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "\\") {
      index++;
      continue;
    }
    if (character === "[") inClass = true;
    if (character === "]") inClass = false;
    if (inClass) continue;
    if (character === "{") {
      braces.push({ start: index, commas: [] });
      continue;
    }
    if (character === ",") {
      braces.at(-1)?.commas.push(index);
      continue;
    }
    if (character !== "}") continue;
    const brace = braces.pop();
    if (!brace || brace.commas.length === 0) continue;
    const boundaries = [brace.start, ...brace.commas, index];
    return boundaries
      .slice(1)
      .flatMap((end, alternative) =>
        braceAlternatives(
          pattern.slice(0, brace.start) +
            pattern.slice(boundaries[alternative]! + 1, end) +
            pattern.slice(index + 1),
        ),
      );
  }
  return [pattern];
}

/** Like path.matchesGlob, with wildcard matching enabled for dot-prefixed segments. */
export function matchesGlobWithDotfiles(path: string, pattern: string): boolean {
  const candidate = prefixSegments(path, false);
  return braceAlternatives(pattern).some((alternative) =>
    matchesGlob(candidate, prefixSegments(alternative, true)),
  );
}
