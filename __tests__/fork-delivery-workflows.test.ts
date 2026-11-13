import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

type Step = { name: string; run?: string; uses?: string; with?: Record<string, unknown> };
type Job = {
  concurrency?: { group: string; "cancel-in-progress": boolean };
  needs?: string[];
  if?: string;
  uses?: string;
  permissions?: Record<string, string>;
  with?: Record<string, string>;
  steps?: Step[];
};
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function workflow(name: string): Promise<Workflow> {
  return Bun.YAML.parse(await Bun.file(`.github/workflows/${name}`).text()) as Workflow;
}

async function imageStep(name: string): Promise<string> {
  const image = await workflow("build-image.yml");
  const step = Object.values(image.jobs)
    .flatMap((job) => job.steps ?? [])
    .find((item) => item.name === name);
  expect(step?.run).toBeDefined();
  return step!.run!;
}

async function runGate(
  overrides: Record<string, string> = {},
): Promise<{ exitCode: number; argumentsText: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "lilac-publication-gate-"));
  temporaryRoots.push(root);
  const argumentsFile = path.join(root, "arguments");
  await writeFile(
    path.join(root, "git"),
    '#!/bin/sh\ncase "$1" in\nrev-parse) printf "%s\\n" "$CHECKOUT_SHA" ;;\nls-remote) printf "%s\\trefs/heads/main\\n" "$MAIN_SHA" ;;\nesac\n',
    { mode: 0o755 },
  );
  await writeFile(
    path.join(root, "gh"),
    '#!/bin/sh\nprintf "%s\\n" "$*" > "$GATE_ARGUMENTS"\nprintf "%s\\n" "$GATE_COUNT"\n',
    { mode: 0o755 },
  );
  const child = Bun.spawn(
    [
      "bash",
      "-eu",
      "-o",
      "pipefail",
      "-c",
      await imageStep("Require verification for the exact published commit"),
    ],
    {
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        PUBLISH_SHA: "candidate-sha",
        CHECKOUT_SHA: "candidate-sha",
        MAIN_SHA: "candidate-sha",
        VERIFIED_SHA: "",
        GITHUB_REPOSITORY: "owner/repo",
        GATE_COUNT: "1",
        GATE_ARGUMENTS: argumentsFile,
        ...overrides,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return {
    exitCode: await child.exited,
    argumentsText: (await Bun.file(argumentsFile).exists())
      ? await Bun.file(argumentsFile).text()
      : "",
  };
}

test("image publication requires successful push CI for the exact direct/manual SHA", async () => {
  const passed = await runGate();
  expect(passed.exitCode).toBe(0);
  expect(passed.argumentsText).toContain("head_sha=candidate-sha");
  expect(passed.argumentsText).toContain("event=push");
  expect(passed.argumentsText).toContain("status=success");
  expect((await runGate({ GATE_COUNT: "0" })).exitCode).toBe(1);
});

test("image publication rejects a different checkout and stale main", async () => {
  expect((await runGate({ CHECKOUT_SHA: "wrong-sha" })).exitCode).toBe(1);
  expect((await runGate({ MAIN_SHA: "newer-sha" })).exitCode).toBe(1);
});

test("sync publication accepts only its exact verified candidate", async () => {
  const passed = await runGate({ VERIFIED_SHA: "candidate-sha", GATE_COUNT: "0" });
  expect(passed.exitCode).toBe(0);
  expect(passed.argumentsText).toBe("");
  expect((await runGate({ VERIFIED_SHA: "different-sha" })).exitCode).toBe(1);
});

test("sync publication depends on successful verification and fast-forward of its pinned candidate", async () => {
  const sync = await workflow("sync-upstream.yml");
  expect(sync.jobs.images?.needs).toEqual(["prepare", "verify", "publish"]);
  expect(sync.jobs.images?.uses).toBe("./.github/workflows/build-image.yml");
  expect(sync.jobs.images?.with?.verified_sha).toBe("${{ needs.prepare.outputs.candidate_sha }}");
  expect(sync.jobs.images?.permissions?.actions).toBe("read");
  expect(sync.jobs.verify?.with?.ref).toBe("${{ needs.prepare.outputs.candidate_sha }}");
  const publish =
    sync.jobs.publish?.steps?.find(
      (step) => step.name === "Fast-forward main to the verified candidate",
    )?.run ?? "";
  expect(publish).not.toContain("gh workflow run");
  expect(publish).toContain('test "$(git rev-parse origin/main)" = "$BASELINE_SHA"');
  expect(sync.jobs.images?.if).toContain("needs.verify.result == 'success'");
  expect(sync.jobs.images?.if).toContain("needs.publish.result == 'success'");
});

test("image workflow binds checkout, tags and build metadata to the publication SHA", async () => {
  const image = await workflow("build-image.yml");
  expect(image.on.workflow_call).toBeDefined();
  expect(image.on.workflow_run).toBeDefined();
  expect(image.on.push).toBeUndefined();
  const source = await Bun.file(".github/workflows/build-image.yml").text();
  expect(source).toContain("github.event.workflow_run.head_sha");
  expect(source).toContain("LILAC_BUILD_COMMIT=${{ env.PUBLISH_SHA }}");
  expect(source).toContain("value=${{ matrix.variant.tag }}-${{ steps.source.outputs.short_sha }}");
  expect(source).not.toContain("type=sha,");
});

test("image publishers serialize each variant across direct, manual and reusable invocations", async () => {
  const image = await workflow("build-image.yml");
  expect(image.jobs["build-and-push"]?.concurrency).toEqual({
    group: "fork-core-image-${{ github.repository }}-${{ matrix.variant.tag }}",
    "cancel-in-progress": false,
  });
});

test("all CI jobs check out the requested candidate and footprint is strict", async () => {
  const ci = await workflow("ci.yml");
  for (const job of Object.values(ci.jobs)) {
    const checkout = job.steps?.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.ref).toBe("${{ inputs.ref || github.sha }}");
  }
  const footprint = ci.jobs["fork-footprint"]?.steps?.find(
    (step) => step.name === "Check modified upstream files against the allowlist",
  );
  expect(footprint?.run).toContain("--strict");
  expect(ci.jobs["computer-use"]).toBeDefined();
});

