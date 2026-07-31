import { describe, expect, it } from "bun:test";

import { withOpenAIImageEditFilenamesFetch } from "../openai-image-edit-fetch";

function mockFetch(
  implementation: (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ) => Promise<Response>,
): typeof globalThis.fetch {
  return Object.assign(implementation, { preconnect() {} });
}

describe("withOpenAIImageEditFilenamesFetch", () => {
  it("adds filenames to unnamed OpenAI image edit blobs", async () => {
    let requestBody = "";
    const fetchFn = withOpenAIImageEditFilenamesFetch(
      mockFetch(async (_input, init) => {
        requestBody = await new Response(init?.body).text();
        return new Response(null, { status: 204 });
      }),
    );
    const body = new FormData();
    body.append("model", "gpt-image-2");
    body.append("image", new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }));
    body.append("mask", new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }));

    await fetchFn("https://api.openai.com/v1/images/edits", { method: "POST", body });

    expect(requestBody).toContain('name="image"; filename="image.png"');
    expect(requestBody).toContain('name="mask"; filename="mask.png"');
  });

  it("does not alter non-image-edit requests", async () => {
    const body = new FormData();
    body.append("image", new Blob(["image"], { type: "image/png" }));
    let receivedBody: RequestInit["body"];
    const fetchFn = withOpenAIImageEditFilenamesFetch(
      mockFetch(async (_input, init) => {
        receivedBody = init?.body;
        return new Response(null, { status: 204 });
      }),
    );

    await fetchFn("https://api.openai.com/v1/files", { method: "POST", body });

    expect(receivedBody).toBe(body);
  });
});
