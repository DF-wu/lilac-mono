let refresh: (() => Promise<void>) | undefined;

export function registerConnectionCredentials(operation: () => Promise<void>): () => void {
  refresh = operation;
  return () => {
    if (refresh === operation) refresh = undefined;
  };
}

export async function prepareWebConnection(): Promise<void> {
  await refresh?.();
}
