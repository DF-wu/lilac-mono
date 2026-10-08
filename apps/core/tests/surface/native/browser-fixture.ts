import type { NativeRuntimeOptions } from "../../../src/surface/native/runtime";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { MockLanguageModelV4 } from "ai/test";
import { createNativeIntegrationFixture, nativeFixtureTextResponse } from "./integration-fixture";
import { seedNativeBrowserFixture } from "./browser-seed";

const HTML_PREVIEW_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#8b5cf6" stroke-width="2" stroke-linecap="round"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>';

// A CDN chart library, a local image the snapshot inlines, and the theme variables.
const HTML_PREVIEW_PAGE = `<!doctype html>
<html>
  <head>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
    <style>
      header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
      header img { width: 20px; height: 20px; }
      h4 { margin: 0; font-weight: 600; }
      .stats { display: flex; gap: 12px; margin-top: 12px; }
      .stat { flex: 1; padding: 12px 16px; border: 1px solid var(--border); border-radius: var(--radius); }
      .stat b { display: block; font-size: 18px; }
      .stat span { color: var(--muted-foreground); font-size: 12px; }
    </style>
  </head>
  <body>
    <header><img src="./runner.svg" alt="" /><h4>Runs this week</h4></header>
    <div style="height: 220px"><canvas id="runs"></canvas></div>
    <div class="stats">
      <div class="stat"><b>312</b><span>Total runs</span></div>
      <div class="stat" style="color: var(--success)"><b>97.4%</b><span>Succeeded</span></div>
      <div class="stat"><b>81</b><span>Busiest day</span></div>
    </div>
    <script>
      const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      const chart = new Chart(document.getElementById("runs"), {
        type: "bar",
        data: {
          labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
          datasets: [{ data: [42, 68, 55, 81, 34, 18, 14], borderRadius: 6 }],
        },
        options: { maintainAspectRatio: false, plugins: { legend: { display: false } } },
      });
      function paint() {
        chart.data.datasets[0].backgroundColor = css("--chart-1");
        chart.options.scales.x.ticks.color = css("--muted-foreground");
        chart.options.scales.y.ticks.color = css("--muted-foreground");
        chart.options.scales.x.grid.color = "transparent";
        chart.options.scales.y.grid.color = css("--border");
        chart.update();
      }
      paint();
      new MutationObserver(paint).observe(document.getElementById("lilac-theme"), {
        childList: true,
        characterData: true,
        subtree: true,
      });
    </script>
  </body>
</html>
`;

export async function startNativeBrowserFixture(mcpRegistry?: NativeRuntimeOptions["mcpRegistry"]) {
  let threads: ReturnType<typeof seedNativeBrowserFixture> | undefined;
  const fixture = await createNativeIntegrationFixture({
    mcpRegistry,
    // Prompts that mention an HTML preview get a reply with a saved chart page.
    model: new MockLanguageModelV4({
      modelId: "native-fixture",
      doStream: async ({ prompt }) =>
        nativeFixtureTextResponse(
          /html preview/iu.test(JSON.stringify(prompt.findLast((item) => item.role === "user")))
            ? "Here is this week's run summary.\n\n```html-preview-file\nhtml-preview/weekly-runs.html\n```\n\nThursday had the most runs."
            : "Fixture response.\n\nReady for the next message.",
        ),
    }),
    port: 8789,
    password: process.env.TEST_NATIVE_PASSWORD ?? "native-fixture-password",
    allowedOrigins: [
      "http://127.0.0.1:8789",
      "http://localhost:8789",
      "http://127.0.0.1:5173",
      "http://localhost:5173",
    ],
    additionalLocalUsers: [
      {
        userId: "participant",
        username: "participant",
        password: "native-participant-password",
        sessionLifetimeSeconds: 60,
      },
    ],
    seed(store, transcript) {
      threads = seedNativeBrowserFixture(store, { transcript });
    },
    async prepare({ workspaceRoot, dataDir, config }) {
      await mkdir(path.join(workspaceRoot, "html-preview"), { recursive: true });
      await writeFile(path.join(workspaceRoot, "html-preview", "runner.svg"), HTML_PREVIEW_ICON);
      await writeFile(
        path.join(workspaceRoot, "html-preview", "weekly-runs.html"),
        HTML_PREVIEW_PAGE,
      );
      await writeFile(
        path.join(workspaceRoot, "example.md"),
        "# File viewer\n\n> [!NOTE]\n> Preview uses the chat renderer.\n\n```ts\nexport const ready = true;\n```\n",
      );
      await writeFile(
        path.join(workspaceRoot, "example.ts"),
        Array.from(
          { length: 180 },
          (_, index) =>
            `export const item${index + 1} = "A long line that wraps naturally in the narrow file viewer without stretching the panel.";`,
        ).join("\n"),
      );
      config.models.def["fixture-fast"] = {
        model: "openai/native-fixture-fast",
        comment: "Fast deterministic response",
      };
      config.models.def["fixture-deep"] = {
        model: "openai/native-fixture-deep",
        comment: "Alternate deterministic response",
      };
      config.models.main = { model: "fixture-fast" };
      for (const [name, description] of [
        ["review", "Review changes for correctness and missing tests"],
        ["explain", "Explain a module using a diagram and short examples"],
      ]) {
        const directory = path.join(workspaceRoot, ".agents", "skills", name!);
        await mkdir(directory, { recursive: true });
        await writeFile(
          path.join(directory, "SKILL.md"),
          `---\nname: ${name}\ndescription: ${description}\n---\n\nUse the supplied user request and report a concise result.\n`,
        );
      }
      const commandDirectory = path.join(dataDir, "cmds", "fixture-status");
      await mkdir(commandDirectory, { recursive: true });
      await writeFile(
        path.join(commandDirectory, "def.json"),
        JSON.stringify({
          name: "fixture-status",
          description: "Show deterministic browser fixture status",
          args: [],
        }),
      );
      await writeFile(
        path.join(commandDirectory, "index.ts"),
        'export function execute() { return { type: "text", value: "The isolated browser fixture is ready." }; }\n',
      );
    },
  });
  if (!threads) throw new Error("Browser fixture data was not seeded");
  const links = Object.fromEntries(
    Object.entries(threads)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([name, threadId]) => [name, `${fixture.url}?thread=${encodeURIComponent(threadId)}`]),
  );
  return { ...fixture, threads, links };
}

if (import.meta.main) {
  const fixture = await startNativeBrowserFixture();
  console.info(
    JSON.stringify(
      {
        kind: "native-browser-fixture-ready",
        url: fixture.url,
        username: fixture.username,
        links: fixture.links,
        historyTurns: fixture.threads.historyTurns,
      },
      null,
      2,
    ),
  );
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    void fixture.close().then(() => process.exit(0));
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
