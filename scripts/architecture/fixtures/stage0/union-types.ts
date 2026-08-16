export type ImportedState = "idle" | "running" | "done";

export type ImportedEvent =
  | { readonly kind: "created"; readonly id: string }
  | { readonly kind: "updated"; readonly id: string }
  | { readonly kind: "deleted"; readonly id: string };

export type ExhaustiveMap<Key extends PropertyKey, Value> = {
  readonly [Current in Key]: Value;
};

export const importedExhaustiveStateMap = {
  idle: "idle",
  running: "running",
  done: "done",
} satisfies Record<ImportedState, string>;

const importedRawStateMap = {
  idle: "idle",
  running: "running",
  done: "done",
};

export const importedIntermediateStateMap: ExhaustiveMap<ImportedState, string> =
  importedRawStateMap;

export const importedPartialStateMap: Partial<Record<ImportedState, string>> = {
  idle: "idle",
};

export const namespacePartialStateMap = {
  idle: "idle",
} as Record<ImportedState, string>;
