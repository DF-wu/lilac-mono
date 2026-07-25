export const SOURCE_SNAPSHOT_COMMIT = "f31f4f4e11867575c8ae3d6d754cae428f0d9ede";

export type SourceRef = {
  path: string;
  line: number;
  label?: string;
};

export type ImplementationStatus = "implemented" | "optional" | "planned-gap";

export type SystemNodeKind =
  | "actor"
  | "surface"
  | "orchestrator"
  | "agent"
  | "capability"
  | "store"
  | "infrastructure"
  | "satellite";

export type SystemNodeData = {
  label: string;
  eyebrow: string;
  kind: SystemNodeKind;
  status: ImplementationStatus;
  summary: string;
  responsibilities: readonly string[];
  inputs: readonly string[];
  outputs: readonly string[];
  guarantees: readonly string[];
  risks: readonly string[];
  technologies: readonly string[];
  sources: readonly SourceRef[];
  searchText: string;
};

export type MapStage = {
  id: string;
  label: string;
  eyebrow: string;
  summary: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
};

export type MapNodeDefinition = {
  id: string;
  position: { x: number; y: number };
  data: SystemNodeData;
  lens: readonly MapLens[];
};

export type MapEdgeKind = "event" | "stream" | "call" | "http" | "stdio" | "storage" | "spawn";

export type MapEdgeDefinition = {
  id: string;
  source: string;
  target: string;
  label: string;
  kind: MapEdgeKind;
  detail: string;
  lens: readonly MapLens[];
  sources: readonly SourceRef[];
};

export type MapLens = "core-reply" | "full-runtime" | "tools" | "persistence" | "satellites";

export type ScenarioCategory = "request" | "control" | "tools" | "durability" | "satellite";

export type FlowStep = {
  id: string;
  order: number;
  from: string;
  to: string;
  title: string;
  event?: string;
  transport: MapEdgeKind;
  description: string;
  payload: readonly string[];
  invariant: string;
  failure: string;
  sources: readonly SourceRef[];
};

export type RuntimeScenario = {
  id: string;
  category: ScenarioCategory;
  label: string;
  shortLabel: string;
  summary: string;
  trigger: string;
  outcome: string;
  lanes: readonly string[];
  steps: readonly FlowStep[];
  notes: readonly string[];
};

export type EventTopic = {
  topic: string;
  role: string;
  semantics: string;
  key: string;
  producers: readonly string[];
  consumers: readonly string[];
  events: readonly {
    type: string;
    payload: string;
    purpose: string;
  }[];
  sources: readonly SourceRef[];
};

export type StateMachine = {
  id: string;
  label: string;
  summary: string;
  states: readonly {
    id: string;
    label: string;
    tone: "neutral" | "active" | "success" | "danger" | "blocked";
  }[];
  transitions: readonly {
    from: string;
    to: string;
    label: string;
  }[];
  sources: readonly SourceRef[];
};

export type WorkspacePackage = {
  id: string;
  label: string;
  kind: "app" | "package";
  role: string;
  runtime: string;
  dependsOn: readonly string[];
  keyFiles: readonly SourceRef[];
};

export type PersistenceEntry = {
  name: string;
  owner: string;
  location: string;
  purpose: string;
  lifecycle: string;
  source: SourceRef;
};

export type ResearchSource = {
  name: string;
  url: string;
  principle: string;
  applied: string;
};

export function source(path: string, line: number, label?: string): SourceRef {
  return { path, line, label };
}
