import { afterEach, expect, test } from "bun:test";
import { copyPreviewImage } from "../src/image-clipboard";

const originals = new Map(
  ["document", "navigator", "ClipboardItem"].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]),
);
afterEach(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function install(options: { clipboardFails?: boolean; nullBlob?: boolean } = {}) {
  const draws: unknown[][] = [];
  const writes: Record<string, Blob>[] = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: (...args: unknown[]) => draws.push(args) }),
    toBlob: (callback: BlobCallback) =>
      callback(options.nullBlob ? null : new Blob(["png"], { type: "image/png" })),
    toDataURL: () => "data:image/png;base64,cG5n",
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => canvas },
  });
  Object.defineProperty(globalThis, "ClipboardItem", {
    configurable: true,
    value: class {
      constructor(readonly data: Record<string, Blob>) {}
    },
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        write: async (items: { data: Record<string, Blob> }[]) => {
          if (options.clipboardFails) throw new Error("private platform details");
          writes.push(...items.map((item) => item.data));
        },
      },
    },
  });
  return { canvas, draws, writes };
}

test("image copy preserves natural size and writes a PNG clipboard item", async () => {
  const fixture = install();
  const image = { naturalWidth: 300, naturalHeight: 200 } as HTMLImageElement;
  const result = await copyPreviewImage(image);
  expect(result.isOk()).toBe(true);
  expect(fixture.canvas.width).toBe(300);
  expect(fixture.canvas.height).toBe(200);
  expect(fixture.draws).toEqual([[image, 0, 0]]);
  expect(fixture.writes[0]?.["image/png"]?.type).toBe("image/png");
});

test("image copy includes attachment metadata and PNG in the same clipboard item", async () => {
  const fixture = install();
  const html = new Blob(['<div data-lilac-message="test">Attachment</div>'], {
    type: "text/html",
  });
  const text = new Blob(["Attachment"], { type: "text/plain" });
  const result = await copyPreviewImage(
    { naturalWidth: 30, naturalHeight: 20 } as HTMLImageElement,
    (pngUrl) => {
      expect(pngUrl).toBe("data:image/png;base64,cG5n");
      return { "text/html": html, "text/plain": text };
    },
  );
  expect(result.isOk()).toBe(true);
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.writes[0]?.["image/png"]?.type).toBe("image/png");
  expect(fixture.writes[0]?.["text/html"]).toBe(html);
  expect(fixture.writes[0]?.["text/plain"]).toBe(text);
});

test("encoding and clipboard failures return a download fallback without platform details", async () => {
  for (const options of [{ nullBlob: true }, { clipboardFails: true }]) {
    install(options);
    const result = await copyPreviewImage({
      naturalWidth: 20,
      naturalHeight: 10,
    } as HTMLImageElement);
    expect(result.match({ ok: () => "unexpected", err: (error) => error.message })).toBe(
      "Image could not be copied. Download it instead.",
    );
  }
});
