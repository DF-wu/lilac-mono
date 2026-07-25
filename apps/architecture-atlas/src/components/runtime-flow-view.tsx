import { useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CircleDot,
  Clock3,
  Pause,
  Play,
  RotateCcw,
  Search,
  SkipBack,
  SkipForward,
} from "lucide-react";

import { RUNTIME_SCENARIOS } from "../data/scenarios";
import type { FlowStep, RuntimeScenario, ScenarioCategory } from "../data/types";
import { SourceLinks } from "./source-links";

const CATEGORY_OPTIONS: readonly { id: "all" | ScenarioCategory; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "request", label: "請求" },
  { id: "control", label: "控制 / Context" },
  { id: "tools", label: "工具" },
  { id: "durability", label: "持久化" },
  { id: "satellite", label: "獨立程序" },
];

const CATEGORY_LABELS: Record<ScenarioCategory, string> = {
  request: "REQUEST",
  control: "CONTROL",
  tools: "TOOLS",
  durability: "DURABILITY",
  satellite: "SATELLITE",
};

function ScenarioList({
  scenarios,
  selectedId,
  onSelect,
}: {
  scenarios: readonly RuntimeScenario[];
  selectedId: string;
  onSelect: (scenario: RuntimeScenario) => void;
}) {
  return (
    <nav className="scenario-list" aria-label="執行流程清單">
      <div className="scenario-list__header">
        <span>SCENARIOS</span>
        <b>{scenarios.length}</b>
      </div>
      {scenarios.map((scenario, index) => (
        <button
          data-active={selectedId === scenario.id}
          key={scenario.id}
          onClick={() => onSelect(scenario)}
          type="button"
        >
          <span className="scenario-list__index">{String(index + 1).padStart(2, "0")}</span>
          <span>
            <small>{CATEGORY_LABELS[scenario.category]}</small>
            <strong>{scenario.shortLabel}</strong>
            <em>{scenario.steps.length} steps</em>
          </span>
          <ArrowRight aria-hidden="true" size={15} />
        </button>
      ))}
    </nav>
  );
}

function StepInspector({ step, showFailure }: { step: FlowStep; showFailure: boolean }) {
  return (
    <aside className="flow-inspector" aria-label={`步驟 ${step.order} 詳細資料`}>
      <div className="step-order-block">
        <span>{String(step.order).padStart(2, "0")}</span>
        <div>
          <p>{step.transport.toUpperCase()}</p>
          <h2>{step.title}</h2>
        </div>
      </div>
      <div className="step-route">
        <span>{step.from}</span>
        <ArrowRight aria-hidden="true" size={16} />
        <span>{step.to}</span>
      </div>
      {step.event ? <code className="event-code">{step.event}</code> : null}
      <p className="flow-inspector__description">{step.description}</p>

      <section className="inspector-section">
        <h3>資料包 / 狀態</h3>
        <div className="payload-list">
          {step.payload.map((item) => (
            <code key={item}>{item}</code>
          ))}
        </div>
      </section>

      <section className="inspector-section invariant-block">
        <h3>
          <CheckCircle2 aria-hidden="true" size={15} /> 本步不變條件
        </h3>
        <p>{step.invariant}</p>
      </section>

      {showFailure ? (
        <section className="inspector-section failure-block">
          <h3>
            <AlertTriangle aria-hidden="true" size={15} /> 失敗 / 限制分支
          </h3>
          <p>{step.failure}</p>
        </section>
      ) : null}

      <section className="inspector-section">
        <h3>原始碼證據</h3>
        <SourceLinks sources={step.sources} />
      </section>
    </aside>
  );
}

