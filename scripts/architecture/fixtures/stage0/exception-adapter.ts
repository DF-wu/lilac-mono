export function exactExceptionAdapter(error: unknown): void {
  try {
    void String(error);
  } catch {
    return;
  }
  const inspectNested = (payload: unknown): void => {
    void payload;
  };
  inspectNested(error);
}
