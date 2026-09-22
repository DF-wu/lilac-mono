import { expect, test } from "bun:test";

test("browser transport bundle excludes Core, server, AI runtime and schema implementation", async () => {
  const result = await Bun.build({
    entrypoints: [import.meta.dir + "/support/browser-client.ts"],
    target: "browser",
    minify: true,
    metafile: true,
  });
  expect(result.success).toBe(true);
  expect(result.metafile).toBeDefined();
  const inputs = Object.keys(result.metafile?.inputs ?? {});
  expect(inputs.length).toBeGreaterThan(0);
  for (const input of inputs) {
    expect(input).not.toContain("apps/core/");
    expect(input).not.toContain("@orpc/server/");
    expect(input).not.toContain("/ai/");
    expect(input).not.toContain("/zod/");
  }
  const output = result.outputs[0];
  expect(output).toBeDefined();
  const code = await output!.text();
  console.info(
    `native browser transport: ${Buffer.byteLength(code)} bytes minified, ${Bun.gzipSync(code).byteLength} bytes gzip`,
  );
});
