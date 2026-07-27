# Lilac System Atlas

這是一個獨立的、以原始碼證據為核心的 Lilac Mono architecture explorer。它不會被 core runtime 啟動，也不會連 Redis；所有圖、事件、payload、狀態與 source link 都是對固定 commit 的靜態研究快照。

## 啟動

在 repository root 執行：

```bash
bun --cwd=apps/architecture-atlas run dev
```

一鍵啟動並嘗試開啟執行主機上的瀏覽器；如果 `4173` 已有 Atlas，則直接開啟現有服務：

```bash
bun run atlas:open
```

或指定可由其他裝置存取的 host/port：

```bash
bun --cwd=apps/architecture-atlas run dev -- --host 0.0.0.0 --port 4173
```

Production build / preview：

```bash
bun --cwd=apps/architecture-atlas run build
bun --cwd=apps/architecture-atlas run preview -- --port 4173
```

## 三種閱讀版本

### Version 01 — 系統地圖

以固定座標的 C4-style topology 顯示 ingress、surface/coordination、agent runtime、capability、state 與 satellite boundaries。可切換核心回覆、完整 runtime、工具鏈、持久化、獨立程序五種 lens；點節點會看到責任、輸入/輸出、保證、風險與 GitHub source line。手機預設以文字 catalog 開始，避免大型 graph 被縮成不可讀縮圖。

### Version 02 — 執行劇場

15 條以現行程式碼還原的 scenario：Discord/GitHub request、steer/follow-up/interrupt、Level 1/2 tools、workflow v2/v3、subagent、heartbeat、graceful restart、compaction、conversation memory、ACP、remote FS、config reload。每一步都包含 transport、event、payload、invariant、failure branch 與來源；播放只是閱讀游標，不宣稱是 telemetry。

### Version 03 — 契約與程式碼

把難以在一張圖中讀懂的細節拆成可查表面板：9 個 topic lane / 24 個 canonical events、7 個狀態機、workspace dependency matrix、15 個 persistence owner、12-step startup order、Compose deployment units/ports/volumes/healthchecks、四個核心 context 層加 heartbeat handoff、remote FS operation matrix、v1/v2 config diff、安全／可靠性限制與 current-vs-plan gaps。產品 workspace 統計不含這個文件用 app 本身。

## 證據與研究方法

- 程式碼 snapshot：`f31f4f4e11867575c8ae3d6d754cae428f0d9ede`（`DF-wu/lilac-mono`）。每個主要結論至少帶一個檔案與行號連結。
- Runtime 與 package 的結論以 `apps/*`、`packages/*` 現行實作、測試、`PROJECT.md`、`MIGRATIONS.md` 交叉核對；`plan/*` 只在 UI 中以 planned gap 顯示，不當成已實作。
- 視圖方法參考 C4 hierarchical/dynamic diagrams、arc42 building-block/runtime/deployment views、Structurizr dynamic views、Mermaid architecture group/service/edge、React Flow WCAG keyboard model 與 LikeC4 single-source-of-truth 思路。完整 URL 與採用理由在網站右上角 info drawer。
- ACP controller、remote-fs runner、FileSystem event callback、config watch 各自有獨立 protocol；網站刻意不把它們畫成 Redis events。

## 維護資料模型

主要資料在 `src/data/`：

- `system-map.ts`：stages、nodes、typed edges 與 lens。
- `scenarios.ts`、`scenarios-autonomy.ts`、`scenarios-memory-satellites.ts`：可播放 runtime stories。
- `contracts.ts`：topic/event contracts、state machines、package/data/security matrices。
- `research.ts`：外部研究來源與方法決策。

當 core 的事件或啟動順序變更時，先更新 source snapshot/行號，再更新上述資料；不要只改圖上的 label。新增「計畫中」能力時，使用 `planned-gap` 或 current-vs-plan table，避免把設計稿誤報成 runtime。

## 驗證

```bash
bun --cwd=apps/architecture-atlas run typecheck
bun --cwd=apps/architecture-atlas run build
```

Root-level validation 仍應依 repository `AGENTS.md` 執行 `bun run lint:fix`、`bun run fmt`、workspace typecheck 與測試。瀏覽器驗收至少檢查 1440px、900px 與 375px；圖形互動另有文字 catalog/table fallback。
