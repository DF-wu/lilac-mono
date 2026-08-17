import { describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

async function readRepoFile(path: string): Promise<string> {
  return readFile(`${REPO_ROOT}/${path}`, "utf8");
}

describe("Docker image identity variants", () => {
  it("derives the image account and home from CONTAINER_USER", async () => {
    const dockerfile = await readRepoFile("Dockerfile");

    expect(dockerfile).toContain("ARG CONTAINER_USER=lilac");
    expect(dockerfile).toContain("ENV LILAC_USER=${CONTAINER_USER}");
    expect(dockerfile).toContain("ENV LILAC_UID=${CONTAINER_UID}");
    expect(dockerfile).toContain("ENV LILAC_GID=${CONTAINER_UID}");
    expect(dockerfile).toContain("ENV HOME=/home/${LILAC_USER}");
    expect(dockerfile).toContain("> /etc/lilac-runtime-user");
    expect(dockerfile).toContain("CONTAINER_USER is already assigned to a base-image account");
    expect(dockerfile).toContain("CONTAINER_USER is already assigned to a base-image group");
  });

  it("drops privileges using the root-owned image identity", async () => {
    const entrypoint = await readRepoFile("docker/direct-entrypoint.sh");

    expect(entrypoint).toContain("cat /etc/lilac-runtime-user");
    expect(entrypoint).toContain('id -u "$runtime_user"');
    expect(entrypoint).toContain('export HOME="$home"');
    expect(entrypoint).toContain('export USER="$runtime_user"');
    expect(entrypoint).toContain('export LOGNAME="$runtime_user"');
    expect(entrypoint).not.toContain("id -u lilac");
    expect(entrypoint).not.toContain("id -g lilac");
  });

  it("verifies each published variant before pushing its tags", async () => {
    const workflow = await readRepoFile(".github/workflows/build-image.yml");
    const verifyIndex = workflow.indexOf("Verify image identity and runtime isolation");
    const pushIndex = workflow.indexOf("Push verified image tags");

    expect(workflow).toContain("push: false");
    expect(workflow).toContain('"${{ matrix.variant.container_user }}"');
    expect(workflow).toContain('"${{ matrix.variant.container_uid }}"');
    expect(verifyIndex).toBeGreaterThan(0);
    expect(pushIndex).toBeGreaterThan(verifyIndex);
  });

  it("runs pull request image smoke tests for every supported identity", async () => {
    const workflow = await readRepoFile(".github/workflows/ci.yml");

    for (const identity of ["lilac", "Catalina", "Claudia"]) {
      expect(workflow).toContain(`container_user: ${identity}`);
    }
    expect(workflow).toContain('"${{ matrix.variant.container_user }}"');
    expect(workflow).toContain('"${{ matrix.variant.container_uid }}"');
  });
});
