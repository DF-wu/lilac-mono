import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { defaultPanelTabs, defaultRightPanel, type PanelTabs, type PanelTab } from "../panel-store";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./ui/tabs";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "./ui/dropdown-menu";
import { IconButton } from "./ui";
import { useQuery } from "@tanstack/react-query";
import { useStore } from "zustand";
import { Bot, FileText, Plus, X } from "lucide-react";
import { useOptionalWorkspace, useWorkspace } from "../workspace-context";
import type { FileTarget } from "../file-target";
import { useFileViewer } from "./file-viewer-context";
import {
  AttachmentPreviewBody,
  ResourcePreview,
  attachmentKind,
  useResourcePreviewText,
} from "./ResourcePreview";
import { FileSource } from "./FileSource";
import { NativeSubagentPanel } from "./SubagentPanel";
import { Button } from "./ui/button";
import { Tooltip, TooltipTrigger, TooltipContent } from "./ui/tooltip";
import "./file-viewer.css";

export function useFileResolution(target: FileTarget, enabled = true) {
  const workspace = useOptionalWorkspace();
  const viewer = useFileViewer();
  const path = target.type === "path" ? target.path : undefined;
  const query = useQuery({
    queryKey: ["file-resolution", viewer?.threadId, path],
    queryFn: ({ signal }) =>
      workspace!.client.rpc!.files.resolve({ threadId: viewer!.threadId, path: path! }, { signal }),
    enabled:
      enabled &&
      !!path &&
      !!viewer?.threadId &&
      !viewer.threadId.startsWith("draft:") &&
      !!workspace?.client.rpc,
    staleTime: 0,
    gcTime: 60_000,
    retry: false,
  });
  if (target.type === "resource") return { file: target, error: undefined };
  const file: Extract<FileTarget, { type: "resource" }> | undefined = query.data
    ? { type: "resource", ...query.data, line: target.line, endLine: target.endLine }
    : undefined;
  const unavailable =
    !workspace?.client.rpc || !viewer?.threadId || viewer.threadId.startsWith("draft:");
  return {
    file,
    error:
      query.error?.message ??
      (unavailable ? "File browsing is unavailable in this conversation." : undefined),
  };
}

export function FileTargetPreview({
  target,
  onClose,
}: {
  target: FileTarget;
  onClose: () => void;
}) {
  const { file, error } = useFileResolution(target);
  const unresolved = error
    ? { status: "error" as const, message: error }
    : { status: "loading" as const };
  return (
    <ResourcePreview
      name={file?.name ?? target.name}
      href={file?.href ?? ""}
      kind={file ? attachmentKind(file.mediaType, file.name) : "text"}
      line={target.line}
      endLine={target.endLine}
      target={file ?? target}
      textState={file ? undefined : unresolved}
      onClose={onClose}
    />
  );
}

export function FilePanelContent({
  target,
  tabId,
  active = true,
}: {
  target: FileTarget;
  tabId?: string;
  active?: boolean;
}) {
  const workspace = useOptionalWorkspace();
  const viewer = useFileViewer();
  const { file, error } = useFileResolution(target, active);
  useEffect(() => {
    if (file && tabId && viewer)
      workspace?.panels.getState().resolveFile(viewer.threadId, tabId, file);
  }, [file, tabId, viewer, workspace]);
  const kind = file ? attachmentKind(file.mediaType, file.name) : "text";
  const loaded = useResourcePreviewText(file?.href ?? "", kind, active);
  const unresolved = error
    ? { status: "error" as const, message: error }
    : { status: "loading" as const };
  const text = file ? loaded : unresolved;
  const path = target.type === "path" ? target.path : (target.path ?? target.name);
  const media = file ? (
    <AttachmentPreviewBody key={file.href} name={file.name} href={file.href} kind={kind} fill />
  ) : null;
  const heading = (
    <Tooltip>
      <TooltipTrigger render={<div className="file-panel-heading" />}>
        <span>{file?.path ?? path}</span>
      </TooltipTrigger>
      <TooltipContent>{file?.path ?? path}</TooltipContent>
    </Tooltip>
  );
  if (kind === "text")
    return (
      <FileSource
        name={file?.name ?? target.name}
        text={text}
        line={target.line}
        endLine={target.endLine}
        navigation={target}
        heading={heading}
      />
    );
  return (
    <>
      {heading}
      {media}
    </>
  );
}

