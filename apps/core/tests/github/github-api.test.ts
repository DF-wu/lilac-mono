import { describe, expect, it } from "bun:test";

import { decodeGithubApiErrorResponse, GithubApiError } from "../../src/github/github-api";
import { SurfacePermissionDenied, SurfaceRateLimited } from "../../src/surface/adapter";
import { classifyGithubSurfaceError } from "../../src/surface/github/github-adapter";

function decodedError(
  result: Awaited<ReturnType<typeof decodeGithubApiErrorResponse>>,
): GithubApiError {
  if (result.status === "error") return result.error;
  throw new Error("expected decoded GitHub API error");
}

async function classifyResponse(response: Response) {
  const decoded = await decodeGithubApiErrorResponse(response, "/repos/octo/repo/issues/1");
  return classifyGithubSurfaceError("read-message", decodedError(decoded));
}

describe("GitHub HTTP error classification", () => {
  it("maps an ordinary 403 without Retry-After to permission denied", async () => {
    const response = new Response("Resource not accessible", { status: 403 });
    const decoded = await decodeGithubApiErrorResponse(response, "/repos/octo/repo/issues/1");
    const error = decodedError(decoded);

    expect(error).toBeInstanceOf(GithubApiError);
    expect(error.rateLimit).toBeUndefined();
    expect(classifyGithubSurfaceError("read-message", error)).toBeInstanceOf(
      SurfacePermissionDenied,
    );
  });

  it.each([
    new Response("secondary rate limit exceeded", { status: 403 }),
    new Response("rate limit exceeded", {
      status: 403,
      headers: { "x-ratelimit-remaining": "0" },
    }),
  ])("maps a genuine 403 rate-limit response to rate limited", async (response) => {
    expect(await classifyResponse(response)).toBeInstanceOf(SurfaceRateLimited);
  });

  it("preserves a numeric Retry-After and does not synthesize zero when absent", async () => {
    const withRetryAfter = await decodeGithubApiErrorResponse(
      new Response("rate limited", { status: 429, headers: { "retry-after": "2.5" } }),
      "/repos/octo/repo/issues/1",
    );
    const withoutRetryAfter = await decodeGithubApiErrorResponse(
      new Response("rate limited", { status: 429 }),
      "/repos/octo/repo/issues/1",
    );

    expect(decodedError(withRetryAfter).rateLimit).toEqual({ retryAfterMs: 2500 });
    expect(decodedError(withoutRetryAfter).rateLimit).toEqual({});
  });
});
