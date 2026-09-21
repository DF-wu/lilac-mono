import { expect, it } from "bun:test";
import { completeConfigSave, editConfig, type ConfigEditors } from "../src/config-editor";

function fixture(): ConfigEditors {
  return {
    core: {
      document: { kind: "core", revision: "core_old", text: "old core" },
      text: "submitted core",
      editRevision: 1,
    },
    mcp: {
      document: { kind: "mcp", revision: "mcp_old", text: "old mcp" },
      text: "unsaved mcp",
      editRevision: 2,
    },
  };
}
it("settles a late Core save only in the Core editor", () => {
  const editors = fixture();
  const saved = completeConfigSave(
    editors,
    { kind: "core", editRevision: 1 },
    { kind: "core", revision: "core_new", text: "submitted core" },
  );
  expect(saved.mcp).toBe(editors.mcp);
  expect(saved.core?.document.revision).toBe("core_new");
  expect(saved.core?.text).toBe("submitted core");
});
it("preserves newer typing while advancing the revision for the next CAS save", () => {
  const edited = editConfig(fixture(), "core", "new typing");
  const saved = completeConfigSave(
    edited,
    { kind: "core", editRevision: 1 },
    { kind: "core", revision: "core_new", text: "submitted core" },
  );
  expect(saved.core?.text).toBe("new typing");
  expect(saved.core?.document.revision).toBe("core_new");
  expect(saved.core?.status).toContain("unsaved");
});
