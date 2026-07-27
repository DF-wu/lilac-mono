import { useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  MarkerType,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Database,
  List,
  Network,
  Search,
  ShieldCheck,
} from "lucide-react";
import "@xyflow/react/dist/style.css";

import { MAP_EDGES, MAP_LENS_OPTIONS, MAP_NODES, MAP_STAGES } from "../data/system-map";
import type { MapEdgeKind, MapLens, SystemNodeData } from "../data/types";
import {
  ArchitectureNode,
  StageNode,
  type ArchitectureFlowNode,
  type StageFlowNode,
} from "./architecture-node";
import { MapControls } from "./map-controls";
import { SourceLinks } from "./source-links";

const NODE_TYPES = {
  architecture: ArchitectureNode,
  stage: StageNode,
};

const EDGE_COLORS: Record<MapEdgeKind, string> = {
  event: "#007f8f",
  stream: "#b35a00",
  call: "#5d6970",
  http: "#4455a7",
  stdio: "#b83a4b",
  storage: "#26734d",
  spawn: "#7b4d9f",
};

type ViewMode = "diagram" | "catalog";

function toFlowNodes(lens: MapLens, query: string): Array<ArchitectureFlowNode | StageFlowNode> {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-Hant");
  const visibleNodes = MAP_NODES.filter((item) => item.lens.some((itemLens) => itemLens === lens));
  const visibleStageIds = new Set(
    MAP_STAGES.filter((stage) =>
      visibleNodes.some(
        (item) =>
          item.position.x >= stage.position.x &&
          item.position.x < stage.position.x + stage.size.width,
      ),
    ).map((stage) => stage.id),
  );

  const stages: StageFlowNode[] = MAP_STAGES.filter((stage) => visibleStageIds.has(stage.id)).map(
    (stage) => ({
      id: `stage-${stage.id}`,
      type: "stage",
      position: stage.position,
      data: { label: stage.label, eyebrow: stage.eyebrow, summary: stage.summary },
      style: { width: stage.size.width, height: stage.size.height },
      selectable: false,
      draggable: false,
      focusable: false,
      zIndex: -2,
    }),
  );

  const nodes: ArchitectureFlowNode[] = visibleNodes.map((item) => {
    const isMatch = normalizedQuery.length === 0 || item.data.searchText.includes(normalizedQuery);
    return {
      id: item.id,
      type: "architecture",
      position: item.position,
      data: item.data,
      draggable: false,
      className: isMatch ? "flow-node-match" : "flow-node-dimmed",
      ariaLabel: `${item.data.label}。${item.data.summary}`,
      zIndex: 2,
    };
  });

  return [...stages, ...nodes];
}

function toFlowEdges(lens: MapLens): Edge[] {
  const visibleNodeIds = new Set(
    MAP_NODES.filter((item) => item.lens.some((itemLens) => itemLens === lens)).map(
      (item) => item.id,
    ),
  );

  return MAP_EDGES.filter(
    (edge) =>
      edge.lens.some((edgeLens) => edgeLens === lens) &&
      visibleNodeIds.has(edge.source) &&
      visibleNodeIds.has(edge.target),
  ).map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    type: "smoothstep",
    className: `architecture-edge architecture-edge--${edge.kind}`,
    ariaLabel: `${edge.source} 到 ${edge.target}：${edge.label}。${edge.detail}`,
    focusable: true,
    style: { stroke: EDGE_COLORS[edge.kind], strokeWidth: edge.kind === "stream" ? 2.2 : 1.6 },
    labelStyle: { fill: "#43515a", fontSize: 10, fontFamily: "JetBrains Mono" },
    labelBgStyle: { fill: "#fbfcfc", fillOpacity: 0.92 },
    labelBgPadding: [5, 3],
    labelBgBorderRadius: 2,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 16,
      height: 16,
      color: EDGE_COLORS[edge.kind],
    },
  }));
}

