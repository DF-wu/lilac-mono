import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  blobRefV1Schema,
  createLocalBlobStore,
  materializeBlobRead,
} from "@stanley2058/lilac-blob-storage";
import { runBlobStorageMigration } from "../../scripts/migrate-blob-storage";
import { applyWorkflowSchemaMigrations } from "../../src/workflow/workflow-migrations";
import { createTranscriptSchemaMigrationFixture } from "../transcript/fixtures/transcript-schema-migration-fixtures";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "lilac-fork-cutover-evidence-"));
  roots.push(root);
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir);
  const configPath = path.join(dataDir, "core-config.yaml");
  await fs.writeFile(configPath, "configVersion: 2\n");
  const transcript = path.join(dataDir, "agent-transcripts.db");
  const workflow = path.join(dataDir, "data.sqlite3");
  createTranscriptSchemaMigrationFixture(transcript, 5);
  const db = new Database(workflow, { create: true, strict: true });
  applyWorkflowSchemaMigrations(db, () => 1, 25).match({
    ok: () => undefined,
    err: (e) => {
      throw e;
    },
  });
  db.close(false);
  const bytes = new Uint8Array([0, 1, 2, 255, 254, 128, 17]);
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const td = new Database(transcript, { strict: true });
  td.run("INSERT INTO core_owned_blobs VALUES (?, ?, ?, ?, ?, ?)", [
    digest,
    "application/octet-stream",
    "integrity.bin",
    bytes.length,
    bytes,
    1,
  ]);
  td.close(false);
  return {
    root,
    dataDir,
    configPath,
    transcript,
    workflow,
    bytes,
    digest,
    options: { dataDir, configPath, workflowDbPath: workflow, dryRun: false },
  };
}
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(dir: string) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(file);
        continue;
      }
      result[path.relative(root, file)] = new Bun.CryptoHasher("sha256")
        .update(await fs.readFile(file))
        .digest("hex");
    }
  }
  await walk(root);
  return result;
}
function version(file: string, table: string) {
  const db = new Database(file, { readonly: true, strict: true });
  const v = db
    .query<{ version: number }, []>(`SELECT MAX(version) AS version FROM ${table}`)
    .get()!.version;
  db.close(false);
  return v;
}
test("legacy dry-run, exact backup, durable byte integrity, and exact restore", async () => {
  const f = await fixture();
  const before = await snapshot(f.dataDir);
  const backup = path.join(f.root, "backup");
  await fs.cp(f.dataDir, backup, { recursive: true });
  expect(await snapshot(backup)).toEqual(before);
  const dry = await runBlobStorageMigration({ ...f.options, dryRun: true });
  expect(dry.isOk()).toBe(true);
  expect(await snapshot(f.dataDir)).toEqual(before);
  const result = await runBlobStorageMigration(f.options);
  result.match({
    ok: () => undefined,
    err: (e) => {
      throw e;
    },
  });
  expect(version(f.transcript, "transcript_schema_migrations")).toBe(6);
  expect(version(f.workflow, "workflow_schema_migrations")).toBe(26);
  const db = new Database(f.transcript, { readonly: true, strict: true });
  const row = db
    .query<{ blob_ref_json: string }, []>("SELECT blob_ref_json FROM core_owned_blobs")
    .get()!;
  db.close(false);
  const ref = blobRefV1Schema.parse(JSON.parse(row.blob_ref_json));
  expect(ref.sha256).toBe(f.digest);
  expect(ref.byteLength).toBe(f.bytes.length);
  const store = (await createLocalBlobStore({ root: path.join(f.dataDir, "blobs") })).match({
    ok: (s) => s,
    err: (e) => {
      throw e;
    },
  });
  const read = (await store.open(ref)).match({
    ok: (r) => r,
    err: (e) => {
      throw e;
    },
  });
  const bytes = (await materializeBlobRead(read)).match({
    ok: (b) => b,
    err: (e) => {
      throw e;
    },
  });
  expect(bytes).toEqual(f.bytes);
  await store.close({ deadlineAtMs: Date.now() + 5_000 });
  expect(await snapshot(backup)).toEqual(before);
  await fs.rm(f.dataDir, { recursive: true });
  await fs.cp(backup, f.dataDir, { recursive: true });
  expect(await snapshot(f.dataDir)).toEqual(before);
  expect(version(f.transcript, "transcript_schema_migrations")).toBe(5);
  expect(version(f.workflow, "workflow_schema_migrations")).toBe(25);
});
test("historical command refuses already-current fixtures without mutation", async () => {
  const f = await fixture();
  (await runBlobStorageMigration(f.options)).match({
    ok: () => undefined,
    err: (e) => {
      throw e;
    },
  });
  const before = await snapshot(f.dataDir);
  expect((await runBlobStorageMigration({ ...f.options, dryRun: true })).isErr()).toBe(true);
  expect(await snapshot(f.dataDir)).toEqual(before);
});
test("mixed legacy/current schemas stop before writes", async () => {
  const f = await fixture();
  const other = await fixture();
  (await runBlobStorageMigration(other.options)).match({
    ok: () => undefined,
    err: (e) => {
      throw e;
    },
  });
  await fs.copyFile(other.workflow, f.workflow);
  const before = await snapshot(f.dataDir);
  expect((await runBlobStorageMigration(f.options)).isErr()).toBe(true);
  expect(await snapshot(f.dataDir)).toEqual(before);
});
test("corrupt legacy bytes stop both dry-run and apply before writes", async () => {
  const f = await fixture();
  const db = new Database(f.transcript, { strict: true });
  db.run("UPDATE core_owned_blobs SET bytes=?", [new Uint8Array([9, 9, 9, 9, 9, 9, 9])]);
  db.close(false);
  const before = await snapshot(f.dataDir);
  for (const dryRun of [true, false]) {
    expect((await runBlobStorageMigration({ ...f.options, dryRun })).isErr()).toBe(true);
    expect(await snapshot(f.dataDir)).toEqual(before);
  }
});
