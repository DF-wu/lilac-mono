import type { ZodType } from "zod";

declare const schema: ZodType<{ readonly id: string }>;

export function testOnlyDecoder(value: unknown) {
  return schema.parse(value);
}
