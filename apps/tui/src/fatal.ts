export function captureTuiException(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error("Opaque terminal exception");
}

export function rethrowTuiDefect(error: Error): never {
  throw error;
}
