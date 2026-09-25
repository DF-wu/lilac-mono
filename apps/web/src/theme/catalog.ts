import { Result } from "better-result";
import { builtinThemes } from "./builtin";
import { resolveTheme, type ResolvedTheme, type ThemeDefinition } from "./resolve-theme";

type ThemeSource = { light: ThemeDefinition; dark: ThemeDefinition };
export type ResolvedThemePair = { light: ResolvedTheme; dark: ResolvedTheme };

async function importPair(
  light: Promise<{ default: ThemeDefinition }>,
  dark: Promise<{ default: ThemeDefinition }>,
): Promise<ThemeSource> {
  const [lightModule, darkModule] = await Promise.all([light, dark]);
  return { light: lightModule.default, dark: darkModule.default };
}

// Third-party palettes load on demand so the default theme adds nothing to the shell bundle.
export const themeCatalog = [
  { id: "lilac", name: "Lilac", load: async (): Promise<ThemeSource> => builtinThemes },
  {
    id: "catppuccin",
    name: "Catppuccin",
    load: () =>
      importPair(
        import("shiki/themes/catppuccin-latte.mjs"),
        import("shiki/themes/catppuccin-mocha.mjs"),
      ),
  },
  {
    id: "github",
    name: "GitHub",
    load: () =>
      importPair(
        import("shiki/themes/github-light-default.mjs"),
        import("shiki/themes/github-dark-default.mjs"),
      ),
  },
] as const;
export type ThemeId = (typeof themeCatalog)[number]["id"];
export const themeIds = themeCatalog.map((entry) => entry.id) as [ThemeId, ...ThemeId[]];

const resolved = new Map<ThemeId, ResolvedThemePair>([
  ["lilac", { light: resolveTheme(builtinThemes.light), dark: resolveTheme(builtinThemes.dark) }],
]);
const pending = new Map<ThemeId, Promise<Result<ResolvedThemePair, string>>>();

export function cachedThemePair(id: ThemeId) {
  return resolved.get(id);
}

export function loadThemePair(id: ThemeId): Promise<Result<ResolvedThemePair, string>> {
  const cached = resolved.get(id);
  if (cached) return Promise.resolve(Result.ok(cached));
  const existing = pending.get(id);
  if (existing) return existing;
  const entry = themeCatalog.find((candidate) => candidate.id === id)!;
  const task = Result.tryPromise({
    try: entry.load,
    catch: () => "Could not load the theme",
  }).then((result) => {
    pending.delete(id);
    return result.map((source) => {
      const pair = {
        light: resolveTheme(source.light, "light"),
        dark: resolveTheme(source.dark, "dark"),
      };
      resolved.set(id, pair);
      return pair;
    });
  });
  pending.set(id, task);
  return task;
}
