import { describe, expect, it } from "bun:test";
import type { Level1ToolSpec } from "@stanley2058/lilac-plugin-runtime";
import { Panic } from "better-result";

import {
  formatToolLogPreview,
  summarizeToolFailure,
} from "../../../src/surface/bridge/bus-agent-runner/tool-failure-logging";
import { createLocalToolSpecs } from "../../../src/plugins/builtin/local-tools";

const BUILTIN_TOOL_SPECS = new Map(createLocalToolSpecs().map((spec) => [spec.name, spec]));

function summarizeBuiltinFailure(params: { toolName: string; isError: boolean; result: unknown }) {
  return summarizeToolFailure({ ...params, toolSpecs: BUILTIN_TOOL_SPECS });
}

describe("summarizeToolFailure", () => {
  it("marks bash non-zero exit as soft failure", () => {
    const res = summarizeBuiltinFailure({
      toolName: "bash",
      isError: false,
      result: {
        stdout: "",
        stderr: "command not found",
        exitCode: 127,
      },
    });

    expect(res.ok).toBe(false);
    expect(res.failureKind).toBe("soft");
    expect(res.error).toContain("127");
  });

  it("marks read_file success=false as soft failure", () => {
    const res = summarizeBuiltinFailure({
      toolName: "read_file",
      isError: false,
      result: {
        success: false,
        resolvedPath: "/tmp/missing.txt",
        error: {
          code: "NOT_FOUND",
          message: "No such file",
        },
      },
    });

    expect(res.ok).toBe(false);
    expect(res.failureKind).toBe("soft");
    expect(res.error).toBe("No such file");
  });

  it("marks fuzzy_search errors as soft failures", () => {
    const res = summarizeBuiltinFailure({
      toolName: "fuzzy_search",
      isError: false,
      result: { error: "index unavailable" },
    });

    expect(res).toEqual({
      ok: false,
      failureKind: "soft",
      error: "fuzzy_search failed: index unavailable",
    });
  });

  it("marks execution errors as hard failure", () => {
    const res = summarizeBuiltinFailure({
      toolName: "glob",
      isError: true,
      result: "validation failed",
    });

    expect(res.ok).toBe(false);
    expect(res.failureKind).toBe("hard");
    expect(res.error).toBe("validation failed");
  });

  it("prefers plugin-provided failure summarizer when available", () => {
    const specs = new Map<string, Level1ToolSpec<unknown>>([
      [
        "custom_tool",
        {
          name: "custom_tool",
          createTool: () => ({}),
          isEnabled: () => true,
          summarizeFailure: () => ({ ok: false, failureKind: "soft", error: "custom failure" }),
        },
      ],
    ]);

    const res = summarizeToolFailure({
      toolName: "custom_tool",
      isError: false,
      result: { nope: true },
      toolSpecs: specs,
    });

    expect(res).toEqual({ ok: false, failureKind: "soft", error: "custom failure" });
  });

  it("falls back when plugin summarizers fail or return malformed results", () => {
    const failed: Level1ToolSpec<unknown> = {
      name: "failed",
      createTool: () => ({}),
      isEnabled: () => true,
      summarizeFailure() {
        throw new Error("summary boom");
      },
    };
    const malformed: Level1ToolSpec<unknown> = {
      name: "malformed",
      createTool: () => ({}),
      isEnabled: () => true,
      summarizeFailure: () => ({ ok: true }),
    };
    Object.defineProperty(malformed, "summarizeFailure", { value: () => ({ failureKind: "bad" }) });

    expect(
      summarizeToolFailure({
        toolName: "failed",
        isError: false,
        result: {},
        toolSpecs: new Map([["failed", failed]]),
      }),
    ).toEqual({ ok: true });
    expect(
      summarizeToolFailure({
        toolName: "malformed",
        isError: false,
        result: {},
        toolSpecs: new Map([["malformed", malformed]]),
      }),
    ).toEqual({ ok: true });
  });

  it("propagates Panic from plugin summarizers", () => {
    const panic = new Panic({ message: "summary invariant" });
    const spec: Level1ToolSpec<unknown> = {
      name: "panic",
      createTool: () => ({}),
      isEnabled: () => true,
      summarizeFailure() {
        throw panic;
      },
    };
    try {
      summarizeToolFailure({
        toolName: "panic",
        isError: false,
        result: {},
        toolSpecs: new Map([["panic", spec]]),
      });
      throw new Error("expected Panic");
    } catch (cause) {
      expect(Panic.is(cause)).toBe(true);
    }
  });
});

describe("formatToolLogPreview", () => {
  it("redacts secrets and truncates previews", () => {
    const long = "x".repeat(6_000);
    const preview = formatToolLogPreview({
      toolName: "bash",
      value: {
        command: "curl -H 'authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz1234'",
        long,
      },
    });

    expect(preview).toContain("<redacted>");
    expect(preview.length).toBeLessThanOrEqual(4_003);
  });

  it("truncates batch previews", () => {
    const big = "x".repeat(6_000);
    const preview = formatToolLogPreview({
      toolName: "batch",
      value: {
        tool_calls: [{ tool: "bash", parameters: { command: `printf '${big}'` } }],
      },
    });

    expect(preview.length).toBeLessThanOrEqual(4_003);
    expect(preview.endsWith("...")).toBe(true);
  });
});
