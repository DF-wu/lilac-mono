import { expect, test } from "bun:test";
import { parseFilePath, fileLanguage } from "../src/file-target";

test("inline file paths keep their destination, basename, and optional source line", () => {
  expect(parseFilePath("/tmp/example.md:123")).toEqual({
    type: "path",
    path: "/tmp/example.md",
    name: "example.md",
    line: 123,
  });
  expect(parseFilePath("~/.bashrc")).toEqual({ type: "path", path: "~/.bashrc", name: ".bashrc" });
  expect(parseFilePath("../src/My File.ts:12:4")).toEqual({
    type: "path",
    path: "../src/My File.ts",
    name: "My File.ts",
    line: 12,
  });
  for (const text of [
    "https://example.com/a.ts",
    "//example.com/a.ts",
    "const a = 1",
    "./",
    "/tmp/..",
    "./a\nb",
    "/tmp/a\0b",
    "/a.ts:9007199254740992",
  ])
    expect(parseFilePath(text)).toBeUndefined();
});

test("file source uses the chat highlighter's language names", () => {
  expect(fileLanguage("example.ts")).toBe("typescript");
  expect(fileLanguage("README.md")).toBe("markdown");
  expect(fileLanguage(".bashrc")).toBe("bash");
  expect(fileLanguage("Dockerfile")).toBe("dockerfile");
});

test("inline file ranges separate the path and retain both inclusive line bounds", () => {
  expect(
    parseFilePath("/tmp/lilac-native-integration-5LdtOX/workspace/example.ts:123-125"),
  ).toEqual({
    type: "path",
    path: "/tmp/lilac-native-integration-5LdtOX/workspace/example.ts",
    name: "example.ts",
    line: 123,
    endLine: 125,
  });
  expect(parseFilePath("~/notes.md:4-4")).toEqual({
    type: "path",
    path: "~/notes.md",
    name: "notes.md",
    line: 4,
    endLine: 4,
  });
  expect(parseFilePath("../example.ts:125-123")).toBeUndefined();
  expect(parseFilePath("../example.ts:1-9007199254740992")).toBeUndefined();
});
