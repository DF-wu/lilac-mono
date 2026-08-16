import type { ZodType } from "zod";

interface DomainValue {
  readonly id: string;
}

declare const importedSchema: ZodType<DomainValue, unknown>;

export function registeredDecode(value: unknown): DomainValue {
  function parseNested(raw: unknown): DomainValue {
    return importedSchema.parse(raw);
  }
  return parseNested(value);
}

export function unregisteredDecode(value: unknown) {
  const importedAlias = importedSchema.safeParse;
  return importedAlias(value);
}

const unrelatedParser = {
  parse(value: unknown): string {
    return String(value);
  },
};

export function falsePositiveUtility(value: unknown): string {
  return unrelatedParser.parse(value);
}
