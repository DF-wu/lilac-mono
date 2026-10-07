import { Result } from "better-result";
import { linkPreviewUrl, PublicResourceFailure, readPublicResource } from "./public-resource";

export async function resolveRemoteImage(
  href: string,
  signal: AbortSignal,
  read = readPublicResource,
) {
  return Result.gen(async function* () {
    let url = linkPreviewUrl(href);
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
    for (let redirects = 0; url && redirects <= 3; redirects++) {
      const reply = yield* Result.await(read(url, deadline, "image"));
      if (reply.location) {
        url = linkPreviewUrl(reply.location, url.href);
        continue;
      }
      return Result.ok(reply);
    }
    return Result.err(new PublicResourceFailure({ message: "Remote image unavailable" }));
  });
}

export async function handleRemoteImage(request: Request, resolve = resolveRemoteImage) {
  if (request.method !== "GET")
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET" } });
  const href = new URL(request.url).searchParams.get("url");
  if (!href || !linkPreviewUrl(href)) return new Response("Invalid image URL", { status: 422 });
  return (await resolve(href, request.signal)).match({
    ok: ({ bytes, mediaType }) =>
      new Response(new Uint8Array(bytes), {
        headers: {
          "Content-Type": mediaType,
          "Content-Length": String(bytes.byteLength),
          "Cache-Control": "private, max-age=1800",
          "X-Content-Type-Options": "nosniff",
          "Cross-Origin-Resource-Policy": "same-origin",
          // SVG favicons can contain embedded raster images, but must never execute scripts.
          "Content-Security-Policy": "sandbox; default-src 'none'; img-src data:",
        },
      }),
    err: () =>
      new Response("Remote image unavailable", {
        status: 502,
        headers: { "Cache-Control": "no-store" },
      }),
  });
}
