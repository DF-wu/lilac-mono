import type {
  CanonicalPayloadSelection,
  PrepareModelCall,
  PrepareModelCallContext,
  PreparedModelCall,
} from "@stanley2058/lilac-agent";
import { hashCanonicalMessagesV1 } from "@stanley2058/lilac-agent";
import type { LanguageModel, ModelMessage } from "ai";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import type {
  ClaudeNativeAttemptObservation,
  ClaudeNativeSessionLifecycle,
  MaterializedClaudeCodeRun,
} from "./claude-code-run";

export class ClaudeAttemptRuntimeInvalidInput extends TaggedError(
  "ClaudeAttemptRuntimeInvalidInput",
)<{
  readonly message: string;
}> {}

export class ClaudeAttemptRuntimeStateFailed extends TaggedError(
  "ClaudeAttemptRuntimeStateFailed",
)<{
  readonly message: string;
}> {}

export class ClaudeAttemptRuntimeCandidateFailed extends TaggedError(
  "ClaudeAttemptRuntimeCandidateFailed",
)<{
  readonly cause?: unknown;
  readonly message: string;
}> {}

export class ClaudeAttemptRuntimeCleanupFailed extends TaggedError(
  "ClaudeAttemptRuntimeCleanupFailed",
)<{
  readonly cause: unknown;
  readonly message: string;
}> {}

export class ClaudeAttemptRuntimeOperationAndCleanupFailed extends TaggedError(
  "ClaudeAttemptRuntimeOperationAndCleanupFailed",
)<{
  readonly operationError: ClaudeAttemptRuntimeCandidateFailed | ClaudeAttemptRuntimeStateFailed;
  readonly cleanupError: ClaudeAttemptRuntimeCleanupFailed;
  readonly message: string;
}> {}

export type ClaudeAttemptRuntimeError =
  | ClaudeAttemptRuntimeInvalidInput
  | ClaudeAttemptRuntimeStateFailed
  | ClaudeAttemptRuntimeCandidateFailed
  | ClaudeAttemptRuntimeCleanupFailed
  | ClaudeAttemptRuntimeOperationAndCleanupFailed;

export type ClaudeAttemptRuntimeCandidate = {
  readonly run: MaterializedClaudeCodeRun;
  readonly modelSpecifier: string;
  readonly initialPayload: CanonicalPayloadSelection;
};

export type ClaudeAttemptRuntimeCandidateFactoryRequest<FactoryInputs> = {
  readonly attemptIndex: number;
  readonly inputs: FactoryInputs;
  /** Stable across caller-approved retries; replaced after canonical replacement. */
  readonly prepareContext: PrepareModelCallContext;
};

export type ClaudeAttemptRuntimeCandidateFactory<FactoryInputs> = (
  request: ClaudeAttemptRuntimeCandidateFactoryRequest<FactoryInputs>,
) => Promise<ClaudeAttemptRuntimeCandidate>;

export type ClaudeAttemptRuntimeCursor = {
  readonly canonicalMessageCount: number;
  readonly canonicalPrefixHash: string;
  readonly nativeContextTokens: number | null;
  readonly nativeContextMaxTokens: number | null;
};

export type ClaudeAttemptRuntimeOwnerPhase =
  | "idle"
  | "materializing"
  | "active"
  | "unusable"
  | "retired";

export type ClaudeAttemptRuntimeOwnerState = {
  readonly phase: ClaudeAttemptRuntimeOwnerPhase;
  /** The active attempt index, or the index that the next factory call will receive. */
  readonly attemptIndex: number;
  readonly cursor: ClaudeAttemptRuntimeCursor | null;
  readonly nativeObservation: ClaudeNativeAttemptObservation | null;
  readonly unusableReason: string | null;
};

export type ClaudeAttemptRuntimeInputEstimate = {
  readonly unsynchronizedSuffixAndOverlayEstimate: number;
  readonly storedNativeContextTokens?: number | null;
};

type ValidatedCandidate = ClaudeAttemptRuntimeCandidate & {
  readonly nativeSession: ClaudeNativeSessionLifecycle;
  readonly continuationModel: LanguageModel;
  readonly attemptIdentity: string;
};

