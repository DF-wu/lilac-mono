import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  decodeDynamicToolPluginModule,
  decodeToolPluginInstance,
  invokeLevel2Call,
  type ServerToolCallOptions,
} from "@stanley2058/lilac-plugin-runtime";
import { Panic } from "better-result";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const ENV_BASE = "CUSTOM_MEDIA_BUNDLE_TEST_BASE_URL";
const ENV_KEY = "CUSTOM_MEDIA_BUNDLE_TEST_API_KEY";
const API_KEY = "sk-bundle-test-placeholder";
const bundleURL = new URL(
  "../../../../examples/plugins/custom-media/dist/index.js",
  import.meta.url,
);
let directories: string[] = [];
let servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  for (const server of servers) await server.stop(true);
  servers = [];
  for (const directory of directories) await fs.rm(directory, { recursive: true, force: true });
  directories = [];
  delete process.env[ENV_BASE];
  delete process.env[ENV_KEY];
});

async function tempDirectory() {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "custom-media-bundle-"));
  directories.push(directory);
  return directory;
}

function startServer(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
  servers.push(server);
  process.env[ENV_BASE] = `http://127.0.0.1:${server.port}`;
  process.env[ENV_KEY] = API_KEY;
}

async function callBundledTool(
  callableId: string,
  input: Record<string, unknown>,
  opts?: ServerToolCallOptions,
) {
  const capability = decodeDynamicToolPluginModule(await import(bundleURL.href)).unwrap().plugin;
  const instance = await capability.create.call(capability.plugin, {
    runtime: {},
    dataDir: tmpdir(),
    pluginConfig: { baseUrlEnv: ENV_BASE, apiKeyEnv: ENV_KEY },
    source: "external",
  });
  const tool = decodeToolPluginInstance("custom-media", instance).unwrap().level2[0]!.tool;
  await tool.init();
  return invokeLevel2Call({
    pluginId: "custom-media",
    source: "external",
    tool,
    callableId,
    input,
    opts,
  });
}

