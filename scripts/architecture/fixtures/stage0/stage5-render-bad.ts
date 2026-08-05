import type { ToolProjection } from "./stage5-tools.ts";
import type {
  ImportedCallContract,
  ImportedMethodContract,
  ImportedNestedContract,
  ImportedOverBudgetContract,
  ImportedRecursiveContract,
} from "./stage5-render-contracts.ts";

export type DirectUnknownAlias = unknown;
export type NestedUnknownAlias = Promise<
  ReadonlyMap<string, readonly ({ data: unknown } | string)[]>
>;

export interface UnknownPropertyContract {
  readonly payload: ReadonlyMap<string, { readonly nested: unknown }>;
}

export function unknownParameter(value: Set<Promise<unknown>>): string {
  return String(value.size);
}

export function unknownReturn(): Record<string, unknown> {
  return {};
}

export function unknownLocal(): string {
  const local: Map<string, readonly unknown[]> = new Map();
  return String(local.size);
}

export function importedMethodOnly(contract: ImportedMethodContract): string {
  return contract.decode("value");
}

export function importedCallOnly(contract: ImportedCallContract): string {
  return contract("value");
}

export function importedNestedMethod(contract: ImportedNestedContract): string {
  return contract.child.render("value");
}

export function importedOverBudget(contract: ImportedOverBudgetContract): string {
  return contract.value;
}

export function importedRecursive(contract: ImportedRecursiveContract): string {
  return contract.label;
}

export function incompleteToolProjectionSwitch(projection: ToolProjection): string {
  switch (projection.kind) {
    case "bash":
      return projection.command;
    case "read":
      return projection.path;
    case "unknown-tool":
      return projection.preview;
  }
  return "malformed";
}
