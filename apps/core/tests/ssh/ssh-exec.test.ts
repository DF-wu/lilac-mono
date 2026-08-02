import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";

import { readStreamTextCapped, sshExecBash, sshExecScriptJson } from "../../src/ssh/ssh-exec";
import { remoteFuzzySearch } from "../../src/tools/fs/remote-fs";

describe("ssh exec transport", () => {
  let tempDir = "";
  let binDir = "";
  let previousPath: string | undefined;
  let previousSshConfigPath: string | undefined;
  let previousRemoteRunnerCommand: string | undefined;
  let previousRemoteRunnerPackage: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "lilac-ssh-exec-"));

    binDir = path.join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });

    const sshPath = path.join(binDir, "ssh");
    await writeFile(
      sshPath,
      `#!/usr/bin/env bash
set -euo pipefail

while [ "$#" -gt 0 ]; do
  if [ "$1" = "-T" ]; then
    shift
    continue
  fi

  if [ "$1" = "-o" ]; then
    shift 2
    continue
  fi

  shift
  break
done

exec "$@"
`,
      "utf8",
    );
    await chmod(sshPath, 0o755);

    const sshConfigPath = path.join(tempDir, "ssh-config");
    await writeFile(sshConfigPath, "Host fakehost\n  HostName 127.0.0.1\n  User tester\n", "utf8");

    previousPath = process.env.PATH;
    previousSshConfigPath = process.env.LILAC_SSH_CONFIG_PATH;
    previousRemoteRunnerCommand = process.env.LILAC_REMOTE_FS_RUNNER_COMMAND;
    previousRemoteRunnerPackage = process.env.LILAC_REMOTE_FS_RUNNER_PACKAGE;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    process.env.LILAC_SSH_CONFIG_PATH = sshConfigPath;
    delete process.env.LILAC_REMOTE_FS_RUNNER_COMMAND;
    delete process.env.LILAC_REMOTE_FS_RUNNER_PACKAGE;
  });

  afterEach(async () => {
    process.env.PATH = previousPath;

    if (previousSshConfigPath === undefined) {
      delete process.env.LILAC_SSH_CONFIG_PATH;
    } else {
      process.env.LILAC_SSH_CONFIG_PATH = previousSshConfigPath;
    }
    if (previousRemoteRunnerCommand === undefined) {
      delete process.env.LILAC_REMOTE_FS_RUNNER_COMMAND;
    } else {
      process.env.LILAC_REMOTE_FS_RUNNER_COMMAND = previousRemoteRunnerCommand;
    }
    if (previousRemoteRunnerPackage === undefined) {
      delete process.env.LILAC_REMOTE_FS_RUNNER_PACKAGE;
    } else {
      process.env.LILAC_REMOTE_FS_RUNNER_PACKAGE = previousRemoteRunnerPackage;
    }

    await rm(tempDir, { recursive: true, force: true });
  });

  it("runs large remote commands without passing them as a bash argument", async () => {
    const padding = "x".repeat(200_000);

    const result = await sshExecBash({
      host: "fakehost",
      cmd: `printf ok\n# ${padding}\n`,
      cwd: "~",
      timeoutMs: 5_000,
      maxOutputChars: 10_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("ok");
  });

  it("runs large JSON runner scripts over ssh", async () => {
    const padding = "x".repeat(200_000);
    const js = `const padding = ${JSON.stringify(padding)};\nprocess.stdout.write(JSON.stringify({ ok: true, value: padding.length }));\n`;

    const result = await sshExecScriptJson<number>({
      host: "fakehost",
      cwd: "~",
      js,
      input: { op: "noop" },
      timeoutMs: 5_000,
      maxOutputChars: 10_000,
    });

    expect(result).toEqual({ ok: true, value: 200_000 });
  });

  it("preserves empty positional parameters for remote commands", async () => {
    const result = await sshExecBash({
      host: "fakehost",
      cmd: 'printf "%s" "${1:-missing}"',
      cwd: "~",
      timeoutMs: 5_000,
      maxOutputChars: 10_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("missing");
  });

  it("does not copy raw stream chunks when overflow retention is disabled", async () => {
    const bytes = new TextEncoder().encode("ab😀Z");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 3));
        controller.enqueue(bytes.slice(3));
        controller.close();
      },
    });
    const bufferFromSpy = spyOn(Buffer, "from");
    let rawCopyCalls = 0;

    try {
      const result = await readStreamTextCapped(stream, 4);
      rawCopyCalls = bufferFromSpy.mock.calls.length;

      expect(result).toEqual({ text: "ab😀", totalChars: 5, capped: true });
    } finally {
      bufferFromSpy.mockRestore();
    }

    expect(rawCopyCalls).toBe(0);
  });

  it("reports activity only for non-empty raw chunks", async () => {
    let activityCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array());
        controller.enqueue(new TextEncoder().encode("output"));
        controller.close();
      },
    });

    const result = await readStreamTextCapped(stream, 100, {
      onActivity: () => {
        activityCount += 1;
      },
    });

    expect(result.text).toBe("output");
    expect(activityCount).toBe(1);
  });

  it("creates secure byte-exact SSH overflow files only after the cap", async () => {
    const underLimitBase = path.join(tempDir, "under-limit");
    const underLimit = await sshExecBash({
      host: "fakehost",
      cmd: "printf small",
      timeoutMs: 5_000,
      maxOutputChars: 100,
      overflowOutputPath: underLimitBase,
    });

    expect(underLimit.capped).toEqual({ stdout: false, stderr: false });
    await expect(stat(`${underLimitBase}.stdout.part`)).rejects.toThrow();
    await expect(stat(`${underLimitBase}.stderr.part`)).rejects.toThrow();

    const overflowBase = path.join(tempDir, "overflow");
    const overflow = await sshExecBash({
      host: "fakehost",
      cmd: "printf stdout-content; printf stderr-content >&2",
      timeoutMs: 5_000,
      maxOutputChars: 5,
      overflowOutputPath: overflowBase,
    });
    const stdoutPath = `${overflowBase}.stdout.part`;
    const stderrPath = `${overflowBase}.stderr.part`;

    expect(overflow.stdout).toBe("stdou");
    expect(overflow.stderr).toBe("stder");
    expect(overflow.capped).toEqual({ stdout: true, stderr: true });
    expect(overflow.overflowPaths).toEqual({ stdout: stdoutPath, stderr: stderrPath });
    expect(await readFile(stdoutPath, "utf8")).toBe("stdout-content");
    expect(await readFile(stderrPath, "utf8")).toBe("stderr-content");
    expect((await stat(stdoutPath)).mode & 0o777).toBe(0o600);
    expect((await stat(stderrPath)).mode & 0o777).toBe(0o600);
  });

  it("retains exact non-ASCII, BOM, and malformed UTF-8 bytes in streaming overflow", async () => {
    const overflowPath = path.join(tempDir, "stream-bytes.part");
    const bytes = Uint8Array.from([
      0xef,
      0xbb,
      0xbf,
      ...Buffer.from("é", "utf8"),
      0xff,
      0xfe,
      ...Buffer.from("tail", "utf8"),
    ]);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 4));
        controller.enqueue(bytes.slice(4, 7));
        controller.enqueue(bytes.slice(7));
        controller.close();
      },
    });

    const result = await readStreamTextCapped(stream, 2, { overflowFilePath: overflowPath });

    expect(result.capped).toBeTrue();
    expect(result.text).toBe("é�");
    expect(result.overflowFilePath).toBe(overflowPath);
    expect(await readFile(overflowPath)).toEqual(Buffer.from(bytes));
  });

  it("retains exact non-ASCII, BOM, and malformed UTF-8 bytes in non-stream overflow", async () => {
    const overflowPath = path.join(tempDir, "fallback-bytes.part");
    const bytes = Uint8Array.from([
      0xef,
      0xbb,
      0xbf,
      ...Buffer.from("é", "utf8"),
      0xff,
      ...Buffer.from("tail", "utf8"),
    ]);

    const result = await readStreamTextCapped(new Blob([bytes]), 1, {
      overflowFilePath: overflowPath,
    });

    expect(result.capped).toBeTrue();
    expect(result.text).toBe("é");
    expect(result.overflowFilePath).toBe(overflowPath);
    expect(await readFile(overflowPath)).toEqual(Buffer.from(bytes));
  });

  it("does not clobber or remove pre-existing SSH overflow targets", async () => {
    const overflowBase = path.join(tempDir, "existing-overflow");
    const stdoutPath = `${overflowBase}.stdout.part`;
    const stderrPath = `${overflowBase}.stderr.part`;
    await writeFile(stdoutPath, "existing stdout", { mode: 0o640 });
    await writeFile(stderrPath, "existing stderr", { mode: 0o640 });

    const result = await sshExecBash({
      host: "fakehost",
      cmd: "printf stdout-content; printf stderr-content >&2",
      timeoutMs: 5_000,
      maxOutputChars: 5,
      overflowOutputPath: overflowBase,
    });

    expect(result.capped).toEqual({ stdout: true, stderr: true });
    expect(result.overflowPaths).toEqual({});
    expect(await readFile(stdoutPath, "utf8")).toBe("existing stdout");
    expect(await readFile(stderrPath, "utf8")).toBe("existing stderr");
    expect((await stat(stdoutPath)).mode & 0o777).toBe(0o640);
    expect((await stat(stderrPath)).mode & 0o777).toBe(0o640);
  });

  it("prefers bunx and passes JSON stdin to the default remote FFF runner command", async () => {
    const bunxPath = path.join(binDir, "bunx");
    await writeFile(
      bunxPath,
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${2:-}" != "request" ]; then
  printf '%s' '{"ok":false,"error":"unexpected bunx invocation"}'
  exit 0
fi
payload=$(cat)
if [[ "$payload" != *'"op":"fs.fuzzy_search"'* ]]; then
  printf '%s' '{"ok":false,"error":"missing fuzzy op"}'
  exit 0
fi
printf '%s' '{"ok":true,"value":{"results":[{"path":"package.json","fileName":"package.json","size":123,"gitStatus":"clean","score":1}],"totalMatched":1,"totalFiles":1,"truncated":false,"effectiveBackend":"fff"}}'
`,
      "utf8",
    );
    await chmod(bunxPath, 0o755);

    const npxPath = path.join(binDir, "npx");
    await writeFile(
      npxPath,
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s' '{"ok":false,"error":"npx should not be used when bunx exists"}'
`,
      "utf8",
    );
    await chmod(npxPath, 0o755);

    const result = await remoteFuzzySearch({
      host: "fakehost",
      cwd: tempDir,
      input: { query: "package json", maxResults: 5 },
      denyPaths: [],
      timeoutMs: 5_000,
    });

    expect(result).toEqual({
      results: [
        {
          path: "package.json",
          fileName: "package.json",
          size: 123,
          gitStatus: "clean",
          score: 1,
        },
      ],
      totalMatched: 1,
      totalFiles: 1,
      truncated: false,
      effectiveBackend: "fff",
    });
  });
});