function resultOutcome<T, E>(
  result: ResultType<T, E>,
): { ok: true; value: T } | { ok: false; error: E } {
  return result.match<{ ok: true; value: T } | { ok: false; error: E }>({
    ok: (value) => ({ ok: true, value }),
    err: (error) => ({ ok: false, error }),
  });
}

function stateError(message: string): ClaudeAttemptRuntimeStateFailed {
  return new ClaudeAttemptRuntimeStateFailed({ message });
}

function candidateError(message: string): ClaudeAttemptRuntimeCandidateFailed {
  return new ClaudeAttemptRuntimeCandidateFailed({ message });
}

async function captureCandidateFactory(
  create: () => Promise<ClaudeAttemptRuntimeCandidate>,
): Promise<ResultType<ClaudeAttemptRuntimeCandidate, ClaudeAttemptRuntimeCandidateFailed>> {
  try {
    return Result.ok(await create());
  } catch (cause) {
    if (Panic.is(cause)) throw cause;
    return Result.err(
      new ClaudeAttemptRuntimeCandidateFailed({
        cause,
        message: "Claude candidate factory failed",
      }),
    );
  }
}

async function disposeRun(
  run: MaterializedClaudeCodeRun,
): Promise<ResultType<void, ClaudeAttemptRuntimeCleanupFailed>> {
  const disposed = resultOutcome(await run.disposeResult());
  if (!disposed.ok) {
    return Result.err(
      new ClaudeAttemptRuntimeCleanupFailed({
        cause: disposed.error,
        message: "Claude candidate cleanup failed",
      }),
    );
  }
  return Result.ok();
}

async function rejectCandidate(
  run: MaterializedClaudeCodeRun,
  error: ClaudeAttemptRuntimeCandidateFailed,
): Promise<
  ResultType<
    never,
    ClaudeAttemptRuntimeCandidateFailed | ClaudeAttemptRuntimeOperationAndCleanupFailed
  >
> {
  const cleanup = await disposeRun(run);
  const cleanupOutcome = resultOutcome(cleanup);
  if (cleanupOutcome.ok) return Result.err(error);
  return Result.err(
    new ClaudeAttemptRuntimeOperationAndCleanupFailed({
      operationError: error,
      cleanupError: cleanupOutcome.error,
      message: `${error.message}; cleanup also failed`,
    }),
  );
}

export class ClaudeAttemptRuntimeOwner<FactoryInputs> {
  /** Compatibility adapter required by the Agent `PrepareModelCall` contract. */
  readonly prepare: PrepareModelCall = async (context) => {
    const prepared = resultOutcome(await this.prepareResult(context));
    if (!prepared.ok) throw prepared.error;
    return prepared.value;
  };

  private readonly factoryInputs: FactoryInputs;
  private readonly createCandidate: ClaudeAttemptRuntimeCandidateFactory<FactoryInputs>;

  private attemptIndex = 0;
  private attemptConsumed = false;
  private candidate: ValidatedCandidate | null = null;
  private materialization: Promise<
    ResultType<ValidatedCandidate, ClaudeAttemptRuntimeError>
  > | null = null;
  private stablePrepareContext: PrepareModelCallContext | null = null;
  private cursor: ClaudeAttemptRuntimeCursor | null = null;
  private lastPreparedCanonicalCount: number | null = null;
  private lastPreparedCanonicalHash: string | null = null;
  private lastObservation: ClaudeNativeAttemptObservation | null = null;
  private hasSuccessfulCall = false;
  private unusableReason: string | null = null;
  private ended = false;
  private runEndRetirement: Promise<ResultType<void, ClaudeAttemptRuntimeError>> | null = null;
  private runEndCompatibilityRetirement: Promise<void> | null = null;

  constructor(options: {
    readonly factoryInputs: FactoryInputs;
    readonly createCandidate: ClaudeAttemptRuntimeCandidateFactory<FactoryInputs>;
  }) {
    this.factoryInputs = options.factoryInputs;
    this.createCandidate = options.createCandidate;
  }

