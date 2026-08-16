import { describe, expect, it } from "bun:test";
import { parseCoreConfigResult } from "@stanley2058/lilac-utils";

import { resolveSessionSafetyMode } from "../../src/surface/session-policy";

describe("session safety mode", () => {
  it("inherits restricted safety mode from parent when child has local prompts", () => {
    const parsed = parseCoreConfigResult({
      surface: {
        router: {
          sessionModes: {
            parent: { safetyMode: "restricted" },
            child: { additionalPrompts: ["child memo"] },
          },
        },
      },
    });
    expect(parsed.status).toBe("ok");
    if (parsed.status === "error") return;

    expect(resolveSessionSafetyMode(parsed.value, "child", "parent")).toBe("restricted");
  });
});
