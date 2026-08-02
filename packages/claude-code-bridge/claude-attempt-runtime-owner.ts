import type {
  CanonicalPayloadSelection,
  PrepareModelCall,
  PrepareModelCallContext,
  PreparedModelCall,
} from "@stanley2058/lilac-agent";
import { hashCanonicalMessagesV1 } from "@stanley2058/lilac-agent";
import type { LanguageModel, ModelMessage } from "ai";
import { z } from "zod";

import type {
  ClaudeNativeAttemptObservation,
  ClaudeNativeSessionLifecycle,
  MaterializedClaudeCodeRun,
} from "./claude-code-run";

const canonicalCountSchema = z.number().int().nonnegative();
const candidateSelectionSchema = z.object({
  run: z.custom<MaterializedClaudeCodeRun>(),
  modelSpecifier: z.string().min(1),
  initialPayload: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("full") }).strict(),
    z.object({ mode: z.literal("suffix"), startIndex: canonicalCountSchema }).strict(),
  ]),
});

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

export class ClaudeAttemptRuntimeOwner<FactoryInputs> {
  readonly prepare: PrepareModelCall = async (context) => this.prepareCall(context);

  private readonly factoryInputs: FactoryInputs;
  private readonly createCandidate: ClaudeAttemptRuntimeCandidateFactory<FactoryInputs>;

  private attemptIndex = 0;
  private attemptConsumed = false;
  private candidate: ValidatedCandidate | null = null;
  private materialization: Promise<ValidatedCandidate> | null = null;
  private stablePrepareContext: PrepareModelCallContext | null = null;
  private cursor: ClaudeAttemptRuntimeCursor | null = null;
  private lastPreparedCanonicalCount: number | null = null;
  private lastPreparedCanonicalHash: string | null = null;
  private lastObservation: ClaudeNativeAttemptObservation | null = null;
  private hasSuccessfulCall = false;
  private unusableReason: string | null = null;
  private ended = false;
  private runEndRetirement: Promise<void> | null = null;

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

  /**
   * Combines the latest native occupancy with the unsynchronized request contribution.
   * Callers may supply the stored clean-base snapshot before this owner captures live usage.
   */
  getNativeInputEstimateFloor(input: ClaudeAttemptRuntimeInputEstimate): number | null {
    const suffixAndOverlayEstimate = input.unsynchronizedSuffixAndOverlayEstimate;
    if (!Number.isFinite(suffixAndOverlayEstimate) || suffixAndOverlayEstimate < 0) {
      throw new RangeError(
        "Unsynchronized suffix and overlay estimate must be finite and non-negative",
      );
    }
    const storedTokens = input.storedNativeContextTokens;
    if (storedTokens !== undefined && storedTokens !== null) {
      if (!Number.isFinite(storedTokens) || storedTokens < 0) {
        throw new RangeError("Stored native context tokens must be finite and non-negative");
      }
    }
    const currentTokens = this.cursor?.nativeContextTokens ?? null;
    if (currentTokens !== null && (!Number.isFinite(currentTokens) || currentTokens < 0)) {
      throw new RangeError("Current native context tokens must be finite and non-negative");
    }
    const nativeTokens = currentTokens ?? storedTokens ?? null;
    if (nativeTokens === null) return null;
    const floor = suffixAndOverlayEstimate + nativeTokens;
    if (!Number.isFinite(floor)) {
      throw new RangeError("Native input estimate floor must be finite");
    }
    return floor;
  }

