export function exactExceptionAdapter(error: unknown): void {
  const inspectNested = (payload: unknown): void => {
    void payload;
  };
  inspectNested(error);
}
