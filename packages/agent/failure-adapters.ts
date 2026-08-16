import { Panic } from "better-result";

/** Content-blind pass-through value accepted from an external runtime. */
export type OpaqueAgentValue = {} | null | undefined;

/** Preserve an unrecoverable defect without exempting the surrounding adapter's ordinary failures. */
export function rethrowAgentPanic(cause: Panic): never;
export function rethrowAgentPanic(cause: OpaqueAgentValue): void;
export function rethrowAgentPanic(cause: OpaqueAgentValue): void {
  if (Panic.is(cause)) throw cause;
}

export function isAgentPanic(cause: unknown): cause is Panic {
  return Panic.is(cause);
}
