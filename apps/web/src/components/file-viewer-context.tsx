import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useWorkspace } from "../workspace-context";
import type { FileTarget } from "../file-target";

export const FileViewerContext = createContext<
  | {
      threadId: string;
      openFile: (target: FileTarget) => void;
    }
  | undefined
>(undefined);

export const useFileViewer = () => useContext(FileViewerContext);

export function FileViewerProvider({
  threadId,
  children,
}: {
  threadId: string;
  children: ReactNode;
}) {
  const { panels } = useWorkspace();
  const value = useMemo(
    () => ({
      threadId,
      openFile: (target: FileTarget) => panels.getState().openFile(threadId, target),
    }),
    [panels, threadId],
  );
  return <FileViewerContext value={value}>{children}</FileViewerContext>;
}
