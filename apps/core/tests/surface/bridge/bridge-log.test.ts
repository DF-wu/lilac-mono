import { describe, expect, it } from "bun:test";
import { TaggedError } from "better-result";

import {
  formatBridgeLogContext,
  formatBridgeTaggedErrorForLog,
} from "../../../src/surface/bridge/bridge-log";

class BridgeTestFailure extends TaggedError("BridgeTestFailure")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

describe("bridge structured log projection", () => {
  it("keeps ordinary context primitive-only", () => {
    expect(
      formatBridgeLogContext({ requestId: "request-1", attempts: 2, cancelled: false }),
    ).toEqual({ requestId: "request-1", attempts: 2, cancelled: false });
  });

  it("redacts TaggedError messages and never exposes causes", () => {
    const projected = formatBridgeTaggedErrorForLog(
      new BridgeTestFailure({
        cause: { authorization: "Bearer cause-secret" },
        message: "request failed token=sk-super-secret at https://user:pass@example.com/path?q=1",
      }),
      { requestId: "request-1" },
    );

    expect(projected.requestId).toBe("request-1");
    expect(projected.errorTag).toBe("BridgeTestFailure");
    expect(projected.errorMessage).not.toContain("sk-super-secret");
    expect(projected.errorMessage).not.toContain("user:pass");
    expect(projected).not.toHaveProperty("cause");
    expect(Object.values(projected).join(" ")).not.toContain("cause-secret");
  });

  it("returns the closed fallback when TaggedError inspection is hostile", () => {
    const hostile = new Proxy(new BridgeTestFailure({ cause: undefined, message: "unused" }), {
      get() {
        throw new Error("property trap must stay contained");
      },
      getPrototypeOf() {
        throw new Error("prototype trap must stay contained");
      },
    });

    expect(
      formatBridgeTaggedErrorForLog(
        hostile,
        { requestId: "request-1" },
        {
          errorTag: "BridgeDrainFailed",
          errorMessage: "Bridge drain failed",
        },
      ),
    ).toEqual({
      requestId: "request-1",
      errorTag: "BridgeDrainFailed",
      errorMessage: "Bridge drain failed",
    });
  });
});