export function RightPanel({ threadId, foreground }: { threadId: string; foreground: boolean }) {
  const { panels } = useWorkspace();
  const tabs = useStore(panels, (state) => state.tabs.get(threadId) ?? defaultPanelTabs);
  const open = useStore(panels, (state) => (state.threads.get(threadId) ?? defaultRightPanel).open);
  const visible = foreground && open;
  const actions = panels.getState();
  return (
    <RightPanelTabs
      key={threadId}
      visible={visible}
      tabs={tabs}
      onFocus={(id) => actions.focusTab(threadId, id)}
      onClose={(id) => actions.closeTab(threadId, id)}
      onAgents={() => actions.openAgents(threadId)}
      renderTab={(tab, active) =>
        tab.type === "agents" ? (
          <NativeSubagentPanel threadId={threadId} foreground={foreground && active} embedded />
        ) : (
          <FilePanelContent target={tab.target} tabId={tab.id} active={visible && active} />
        )
      }
    />
  );
}

export function RightPanelTabs({
  tabs,
  onFocus,
  onClose,
  onAgents,
  renderTab,
  visible = true,
}: {
  tabs: PanelTabs;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onAgents: () => void;
  renderTab: (tab: PanelTab, active: boolean) => ReactNode;
  visible?: boolean;
}) {
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const viewport = list.current;
    const active = viewport?.querySelector<HTMLElement>('[role="tab"][data-active]');
    if (!viewport || !active) return;
    const bounds = viewport.getBoundingClientRect();
    const target = active.getBoundingClientRect();
    if (target.right > bounds.right) viewport.scrollLeft += target.right - bounds.right;
    else if (target.left < bounds.left) viewport.scrollLeft += target.left - bounds.left;
  }, [tabs.activeId, tabs.items.length]);
  return (
    <aside className="file-panel" aria-label="Right panel">
      <Tabs
        value={tabs.activeId ?? null}
        onValueChange={(value) => {
          if (typeof value === "string") onFocus(value);
        }}
        className="file-panel-tabs-root"
      >
        <div className="file-panel-tab-bar">
          <TabsList ref={list} className="file-panel-tabs" aria-label="Right panel tabs">
            {tabs.items.map((tab) => (
              <div className="file-panel-tab" key={tab.id}>
                <TabsTrigger value={tab.id}>
                  {tab.type === "agents" ? <Bot /> : <FileText />}
                  <span>{tab.type === "agents" ? "Agents" : tab.target.name}</span>
                </TabsTrigger>
                <IconButton
                  className="file-tab-close"
                  label={`Close ${tab.type === "agents" ? "Agents" : tab.target.name}`}
                  onClick={() => onClose(tab.id)}
                >
                  <X />
                </IconButton>
              </div>
            ))}
          </TabsList>
          <DropdownMenu>
            <DropdownMenuTrigger render={<IconButton label="Add tab" />}>
              <Plus />
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem onClick={onAgents}>
                <Bot />
                Agents
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="file-panel-tab-content">
          {tabs.items.map((tab) => (
            <TabsContent key={tab.id} value={tab.id} keepMounted className="file-panel-tab-page">
              <VisitedTabContent active={visible && tabs.activeId === tab.id}>
                {renderTab(tab, tabs.activeId === tab.id)}
              </VisitedTabContent>
            </TabsContent>
          ))}
          {!tabs.items.length ? (
            <div className="file-status">
              <Button variant="ghost" onClick={onAgents}>
                <Bot />
                Open Agents
              </Button>
            </div>
          ) : null}
        </div>
      </Tabs>
    </aside>
  );
}

function VisitedTabContent({ active, children }: { active: boolean; children: ReactNode }) {
  const [visited, setVisited] = useState(active);
  if (active && !visited) setVisited(true);
  return active || visited ? children : null;
}
