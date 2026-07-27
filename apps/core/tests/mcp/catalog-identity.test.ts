import { describe, expect, it } from "bun:test";

import {
  assignCatalogToolNames,
  baseCatalogToolName,
  catalogToolStableId,
  MAX_MODEL_TOOL_NAME_LENGTH,
  parseCatalogToolStableId,
  type CatalogToolIdentity,
} from "../../src/mcp";

describe("source-neutral catalog identity", () => {
  it("round-trips a versioned stable identity without delimiter characters", () => {
    const identity: CatalogToolIdentity = {
      source: "mcp",
      sourceId: "linear:team",
      rawToolName: "issue\u0000create",
    };
    const stableId = catalogToolStableId(identity);

    expect(stableId).not.toContain("\u0000");
    expect(parseCatalogToolStableId(stableId)).toEqual({ ok: true, identity });
    expect(parseCatalogToolStableId('["lilac.catalog-tool",2,"mcp","x","y"]').ok).toBe(false);
  });

  it("uses source-qualified underscore names for plugins and MCP servers", () => {
    expect(
      baseCatalogToolName({ source: "plugin", sourceId: "github-tools", rawToolName: "pull/get" }),
    ).toBe("plugin_github_tools_pull_get");
    expect(
      baseCatalogToolName({ source: "mcp", sourceId: "linear", rawToolName: "create_issue" }),
    ).toBe("mcp_linear_create_issue");
  });

  it("deterministically hashes normalization collisions and reserved names", () => {
    const identities: CatalogToolIdentity[] = [
      { source: "mcp", sourceId: "a-b", rawToolName: "lookup" },
      { source: "mcp", sourceId: "a_b", rawToolName: "lookup" },
      { source: "plugin", sourceId: "safe", rawToolName: "read" },
    ];
    const forward = assignCatalogToolNames(identities, new Set(["plugin_safe_read"]));
    const reversed = assignCatalogToolNames(
      [...identities].reverse(),
      new Set(["plugin_safe_read"]),
    );

    expect([...forward.byStableId]).toEqual([...reversed.byStableId]);
    expect(forward.collisions).toEqual([]);
    expect(new Set(forward.byStableId.values()).size).toBe(3);
    expect([...forward.byStableId.values()]).not.toContain("plugin_safe_read");
  });

  it("truncates long names with a stable suffix and retains explicit reverse mapping", () => {
    const identity: CatalogToolIdentity = {
      source: "plugin",
      sourceId: "source".repeat(20),
      rawToolName: "tool".repeat(30),
    };
    const assignment = assignCatalogToolNames([identity]);
    const modelName = assignment.byStableId.get(catalogToolStableId(identity));

    expect(modelName).toBeDefined();
    expect(modelName?.length).toBeLessThanOrEqual(MAX_MODEL_TOOL_NAME_LENGTH);
    expect(assignment.byModelName.get(modelName ?? "")).toEqual(identity);
  });
});
