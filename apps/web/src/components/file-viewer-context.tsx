import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useOptionalWorkspace, useWorkspace } from "../workspace-context";
import type { FileTarget } from "../file-target";

export const FileViewerContext = createContext<
  | {
      threadId: string;
      openFile: (target: FileTarget) => void;
      /** Overrides server path resolution, for previews without a connected workspace. */
      resolveFile?: (
        path: string,
      ) => Promise<Omit<Extract<FileTarget, { type: "resource" }>, "type">>;
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

export function useFileResolution(target: FileTarget, enabled = true) {
  const workspace = useOptionalWorkspace();
  const viewer = useFileViewer();
  const path = target.type === "path" ? target.path : undefined;
  const query = useQuery({
    queryKey: ["file-resolution", viewer?.threadId, path],
    queryFn: ({ signal }) =>
      viewer?.resolveFile
        ? viewer.resolveFile(path!)
        : workspace!.client.rpc!.files.resolve(
            { threadId: viewer!.threadId, path: path! },
            { signal },
          ),
    enabled:
      enabled &&
      !!path &&
      !!viewer?.threadId &&
      !viewer.threadId.startsWith("draft:") &&
      (!!viewer.resolveFile || !!workspace?.client.rpc),
    staleTime: 0,
    gcTime: 60_000,
    retry: false,
  });
  if (target.type === "resource") return { file: target, error: undefined };
  const file: Extract<FileTarget, { type: "resource" }> | undefined = query.data
    ? { type: "resource", ...query.data, line: target.line, endLine: target.endLine }
    : undefined;
  const unavailable =
    (!workspace?.client.rpc && !viewer?.resolveFile) ||
    !viewer?.threadId ||
    viewer.threadId.startsWith("draft:");
  return {
    file,
    error:
      query.error?.message ??
      (unavailable ? "File browsing is unavailable in this conversation." : undefined),
  };
}
