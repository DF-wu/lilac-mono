import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { env } from "@stanley2058/lilac-utils";
import type { ServerToolFailure } from "@stanley2058/lilac-plugin-runtime";
import type { Result as ResultType } from "better-result";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Generate } from "../../src/tool-server/tools/generate";
import { configuredImageProviders, runImageScript } from "../../src/tool-server/tools/image-script";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+9n0AAAAASUVORK5CYII=";
const names = ["openai", "openrouter", "xai", "openaiCompatible"] as const;
const originalProviders = Object.fromEntries(
  names.map((name) => [name, { ...env.providers[name] }]),
);

function value<T>(result: ResultType<T, ServerToolFailure>): T {
  if (result.status === "error") throw new Error(result.error.message);
  return result.value;
}

async function recipe(index: number): Promise<string> {
  const reference = await Bun.file(
    new URL(
      "../../../../packages/utils/builtin-skills/image-generation/references/openai-compatible.md",
      import.meta.url,
    ),
  ).text();
  const code = [...reference.matchAll(/```js\n([\s\S]*?)\n```/g)][index]?.[1];
  expect(code).toBeDefined();
  return code!;
}

describe("image script OpenAI-compatible provider", () => {
  let cwd: string;
  let server: ReturnType<typeof Bun.serve> | undefined;
  beforeEach(async () => {
    cwd = await fs.mkdtemp(join(tmpdir(), "lilac-image-script-compatible-"));
    for (const name of names)
      Object.assign(env.providers[name], { apiKey: undefined, baseUrl: undefined });
  });
  afterEach(async () => {
    server?.stop(true);
    server = undefined;
    for (const name of names) Object.assign(env.providers[name], originalProviders[name]);
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it("is configured only by its base URL and advertised without credentials", async () => {
    Object.assign(env.providers.openaiCompatible, { apiKey: "compatible-secret" });
    expect(configuredImageProviders()).toEqual({});

    Object.assign(env.providers.openaiCompatible, { baseUrl: " http://localhost:4321/v1/ " });
    expect(configuredImageProviders()).toEqual({
      openaiCompatible: { baseURL: "http://localhost:4321/v1", apiKey: "compatible-secret" },
    });
    const image = (await new Generate().list()).find(
      (entry) => entry.callableId === "generate.image",
    );
    expect(image?.description).toContain("Configured providers: openaiCompatible.");
    expect(JSON.stringify(image)).not.toContain("compatible-secret");
    expect(JSON.stringify(image)).not.toContain("localhost:4321");

    Object.assign(env.providers.openaiCompatible, { apiKey: undefined });
    expect(configuredImageProviders()).toEqual({
      openaiCompatible: { baseURL: "http://localhost:4321/v1" },
    });
  });

  it("exposes the endpoint to scripts and redacts its key", async () => {
    Object.assign(env.providers.openaiCompatible, {
      baseUrl: "http://localhost:4321/v1",
      apiKey: "compatible-secret-for-test",
    });
    const result = value(
      await runImageScript(
        {
          code: "console.log(providers.openaiCompatible.baseURL, providers.openaiCompatible.apiKey);",
        },
        { context: { cwd } },
      ),
    );
    expect(result).toMatchObject({ exitCode: 0, stdout: "http://localhost:4321/v1 <redacted>\n" });
  });

  for (const [recipeIndex, endpoint] of [
    [0, "/v1/models"],
    [1, "/v1/images/generations"],
    [2, "/v1/images/edits"],
  ] as const) {
    it(`executes bundled recipe ${recipeIndex} against ${endpoint}`, async () => {
      let requestPath = "";
      let authorization: string | null = null;
      let requestModel: string | undefined;
      let imageName: string | undefined;
      let maskName: string | undefined;
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          requestPath = new URL(request.url).pathname;
          if (requestPath === "/v1/files/generated.png") {
            return new Response(Buffer.from(PNG, "base64"), {
              headers: { "Content-Type": "image/png" },
            });
          }
          authorization = request.headers.get("authorization");
          if (request.method === "GET") {
            return Response.json({ data: [{ id: "gpt-image-2.5-sunburst" }] });
          }
          if (request.headers.get("content-type")?.startsWith("multipart/")) {
            const form = await request.formData();
            requestModel = String(form.get("model"));
            const image = form.get("image[]");
            const mask = form.get("mask");
            imageName = image instanceof File ? image.name : undefined;
            maskName = mask instanceof File ? mask.name : undefined;
            return Response.json({ data: [{ b64_json: PNG }] });
          }
          requestModel = (await request.json()).model;
          // Gateways may answer with a URL instead of base64 bytes.
          return Response.json({ data: [{ url: `${server?.url}v1/files/generated.png` }] });
        },
      });
      Object.assign(env.providers.openaiCompatible, {
        baseUrl: `${server.url}v1/`,
        apiKey: "mock-compatible-key",
      });
      await fs.writeFile(join(cwd, "input.png"), Buffer.from(PNG, "base64"));
      await fs.writeFile(join(cwd, "mask.png"), Buffer.from(PNG, "base64"));

      const result = value(
        await runImageScript({ code: await recipe(recipeIndex) }, { context: { cwd } }),
      );
      expect(result).toMatchObject({ exitCode: 0, stderr: "", truncated: false });
      expect(String(authorization)).toBe("Bearer mock-compatible-key");
      const output = JSON.parse(result.stdout);
      if (recipeIndex === 0) {
        expect(requestPath).toBe(endpoint);
        expect(output).toEqual(["gpt-image-2.5-sunburst"]);
        return;
      }
      expect(requestModel).toBe("gpt-image-2.5-sunburst");
      if (recipeIndex === 1) {
        expect(requestPath).toBe("/v1/files/generated.png");
        expect(output.mimeType).toBe("image/png");
        expect(output.path).toEndWith(".png");
      } else {
        expect(requestPath).toBe(endpoint);
        expect(imageName).toBe("input.png");
        expect(maskName).toBe("mask.png");
      }
      expect(output.path).toStartWith(cwd);
      expect(await fs.readFile(output.path)).toEqual(Buffer.from(PNG, "base64"));
    });
  }
});
