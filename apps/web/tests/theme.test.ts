import { expect, test } from "bun:test";
import type { ThemeRegistration } from "shiki/core";
import githubLight from "shiki/themes/github-light.mjs";
import githubDark from "shiki/themes/github-dark.mjs";
import { resolveTheme } from "../src/theme/resolve-theme";
import { builtinThemes } from "../src/theme/builtin";
import { highlightCode } from "../src/components/rich-code";

test("VS Code roles preserve distinct control pairs, alpha and explicit transparency", () => {
  const theme = resolveTheme({
    type: "light",
    colors: {
      "editor.background": "#abcdef",
      "editor.foreground": "#123456",
      "sideBar.background": "#ffffff",
      "sideBar.foreground": "#000000",
      "button.background": "#123",
      "button.foreground": "#fff",
      "textLink.foreground": "#456",
      "textLink.activeForeground": "#789",
      "input.background": "#0000",
      "input.foreground": "#345",
      "list.activeSelectionBackground": "#10203040",
      "list.activeSelectionForeground": "#def",
      "menu.background": "#abc",
      "menu.foreground": "#456",
    },
  });
  expect(theme.variables.primary).toBe("#123");
  expect(theme.variables["primary-foreground"]).toBe("#fff");
  expect(theme.variables.link).toBe("#456");
  expect(theme.variables["input-background"]).toBe("#0000");
  expect(theme.variables["input-foreground"]).toBe("#345");
  expect(theme.variables.selection).toBe("#10203040");
  expect(theme.variables["selection-foreground"]).toBe("#def");
  expect(theme.variables.menu).toBe("#abc");
  expect(theme.variables["menu-foreground"]).toBe("#456");
});

test("sparse themes have complete fallbacks and invalid UI color values cannot become CSS", () => {
  const sparse = resolveTheme({
    type: "dark",
    colors: { "editor.background": "url(https://invalid.example)", "sideBar.background": "#12345" },
  });
  expect(sparse.variables.background).toBe(builtinThemes.dark.colors["editor.background"]);
  expect(sparse.variables.sidebar).toBe(sparse.variables.background);
  expect(Object.values(sparse.variables).every((value) => value.length > 0)).toBe(true);
  expect(JSON.stringify(sparse.variables)).not.toContain("invalid.example");
  expect(resolveTheme({ type: "light" }).variables.background).toBe(
    builtinThemes.light.colors["editor.background"],
  );
});

test("ordinary VS Code themes supply both UI and TextMate colors without manual mapping", async () => {
  for (const input of [githubLight, githubDark]) {
    const theme = resolveTheme(input);
    expect(theme.variables.background).toBe(input.colors?.["editor.background"] ?? "");
    expect(theme.syntax?.tokenColors).toBe(input.tokenColors);
    const tokens = await highlightCode('const value = "hello";', "typescript", theme.syntax);
    expect(tokens.flat().some((token) => /^#/.test(token.color ?? ""))).toBe(true);
  }
});

test("syntax cache separates theme objects even when names match and preserves token styles", async () => {
  const source = "const value = 1;";
  const makeTheme = (foreground: string): ThemeRegistration => ({
    name: "same-name",
    type: "dark",
    colors: { "editor.background": "#000000", "editor.foreground": "#ffffff" },
    tokenColors: [{ scope: "keyword", settings: { foreground, fontStyle: "italic" } }],
  });
  const first = makeTheme("#ff0000"),
    second = makeTheme("#00ff00");
  const a = await highlightCode(source, "typescript", first);
  const b = await highlightCode(source, "typescript", second);
  expect(a.flat().some((token) => token.color === "#FF0000" && token.fontStyle === 1)).toBe(true);
  expect(b.flat().some((token) => token.color === "#00FF00" && token.fontStyle === 1)).toBe(true);
  expect(await highlightCode(source, "typescript", first)).toBe(a);
});

test("JSON theme metadata accepts explicit kind and general foreground fallback", () => {
  const input = { type: "light", colors: { foreground: "#123456" } };
  expect(resolveTheme(input).kind).toBe("light");
  expect(resolveTheme(input).variables.foreground).toBe("#123456");
  expect(resolveTheme(input, "dark").kind).toBe("dark");
});

test("contrast borders and explicit kind work for a sparse registered theme", () => {
  const theme = resolveTheme(
    { colors: { contrastBorder: "#ffff00", "widget.border": "#ff0000" } },
    "light",
  );
  expect(theme.variables.border).toBe("#ffff00");
  expect(theme.variables["input-border"]).toBe("#ffff00");
  expect(theme.variables.background).toBe(builtinThemes.light.colors["editor.background"]);
});

test("menu highlights derive from the menu pair without colliding with its surface", () => {
  for (const theme of Object.values(builtinThemes)) {
    const { variables } = resolveTheme(theme);
    expect(variables["menu-selection"]).not.toBe(variables.menu);
    expect(variables["menu-selection"]).toBe(
      `color-mix(in srgb, ${variables["menu-foreground"]} 12%, ${variables.menu})`,
    );
    expect(variables["menu-selection-foreground"]).toBe(variables["menu-foreground"]);
  }
  const { variables } = resolveTheme({
    colors: {
      "menu.background": "#123456",
      "menu.foreground": "#ffffff",
      "menu.selectionBackground": "#fedcba",
      "menu.selectionForeground": "#000000",
    },
  });
  expect(variables["menu-selection"]).toBe("#fedcba");
  expect(variables["menu-selection-foreground"]).toBe("#000000");
});
