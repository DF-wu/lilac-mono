import { Result } from "better-result";
import { z } from "zod";

const sentAttachmentsSchema = z.object({
  ok: z.literal(true),
  attachments: z.array(
    z.object({
      filename: z.string(),
      mimeType: z.string(),
      bytes: z.number().int().nonnegative(),
    }),
  ),
});
const bashCallSchema = z.object({ command: z.string() });
const bashOutputSchema = z.object({ stdout: z.string(), exitCode: z.literal(0) });
export type SentAttachment = z.infer<typeof sentAttachmentsSchema>["attachments"][number];

export function decodeSentAttachmentMetadata(value: unknown): SentAttachment[] {
  const parsed = sentAttachmentsSchema.safeParse(value);
  return parsed.success ? parsed.data.attachments : [];
}

export function decodeSentAttachmentStdout(value: unknown): SentAttachment[] {
  const bash = bashOutputSchema.safeParse(value);
  if (!bash.success) return [];
  return Result.try({
    try: () => JSON.parse(bash.data.stdout) as unknown,
    catch: () => null,
  }).match({ ok: decodeSentAttachmentMetadata, err: () => [] });
}

export function isSentAttachmentCommand(value: unknown): boolean {
  const call = bashCallSchema.safeParse(value);
  return (
    call.success &&
    /(?:^|[;&|]\s*)tools\s+attachment\.add_files(?:\s|$)/u.test(call.data.command.trim())
  );
}
