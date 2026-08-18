import { createHash } from "node:crypto";

import { Result } from "better-result";
import { z } from "zod";

export const CATALOG_TOOL_ID_VERSION = 1 as const;
export const MAX_MODEL_TOOL_NAME_LENGTH = 64;

export const catalogToolIdentitySchema = z.strictObject({
  source: z.enum(["plugin", "mcp"]),
  sourceId: z.string().min(1),
  rawToolName: z.string().min(1),
});

export type CatalogToolIdentity = z.infer<typeof catalogToolIdentitySchema>;

const stableIdSchema = z.tuple([
  z.literal("lilac.catalog-tool"),
  z.literal(CATALOG_TOOL_ID_VERSION),
  z.enum(["plugin", "mcp"]),
  z.string().min(1),
  z.string().min(1),
]);

export type CatalogStableIdParseResult =
  | { ok: true; identity: CatalogToolIdentity }
  | { ok: false; error: string };

/** A versioned, delimiter-safe persistence key. */
export function catalogToolStableId(identity: CatalogToolIdentity): string {
  return JSON.stringify([
    "lilac.catalog-tool",
    CATALOG_TOOL_ID_VERSION,
    identity.source,
    identity.sourceId,
    identity.rawToolName,
  ]);
}

export function parseCatalogToolStableId(stableId: string): CatalogStableIdParseResult {
  const decoded = Result.try({ try: () => JSON.parse(stableId) as unknown, catch: () => null });

  const parsed = decoded.match<() => ReturnType<typeof stableIdSchema.safeParse> | null>({
    ok: (value) => () => stableIdSchema.safeParse(value),
    err: () => () => null,
  })();
  if (!parsed) return { ok: false, error: "invalid catalog tool ID JSON" };
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  return {
    ok: true,
    identity: { source: parsed.data[2], sourceId: parsed.data[3], rawToolName: parsed.data[4] },
  };
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeNameSegment(value: string): string {
  const normalized = value.replace(/[^0-9A-Za-z_]+/g, "_").replace(/_+/g, "_");
  return normalized.replace(/^_+|_+$/g, "");
}

export function catalogToolNamespaceName(
  identity: Pick<CatalogToolIdentity, "source" | "sourceId">,
): string {
  const sourceId = normalizeNameSegment(identity.sourceId) || "source";
  return `${identity.source}_${sourceId}`;
}

function identityHash(identity: CatalogToolIdentity): string {
  return createHash("sha256").update(catalogToolStableId(identity)).digest("hex").slice(0, 10);
}

function appendHash(base: string, identity: CatalogToolIdentity): string {
  const suffix = `_${identityHash(identity)}`;
  const available = MAX_MODEL_TOOL_NAME_LENGTH - suffix.length;
  const stem = base.slice(0, available).replace(/_+$/g, "") || "tool";
  return `${stem}${suffix}`;
}

/** Deterministic candidate before catalog-wide collision resolution. */
export function baseCatalogToolName(identity: CatalogToolIdentity): string {
  const namespace = catalogToolNamespaceName(identity);
  const rawToolName = normalizeNameSegment(identity.rawToolName) || "tool";
  const base = `${namespace}_${rawToolName}`;
  return base.length <= MAX_MODEL_TOOL_NAME_LENGTH ? base : appendHash(base, identity);
}

export type CatalogToolNameCollision = {
  readonly modelName: string;
  readonly identities: readonly CatalogToolIdentity[];
  readonly reserved: boolean;
};

export type CatalogToolNameAssignment = {
  /** Stable catalog ID to provider-facing tool name. */
  readonly byStableId: ReadonlyMap<string, string>;
  /** Provider-facing tool name to structured source identity. */
  readonly byModelName: ReadonlyMap<string, CatalogToolIdentity>;
  /** Normally empty; detects a reserved or hash-suffix collision without shadowing. */
  readonly collisions: readonly CatalogToolNameCollision[];
};

export function assignCatalogToolNames(
  identities: readonly CatalogToolIdentity[],
  reservedNames: ReadonlySet<string> = new Set(),
): CatalogToolNameAssignment {
  const unique = new Map<string, CatalogToolIdentity>();
  for (const identity of identities) {
    unique.set(catalogToolStableId(identity), identity);
  }
  const sorted = [...unique.entries()].sort(([left], [right]) => compareText(left, right));

  const baseCounts = new Map<string, number>();
  for (const [, identity] of sorted) {
    const base = baseCatalogToolName(identity);
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }

  const finalGroups = new Map<string, Array<{ stableId: string; identity: CatalogToolIdentity }>>();
  for (const [stableId, identity] of sorted) {
    const base = baseCatalogToolName(identity);
    const modelName =
      (baseCounts.get(base) ?? 0) > 1 || reservedNames.has(base)
        ? appendHash(base, identity)
        : base;
    const group = finalGroups.get(modelName) ?? [];
    group.push({ stableId, identity });
    finalGroups.set(modelName, group);
  }

  const byStableId = new Map<string, string>();
  const byModelName = new Map<string, CatalogToolIdentity>();
  const collisions: CatalogToolNameCollision[] = [];

  for (const modelName of [...finalGroups.keys()].sort(compareText)) {
    const group = finalGroups.get(modelName);
    if (!group) continue;
    const reserved = reservedNames.has(modelName);
    if (reserved || group.length > 1) {
      collisions.push({
        modelName,
        identities: group.map(({ identity }) => identity),
        reserved,
      });
      continue;
    }

    const onlyEntry = group[0];
    if (!onlyEntry) continue;
    const { stableId, identity } = onlyEntry;
    byStableId.set(stableId, modelName);
    byModelName.set(modelName, identity);
  }

  return { byStableId, byModelName, collisions };
}
