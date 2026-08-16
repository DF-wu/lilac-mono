import { Result } from "better-result";

import { parseGithubRequestId } from "../../github/github-ids";
import type { SurfaceToolTargetRouting } from "../protocol";

export const githubToolTargetRouting = {
  helpFallbackPriority: 1,
  inferRequestTarget: (requestId) => {
    if (!requestId) return null;
    const parsed = parseGithubRequestId({ requestId });
    return parsed ? { sessionId: parsed.sessionId, messageId: parsed.triggerId } : null;
  },
  describeSessionIds: () => ({
    sessionIdFormats: {
      client: "github",
      accepted: [
        {
          format: "OWNER/REPO#123",
          meaning: "GitHub issue/PR thread",
        },
      ],
      notes: [
        "For GitHub triggers, surface tools can default sessionId/messageId from requestId when it is 'github:<OWNER/REPO#N>:<triggerId>'.",
      ],
    },
  }),
  resolveSession: async ({ selector }) =>
    Result.ok({ sessionRef: { platform: "github", channelId: selector } }),
} satisfies SurfaceToolTargetRouting<"github">;
