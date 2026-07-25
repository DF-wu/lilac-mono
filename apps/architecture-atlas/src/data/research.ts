import type { ResearchSource } from "./types";

export const RESEARCH_SOURCES = [
  {
    name: "C4 model",
    url: "https://c4model.com/",
    principle: "用 system、container、component、code 的階層抽象控制一次看到的細節量。",
    applied: "系統地圖先顯示容器級邊界，再由節點 inspector 展開元件與原始碼。",
  },
  {
    name: "C4 dynamic diagram",
    url: "https://c4model.com/diagrams/dynamic",
    principle: "以編號互動表達順序，保留比傳統 sequence diagram 更自由的空間配置。",
    applied: "執行劇場將每個 scenario 拆成可播放、可逐步檢查的編號事件。",
  },
  {
    name: "arc42 overview",
    url: "https://arc42.org/overview",
    principle: "建構區塊、runtime、deployment、cross-cutting concepts 應分開描述。",
    applied:
      "三個版本分別承擔 static map、runtime story、contract/evidence，不把所有內容塞進一張圖。",
  },
  {
    name: "Structurizr dynamic views",
    url: "https://docs.structurizr.com/ui/diagrams/dynamic-view",
    principle: "同一架構模型可衍生 static、dynamic、deployment 與 filtered views。",
    applied: "所有視圖共用同一批名稱、事件與來源證據，避免跨圖語意漂移。",
  },
  {
    name: "Mermaid architecture diagrams",
    url: "https://mermaid.js.org/syntax/architecture.html",
    principle: "group、service、edge、junction 與 deterministic layout 能讓拓樸可重現。",
    applied: "系統地圖採固定分帶與穩定座標，切換 filter 時不重新隨機排版。",
  },
  {
    name: "React Flow accessibility",
    url: "https://reactflow.dev/learn/advanced-use/accessibility",
    principle: "節點與邊需支援 tab focus、keyboard selection、自動平移與 ARIA 描述。",
    applied: "互動圖保留鍵盤節點焦點，並提供完整文字 inspector 與表格型替代視圖。",
  },
  {
    name: "LikeC4",
    url: "https://likec4.dev/",
    principle: "Architecture as Code 應由單一 source of truth 產生可視化、驗證與分享結果。",
    applied: "每個結論都帶 commit、檔案與行號；plan 與 implemented evidence 分開。",
  },
] as const satisfies readonly ResearchSource[];

export const METHOD_DECISIONS = [
  "以固定 commit f31f4f4 為證據快照，避免文件與目前 worktree 混成同一時點。",
  "圖只負責關係；完整責任、payload、失敗路徑與 source ref 放在鄰近文字面板。",
  "顏色只表示類別，所有狀態同時使用文字與圖形標記。",
  "ACP、remote-fs 與 plan 中能力明確畫在 core 邊界之外，不製造不存在的 runtime import。",
] as const;
