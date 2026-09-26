import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { nativeDeploymentSettingsSchema } from "@stanley2058/lilac-client-protocol";
import { NativeStore } from "../../../src/surface/native/store";
import { createNativeIntegrationFixture } from "./integration-fixture";

const initial = {
  titleModel: "main",
  outputStreaming: "complete" as const,
  oldMessageSelectionMaxAgeMs: 60000,
  storageRetentionMaxAgeMs: 86400000,
  crossThreadSend: { triggerRun: false },
};

test("deployment settings seed once, survive restart, enforce ownership and reject stale writes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "native-deployment-"));
  const file = path.join(directory, "native.sqlite");
  let store = new NativeStore(new Database(file));
  try {
    store.initialize().unwrap();
    for (const role of ["owner", "participant"] as const)
      store
        .upsertUser({ id: role, providerId: role, displayName: role, role, toolMode: "full" })
        .unwrap();
    store.initializeDeployment(initial).unwrap();
    const document = store.readDeployment("owner").unwrap();
    expect(document.settings).toEqual(initial);
    expect(
      store.readDeployment("participant").match({ ok: () => null, err: (error) => error }),
    ).toMatchObject({ code: "forbidden" });
    expect(
      store
        .setDeployment("participant", { settings: initial, expectedRevision: 0 })
        .match({ ok: () => null, err: (error) => error }),
    ).toMatchObject({ code: "forbidden" });
    const changed = {
      ...initial,
      titleModel: "fast",
      outputStreaming: "paragraph" as const,
      storageRetentionMaxAgeMs: null,
    };
    const saved = store.setDeployment("owner", { settings: changed, expectedRevision: 0 }).unwrap();
    expect(saved.revision).toBe(1);
    expect(
      store
        .setDeployment("owner", { settings: initial, expectedRevision: 0 })
        .match({ ok: () => null, err: (error) => error }),
    ).toMatchObject({ code: "conflict" });
    expect(
      store.setDeployment("owner", { settings: changed, expectedRevision: 1 }).unwrap(),
    ).toEqual(saved);
    store.close();
    store = new NativeStore(new Database(file));
    store.initialize().unwrap();
    store.initializeDeployment(initial).unwrap();
    expect(store.getDeployment().unwrap()).toEqual(saved);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("deployment RPC imports all legacy fields and saves without touching commented YAML", async () => {
  let file = "";
  const yaml =
    "# Operator notes\nconfigVersion: 2\nsurface:\n  native:\n    outputStreaming: complete # Keep this comment\n";
  const fixture = await createNativeIntegrationFixture({
    prepare: async ({ config, dataDir }) => {
      Object.assign(config.surface.native, initial);
      file = path.join(dataDir, "core-config.yaml");
    },
  });
  try {
    await writeFile(file, yaml);
    const { client } = fixture.connect();
    const document = await client.config.readDeployment({});
    expect(document.settings).toEqual(initial);
    const settings = {
      ...initial,
      titleModel: "fast",
      oldMessageSelectionMaxAgeMs: null,
      storageRetentionMaxAgeMs: null,
      crossThreadSend: { triggerRun: true },
      outputStreaming: "paragraph" as const,
    };
    const saved = await client.config.setDeployment({
      settings,
      expectedRevision: document.revision,
    });
    expect(await client.config.readDeployment({})).toEqual(saved);
    expect(fixture.store.getDeployment().unwrap().settings).toEqual(settings);
    expect(await readFile(file, "utf8")).toBe(yaml);
    await expect(
      client.config.setDeployment({ settings: initial, expectedRevision: document.revision }),
    ).rejects.toThrow();
  } finally {
    await fixture.close();
  }
});

test("deployment contract rejects invalid fields and permits unlimited ages", () => {
  expect(
    nativeDeploymentSettingsSchema.safeParse({
      ...initial,
      oldMessageSelectionMaxAgeMs: null,
      storageRetentionMaxAgeMs: null,
    }).success,
  ).toBe(true);
  for (const patch of [
    { titleModel: " " },
    { outputStreaming: "invalid" },
    { oldMessageSelectionMaxAgeMs: 0 },
    { storageRetentionMaxAgeMs: -1 },
    { storageRetentionMaxAgeMs: 1.5 },
    { crossThreadSend: { triggerRun: "yes" } },
  ])
    expect(nativeDeploymentSettingsSchema.safeParse({ ...initial, ...patch }).success).toBe(false);
});
