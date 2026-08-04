import { createCliRenderer } from "@opentui/core";
import { render } from "@opentui/solid";
import { Panic, Result, TaggedError, type Result as ResultType } from "better-result";

import {
  captureTuiFailure,
  captureTuiOperation,
  captureTuiOperationAsync,
  signalTuiDefect,
  type CapturedTuiFailure,
} from "./failure-adapter";
import { COLORS, createTerminalTheme, type ThemeColors } from "./theme";

export class TerminalRuntimeFailed extends TaggedError("TerminalRuntimeFailed")<{
  readonly operation: "create" | "palette" | "background" | "render" | "destroy" | "entrypoint";
  readonly cause: unknown;
  readonly message: string;
}> {}

export type TerminalRenderer = Awaited<ReturnType<typeof createCliRenderer>>;
export type TerminalPalette = Awaited<ReturnType<TerminalRenderer["getPalette"]>>;

export interface TerminalPaletteReader {
  getPalette(options: { readonly size: 16 }): Promise<TerminalPalette>;
}

export class TerminalOperationAndCleanupFailed extends TaggedError(
  "TerminalOperationAndCleanupFailed",
)<{
  readonly operation: TerminalRuntimeFailed;
  readonly cleanup: TerminalRuntimeFailed;
  readonly message: string;
}> {}

export interface OwnedTerminalRenderer {
  readonly isDestroyed: boolean;
  destroy(): void;
}

export interface TerminalBackgroundRenderer {
  setBackgroundColor(color: string): void;
}

export type TerminalShutdownOutcome =
  | { readonly kind: "success" }
  | { readonly kind: "failure"; readonly error: TerminalRuntimeFailed }
  | { readonly kind: "defect"; readonly defect: Error };

export async function createTerminalRenderer(
  options: Parameters<typeof createCliRenderer>[0],
): Promise<ResultType<TerminalRenderer, TerminalRuntimeFailed>> {
  return captureTuiOperationAsync(
    () => createCliRenderer(options),
    (cause) =>
      new TerminalRuntimeFailed({
        operation: "create",
        cause,
        message: "Terminal renderer creation failed",
      }),
  );
}

export async function readTerminalPalette(
  renderer: TerminalPaletteReader,
): Promise<ResultType<TerminalPalette, TerminalRuntimeFailed>> {
  return captureTuiOperationAsync(
    () => renderer.getPalette({ size: 16 }),
    (cause) =>
      new TerminalRuntimeFailed({
        operation: "palette",
        cause,
        message: "Terminal palette unavailable",
      }),
  );
}

export async function readTerminalTheme(renderer: TerminalPaletteReader): Promise<ThemeColors> {
  const palette = await readTerminalPalette(renderer);
  return palette.status === "ok" ? createTerminalTheme(palette.value) : COLORS;
}

export function setTerminalBackground(
  renderer: TerminalBackgroundRenderer,
  color: string,
): ResultType<void, TerminalRuntimeFailed> {
  return captureTuiOperation(
    () => renderer.setBackgroundColor(color),
    (cause) =>
      new TerminalRuntimeFailed({
        operation: "background",
        cause,
        message: "Terminal background setup failed",
      }),
  );
}

export async function renderTerminalApp(
  root: Parameters<typeof render>[0],
  renderer: Parameters<typeof render>[1],
): Promise<ResultType<void, TerminalRuntimeFailed>> {
  return captureTuiOperationAsync(
    async () => {
      await render(root, renderer);
    },
    (cause) =>
      new TerminalRuntimeFailed({
        operation: "render",
        cause,
        message: "Terminal render failed",
      }),
  );
}

export function destroyTerminalRenderer(
  renderer: OwnedTerminalRenderer,
): ResultType<void, TerminalRuntimeFailed> {
  return captureTuiOperation(
    () => renderer.destroy(),
    (cause) =>
      new TerminalRuntimeFailed({
        operation: "destroy",
        cause,
        message: "Terminal cleanup failed",
      }),
  );
}

/** Attempt shutdown synchronously and always release the owner's renderer wait. */
export function requestTerminalRendererShutdown(
  renderer: OwnedTerminalRenderer,
  settle: () => void,
): TerminalShutdownOutcome {
  let attempted: ResultType<ResultType<void, TerminalRuntimeFailed>, CapturedTuiFailure>;
  try {
    attempted = Result.try({
      try: () => destroyTerminalRenderer(renderer),
      catch: captureTuiFailure,
    });
  } finally {
    settle();
  }
  if (attempted.status === "error") {
    return {
      kind: "defect",
      defect: attempted.error.kind === "panic" ? attempted.error.panic : attempted.error.cause,
    };
  }
  if (attempted.value.status === "error") {
    return { kind: "failure", error: attempted.value.error };
  }
  return { kind: "success" };
}

/** Resolve the retained shutdown outcome after the renderer wait has completed. */
export function resolveTerminalShutdownOutcome(
  outcome: TerminalShutdownOutcome,
): ResultType<void, TerminalRuntimeFailed> {
  switch (outcome.kind) {
    case "success":
      return Result.ok(undefined);
    case "failure":
      return Result.err(outcome.error);
    case "defect":
      return signalTuiDefect(outcome.defect);
  }
}

/** Own the renderer until work settles; a thrown primary always wins over cleanup failure. */
export async function runWithOwnedTerminalRenderer<T>(
  renderer: OwnedTerminalRenderer,
  operation: () => Promise<ResultType<T, TerminalRuntimeFailed>>,
): Promise<ResultType<T, TerminalRuntimeFailed | TerminalOperationAndCleanupFailed>> {
  const attempted = await Result.tryPromise({
    try: operation,
    catch: captureTuiFailure,
  });
  if (attempted.status === "error") {
    if (!renderer.isDestroyed) {
      Result.try({
        try: () => destroyTerminalRenderer(renderer),
        catch: () => undefined,
      });
    }
    return signalTuiDefect(
      attempted.error.kind === "panic" ? attempted.error.panic : attempted.error.cause,
    );
  }
  const work = attempted.value;

  if (renderer.isDestroyed) return work;
  const cleanup = destroyTerminalRenderer(renderer);
  if (cleanup.status === "ok") return work;
  if (work.status === "error") {
    return Result.err(
      new TerminalOperationAndCleanupFailed({
        operation: work.error,
        cleanup: cleanup.error,
        message: `${work.error.message}; ${cleanup.error.message}`,
      }),
    );
  }
  return Result.err(cleanup.error);
}

/** Top-level host adapter classifies defects before mapping them to the process exit contract. */
export async function runTerminalEntrypoint(
  operation: () => Promise<number>,
): Promise<ResultType<number, TerminalRuntimeFailed>> {
  const captured = await Result.tryPromise({
    try: operation,
    catch: captureTuiFailure,
  });
  if (captured.status === "ok") return Result.ok(captured.value);
  const cause = captured.error.kind === "panic" ? captured.error.panic : captured.error.cause;
  return Result.err(
    new TerminalRuntimeFailed({
      operation: "entrypoint",
      cause,
      message: Panic.is(cause) ? cause.message : "Mini Lilac terminal entrypoint failed",
    }),
  );
}
