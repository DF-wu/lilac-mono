import { Result } from "better-result";

function captureError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error("Unknown fixture failure", { cause });
}

export function rejectNegatedGuard(): boolean {
  const captured = Result.try({ try: () => 42, catch: captureError });
  if (!captured.isErr()) return true;
  return false;
}

export function rejectConditionalGuard(): boolean {
  const captured = Result.try({ try: () => 42, catch: captureError });
  return captured.isErr() ? false : true;
}

export function rejectSuccessGuard(): number {
  const captured = Result.try({ try: () => 42, catch: captureError });
  if (captured.isOk()) return captured.value;
  return 0;
}

export function rejectStaticGuard(): number {
  const captured = Result.try({ try: () => 42, catch: captureError });
  if (Result.isError(captured)) return captured.error.message.length;
  return captured.value;
}

export function rejectAliasedCapture(): number {
  const captured = Result.try({ try: () => 42, catch: captureError });
  const aliased = captured;
  if (aliased.isErr()) return aliased.error.message.length;
  return aliased.value;
}

export function rejectMutableCapture(): number {
  let captured = Result.try({ try: () => 42, catch: captureError });
  if (captured.isErr()) return captured.error.message.length;
  return captured.value;
}

export function rejectNestedGuard(): number {
  const captured = Result.try({ try: () => 42, catch: captureError });
  {
    if (captured.isErr()) return captured.error.message.length;
  }
  return captured.value;
}

export function rejectFunctionFormCapture(): number {
  const captured = Result.try(() => 42);
  if (captured.isErr()) return 0;
  return captured.value;
}

export function rejectInlineCapture(): boolean {
  if (Result.try({ try: () => 42, catch: captureError }).isErr()) return false;
  return true;
}
