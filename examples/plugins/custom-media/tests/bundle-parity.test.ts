import { afterEach, expect, it } from "bun:test";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCustomMediaServerTool } from "../src/index";
import { imageOutputSchema, videoOutputSchema } from "../src/schemas";

const bundled = await import(new URL("../dist/index.js", import.meta.url).href);
const bundledFactory: typeof createCustomMediaServerTool = bundled.createCustomMediaServerTool;
const factories = [
  ["source", createCustomMediaServerTool],
  ["bundle", bundledFactory],
] as const;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const baseUrlEnv = "CUSTOM_MEDIA_PARITY_BASE_URL";
const apiKeyEnv = "CUSTOM_MEDIA_PARITY_API_KEY";
const previousBase = process.env[baseUrlEnv];
const previousKey = process.env[apiKeyEnv];
const directories: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true });
  if (previousBase === undefined) delete process.env[baseUrlEnv];
  else process.env[baseUrlEnv] = previousBase;
  if (previousKey === undefined) delete process.env[apiKeyEnv];
  else process.env[apiKeyEnv] = previousKey;
});

for (const [name, factory] of factories) {
  it(`${name} exposes the current Result contract for local image and video calls`, async () => {
    const cwd = await fs.mkdtemp(path.join(tmpdir(), `custom-media-${name}-parity-`));
    directories.push(cwd);
    const endpoints: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const endpoint = new URL(request.url).pathname;
        endpoints.push(endpoint);
        expect(request.headers.get("authorization")).toBe("Bearer parity-key");
        if (endpoint === "/v1/images/generations") {
          expect(await request.json()).toMatchObject({ model: "gpt-image-1.5" });
          return Response.json({ data: [{ b64_json: png.toString("base64") }] });
        }
        if (endpoint === "/v1/videos") {
          expect((await request.formData()).get("model")).toBe("grok-imagine-video");
          return Response.json({ id: "parity-video", status: "processing" });
        }
        if (endpoint === "/v1/videos/parity-video") {
          return Response.json({ id: "parity-video", status: "completed" });
        }
        if (endpoint === "/v1/videos/parity-video/content") {
          return new Response("video bytes", { headers: { "content-type": "video/mp4" } });
        }
        return new Response("unexpected endpoint", { status: 404 });
      },
    });
    servers.push(server);
    process.env[baseUrlEnv] = `http://127.0.0.1:${server.port}`;
    process.env[apiKeyEnv] = "parity-key";
    const tool = factory({ baseUrlEnv, apiKeyEnv });
    expect((await tool.list()).map((entry) => entry.callableId)).toEqual([
      "custom-media.image",
      "custom-media.video",
    ]);
    const image = await tool.call(
      "custom-media.image",
      { prompt: "local fixture", model: "gpt-5-image" },
      { context: { cwd } },
    );
    expect(image.status).toBe("ok");
    const imageOutput = imageOutputSchema.parse(image.unwrap());
    expect(await fs.readFile(imageOutput.path)).toEqual(png);
    const video = await tool.call(
      "custom-media.video",
      { prompt: "local fixture", path: "parity.mp4", pollIntervalMs: 10 },
      { context: { cwd } },
    );
    expect(video.status).toBe("ok");
    const videoOutput = videoOutputSchema.parse(video.unwrap());
    expect(await fs.readFile(videoOutput.path, "utf8")).toBe("video bytes");
    expect(endpoints).toEqual([
      "/v1/images/generations",
      "/v1/videos",
      "/v1/videos/parity-video",
      "/v1/videos/parity-video/content",
    ]);
    const invalid = await tool.call("custom-media.video", { prompt: "missing output path" });
    expect(invalid).toMatchObject({
      status: "error",
      error: { kind: "usage", code: "INVALID_INPUT", retryable: false },
    });
    expect(invalid.match({ ok: () => "unexpected", err: (error) => error.code })).toBe(
      "INVALID_INPUT",
    );
    const cancelled = await tool.call(
      "custom-media.video",
      { prompt: "cancelled", path: "cancelled.mp4" },
      { context: { cwd }, signal: AbortSignal.abort() },
    );
    expect(cancelled).toMatchObject({ status: "error", error: { kind: "cancelled" } });
    expect(await fs.readdir(cwd)).not.toContain("cancelled.mp4");
  });
}
