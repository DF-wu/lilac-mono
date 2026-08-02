import type { ZodType, z } from "zod";

interface DomainValue {
  readonly id: string;
}

declare const importedSchema: ZodType<DomainValue, unknown>;

export function consumeUnknown(value: unknown): void {
  void value;
}

export function consumeSchemaInput(value: z.input<typeof importedSchema>): void {
  void value;
}

export function consumeSchemaOutput(value: z.output<typeof importedSchema>): void {
  void value.id;
}

export function opaqueStringify(value: unknown): string {
  return String(value);
}

export function assertDomain(value: unknown): DomainValue {
  return value as DomainValue;
}

export function assertPrimitive(value: unknown): string {
  return value as string;
}

export function isDomain(value: unknown): value is DomainValue {
  return typeof value === "object" && value !== null && "id" in value;
}

export function isCapability(value: unknown): value is { readonly version: string } {
  return typeof value === "object" && value !== null && "version" in value;
}

export function overloaded(value: unknown): value is DomainValue;
export function overloaded(value: unknown): boolean {
  return isDomain(value);
}

export const filtered = ["value" as unknown].filter((value: unknown): value is DomainValue =>
  isDomain(value),
);

export interface OpaqueContract {
  accept(value: unknown): void;
  reject(value: unknown): void;
}
