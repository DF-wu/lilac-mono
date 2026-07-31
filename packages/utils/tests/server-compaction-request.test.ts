import { describe, expect, it } from "bun:test";

import {
  REMOTE_COMPACTION_BETA_FEATURE,
  SERVER_COMPACTION_REQUEST_HEADER,
  SERVER_COMPACTION_REQUEST_MARKER,
  withServerCompactionRequestFetch,
} from "../server-compaction-request";

type CapturedRequest = {
  input: Parameters<typeof fetch>[0];
  init: Parameters<typeof fetch>[1];
};

function capturingFetch(captured: CapturedRequest[]): typeof fetch {
  return (async (input, init) => {
    captured.push({ input, init });
    return Response.json({ ok: true });
  }) as typeof fetch;
}

describe("withServerCompactionRequestFetch", () => {
  it("mutates only explicitly marked Responses JSON requests", async () => {
    const captured: CapturedRequest[] = [];
    const wrapped = withServerCompactionRequestFetch(capturingFetch(captured));

    await wrapped("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SERVER_COMPACTION_REQUEST_HEADER]: SERVER_COMPACTION_REQUEST_MARKER,
      },
      body: JSON.stringify({ model: "gpt-test", input: [{ role: "user", content: "hello" }] }),
    });

    const request = captured[0];
    const headers = new Headers(request?.init?.headers);
    expect(headers.has(SERVER_COMPACTION_REQUEST_HEADER)).toBe(false);
    expect(headers.get("x-codex-beta-features")).toBe(REMOTE_COMPACTION_BETA_FEATURE);
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      model: "gpt-test",
      input: [{ role: "user", content: "hello" }, { type: "compaction_trigger" }],
    });
  });

  it("leaves unmarked requests unchanged", async () => {
    const captured: CapturedRequest[] = [];
    const wrapped = withServerCompactionRequestFetch(capturingFetch(captured));
    const init = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: [] }),
    } satisfies RequestInit;

    await wrapped("https://api.openai.com/v1/responses", init);

    expect(captured[0]?.init).toBe(init);
  });

  it("replaces existing triggers with exactly one trailing trigger", async () => {
    const captured: CapturedRequest[] = [];
    const wrapped = withServerCompactionRequestFetch(capturingFetch(captured));

    await wrapped("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { [SERVER_COMPACTION_REQUEST_HEADER]: SERVER_COMPACTION_REQUEST_MARKER },
      body: JSON.stringify({
        input: [
          { type: "compaction_trigger" },
          { role: "user", content: "continue" },
          { type: "compaction_trigger", ignored: true },
        ],
      }),
    });

    expect(JSON.parse(String(captured[0]?.init?.body)).input).toEqual([
      { role: "user", content: "continue" },
      { type: "compaction_trigger" },
    ]);
  });

  it("merges the Codex beta feature without duplicating it", async () => {
    const captured: CapturedRequest[] = [];
    const wrapped = withServerCompactionRequestFetch(capturingFetch(captured));

    await wrapped("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        [SERVER_COMPACTION_REQUEST_HEADER]: SERVER_COMPACTION_REQUEST_MARKER,
        "x-codex-beta-features": "responses_websockets, remote_compaction_v2",
      },
      body: JSON.stringify({ input: [] }),
    });

    expect(new Headers(captured[0]?.init?.headers).get("x-codex-beta-features")).toBe(
      "responses_websockets,remote_compaction_v2",
    );
  });

  it("fails closed when a marked Responses request cannot be rewritten", async () => {
    const wrapped = withServerCompactionRequestFetch(capturingFetch([]));

    await expect(
      wrapped("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { [SERVER_COMPACTION_REQUEST_HEADER]: SERVER_COMPACTION_REQUEST_MARKER },
        body: "not-json",
      }),
    ).rejects.toThrow("must have a valid JSON body");
    await expect(
      wrapped("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { [SERVER_COMPACTION_REQUEST_HEADER]: SERVER_COMPACTION_REQUEST_MARKER },
        body: JSON.stringify({ model: "gpt-test" }),
      }),
    ).rejects.toThrow("must contain a Responses input array");
    await expect(
      wrapped("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { [SERVER_COMPACTION_REQUEST_HEADER]: SERVER_COMPACTION_REQUEST_MARKER },
        body: JSON.stringify({ messages: [] }),
      }),
    ).rejects.toThrow("must target POST /responses");
  });

  it("preserves properties on an existing WebSocket fetch adapter", () => {
    const transport = Object.assign(capturingFetch([]), { close: () => undefined });

    const wrapped = withServerCompactionRequestFetch(transport);

    expect(wrapped.close).toBe(transport.close);
  });
});
