export function signalUnknown(error: unknown): never {
  throw error;
}