  get state(): ClaudeAttemptRuntimeOwnerState {
    const liveObservation = this.candidate?.nativeSession.getObservation() ?? null;
    let phase: ClaudeAttemptRuntimeOwnerState["phase"] = "idle";
    if (this.ended) phase = "retired";
    else if (this.unusableReason) phase = "unusable";
    else if (this.candidate) phase = "active";
    else if (this.materialization) phase = "materializing";
    return {
      phase,
      attemptIndex: this.attemptIndex,
      cursor: this.cursor ? { ...this.cursor } : null,
      nativeObservation: liveObservation ?? this.lastObservation,
      unusableReason: this.unusableReason,
    };
  }

  get currentCandidate(): ClaudeAttemptRuntimeCandidate | null {
    return this.candidate;
  }

  getNativeInputEstimateFloorResult(
    input: ClaudeAttemptRuntimeInputEstimate,
  ): ResultType<number | null, ClaudeAttemptRuntimeInvalidInput> {
    const suffixAndOverlayEstimate = input.unsynchronizedSuffixAndOverlayEstimate;
    if (!Number.isFinite(suffixAndOverlayEstimate) || suffixAndOverlayEstimate < 0) {
      return Result.err(
        new ClaudeAttemptRuntimeInvalidInput({
          message: "Unsynchronized suffix and overlay estimate must be finite and non-negative",
        }),
      );
    }
    const storedTokens = input.storedNativeContextTokens;
    if (
      storedTokens !== undefined &&
      storedTokens !== null &&
      (!Number.isFinite(storedTokens) || storedTokens < 0)
    ) {
      return Result.err(
        new ClaudeAttemptRuntimeInvalidInput({
          message: "Stored native context tokens must be finite and non-negative",
        }),
      );
    }
    const currentTokens = this.cursor?.nativeContextTokens ?? null;
    if (currentTokens !== null && (!Number.isFinite(currentTokens) || currentTokens < 0)) {
      return Result.err(
        new ClaudeAttemptRuntimeInvalidInput({
          message: "Current native context tokens must be finite and non-negative",
        }),
      );
    }
    const nativeTokens = currentTokens ?? storedTokens ?? null;
    if (nativeTokens === null) return Result.ok(null);
    const floor = suffixAndOverlayEstimate + nativeTokens;
    if (!Number.isFinite(floor)) {
      return Result.err(
        new ClaudeAttemptRuntimeInvalidInput({
          message: "Native input estimate floor must be finite",
        }),
      );
    }
    return Result.ok(floor);
  }

  /** Compatibility adapter for the established synchronous estimate contract. */
  getNativeInputEstimateFloor(input: ClaudeAttemptRuntimeInputEstimate): number | null {
    const estimate = resultOutcome(this.getNativeInputEstimateFloorResult(input));
    if (!estimate.ok) throw estimate.error;
    return estimate.value;
  }

  async recordSuccessfulModelCallResult(
    canonicalMessages: readonly ModelMessage[],
  ): Promise<ResultType<void, ClaudeAttemptRuntimeError>> {
    const parsedCount = canonicalMessages.length;
    const candidate = this.candidate;
    if (!candidate || this.unusableReason) {
      return Result.err(
        stateError("Cannot record a successful model call without a usable Claude candidate"),
      );
    }
    if (this.lastPreparedCanonicalCount === null) {
      return Result.err(stateError("Cannot record a successful model call before prepare"));
    }
    const completedPreparedPrefixHash = hashCanonicalMessagesV1(
      canonicalMessages.slice(0, this.lastPreparedCanonicalCount),
    ).hash;
    if (
      this.lastPreparedCanonicalHash === null ||
      completedPreparedPrefixHash !== this.lastPreparedCanonicalHash
    ) {
      return this.markUnusable(candidate, "canonical history changed after model-call preparation");
    }
    if (parsedCount < this.lastPreparedCanonicalCount) {
      return Result.err(
        stateError(
          `Successful canonical count ${parsedCount} is below prepared count ${this.lastPreparedCanonicalCount}`,
        ),
      );
    }
    if (this.cursor && parsedCount < this.cursor.canonicalMessageCount) {
      return Result.err(
        stateError(
          `Successful canonical count ${parsedCount} is behind cursor ${this.cursor.canonicalMessageCount}`,
        ),
      );
    }
    if (this.cursor) {
      const synchronizedPrefixHash = hashCanonicalMessagesV1(
        canonicalMessages.slice(0, this.cursor.canonicalMessageCount),
      ).hash;
      if (synchronizedPrefixHash !== this.cursor.canonicalPrefixHash) {
        return this.markUnusable(
          candidate,
          "canonical prefix changed before successful cursor advancement",
        );
      }
    }

    const observation = await candidate.nativeSession.waitForObservation();
    this.lastObservation = observation;
    const identityValid =
      observation.requestedSessionId !== null &&
      observation.initSessionId === observation.requestedSessionId &&
      observation.resultSessionId === observation.requestedSessionId &&
      observation.requiredObservabilityError === null;
    if (!identityValid) {
      return this.markUnusable(
        candidate,
        "terminal native session identity is missing, mismatched, or conflicting",
      );
    }
    if (observation.contextTokens === null || observation.contextMaxTokens === null) {
      const unusable = await this.markUnusable(
        candidate,
        "terminal native context usage is missing",
      );
      const unusableOutcome = resultOutcome(unusable);
      return !unusableOutcome.ok && unusableOutcome.error._tag === "ClaudeAttemptRuntimeStateFailed"
        ? Result.ok()
        : unusable;
    }
    this.cursor = {
      canonicalMessageCount: parsedCount,
      canonicalPrefixHash: hashCanonicalMessagesV1(canonicalMessages).hash,
      nativeContextTokens: observation.contextTokens,
      nativeContextMaxTokens: observation.contextMaxTokens,
    };
    this.hasSuccessfulCall = true;
    return Result.ok();
  }

