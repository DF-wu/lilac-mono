import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function runInstall(corruptInstaller: boolean) {
  const directory = await mkdtemp(join(tmpdir(), "lilac-release-test-"));
  directories.push(directory);
  const marker = join(directory, "executed");
  const installer = '#!/usr/bin/env bash\nprintf "installer:%s\\n" "$*" >> "$TEST_MARKER"\n';
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  await Promise.all([
    writeFile(join(directory, "lilac-linux-x64"), installer),
    writeFile(
      join(directory, "SHA256SUMS"),
      `${corruptInstaller ? "0".repeat(64) : digest(installer)}  lilac-linux-x64\n`,
    ),
  ]);
  const source = await readFile(resolve(import.meta.dir, "../../../install.sh"), "utf8");
  const harness = `${source.replace(/\nlilac_main "\$@"\s*$/, "")}
lilac_check_machine() { lilac_os=linux; lilac_arch=x64; lilac_checksum_command=sha256sum; exec 3</dev/null; }
lilac_download() { cp "$TEST_RELEASE/\${1##*/}" "$2"; }
lilac_main demo
`;
  const child = Bun.spawn(["bash", "-c", harness], {
    env: {
      ...process.env,
      LILAC_RELEASE_BASE_URL: "https://release.invalid/test",
      TEST_RELEASE: directory,
      TEST_MARKER: marker,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  const executed = (await Bun.file(marker).exists()) ? await Bun.file(marker).text() : "";
  return { status, stderr, executed };
}

test("release bootstrap downloads only the installer", async () => {
  const result = await runInstall(false);
  expect(result.status).toBe(0);
  expect(result.executed).toBe("installer:--version\ninstaller:demo\n");
});

test("a corrupt installer prevents execution", async () => {
  const result = await runInstall(true);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("lilac checksum verification failed");
  expect(result.executed).toBe("");
});
