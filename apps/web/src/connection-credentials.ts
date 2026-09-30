let refresh: (() => Promise<string | null>) | undefined;

export function registerConnectionCredentials(operation: () => Promise<string | null>): () => void {
  refresh = operation;
  return () => {
    if (refresh === operation) refresh = undefined;
  };
}

export async function prepareWebConnection(): Promise<void> {
  await refresh?.();
}

export async function readConnectionToken(): Promise<string | null | undefined> {
  return refresh?.();
}