  /** Compatibility adapter for existing continuation consumers. */
  async recordSuccessfulModelCall(canonicalMessages: readonly ModelMessage[]): Promise<void> {
    const recorded = resultOutcome(await this.recordSuccessfulModelCallResult(canonicalMessages));
    if (!recorded.ok) throw recorded.error;
  }

  async retireForRetryResult(): Promise<ResultType<void, ClaudeAttemptRuntimeError>> {
    const active = resultOutcome(this.notEnded("retry"));
    if (!active.ok) return Result.err(active.error);
    if (!this.attemptConsumed) return Result.ok();
    const retired = await this.retireCandidateResult();
    this.attemptIndex += 1;
    this.attemptConsumed = false;
    this.resetAttemptState({ preservePrepareContext: true });
    return retired;
  }

  async retireForRetry(): Promise<void> {
    const retired = resultOutcome(await this.retireForRetryResult());
    if (!retired.ok) throw retired.error;
  }

  async retireForCanonicalReplacementResult(): Promise<
    ResultType<void, ClaudeAttemptRuntimeError>
  > {
    const active = resultOutcome(this.notEnded("canonical replacement"));
    if (!active.ok) return Result.err(active.error);
    const consumed = this.attemptConsumed;
    const retired = await this.retireCandidateResult();
    if (consumed) this.attemptIndex += 1;
    this.attemptConsumed = false;
    this.resetAttemptState({ preservePrepareContext: false });
    return retired;
  }

  async retireForCanonicalReplacement(): Promise<void> {
    const retired = resultOutcome(await this.retireForCanonicalReplacementResult());
    if (!retired.ok) throw retired.error;
  }

  retireAtRunEndResult(): Promise<ResultType<void, ClaudeAttemptRuntimeError>> {
    if (this.runEndRetirement) return this.runEndRetirement;
    this.ended = true;
    this.runEndRetirement = this.retireAtRunEndInternal();
    return this.runEndRetirement;
  }

  retireAtRunEnd(): Promise<void> {
    if (this.runEndCompatibilityRetirement) return this.runEndCompatibilityRetirement;
    this.runEndCompatibilityRetirement = this.adaptRunEndRetirementToHost();
    return this.runEndCompatibilityRetirement;
  }

