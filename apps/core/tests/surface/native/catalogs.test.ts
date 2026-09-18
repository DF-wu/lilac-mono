import { expect, it } from "bun:test";
import { parseCoreConfigV2ToUniversal } from "@stanley2058/lilac-utils/core-config";
import { NativeCatalogService } from "../../../src/surface/native/catalogs";

it("projects display data without provider options or skill paths and reuses revision", () => {
  const config = parseCoreConfigV2ToUniversal({
    models: {
      def: {
        demo: { model: "openai/demo", options: { private: { token: "secret" } }, comment: "Demo" },
      },
      main: { model: "demo" },
    },
  });
  const service = new NativeCatalogService({
    config,
    commands: [],
    skills: [
      {
        name: "test",
        description: "Test",
        source: "lilac-data",
        location: "/private/SKILL.md",
        baseDir: "/private",
      },
    ],
  });
  const reply = service.get({ key: "owner" });
  expect(reply.kind).toBe("catalog");
  if (reply.kind !== "catalog") return;
  expect(JSON.stringify(reply)).not.toContain("secret");
  expect(JSON.stringify(reply)).not.toContain("/private");
  expect(service.get({ key: "owner" }, reply.catalog.revision)).toEqual({
    kind: "unchanged",
    revision: reply.catalog.revision,
  });
  const restricted = service.get({ key: "participant", skillNames: new Set() });
  if (restricted.kind !== "catalog") return;
  expect(restricted.catalog.skills).toEqual([]);
  expect(restricted.catalog.revision).not.toBe(reply.catalog.revision);
});
