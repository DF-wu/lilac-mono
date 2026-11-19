import { expect, test } from "bun:test";
import { z } from "zod";
import { toEditorSchema } from "../../scripts/generate-config-schemas";

test("editor schema rejects unrepresentable inputs instead of generating permissive schemas", () => {
  for (const schema of [
    z.transform((value) => value),
    z.literal(undefined),
    z.literal(1n),
    z.bigint(),
    z.date(),
  ]) {
    const errors: string[] = [];
    toEditorSchema(schema, errors);
    expect(errors).toEqual([expect.stringContaining("needs an editor schema")]);
  }
});

test("editor schema represents an omitted-only field without accepting JSON values", () => {
  expect(toEditorSchema(z.undefined())).toMatchObject({ not: {} });
});
