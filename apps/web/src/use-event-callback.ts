import { useCallback, useInsertionEffect, useRef } from "react";

export function useEventCallback<Args extends unknown[], Return>(
  callback: (...args: Args) => Return,
) {
  const latest = useRef(callback);
  // Publish before descendant layout effects without exposing an uncommitted thread's handlers.
  useInsertionEffect(() => {
    latest.current = callback;
  });
  return useCallback((...args: Args) => latest.current.apply(undefined, args), []);
}
