import { afterEach, describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { MAX_IMAGE_BYTES, readPublicResource, requestPublicResource } from "./public-resource";
import { handleRemoteImage, resolveRemoteImage } from "./remote-image";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop();
});

function upstream(fetch: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch });
  cleanup.push(() => {
    server.stop(true);
  });
  return new URL(`http://public.example:${server.port}/image`);
}

function readTestServer(url: URL, signal = AbortSignal.timeout(1000)) {
  return requestPublicResource(url, { address: "127.0.0.1", family: 4 }, signal, "image");
}

describe("remote images", () => {
  test("pins the connection and sends no user credentials to the upstream", async () => {
    const url = upstream((request) => {
      expect(request.headers.get("host")).toBe(url.host);
      expect(request.headers.get("cookie")).toBeNull();
      expect(request.headers.get("authorization")).toBeNull();
      expect(request.headers.get("referer")).toBeNull();
      return new Response("image bytes", {
        headers: { "Content-Type": "image/png", "Cross-Origin-Resource-Policy": "same-origin" },
      });
    });
    const result = (await readTestServer(url)).unwrap();
    expect(result.bytes.toString()).toBe("image bytes");
    expect(result.mediaType).toBe("image/png");
  });

  test("rejects non-image responses, errors, and redirects without a destination", async () => {
    for (const response of [
      new Response("html"),
      new Response("missing", { status: 404, headers: { "Content-Type": "image/png" } }),
      new Response(null, { status: 302 }),
    ]) {
      expect((await readTestServer(upstream(() => response))).isErr()).toBe(true);
    }
  });

  test("rejects oversized content-length and chunked images without returning partial bytes", async () => {
    const known = upstream(
      () =>
        new Response(new Uint8Array(MAX_IMAGE_BYTES + 1), {
          headers: { "Content-Type": "image/png" },
        }),
    );
    expect((await readTestServer(known)).isErr()).toBe(true);
    const chunked = upstream(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(MAX_IMAGE_BYTES));
              controller.enqueue(new Uint8Array(1));
              controller.close();
            },
          }),
          { headers: { "Content-Type": "image/png" } },
        ),
    );
    expect((await readTestServer(chunked)).isErr()).toBe(true);
  });

  test("cancellation interrupts an unfinished body", async () => {
    const controller = new AbortController();
    const url = upstream(
      () =>
        new Response(
          new ReadableStream({
            start(stream) {
              stream.enqueue(new Uint8Array([1]));
              controller.abort();
            },
          }),
          { headers: { "Content-Type": "image/png" } },
        ),
    );
    expect((await readTestServer(url, controller.signal)).isErr()).toBe(true);
  });

  test("validates each redirect, resolves relative locations, and bounds loops", async () => {
    const visited: string[] = [];
    const image = { bytes: Buffer.from("png"), mediaType: "image/png" };
    const result = await resolveRemoteImage(
      "https://example.com/start",
      new AbortController().signal,
      async (url) => {
        visited.push(url.href);
        return Result.ok(visited.length === 1 ? { ...image, location: "/final" } : image);
      },
    );
    expect(result.unwrap()).toEqual(image);
    expect(visited).toEqual(["https://example.com/start", "https://example.com/final"]);
    for (const location of [
      "file:///etc/passwd",
      "https://user:pass@example.com/image",
      "http://127.0.0.1/image",
      "http://[::1]/image",
    ]) {
      let requests = 0;
      const rejected = await resolveRemoteImage(
        "https://example.com/start",
        new AbortController().signal,
        async (url, signal, kind) => {
          requests++;
          if (requests === 1) return Result.ok({ ...image, location });
          return readPublicResource(url, signal, kind);
        },
      );
      expect(rejected.isErr()).toBe(true);
    }
    let requests = 0;
    expect(
      (
        await resolveRemoteImage("https://example.com", new AbortController().signal, async () => {
          requests++;
          return Result.ok({ ...image, location: "/loop" });
        })
      ).isErr(),
    ).toBe(true);
    expect(requests).toBe(4);
  });

  test("serves SVGs with a sandbox, allows embedded raster data, and caches privately", async () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,AA=="/></svg>';
    const response = await handleRemoteImage(
      new Request("http://localhost/api/remote-image?url=https://example.com/icon.svg"),
      async () => Result.ok({ bytes: Buffer.from(svg), mediaType: "image/svg+xml" }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(svg);
    expect(response.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "sandbox; default-src 'none'; img-src data:",
    );
    expect(response.headers.get("Cache-Control")).toBe("private, max-age=1800");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  test("rejects invalid inputs before fetching", async () => {
    for (const href of ["", "file:///etc/passwd", "https://user:pass@example.com/icon"]) {
      const response = await handleRemoteImage(
        new Request(`http://localhost/api/remote-image?url=${encodeURIComponent(href)}`),
      );
      expect(response.status).toBe(422);
    }
    expect(
      (
        await handleRemoteImage(
          new Request("http://localhost/api/remote-image", { method: "POST" }),
        )
      ).status,
    ).toBe(405);
  });
});
