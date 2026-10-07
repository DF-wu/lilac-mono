import { createTypeSafeAi, type TypeSafeAiProvider } from "@ai-sdk/typesafe-ai";
import {
  createOpenAIDecisionModel,
  opaqueErrorMessage,
  type CoreConfig,
} from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";
import { experimental_decide } from "ai";

type DecisionModel = ReturnType<TypeSafeAiProvider["decisionModel"]>;
type DecisionCall = Parameters<DecisionModel["doDecide"]>[0];
type DecisionResult = Awaited<ReturnType<DecisionModel["doDecide"]>>;

export type DecisionAutoInjectOptions =
  CoreConfig["conversation"]["thread"]["decisionAutoInject"]["jev"] & { limit: number };

export function selectDecisionAutoInjectModel(
  models: readonly string[],
  hasImages: boolean,
): string {
  return (
    (hasImages ? models.find((model) => model.startsWith("openai/")) : undefined) ?? models[0]!
  );
}

export function decisionAutoInjectOptionsForModel(
  config: CoreConfig["conversation"]["thread"]["decisionAutoInject"],
  model: string,
): DecisionAutoInjectOptions {
  return { ...(model.startsWith("openai/") ? config.luna : config.jev), limit: config.limit };
}

export type DecisionAutoInjectCandidate = {
  threadId: string;
  title: string;
  brief: string;
};

export type DecisionAutoInjectAnswers = {
  asksToRecall: number;
  durableSubject: number;
  casual: number;
  /** P(candidate helps), aligned with the evaluated candidates. */
  relevance: readonly number[];
  usage?: { inputTokens?: number; outputTokens?: number };
};

export type DecisionAutoInjectEvaluator = {
  readonly model: string;
  readonly supportsImages?: boolean;
  evaluate(input: {
    message: string;
    candidates: readonly DecisionAutoInjectCandidate[];
    images?: readonly string[];
  }): Promise<ResultType<DecisionAutoInjectAnswers, DecisionAutoInjectEvaluationFailed>>;
};

export type DecisionAutoInjectScoredCandidate = {
  index: number;
  threadId: string;
  probability: number;
};

export type DecisionAutoInjectDecision = {
  gate: "recall" | "durable-subject" | null;
  selected: DecisionAutoInjectScoredCandidate[];
  highestRejected: DecisionAutoInjectScoredCandidate | null;
};

export class DecisionAutoInjectUnavailable extends TaggedError("DecisionAutoInjectUnavailable")<{
  readonly message: string;
}> {}

export class DecisionAutoInjectEvaluationFailed extends TaggedError(
  "DecisionAutoInjectEvaluationFailed",
)<{
  readonly message: string;
}> {}

// Keep the message cap used to evaluate the original Jev thresholds.
const DECISION_MESSAGE_MAX_CHARS = 4000;

const GATE_QUESTIONS = {
  asks_to_recall: "`message` asks to find or recall something discussed in a past conversation",
  durable_subject:
    "`message` is about a lasting subject in the user's life or work, such as a project, plan, decision, recurring problem, or relationship, rather than a one-off remark",
  casual:
    "`message` is a casual reaction, greeting, test, or short coordination with no substantive request",
} as const;

const CANDIDATE_QUESTION = "Would reading `candidate_thread` help respond to `message`?";

function candidateQuestionId(index: number): string {
  return `candidate_${index}`;
}

export function buildDecisionAutoInjectCall(input: {
  message: string;
  candidates: readonly DecisionAutoInjectCandidate[];
}): Pick<DecisionCall, "state" | "questions"> {
  const questions: Record<string, DecisionCall["questions"][string]> = {
    asks_to_recall: { type: "boolean", instructions: GATE_QUESTIONS.asks_to_recall },
    durable_subject: { type: "boolean", instructions: GATE_QUESTIONS.durable_subject },
    casual: { type: "boolean", instructions: GATE_QUESTIONS.casual },
  };
  input.candidates.forEach((candidate, index) => {
    questions[candidateQuestionId(index)] = {
      type: "boolean",
      instructions: {
        candidate_thread: { title: candidate.title, summary: candidate.brief },
        question: CANDIDATE_QUESTION,
      },
    };
  });
  return {
    state: { message: input.message.slice(0, DECISION_MESSAGE_MAX_CHARS) },
    questions,
  };
}

function booleanProbability(result: DecisionResult, questionId: string): number | null {
  const answer = result.answers[questionId];
  if (answer?.type !== "boolean") return null;
  return Number.isFinite(answer.probability) ? answer.probability : null;
}