describe("bundled custom-media through Core's Level 2 hook", () => {
  it("accepts the plugin-local Result and preserves image output", async () => {
    const output = await tempDirectory();
    startServer(() => Response.json({ data: [{ b64_json: PNG.toString("base64") }] }));
    const invoked = await callBundledTool("custom-media.image", {
      prompt: "harbor",
      outputDir: output,
    });
    expect(invoked).toMatchObject({
      status: "ok",
      value: {
        status: "ok",
        value: {
          ok: true,
          path: path.join(output, "custom-media-image.png"),
          mimeType: "image/png",
          model: "gpt-image-2",
          route: "gpt-image-2",
        },
      },
    });
    expect(await fs.readFile(path.join(output, "custom-media-image.png"))).toEqual(PNG);
  });

  it("accepts the video Result and preserves the saved payload", async () => {
    const output = await tempDirectory();
    startServer((request) =>
      request.method === "POST"
        ? Response.json({ id: "bundle_video", status: "succeeded" })
        : new Response("video-bytes", { headers: { "content-type": "video/mp4" } }),
    );
    const invoked = await callBundledTool(
      "custom-media.video",
      { prompt: "harbor", path: "clip.mp4" },
      { context: { cwd: output } },
    );
    expect(invoked).toMatchObject({
      status: "ok",
      value: {
        status: "ok",
        value: {
          ok: true,
          path: path.join(output, "clip.mp4"),
          bytes: 11,
          mimeType: "video/mp4",
          videoId: "bundle_video",
        },
      },
    });
    expect(await fs.readFile(path.join(output, "clip.mp4"), "utf8")).toBe("video-bytes");
  });

  it("ships named image and mask edit parts in the rebuilt bundle", async () => {
    const output = await tempDirectory();
    const inputPath = path.join(output, "input.png");
    const maskPath = path.join(output, "mask.png");
    await fs.writeFile(inputPath, PNG);
    await fs.writeFile(maskPath, PNG);
    let multipart = "";
    startServer(async (request) => {
      expect(new URL(request.url).pathname).toBe("/v1/images/edits");
      multipart = await request.text();
      return Response.json({ data: [{ b64_json: PNG.toString("base64") }] });
    });
    const invoked = await callBundledTool("custom-media.image", {
      prompt: "edit with mask",
      inputImages: [inputPath, inputPath],
      maskImage: maskPath,
      outputDir: output,
    });
    const filenames = [
      ...multipart.matchAll(/name="(?:image(?:\[\])?|mask)"; filename="([^"]*)"/gu),
    ].map((match) => match[1]);
    expect(filenames).toHaveLength(3);
    expect(filenames).not.toContain("");
    expect(invoked).toMatchObject({ status: "ok", value: { status: "ok", value: { ok: true } } });
  });

  it("reports missing environment configuration without a hook defect", async () => {
    const invoked = await callBundledTool("custom-media.image", {
      prompt: "missing configuration",
    });
    expect(invoked).toMatchObject({
      status: "ok",
      value: {
        status: "error",
        error: { kind: "unavailable", code: "MISSING_ENV", retryable: false },
      },
    });
  });

  it("keeps restricted path violations denied", async () => {
    startServer(() => Response.json({ data: [] }));
    const invoked = await callBundledTool(
      "custom-media.video",
      { prompt: "restricted", path: "/etc/clip.mp4" },
      { context: { cwd: "/tmp", safetyMode: "restricted", sessionId: "custom-media-denied" } },
    );
    expect(invoked).toMatchObject({
      status: "ok",
      value: { status: "error", error: { kind: "denied", code: "UNSAFE_PATH", retryable: false } },
    });
  });

  it.each(["custom-media.image", "custom-media.video", "custom-media.unknown"])(
    "keeps %s input failures inside a successful hook invocation",
    async (callableId) => {
      const invoked = await callBundledTool(callableId, {});
      expect(invoked).toMatchObject({
        status: "ok",
        value: {
          status: "error",
          error: {
            kind: "usage",
            code: "INVALID_INPUT",
            message: expect.any(String),
            retryable: false,
          },
        },
      });
    },
  );

  it("returns redacted provider failures instead of hook defects", async () => {
    startServer(() =>
      Response.json({ error: { message: `Rejected Bearer ${API_KEY}` } }, { status: 503 }),
    );
    const invoked = await callBundledTool("custom-media.image", { prompt: "fail" });
    expect(invoked).toMatchObject({
      status: "ok",
      value: {
        status: "error",
        error: { kind: "unavailable", code: "PROVIDER_ERROR", retryable: true },
      },
    });
    const serialized = JSON.stringify(invoked);
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).toContain("REDACTED");
  });

  it("returns malformed provider base64 without a hook defect", async () => {
    startServer(() => Response.json({ data: [{ b64_json: "not valid base64!" }] }));
    const invoked = await callBundledTool("custom-media.image", { prompt: "invalid payload" });

    expect(invoked).toMatchObject({
      status: "ok",
      value: {
        status: "error",
        error: { kind: "unavailable", code: "PROVIDER_ERROR", retryable: true },
      },
    });
  });

  it("returns caller cancellation as a semantic failure", async () => {
    startServer(() => Response.json({ data: [] }));
    const invoked = await callBundledTool(
      "custom-media.video",
      { prompt: "cancel", path: "cancel.mp4" },
      { signal: AbortSignal.abort() },
    );
    expect(invoked).toMatchObject({
      status: "ok",
      value: { status: "error", error: { kind: "cancelled", code: "ABORTED", retryable: false } },
    });
  });

  it("returns operation deadlines as retryable timeout failures", async () => {
    startServer(() => Response.json({ id: "timeout_video", status: "processing" }));
    const invoked = await callBundledTool("custom-media.video", {
      prompt: "timeout",
      path: "timeout.mp4",
      timeoutMs: 100,
      pollIntervalMs: 30_000,
    });
    expect(invoked).toMatchObject({
      status: "ok",
      value: { status: "error", error: { kind: "timeout", code: "TIMEOUT", retryable: true } },
    });
  });

  it("preserves unexpected defects and Panic identity", async () => {
    const defect = new Error("unexpected input getter defect");
    const panic = new Panic({ message: "input getter invariant" });
    for (const cause of [defect, panic]) {
      const input = {
        get prompt(): string {
          throw cause;
        },
      };
      if (cause === panic) {
        await expect(callBundledTool("custom-media.image", input)).rejects.toBe(panic);
        continue;
      }
      const invoked = await callBundledTool("custom-media.image", input);
      expect(invoked).toMatchObject({
        status: "error",
        error: { _tag: "ToolPluginHookError", cause: defect },
      });
    }
  });
});
