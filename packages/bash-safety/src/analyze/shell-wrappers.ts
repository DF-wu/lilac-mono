export function extractDashCArg(tokens: readonly string[]): string | null {
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;

    if (token === "--") return null;

    if (token === "-c" && tokens[i + 1]) {
      return tokens[i + 1] === "--" ? (tokens[i + 2] ?? null) : (tokens[i + 1] ?? null);
    }

    if (token.startsWith("-") && token.includes("c") && !token.startsWith("--")) {
      const nextToken = tokens[i + 1];
      if (nextToken === "--") return tokens[i + 2] ?? null;
      if (nextToken) return nextToken;
    }
  }

  return null;
}

export function extractWatchCommand(tokens: readonly string[]): string[] | null {
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token) return null;
    if (token === "--") return tokens.slice(i + 1);
    if (!token.startsWith("-") || token === "-") return tokens.slice(i);
    if (token === "-h" || token === "-v") {
      return null;
    }
    if (token.startsWith("--")) {
      const option = resolveWatchLongOption(token);
      if (!option) {
        i++;
        continue;
      }
      if (option.terminates) return null;
      if (option.takesValue && !token.includes("=")) {
        if (!tokens[i + 1]) return null;
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (token === "-n" || token === "-q" || token === "-s") {
      if (!tokens[i + 1]) return null;
      i += 2;
      continue;
    }
    const consumesNext = watchShortOptionConsumesNext(token);
    if (consumesNext) {
      if (!tokens[i + 1]) return null;
      i += 2;
      continue;
    }
    i++;
  }
  return null;
}

function resolveWatchLongOption(token: string): WatchLongOption | null {
  const name = token.split("=", 1)[0] ?? token;
  const exact = WATCH_LONG_OPTIONS.find((option) => option.name === name);
  if (exact) return exact;
  const matches = WATCH_LONG_OPTIONS.filter((option) => option.name.startsWith(name));
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

function watchShortOptionConsumesNext(token: string): boolean {
  const options = token.slice(1);
  for (let i = 0; i < options.length; i++) {
    const option = options[i];
    if (option === "d") return false;
    if (option === "n" || option === "q" || option === "s") {
      return i === options.length - 1;
    }
  }
  return false;
}
interface WatchLongOption {
  readonly name: string;
  readonly takesValue?: boolean;
  readonly terminates?: boolean;
}

const WATCH_LONG_OPTIONS: readonly WatchLongOption[] = [
  { name: "--beep" },
  { name: "--color" },
  { name: "--no-color" },
  { name: "--differences" },
  { name: "--errexit" },
  { name: "--follow" },
  { name: "--chgexit" },
  { name: "--equexit", takesValue: true },
  { name: "--interval", takesValue: true },
  { name: "--precise" },
  { name: "--no-rerun" },
  { name: "--shotsdir", takesValue: true },
  { name: "--no-title" },
  { name: "--no-wrap" },
  { name: "--exec" },
  { name: "--help", terminates: true },
  { name: "--version", terminates: true },
];
