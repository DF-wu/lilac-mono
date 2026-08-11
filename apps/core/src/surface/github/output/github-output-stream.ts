import { Result } from "better-result";

import type { GithubSessionRef, MsgRef } from "../../types";
import type {
  SurfaceOperationResult,
  SurfaceOutputPart,
  SurfaceOutputPartDisposition,
  SurfaceOutputResult,
  SurfaceOutputStream,
} from "../../adapter";

import { markGithubAgentComment } from "../../../github/github-comment-marker";

export class GithubOutputStream implements SurfaceOutputStream {
  private text = "";
  private created: MsgRef[] = [];

  constructor(
    private readonly sessionRef: GithubSessionRef,
    private readonly api: {
      createComment(body: string): Promise<SurfaceOperationResult<{ readonly id: number }>>;
    },
    private readonly opts?: { replyTo?: MsgRef },
  ) {}

  hydrateRecovery(parts: readonly SurfaceOutputPart[]): SurfaceOutputPartDisposition {
    let disposition: SurfaceOutputPartDisposition = "ignored";
    for (const part of parts) {
      const applied = this.applyPart(part);
      if (applied === "visible" || (applied === "terminal" && disposition === "ignored")) {
        disposition = applied;
      }
    }
    return disposition;
  }

  async push(
    part: SurfaceOutputPart,
  ): Promise<SurfaceOperationResult<SurfaceOutputPartDisposition>> {
    return Result.ok(this.applyPart(part));
  }

  private applyPart(part: SurfaceOutputPart): SurfaceOutputPartDisposition {
    switch (part.type) {
      case "text.delta": {
        // Buffer deltas; GitHub surface posts once at finish.
        this.text += part.delta;
        return "visible";
      }
      case "text.set": {
        this.text = part.text;
        return "visible";
      }
      case "attachment.add": {
        // GitHub omits binary attachments, but attachment-only replies still complete at finish.
        return "terminal";
      }
      case "reasoning.status": {
        // Ignore (no streaming UI for GitHub).
        return "ignored";
      }
      case "tool.status": {
        // GitHub has no tool UI, but tool-only replies still complete at finish.
        return "terminal";
      }
      case "meta.stats": {
        // Ignore (no dedicated stats UI for GitHub).
        return "ignored";
      }
      default: {
        const _exhaustive: never = part;
        return _exhaustive;
      }
    }
  }

  async finish(): Promise<SurfaceOperationResult<SurfaceOutputResult>> {
    const replyPrefix = (() => {
      const replyTo = this.opts?.replyTo;
      if (!replyTo || replyTo.platform !== "github") return "";
      return `In reply to ${replyTo.messageId}:\n\n`;
    })();

    const body = markGithubAgentComment(`${replyPrefix}${this.text}`);
    const res = await this.api.createComment(body);
    if (res.status === "error") return res;

    const ref: MsgRef = {
      platform: "github",
      channelId: this.sessionRef.channelId,
      messageId: String(res.value.id),
    };
    this.created.push(ref);

    return Result.ok({
      created: this.created,
      last: ref,
    });
  }

  async abort(_reason?: string): Promise<SurfaceOperationResult<void>> {
    return Result.ok(undefined);
  }
}
