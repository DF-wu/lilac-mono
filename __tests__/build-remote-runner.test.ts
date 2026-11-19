import { expect, it } from "bun:test";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

it("copies the newly built runner when CARGO_TARGET_DIR points elsewhere", async () => {
  const fixture = await mkdtemp(path.join(tmpdir(), "lilac-runner-build-"));
  const target = "x86_64-unknown-linux-musl";
  const runner = path.join(fixture, "apps/remote-runner");
  const localArtifact = path.join(runner, "target", target, "release/lilac-remote");
  try {
    await mkdir(path.join(fixture, "scripts"), { recursive: true });
    await mkdir(path.dirname(localArtifact), { recursive: true });
    await mkdir(path.join(fixture, "bin"));
    await copyFile(
      new URL("../scripts/build-remote-runner.ts", import.meta.url),
      path.join(fixture, "scripts/build-remote-runner.ts"),
    );
    await copyFile(
      new URL("../apps/remote-runner/index.ts", import.meta.url),
      path.join(runner, "index.ts"),
    );
    await writeFile(localArtifact, "stale artifact");
    const cargo = path.join(fixture, "bin/cargo");
    await writeFile(
      cargo,
      `#!/bin/sh
target_dir="$CARGO_TARGET_DIR"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --target-dir) target_dir="$2"; shift 2 ;;
    --target) target="$2"; shift 2 ;;
    *) shift ;;
  esac
done
/bin/mkdir -p "$target_dir/$target/release"
printf 'fresh artifact' > "$target_dir/$target/release/lilac-remote"
`,
    );
    await chmod(cargo, 0o755);
    const child = Bun.spawn(
      [process.execPath, "scripts/build-remote-runner.ts", "--target", target],
      {
        cwd: fixture,
        env: {
          ...process.env,
          PATH: path.join(fixture, "bin"),
          CARGO_TARGET_DIR: path.join(fixture, "elsewhere"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(await readFile(path.join(runner, "dist", target, "lilac-remote"), "utf8")).toBe(
      "fresh artifact",
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
