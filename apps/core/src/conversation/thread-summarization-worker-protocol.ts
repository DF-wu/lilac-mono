import { Result, TaggedError, type Result as ResultType } from "better-result";
import { z } from "zod";

const nonemptyStringSchema = z.string().min(1);
const countSchema = z.number().finite().int().nonnegative();

const threadSummarizationInputSchema = z.strictObject({
  jobId: nonemptyStringSchema.optional(),
  trigger: z.enum(["manual", "periodic"]).optional(),
  dryRun: z.boolean().optional(),
  wait: z.boolean().optional(),
  force: z.boolean().optional(),
  clear: z.boolean().optional(),
  limit: z.number().finite().optional(),
  threadId: nonemptyStringSchema.optional(),
  beforeTs: z.number().finite().optional(),
  afterTs: z.number().finite().optional(),
  now: z.number().finite().optional(),
});

const eligibilityReasonCountsSchema = z.strictObject({
  forced: countSchema.optional(),
  "never-summarized": countSchema.optional(),
  "content-changed": countSchema.optional(),
  "summary-version": countSchema.optional(),
  "embedding-missing": countSchema.optional(),
  "embedding-outdated": countSchema.optional(),
  "embedding-version": countSchema.optional(),
  "embedding-model": countSchema.optional(),
});

export const threadSummarizationResultSchema = z.strictObject({
  dryRun: z.boolean(),
  refreshed: z.strictObject({
    channels: countSchema,
    threads: countSchema,
    messages: countSchema,
  }),
  eligible: countSchema,
  eligibleTotal: countSchema,
  eligibility: z.strictObject({
    summary: countSchema,
    embeddingOnly: countSchema,
    reasons: eligibilityReasonCountsSchema,
  }),
  cleared: countSchema,
  summarized: countSchema,
  failed: countSchema,
  failures: z.array(
    z.strictObject({ threadId: nonemptyStringSchema, error: nonemptyStringSchema }),
  ),
  threadIds: z.array(nonemptyStringSchema),
  jobId: nonemptyStringSchema.optional(),
  status: z.enum(["queued", "completed"]).optional(),
});

export type ThreadSummarizationResult = z.infer<typeof threadSummarizationResultSchema>;

export const threadSummarizationWorkerRequestSchema = z.strictObject({
  id: nonemptyStringSchema,
  input: threadSummarizationInputSchema,
  searchDbPath: nonemptyStringSchema,
  surfaceDbPath: nonemptyStringSchema.optional(),
});

export type ThreadSummarizationWorkerRequest = z.infer<
  typeof threadSummarizationWorkerRequestSchema
>;

export const threadSummarizationWorkerResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    id: nonemptyStringSchema,
    ok: z.literal(true),
    result: threadSummarizationResultSchema,
  }),
  z.strictObject({
    id: nonemptyStringSchema,
    ok: z.literal(false),
    error: nonemptyStringSchema,
  }),
]);

export type ThreadSummarizationWorkerResponse = z.infer<
  typeof threadSummarizationWorkerResponseSchema
>;

export class ThreadSummarizationWorkerRequestDecodeError extends TaggedError(
  "ThreadSummarizationWorkerRequestDecodeError",
)<{
  readonly issues: readonly string[];
  readonly message: string;
}> {}

export class ThreadSummarizationWorkerResponseDecodeError extends TaggedError(
  "ThreadSummarizationWorkerResponseDecodeError",
)<{
  readonly issues: readonly string[];
  readonly message: string;
}> {}

function formatIssues(error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
    return `${path}: ${issue.message}`;
  });
}

export function decodeThreadSummarizationWorkerRequest(
  input: unknown,
): ResultType<ThreadSummarizationWorkerRequest, ThreadSummarizationWorkerRequestDecodeError> {
  const parsed = threadSummarizationWorkerRequestSchema.safeParse(input);
  if (parsed.success) return Result.ok(parsed.data);
  return Result.err(
    new ThreadSummarizationWorkerRequestDecodeError({
      issues: formatIssues(parsed.error),
      message: "Invalid conversation thread summarization worker request",
    }),
  );
}

export function decodeThreadSummarizationWorkerResponse(
  input: unknown,
): ResultType<ThreadSummarizationWorkerResponse, ThreadSummarizationWorkerResponseDecodeError> {
  const parsed = threadSummarizationWorkerResponseSchema.safeParse(input);
  if (parsed.success) return Result.ok(parsed.data);
  return Result.err(
    new ThreadSummarizationWorkerResponseDecodeError({
      issues: formatIssues(parsed.error),
      message: "Invalid conversation thread summarization worker response",
    }),
  );
}
