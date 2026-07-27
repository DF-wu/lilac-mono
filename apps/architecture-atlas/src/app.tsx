import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpenText,
  CheckCircle2,
  Braces,
  ExternalLink,
  Flower2,
  GitBranch,
  Info,
  Map,
  Workflow,
  X,
} from "lucide-react";

import { METHOD_DECISIONS, RESEARCH_SOURCES } from "./data/research";

const SystemMapView = lazy(async () => {
  const module = await import("./components/system-map-view");
  return { default: module.SystemMapView };
});

const RuntimeFlowView = lazy(async () => {
  const module = await import("./components/runtime-flow-view");
  return { default: module.RuntimeFlowView };
});

const ContractsView = lazy(async () => {
  const module = await import("./components/contracts-view");
  return { default: module.ContractsView };
});

type AtlasView = "map" | "flows" | "contracts";

const VIEW_OPTIONS: readonly {
  id: AtlasView;
  label: string;
  eyebrow: string;
  icon: typeof Map;
}[] = [
  { id: "map", label: "系統地圖", eyebrow: "VERSION 01", icon: Map },
  { id: "flows", label: "執行劇場", eyebrow: "VERSION 02", icon: Workflow },
  { id: "contracts", label: "契約與程式碼", eyebrow: "VERSION 03", icon: Braces },
];

export function App() {
  const [activeView, setActiveView] = useState<AtlasView>("map");
  const [showResearch, setShowResearch] = useState(false);
  const researchTriggerRef = useRef<HTMLButtonElement>(null);
  const researchCloseRef = useRef<HTMLButtonElement>(null);

  const closeResearch = useCallback(() => {
    setShowResearch(false);
    window.requestAnimationFrame(() => researchTriggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!showResearch) return;
    researchCloseRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeResearch();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeResearch, showResearch]);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要內容
      </a>
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-mark" aria-hidden="true">
            <Flower2 size={20} strokeWidth={1.8} />
          </span>
          <span>
            <span className="brand-name">LILAC / SYSTEM ATLAS</span>
            <span className="brand-meta">code evidence at f31f4f4 · 2026-07-18</span>
          </span>
        </div>

        <nav className="view-switcher" aria-label="三種架構閱讀方式">
          {VIEW_OPTIONS.map((option) => {
            const Icon = option.icon;
            return (
              <button
                className="view-switcher__item"
                data-active={activeView === option.id}
                key={option.id}
                onClick={() => setActiveView(option.id)}
                type="button"
              >
                <Icon aria-hidden="true" size={18} />
                <span>
                  <small>{option.eyebrow}</small>
                  {option.label}
                </span>
              </button>
            );
          })}
        </nav>

        <div className="topbar-actions">
          <a
            className="icon-button"
            href="https://github.com/DF-wu/lilac-mono/tree/f31f4f4e11867575c8ae3d6d754cae428f0d9ede"
            target="_blank"
            rel="noreferrer"
            aria-label="開啟對應的 GitHub 原始碼"
            title="原始碼"
          >
            <GitBranch size={18} />
          </a>
          <button
            ref={researchTriggerRef}
            className="icon-button"
            type="button"
            aria-label="閱讀方法與資料來源"
            aria-expanded={showResearch}
            title="方法與資料來源"
            onClick={() => setShowResearch(true)}
          >
            <Info size={18} />
          </button>
        </div>
      </header>

      <main id="main-content" className="main-content" tabIndex={-1}>
        <Suspense fallback={<ViewLoading />}>
          {activeView === "map" ? (
            <SystemMapView />
          ) : activeView === "flows" ? (
            <RuntimeFlowView />
          ) : (
            <ContractsView />
          )}
        </Suspense>
      </main>

      {showResearch ? (
        <div className="research-scrim" role="presentation" onMouseDown={closeResearch}>
          <aside
            className="research-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="research-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <p>METHOD / SOURCES</p>
                <h2 id="research-title">架構視覺化研究筆記</h2>
              </div>
              <button
                ref={researchCloseRef}
                className="icon-button"
                type="button"
                aria-label="關閉方法與資料來源"
                title="關閉"
                onClick={closeResearch}
              >
                <X size={18} />
              </button>
            </header>
            <p className="research-lead">
              這份 atlas 以固定 commit
              的原始碼為唯一實作證據，再借用成熟架構文件方法決定抽象層級與閱讀順序。
            </p>
            <section className="research-section">
              <h3>
                <CheckCircle2 aria-hidden="true" size={15} /> 已採用的決策
              </h3>
              <ul>
                {METHOD_DECISIONS.map((decision) => (
                  <li key={decision}>{decision}</li>
                ))}
              </ul>
            </section>
            <section className="research-section">
              <h3>
                <BookOpenText aria-hidden="true" size={15} /> 外部參考
              </h3>
              <div className="research-source-list">
                {RESEARCH_SOURCES.map((item) => (
                  <a href={item.url} key={item.name} target="_blank" rel="noreferrer">
                    <span>
                      <strong>{item.name}</strong>
                      <small>{item.principle}</small>
                      <em>採用：{item.applied}</em>
                    </span>
                    <ExternalLink aria-hidden="true" size={14} />
                  </a>
                ))}
              </div>
            </section>
            <footer className="research-footer">
              Snapshot: `f31f4f4e11867575c8ae3d6d754cae428f0d9ede` · repo: `DF-wu/lilac-mono`
            </footer>
          </aside>
        </div>
      ) : null}
    </div>
  );
}

function ViewLoading() {
  return (
    <section className="view-loading" aria-live="polite">
      <span className="view-loading__mark" aria-hidden="true">
        <Flower2 size={18} />
      </span>
      <p>載入架構視圖…</p>
    </section>
  );
}