test("ordinary merge conflicts produce a review path without publishing a candidate", async () => {
  const sync = await workflow("sync-upstream.yml");
  const prepare = sync.jobs.prepare?.steps?.find(
    (step) => step.name === "Attempt an ordinary Git merge on a candidate branch",
  );
  expect(prepare?.run).toBeDefined();
  const root = await mkdtemp(path.join(tmpdir(), "lilac-sync-conflict-"));
  temporaryRoots.push(root);
  const output = path.join(root, "output");
  const mutations = path.join(root, "mutations");
  await writeFile(
    path.join(root, "git"),
    '#!/bin/sh\ncase "$*" in\n"rev-parse origin/main") echo baseline ;;\n"rev-parse upstream/main") echo upstream ;;\n"merge-base --is-ancestor upstream baseline") exit 1 ;;\n"merge --no-ff --no-edit upstream") exit 1 ;;\n"ls-files --unmerged") echo unresolved ;;\npush*|*reset*|*rebase*|*checkout*) printf "%s\\n" "$*" >> "$MUTATIONS"; exit 1 ;;\nesac\n',
    { mode: 0o755 },
  );
  await writeFile(path.join(root, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const child = Bun.spawn(["bash", "-eu", "-o", "pipefail", "-c", prepare!.run!], {
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      GITHUB_OUTPUT: output,
      GITHUB_RUN_ID: "1",
      GITHUB_RUN_ATTEMPT: "1",
      SYNC_BRANCH: "automation/sync-upstream",
      EVENT_NAME: "workflow_dispatch",
      MUTATIONS: mutations,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(await child.exited).toBe(0);
  expect(await Bun.file(output).text()).toContain("mode=conflict");
  expect(await Bun.file(output).text()).not.toContain("candidate_sha=");
  expect(await Bun.file(mutations).exists()).toBe(false);
});

test("publication rechecks main after image verification before pushing tags", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "lilac-image-push-"));
  temporaryRoots.push(root);
  await writeFile(
    path.join(root, "git"),
    '#!/bin/sh\nprintf "%s\\trefs/heads/main\\n" "$MAIN_SHA"\n',
    { mode: 0o755 },
  );
  const pushes = path.join(root, "pushes");
  await writeFile(path.join(root, "docker"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PUSHES"\n', {
    mode: 0o755,
  });
  const child = Bun.spawn(
    ["bash", "-eu", "-o", "pipefail", "-c", await imageStep("Push verified image tags")],
    {
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        MAIN_SHA: "newer-main",
        PUBLISH_SHA: "verified-candidate",
        IMAGE_TAGS: "image:catalina\nimage:latest",
        PUSHES: pushes,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(await child.exited).toBe(1);
  expect(await Bun.file(pushes).exists()).toBe(false);
});