export function decodeDecisionAutoInjectAnswers(
  result: DecisionResult,
  candidateCount: number,
): ResultType<DecisionAutoInjectAnswers, DecisionAutoInjectEvaluationFailed> {
  const questionIds = ["asks_to_recall", "durable_subject", "casual"];
  for (let index = 0; index < candidateCount; index += 1) {
    questionIds.push(candidateQuestionId(index));
  }
  const probabilities = questionIds.map((questionId) => booleanProbability(result, questionId));
  const missing = questionIds.filter((_, index) => probabilities[index] === null);
  if (missing.length > 0) {
    return Result.err(
      new DecisionAutoInjectEvaluationFailed({
        message: `Decision response is missing boolean answers for ${missing.join(", ")}`,
      }),
    );
  }
  const [asksToRecall = 0, durableSubject = 0, casual = 0, ...relevance] = probabilities.map(
    (probability) => probability ?? 0,
  );
  return Result.ok({
    asksToRecall,
    durableSubject,
    casual,
    relevance,
    ...(result.usage ? { usage: result.usage } : {}),
  });
}

function selectDecisionGate(
  answers: DecisionAutoInjectAnswers,
  options: DecisionAutoInjectOptions,
): DecisionAutoInjectDecision["gate"] {
  if (answers.asksToRecall >= options.recallMinProbability) return "recall";
  if (
    answers.durableSubject >= options.durableSubjectMinProbability &&
    answers.casual < options.casualMaxProbability
  ) {
    return "durable-subject";
  }
  return null;
}

export function decideDecisionAutoInject(input: {
  answers: DecisionAutoInjectAnswers;
  candidates: readonly DecisionAutoInjectCandidate[];
  options: DecisionAutoInjectOptions;
}): DecisionAutoInjectDecision {
  const gate = selectDecisionGate(input.answers, input.options);
  const ranked = input.candidates
    .map((candidate, index) => ({
      index,
      threadId: candidate.threadId,
      probability: input.answers.relevance[index] ?? 0,
    }))
    .sort((left, right) => right.probability - left.probability || left.index - right.index);
  if (!gate) return { gate, selected: [], highestRejected: ranked[0] ?? null };

  const selected = ranked
    .filter((candidate) => candidate.probability >= input.options.relevanceMinProbability)
    .slice(0, input.options.limit);
  return { gate, selected, highestRejected: ranked[selected.length] ?? null };
}

export function createDecisionAutoInjectEvaluator(input: {
  apiKey?: string;
  baseUrl?: string;
  model: string;
  fetch?: typeof globalThis.fetch;
}): ResultType<DecisionAutoInjectEvaluator, DecisionAutoInjectUnavailable> {
  const slash = input.model.indexOf("/");
  const provider = slash < 0 ? "typesafe" : input.model.slice(0, slash);
  const modelId = slash < 0 ? input.model : input.model.slice(slash + 1);
  if ((provider !== "typesafe" && provider !== "openai") || !modelId.trim()) {
    return Result.err(
      new DecisionAutoInjectUnavailable({
        message: "Decision auto-inject models must use typesafe/model or openai/model",
      }),
    );
  }
  const apiKey = input.apiKey?.trim();
  if (!apiKey) {
    const variable = provider === "openai" ? "OPENAI_API_KEY" : "TYPESAFE_AI_API_KEY";
    return Result.err(
      new DecisionAutoInjectUnavailable({
        message: `${variable} is required for ${provider} decision auto-inject`,
      }),
    );
  }
  const baseUrl = input.baseUrl?.trim() || undefined;
  if (provider === "openai") {
    return Result.ok({
      model: `openai/${modelId}`,
      supportsImages: true,
      async evaluate(evaluateInput) {
        const model = createOpenAIDecisionModel({
          apiKey,
          baseUrl,
          model: modelId,
          images: evaluateInput.images,
          fetch: input.fetch,
        });
        return createDecisionAutoInjectEvaluatorForModel(model).evaluate(evaluateInput);
      },
    });
  }
  const model = createTypeSafeAi({ apiKey, baseURL: baseUrl, fetch: input.fetch }).decisionModel(
    modelId,
  );
  return Result.ok(createDecisionAutoInjectEvaluatorForModel(model));
}

export function createDecisionAutoInjectEvaluatorForModel(
  model: Pick<DecisionModel, "modelId" | "doDecide"> &
    Partial<Pick<DecisionModel, "provider" | "specificationVersion" | "supportedQuestionTypes">>,
): DecisionAutoInjectEvaluator {
  const decisionModel: DecisionModel = {
    specificationVersion: "v4",
    provider: model.provider ?? "decision",
    supportedQuestionTypes: model.supportedQuestionTypes ?? ["boolean"],
    modelId: model.modelId,
    doDecide: (call) => model.doDecide(call),
  };
  return {
    model: model.modelId,
    async evaluate(evaluateInput) {
      const evaluated = await Result.tryPromise({
        try: async () =>
          await experimental_decide({
            model: decisionModel,
            ...buildDecisionAutoInjectCall(evaluateInput),
            maxRetries: 0,
          }),
        catch: (cause) =>
          new DecisionAutoInjectEvaluationFailed({
            message: opaqueErrorMessage(cause, "Decision evaluation failed"),
          }),
      });
      return evaluated.andThen((result) =>
        decodeDecisionAutoInjectAnswers(result, evaluateInput.candidates.length),
      );
    },
  };
}
