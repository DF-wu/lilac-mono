import { afterEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { mutateMcpConfigFile } from "../../../src/mcp/config-file";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Result } from "better-result";
import { NativeConfigService } from "../../../src/surface/native/config-service";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function fixture() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "native-config-"));
  dirs.push(dataDir);
  await fs.writeFile(path.join(dataDir, "core-config.yaml"), "configVersion: 2\n");
  await fs.writeFile(path.join(dataDir, "mcp-config.yaml"), "configVersion: 1\nservers: {}\n");
  let reloads = 0;
  const service = new NativeConfigService({
    dataDir,
    ownerId: "owner",
    registry: {
      reload: async () => {
        reloads++;
        return Result.ok([]);
      },
    },
  });
  return { dataDir, service, reloads: () => reloads };
}

describe("native owner configuration", () => {
  it("denies participant reads and writes", async () => {
    const { service } = await fixture();
    expect((await service.read("participant", "core")).isErr()).toBe(true);
    expect(
      (
        await service.save("participant", {
          kind: "core",
          text: "configVersion: 2",
          expectedRevision: "x",
        })
      ).isErr(),
    ).toBe(true);
    expect((await service.reloadMcp("participant")).isErr()).toBe(true);
  });
  it("validates without mutation, saves atomically and rejects stale concurrent saves", async () => {
    const { service, dataDir } = await fixture();
    const initial = (await service.read("owner", "core")).unwrap();
    const invalid = await service.save("owner", {
      kind: "core",
      expectedRevision: initial.revision,
      text: "configVersion: 2\nsurface:\n  native:\n    port: -1\n",
    });
    expect(invalid.match({ ok: () => "", err: (error) => error.message })).toContain("port");
    expect(await fs.readFile(path.join(dataDir, "core-config.yaml"), "utf8")).toBe(initial.text);
    const [first, second] = await Promise.all([
      service.save("owner", {
        kind: "core",
        expectedRevision: initial.revision,
        text: "configVersion: 2\nagent:\n  reasoningDisplay: none\n",
      }),
      service.save("owner", {
        kind: "core",
        expectedRevision: initial.revision,
        text: "configVersion: 2\nagent:\n  reasoningDisplay: detailed\n",
      }),
    ]);
    expect(first.isOk()).toBe(true);
    expect(second.match({ ok: () => "", err: (error) => error.code })).toBe("conflict");
    expect((await fs.readdir(dataDir)).sort()).toEqual(["core-config.yaml", "mcp-config.yaml"]);
  });
  it("saves MCP without reload and only reloads on owner request", async () => {
    const { service, reloads } = await fixture();
    const current = (await service.read("owner", "mcp")).unwrap();
    const saved = await service.save("owner", {
      kind: "mcp",
      expectedRevision: current.revision,
      text: "configVersion: 1\nservers:\n  test:\n    transport: stdio\n    command: echo\n",
    });
    expect(saved.isOk()).toBe(true);
    expect(reloads()).toBe(0);
    expect((await service.reloadMcp("owner")).isOk()).toBe(true);
    expect(reloads()).toBe(1);
  });
});

it("serializes MCP tool mutation and owner saves through one path lock", async () => {
  const { service, dataDir } = await fixture();
  const current = (await service.read("owner", "mcp")).unwrap();
  const renameEntered = Promise.withResolvers<void>();
  const allowRename = Promise.withResolvers<void>();
  const changed = mutateMcpConfigFile({
    configPath: path.join(dataDir, "mcp-config.yaml"),
    mutation: {
      type: "upsert",
      server: {
        id: "tool-added",
        allowSubagents: false,
        transportConfig: { transport: "stdio", command: "echo", args: [], env: {} },
      },
    },
    fileDependencies: {
      mkdir: fs.mkdir,
      open: fs.open,
      rm: fs.rm,
      randomUUID,
      rename: async (from, to) => {
        renameEntered.resolve();
        await allowRename.promise;
        await fs.rename(from, to);
      },
    },
  });
  await renameEntered.promise;
  const saved = service.save("owner", {
    kind: "mcp",
    expectedRevision: current.revision,
    text: "configVersion: 1\nservers: {}\n# stale owner change\n",
  });
  allowRename.resolve();
  expect((await changed).isOk()).toBe(true);
  expect((await saved).match({ ok: () => "", err: (error) => error.code })).toBe("conflict");
  expect((await service.read("owner", "mcp")).unwrap().text).toContain("tool-added");
});

