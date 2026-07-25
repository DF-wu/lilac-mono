import type { Node, NodeProps } from "@xyflow/react";
import { Handle, Position } from "@xyflow/react";
import {
  Bot,
  Boxes,
  Cable,
  CircleUserRound,
  Database,
  Layers3,
  RadioTower,
  Satellite,
} from "lucide-react";

import type { SystemNodeData } from "../data/types";

export type ArchitectureFlowNode = Node<SystemNodeData, "architecture">;
export type StageFlowNode = Node<{ label: string; eyebrow: string; summary: string }, "stage">;

const KIND_ICONS = {
  actor: CircleUserRound,
  surface: RadioTower,
  orchestrator: Cable,
  agent: Bot,
  capability: Boxes,
  store: Database,
  infrastructure: Layers3,
  satellite: Satellite,
} as const;

export function ArchitectureNode({ data, selected }: NodeProps<ArchitectureFlowNode>) {
  const Icon = KIND_ICONS[data.kind];

  return (
    <div className="architecture-node" data-kind={data.kind} data-selected={selected}>
      <Handle className="architecture-handle" type="target" position={Position.Left} />
      <div className="architecture-node__topline">
        <span className="architecture-node__icon" aria-hidden="true">
          <Icon size={15} strokeWidth={1.8} />
        </span>
        <span className="architecture-node__eyebrow">{data.eyebrow}</span>
        <span className="status-dot" data-status={data.status} title={data.status} />
      </div>
      <strong>{data.label}</strong>
      <p>{data.summary}</p>
      <div className="architecture-node__ports">
        <span>{data.inputs.length} IN</span>
        <span>{data.outputs.length} OUT</span>
      </div>
      <Handle className="architecture-handle" type="source" position={Position.Right} />
    </div>
  );
}

export function StageNode({ data }: NodeProps<StageFlowNode>) {
  return (
    <div className="stage-node">
      <span>{data.eyebrow}</span>
      <strong>{data.label}</strong>
      <p>{data.summary}</p>
    </div>
  );
}
