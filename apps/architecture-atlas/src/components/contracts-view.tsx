import { useMemo, useState } from "react";
import {
  AlertOctagon,
  ArrowDown,
  ArrowRight,
  Check,
  CircleHelp,
  Container,
  Database,
  FileCode2,
  Filter,
  Layers2,
  LockKeyhole,
  Network,
  Radio,
  Search,
  ShieldAlert,
  Table2,
  Waypoints,
} from "lucide-react";

import {
  BUILTIN_PLUGIN_IDS,
  CONFIG_VERSION_DIFF,
  CONTEXT_LAYERS,
  DEPLOYMENT_CONNECTIONS,
  DEPLOYMENT_UNITS,
  EVENT_TOPICS,
  FS_TRANSPORT_MATRIX,
  IMPLEMENTATION_GAPS,
  LEVEL1_TOOL_MATRIX,
  PERSISTENCE_ENTRIES,
  SAFETY_AND_RELIABILITY,
  STARTUP_SEQUENCE,
  STATE_MACHINES,
  WORKSPACE_PACKAGES,
} from "../data/contracts";
import type { EventTopic, StateMachine } from "../data/types";
import { SourceLinks } from "./source-links";

type ContractPane = "events" | "states" | "workspace" | "guardrails";
type WorkspacePane = "packages" | "data" | "startup" | "deployment";
type GuardrailPane = "context" | "remote" | "config" | "safety";

const PANE_OPTIONS: readonly { id: ContractPane; label: string; icon: typeof Network }[] = [
  { id: "events", label: "Event 契約", icon: Radio },
  { id: "states", label: "狀態機", icon: Waypoints },
  { id: "workspace", label: "Workspace / Data", icon: Table2 },
  { id: "guardrails", label: "防線 / 現況", icon: ShieldAlert },
];

