import { expect, test } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("release artifacts require reusable CI at their exact SHA after a token-authenticated sync", async () => {
  const workflow = Bun.YAML.parse(await Bun.file(".github/workflows/release.yaml").text()) as {
    jobs: Record<
      string,
      { needs?: string | string[]; if?: string; uses?: string; with?: Record<string, string> }
    >;
  };
  const verify = workflow.jobs.verify;
  expect(verify?.uses).toBe("./.github/workflows/ci.yml");
  expect(verify?.with?.ref).toBe("${{ github.sha }}");
  expect(verify?.with?.upstream_ref).toBe("${{ needs.release-info.outputs.upstream-ref }}");
  expect(verify?.if).toBe("needs.release-info.outputs.should-release == 'true'");
  expect(workflow.jobs.images?.needs).toEqual(["release-info", "verify"]);
  // Every later artifact publication depends transitively on the verified image build.
  expect(workflow.jobs["image-manifests"]?.needs).toContain("images");
  expect(workflow.jobs.cli?.needs).toContain("image-manifests");
  expect(workflow.jobs.publish?.needs).toContain("cli");
});

test("inherited release keeps the fork Catalina latest tag owned by variant publication", async () => {
  const workflow = Bun.YAML.parse(await Bun.file(".github/workflows/release.yaml").text()) as {
    jobs: { publish: { steps: { name: string; run?: string }[] } };
  };
  const publish = workflow.jobs.publish.steps.find(
    (step) => step.name === "Update convenience image tags",
  )!;
  const root = await mkdtemp(path.join(tmpdir(), "release-tags-"));
  try {
    const calls = path.join(root, "calls");
    await writeFile(
      path.join(root, "docker"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$DOCKER_CALLS"\n',
      { mode: 0o755 },
    );
    const child = Bun.spawn(["bash", "-eu", "-c", publish.run!], {
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        GITHUB_REPOSITORY: "DF-wu/lilac-mono",
        CORE: "ghcr.io/df-wu/lilac-mono@sha256:core",
        GATEWAY: "gateway@sha256:gateway",
        RUNNER: "runner@sha256:runner",
        DOCKER_CALLS: calls,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(await child.exited).toBe(0);
    const published = await Bun.file(calls).text();
    expect(published).not.toContain("ghcr.io/df-wu/lilac-mono:latest");
    expect(published).toContain("--tag gateway:latest gateway@sha256:gateway");
    expect(published).toContain("--tag runner:latest runner@sha256:runner");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
