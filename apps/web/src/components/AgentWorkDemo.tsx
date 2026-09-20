import { useMemo } from "react";
import { useStore } from "zustand";
import { demoSubagents, demoSubagentTranscript } from "../agent-work-fixtures";
import { createSubagentPanelStore } from "../subagent-panel-store";
import { SubagentContext } from "./subagent-context";
import { SubagentPanelView, RightPanelToggle } from "./SubagentPanel";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "./ui/resizable";
import { MessageArrivals } from "../message-arrivals";
import { MessageArrivalsContext } from "./message-arrivals";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw } from "lucide-react";
import { agentWorkStages } from "../agent-work-fixtures";
import { MessageIdentityContext } from "./message-identity";
import { MessageServicesContext, type MessageServices } from "./message-services";
import { Turn } from "./Timeline";
import type { ReadyTurnSlot } from "@stanley2058/lilac-client-protocol";
import { Button } from "./ui/button";
import { IconButton } from "./ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

const identities = {
  viewerId: "demo_user",
  agent: { displayName: "Lilac" },
  users: new Map([
    ["demo_user", { displayName: "Alex Chen" }],
    ["demo_other_user", { displayName: "Morgan Lee" }],
  ]),
};

export function AgentWorkDemo() {
  const [panel] = useState(createSubagentPanelStore);
  const panelOpen = useStore(panel, (state) => state.open);
  const panelSelection = useStore(panel, (state) => state.selection);
  const [panelWidth, setPanelWidth] = useState(360);
  const [panelSliding, setPanelSliding] = useState(false);
  const [previousOpen, setPreviousOpen] = useState(panelOpen);
  const panelGroup = useRef<HTMLDivElement>(null);
  if (previousOpen !== panelOpen) {
    setPreviousOpen(panelOpen);
    setPanelSliding(true);
  }
  useEffect(() => {
    if (!panelSliding) return;
    let canceled = false;
    const animations = panelGroup.current?.getAnimations() ?? [];
    void Promise.allSettled(animations.map((animation) => animation.finished)).then(() => {
      if (!canceled) setPanelSliding(false);
    });
    return () => {
      canceled = true;
    };
  }, [panelOpen, panelSliding]);
  const [playhead, setPlayhead] = useState({ stage: 1, frame: 0, playing: false });
  const [feedback, setFeedback] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const stage = agentWorkStages[playhead.stage]!;
  const slot = stage.frames[playhead.frame]!;
  const agents = useMemo(() => demoSubagents(slot), [slot]);
  const selectedAgent = agents.find((agent) => agent.id === panelSelection?.agentId);
  const agentContext = useMemo(
    () => ({
      agents: new Map(agents.map((agent) => [agent.activityId, agent])),
      open: (id: string) => panel.getState().select("demo", id),
    }),
    [agents, panel],
  );
  useEffect(() => {
    if (!playhead.playing) return;
    const timer = window.setTimeout(
      () => {
        setPlayhead((current) => {
          if (current.frame + 1 < stage.frames.length)
            return { ...current, frame: current.frame + 1 };
          if (current.stage + 1 < agentWorkStages.length)
            return { ...current, stage: current.stage + 1, frame: 0 };
          return { ...current, playing: false };
        });
      },
      stage.frames.length > 1 ? 140 : 2200,
    );
    return () => window.clearTimeout(timer);
  }, [playhead, stage]);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const pause = () =>
      setPlayhead((current) => (current.playing ? { ...current, playing: false } : current));
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) pause();
    });
    const onVisibilityChange = () => {
      if (document.hidden) pause();
    };
    observer.observe(element);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);
  function select(index: number) {
    setPlayhead({ stage: index, frame: 0, playing: false });
    setFeedback("");
  }
  function togglePlayback() {
    setFeedback("");
    setPlayhead((current) => {
      if (current.playing) return { ...current, playing: false };
      if (current.stage === agentWorkStages.length - 1)
        return { stage: 0, frame: 0, playing: true };
      return { ...current, playing: true };
    });
  }
  const services: MessageServices = {
    canEdit: true,
    resourceUrl: () => "",
    onAction: (_messageId, part, actionId) =>
      setFeedback(
        `Selected: ${part.data.actions.find((action) => action.actionId === actionId)?.label ?? actionId}`,
      ),
    onReaction: () => {},
  };
  return (
    <div className="ds-agent-demo" ref={container}>
      <div className="ds-agent-controls">
        <Select
          items={agentWorkStages.map((item) => ({ value: item.id, label: item.label }))}
          value={stage.id}
          onValueChange={(id) => {
            const index = agentWorkStages.findIndex((item) => item.id === id);
            if (index >= 0) select(index);
          }}
        >
          <SelectTrigger aria-label="Agent demo stage">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {agentWorkStages.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="ds-row">
          <IconButton
            label="Previous stage"
            disabled={playhead.stage === 0}
            onClick={() => select(playhead.stage - 1)}
          >
            <ChevronLeft />
          </IconButton>
          <Button variant="secondary" onClick={togglePlayback}>
            {playhead.playing ? <Pause /> : <Play />}
            {playhead.playing ? "Pause" : "Play stages"}
          </Button>
          <IconButton
            label="Next stage"
            disabled={playhead.stage === agentWorkStages.length - 1}
            onClick={() => select(playhead.stage + 1)}
          >
            <ChevronRight />
          </IconButton>
          <IconButton label="Restart demo" onClick={() => select(0)}>
            <RotateCcw />
          </IconButton>
        </div>
      </div>
      <div className="ds-agent-caption" role="status">
        <span className="ds-state-label">
          {playhead.stage + 1} / {agentWorkStages.length} · {stage.label}
        </span>
        <p className="ds-muted">{stage.description}</p>
      </div>
      <SubagentContext value={agentContext}>
        <div
          className={`ds-agent-workspace ${panelOpen ? "" : "right-panel-hidden"}`}
          style={
            {
              "--right-panel-width": `${panelWidth}px`,
              "--right-panel-offset": `${panelWidth + 1}px`,
            } as React.CSSProperties
          }
        >
          <RightPanelToggle open={panelOpen} onToggle={panel.getState().toggle} />
          <ResizablePanelGroup
            orientation="horizontal"
            className="workspace-panels"
            elementRef={panelGroup}
            data-right-fixed={!panelOpen || panelSliding}
            style={{ width: "var(--workspace-width, 100%)" }}
          >
            <ResizablePanel minSize="10%">
              <div className="ds-agent-preview" aria-label="Agent work preview" tabIndex={0}>
                <MessageIdentityContext value={identities}>
                  <MessageServicesContext value={services}>
                    <DemoTurn
                      key={stage.id}
                      slot={slot}
                      onRewind={() =>
                        setFeedback("Rewind selected. This demo does not change any conversation.")
                      }
                    />
                  </MessageServicesContext>
                </MessageIdentityContext>
              </div>
            </ResizablePanel>
            <ResizableHandle
              disabled={!panelOpen || panelSliding}
              aria-label="Demo agents panel width"
            />
            <ResizablePanel
              id="demo-agents-panel"
              className="right-panel"
              defaultSize="360px"
              minSize="200px"
              maxSize="65%"
              groupResizeBehavior="preserve-pixel-size"
              inert={!panelOpen}
              aria-hidden={!panelOpen}
              onResize={(size) => {
                if (panelOpen && !panelSliding && size.inPixels > 0) setPanelWidth(size.inPixels);
              }}
            >
              <SubagentPanelView
                items={agents}
                selected={selectedAgent}
                messages={selectedAgent ? demoSubagentTranscript(selectedAgent) : []}
                onSelect={agentContext.open}
                onBack={panel.getState().back}
              />
            </ResizablePanel>
          </ResizablePanelGroup>
        </div>
      </SubagentContext>
      <p className="ds-feedback" role="status">
        {feedback}
      </p>
    </div>
  );
}

function DemoTurn({ slot, onRewind }: { slot: ReadyTurnSlot; onRewind: () => void }) {
  const [arrivals] = useState(() => {
    const arrivals = new MessageArrivals();
    arrivals.activate([]);
    return arrivals;
  });
  return (
    <MessageArrivalsContext value={arrivals}>
      <Turn slot={slot} onRewind={onRewind} onLoadMore={() => {}} />
    </MessageArrivalsContext>
  );
}
