import type { DisplayCatalog } from "@stanley2058/lilac-client-protocol";
import { cacheScopeKey, type CacheScope } from "./cache.ts";

export type Completion = {
  id: string;
  name: string;
  description: string;
  source?: string;
  kind: "skill" | "builtin" | "custom";
  insertText: string;
};

export class DisplayCatalogCache {
  private readonly catalogs = new Map<string, DisplayCatalog>();
  get(scope: CacheScope): DisplayCatalog | undefined {
    return this.catalogs.get(cacheScopeKey(scope));
  }
  put(scope: CacheScope, catalog: DisplayCatalog): void {
    this.catalogs.set(cacheScopeKey(scope), catalog);
  }
  purge(scope: CacheScope): void {
    this.catalogs.delete(cacheScopeKey(scope));
  }
  complete(scope: CacheScope, trigger: "$" | "/", query: string, limit = 30): Completion[] {
    const catalog = this.get(scope);
    if (!catalog) return [];
    const skillPrefix = trigger === "/" && query.toLocaleLowerCase().startsWith("skill:");
    const normalized = (skillPrefix ? query.slice(6) : query).toLocaleLowerCase();
    const skills: Completion[] = catalog.skills.map((skill) => ({
      ...skill,
      kind: "skill",
      insertText: trigger === "$" ? `$${skill.name}` : `/skill:${skill.name}`,
    }));
    const commands: Completion[] =
      trigger === "$" || skillPrefix
        ? []
        : catalog.commands.map((command) => ({
            ...command,
            insertText: `/${command.name}`,
          }));
    return [...skills, ...commands]
      .filter((item) => `${item.name} ${item.description}`.toLocaleLowerCase().includes(normalized))
      .sort(
        (a, b) =>
          Number(b.name.toLocaleLowerCase().startsWith(normalized)) -
            Number(a.name.toLocaleLowerCase().startsWith(normalized)) ||
          a.name.localeCompare(b.name),
      )
      .slice(0, Math.max(0, Math.min(limit, 100)));
  }
}