  async prepareResult(
    context: PrepareModelCallContext,
  ): Promise<ResultType<PreparedModelCall, ClaudeAttemptRuntimeError>> {
    const active = resultOutcome(this.notEnded("prepare"));
    if (!active.ok) return Result.err(active.error);
    if (this.unusableReason) {
      return Result.err(stateError(`Claude candidate is unusable: ${this.unusableReason}`));
    }

    this.stablePrepareContext ??= context;
    let materialized = resultOutcome(await this.materializeCandidateResult());
    if (!materialized.ok) return Result.err(materialized.error);
    let candidate = materialized.value;
    let payload: CanonicalPayloadSelection = this.hasSuccessfulCall
      ? { mode: "suffix", startIndex: this.cursor?.canonicalMessageCount ?? 0 }
      : candidate.initialPayload;

    if (payload.mode === "suffix" && this.cursor) {
      const currentPrefixHash = hashCanonicalMessagesV1(
        context.canonicalMessages.slice(0, payload.startIndex),
      ).hash;
      if (currentPrefixHash !== this.cursor.canonicalPrefixHash) {
        const replaced = resultOutcome(await this.replaceForCanonicalMismatchResult());
        if (!replaced.ok) return Result.err(replaced.error);
        this.stablePrepareContext = context;
        materialized = resultOutcome(await this.materializeCandidateResult());
        if (!materialized.ok) return Result.err(materialized.error);
        candidate = materialized.value;
        payload = candidate.initialPayload;
      }
    }

    const suffixStart = payload.mode === "full" ? 0 : payload.startIndex;
    if (suffixStart > context.canonicalMessages.length) {
      const reason = `canonical suffix ${suffixStart} exceeds message count ${context.canonicalMessages.length}`;
      return this.markUnusable(candidate, reason);
    }

    this.lastPreparedCanonicalCount = context.canonicalMessages.length;
    this.lastPreparedCanonicalHash = hashCanonicalMessagesV1(context.canonicalMessages).hash;
    return Result.ok({
      runtime: {
        model: this.hasSuccessfulCall ? candidate.continuationModel : candidate.run.agentModel,
        modelSpecifier: candidate.modelSpecifier,
        executionMode: "provider-tools",
        persistentAttemptIdentity: candidate.attemptIdentity,
        streamTextMaxRetries: 0,
      },
      payload,
    });
  }

  private materializeCandidateResult(): Promise<
    ResultType<ValidatedCandidate, ClaudeAttemptRuntimeError>
  > {
    if (this.candidate) return Promise.resolve(Result.ok(this.candidate));
    if (this.materialization) return this.materialization;
    const prepareContext = this.stablePrepareContext;
    if (!prepareContext) {
      return Promise.resolve(
        Result.err(stateError("Claude candidate materialization requires prepare context")),
      );
    }

    this.attemptConsumed = true;
    const materialization = this.createAndValidateCandidate(prepareContext);
    this.materialization = materialization;
    void materialization.then(() => {
      if (this.materialization === materialization) this.materialization = null;
    });
    return materialization;
  }

  private async createAndValidateCandidate(
    prepareContext: PrepareModelCallContext,
  ): Promise<ResultType<ValidatedCandidate, ClaudeAttemptRuntimeError>> {
    const created = resultOutcome(
      await captureCandidateFactory(() =>
        this.createCandidate({
          attemptIndex: this.attemptIndex,
          inputs: this.factoryInputs,
          prepareContext,
        }),
      ),
    );
    if (!created.ok) {
      this.unusableReason = created.error.message;
      return Result.err(created.error);
    }
    const candidate = created.value;
    const nativeSession = candidate.run.nativeSession;
    if (!nativeSession) {
      return this.rejectAndRemember(
        candidate.run,
        candidateError("Invalid Claude candidate: native session lifecycle is missing"),
      );
    }
    const observation = nativeSession.getObservation();
    if (observation.requestedSessionId === null) {
      return this.rejectAndRemember(
        candidate.run,
        candidateError("Invalid Claude candidate: ephemeral native sessions are not supported"),
      );
    }
    if (!candidate.run.continuationModel) {
      return this.rejectAndRemember(
        candidate.run,
        candidateError("Invalid Claude candidate: continuation model is missing"),
      );
    }
    if (observation.sourceSessionId === null && candidate.initialPayload.mode !== "full") {
      return this.rejectAndRemember(
        candidate.run,
        candidateError("Invalid Claude candidate: fresh sessions require a full initial payload"),
      );
    }
    if (observation.sourceSessionId !== null && candidate.initialPayload.mode !== "suffix") {
      return this.rejectAndRemember(
        candidate.run,
        candidateError("Invalid Claude candidate: fork sessions require a suffix initial payload"),
      );
    }

    const initialStart =
      candidate.initialPayload.mode === "full" ? 0 : candidate.initialPayload.startIndex;
    if (initialStart > prepareContext.canonicalMessages.length) {
      return this.rejectAndRemember(
        candidate.run,
        candidateError(
          `Invalid Claude candidate: canonical suffix ${initialStart} exceeds message count ${prepareContext.canonicalMessages.length}`,
        ),
      );
    }

    this.lastObservation = observation;
    this.cursor = {
      canonicalMessageCount: initialStart,
      canonicalPrefixHash: hashCanonicalMessagesV1(
        prepareContext.canonicalMessages.slice(0, initialStart),
      ).hash,
      nativeContextTokens: observation.contextTokens,
      nativeContextMaxTokens: observation.contextMaxTokens,
    };
    const validated = {
      ...candidate,
      nativeSession,
      continuationModel: candidate.run.continuationModel,
      attemptIdentity: observation.requestedSessionId,
    } satisfies ValidatedCandidate;
    this.candidate = validated;
    return Result.ok(validated);
  }