function EventPane() {
  const [query, setQuery] = useState("");
  const [selectedTopic, setSelectedTopic] = useState<EventTopic>(EVENT_TOPICS[0]);
  const filteredTopics = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-Hant");
    if (normalized.length === 0) return EVENT_TOPICS;
    return EVENT_TOPICS.filter((topic) =>
      [
        topic.topic,
        topic.role,
        topic.semantics,
        ...topic.producers,
        ...topic.consumers,
        ...topic.events.map((event) => event.type),
      ]
        .join(" ")
        .toLocaleLowerCase("zh-Hant")
        .includes(normalized),
    );
  }, [query]);

  return (
    <div className="contract-layout contract-layout--events">
      <aside className="contract-index" aria-label="Event topic 清單">
        <div className="contract-index__header">
          <span>TOPICS</span>
          <b>{EVENT_TOPICS.length}</b>
        </div>
        <label className="search-control search-control--inside">
          <Search aria-hidden="true" size={15} />
          <span className="sr-only">搜尋 topic</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="topic / event / producer"
          />
        </label>
        {filteredTopics.map((topic) => (
          <button
            data-active={selectedTopic.topic === topic.topic}
            key={topic.topic}
            onClick={() => setSelectedTopic(topic)}
            type="button"
          >
            <span className="topic-symbol">
              {topic.topic.startsWith("out") ? "OUT" : topic.topic.slice(0, 3).toUpperCase()}
            </span>
            <span>
              <strong>{topic.topic}</strong>
              <small>
                {topic.events.length} event{topic.events.length === 1 ? "" : "s"} · key={topic.key}
              </small>
            </span>
            <ArrowRight aria-hidden="true" size={14} />
          </button>
        ))}
      </aside>

      <section className="contract-detail" aria-labelledby="event-detail-title">
        <div className="contract-detail__heading">
          <div>
            <p>TOPIC CONTRACT / {selectedTopic.key}</p>
            <h2 id="event-detail-title">{selectedTopic.topic}</h2>
            <span>{selectedTopic.role}</span>
          </div>
          <span
            className={`topic-badge topic-badge--${selectedTopic.topic.startsWith("out") ? "output" : selectedTopic.topic.startsWith("evt") ? "event" : "command"}`}
          >
            {selectedTopic.topic.startsWith("out")
              ? "REQUEST STREAM"
              : selectedTopic.topic.startsWith("evt")
                ? "EVENT"
                : "COMMAND"}
          </span>
        </div>

        <p className="contract-lead">{selectedTopic.semantics}</p>

        <div className="producer-consumer-grid">
          <div>
            <h3>Publishers</h3>
            {selectedTopic.producers.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
          <ArrowRight aria-hidden="true" size={18} />
          <div>
            <h3>Subscribers</h3>
            {selectedTopic.consumers.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
        </div>

        <div className="event-table-wrap">
          <table className="contract-table event-table">
            <caption>此 topic 的 canonical event 與 payload</caption>
            <thead>
              <tr>
                <th>Type</th>
                <th>Payload shape</th>
                <th>Purpose</th>
              </tr>
            </thead>
            <tbody>
              {selectedTopic.events.map((event) => (
                <tr key={event.type}>
                  <td>
                    <code>{event.type}</code>
                  </td>
                  <td>
                    <code>{event.payload}</code>
                  </td>
                  <td>{event.purpose}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <section className="contract-source-block">
          <h3>Spec / wiring evidence</h3>
          <SourceLinks sources={selectedTopic.sources} />
        </section>
      </section>
    </div>
  );
}

function StateMachineDiagram({ machine }: { machine: StateMachine }) {
  return (
    <div className="state-machine" aria-label={`${machine.label} 狀態機`}>
      <div className="state-machine__states">
        {machine.states.map((state, index) => (
          <span className="state-pill" data-tone={state.tone} key={state.id}>
            <b>{String(index + 1).padStart(2, "0")}</b>
            {state.label}
          </span>
        ))}
      </div>
      <div className="transition-list">
        {machine.transitions.map((transition) => (
          <div
            className="transition-row"
            key={`${transition.from}-${transition.to}-${transition.label}`}
          >
            <code>{transition.from}</code>
            <ArrowRight aria-hidden="true" size={14} />
            <code>{transition.to}</code>
            <span>{transition.label}</span>
          </div>
        ))}
      </div>
      <div className="state-source">
        <span>Evidence</span>
        <SourceLinks sources={machine.sources} compact />
      </div>
    </div>
  );
}

function StatesPane() {
  const [selectedId, setSelectedId] = useState<string>(STATE_MACHINES[0].id);
  const selected = STATE_MACHINES.find((machine) => machine.id === selectedId) ?? STATE_MACHINES[0];

  return (
    <div className="states-layout">
      <nav className="state-index" aria-label="狀態機清單">
        {STATE_MACHINES.map((machine, index) => (
          <button
            data-active={machine.id === selected.id}
            key={machine.id}
            onClick={() => setSelectedId(machine.id)}
            type="button"
          >
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{machine.label}</strong>
            <ArrowRight aria-hidden="true" size={14} />
          </button>
        ))}
      </nav>
      <section className="state-detail">
        <p className="contract-kicker">
          STATE MACHINE / {selected.states.length} STATES / {selected.transitions.length}{" "}
          TRANSITIONS
        </p>
        <h2>{selected.label}</h2>
        <p>{selected.summary}</p>
        <StateMachineDiagram machine={selected} />
      </section>
    </div>
  );
}

function PackageMatrix() {
  const ids = WORKSPACE_PACKAGES.map((item) => item.id);
  return (
    <div className="package-area">
      <div className="table-scroll">
        <table className="contract-table dependency-matrix">
          <caption>
            Workspace dependency matrix，行是 package，欄是直接 workspace dependency
          </caption>
          <thead>
            <tr>
              <th>Package</th>
              {ids.map((id) => (
                <th className="matrix-heading" key={id}>
                  {id.replace("apps/", "a/").replace("packages/", "p/")}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {WORKSPACE_PACKAGES.map((pkg) => (
              <tr key={pkg.id}>
                <th>
                  <strong>{pkg.id}</strong>
                  <small>{pkg.role}</small>
                </th>
                {ids.map((target) => (
                  <td key={target}>
                    {pkg.dependsOn.some((dep) => dep === target || dep.startsWith(target)) ? (
                      <Check aria-label={`${pkg.id} depends on ${target}`} size={15} />
                    ) : (
                      <span aria-label="無直接 workspace dependency">·</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="package-evidence-list">
        {WORKSPACE_PACKAGES.map((pkg) => (
          <article key={pkg.id}>
            <div>
              <span className="package-type">{pkg.kind.toUpperCase()}</span>
              <h3>{pkg.label}</h3>
              <p>{pkg.runtime}</p>
            </div>
            <SourceLinks sources={pkg.keyFiles} compact />
          </article>
        ))}
      </div>
    </div>
  );
}

function PersistenceTable() {
  return (
    <div className="table-scroll">
      <table className="contract-table persistence-table">
        <caption>持久化與暫存資料 ownership map</caption>
        <thead>
          <tr>
            <th>Store</th>
            <th>Owner</th>
            <th>Location</th>
            <th>Purpose</th>
            <th>Lifecycle</th>
            <th>Evidence</th>
          </tr>
        </thead>
        <tbody>
          {PERSISTENCE_ENTRIES.map((entry) => (
            <tr key={entry.name}>
              <td>
                <strong>{entry.name}</strong>
              </td>
              <td>{entry.owner}</td>
              <td>
                <code>{entry.location}</code>
              </td>
              <td>{entry.purpose}</td>
              <td>{entry.lifecycle}</td>
              <td>
                <SourceLinks compact sources={[entry.source]} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StartupTimeline() {
  return (
    <ol className="startup-timeline">
      {STARTUP_SEQUENCE.map((step) => (
        <li key={step.order}>
          <span>{String(step.order).padStart(2, "0")}</span>
          <div>
            <strong>{step.title}</strong>
            <p>{step.detail}</p>
            <SourceLinks compact sources={[step.source]} />
          </div>
        </li>
      ))}
    </ol>
  );
}

function DeploymentView() {
  return (
    <div className="deployment-view">
      <div className="deployment-units">
        {DEPLOYMENT_UNITS.map((unit) => (
          <article key={unit.name}>
            <span>{unit.zone}</span>
            <h3>{unit.name}</h3>
            <code>{unit.runtime}</code>
            <p>{unit.detail}</p>
            <ul>
              {unit.interfaces.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <SourceLinks compact sources={unit.sources} />
          </article>
        ))}
      </div>
      <div className="table-scroll deployment-connections">
        <table className="contract-table">
          <caption>Deployment network and process connections</caption>
          <thead>
            <tr>
              <th>From</th>
              <th>To</th>
              <th>Protocol</th>
              <th>Direction</th>
              <th>Boundary note</th>
            </tr>
          </thead>
          <tbody>
            {DEPLOYMENT_CONNECTIONS.map((connection) => (
              <tr key={`${connection.from}-${connection.to}`}>
                <td>{connection.from}</td>
                <td>{connection.to}</td>
                <td>
                  <code>{connection.protocol}</code>
                </td>
                <td>{connection.direction}</td>
                <td>{connection.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function WorkspacePane() {
  const [subPane, setSubPane] = useState<WorkspacePane>("packages");
  return (
    <div className="workspace-layout">
      <div className="subpane-switcher" role="group" aria-label="Workspace detail">
        <button
          data-active={subPane === "packages"}
          onClick={() => setSubPane("packages")}
          type="button"
        >
          <Network size={15} /> 套件圖
        </button>
        <button data-active={subPane === "data"} onClick={() => setSubPane("data")} type="button">
          <Database size={15} /> 資料所有權
        </button>
        <button
          data-active={subPane === "startup"}
          onClick={() => setSubPane("startup")}
          type="button"
        >
          <ArrowDown size={15} /> 啟動順序
        </button>
        <button
          data-active={subPane === "deployment"}
          onClick={() => setSubPane("deployment")}
          type="button"
        >
          <Container size={15} /> Deployment
        </button>
      </div>
      {subPane === "packages" ? (
        <PackageMatrix />
      ) : subPane === "data" ? (
        <PersistenceTable />
      ) : subPane === "startup" ? (
        <StartupTimeline />
      ) : (
        <DeploymentView />
      )}
    </div>
  );
}

function GuardrailsPane() {
  const [subPane, setSubPane] = useState<GuardrailPane>("context");
  return (
    <div className="guardrails-layout">
      <div className="subpane-switcher" role="group" aria-label="防線 detail">
        <button
          data-active={subPane === "context"}
          onClick={() => setSubPane("context")}
          type="button"
        >
          <Layers2 size={15} /> Context layers
        </button>
        <button
          data-active={subPane === "remote"}
          onClick={() => setSubPane("remote")}
          type="button"
        >
          <Radio size={15} /> Remote matrix
        </button>
        <button
          data-active={subPane === "config"}
          onClick={() => setSubPane("config")}
          type="button"
        >
          <FileCode2 size={15} /> v1 / v2
        </button>
        <button
          data-active={subPane === "safety"}
          onClick={() => setSubPane("safety")}
          type="button"
        >
          <LockKeyhole size={15} /> Safety
        </button>
      </div>
      {subPane === "context" ? (
        <div className="context-stack">
          {CONTEXT_LAYERS.map((layer) => (
            <article key={layer.name}>
              <span>{String(layer.order).padStart(2, "0")}</span>
              <div>
                <p>{layer.owner}</p>
                <h3>{layer.name}</h3>
                <strong>{layer.content}</strong>
                <small>不是：{layer.notThis}</small>
                <SourceLinks compact sources={[layer.source]} />
              </div>
            </article>
          ))}
        </div>
      ) : subPane === "remote" ? (
        <div className="table-scroll">
          <table className="contract-table remote-table">
            <caption>Remote FS operation transport matrix</caption>
            <thead>
              <tr>
                <th>Operation</th>
                <th>Remote primary</th>
                <th>Transport fallback</th>
                <th>Shared backend</th>
                <th>Key caveat</th>
              </tr>
            </thead>
            <tbody>
              {FS_TRANSPORT_MATRIX.map((row) => (
                <tr key={row.operation}>
                  <td>
                    <code>{row.operation}</code>
                  </td>
                  <td>{row.remotePrimary}</td>
                  <td>{row.fallback}</td>
                  <td>{row.sharedBackend}</td>
                  <td>{row.caveat}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : subPane === "config" ? (
        <div className="table-scroll">
          <table className="contract-table config-table">
            <caption>core-config input version difference，UniversalCoreConfig 是共同輸出</caption>
            <thead>
              <tr>
                <th>Field</th>
                <th>v1</th>
                <th>v2</th>
                <th>Runtime impact</th>
              </tr>
            </thead>
            <tbody>
              {CONFIG_VERSION_DIFF.map((row) => (
                <tr key={row.field}>
                  <th>{row.field}</th>
                  <td>{row.v1}</td>
                  <td>{row.v2}</td>
                  <td>{row.impact}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="safety-layout">
          <section>
            <div className="safety-heading">
              <ShieldAlert size={17} />
              <h2>防線與可靠性</h2>
            </div>
            <div className="safety-list">
              {SAFETY_AND_RELIABILITY.map((item) => (
                <article data-type={item.type} key={`${item.area}-${item.title}`}>
                  <span>{item.type === "defense" ? "DEFENSE" : "LIMIT"}</span>
                  <div>
                    <p>{item.area}</p>
                    <h3>{item.title}</h3>
                    <strong>{item.detail}</strong>
                    <SourceLinks compact sources={[item.source]} />
                  </div>
                </article>
              ))}
            </div>
          </section>
          <section className="gap-section">
            <div className="safety-heading">
              <CircleHelp size={17} />
              <h2>Current vs plan</h2>
            </div>
            <div className="gap-list">
              {IMPLEMENTATION_GAPS.map((gap) => (
                <article data-status={gap.status} key={gap.title}>
                  <span>{gap.status}</span>
                  <h3>{gap.title}</h3>
                  <p>
                    <b>Current:</b> {gap.current}
                  </p>
                  <p>
                    <b>Plan:</b> {gap.planned}
                  </p>
                  <div className="gap-sources">
                    <SourceLinks compact sources={[gap.source, gap.plan]} />
                  </div>
                </article>
              ))}
            </div>
          </section>
          <section className="tool-profile-section">
            <div className="safety-heading">
              <Filter size={17} />
              <h2>Level 1 profile matrix</h2>
            </div>
            <div className="table-scroll">
              <table className="contract-table profile-table">
                <caption>Built-in Level 1 tools by run profile</caption>
                <thead>
                  <tr>
                    <th>Tool</th>
                    <th>primary</th>
                    <th>self</th>
                    <th>general</th>
                    <th>explore</th>
                    <th>restricted</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {LEVEL1_TOOL_MATRIX.map((row) => (
                    <tr key={row.tool}>
                      <th>
                        <code>{row.tool}</code>
                      </th>
                      <td>{row.primary ? "✓" : "—"}</td>
                      <td>{row.self ? "✓" : "—"}</td>
                      <td>{row.general ? "✓" : "—"}</td>
                      <td>{row.explore ? "✓" : "—"}</td>
                      <td>{row.restricted ? "✓" : "—"}</td>
                      <td>{row.notes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="builtin-note">
              <b>Built-in plugin IDs:</b> {BUILTIN_PLUGIN_IDS.join(" · ")}
            </p>
          </section>
        </div>
      )}
    </div>
  );
}

export function ContractsView() {
  const [pane, setPane] = useState<ContractPane>("events");

  return (
    <section className="atlas-view contracts-page" aria-labelledby="contracts-title">
      <div className="view-heading-row">
        <div>
          <p className="view-kicker">VERSION 03 / SOURCE OF TRUTH + AUDIT</p>
          <h1 id="contracts-title">契約、狀態與證據圖鑑</h1>
          <p>
            把圖上容易被忽略的細節攤平成可查表格：topic payload、consumer mode、workspace
            dependencies、<span className="no-break">資料 ownership</span>、context 層與
            current/plan 邊界。
          </p>
        </div>
        <dl className="metric-strip" aria-label="契約檢查台統計">
          <div>
            <dt>TOPICS</dt>
            <dd>{EVENT_TOPICS.length}</dd>
          </div>
          <div>
            <dt>STATES</dt>
            <dd>{STATE_MACHINES.length}</dd>
          </div>
          <div>
            <dt>STORES</dt>
            <dd>{PERSISTENCE_ENTRIES.length}</dd>
          </div>
          <div>
            <dt>GAPS MARKED</dt>
            <dd>{IMPLEMENTATION_GAPS.length}</dd>
          </div>
        </dl>
      </div>

      <nav className="contract-pane-nav" aria-label="契約檢查台分頁">
        {PANE_OPTIONS.map((option) => {
          const Icon = option.icon;
          return (
            <button
              data-active={pane === option.id}
              key={option.id}
              onClick={() => setPane(option.id)}
              type="button"
            >
              <Icon aria-hidden="true" size={17} />
              <span>{option.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="contracts-workspace">
        {pane === "events" ? (
          <EventPane />
        ) : pane === "states" ? (
          <StatesPane />
        ) : pane === "workspace" ? (
          <WorkspacePane />
        ) : (
          <GuardrailsPane />
        )}
      </div>

      <footer className="contracts-footer">
        <AlertOctagon aria-hidden="true" size={15} />
        <span>
          本檢查台把 `cmd.agent`、`evt.workflow` 與 ACP plan gaps
          標成「未接線／預定」，不把型別存在誤報成 runtime 行為。
        </span>
      </footer>
    </section>
  );
}
