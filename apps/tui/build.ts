import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import solid from "@opentui/solid/bun-plugin";

const targets = {
  "linux-x64": "bun-linux-x64-baseline",
  "linux-arm64": "bun-linux-arm64",
  "darwin-x64": "bun-darwin-x64-baseline",
  "darwin-arm64": "bun-darwin-arm64",
} satisfies Record<string, Bun.Build.CompileTarget>;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    target: { type: "string", default: `${process.platform}-${process.arch}` },
    outdir: { type: "string", default: resolve(import.meta.dir, "dist") },
  },
  strict: true,
});
const targetEntry = Object.entries(targets).find(([name]) => name === values.target);
if (!targetEntry) {
  console.error(`Unsupported target ${values.target}. Choose ${Object.keys(targets).join(", ")}.`);
  process.exit(1);
}

const version = process.env.LILAC_TUI_VERSION ?? "dev";
const defines = {
  "process.env.LILAC_TUI_VERSION": JSON.stringify(version),
  "process.env.OPENTUI_LIBC": JSON.stringify("glibc"),
};

await mkdir(values.outdir, { recursive: true });
const output = await Bun.build({
  entrypoints: [resolve(import.meta.dir, "src/main.ts")],
  target: "bun",
  minify: true,
  plugins: [solid],
  define: defines,
  compile: {
    target: targetEntry[1],
    outfile: resolve(values.outdir, `lilac-tui-${targetEntry[0]}`),
    autoloadDotenv: false,
    autoloadBunfig: false,
    autoloadTsconfig: false,
    autoloadPackageJson: false,
  },
});
if (!output.success) {
  for (const log of output.logs) console.error(String(log));
  process.exit(1);
}

console.info(`Built lilac-tui-${targetEntry[0]} (${version}).`);
