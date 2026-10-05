import { expect, test } from "bun:test";
import { namePastedImage } from "../src/pasted-file";

test.each([
  ["image/png", "pasted-image.png"],
  ["image/jpeg", "pasted-image.jpg"],
  ["image/gif", "pasted-image.gif"],
  ["image/webp", "pasted-image.webp"],
  ["image/avif", "pasted-image.avif"],
  ["image/svg+xml", "pasted-image.svg"],
  ["image/x-example", "pasted-image"],
])("names an unnamed %s paste without changing its contents", async (type, name) => {
  const bytes = new Uint8Array([0, 1, 127, 255]);
  const file = new File([bytes], "", { type, lastModified: 1234 });
  const named = namePastedImage(file);
  expect(named.name).toBe(name);
  expect(named.type).toBe(type);
  expect(named.lastModified).toBe(file.lastModified);
  expect(new Uint8Array(await named.arrayBuffer())).toEqual(bytes);
});

test("preserves named images and non-image files", () => {
  for (const file of [
    new File(["image"], "Screenshot.png", { type: "image/png" }),
    new File(["text"], "", { type: "text/plain" }),
  ]) {
    expect(namePastedImage(file)).toBe(file);
  }
});
