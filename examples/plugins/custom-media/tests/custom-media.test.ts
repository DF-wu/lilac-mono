import { afterEach, describe, expect, it } from "bun:test";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { customMediaConfigSchema } from "../src/config";
import { createCustomMediaServerTool } from "../src/index";
import { IMAGE_MODEL_REGISTRY } from "../src/models";
import { restrictedSessionRoot, restrictedSessionToken } from "../src/paths";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const ENV_BASE = "CUSTOM_MEDIA_TEST_BASE_URL";
const ENV_KEY = "CUSTOM_MEDIA_TEST_API_KEY";
const API_KEY = "sk-test-secret-value";
const config = { baseUrlEnv: ENV_BASE, apiKeyEnv: ENV_KEY };

let cleanupPaths: string[] = [];
let servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(async () => {
  for (const server of servers) await server.stop(true);
  servers = [];
  for (const cleanupPath of cleanupPaths) {
    await fs.rm(cleanupPath, { recursive: true, force: true });
  }
  cleanupPaths = [];
  delete process.env[ENV_BASE];
  delete process.env[ENV_KEY];
});

async function tempDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), prefix));
  cleanupPaths.push(directory);
  return directory;
}

function startServer(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch });
  servers.push(server);
  process.env[ENV_BASE] = `http://127.0.0.1:${server.port}`;
  process.env[ENV_KEY] = API_KEY;
  return server;
}

describe("custom-media configuration and registration", () => {
  it("defaults to OpenAI-compatible environment variable names", () => {
    expect(customMediaConfigSchema.parse(undefined)).toEqual({
      baseUrlEnv: "OPENAI_COMPATIBLE_BASE_URL",
      apiKeyEnv: "OPENAI_COMPATIBLE_API_KEY",
    });
  });

  it("accepts only environment variable names, never literal credentials", () => {
    expect(() => customMediaConfigSchema.parse({ apiKey: API_KEY })).toThrow();
    expect(() => customMediaConfigSchema.parse({ apiKeyEnv: API_KEY })).toThrow();
    expect(customMediaConfigSchema.parse(config)).toEqual(config);
  });

  it("publishes unique custom callable IDs and the documented route aliases", async () => {
    const entries = await createCustomMediaServerTool(config).list();
    expect(entries.map((entry) => entry.callableId)).toEqual([
      "custom-media.image",
      "custom-media.video",
    ]);
    expect(IMAGE_MODEL_REGISTRY["gpt-5-image"].route).toBe("gpt-image-1.5");
    expect(IMAGE_MODEL_REGISTRY["nanobanana-2"].route).toBe(
      "google/gemini-3.1-flash-image-preview",
    );
  });

  it("matches core's restricted-session SHA-256 token mapping", () => {
    expect(restrictedSessionToken("restricted-test")).toBe("6dbef66f623270731db76b3cffca59ab");
    expect(restrictedSessionRoot("restricted-test")).toBe(
      "/tmp/lilac-restricted/6dbef66f623270731db76b3cffca59ab",
    );
  });
});

