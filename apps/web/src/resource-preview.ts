import { resourcePreviewSchema, type ResourcePreview } from "@stanley2058/lilac-client-protocol";
import { Result } from "better-result";
import { WebRequestFailed } from "./http";

export function decodeResourcePreview(value: unknown): Result<ResourcePreview, WebRequestFailed> {
  const parsed = resourcePreviewSchema.safeParse(value);
  if (!parsed.success)
    return Result.err(
      new WebRequestFailed({ code: "incompatible", message: "This file preview is unavailable." }),
    );
  return Result.ok(parsed.data);
}

export function previewUrl(href: string, origin: string): string {
  const url = new URL(href, origin);
  url.pathname += "/preview";
  return url.href;
}

export async function loadResourcePreview(
  href: string,
  signal: AbortSignal,
): Promise<Result<ResourcePreview, WebRequestFailed>> {
  return Result.gen(async function* () {
    const response = yield* Result.await(
      Result.tryPromise({
        try: () =>
          fetch(previewUrl(href, location.origin), {
            signal,
            credentials: "same-origin",
            cache: "no-store",
          }),
        catch: () =>
          new WebRequestFailed({ code: "unavailable", message: "This file is unavailable." }),
      }),
    );
    if (!response.ok)
      return Result.err(
        new WebRequestFailed({
          code: "unavailable",
          message:
            response.status === 422
              ? "Text preview is unavailable for this binary file."
              : "This file is unavailable.",
        }),
      );
    const body = yield* Result.await(
      Result.tryPromise({
        try: (): Promise<unknown> => response.json(),
        catch: () =>
          new WebRequestFailed({
            code: "incompatible",
            message: "This file preview is unavailable.",
          }),
      }),
    );
    return decodeResourcePreview(body);
  });
}
