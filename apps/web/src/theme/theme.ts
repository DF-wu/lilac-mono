import { Result } from "better-result";
import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { builtinThemes } from "./builtin";
import { resolveTheme, type ResolvedTheme, type ThemeKind } from "./resolve-theme";

export type ThemeMode = "light" | "dark" | "system";
let themes: Record<ThemeKind, ResolvedTheme> = {
  light: resolveTheme(builtinThemes.light),
  dark: resolveTheme(builtinThemes.dark),
};
let mode: ThemeMode = "system";
const syntaxStore = createStore(() => ({ syntax: themes.dark.syntax }));

export function useSyntaxTheme() {
  return useStore(syntaxStore, (state) => state.syntax);
}

export function setThemeMode(value: string) {
  mode = value === "light" || value === "dark" ? value : "system";
  applyTheme();
}

export function installThemes(pair: { light: ResolvedTheme; dark: ResolvedTheme }) {
  themes = pair;
  applyTheme();
}

function effectiveKind(): ThemeKind {
  if (mode !== "system") return mode;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme() {
  const kind = effectiveKind();
  const theme = themes[kind];
  const root = document.documentElement;
  root.dataset.theme = mode;
  root.style.colorScheme = kind;
  for (const [name, value] of Object.entries(theme.variables))
    root.style.setProperty(`--ui-${name}`, value);
  if (syntaxStore.getState().syntax !== theme.syntax)
    syntaxStore.setState({ syntax: theme.syntax });
}

export function readTheme(): ThemeMode {
  return Result.try({
    try: () => localStorage.getItem("lilac-theme-v1"),
    catch: () => "Storage unavailable",
  }).match({
    ok: (value) => (value === "light" || value === "dark" ? value : "system"),
    err: () => "system",
  });
}

export function watchSystemTheme() {
  mode = readTheme();
  const media = matchMedia("(prefers-color-scheme: light)");
  media.addEventListener("change", applyTheme);
  applyTheme();
  return () => media.removeEventListener("change", applyTheme);
}
