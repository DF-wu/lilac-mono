import { Panic } from "better-result";

export function rethrowBundledRemoteRunnerPanic(error: unknown): void {
  let panic = false;
  try {
    panic = Panic.is(error);
  } catch {
    return;
  }
  if (panic) throw error;
}

export function bundledRemoteRunnerErrorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "Opaque bundled remote runner failure";
  }
}
