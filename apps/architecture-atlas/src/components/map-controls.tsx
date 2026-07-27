import { ControlButton, Panel, useReactFlow } from "@xyflow/react";
import { Maximize2, Minus, Plus } from "lucide-react";

export function MapControls() {
  const { fitView, zoomIn, zoomOut } = useReactFlow();

  return (
    <Panel
      className="react-flow__controls vertical"
      position="bottom-left"
      role="toolbar"
      aria-label="圖形縮放控制"
    >
      <ControlButton
        aria-label="放大"
        onClick={() => {
          void zoomIn();
        }}
        title="放大"
      >
        <Plus aria-hidden="true" />
      </ControlButton>
      <ControlButton
        aria-label="縮小"
        onClick={() => {
          void zoomOut();
        }}
        title="縮小"
      >
        <Minus aria-hidden="true" />
      </ControlButton>
      <ControlButton
        aria-label="符合視窗"
        onClick={() => {
          void fitView();
        }}
        title="符合視窗"
      >
        <Maximize2 aria-hidden="true" />
      </ControlButton>
    </Panel>
  );
}