describe("custom-media.image", () => {
  it("generates through createOpenAICompatible without retries or model fallback", async () => {
    const output = await tempDirectory("custom-media-image-");
    let requests = 0;
    startServer(async (request) => {
      requests += 1;
      const url = new URL(request.url);
      expect(url.pathname).toBe("/v1/images/generations");
      expect(request.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
      const body = (await request.json()) as Record<string, unknown>;
      expect(body.model).toBe("gpt-image-1.5");
      expect(body.prompt).toBe("paint a quiet harbor");
      return Response.json({ data: [{ b64_json: PNG.toString("base64") }] });
    });

    const result = await createCustomMediaServerTool(config).call(
      "custom-media.image",
      {
        prompt: "paint a quiet harbor",
        model: "gpt-5-image",
        aspectRatio: "3:2",
        outputDir: output,
      },
      { context: { cwd: output } },
    );

    expect(requests).toBe(1);
    expect(result).toMatchObject({
      ok: true,
      model: "gpt-5-image",
      route: "gpt-image-1.5",
      mimeType: "image/png",
    });
    expect(await fs.readFile((result as { path: string }).path)).toEqual(PNG);
  });

  it("uses multipart /images/edits with validated local images", async () => {
    const output = await tempDirectory("custom-media-edit-");
    const inputPath = path.join(output, "input.png");
    await fs.writeFile(inputPath, PNG);
    startServer(async (request) => {
      expect(new URL(request.url).pathname).toBe("/v1/images/edits");
      const form = await request.formData();
      expect(form.get("model")).toBe("grok-imagine-image");
      expect(form.get("prompt")).toBe("add morning light");
      expect(form.get("image")).toBeInstanceOf(File);
      return Response.json({ data: [{ b64_json: PNG.toString("base64") }] });
    });

    const result = await createCustomMediaServerTool(config).call(
      "custom-media.image",
      {
        prompt: "add morning light",
        model: "grok-imagine-image",
        inputImages: inputPath,
        outputDir: output,
      },
      { context: { cwd: output } },
    );
    expect(result).toMatchObject({ ok: true, route: "grok-imagine-image" });
  });

  it("validates per-model capabilities before making an HTTP request", async () => {
    let requests = 0;
    startServer(() => {
      requests += 1;
      return Response.json({ data: [] });
    });
    await expect(
      createCustomMediaServerTool(config).call("custom-media.image", {
        prompt: "invalid size",
        model: "grok-imagine-image",
        size: "1024x1024",
      }),
    ).rejects.toThrow("UNSUPPORTED_CAPABILITY");
    expect(requests).toBe(0);
  });

  it("maps restricted /tmp inputs and outputs to the session-owned host directory", async () => {
    const sessionId = `custom-media-${crypto.randomUUID()}`;
    const restrictedRoot = restrictedSessionRoot(sessionId);
    cleanupPaths.push(restrictedRoot);
    await fs.mkdir(restrictedRoot, { recursive: true });
    await fs.writeFile(path.join(restrictedRoot, "input.png"), PNG);
    startServer(async (request) => {
      expect(new URL(request.url).pathname).toBe("/v1/images/edits");
      return Response.json({ data: [{ b64_json: PNG.toString("base64") }] });
    });

    const result = await createCustomMediaServerTool(config).call(
      "custom-media.image",
      {
        prompt: "edit safely",
        inputImages: "/tmp/input.png",
        outputDir: "/tmp/out",
      },
      { context: { cwd: "/tmp", safetyMode: "restricted", sessionId } },
    );
    const returnedPath = (result as { path: string }).path;
    expect(returnedPath).toStartWith("/tmp/out/custom-media-image");
    expect(await fs.readFile(path.join(restrictedRoot, returnedPath.slice(5)))).toEqual(PNG);
  });

  it("redacts provider credentials from diagnostics", async () => {
    startServer(() =>
      Response.json(
        { error: { message: `bad Authorization: Bearer ${API_KEY}` } },
        { status: 401 },
      ),
    );
    try {
      await createCustomMediaServerTool(config).call("custom-media.image", {
        prompt: "fail",
      });
      throw new Error("expected image call to fail");
    } catch (error) {
      expect(String(error)).not.toContain(API_KEY);
      expect(String(error)).toContain("REDACTED");
    }
  });
});

describe("custom-media.video", () => {
  it("uploads multipart input, polls, and streams content into an exclusive file", async () => {
    const output = await tempDirectory("custom-media-video-");
    const inputPath = path.join(output, "frame.png");
    await fs.writeFile(inputPath, PNG);
    await fs.writeFile(path.join(output, "clip.mp4"), "existing");
    let polls = 0;
    startServer(async (request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/v1/videos") {
        const form = await request.formData();
        expect(form.get("model")).toBe("grok-imagine-video");
        expect(form.get("seconds")).toBe("5");
        expect(form.get("size")).toBe("1280x720");
        expect(form.get("input_reference")).toBeInstanceOf(File);
        return Response.json({ id: "video_1", status: "processing", progress: 0 }, { status: 201 });
      }
      if (url.pathname === "/v1/videos/video_1") {
        polls += 1;
        return Response.json({ id: "video_1", status: "succeeded", progress: 100 });
      }
      if (url.pathname === "/v1/videos/video_1/content") {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("video-"));
            controller.enqueue(new TextEncoder().encode("bytes"));
            controller.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "video/mp4" } });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await createCustomMediaServerTool(config).call(
      "custom-media.video",
      {
        prompt: "slow camera move",
        path: "clip.mp4",
        inputImage: "frame.png",
        seconds: 5,
        size: "1280x720",
        pollIntervalMs: 10,
      },
      { context: { cwd: output } },
    );
    expect(polls).toBe(1);
    expect(result).toMatchObject({
      ok: true,
      path: path.join(output, "clip (1).mp4"),
      bytes: 11,
      mimeType: "video/mp4",
      videoId: "video_1",
    });
    expect(await fs.readFile(path.join(output, "clip.mp4"), "utf8")).toBe("existing");
    expect(await fs.readFile(path.join(output, "clip (1).mp4"), "utf8")).toBe("video-bytes");
  });

  it("bounds streaming downloads and removes partial exclusive files", async () => {
    const output = await tempDirectory("custom-media-video-limit-");
    startServer((request) => {
      const url = new URL(request.url);
      if (request.method === "POST") {
        return Response.json({ id: "video_limit", status: "succeeded" }, { status: 201 });
      }
      if (url.pathname.endsWith("/content")) {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(8));
              controller.close();
            },
          }),
          { headers: { "content-type": "video/mp4" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    await expect(
      createCustomMediaServerTool(config).call(
        "custom-media.video",
        {
          prompt: "bounded",
          path: "bounded.mp4",
          maxDownloadBytes: 4,
        },
        { context: { cwd: output } },
      ),
    ).rejects.toThrow("DOWNLOAD_TOO_LARGE");
    expect(await fs.readdir(output)).toEqual([]);
  });

  it("redacts credentials echoed by terminal task errors", async () => {
    const output = await tempDirectory("custom-media-video-error-");
    startServer(() =>
      Response.json({
        id: "video_failed",
        status: "failed",
        error: { message: `bad Authorization: Bearer ${API_KEY}` },
      }),
    );

    try {
      await createCustomMediaServerTool(config).call(
        "custom-media.video",
        { prompt: "fail", path: "failed.mp4" },
        { context: { cwd: output } },
      );
      throw new Error("expected video call to fail");
    } catch (error) {
      expect(String(error)).not.toContain(API_KEY);
      expect(String(error)).toContain("REDACTED");
    }
  });
});
