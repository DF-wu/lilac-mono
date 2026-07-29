import { describe, expect, it } from "bun:test";
import path from "node:path";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { seedCoreConfig } from "../core-config";

describe("core config seeding", () => {
  it("creates core-config.yaml and can overwrite when requested", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-utils-core-config-"));
    try {
      const first = await seedCoreConfig({ dataDir: dir });
      expect(first.created).toBe(true);
      expect(first.overwritten).toBe(false);
      expect(await Bun.file(first.configPath).exists()).toBe(true);
      expect(await Bun.file(path.join(dir, ".gitkeep")).exists()).toBe(false);

      await writeFile(first.configPath, "# custom\nfoo: bar\n", "utf8");

      const second = await seedCoreConfig({ dataDir: dir });
      expect(second.created).toBe(false);
      expect(second.overwritten).toBe(false);
      const rawSecond = await Bun.file(second.configPath).text();
      expect(rawSecond).toContain("foo: bar");

      const third = await seedCoreConfig({ dataDir: dir, overwrite: true });
      expect(third.created).toBe(false);
      expect(third.overwritten).toBe(true);
      const rawThird = await Bun.file(third.configPath).text();
      expect(rawThird).not.toContain("foo: bar");
      expect(rawThird).toContain("surface:");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not create or overwrite .gitkeep while seeding", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "lilac-utils-core-config-"));
    try {
      const gitkeepPath = path.join(dir, ".gitkeep");
      await writeFile(gitkeepPath, "preserve me\n", "utf8");
      const knownTime = new Date("2020-01-02T03:04:05.000Z");
      await utimes(gitkeepPath, knownTime, knownTime);

      await seedCoreConfig({ dataDir: dir });

      expect(await Bun.file(gitkeepPath).text()).toBe("preserve me\n");
      expect((await Bun.file(gitkeepPath).stat()).mtimeMs).toBe(knownTime.getTime());
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
