import { describe, expect, it } from "bun:test";
import { Panic } from "better-result";

import { surfaceExternalFallback } from "../../src/surface/adapter";

describe("surface external failure fallback", () => {
  it("returns the compatibility fallback for ordinary external failures", () => {
    expect(surfaceExternalFallback(null)(new Error("unavailable"))).toBeNull();
  });

  it("preserves Panic exactly instead of converting it to absence", () => {
    const panic = new Panic({ message: "surface invariant failed" });

    expect(() => surfaceExternalFallback(null)(panic)).toThrow(panic);
  });
});
