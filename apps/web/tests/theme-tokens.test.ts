import { expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTheme } from "../src/theme/resolve-theme";

const source = join(import.meta.dir, "../src");

test("every UI color role is available through the Tailwind bridge", () => {
  const bridge = readFileSync(join(source, "theme/tailwind.css"), "utf8");
  const aliases = new Set(
    [...bridge.matchAll(/--color-([\w-]+):\s*var\(--ui-[\w-]+\)/g)].map((match) => match[1]),
  );
  const roles = Object.keys(resolveTheme({ type: "dark" }).variables).filter(
    (role) => role !== "shadow-color",
  );
  expect(roles.filter((role) => !aliases.has(role === "input-border" ? "input" : role))).toEqual(
    [],
  );
});
const literalColor = /#[\da-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla|oklch|oklab)\([\d.]/i;
const paletteUtility =
  /\b(?:bg|text|border|ring|outline|fill|stroke|from|via|to|shadow)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d+)\b/;

test("component styles use semantic colors from the theme core", () => {
  const violations: string[] = [];
  for (const file of new Glob("**/*.{ts,tsx,css}").scanSync(source)) {
    if (file.startsWith("theme/") || file === "components/file-icon.css") continue;
    const contents = readFileSync(join(source, file), "utf8");
    for (const [index, line] of contents.split("\n").entries()) {
      if (literalColor.test(line) || paletteUtility.test(line))
        violations.push(`${file}:${index + 1}`);
    }
  }
  expect(violations).toEqual([]);
});
