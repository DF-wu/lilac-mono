import { Result } from "better-result";

import { SurfaceOperationUnsupported } from "../../src/surface/adapter";
import type {
  SurfaceMergeBlockPlanOptions,
  SurfaceOperationResult,
  SurfaceReplyChainPlanOptions,
  SurfaceSendPreparationInput,
  TypingIndicatorSubscription,
} from "../../src/surface/adapter";
import type {
  MsgRef,
  SessionRef,
  SurfaceReactionDetail,
  SurfaceSessionParticipantsResult,
} from "../../src/surface/types";

export class SurfaceAdapterTestBase {
  async prepareSendMsg(
    _sessionRef: SessionRef,
    _input: SurfaceSendPreparationInput,
  ): Promise<SurfaceOperationResult<void>> {
    return Result.ok(undefined);
  }

  async listSessionParticipants(
    _sessionRef: SessionRef,
    _opts?: { limit?: number },
  ): Promise<SurfaceOperationResult<SurfaceSessionParticipantsResult>> {
    return Result.err(
      new SurfaceOperationUnsupported({
        platform: _sessionRef.platform,
        operation: "list-session-participants",
        message: "Test adapter does not implement session participant listing",
      }),
    );
  }

  async startTyping(
    _sessionRef: SessionRef,
  ): Promise<SurfaceOperationResult<TypingIndicatorSubscription>> {
    return Result.err(
      new SurfaceOperationUnsupported({
        platform: _sessionRef.platform,
        operation: "start-typing",
        message: "Test adapter does not implement typing indicators",
      }),
    );
  }

  async planReplyChain(
    msgRef: MsgRef,
    _opts?: SurfaceReplyChainPlanOptions,
  ): Promise<SurfaceOperationResult<readonly MsgRef[]>> {
    return Result.err(
      new SurfaceOperationUnsupported({
        platform: msgRef.platform,
        operation: "plan-reply-chain",
        message: "Test adapter does not implement reply-chain planning",
      }),
    );
  }

  async planMergeBlockEndingAt(
    msgRef: MsgRef,
    _opts?: SurfaceMergeBlockPlanOptions,
  ): Promise<SurfaceOperationResult<readonly MsgRef[]>> {
    return Result.err(
      new SurfaceOperationUnsupported({
        platform: msgRef.platform,
        operation: "plan-merge-block",
        message: "Test adapter does not implement merge-block planning",
      }),
    );
  }

  async listReactionDetails(
    _msgRef: MsgRef,
  ): Promise<SurfaceOperationResult<SurfaceReactionDetail[]>> {
    return Result.err(
      new SurfaceOperationUnsupported({
        platform: _msgRef.platform,
        operation: "list-reaction-details",
        message: "Test adapter does not implement detailed reaction listing",
      }),
    );
  }
}
