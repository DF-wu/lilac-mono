import { describe, expect, it } from "bun:test";
import { Panic, Result, type Result as ResultType } from "better-result";

import { parseCliOptions } from "./cli";
import { decodeDraftExtmarkData } from "./opentui-boundary";
import { bindingPreferencesCodecCases, decodeBindingPreferences } from "./preferences";
import { readTerminalStream } from "./terminal-stream-adapter";
import {
  requestTerminalRendererShutdown,
  readTerminalTheme,
  resolveTerminalShutdownOutcome,
  runWithOwnedTerminalRenderer,
  setTerminalBackground,
  TerminalRuntimeFailed,
  type OwnedTerminalRenderer,
  type TerminalBackgroundRenderer,
  type TerminalPaletteReader,
} from "./terminal-runtime-adapter";
import { COLORS } from "./theme";

describe("Stage 7 boundary results", () => {
  it("classifies malformed, unsupported, and corrupt preferences separately", () => {
    const current = decodeBindingPreferences(bindingPreferencesCodecCases.current.input);
    const missing = decodeBindingPreferences(
      bindingPreferencesCodecCases["missing-defaulted"].input,
    );
    const legacy = decodeBindingPreferences(bindingPreferencesCodecCases.legacy.input);
    const malformed = decodeBindingPreferences(
      bindingPreferencesCodecCases["malformed-serialization"].input,
    );
    const unsupported = decodeBindingPreferences(
      bindingPreferencesCodecCases["unsupported-version"].input,
    );
    const corrupt = decodeBindingPreferences(bindingPreferencesCodecCases["corrupt-fields"].input);

    expect(current.status === "ok" ? current.value.provenance : undefined).toBe("current");
    expect(missing.status === "ok" ? missing.value.provenance : undefined).toBe(
      "missing-defaulted",
    );
    expect(legacy.status === "ok" ? legacy.value.provenance : undefined).toBe("migrated");
    expect(malformed.status === "error" ? malformed.error._tag : undefined).toBe(
      "BindingPreferencesMalformed",
    );
    expect(unsupported.status === "error" ? unsupported.error._tag : undefined).toBe(
      "BindingPreferencesUnsupportedVersion",
    );
    expect(corrupt.status === "error" ? corrupt.error._tag : undefined).toBe(
      "BindingPreferencesCorrupt",
    );
  });

  it("rejects invalid CLI reasoning as an owned result", () => {
    const parsed = parseCliOptions({
      argv: ["--reasoning", "extreme"],
      env: {},
      cwd: process.cwd(),
    });

    expect(parsed.status).toBe("error");
    if (parsed.status === "error") expect(parsed.error._tag).toBe("CliArgumentsInvalid");
  });

  it("decodes only complete OpenTUI draft extmark payloads", () => {
    expect(
      decodeDraftExtmarkData({ kind: "mini-lilac-draft", id: "draft-1", generation: 2 }),
    ).toEqual({ kind: "mini-lilac-draft", id: "draft-1", generation: 2 });
    expect(decodeDraftExtmarkData({ kind: "mini-lilac-draft", id: "draft-1" })).toBeUndefined();
  });

  it("maps ordinary stream reader rejection and preserves Panic", async () => {
    const failed = new ReadableStream<string>({
      start: (controller) => controller.error(new Error("socket closed")),
    }).getReader();
    const failure = await readTerminalStream(failed);
    expect(failure.status).toBe("error");
    if (failure.status === "error") expect(failure.error._tag).toBe("TerminalStreamReadFailed");

    const panic = new Panic({ message: "stream invariant" });
    const panicked = new ReadableStream<string>({
      start: (controller) => controller.error(panic),
    }).getReader();
    await expect(readTerminalStream(panicked)).rejects.toBe(panic);
  });

  it("uses the static theme when terminal palette discovery fails", async () => {
    const renderer: TerminalPaletteReader = {
      getPalette: () => Promise.reject(new Error("palette unavailable")),
    };

    expect(await readTerminalTheme(renderer)).toBe(COLORS);
  });

  it("cleans up before supervising a terminal palette Panic", async () => {
    const panic = new Panic({ message: "palette invariant" });
    let destroyCount = 0;
    const renderer: OwnedTerminalRenderer & TerminalPaletteReader = {
      isDestroyed: false,
      destroy: () => {
        destroyCount += 1;
      },
      getPalette: () => Promise.reject(panic),
    };

    const operation = runWithOwnedTerminalRenderer(renderer, async () => {
      await readTerminalTheme(renderer);
      return Result.ok(undefined);
    });

    await expect(operation).rejects.toBe(panic);
    expect(destroyCount).toBe(1);
  });

  it("destroys the renderer before propagating a setBackgroundColor Panic", async () => {
    const panic = new Panic({ message: "background invariant" });
    let destroyCount = 0;
    const renderer: OwnedTerminalRenderer & TerminalBackgroundRenderer = {
      isDestroyed: false,
      destroy: () => {
        destroyCount += 1;
      },
      setBackgroundColor: () => {
        throw panic;
      },
    };

    const operation = runWithOwnedTerminalRenderer(renderer, async () => {
      const background = setTerminalBackground(renderer, "#000000");
      if (background.status === "error") return Result.err(background.error);
      return Result.ok(undefined);
    });

    await expect(operation).rejects.toBe(panic);
    expect(destroyCount).toBe(1);
  });

  it("keeps the render Panic when renderer cleanup also panics", async () => {
    const renderPanic = new Panic({ message: "render invariant" });
    const cleanupPanic = new Panic({ message: "cleanup invariant" });
    let destroyCount = 0;
    const renderer: OwnedTerminalRenderer = {
      isDestroyed: false,
      destroy: () => {
        destroyCount += 1;
        throw cleanupPanic;
      },
    };

    const operation = runWithOwnedTerminalRenderer(
      renderer,
      async (): Promise<ResultType<void, TerminalRuntimeFailed>> => {
        throw renderPanic;
      },
    );

    await expect(operation).rejects.toBe(renderPanic);
    expect(destroyCount).toBe(1);
  });

  it("settles renderer shutdown before preserving a destroy Panic", async () => {
    const panic = new Panic({ message: "destroy invariant" });
    let destroyCount = 0;
    let settleCount = 0;
    let resolveCompletion: (() => void) | undefined;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const renderer: OwnedTerminalRenderer = {
      isDestroyed: false,
      destroy: () => {
        destroyCount += 1;
        throw panic;
      },
    };

    const outcome = requestTerminalRendererShutdown(renderer, () => {
      settleCount += 1;
      resolveCompletion?.();
    });

    await completion;
    expect(destroyCount).toBe(1);
    expect(settleCount).toBe(1);
    expect(outcome).toEqual({ kind: "defect", defect: panic });
    expect(() => resolveTerminalShutdownOutcome(outcome)).toThrow(panic);
  });

  it("settles renderer shutdown and retains an ordinary destroy failure", async () => {
    const cause = new Error("destroy unavailable");
    let destroyCount = 0;
    let settleCount = 0;
    let resolveCompletion: (() => void) | undefined;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const renderer: OwnedTerminalRenderer = {
      isDestroyed: false,
      destroy: () => {
        destroyCount += 1;
        throw cause;
      },
    };

    const outcome = requestTerminalRendererShutdown(renderer, () => {
      settleCount += 1;
      resolveCompletion?.();
    });

    await completion;
    expect(destroyCount).toBe(1);
    expect(settleCount).toBe(1);
    expect(outcome.kind).toBe("failure");
    const resolved = resolveTerminalShutdownOutcome(outcome);
    expect(resolved.status).toBe("error");
    if (resolved.status === "error") {
      expect(resolved.error.operation).toBe("destroy");
      expect(resolved.error.cause).toBe(cause);
    }
  });
});
