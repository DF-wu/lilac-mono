import { createToolServer } from "@stanley2058/lilac-core";
import { parseCoreConfig } from "@stanley2058/lilac-utils";

import { createToolBridgePluginManager } from "./create-plugin-manager";

const dataDirFlag = process.argv.find((arg) => arg.startsWith("--data-dir="));
const dataDir = dataDirFlag?.slice("--data-dir=".length);
if (!dataDir) {
  throw new Error("Missing --data-dir");
}

const config = await parseCoreConfig({
  configVersion: 2,
  tools: {
    generate: {
      image: {
        models: ["openai-compatible/gpt-image-2"],
        defaults: { size: "1024x1024" },
        profiles: {
          "openai-compatible/gpt-image-2": {
            useWhen: "high fidelity product shots",
            defaults: {
              options: {
                quality: "high",
              },
            },
          },
        },
      },
    },
  },
});

const pluginManager = createToolBridgePluginManager({
  dataDir,
  getConfig: async () => config,
});
const server = createToolServer({ pluginManager });
await server.init();

try {
  const response = await server.app.handle(new Request("http://localhost/help/generate.image"));
  const body = await response.json();
  console.log(
    JSON.stringify({
      status: response.status,
      body,
    }),
  );
} finally {
  await server.stop();
}
