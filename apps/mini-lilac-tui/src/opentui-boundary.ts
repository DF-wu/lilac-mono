import { z } from "zod";

const draftExtmarkDataSchema = z.object({
  kind: z.literal("mini-lilac-draft"),
  id: z.string(),
  generation: z.number(),
});

export type DraftExtmarkData = z.output<typeof draftExtmarkDataSchema>;

/** Decode opaque OpenTUI extmark data before it reaches editor state logic. */
export function decodeDraftExtmarkData(value: unknown): DraftExtmarkData | undefined {
  const decoded = draftExtmarkDataSchema.safeParse(value);
  return decoded.success ? decoded.data : undefined;
}
