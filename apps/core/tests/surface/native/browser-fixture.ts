import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createNativeIntegrationFixture } from "./integration-fixture";
import { seedNativeBrowserFixture } from "./browser-seed";

export async function startNativeBrowserFixture() {
  let threads: ReturnType<typeof seedNativeBrowserFixture> | undefined;
  const fixture = await createNativeIntegrationFixture({
    port: 8787,
    password: process.env.TEST_NATIVE_PASSWORD ?? "native-fixture-password",
    allowedOrigins: [
      "http://127.0.0.1:8787",
      "http://localhost:8787",
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
