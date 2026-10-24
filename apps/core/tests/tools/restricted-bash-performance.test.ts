import { expect, test } from "bun:test";
import { Bash, defineCommand, DefenseInDepthBox, SecurityViolationError } from "just-bash";

import { PageContent } from "../../src/tool-server/tools/web/page-content";

test("restricted bash preserves native performance getters in nested HTTP tools", async () => {
  const originalPerformance = globalThis.performance;
  const page = new PageContent();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      const parsed = page.parse("<html><body>heartbeat page</body></html>", "https://example.com", {
        preprocessor: "none",
      });
      return Response.json({
        text: parsed.text,
        timeOrigin: performance.timeOrigin,
        guarded: performance !== originalPerformance,
      });
    },
  });
  try {
    const bash = new Bash({
      defenseInDepth: true,
      customCommands: [
        defineCommand("probe", async () => {
          const response = await fetch(`http://127.0.0.1:${server.port}`);
          return { stdout: await response.text(), stderr: "", exitCode: response.ok ? 0 : 1 };
        }),
      ],
    });
    const result = await bash.exec("probe");
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      text: "heartbeat page",
      timeOrigin: originalPerformance.timeOrigin,
      guarded: true,
    });
    expect(globalThis.performance).toBe(originalPerformance);
  } finally {
    server.stop(true);
  }
});

test("restricted execution still blocks performance getters", async () => {
  const handle = DefenseInDepthBox.getInstance(true).activate();
  let failure: unknown;
  try {
    await handle.run(async () => {
      try {
        void performance.timeOrigin;
      } catch (error) {
        failure = error;
      }
    });
  } finally {
    handle.deactivate();
  }
  expect(failure).toBeInstanceOf(SecurityViolationError);
});
