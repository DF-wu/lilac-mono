import { createTypeSafeAi, type TypeSafeAiProvider } from "@ai-sdk/typesafe-ai";
import { opaqueErrorMessage, type CoreConfig } from "@stanley2058/lilac-utils";
import { Result, TaggedError, type Result as ResultType } from "better-result";

type JevDecisionModel = ReturnType<TypeSafeAiProvider["decisionModel"]>;
type JevDecisionCall = Parameters<JevDecisionModel["doDecide"]>[0];
type JevDecisionResult = Awaited<ReturnType<JevDecisionModel["doDecide"]>>;

export type JevAutoInjectOptions = CoreConfig["conversation"]["thread"]["jevAutoInject"];

export type JevAutoInjectCandidate = {
  threadId: string;
  title: string;
  brief: string;
};

export type JevAutoInjectAnswers = {
  asksToRecall: number;
  durableSubject: number;
  casual: number;
  /** P(candidate helps), aligned with the evaluated candidates. */
  relevance: readonly number[];
  usage?: { inputTokens?: number; outputTokens?: number };
};

export type JevAutoInjectEvaluator = {
  readonly model: string;
  evaluate(input: {
    message: string;
    candidates: readonly JevAutoInjectCandidate[];
  }): Promise<ResultType<JevAutoInjectAnswers, JevAutoInjectEvaluationFailed>>;
};

export type JevAutoInjectScoredCandidate = {
  index: number;
  threadId: string;
  probability: number;
};

export type JevAutoInjectDecision = {
  gate: "recall" | "durable-subject" | null;
  selected: JevAutoInjectScoredCandidate[];
  highestRejected: JevAutoInjectScoredCandidate | null;
};

export class JevAutoInjectUnavailable extends TaggedError("JevAutoInjectUnavailable")<{
  readonly message: string;
}> {}

export class JevAutoInjectEvaluationFailed extends TaggedError("JevAutoInjectEvaluationFailed")<{
  readonly message: string;
}> {}

// Jev latency stays flat with input size, but a pasted log can still be enormous. The eval that set
// the default thresholds used the same cap.
const JEV_MESSAGE_MAX_CHARS = 4000;

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

export function buildJevAutoInjectCall(input: {
  message: string;
  candidates: readonly JevAutoInjectCandidate[];
}): Pick<JevDecisionCall, "state" | "questions"> {
  const questions: Record<string, JevDecisionCall["questions"][string]> = {
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
    state: { message: input.message.slice(0, JEV_MESSAGE_MAX_CHARS) },
    questions,
  };
}

function booleanProbability(result: JevDecisionResult, questionId: string): number | null {
  const answer = result.answers[questionId];
  if (answer?.type !== "boolean") return null;
  return Number.isFinite(answer.probability) ? answer.probability : null;
}

export function decodeJevAutoInjectAnswers(
  result: JevDecisionResult,
  candidateCount: number,
): ResultType<JevAutoInjectAnswers, JevAutoInjectEvaluationFailed> {
  const questionIds = ["asks_to_recall", "durable_subject", "casual"];
  for (let index = 0; index < candidateCount; index += 1) {
    questionIds.push(candidateQuestionId(index));
  }
  const probabilities = questionIds.map((questionId) => booleanProbability(result, questionId));
  const missing = questionIds.filter((_, index) => probabilities[index] === null);
  if (missing.length > 0) {
    return Result.err(
      new JevAutoInjectEvaluationFailed({
        message: `Jev response is missing boolean answers for ${missing.join(", ")}`,
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

function selectJevGate(
  answers: JevAutoInjectAnswers,
  options: JevAutoInjectOptions,
): JevAutoInjectDecision["gate"] {
  if (answers.asksToRecall >= options.recallMinProbability) return "recall";
  if (
    answers.durableSubject >= options.durableSubjectMinProbability &&
    answers.casual < options.casualMaxProbability
  ) {
    return "durable-subject";
  }
  return null;
}

export function decideJevAutoInject(input: {
  answers: JevAutoInjectAnswers;
  candidates: readonly JevAutoInjectCandidate[];
  options: JevAutoInjectOptions;
}): JevAutoInjectDecision {
  const gate = selectJevGate(input.answers, input.options);
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

export function createJevAutoInjectEvaluator(input: {
  apiKey?: string;
  baseUrl?: string;
  model: string;
}): ResultType<JevAutoInjectEvaluator, JevAutoInjectUnavailable> {
  const apiKey = input.apiKey?.trim();
  if (!apiKey) {
    return Result.err(
      new JevAutoInjectUnavailable({
        message: "TYPESAFE_AI_API_KEY is required when conversation.thread.autoInjectMode is jev",
      }),
    );
  }
  const baseURL = input.baseUrl?.trim() || undefined;
  const model = createTypeSafeAi({ apiKey, ...(baseURL ? { baseURL } : {}) }).decisionModel(
    input.model,
  );
  return Result.ok(createJevAutoInjectEvaluatorForModel(model));
}

export function createJevAutoInjectEvaluatorForModel(
  model: Pick<JevDecisionModel, "modelId" | "doDecide">,
): JevAutoInjectEvaluator {
  return {
    model: model.modelId,
    async evaluate(evaluateInput) {
      const evaluated = await Result.tryPromise({
        try: async () => await model.doDecide(buildJevAutoInjectCall(evaluateInput)),
        catch: (cause) =>
          new JevAutoInjectEvaluationFailed({
            message: opaqueErrorMessage(cause, "Jev evaluation failed"),
          }),
      });
      return evaluated.andThen((result) =>
        decodeJevAutoInjectAnswers(result, evaluateInput.candidates.length),
      );
    },
  };
}