function NodeInspector({ node }: { node: SystemNodeData }) {
  return (
    <aside className="map-inspector" aria-label={`${node.label} 詳細資料`}>
      <div className="inspector-heading">
        <div>
          <p>{node.eyebrow}</p>
          <h2>{node.label}</h2>
        </div>
        <span className="status-badge" data-status={node.status}>
          {node.status === "implemented"
            ? "已實作"
            : node.status === "optional"
              ? "條件式啟用"
              : "Plan gap"}
        </span>
      </div>
      <p className="inspector-summary">{node.summary}</p>

      <section className="inspector-section">
        <h3>責任</h3>
        <ul>
          {node.responsibilities.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section className="inspector-section inspector-io">
        <div>
          <h3>輸入</h3>
          {node.inputs.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
        <ArrowRight aria-hidden="true" size={18} />
        <div>
          <h3>輸出</h3>
          {node.outputs.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      </section>

      <section className="inspector-section signal-list signal-list--good">
        <h3>
          <ShieldCheck aria-hidden="true" size={15} /> 保證與防線
        </h3>
        {node.guarantees.map((item) => (
          <p key={item}>{item}</p>
        ))}
      </section>

      <section className="inspector-section signal-list signal-list--risk">
        <h3>
          <AlertTriangle aria-hidden="true" size={15} /> 限制與風險
        </h3>
        {node.risks.map((item) => (
          <p key={item}>{item}</p>
        ))}
      </section>

      <section className="inspector-section">
        <h3>技術</h3>
        <div className="tag-list">
          {node.technologies.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </div>
      </section>

      <section className="inspector-section">
        <h3>原始碼證據</h3>
        <SourceLinks sources={node.sources} />
      </section>
    </aside>
  );
}

function CatalogView({
  nodes,
  onSelect,
}: {
  nodes: readonly SystemNodeData[];
  onSelect: (node: SystemNodeData) => void;
}) {
  return (
    <section className="map-catalog" aria-label="架構元件文字清單">
      {nodes.map((node) => (
        <button
          className="catalog-row"
          key={node.label}
          onClick={() => onSelect(node)}
          type="button"
        >
          <span className="catalog-row__type">{node.eyebrow}</span>
          <span>
            <strong>{node.label}</strong>
            <small>{node.summary}</small>
          </span>
          <span className="catalog-row__metrics">
            {node.inputs.length} IN / {node.outputs.length} OUT
          </span>
          <ArrowRight aria-hidden="true" size={16} />
        </button>
      ))}
    </section>
  );
}

export function SystemMapView() {
  const [lens, setLens] = useState<MapLens>("core-reply");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<ViewMode>(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width: 900px)").matches
      ? "catalog"
      : "diagram",
  );
  const defaultNode =
    MAP_NODES.find((item) => item.id === "request-router")?.data ?? MAP_NODES[0].data;
  const [selectedNode, setSelectedNode] = useState<SystemNodeData>(defaultNode);

  const nodes = useMemo(() => toFlowNodes(lens, query), [lens, query]);
  const edges = useMemo(() => toFlowEdges(lens), [lens]);
  const catalogNodes = useMemo(
    () =>
      MAP_NODES.filter((item) => item.lens.some((itemLens) => itemLens === lens))
        .map((item) => item.data)
        .filter(
          (item) =>
            query.trim().length === 0 ||
            item.searchText.includes(query.trim().toLocaleLowerCase("zh-Hant")),
        ),
    [lens, query],
  );

  const handleNodeClick: NodeMouseHandler<Node> = (_event, node) => {
    if (node.type !== "architecture") return;
    const match = MAP_NODES.find((item) => item.id === node.id);
    if (match) setSelectedNode(match.data);
  };

  return (
    <section className="atlas-view map-page" aria-labelledby="map-title">
      <div className="view-heading-row">
        <div>
          <p className="view-kicker">VERSION 01 / STATIC + BOUNDARIES</p>
          <h1 id="map-title">Lilac 全系統地圖</h1>
          <p>
            先沿箭頭讀主路徑，再點任一元件檢查責任、風險
            <span className="no-break">與原始碼</span>。固定布局保留跨視圖的空間記憶。
          </p>
        </div>
        <dl className="metric-strip" aria-label="架構快照統計">
          <div>
            <dt>PRODUCT WS</dt>
            <dd>9</dd>
          </div>
          <div>
            <dt>EVENT TYPES</dt>
            <dd>24</dd>
          </div>
          <div>
            <dt>TOPIC LANES</dt>
            <dd>9</dd>
          </div>
          <div>
            <dt>READING MODES</dt>
            <dd>3</dd>
          </div>
        </dl>
      </div>

      <div className="map-toolbar">
        <div className="segmented-control" role="group" aria-label="架構篩選鏡頭">
          {MAP_LENS_OPTIONS.map((option) => (
            <button
              data-active={lens === option.id}
              key={option.id}
              onClick={() => setLens(option.id)}
              title={option.description}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
        <label className="search-control">
          <Search aria-hidden="true" size={16} />
          <span className="sr-only">搜尋架構元件</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜尋元件、技術或責任"
          />
        </label>
        <div className="mode-switch" role="group" aria-label="圖形或文字檢視">
          <button data-active={mode === "diagram"} onClick={() => setMode("diagram")} type="button">
            <Network aria-hidden="true" size={16} /> 圖
          </button>
          <button data-active={mode === "catalog"} onClick={() => setMode("catalog")} type="button">
            <List aria-hidden="true" size={16} /> 清單
          </button>
        </div>
      </div>

      <div className="map-workspace">
        <div className="map-canvas-wrap">
          {mode === "diagram" ? (
            <ReactFlow
              key={lens}
              nodes={nodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              onNodeClick={handleNodeClick}
              nodesDraggable={false}
              nodesConnectable={false}
              nodesFocusable
              edgesFocusable
              fitView
              fitViewOptions={{ padding: 0.04, minZoom: 0.3, maxZoom: 0.85 }}
              minZoom={0.25}
              maxZoom={1.5}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#bac4c8" gap={24} size={1} variant={BackgroundVariant.Dots} />
              <MapControls />
              <MiniMap
                pannable
                zoomable
                position="bottom-right"
                nodeColor={(node) => (node.type === "stage" ? "#d9e0e2" : "#5d7178")}
                maskColor="rgb(237 241 242 / 72%)"
              />
            </ReactFlow>
          ) : (
            <CatalogView nodes={catalogNodes} onSelect={setSelectedNode} />
          )}
          <div className="edge-legend" role="group" aria-label="連線圖例">
            {(
              [
                ["event", "Redis event"],
                ["stream", "stream"],
                ["call", "in-process"],
                ["http", "HTTP"],
                ["stdio", "stdio / JSON"],
                ["storage", "storage"],
                ["spawn", "spawn"],
              ] as const
            ).map(([kind, label]) => (
              <span key={kind}>
                <i style={{ background: EDGE_COLORS[kind] }} />
                {label}
              </span>
            ))}
          </div>
        </div>
        <NodeInspector node={selectedNode} />
      </div>

      <div className="map-footnotes">
        <span>
          <CheckCircle2 aria-hidden="true" size={15} /> 綠點：程式碼中已接線
        </span>
        <span>
          <Database aria-hidden="true" size={15} /> 持久化不等於同一資料庫
        </span>
        <span>
          <AlertTriangle aria-hidden="true" size={15} /> ACP 與 remote FS 不屬 Redis event loop
        </span>
      </div>
    </section>
  );
}
