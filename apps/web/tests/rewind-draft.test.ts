import { afterEach, expect, spyOn, test } from "bun:test";
import { rewindDraft } from "../src/rewind-draft";
import { resolveComposerAttachments } from "../src/components/composer-editor";
import type { Attachment } from "../src/types";
import type { DisplayPart } from "@stanley2058/lilac-client-protocol";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const parts: DisplayPart[] = [
  {
    type: "data-resource",
    id: "old",
    data: {
      resourceId: "old",
      name: "photo.png",
      mediaType: "image/png",
      state: "ready",
      size: 11,
    },
  },
];
function fixture() {
  const attachments: Attachment[] = [];
  const calls: string[] = [];
  const errors: string[] = [];
  const options = {
    parts,
    threadId: "thread",
    resourceUrl: (id: string) => `/api/resources/${id}`,
    pool: {
      signal: new AbortController().signal,
      get: () => attachments,
      add: (_thread: string, file: File) => {
        calls.push("reserve-new");
        attachments.push({
          key: "new-key",
          file,
          progress: 0,
          state: "reserving",
          reservation: Promise.resolve("new-resource"),
        });
        return "new-key";
      },
    },
    rewind: async () => {
      calls.push("rewind");
      return { text: "Look [photo.png](/api/resources/old)" };
    },
    onError: (message: string) => errors.push(message),
  };
  return { options, attachments, calls, errors };
}

test("rewind captures bytes before mutation and restores a sendable attachment with a new identity", async () => {
  const f = fixture();
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async () => {
        f.calls.push("download");
        return new Response("image bytes");
      },
      { preconnect: originalFetch.preconnect },
    ),
  );
  const result = await rewindDraft(f.options);
  expect(f.calls).toEqual(["download", "rewind", "reserve-new"]);
  expect(result?.attachments).toEqual(["new-key"]);
  expect(result?.text).toContain("attachment:new-key");
  expect(await f.attachments[0]!.file.text()).toBe("image bytes");
  expect(f.attachments[0]!.file.type).toBe("image/png");
  expect(
    resolveComposerAttachments(result!.text, new Map([["new-key", "new-resource"]])),
  ).toContain("/api/resources/new-resource");
});

test("a failed attachment download leaves the original turn intact", async () => {
  const f = fixture();
  spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }));
  expect(await rewindDraft(f.options)).toBeUndefined();
  expect(f.calls).toEqual([]);
  expect(f.errors).toEqual(["Could not restore attachment photo.png"]);
});

test("a rejected rewind does not reserve replacement uploads", async () => {
  const f = fixture();
  spyOn(globalThis, "fetch").mockResolvedValue(new Response("image bytes"));
  expect(await rewindDraft({ ...f.options, rewind: async () => undefined })).toBeUndefined();
  expect(f.attachments).toEqual([]);
});

test("attachments without inline links are restored as composer chips", async () => {
  const f = fixture();
  spyOn(globalThis, "fetch").mockResolvedValue(new Response("image bytes"));
  const result = await rewindDraft({ ...f.options, rewind: async () => ({ text: "" }) });
  expect(result?.text).toContain("attachment:new-key");
});

test("text-only rewinds preserve the server text without a Markdown round trip", async () => {
  const f = fixture();
  const text = "plain  text\n\n[editable](https://example.com)  ";
  const fetch = spyOn(globalThis, "fetch");
  expect(await rewindDraft({ ...f.options, parts: [], rewind: async () => ({ text }) })).toEqual({
    text,
    attachments: [],
  });
  expect(fetch).not.toHaveBeenCalled();
});
