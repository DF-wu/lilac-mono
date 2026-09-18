import { createContext } from "react";
export const UploadProgressContext = createContext<
  ReadonlyMap<string, { progress: number; state: string; error?: string; retry?: () => void }>
>(new Map());