  /**
   * Records a completed outer call after the caller has committed its exact process-local
   * canonical messages. This method does not decide whether a failed call is retry-safe.
   */
  async recordSuccessfulModelCall(canonicalMessages: readonly ModelMessage[]): Promise<void> {
    const parsedCount = canonicalCountSchema.parse(canonicalMessages.length);
    const candidate = this.candidate;
    if (!candidate || this.unusableReason) {
      throw new Error("Cannot record a successful model call without a usable Claude candidate");
    }
    if (this.lastPreparedCanonicalCount === null) {
      throw new Error("Cannot record a successful model call before prepare");
    }
    const completedPreparedPrefixHash = hashCanonicalMessagesV1(
      canonicalMessages.slice(0, this.lastPreparedCanonicalCount),
    ).hash;
    if (
      this.lastPreparedCanonicalHash === null ||
      completedPreparedPrefixHash !== this.lastPreparedCanonicalHash
    ) {
      this.unusableReason = "canonical history changed after model-call preparation";
      this.candidate = null;
      await candidate.run.dispose();
      throw new Error(`Claude candidate is unusable: ${this.unusableReason}`);
    }
    if (parsedCount < this.lastPreparedCanonicalCount) {
      throw new Error(
        `Successful canonical count ${parsedCount} is below prepared count ${this.lastPreparedCanonicalCount}`,
      );
    }
    if (this.cursor && parsedCount < this.cursor.canonicalMessageCount) {
      throw new Error(
        `Successful canonical count ${parsedCount} is behind cursor ${this.cursor.canonicalMessageCount}`,
      );
    }
    if (this.cursor) {
      const synchronizedPrefixHash = hashCanonicalMessagesV1(
        canonicalMessages.slice(0, this.cursor.canonicalMessageCount),
      ).hash;
      if (synchronizedPrefixHash !== this.cursor.canonicalPrefixHash) {
        this.unusableReason = "canonical prefix changed before successful cursor advancement";
        this.candidate = null;
        await candidate.run.dispose();
        throw new Error(`Claude candidate is unusable: ${this.unusableReason}`);
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
      this.unusableReason =
        "terminal native session identity is missing, mismatched, or conflicting";
      this.candidate = null;
      await candidate.run.dispose();
      throw new Error(`Claude candidate is unusable: ${this.unusableReason}`);
    }
    if (observation.contextTokens === null || observation.contextMaxTokens === null) {
      this.unusableReason = "terminal native context usage is missing";
      this.candidate = null;
      await candidate.run.dispose();
      return;
    }
    const completedCanonicalHash = hashCanonicalMessagesV1(canonicalMessages).hash;
    this.cursor = {
      canonicalMessageCount: parsedCount,
      canonicalPrefixHash: completedCanonicalHash,
      nativeContextTokens: observation.contextTokens,
      nativeContextMaxTokens: observation.contextMaxTokens,
    };
    this.hasSuccessfulCall = true;
  }

  /**
   * Retires the current candidate for a retry already approved by the Agent retry-safety contract.
   * The next prepare reuses the original factory inputs and prepare context with a new attempt index.
   */
  async retireForRetry(): Promise<void> {
    this.assertNotEnded("retry");
    if (!this.attemptConsumed) return;

    try {
      await this.retireCandidate();
    } finally {
      this.attemptIndex += 1;
      this.attemptConsumed = false;
      this.resetAttemptState({ preservePrepareContext: true });
    }
  }

  /** Retires native lineage after canonical history is replaced. */
  async retireForCanonicalReplacement(): Promise<void> {
    this.assertNotEnded("canonical replacement");
    const consumed = this.attemptConsumed;
    try {
      await this.retireCandidate();
    } finally {
      if (consumed) this.attemptIndex += 1;
      this.attemptConsumed = false;
      this.resetAttemptState({ preservePrepareContext: false });
    }
  }

  /** Permanently and idempotently retires this request-local owner. */
  retireAtRunEnd(): Promise<void> {
    if (this.runEndRetirement) return this.runEndRetirement;
    this.ended = true;
    this.runEndRetirement = this.retireCandidate().finally(() => {
      this.cursor = null;
      this.lastPreparedCanonicalCount = null;
      this.lastPreparedCanonicalHash = null;
      this.stablePrepareContext = null;
    });
    return this.runEndRetirement;
  }

  private async prepareCall(context: PrepareModelCallContext): Promise<PreparedModelCall> {
    this.assertNotEnded("prepare");
    if (this.unusableReason) {
      throw new Error(`Claude candidate is unusable: ${this.unusableReason}`);
    }

    this.stablePrepareContext ??= context;
    let candidate = await this.materializeCandidate();
    let payload: CanonicalPayloadSelection = this.hasSuccessfulCall
      ? {
          mode: "suffix",
          startIndex: this.cursor?.canonicalMessageCount ?? 0,
        }
      : candidate.initialPayload;

    if (payload.mode === "suffix" && this.cursor) {
      const currentPrefixHash = hashCanonicalMessagesV1(
        context.canonicalMessages.slice(0, payload.startIndex),
      ).hash;
      if (currentPrefixHash !== this.cursor.canonicalPrefixHash) {
        await this.replaceForCanonicalMismatch();
        this.stablePrepareContext = context;
        candidate = await this.materializeCandidate();
        payload = candidate.initialPayload;
      }
    }

    const suffixStart = payload.mode === "full" ? 0 : payload.startIndex;
    if (suffixStart > context.canonicalMessages.length) {
      this.unusableReason = `canonical suffix ${suffixStart} exceeds message count ${context.canonicalMessages.length}`;
      await this.retireCandidate();
      throw new Error(`Claude candidate is unusable: ${this.unusableReason}`);
    }

    this.lastPreparedCanonicalCount = context.canonicalMessages.length;
    this.lastPreparedCanonicalHash = hashCanonicalMessagesV1(context.canonicalMessages).hash;
    return {
      runtime: {
        model: this.hasSuccessfulCall ? candidate.continuationModel : candidate.run.agentModel,
        modelSpecifier: candidate.modelSpecifier,
        executionMode: "provider-tools",
        persistentAttemptIdentity: candidate.attemptIdentity,
        streamTextMaxRetries: 0,
      },
      payload,
    };
  }

  private materializeCandidate(): Promise<ValidatedCandidate> {
    if (this.candidate) return Promise.resolve(this.candidate);
    if (this.materialization) return this.materialization;
    const prepareContext = this.stablePrepareContext;
    if (!prepareContext)
      throw new Error("Claude candidate materialization requires prepare context");

    this.attemptConsumed = true;
    const materialization = this.createCandidate({
      attemptIndex: this.attemptIndex,
      inputs: this.factoryInputs,
      prepareContext,
    })
      .then(async (rawCandidate) => {
        const parsed = candidateSelectionSchema.safeParse(rawCandidate);
        if (!parsed.success) {
          await rawCandidate.run.dispose();
          throw new Error(`Invalid Claude candidate: ${z.prettifyError(parsed.error)}`);
        }

        const candidate = parsed.data;
        const nativeSession = candidate.run.nativeSession;
        if (!nativeSession) {
          await candidate.run.dispose();
          throw new Error("Invalid Claude candidate: native session lifecycle is missing");
        }
        const observation = nativeSession.getObservation();
        if (observation.requestedSessionId === null) {
          await candidate.run.dispose();
          throw new Error("Invalid Claude candidate: ephemeral native sessions are not supported");
        }
        if (!candidate.run.continuationModel) {
          await candidate.run.dispose();
          throw new Error("Invalid Claude candidate: continuation model is missing");
        }
        if (observation.sourceSessionId === null && candidate.initialPayload.mode !== "full") {
          await candidate.run.dispose();
          throw new Error(
            "Invalid Claude candidate: fresh sessions require a full initial payload",
          );
        }
        if (observation.sourceSessionId !== null && candidate.initialPayload.mode !== "suffix") {
          await candidate.run.dispose();
          throw new Error(
            "Invalid Claude candidate: fork sessions require a suffix initial payload",
          );
        }

        const initialStart =
          candidate.initialPayload.mode === "full" ? 0 : candidate.initialPayload.startIndex;
        if (initialStart > prepareContext.canonicalMessages.length) {
          await candidate.run.dispose();
          throw new Error(
            `Invalid Claude candidate: canonical suffix ${initialStart} exceeds message count ${prepareContext.canonicalMessages.length}`,
          );
        }

        let canonicalPrefixHash: string;
        try {
          canonicalPrefixHash = hashCanonicalMessagesV1(
            prepareContext.canonicalMessages.slice(0, initialStart),
          ).hash;
        } catch (error) {
          await candidate.run.dispose();
          throw error;
        }

        this.lastObservation = observation;
        this.cursor = {
          canonicalMessageCount: initialStart,
          canonicalPrefixHash,
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
        return validated;
      })
      .catch((error: unknown) => {
        this.unusableReason = error instanceof Error ? error.message : String(error);
        throw error;
      })
      .finally(() => {
        if (this.materialization === materialization) this.materialization = null;
      });
    this.materialization = materialization;
    return materialization;
  }

  private async retireCandidate(): Promise<void> {
    const materialization = this.materialization;
    if (materialization) await materialization.catch(() => undefined);
    const candidate = this.candidate;
    this.candidate = null;
    if (candidate) {
      this.lastObservation = candidate.nativeSession.getObservation();
      await candidate.run.dispose();
    }
  }

  private async replaceForCanonicalMismatch(): Promise<void> {
    const consumed = this.attemptConsumed;
    try {
      await this.retireCandidate();
    } finally {
      if (consumed) this.attemptIndex += 1;
      this.attemptConsumed = false;
      this.resetAttemptState({ preservePrepareContext: false });
    }
  }

  private resetAttemptState(options: { readonly preservePrepareContext: boolean }): void {
    this.cursor = null;
    this.lastPreparedCanonicalCount = null;
    this.lastPreparedCanonicalHash = null;
    this.hasSuccessfulCall = false;
    this.unusableReason = null;
    if (!options.preservePrepareContext) this.stablePrepareContext = null;
  }

  private assertNotEnded(action: string): void {
    if (this.ended) throw new Error(`Cannot ${action} after Claude run-end retirement`);
  }
}
