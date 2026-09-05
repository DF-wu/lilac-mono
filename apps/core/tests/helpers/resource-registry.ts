import { createHash } from "node:crypto";

import { Result } from "better-result";

import type { ResourceRegistry } from "../../src/resource";

export function createTestResourceRegistry(): ResourceRegistry {
  return {
    async register(input) {
      const digest = createHash("sha256")
        .update(JSON.stringify(input.origin))
        .digest("hex")
        .slice(0, 32);
      return Result.ok({
        uri: `resource://r1_${digest}`,
        ...(input.filename === undefined ? {} : { filename: input.filename }),
        ...(input.declaredMediaType === undefined
          ? {}
          : { declaredMediaType: input.declaredMediaType }),
        ...(input.reportedByteLength === undefined
          ? {}
          : { reportedByteLength: input.reportedByteLength }),
      });
    },
  };
}
