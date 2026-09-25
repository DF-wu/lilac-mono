import { Result } from "better-result";
import type { CSSProperties } from "react";
import { z } from "zod";
import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { cachedThemePair, loadThemePair, themeIds, type ThemeId } from "./catalog";
import type { ResolvedTheme, ThemeKind } from "./resolve-theme";

export type ThemeMode = "light" | "dark" | "system";
export type ThemeSelection = Record<ThemeKind, ThemeId>;
const selectionKey = "lilac-theme-palette-v1";
const selectionSchema = z.object({ light: z.enum(themeIds), dark: z.enum(themeIds) });
const lilac = cachedThemePair("lilac")!;
const defaultSelection: ThemeSelection = { light: "lilac", dark: "lilac" };
let mode: ThemeMode = "system";
const themeStore = createStore(() => ({
  selection: defaultSelection,
  themes: lilac,
  syntax: lilac.dark.syntax,
}));

export function useSyntaxTheme() {
  return useStore(themeStore, (state) => state.syntax);
}

export function useThemeSelection() {
  return useStore(themeStore, (state) => state.selection);
}

export function useInstalledThemes() {
  return useStore(themeStore, (state) => state.themes);
}

export function themeStyle(theme: ResolvedTheme): CSSProperties {
  return Object.fromEntries(
    Object.entries(theme.variables).map(([name, value]) => [`--ui-${name}`, value]),
  );
}

export function setThemeMode(value: string) {
  mode = value === "light" || value === "dark" ? value : "system";
  applyTheme();
}

export function installThemes(pair: { light: ResolvedTheme; dark: ResolvedTheme }) {
  themeStore.setState({ themes: pair });
  applyTheme();
}

export async function selectTheme(id: ThemeId, kinds: readonly ThemeKind[]) {
  const current = themeStore.getState().selection;
  const selection: ThemeSelection = {
    light: kinds.includes("light") ? id : current.light,
    dark: kinds.includes("dark") ? id : current.dark,
  };
  themeStore.setState({ selection });
  const saved = Result.try({
    try: () => localStorage.setItem(selectionKey, JSON.stringify(selection)),
    catch: () => "Storage unavailable",
  });
  saved.match({ ok: () => {}, err: () => {} });
  await applySelection(selection);
}

async function applySelection(selection: ThemeSelection) {
  const [light, dark] = await Promise.all([
    loadThemePair(selection.light),
    loadThemePair(selection.dark),
  ]);
  if (themeStore.getState().selection !== selection) return;
  const pair = Result.all([light, dark]).match({
    ok: ([lightPair, darkPair]) => ({ light: lightPair.light, dark: darkPair.dark }),
    err: () => undefined,
  });
  if (pair) installThemes(pair);
}

function effectiveKind(): ThemeKind {
  if (mode !== "system") return mode;
  return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function applyTheme() {
  const kind = effectiveKind();
  const theme = themeStore.getState().themes[kind];
  const root = document.documentElement;
  root.dataset.theme = mode;
  root.style.colorScheme = kind;
  for (const [name, value] of Object.entries(theme.variables))
    root.style.setProperty(`--ui-${name}`, value);
  if (themeStore.getState().syntax !== theme.syntax) themeStore.setState({ syntax: theme.syntax });
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

export function decodeThemeSelection(raw: string | null): ThemeSelection {
  if (raw === null) return defaultSelection;
  return Result.try({ try: () => JSON.parse(raw), catch: () => "Invalid theme selection" }).match({
    ok: (value) => {
      const parsed = selectionSchema.safeParse(value);
      return parsed.success ? parsed.data : defaultSelection;
    },
    err: () => defaultSelection,
  });
}

function readSelection(): ThemeSelection {
  return Result.try({
    try: () => localStorage.getItem(selectionKey),
    catch: () => "Storage unavailable",
  }).match({
    ok: decodeThemeSelection,
    err: () => defaultSelection,
  });
}

export function watchSystemTheme() {
  mode = readTheme();
  const media = matchMedia("(prefers-color-scheme: light)");
  media.addEventListener("change", applyTheme);
  applyTheme();
  return () => media.removeEventListener("change", applyTheme);
}

export function loadSavedTheme() {
  const selection = readSelection();
  themeStore.setState({ selection });
  return applySelection(selection);
}
