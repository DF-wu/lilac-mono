export function unrelatedCalls(value: string): string {
  const normalized = value.trim().toUpperCase();
  return [normalized].map((entry) => entry.toLowerCase()).join("");
}

export function ordinaryBoolean(value: unknown): boolean {
  return typeof value === "string";
}
