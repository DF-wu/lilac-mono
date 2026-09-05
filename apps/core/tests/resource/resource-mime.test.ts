import { describe, expect, it } from "bun:test";

import {
  classifyResourceMime,
  classifyResourcePrefix,
  createResourceMimeClassifier,
  createUtf8ResourceValidator,
  hasResourceTextFilenameHint,
  isResourceTextMediaType,
} from "../../src/resource/resource-mime";

const encoder = new TextEncoder();

async function classify(
  chunks: readonly Uint8Array[],
  options: {
    declaredMediaType?: string;
    filename?: string;
    maxPrefixBytes?: number;
  } = {},
) {
  return classifyResourceMime({ ...options, chunks });
}

describe("resource MIME classification", () => {
  it("recognizes every canonical text filename extension", () => {
    const extensions = [
      ".c",
      ".cjs",
      ".conf",
      ".cpp",
      ".css",
      ".csv",
      ".cts",
      ".env",
      ".go",
      ".h",
      ".hpp",
      ".htm",
      ".html",
      ".java",
      ".js",
      ".json",
      ".jsonc",
      ".jsx",
      ".log",
      ".lua",
      ".md",
      ".mdx",
      ".mjs",
      ".mts",
      ".py",
      ".rb",
      ".rs",
      ".sh",
      ".sql",
      ".svg",
      ".toml",
      ".ts",
      ".tsx",
      ".txt",
      ".xml",
      ".yaml",
      ".yml",
    ];

    for (const extension of extensions) {
      expect(hasResourceTextFilenameHint(`document${extension}`)).toBe(true);
    }
    expect(hasResourceTextFilenameHint("image.png")).toBe(false);
    expect(hasResourceTextFilenameHint("README")).toBe(false);
    expect(hasResourceTextFilenameHint(undefined)).toBe(false);
  });

  it("lets trusted binary signatures override declared and filename text hints", async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);

    await expect(
      classify([pdf], { declaredMediaType: "text/plain", filename: "notes.txt" }),
    ).resolves.toEqual({ kind: "pdf", mediaType: "application/pdf" });

    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]);
    await expect(classify([zip], { filename: "archive.txt" })).resolves.toMatchObject({
      kind: "binary",
      mediaType: "application/zip",
    });
  });

  it("requires matching signatures for images and PDFs", async () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0x49, 0x48, 0x44, 0x52,
    ]);

    await expect(classify([png], { declaredMediaType: "text/plain" })).resolves.toEqual({
      kind: "image",
      mediaType: "image/png",
    });
    await expect(
      classify([encoder.encode("not an image")], { declaredMediaType: "image/png" }),
    ).resolves.toEqual({ kind: "binary" });
    await expect(
      classify([encoder.encode("not a pdf")], { filename: "report.pdf" }),
    ).resolves.toEqual({ kind: "binary" });
  });

  it("requires a declared or filename-derived text hint", async () => {
    const bytes = encoder.encode("plain UTF-8 text\n");

    await expect(
      classify([bytes], { declaredMediaType: "Text/Plain; charset=UTF-8" }),
    ).resolves.toEqual({ kind: "text", mediaType: "text/plain", encoding: "utf-8" });
    await expect(classify([bytes], { filename: "config.yaml" })).resolves.toEqual({
      kind: "text",
      mediaType: "application/yaml",
      encoding: "utf-8",
    });
    await expect(classify([bytes])).resolves.toEqual({
      kind: "binary",
    });
  });

  it("accepts a UTF-8 BOM and code points split across chunks", async () => {
    const bytes = encoder.encode("\uFEFFhello 世界\n");
    const classifier = createResourceMimeClassifier({ filename: "message.txt" });

    classifier.observe(bytes.subarray(0, 10));
    classifier.observe(bytes.subarray(10, 11));
    classifier.observe(bytes.subarray(11));

    await expect(classifier.finish()).resolves.toEqual({
      kind: "text",
      mediaType: "text/plain",
      encoding: "utf-8",
    });
  });

  it("rejects invalid and truncated UTF-8 sequences split across chunks", async () => {
    await expect(
      classify([new Uint8Array([0x68, 0xc3]), new Uint8Array([0x28, 0x69])], {
        filename: "message.txt",
      }),
    ).resolves.toEqual({ kind: "binary" });

    await expect(
      classify([new Uint8Array([0x68, 0x69, 0xe2, 0x82])], { declaredMediaType: "text/plain" }),
    ).resolves.toEqual({ kind: "binary" });
  });

  it("treats NUL-containing hinted text as binary", async () => {
    await expect(
      classify([encoder.encode("before"), new Uint8Array([0]), encoder.encode("after")], {
        filename: "message.txt",
      }),
    ).resolves.toEqual({ kind: "binary" });
  });

  it("bounds retained signature bytes without truncating streaming UTF-8 validation", async () => {
    const classifier = createResourceMimeClassifier({
      filename: "message.txt",
      maxPrefixBytes: 4,
    });
    classifier.observe(encoder.encode("abcd"));
    classifier.observe(new Uint8Array([0xe2]));
    classifier.observe(new Uint8Array([0x28]));

    await expect(classifier.finish()).resolves.toEqual({
      kind: "binary",
    });
  });

  it("separates bounded prefix classification from full-stream UTF-8 validation", async () => {
    await expect(
      classifyResourcePrefix({
        prefix: new Uint8Array([0x68, 0x69, 0xe2]),
        filename: "message.txt",
      }),
    ).resolves.toEqual({ kind: "text", mediaType: "text/plain", encoding: "utf-8" });

    const validator = createUtf8ResourceValidator();
    expect(validator.observe(new Uint8Array([0x68, 0x69, 0xe2])).isOk()).toBe(true);
    expect(validator.observe(new Uint8Array([0x82, 0xac])).isOk()).toBe(true);
    expect(validator.finish().isOk()).toBe(true);

    const invalid = createUtf8ResourceValidator();
    expect(invalid.observe(new Uint8Array([0xe2])).isOk()).toBe(true);
    expect(invalid.observe(new Uint8Array([0x28])).isErr()).toBe(true);
  });

  it("recognizes structured text types and rejects binary image declarations as text", () => {
    expect(isResourceTextMediaType("application/vnd.api+json")).toBe(true);
    expect(isResourceTextMediaType("image/svg+xml; charset=utf-8")).toBe(true);
    expect(isResourceTextMediaType("image/png")).toBe(false);
  });
});
