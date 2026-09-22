import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

export function serviceWorkerBuild(): Plugin {
  const template = readFileSync(new URL("./public/sw.js", import.meta.url), "utf8");
  return {
    name: "lilac-service-worker",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const html = bundle["index.html"];
      if (!html || html.type !== "asset") return;
      const source =
        typeof html.source === "string" ? html.source : new TextDecoder().decode(html.source);
      const assets = Object.keys(bundle)
        .filter((name) => name.startsWith("assets/"))
        .sort();
      const initial = new Set(
        [...source.matchAll(/(?:src|href)="\/(assets\/[^"?]+)"/g)].map((match) => match[1]!),
      );
      const visit = (name: string) => {
        const chunk = bundle[name];
        if (!chunk || chunk.type !== "chunk") return;
        for (const dependency of chunk.imports) {
          if (initial.has(dependency)) continue;
          initial.add(dependency);
          visit(dependency);
        }
      };
      for (const entry of initial) visit(entry);
      const buildId = createHash("sha256")
        .update(source)
        .update(template)
        .update(assets.join("\n"))
        .digest("hex")
        .slice(0, 20);
      html.source = source.replace(
        "<head>",
        `<head>\n    <meta name="lilac-build" content="${buildId}" />`,
      );
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: template
          .replaceAll("__BUILD_ID__", buildId)
          .replace('"__ASSET_PATHS__"', JSON.stringify(assets.map((name) => `/${name}`)))
          .replace(
            '"__PRECACHE_PATHS__"',
            JSON.stringify(["/", ...[...initial].sort().map((name) => `/${name}`)]),
          ),
      });
    },
  };
}
