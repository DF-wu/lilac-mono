import { TaggedError, type Result as ResultType } from "better-result";

import type { SurfaceOperationError } from "./adapter";
import type {
  MsgRefFor,
  RegisteredSurfacePlatform,
  SessionRefFor,
  SurfacePrincipal,
} from "./types";

export type SurfaceQuestionOption = {
  readonly index: number;
  readonly label: string;
  readonly description: string;
  readonly token: string;
};

export type SurfaceQuestionPrompt = {
  readonly ordinal: number;
  readonly total: number;
  readonly header: string;
  readonly question: string;
  readonly options: readonly SurfaceQuestionOption[];
  readonly customToken: string;
};

export type SurfaceQuestionTerminalState = "cancelled" | "expired" | "interrupted";

export type SurfaceQuestionSummary = {
  readonly answers: readonly {
    readonly header: string;
    readonly answer:
      | { readonly kind: "option"; readonly label: string }
      | { readonly kind: "custom" };
  }[];
};

export type SurfaceQuestionInteractionUpdate =
  | { readonly state: "pending"; readonly prompt: SurfaceQuestionPrompt }
  | { readonly state: "answered"; readonly summary: SurfaceQuestionSummary };

export type SurfaceQuestionInteractionUpdater = (
  update: SurfaceQuestionInteractionUpdate,
) => Promise<ResultType<void, SurfaceOperationError>>;

export type SurfaceQuestionFinishInput<P extends RegisteredSurfacePlatform> = {
  readonly messageRef: MsgRefFor<P>;
  readonly state: SurfaceQuestionTerminalState;
};

export type SurfaceQuestionAnswer<P extends RegisteredSurfacePlatform> = {
  readonly platform: P;
  readonly channelId: string;
  readonly messageRef: MsgRefFor<P>;
  readonly principal: SurfacePrincipal & { readonly platform: P };
  readonly token: string;
  readonly answer:
    | { readonly kind: "option"; readonly optionIndex: number }
    | { readonly kind: "custom"; readonly text: string };
};

export type SurfaceQuestionActivity<P extends RegisteredSurfacePlatform> = Omit<
  SurfaceQuestionAnswer<P>,
  "answer"
>;

export type SurfaceQuestionAnswerDisposition = "accepted" | "not-found" | "stale" | "unauthorized";

export class SurfaceQuestionAnswerHandlingFailed extends TaggedError(
  "SurfaceQuestionAnswerHandlingFailed",
)<{
  readonly message: string;
}> {}

export type SurfaceQuestionAnswerHandler<P extends RegisteredSurfacePlatform> = (
  answer: SurfaceQuestionAnswer<P>,
  updateInteraction: SurfaceQuestionInteractionUpdater,
) => Promise<ResultType<SurfaceQuestionAnswerDisposition, SurfaceQuestionAnswerHandlingFailed>>;

export type SurfaceQuestionActivityHandler<P extends RegisteredSurfacePlatform> = (
  activity: SurfaceQuestionActivity<P>,
) => Promise<ResultType<SurfaceQuestionAnswerDisposition, SurfaceQuestionAnswerHandlingFailed>>;

export type SurfaceQuestionAnswerSubscription = {
  stop(): Promise<void>;
};

export type SurfaceQuestionPort<P extends RegisteredSurfacePlatform> = {
  present(input: {
    readonly sessionRef: SessionRefFor<P>;
    readonly replyTo?: MsgRefFor<P>;
    readonly prompt: SurfaceQuestionPrompt;
  }): Promise<ResultType<MsgRefFor<P>, SurfaceOperationError>>;
  finish(input: SurfaceQuestionFinishInput<P>): Promise<ResultType<void, SurfaceOperationError>>;
  subscribeAnswers(
    handler: SurfaceQuestionAnswerHandler<P>,
    handleActivity: SurfaceQuestionActivityHandler<P>,
  ): Promise<SurfaceQuestionAnswerSubscription>;
};

export type RegisteredSurfaceQuestionPort = SurfaceQuestionPort<RegisteredSurfacePlatform>;
