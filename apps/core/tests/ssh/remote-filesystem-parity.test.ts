import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { FileSystem, fzfFileSearch, type ReadFileOptions } from "@stanley2058/lilac-fs";
import type { Result as ResultType } from "better-result";

import { applyHunksResult, parsePatchResult } from "../../src/tools/apply-patch/apply-patch-core";
import { remoteApplyPatch } from "../../src/tools/apply-patch/remote-apply-patch";
import {
  remoteEditFile,
  remoteFuzzySearch,
  remoteGlob,
  remoteGrep,
  remoteReadFileBytes,
  remoteReadTextFile,
} from "../../src/tools/fs/remote-fs";

// Runs each filesystem operation locally and over the SSH shim against the native runner, on the
// same files, and expects identical results. The shim runs remote commands through `sh -c` with a
// separate HOME, standing in for an SSH host.
const HOST = "parity-host";
const TEST_TIMEOUT_MS = 60_000;

let tempDir = "";
let tree = "";
let denyPaths: string[] = [];
let previousPath: string | undefined;
let previousSshConfigPath: string | undefined;

const FILES: Record<string, string | Uint8Array> = {
  "plain.txt": "alpha\nbeta\ngamma\n",
  "crlf.txt": "one\r\ntwo\r\nthree",
  "unicode.txt": "héllo wörld\n😀 emoji line\n中文字符 here\n",
  "invalid.txt": new Uint8Array([0x61, 0xff, 0x62, 0x0a, 0xe2, 0x82, 0x0a, 0x63]),
  "long.txt": `${"x".repeat(3000)}\nshort\n`,
  "empty.txt": "",
  "lone-cr.txt": "a\rb\r\nc\r",
  "big.txt": Array.from(
    { length: 400 },
    (_, index) => `line ${index + 1} ${"é".repeat(index % 7)}`,
  ).join("\n"),
  "src/app.ts": "export const app = 'alpha';\nconsole.log(app);\n",
  "src/lib/util.ts": "export function util() {\n  return 'beta util';\n}\n",
  "src/lib/util.test.ts": "import { util } from './util';\nutil();\n",
  "src/.hidden.ts": "const hiddenAlpha = 1;\n",
  ".config/settings.json": '{ "alpha": true }\n',
  "docs/readme.md": "# Readme\nalpha beta\n",
  "node_modules/pkg/index.js": "module.exports = 'alpha';\n",
  "binary.dat": new Uint8Array([0x61, 0x6c, 0x70, 0x68, 0x61, 0x00, 0x01, 0x02, 0x0a]),
  "secret/key.txt": "alpha secret\n",
  ".ignore": "ignored.txt\n",
  "ignored.txt": "alpha ignored\n",
};

async function writeTree(root: string) {
  for (const [relativePath, content] of Object.entries(FILES)) {
    await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
    await writeFile(path.join(root, relativePath), content);
  }
  await symlink("src", path.join(root, "linked"));
}

