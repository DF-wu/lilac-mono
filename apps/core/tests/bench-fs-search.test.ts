import { describe, expect, it } from "bun:test";

import { BenchmarkArgumentError, parseBenchmarkArgs } from "../scripts/bench-fs-search";

describe("filesystem search benchmark CLI", () => {
  it("parses valid options without running the benchmark", () => {
    const parsed = parseBenchmarkArgs([
      "--root",
      ".",
      "--backend",
      "node-rg",
      "--warmups",
      "2",
      "--runs",
      "4",
    ]);

    expect(parsed.status).toBe("ok");
    if (parsed.status === "ok" && parsed.value !== "help") {
      expect(parsed.value).toMatchObject({ backend: "node-rg", warmups: 2, runs: 4 });
    }
  });

  it("returns typed argument failures and a total help outcome", () => {
    const invalid = parseBenchmarkArgs(["--runs", "zero"]);
    expect(invalid.status).toBe("error");
    if (invalid.status === "error") expect(BenchmarkArgumentError.is(invalid.error)).toBeTrue();
    expect(parseBenchmarkArgs(["--help"])).toMatchObject({ status: "ok", value: "help" });
  });
});