function SequenceBoard({
  scenario,
  activeIndex,
  onStepSelect,
}: {
  scenario: RuntimeScenario;
  activeIndex: number;
  onStepSelect: (index: number) => void;
}) {
  const gridStyle: CSSProperties = {
    gridTemplateColumns: `repeat(${scenario.lanes.length}, minmax(126px, 1fr))`,
  };

  return (
    <div
      className="sequence-scroll"
      tabIndex={0}
      aria-label={`${scenario.label} 時序圖，可水平捲動`}
    >
      <div className="sequence-board" style={{ minWidth: scenario.lanes.length * 126 }}>
        <div className="sequence-lane-head" style={gridStyle}>
          {scenario.lanes.map((lane, index) => (
            <div key={lane}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{lane}</strong>
            </div>
          ))}
        </div>

        <div className="sequence-steps">
          {scenario.steps.map((step, stepIndex) => {
            const fromIndex = scenario.lanes.indexOf(step.from);
            const toIndex = scenario.lanes.indexOf(step.to);
            const start = Math.min(fromIndex, toIndex);
            const end = Math.max(fromIndex, toIndex);
            const reverse = toIndex < fromIndex;

            return (
              <button
                className="sequence-step-row"
                data-active={stepIndex === activeIndex}
                data-complete={stepIndex < activeIndex}
                key={step.id}
                onClick={() => onStepSelect(stepIndex)}
                type="button"
                aria-label={`步驟 ${step.order}：${step.from} 到 ${step.to}，${step.title}`}
              >
                <span className="sequence-step-row__number">
                  {String(step.order).padStart(2, "0")}
                </span>
                <span className="sequence-step-row__grid" style={gridStyle}>
                  {scenario.lanes.map((lane) => (
                    <i className="lane-rail" key={lane} aria-hidden="true" />
                  ))}
                  <span
                    className="sequence-message"
                    data-reverse={reverse}
                    data-transport={step.transport}
                    style={{ gridColumn: `${start + 1} / ${end + 2}` }}
                  >
                    <span className="sequence-message__line" aria-hidden="true">
                      <CircleDot size={11} />
                      <i />
                      {reverse ? <ArrowLeft size={13} /> : <ArrowRight size={13} />}
                    </span>
                    <span className="sequence-message__label">
                      <b>{step.title}</b>
                      {step.event ? <code>{step.event}</code> : <small>{step.transport}</small>}
                    </span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function RuntimeFlowView() {
  const [category, setCategory] = useState<"all" | ScenarioCategory>("all");
  const [query, setQuery] = useState("");
  const [selectedScenario, setSelectedScenario] = useState<RuntimeScenario>(RUNTIME_SCENARIOS[0]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [showFailure, setShowFailure] = useState(true);

  const filteredScenarios = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-Hant");
    return RUNTIME_SCENARIOS.filter((scenario) => {
      const categoryMatch = category === "all" || scenario.category === category;
      const queryMatch =
        normalized.length === 0 ||
        [scenario.label, scenario.shortLabel, scenario.summary, scenario.trigger, scenario.outcome]
          .join(" ")
          .toLocaleLowerCase("zh-Hant")
          .includes(normalized);
      return categoryMatch && queryMatch;
    });
  }, [category, query]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      setActiveIndex((current) => {
        if (current >= selectedScenario.steps.length - 1) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, 1200);
    return () => window.clearInterval(timer);
  }, [playing, selectedScenario]);

  function selectScenario(scenario: RuntimeScenario) {
    setSelectedScenario(scenario);
    setActiveIndex(0);
    setPlaying(false);
  }

  const activeStep = selectedScenario.steps[activeIndex] ?? selectedScenario.steps[0];
  if (!activeStep) {
    throw new Error(`Scenario '${selectedScenario.id}' has no flow steps`);
  }

  return (
    <section className="atlas-view flow-page" aria-labelledby="flow-title">
      <div className="view-heading-row">
        <div>
          <p className="view-kicker">VERSION 02 / DYNAMIC + FAILURE PATHS</p>
          <h1 id="flow-title">Lilac 執行劇場</h1>
          <p>
            選一條真實 scenario，逐格看
            process、event、payload、狀態與失敗分支。播放只改閱讀焦點，不假裝是 production
            telemetry。
          </p>
        </div>
        <dl className="metric-strip" aria-label="執行劇場統計">
          <div>
            <dt>SCENARIOS</dt>
            <dd>{RUNTIME_SCENARIOS.length}</dd>
          </div>
          <div>
            <dt>SELECTED STEPS</dt>
            <dd>{selectedScenario.steps.length}</dd>
          </div>
          <div>
            <dt>LANES</dt>
            <dd>{selectedScenario.lanes.length}</dd>
          </div>
          <div>
            <dt>FAILURE NOTES</dt>
            <dd>ON</dd>
          </div>
        </dl>
      </div>

      <div className="flow-toolbar">
        <div className="segmented-control" role="group" aria-label="Scenario 類別">
          {CATEGORY_OPTIONS.map((option) => (
            <button
              data-active={category === option.id}
              key={option.id}
              onClick={() => setCategory(option.id)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
        <label className="search-control">
          <Search aria-hidden="true" size={16} />
          <span className="sr-only">搜尋執行流程</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜尋 request、tool、memory、ACP…"
          />
        </label>
        <label className="failure-toggle">
          <input
            checked={showFailure}
            onChange={(event) => setShowFailure(event.target.checked)}
            type="checkbox"
          />
          <span>顯示失敗分支</span>
        </label>
      </div>

      <div className="flow-workspace">
        <ScenarioList
          scenarios={filteredScenarios}
          selectedId={selectedScenario.id}
          onSelect={selectScenario}
        />

        <div className="flow-stage">
          <header className="scenario-header">
            <div>
              <p>
                {CATEGORY_LABELS[selectedScenario.category]} / {selectedScenario.steps.length} STEPS
              </p>
              <h2>{selectedScenario.label}</h2>
              <span>{selectedScenario.summary}</span>
            </div>
            <div className="scenario-contract">
              <span>
                <Play aria-hidden="true" size={13} /> TRIGGER
              </span>
              <p>{selectedScenario.trigger}</p>
              <span>
                <CheckCircle2 aria-hidden="true" size={13} /> OUTCOME
              </span>
              <p>{selectedScenario.outcome}</p>
            </div>
          </header>

          <div className="playback-bar">
            <button
              className="icon-button icon-button--small"
              onClick={() => setActiveIndex(0)}
              type="button"
              aria-label="回到第一步"
              title="回到第一步"
            >
              <SkipBack size={16} />
            </button>
            <button
              className="play-button"
              onClick={() => {
                if (activeIndex >= selectedScenario.steps.length - 1) setActiveIndex(0);
                setPlaying((current) => !current);
              }}
              type="button"
            >
              {playing ? (
                <Pause aria-hidden="true" size={16} />
              ) : (
                <Play aria-hidden="true" size={16} />
              )}
              {playing ? "暫停" : "播放"}
            </button>
            <button
              className="icon-button icon-button--small"
              onClick={() => setActiveIndex((current) => Math.max(0, current - 1))}
              type="button"
              aria-label="上一步"
              title="上一步"
            >
              <ArrowLeft size={16} />
            </button>
            <input
              aria-label="流程步驟"
              className="step-slider"
              type="range"
              min={0}
              max={selectedScenario.steps.length - 1}
              value={activeIndex}
              onChange={(event) => {
                setPlaying(false);
                setActiveIndex(Number(event.target.value));
              }}
            />
            <span className="playback-count">
              {activeIndex + 1} / {selectedScenario.steps.length}
            </span>
            <button
              className="icon-button icon-button--small"
              onClick={() =>
                setActiveIndex((current) =>
                  Math.min(selectedScenario.steps.length - 1, current + 1),
                )
              }
              type="button"
              aria-label="下一步"
              title="下一步"
            >
              <ArrowRight size={16} />
            </button>
            <button
              className="icon-button icon-button--small"
              onClick={() => setActiveIndex(selectedScenario.steps.length - 1)}
              type="button"
              aria-label="跳到最後一步"
              title="跳到最後一步"
            >
              <SkipForward size={16} />
            </button>
            <button
              className="icon-button icon-button--small"
              onClick={() => {
                setPlaying(false);
                setActiveIndex(0);
              }}
              type="button"
              aria-label="重設播放"
              title="重設播放"
            >
              <RotateCcw size={15} />
            </button>
          </div>

          <SequenceBoard
            scenario={selectedScenario}
            activeIndex={activeIndex}
            onStepSelect={(index) => {
              setPlaying(false);
              setActiveIndex(index);
            }}
          />

          <footer className="scenario-notes">
            <Clock3 aria-hidden="true" size={15} />
            <div>
              {selectedScenario.notes.map((note) => (
                <p key={note}>{note}</p>
              ))}
            </div>
          </footer>
        </div>

        <StepInspector step={activeStep} showFailure={showFailure} />
      </div>
    </section>
  );
}
