import { afterEach, describe, expect, it } from "bun:test";
import { generateImage } from "ai";

import {
  createOpenAICompatibleImageProvider,
  OPENAI_COMPATIBLE_IMAGE_PROVIDER_NAME,
} from "../openai-compatible-image-provider";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");

const servers: Bun.Server<unknown>[] = [];

function startServer(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, fetch });
  servers.push(server);
  return server;
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

describe("createOpenAICompatibleImageProvider", () => {
  it("names every multipart blob on image edits", async () => {
    // Given
    const parts: Record<string, string> = {};
    const captured: { authorization?: string | null } = {};
    const server = startServer(async (request) => {
      captured.authorization = request.headers.get("authorization");
      for (const [key, value] of await request.formData()) {
        parts[key] = typeof value === "string" ? value : `${value.type}:${value.name}`;
      }
      return Response.json({ data: [{ b64_json: PNG_BASE64 }] });
    });
    const provider = createOpenAICompatibleImageProvider({
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
      apiKey: "compatible-key",
    });

    // When
    await generateImage({
      model: provider.imageModel("gpt-image-2"),
      prompt: { text: "edit", images: [PNG_BYTES], mask: PNG_BYTES },
      maxRetries: 0,
    });

    // Then
    expect(captured.authorization).toBe("Bearer compatible-key");
    expect(parts).toEqual({
      model: "gpt-image-2",
      prompt: "edit",
      n: "1",
      image: "image/png:image.png",
      mask: "image/png:mask.png",
    });
  });

  it("forwards options under the provider options key as request fields", async () => {
    // Given
    let body: unknown;
    const server = startServer(async (request) => {
      body = await request.json();
      return Response.json({ data: [{ b64_json: PNG_BASE64 }] });
    });
    const provider = createOpenAICompatibleImageProvider({
      baseUrl: `http://127.0.0.1:${server.port}/v1`,
    });

    // When
    const result = await generateImage({
      model: provider.imageModel("google/gemini-3.1-flash-image-preview"),
      prompt: "wide shot",
      maxRetries: 0,
      providerOptions: { [OPENAI_COMPATIBLE_IMAGE_PROVIDER_NAME]: { size: "16:9" } },
    });

    // Then
    expect(body).toEqual({
      model: "google/gemini-3.1-flash-image-preview",
      prompt: "wide shot",
      n: 1,
      size: "16:9",
    });
    expect(result.warnings).toEqual([]);
  });
});
