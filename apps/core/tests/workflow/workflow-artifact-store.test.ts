import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { Panic } from "better-result";

import {
  decodeWorkflowValueArtifact,
  encodeWorkflowValueArtifact,
  WorkflowArtifactCorruptFields,
  WorkflowArtifactHashMismatch,
  WorkflowArtifactMalformedJson,
  WorkflowArtifactUnsupportedVersion,
  workflowValueArtifactCodecCases,
} from "../../src/workflow/workflow-artifact-persistence-codec";
import {
  readWorkflowValueArtifact,
  WorkflowArtifactAbsent,
  WorkflowArtifactIoFailed,
  WorkflowArtifactUnsafePath,
  WorkflowArtifactWriteAndCleanupFailed,
  writeWorkflowValueArtifact,
} from "../../src/workflow/workflow-artifact-store";
import { canonicalJson, sha256 } from "../../src/workflow/workflow-definition";
import type { JsonValue } from "../../src/workflow/workflow-domain";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = join(tmpdir(), `workflow-artifact-store-${crypto.randomUUID()}`);
  roots.push(root);
  return root;
}

afterEach(async () => {
  mock.restore();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("workflow value artifact persistence codec", () => {
  it("exports and executes the exact six-case compatibility catalog", () => {
    expect(Object.keys(workflowValueArtifactCodecCases).sort()).toEqual([
      "corrupt-fields",
      "current",
      "legacy",
      "malformed-serialization",
      "missing-defaulted",
      "unsupported-version",
    ]);

    for (const fixture of Object.values(workflowValueArtifactCodecCases)) {
      const decoded = decodeWorkflowValueArtifact(fixture.input);
      expect(decoded.status).toBe(fixture.outcome);
      if (decoded.status === "ok" && "provenance" in fixture) {
        expect(decoded.value.provenance).toBe(fixture.provenance);
      }
    }
  });

  it("classifies unsupported, malformed, corrupt, and hash-mismatched content separately", () => {
    const unsupported = decodeWorkflowValueArtifact(
      workflowValueArtifactCodecCases["unsupported-version"].input,
    );
    expect(unsupported.status).toBe("error");
    if (unsupported.status === "error") {
      expect(unsupported.error).toBeInstanceOf(WorkflowArtifactUnsupportedVersion);
    }

    const malformed = decodeWorkflowValueArtifact(
      workflowValueArtifactCodecCases["malformed-serialization"].input,
    );
    expect(malformed.status).toBe("error");
    if (malformed.status === "error") {
      expect(malformed.error).toBeInstanceOf(WorkflowArtifactMalformedJson);
    }

    const corrupt = decodeWorkflowValueArtifact(
      workflowValueArtifactCodecCases["corrupt-fields"].input,
    );
    expect(corrupt.status).toBe("error");
    if (corrupt.status === "error") {
      expect(corrupt.error).toBeInstanceOf(WorkflowArtifactCorruptFields);
    }

    const current = workflowValueArtifactCodecCases.current.input;
    const mismatched = decodeWorkflowValueArtifact({
      ...current,
      expectedHash: "f".repeat(64),
      artifactId: `workflow-value:${"f".repeat(64)}`,
    });
    expect(mismatched.status).toBe("error");
    if (mismatched.status === "error") {
      expect(mismatched.error).toBeInstanceOf(WorkflowArtifactHashMismatch);
    }
  });
});

describe("workflow value artifact store", () => {
  it("writes canonical v1 envelopes while retaining payload-derived IDs", async () => {
    const root = temporaryRoot();
    const value: JsonValue = { zebra: [3, 2, 1], alpha: "stable" };
    const payload = canonicalJson(value);
    const hash = sha256(payload);
    const expectedId = `workflow-value:${hash}`;
    const written = await writeWorkflowValueArtifact({ dataDir: root, value, maxBytes: 4096 });
    expect(written.status).toBe("ok");
    if (written.status === "error") return;
    expect(written.value).toBe(expectedId);

    const artifactDir = join(root, "workflow-artifacts");
    const encoded = await fs.readFile(join(artifactDir, `${hash}.json`), "utf8");
    expect(encoded).toBe(encodeWorkflowValueArtifact(value).encoded);
    expect(encoded).toBe(canonicalJson(JSON.parse(encoded)));
    expect((await fs.readdir(artifactDir)).sort()).toEqual([`${hash}.json`]);

    const read = await readWorkflowValueArtifact({
      dataDir: root,
      artifactId: expectedId,
      maxBytes: 4096,
    });
    expect(read.status).toBe("ok");
    if (read.status === "ok") expect(read.value).toEqual(value);
  });

  it("reads canonical unversioned v0 without rewriting wrapper-shaped values", async () => {
    const root = temporaryRoot();
    const value: JsonValue = {
      encoding: "canonical-json",
      format: "lilac-workflow-value",
      value: "legacy wrapper-shaped value",
      version: 1,
    };
    const encoded = canonicalJson(value);
    const hash = sha256(encoded);
    const artifactDir = join(root, "workflow-artifacts");
    const artifactPath = join(artifactDir, `${hash}.json`);
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(artifactPath, encoded);

    const read = await readWorkflowValueArtifact({
      dataDir: root,
      artifactId: `workflow-value:${hash}`,
      maxBytes: 4096,
    });
    expect(read.status).toBe("ok");
    if (read.status === "ok") expect(read.value).toEqual(value);
    expect(await fs.readFile(artifactPath, "utf8")).toBe(encoded);
  });

  it("distinguishes absent artifacts, symlinks, and filesystem I/O", async () => {
    const hash = "a".repeat(64);
    const artifactId = `workflow-value:${hash}`;
    const root = temporaryRoot();
    const absent = await readWorkflowValueArtifact({ dataDir: root, artifactId, maxBytes: 1024 });
    expect(absent.status).toBe("error");
    if (absent.status === "error") expect(absent.error).toBeInstanceOf(WorkflowArtifactAbsent);

    const target = temporaryRoot();
    await fs.mkdir(target, { recursive: true });
    await fs.mkdir(root, { recursive: true });
    await fs.symlink(target, join(root, "workflow-artifacts"));
    const symlinked = await readWorkflowValueArtifact({
      dataDir: root,
      artifactId,
      maxBytes: 1024,
    });
    expect(symlinked.status).toBe("error");
    if (symlinked.status === "error") {
      expect(symlinked.error).toBeInstanceOf(WorkflowArtifactUnsafePath);
      expect(symlinked.error).toMatchObject({ issue: "symlink", location: "root" });
    }

    const io = await readWorkflowValueArtifact({ dataDir: "\0", artifactId, maxBytes: 1024 });
    expect(io.status).toBe("error");
    if (io.status === "error") expect(io.error).toBeInstanceOf(WorkflowArtifactIoFailed);
  });

  it("combines write and cleanup errors without exposing persisted content", async () => {
    const root = temporaryRoot();
    spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename secret-value"));
    spyOn(fs, "rm").mockRejectedValueOnce(new Error("cleanup secret-value"));
    const written = await writeWorkflowValueArtifact({
      dataDir: root,
      value: "secret-value",
      maxBytes: 1024,
    });
    expect(written.status).toBe("error");
    if (written.status === "error") {
      expect(written.error).toBeInstanceOf(WorkflowArtifactWriteAndCleanupFailed);
      expect(JSON.stringify(written.error)).not.toContain("secret-value");
    }
  });

  it("raises Panic when an atomic publication cannot be verified", async () => {
    const root = temporaryRoot();
    spyOn(fs, "readFile").mockRejectedValueOnce(new Error("verification failed"));
    const publication = writeWorkflowValueArtifact({
      dataDir: root,
      value: "published",
      maxBytes: 1024,
    });
    await expect(publication).rejects.toBeInstanceOf(Panic);
  });
});
