export function firstProjection(value: unknown): { readonly first: string } {
  return value as { readonly first: string };
}

export function secondProjection(value: unknown): { readonly second: number } {
  return value as { readonly second: number };
}