beforeAll(async () => {
  tempDir = await realpath(await mkdtemp(path.join(tmpdir(), "lilac-remote-fs-parity-")));
  tree = path.join(tempDir, "tree");
  const remoteHome = path.join(tempDir, "home");
  const binDir = path.join(tempDir, "bin");
  await mkdir(remoteHome, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeTree(tree);
  await symlink("plain.txt", path.join(tree, "plain-alias.txt"));
  denyPaths = [path.join(tree, "secret")];
  const ssh = path.join(binDir, "ssh");
  await writeFile(
    ssh,
    `#!/usr/bin/env bash
set -euo pipefail
while [ "$#" -gt 0 ]; do
  case "$1" in
    -T) shift ;;
    -o) shift 2 ;;
    *) break ;;
  esac
done
shift
export HOME=${JSON.stringify(remoteHome)}
unset XDG_CACHE_HOME
exec sh -c "$*"
`,
  );
  await chmod(ssh, 0o755);
  const sshConfigPath = path.join(tempDir, "ssh-config");
  await writeFile(sshConfigPath, `Host ${HOST}\n  HostName 127.0.0.1\n`);
  previousPath = process.env.PATH;
  previousSshConfigPath = process.env.LILAC_SSH_CONFIG_PATH;
  process.env.PATH = `${binDir}:${previousPath ?? ""}`;
  process.env.LILAC_SSH_CONFIG_PATH = sshConfigPath;
});

afterAll(async () => {
  process.env.PATH = previousPath;
  if (previousSshConfigPath === undefined) delete process.env.LILAC_SSH_CONFIG_PATH;
  else process.env.LILAC_SSH_CONFIG_PATH = previousSshConfigPath;
  await rm(tempDir, { recursive: true, force: true });
});

function local(root = tree) {
  return new FileSystem(root, { denyPaths });
}

function unwrap<T, E>(result: ResultType<T, E>): T {
  return result.match({
    ok: (value) => value,
    err: (error) => {
      throw error;
    },
  });
}

// Bun on macOS names `lstat` in a failed `fs.promises.realpath`; Node, and Bun on Linux, name
// `realpath`, as the runner does.
function sameRealpathSyscall<T>(value: T): T {
  if (process.platform !== "darwin") return value;
  return JSON.parse(JSON.stringify(value).replaceAll(", lstat '", ", realpath '")) as T;
}

function withoutBackend<T>(value: T): T {
  if (!value || typeof value !== "object") return value;
  const { effectiveBackend: _ignored, ...rest } = value as Record<string, unknown>;
  return rest as T;
}

describe("remote filesystem parity", () => {
  const readCases: ReadFileOptions[] = [
    {},
    { format: "numbered" },
    { format: "hashline" },
    { start: { type: "line", line: 2 } },
    { start: { type: "line", line: 1, column: 3 }, maxLines: 2 },
    { start: { type: "offset", offset: 5 }, maxLines: 2 },
    { start: { type: "offset", offset: 0 }, maxCharacters: 9 },
    { maxCharacters: 7 },
    { maxBytes: 6 },
    { start: { type: "line", line: 100 } },
    { format: "hashline", start: { type: "line", line: 1, column: 2 } },
    { format: "numbered", start: { type: "line", line: 395 }, maxLines: 10 },
  ];
  const readFiles = [
    "plain.txt",
    "crlf.txt",
    "unicode.txt",
    "invalid.txt",
    "long.txt",
    "empty.txt",
    "lone-cr.txt",
    "big.txt",
    "secret/key.txt",
    "missing.txt",
    "src",
  ];

  it(
    "reads text windows identically",
    async () => {
      for (const file of readFiles) {
        for (const options of readCases) {
          const input = { path: file, ...options };
          const expected = await local().readFile(input);
          const actual = unwrap(
            await remoteReadTextFile({ host: HOST, cwd: tree, input, denyPaths }),
          );
          expect({ file, options, result: sameRealpathSyscall(actual) }).toEqual({
            file,
            options,
            result: sameRealpathSyscall(expected),
          });
        }
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reads bytes identically",
    async () => {
      const cases = [
        { filePath: "plain.txt", maxBytes: 1_000 },
        { filePath: "binary.dat", maxBytes: 1_000 },
        { filePath: "big.txt", maxBytes: 1_000_000, prefixBytes: 16 },
        { filePath: "plain.txt", maxBytes: 3 },
        { filePath: "secret/key.txt", maxBytes: 1_000 },
        { filePath: "missing.txt", maxBytes: 1_000 },
      ];
      for (const input of cases) {
        const expected = await local().readFileBytes({ path: input.filePath, ...input });
        const actual = unwrap(
          await remoteReadFileBytes({ host: HOST, cwd: tree, denyPaths, ...input }),
        );
        if (expected.success) {
          expect(actual).toEqual({
            ok: true,
            resolvedPath: expected.resolvedPath,
            fileHash: expected.fileHash,
            bytesLength: expected.bytesLength,
            ...(expected.totalBytes === undefined ? {} : { totalBytes: expected.totalBytes }),
            base64: Buffer.from(expected.bytes).toString("base64"),
          });
        } else {
          expect(sameRealpathSyscall(actual)).toEqual({
            ok: false,
            resolvedPath: expected.resolvedPath,
            error: sameRealpathSyscall(expected.error.message),
            errorCode: expected.error.code,
          });
        }
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "globs the same entries",
    async () => {
      const cases: { patterns: string[]; mode?: "default" | "detailed"; maxEntries?: number }[] = [
        { patterns: ["**/*.ts"] },
        { patterns: ["src/**"] },
        { patterns: ["*.txt"] },
        { patterns: ["**/*.ts", "!**/*.test.ts"] },
        { patterns: ["./**/*.ts", "!./**/*.test.ts"] },
        { patterns: ["././src/*", "!././src/lib"] },
        { patterns: ["src/*"], mode: "detailed" },
        { patterns: [".config/*"] },
        { patterns: ["**/node_modules/**"] },
        { patterns: ["linked/*"] },
        { patterns: ["./linked/*"] },
        { patterns: ["././linked/*"] },
        { patterns: ["linked/*"], mode: "detailed" },
        { patterns: ["./linked/*"], mode: "detailed" },
        { patterns: ["**/*.{ts,md}"] },
        { patterns: ["src/lib/"] },
        { patterns: ["+(src|docs)/**"] },
        { patterns: ["./+(src|docs)/**", "!./src/lib/**"] },
        { patterns: ["**/*.json"], mode: "detailed" },
        { patterns: ["secret/**"] },
        { patterns: [path.join(tree, "docs/*.md")] },
      ];
      for (const input of cases) {
        const expected = withoutBackend(
          await local().glob({
            patterns: input.patterns,
            maxEntries: input.maxEntries,
            mode: input.mode ?? "default",
          }),
        );
        const actual = withoutBackend(
          unwrap(await remoteGlob({ host: HOST, cwd: tree, denyPaths, ...input })),
        );
        const sorted = (value: typeof expected) =>
          value.mode === "default"
            ? { ...value, paths: [...value.paths].sort() }
            : {
                ...value,
                entries: [...value.entries].sort((a, b) => a.path.localeCompare(b.path)),
              };
        expect({ input, result: sorted(actual) }).toEqual({ input, result: sorted(expected) });
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "caps explicit directory-symlink roots like the local walker in both modes",
    async () => {
      const root = path.join(tempDir, "capped-linked-glob");
      await mkdir(path.join(root, "target"), { recursive: true });
      await writeFile(path.join(root, "target/child.txt"), "child\n");
      await symlink("target", path.join(root, "linked"));
      const denyPaths = [path.join(root, "denied")];
      for (const pattern of ["linked/*", "./linked/*", "././linked/*"]) {
        for (const mode of ["default", "detailed"] as const) {
          for (const maxEntries of [1, 2]) {
            const input = { patterns: [pattern], mode, maxEntries };
            const expected = withoutBackend(await new FileSystem(root, { denyPaths }).glob(input));
            const actual = withoutBackend(
              unwrap(await remoteGlob({ host: HOST, cwd: root, denyPaths, ...input })),
            );
            expect({ input, result: actual }).toEqual({ input, result: expected });
          }
        }
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "greps the same matches",
    async () => {
      const cases: {
        cwd?: string;
        pattern: string;
        regex?: boolean;
        fileExtensions?: string[];
        mode?: "default" | "detailed" | "hashline";
        maxResults?: number;
      }[] = [
        { pattern: "alpha" },
        { pattern: "l[a-z]+a", regex: true, mode: "detailed" },
        { pattern: "a$", regex: true, mode: "detailed" },
        { pattern: "\\s", regex: true, mode: "detailed", cwd: path.join(tree, "crlf.txt") },
        { pattern: "\\s", regex: true, mode: "detailed", cwd: path.join(tree, "unicode.txt") },
        { pattern: "$", regex: true, mode: "detailed", cwd: path.join(tree, "plain.txt") },
        { pattern: "util", fileExtensions: ["ts"] },
        { pattern: "beta", mode: "hashline" },
        { pattern: "gamma", cwd: path.join(tree, "plain.txt"), mode: "hashline" },
        { pattern: "gamma", cwd: path.join(tree, "plain-alias.txt"), mode: "detailed" },
        { pattern: "gamma", cwd: path.join(tree, "plain-alias.txt"), mode: "hashline" },
        { pattern: "emoji", cwd: path.join(tree, "unicode.txt"), mode: "detailed" },
        { pattern: "x", cwd: path.join(tree, "long.txt"), mode: "hashline" },
        { pattern: "nothing-matches-this" },
      ];
      for (const input of cases) {
        const cwd = input.cwd ?? tree;
        const expected = withoutBackend(
          await local(cwd).grep({
            pattern: input.pattern,
            baseDir: cwd,
            reportedFilePath: cwd,
            regex: input.regex,
            maxResults: input.maxResults,
            fileExtensions: input.fileExtensions,
            mode: input.mode ?? "default",
          }),
        );
        const actual = withoutBackend(
          unwrap(await remoteGrep({ host: HOST, cwd, denyPaths, input })),
        );
        const sorted = (value: typeof expected) => ({
          ...value,
          results: [...value.results].sort((a, b) =>
            a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
          ),
        });
        expect({ input, result: sorted(actual) }).toEqual({ input, result: sorted(expected) });
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "ranks fuzzy matches like the local fzf fallback",
    async () => {
      for (const query of ["util", "readme", "zzz"]) {
        const expected = await fzfFileSearch({
          cwd: tree,
          query,
          maxResults: 10,
          denyPaths,
          dangerouslyAllow: false,
        });
        const actual = unwrap(
          await remoteFuzzySearch({
            host: HOST,
            cwd: tree,
            denyPaths,
            input: { query, maxResults: 10 },
          }),
        );
        expect(actual).toEqual(expected!);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "edits files the same way",
    async () => {
      const localTree = path.join(tempDir, "edit-local");
      const remoteTree = path.join(tempDir, "edit-remote");
      await cp(tree, localTree, { recursive: true, verbatimSymlinks: true });
      await cp(tree, remoteTree, { recursive: true, verbatimSymlinks: true });
      const edits = [
        [{ type: "replace_range", range: { startLine: 1, endLine: 1 }, newText: "ALPHA" }],
        [{ type: "insert_at", line: 2, newText: "inserted" }],
        [{ type: "delete_range", range: { startLine: 2, endLine: 3 } }],
        [{ type: "replace_snippet", target: "beta", newText: "BETA" }],
        [
          {
            type: "replace_snippet",
            target: "l+",
            matching: "regex",
            newText: "L",
            occurrence: "all",
          },
        ],
        [{ type: "replace_snippet", target: "missing", newText: "x" }],
      ] as const;
      for (const [index, edit] of edits.entries()) {
        const file = `edit-${index}.txt`;
        await writeFile(path.join(localTree, file), "alpha\nbeta\ngamma\nbeta again\n");
        await writeFile(path.join(remoteTree, file), "alpha\nbeta\ngamma\nbeta again\n");
        const localFs = local(localTree);
        const read = await localFs.readFile({ path: file });
        if (!read.success) throw new Error("fixture read failed");
        const expected = await localFs.editFile({
          path: file,
          edits: [...edit],
          expectedHash: read.fileHash,
        });
        const actual = unwrap(
          await remoteEditFile({
            host: HOST,
            cwd: remoteTree,
            denyPaths,
            input: { path: file, edits: [...edit] },
          }),
        );
        const normalize = (value: object, root: string) =>
          JSON.parse(JSON.stringify(value).replaceAll(root, "<tree>"));
        const { errors: _errors, ...expectedWithoutErrors } = expected as typeof expected & {
          errors?: unknown;
        };
        expect(normalize(actual, remoteTree)).toEqual(normalize(expectedWithoutErrors, localTree));
        expect(await readFile(path.join(remoteTree, file), "utf8")).toBe(
          await readFile(path.join(localTree, file), "utf8"),
        );
      }

      const hashline = await local(localTree).readFile({ path: "plain.txt", format: "hashline" });
      if (!hashline.success || hashline.format !== "hashline")
        throw new Error("hashline read failed");
      const anchor = hashline.hashlineContent.split("\n")[1]!.split("|")[0]!;
      const hashlineEdits = [{ op: "replace" as const, pos: anchor, lines: ["BETA"] }];
      const expected = await local(localTree).hashlineEditFile({
        path: "plain.txt",
        edits: hashlineEdits,
        expectedHash: hashline.fileHash,
      });
      const actual = unwrap(
        await remoteEditFile({
          host: HOST,
          cwd: remoteTree,
          denyPaths,
          input: {
            path: "plain.txt",
            edits: hashlineEdits,
            mode: "hashline",
            expectedHash: hashline.fileHash,
          },
        }),
      );
      expect(JSON.stringify(actual).replaceAll(remoteTree, "<tree>")).toBe(
        JSON.stringify(expected).replaceAll(localTree, "<tree>"),
      );
      expect(await readFile(path.join(remoteTree, "plain.txt"), "utf8")).toBe(
        await readFile(path.join(localTree, "plain.txt"), "utf8"),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps dangling symlinks in default glob paths without inventing metadata",
    async () => {
      const root = path.join(tempDir, "dangling-glob");
      await mkdir(path.join(root, "first"), { recursive: true });
      await mkdir(path.join(root, "other"));
      await symlink("missing.txt", path.join(root, "first/dangling.txt"));
      await writeFile(path.join(root, "other/present.txt"), "present\n");
      const patterns = ["first/*.txt", "other/*.txt"];
      const denyPaths = [path.join(root, "denied")];
      for (const mode of ["default", "detailed"] as const) {
        for (const maxEntries of [1, 10]) {
          const expected = withoutBackend(
            await new FileSystem(root, { denyPaths }).glob({ patterns, mode, maxEntries }),
          );
          const actual = withoutBackend(
            unwrap(
              await remoteGlob({ host: HOST, cwd: root, patterns, mode, maxEntries, denyPaths }),
            ),
          );
          expect(actual).toEqual(expected);
        }
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps fallback default paths independent from matched metadata errors",
    async () => {
      const root = path.join(tempDir, "loop-glob");
      await mkdir(root);
      await symlink("loop.txt", path.join(root, "loop.txt"));
      await writeFile(path.join(root, "present.txt"), "present\n");
      for (const patterns of [["*.txt"], ["+(loop|present).txt"], ["+(present).txt"]]) {
        for (const mode of ["default", "detailed"] as const) {
          const expected = withoutBackend(await local(root).glob({ patterns, mode }));
          const actual = withoutBackend(
            unwrap(await remoteGlob({ host: HOST, cwd: root, patterns, mode, denyPaths })),
          );
          const sorted = (value: typeof expected) =>
            value.mode === "default" ? { ...value, paths: [...value.paths].sort() } : value;
          expect({ patterns, mode, result: sorted(actual) }).toEqual({
            patterns,
            mode,
            result: sorted(expected),
          });
        }
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "resolves relative paths from the physical remote cwd",
    async () => {
      const root = path.join(tempDir, "symlink-cwd");
      const physical = path.join(root, "physical/work");
      const logical = path.join(root, "logical/work");
      await mkdir(physical, { recursive: true });
      await mkdir(path.dirname(logical));
      await symlink(physical, logical);
      await writeFile(path.join(root, "physical/target.txt"), "physical\n");
      await writeFile(path.join(root, "logical/target.txt"), "logical\n");
      const input = { path: "../target.txt" };
      const expected = await local(physical).readFile(input);
      const actual = unwrap(
        await remoteReadTextFile({ host: HOST, cwd: logical, input, denyPaths }),
      );
      expect(actual).toEqual(expected);

      const patch = [
        "*** Begin Patch",
        "*** Add File: ../created.txt",
        "+physical patch",
        "*** End Patch",
      ].join("\n");
      const applied = await remoteApplyPatch({ host: HOST, cwd: logical, patchText: patch });
      expect(applied.ok).toBeTrue();
      expect(await readFile(path.join(root, "physical/created.txt"), "utf8")).toBe(
        "physical patch",
      );
      await expect(readFile(path.join(root, "logical/created.txt"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "reports an unavailable cwd before reading or applying a patch",
    async () => {
      const cwd = path.join(tempDir, "missing-cwd");
      const read = await remoteReadTextFile({
        host: HOST,
        cwd,
        input: { path: "target.txt" },
        denyPaths,
      });
      expect(read.isErr()).toBeTrue();
      if (read.isErr()) expect(read.error.message).toContain("ENOENT");
      const applied = await remoteApplyPatch({
        host: HOST,
        cwd,
        patchText: "*** Begin Patch\n*** Add File: target.txt\n+blocked\n*** End Patch",
      });
      expect(applied.ok).toBeFalse();
      if (!applied.ok) expect(applied.error).toContain("ENOENT");
      await expect(readFile(path.join(cwd, "target.txt"), "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "rejects a regular file cwd before a patch can write outside it",
    async () => {
      const root = path.join(tempDir, "patch-file-cwd");
      await mkdir(root);
      const cwd = path.join(root, "file.txt");
      await writeFile(cwd, "original");
      const applied = await remoteApplyPatch({
        host: HOST,
        cwd,
        patchText: "*** Begin Patch\n*** Add File: ../escaped.txt\n+blocked\n*** End Patch",
      });
      expect(applied.ok).toBeFalse();
      if (!applied.ok) expect(applied.error).toContain("ENOTDIR");
      await expect(readFile(path.join(root, "escaped.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(cwd, "utf8")).toBe("original");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "denies a retargeted denied symlink on the next call",
    async () => {
      const root = path.join(tempDir, "deny-retarget");
      await mkdir(path.join(root, "a"), { recursive: true });
      await mkdir(path.join(root, "b"), { recursive: true });
      await writeFile(path.join(root, "a/secret.txt"), "a secret\n");
      await writeFile(path.join(root, "b/secret.txt"), "b secret\n");
      const link = path.join(root, "denied");
      await symlink("a", link);
      const deny = [link];
      const read = (file: string) =>
        remoteReadTextFile({ host: HOST, cwd: root, input: { path: file }, denyPaths: deny });

      expect(unwrap(await read("a/secret.txt")).success).toBeFalse();
      await rm(link);
      await symlink("b", link);
      expect(unwrap(await read("b/secret.txt")).success).toBeFalse();
      expect(unwrap(await read("a/secret.txt")).success).toBeTrue();
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "applies patches the same way",
    async () => {
      const localTree = path.join(tempDir, "patch-local");
      const remoteTree = path.join(tempDir, "patch-remote");
      await cp(tree, localTree, { recursive: true, verbatimSymlinks: true });
      await cp(tree, remoteTree, { recursive: true, verbatimSymlinks: true });
      const patch = [
        "*** Begin Patch",
        "*** Add File: added/new.txt",
        "+brand new",
        "*** Update File: crlf.txt",
        "@@",
        " one",
        "-two",
        "+TWO",
        "*** Delete File: empty.txt",
        "*** Update File: src/app.ts",
        "*** Move to: src/moved.ts",
        "@@",
        "-console.log(app);",
        "+console.info(app);",
        "*** End Patch",
      ].join("\n");
      const hunks = parsePatchResult(patch).match({
        ok: (value) => value,
        err: (error) => {
          throw error;
        },
      });
      const expected = await applyHunksResult(localTree, hunks, { denyPaths });
      const actual = await remoteApplyPatch({ host: HOST, cwd: remoteTree, patchText: patch });
      expect(actual).toEqual(
        expected.match<{ ok: true; output: string } | { ok: false; error: string }>({
          ok: (output) => ({ ok: true, output }),
          err: (error) => ({ ok: false, error: error.message }),
        }),
      );
      for (const file of ["added/new.txt", "crlf.txt", "src/moved.ts"]) {
        expect(await readFile(path.join(remoteTree, file), "utf8")).toBe(
          await readFile(path.join(localTree, file), "utf8"),
        );
      }
      await expect(readFile(path.join(remoteTree, "empty.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
    TEST_TIMEOUT_MS,
  );
});
