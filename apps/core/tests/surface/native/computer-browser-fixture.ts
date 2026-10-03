import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Result } from "better-result";
import { decodeConfig } from "../../../../computer-use-gateway/src/contracts";
import { DockerCli } from "../../../../computer-use-gateway/src/docker";
import { ComputerLifecycle } from "../../../../computer-use-gateway/src/lifecycle";
import { createGatewayHandler } from "../../../../computer-use-gateway/src/server";
import { RunnerStore } from "../../../../computer-use-gateway/src/store";
import { McpRegistry } from "../../../src/mcp/registry";
import { hashMcpSession } from "../../../src/mcp/session-context";
import { startNativeBrowserFixture } from "./browser-fixture";

const secret = randomBytes(24).toString("base64url");
const config = decodeConfig({
  MCP_BEARER_SECRET: secret,
  DATABASE_PATH: ":memory:",
  GATEWAY_OWNER: `viewer-fixture-${randomUUID()}`,
  PORT_RANGE_START: "18200",
  PORT_RANGE_END: "18209",
  SECCOMP_PATH: resolve("packages/computer-use-runner/seccomp-chromium.json"),
}).unwrap();
const store = RunnerStore.open(":memory:").unwrap();
const lifecycle = new ComputerLifecycle(store, new DockerCli(config), config);
(await lifecycle.reconcile()).unwrap();
const gateway = Bun.serve({ port: 0, fetch: createGatewayHandler(lifecycle, secret) });
const registry = new McpRegistry({
  configPath: "/unused-viewer-fixture.yaml",
  reportFatalError: (error) => {
    throw error;
  },
  dependencies: {
    readConfig: async () =>
      Result.ok({
        configPath: "/unused-viewer-fixture.yaml",
        exists: true,
        config: {
          configVersion: 1,
          servers: {
            computer_use: {
              id: "computer_use",
              allowSubagents: false,
              transportConfig: {
                transport: "http",
                url: `${gateway.url}mcp`,
                headers: { Authorization: `Bearer ${secret}` },
              },
            },
          },
        },
      }),
  },
});
await registry.init();
const fixture = await startNativeBrowserFixture(registry);
const session = hashMcpSession(`native:${fixture.threads.rich}`);
(await lifecycle.provision(session)).unwrap();
console.info(JSON.stringify({ kind: "computer-browser-fixture-ready", url: fixture.links.rich }));
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await lifecycle.terminate(session);
  await fixture.close();
  await registry.shutdown();
  await gateway.stop(true);
  store.close();
  process.exit(0);
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