it("lets the owner create an absent MCP config", async () => {
  const { service, dataDir } = await fixture();
  await fs.rm(path.join(dataDir, "mcp-config.yaml"));
  const empty = (await service.read("owner", "mcp")).unwrap();
  expect(empty.text).toContain("servers: {}");
  const saved = await service.save("owner", {
    kind: "mcp",
    expectedRevision: empty.revision,
    text: "configVersion: 1\nservers: {}\n# created\n",
  });
  expect(saved.isOk()).toBe(true);
  expect(await fs.readFile(path.join(dataDir, "mcp-config.yaml"), "utf8")).toContain("created");
});

it("reads defaults and persists streaming without changing other configuration values", async () => {
  const { service, dataDir } = await fixture();
  const source =
    "configVersion: 2\nagent:\n  reasoningDisplay: detailed\nsurface:\n  native:\n    port: 9000\n  discord:\n    enabled: false\n";
  const file = path.join(dataDir, "core-config.yaml");
  await fs.writeFile(file, source);
  const initial = (await service.readStreaming("owner")).unwrap();
  expect(initial.mode).toBe("paragraph");
  const saved = (
    await service.setStreaming("owner", { mode: "complete", expectedRevision: initial.revision })
  ).unwrap();
  expect(saved.mode).toBe("complete");
  expect(saved.revision).not.toBe(initial.revision);
  expect((await service.readStreaming("owner")).unwrap()).toEqual(saved);
  expect(Bun.YAML.parse(await fs.readFile(file, "utf8"))).toEqual({
    configVersion: 2,
    agent: { reasoningDisplay: "detailed" },
    surface: { native: { port: 9000, outputStreaming: "complete" }, discord: { enabled: false } },
  });
  const restored = (
    await service.setStreaming("owner", { mode: "paragraph", expectedRevision: saved.revision })
  ).unwrap();
  expect((await service.readStreaming("owner")).unwrap()).toEqual(restored);
});

it("restricts streaming to the owner and rejects stale writes against YAML saves", async () => {
  const { service } = await fixture();
  expect(
    (await service.readStreaming("participant")).match({
      ok: () => "",
      err: (error) => error.code,
    }),
  ).toBe("forbidden");
  const initial = (await service.readStreaming("owner")).unwrap();
  expect(
    (
      await service.setStreaming("participant", {
        mode: "complete",
        expectedRevision: initial.revision,
      })
    ).match({ ok: () => "", err: (error) => error.code }),
  ).toBe("forbidden");
  const results = await Promise.all([
    service.save("owner", {
      kind: "core",
      text: "configVersion: 2\nagent:\n  reasoningDisplay: none\n",
      expectedRevision: initial.revision,
    }),
    service.setStreaming("owner", { mode: "complete", expectedRevision: initial.revision }),
  ]);
  expect(results.filter((result) => result.isOk())).toHaveLength(1);
  expect(
    results
      .filter((result) => result.isErr())[0]!
      .match({ ok: () => "", err: (error) => error.code }),
  ).toBe("conflict");
});

it("keeps no-op writes unchanged and refuses invalid or unsupported Core documents", async () => {
  const { service, dataDir } = await fixture();
  const file = path.join(dataDir, "core-config.yaml");
  const text = "# Keep this comment\nconfigVersion: 2\n";
  await fs.writeFile(file, text);
  const initial = (await service.readStreaming("owner")).unwrap();
  expect(
    (
      await service.setStreaming("owner", { mode: "paragraph", expectedRevision: initial.revision })
    ).unwrap(),
  ).toEqual(initial);
  expect(await fs.readFile(file, "utf8")).toBe(text);
  for (const invalid of [
    "configVersion: 1\n",
    "configVersion: 2\nsurface:\n  native:\n    outputStreaming: invalid\n",
  ]) {
    await fs.writeFile(file, invalid);
    expect(
      (await service.readStreaming("owner")).match({ ok: () => "", err: (error) => error.code }),
    ).toBe("invalid");
    expect(await fs.readFile(file, "utf8")).toBe(invalid);
  }
});
