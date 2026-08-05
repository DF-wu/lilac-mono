import { z } from "zod";
import type { Result as ResultType } from "better-result";
import {
  defineServerTool,
  type ServerTool,
  type ServerToolCallOptions,
} from "@stanley2058/lilac-plugin-runtime";

import type {
  ConversationThreadRunSummarizationResult,
  ConversationThreadToolService,
} from "../../conversation/thread-service";

const searchInputSchema = z.object({
  query: z
    .union([z.string().min(1), z.array(z.string().min(1)).min(1).max(10)])
    .describe(
      "Search query, or multiple query variants/facets of the same intent to combine into one merged ranking. Multi-query is not parallel independent searches.",
    ),
  mode: z
    .enum(["hybrid", "semantic", "lexical"])
    .optional()
    .describe("Search mode. Defaults to hybrid."),
  limit: z.coerce.number().int().positive().max(50).optional().describe("Max results."),
  minScore: z.coerce
    .number()
    .nonnegative()
    .optional()
    .describe("Minimum final score after ranking and aboutness coverage. Defaults to 0.1."),
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe("Only return threads in this Discord session/channel id."),
  participantId: z
    .string()
    .min(1)
    .optional()
    .describe("Only return threads containing this Discord user id."),
  beforeTs: z.coerce
    .number()
    .nonnegative()
    .optional()
    .describe("Only return threads ending at or before this epoch ms."),
  afterTs: z.coerce
    .number()
    .nonnegative()
    .optional()
    .describe("Only return threads ending at or after this epoch ms."),
  verbose: z.boolean().optional().describe("Include scores, ids, anchors, and derived state."),
});

const readInputSchema = z.object({
  threadId: z.string().min(1).describe("Conversation thread id."),
  offset: z.coerce.number().int().nonnegative().optional().describe("Message offset."),
  limit: z.coerce.number().int().positive().max(200).optional().describe("Max messages."),
});

const metadataInputSchema = z.object({
  threadIds: z.array(z.string().min(1)).min(1).max(20).describe("Conversation thread ids."),
});

const runSummarizationInputSchema = z.object({
  dryRun: z.boolean().optional().describe("Only report eligible threads without summarizing."),
  force: z
    .boolean()
    .optional()
    .describe("Rerun summaries for quiet eligible threads even when fresh."),
  clear: z
    .boolean()
    .optional()
    .describe(
      "Clear existing summaries, facets, and embeddings before summarizing matching threads.",
    ),
  wait: z
    .boolean()
    .optional()
    .describe(
      "When a background worker is available, wait for completion instead of returning a queued job id.",
    ),
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(10_000)
    .optional()
    .describe("Optional maximum threads to process. Manual runs are unbounded by default."),
  threadId: z.string().min(1).optional().describe("Optional single thread id."),
  beforeTs: z.coerce
    .number()
    .nonnegative()
    .optional()
    .describe("Only include threads ending at or before this epoch ms."),
  afterTs: z.coerce
    .number()
    .nonnegative()
    .optional()
    .describe("Only include threads ending at or after this epoch ms."),
});

const CONVERSATION_THREAD_CALLABLE_IDS = {
  search: "conversation.thread.search",
  metadata: "conversation.thread.metadata",
  read: "conversation.thread.read",
  runSummarization: "conversation.thread.runSummarization",
} as const;

function adaptConversationThreadResultToToolHost<TValue>(
  result: ResultType<TValue, { readonly message: string }>,
): TValue {
  if (result.status === "ok") return result.value;
  throw new Error(result.error.message);
}

export async function resolveConversationThreadSummarizationToolOperation(
  operation: Promise<
    ResultType<ConversationThreadRunSummarizationResult, { readonly message: string }>
  >,
): Promise<ConversationThreadRunSummarizationResult> {
  return adaptConversationThreadResultToToolHost(await operation);
}

export class ConversationThread implements ServerTool {
  private readonly tool: ServerTool;

  constructor(
    private readonly params: {
      service: ConversationThreadToolService;
    },
  ) {
    this.tool = defineServerTool({
      id: "conversation.thread",
      callables: ({ callable }) => ({
        [CONVERSATION_THREAD_CALLABLE_IDS.search]: callable({
          name: "Conversation Thread Search",
          description:
            "Search summarized conversation threads. Returns compact threadId, title, and brief by default; use verbose for metadata/diagnostics or conversation.thread.read to expand a result. Multi-query combines variants of one intent into one merged ranking.",
          inputSchema: searchInputSchema,
          primaryPositional: { field: "query", variadic: true },
          run: (input) => this.params.service.search(input),
        }),
        [CONVERSATION_THREAD_CALLABLE_IDS.metadata]: callable({
          name: "Conversation Thread Metadata",
          description:
            "Read conversation thread summary metadata by ids without loading transcript messages. Supports up to 20 threadIds for candidate comparison.",
          inputSchema: metadataInputSchema,
          primaryPositional: { field: "threadIds", variadic: true },
          run: (input) => this.params.service.metadata(input),
        }),
        [CONVERSATION_THREAD_CALLABLE_IDS.read]: callable({
          name: "Conversation Thread Read",
          description:
            "Read a conversation thread transcript by id with offset/limit pagination. Output messages use content for message text.",
          inputSchema: readInputSchema,
          primaryPositional: "threadId",
          run: (input) => this.params.service.read(input),
        }),
        [CONVERSATION_THREAD_CALLABLE_IDS.runSummarization]: callable({
          name: "Conversation Thread Run Summarization",
          description: "Hidden admin runner for conversation thread refresh and summarization.",
          inputSchema: runSummarizationInputSchema,
          hidden: true,
          run: (input) => this.params.service.runSummarization(input),
        }),
      }),
    });
  }

  get id(): string {
    return this.tool.id;
  }

  init(): Promise<void> {
    return this.tool.init();
  }

  destroy(): Promise<void> {
    return this.tool.destroy();
  }

  list() {
    return this.tool.list();
  }

  call(
    callableId: string,
    input: Record<string, unknown>,
    opts?: ServerToolCallOptions,
  ): Promise<unknown> {
    return this.tool.call(callableId, input, opts);
  }
}