  private async rejectAndRemember(
    run: MaterializedClaudeCodeRun,
    error: ClaudeAttemptRuntimeCandidateFailed,
  ): Promise<ResultType<never, ClaudeAttemptRuntimeError>> {
    this.unusableReason = error.message;
    return rejectCandidate(run, error);
  }

  private async markUnusable(
    candidate: ValidatedCandidate,
    reason: string,
  ): Promise<
    ResultType<
      never,
      ClaudeAttemptRuntimeStateFailed | ClaudeAttemptRuntimeOperationAndCleanupFailed
    >
  > {
    this.unusableReason = reason;
    this.candidate = null;
    const operationError = stateError(`Claude candidate is unusable: ${reason}`);
    const cleanup = await disposeRun(candidate.run);
    const cleanupOutcome = resultOutcome(cleanup);
    if (!cleanupOutcome.ok) {
      return Result.err(
        new ClaudeAttemptRuntimeOperationAndCleanupFailed({
          operationError,
          cleanupError: cleanupOutcome.error,
          message: `${operationError.message}; cleanup also failed`,
        }),
      );
    }
    return Result.err(operationError);
  }

  private async retireCandidateResult(): Promise<ResultType<void, ClaudeAttemptRuntimeError>> {
    const materialization = this.materialization;
    if (materialization) await materialization;
    const candidate = this.candidate;
    this.candidate = null;
    if (!candidate) return Result.ok();
    this.lastObservation = candidate.nativeSession.getObservation();
    return disposeRun(candidate.run);
  }

  private async replaceForCanonicalMismatchResult(): Promise<
    ResultType<void, ClaudeAttemptRuntimeError>
  > {
    const consumed = this.attemptConsumed;
    const retired = await this.retireCandidateResult();
    if (consumed) this.attemptIndex += 1;
    this.attemptConsumed = false;
    this.resetAttemptState({ preservePrepareContext: false });
    return retired;
  }

  private async retireAtRunEndInternal(): Promise<ResultType<void, ClaudeAttemptRuntimeError>> {
    const retired = await this.retireCandidateResult();
    this.cursor = null;
    this.lastPreparedCanonicalCount = null;
    this.lastPreparedCanonicalHash = null;
    this.stablePrepareContext = null;
    return retired;
  }

  private async adaptRunEndRetirementToHost(): Promise<void> {
    const retired = resultOutcome(await this.retireAtRunEndResult());
    if (!retired.ok) throw retired.error;
  }

  private resetAttemptState(options: { readonly preservePrepareContext: boolean }): void {
    this.cursor = null;
    this.lastPreparedCanonicalCount = null;
    this.lastPreparedCanonicalHash = null;
    this.hasSuccessfulCall = false;
    this.unusableReason = null;
    if (!options.preservePrepareContext) this.stablePrepareContext = null;
  }

  private notEnded(action: string): ResultType<void, ClaudeAttemptRuntimeStateFailed> {
    return this.ended
      ? Result.err(stateError(`Cannot ${action} after Claude run-end retirement`))
      : Result.ok();
  }
}
