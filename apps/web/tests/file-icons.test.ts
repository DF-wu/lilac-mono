import { expect, test } from "bun:test";
import { fileIconName } from "../src/file-icons";
import associations from "../src/assets/file-icons/associations.json";

test("file icons prefer filenames and compound extensions over generic types", () => {
  expect(fileIconName("/workspace/README.md")).toBe("readme");
  expect(fileIconName("package.json")).toBe("package-json");
  expect(fileIconName("Dockerfile")).toBe("docker");
  expect(fileIconName("example.test.ts")).toBe("typescript-test");
  expect(fileIconName("C:\\workspace\\App.TSX")).toBe("typescript-react");
  expect(fileIconName("~/.bashrc")).toBe("bash");
});

test("unknown attachment names fall back to MIME type or the generic file icon", () => {
  expect(fileIconName("download", "image/png")).toBe("image");
  expect(fileIconName("download", "audio/wav")).toBe("audio");
  expect(fileIconName("download", "video/mp4")).toBe("video");
  expect(fileIconName("download", "application/pdf")).toBe("pdf");
  expect(fileIconName("unknown.custom-extension")).toBe("_file");
  expect(fileIconName("__proto__")).toBe("_file");
});

test("every file association and fallback has a bundled SVG symbol", async () => {
  const sprite = await Bun.file(
    new URL("../src/assets/file-icons/catppuccin.svg", import.meta.url),
  ).text();
  const symbols = new Set([...sprite.matchAll(/<symbol id="([^"]+)"/g)].map((match) => match[1]));
  const icons = new Set([
    ...Object.values(associations.fileNames),
    ...Object.values(associations.fileExtensions),
    ...Object.values(associations.languageIds),
    "_file",
    "bash",
    "image",
    "audio",
    "video",
    "pdf",
  ]);
  for (const icon of icons) expect(symbols.has(icon)).toBe(true);
});
