import type { ImportedState } from "./union-types.ts";

const stateMap: Partial<Record<ImportedState, string>> = { idle: "idle" };

export function readMapA(state: ImportedState): string {
  return stateMap[state] ?? "missing";
}
