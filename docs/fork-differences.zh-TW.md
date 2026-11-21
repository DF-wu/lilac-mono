# Fork Differences

語言：[English（主要／規範版本）](./fork-differences.md) · [繁體中文（翻譯）](./fork-differences.zh-TW.md)

本文件比較 [DF-wu/lilac-mono](https://github.com/DF-wu/lilac-mono) 與 [stanley2058/lilac-mono](https://github.com/stanley2058/lilac-mono) 的工程與操作差異。以下分開記錄已進入 fork main 的基準、PR #120 的上游輸入，以及本工作樹已解決衝突的整合 candidate。英文版為規範版本；指定 commit 的原始碼、schema 與測試優先於文字摘要。Fork 差異是維護責任，不代表永久相容性承諾。

## 基準、比較方向與完整性

| 角色 | 完整 commit | 意義 |
| --- | --- | --- |
| 已合入的 fork 基準 F | [`4d8c0a8d799fcacd8aa51ca7613f48d7bb3f2327`](https://github.com/DF-wu/lilac-mono/commit/4d8c0a8d799fcacd8aa51ca7613f48d7bb3f2327) | Fork main，包含 PR #121；本文「現行 fork」的依據 |
| 待整合的 upstream／PR #120 目標 U | [`7613d519643005ee4574c085a534c74af9508f88`](https://github.com/stanley2058/lilac-mono/commit/7613d519643005ee4574c085a534c74af9508f88) | 上游輸入，**不是**已解決衝突的 fork candidate |
| 共同祖先 B | [`90d71dbe9a2a86d8b0a39513e9eb67d65eb93683`](https://github.com/stanley2058/lilac-mono/commit/90d71dbe9a2a86d8b0a39513e9eb67d65eb93683) | Fork PR #119 已納入的 upstream |
| 首次發布整合 C1 | [`3292b12b99992aa648b28aa2b00252098aeb4663`](https://github.com/DF-wu/lilac-mono/commit/3292b12b99992aa648b28aa2b00252098aeb4663) | 已提交且發布的 F／U 雙親 merge；首輪 hosted CI 六項全部通過 |
| PR #120 目前整合 candidate C | [清冊中的內容指紋](./fork-comparison-pr120/PATH-INVENTORY.md#pins-and-scope) | 本清冊所描述的目前整合樹，含下列 review 修正；提交前後皆可重建，不捏造 commit SHA |

「已合入」只指 F 的 Git 狀態，不代表實際部署。[PR #120](https://github.com/DF-wu/lilac-mono/pull/120) 已發布 C1，確實以 F 與 U 為雙親；[首輪 hosted CI](https://github.com/DF-wu/lilac-mono/actions/runs/44926179978) 六項全部通過。C 表示本文件與清冊描述的目前整合樹，包含 C1 之後的 review 修正。C1 的 CI 結果不能代表後續變更；須查核目前 PR head 的 hosted CI。C1 與 C 都不等於 fork main，也不表示已部署。

[完整路徑清冊](./fork-comparison-pr120/PATH-INVENTORY.md) 與 [JSON 證據](./fork-comparison-pr120/inventory.json) 逐一列出所有差異路徑、blob／mode、分類與 footprint 原因。清冊及重建程式使用英文，與英文規範文件共用同一份證據。

| 比較方向（左 → 右） | 路徑數 | 解讀 |
| --- | ---: | --- |
| B → F | 371：新增 160、修改 207、刪除 4 | 共同祖先之後實際存在的 fork 變更，含測試、文件及生成檔 |
| B → U | 147：新增 26、修改 121 | F 尚未完整納入的上游變更 |
| U → F | 494：新增 160、修改 304、刪除 30 | 兩端 tip 比較；**不等於** 494 項 fork 獨有功能，也不等於 fork 主動刪除 30 個檔案 |
| 聯集 | 494 | 347 個僅 fork 側變更、123 個僅上游輸入、24 個雙方皆修改的路徑 |
| F 的精確 footprint | 211 列，211 covered、0 unlisted、0 stale | 只包含共同祖先已存在、之後修改／刪除／變更類型的路徑；不涵蓋 fork 新增檔 |
| F → C | 161：新增 31、修改 130 | 採用上游、保留 fork 行為、必要修正及比較文件 |
| U → C | 388：新增 165、修改 219、刪除 4 | 相對固定上游輸入的實際 resolved fork 差異 |
| 全部聯集 | 503 | 包含所有基準與 candidate 差異，以及六份比較文件 |
| C 相對 U 的精確 footprint | 223 列，223 covered、0 unlisted、0 stale | 等同包含 U 的 merge commit 之正常 gate；checker 本身未改 |

U → F 的 30 個刪除中，**26 個其實是 F 尚未納入的上游新增檔**。B → F 真正刪除的只有 `packages/client-protocol/compat/previous-release/` 下四個歷史 fixture：`actionsPartSchema.schema.json`、`workflowRunSummarySchema.schema.json`、`workflows.get.schema.json`、`workflows.list.schema.json`。這是修正已驗證舊版 release 的實際 contract，並非移除現行 workflow API。

清冊另標出 **23 個生成／schema／bundle 路徑**。B、F、U、C 的 **7 個 gitlink** 及 `.gitmodules` 完全相同：以完整遞迴 Git tree 比對，submodule 差異為零，未初始化或讀取 submodule 內容。JSON 也保留一般檔案的 executable mode 與 blob ID。停用 rename 偵測，避免路徑因相似度配對而被隱藏。

原始試算 `git merge-tree --write-tree --name-only F U` 只有 `apps/core/tests/tools/web.test.ts` 一處文字衝突。C 保留雙方測試群組解開衝突，24 個重疊路徑已配合下列修正與檢查整合。含 conflict marker 的試算樹只作歷史證據。C 共 2,263 個路徑：2,248 個一般檔、7 個 executable、1 個 symlink、7 個 gitlink；mode 全數列入清冊。

## 狀態用語與證據

- **現行 fork 新增／修改／刪除**：由 B → F 及 F 的原始碼證明；同一檔案可以同時包含上游基礎與 fork 擴充。
- **Candidate 修正**：已在目前整合 C 實作，尚未進入 F；revision 狀態以清冊及目前 head 的檢查為準。
- **採用的上游功能**：存在於 U，已納入 C；F 尚無或行為不同，不應歸功為 fork 原創。
- **共用／已上游化**：已納入共同基準；即使最初由 fork 貢獻，也不再列為現行差異。
- **歷史／已退役**：只保留特定日期的證據，或已不在現行 production；不能只憑 commit 標題認定仍有該行為。

F01–F23 沿用 [11 月 11 日整合紀錄](./fork-integration-20261111/README.md) 的功能 ID。該目錄的「當時現況」與清冊是 **PR #101 的歷史證據**，不是本次基準；其 generator 會混用舊 pin 與執行當下 worktree，不能拿來重建本報告。N01–N11 是後續修正，U01–U04 是待納入／共用的上游工作，D 類別是文件及開發工具資料。新清冊為每個路徑指派具名分類；下文說明行為。列出的測試表示覆蓋位置；整合後實際執行結果與限制見 [VERIFICATION.md](./fork-comparison-pr120/VERIFICATION.md)。基準敘述仍只指 F，C 的改動另列於下方。

## Telegram：協定、准入、媒體與 workflow

U 提供 Discord、GitHub、native，以及共用 surface、request-delivery、resource、memory、workflow 基礎，沒有 Telegram implementation、grammY 或 `surface.telegram` 輸入。Fork 在相同上游 owner 上加入 Telegram，不另建執行引擎。

| 功能 | 現行 fork 行為及邊界 | Owner 與回歸證據 |
| --- | --- | --- |
| F01 生命週期／准入 | 預設不啟用，以 long polling 支援 DM、群組、supergroup、forum topic。先初始化歷史與 bot identity，再安裝 replay consumers，最後才在 consumers 與 paused runner 就緒後 polling。保留 durable ingress outbox、健康監督、shutdown、reload。空 chat allowlist 拒絕全部，user allowlist 再加一層准入條件。 | [Runtime](../apps/core/src/surface/telegram/telegram-surface-runtime.ts)、[adapter](../apps/core/src/surface/telegram/telegram-adapter.ts)、`telegram-runtime-lifecycle.test.ts`、`telegram-polling-supervision.test.ts`、`telegram-ingress-outbox.test.ts`；composition 接縫在 `runtime/create-core-runtime.ts` |
| F02 request routing | Mention／active routing、debounce、共用 LLM gate、`!model:`／`!continue`／`!interrupt`、steer／follow-up、request identity。Claim 阻止已被取代的 composition／publication 繼續，只由持有 request 的流程收尾。 | [Router](../apps/core/src/surface/telegram/telegram-request-router.ts)、composition／publish modules、`telegram-request-router.test.ts`、`bus-agent-runner-telegram-authority.test.ts` |
| F03 輸出與本機歷史 | 串流編輯、HTML／plain、4096 字元分段、typing、取消、reaction、edit／delete、topic reply ID、外送附件。取消時 `preview` 移除部分輸出，`inline` 保留。歷史只有 bot 實際觀察或送出的訊息，不是完整 Telegram 回填。 | [Output stream](../apps/core/src/surface/telegram/output/telegram-output-stream.ts)、chunker／HTML／delivery、`store/telegram-surface-store.ts`；fidelity、shrink、recording、attachment、adapter integration suites |
| F04 收入媒體 | Composition 以穩定 `file_id` 取得 photo／document，受限額管理後轉成 managed resource；canonical content 不持久化帶 token 的 URL。Request／reply-history 共用總額；超限或不可用改成 metadata，audio／voice／video 也只有 metadata。 | [Inbound media](../apps/core/src/surface/telegram/telegram-inbound-media.ts)、共用 attachment-resolver 接縫、`telegram-inbound-media.test.ts`、`telegram-attachment-resolution.test.ts`、fake Bot API end-to-end |
| F05 command menu | 穩定且唯一的 alias、Telegram 文法及長度、`@bot` 目標檢查；保留上游一般 custom-command parsing。Bot API menu 上限 100 項。 | [Alias 指派](../apps/core/src/custom-commands/menu-aliases.ts)、[menu 文法](../packages/utils/custom-commands-menu.ts)、manager；menu-alias 與 command-menu tests |
| F06 conversation memory | Telegram source 接上游各主題摘要／embedding／搜尋。每個 chat／topic 一個 source thread，entry 保留 subject offset、revision、generation；讀取、recall、非同步工作皆檢查 chat allowlist／撤權。此處附件投影僅 metadata。 | [Source](../apps/core/src/surface/telegram/telegram-conversation-source.ts)、`conversation/thread-store.ts`、service、search／summarization workers／protocols；[跨 surface 測試](../apps/core/tests/conversation/telegram-cross-surface.test.ts) |
| F07 workflow target | Send／edit／progress card／action／精確 `waitForReply` 共用上游 durable operation、wait、cancel、replay。投遞、編輯／重建、排程觸發均重新檢查 target；建立排程不會凍結授權。 | `apps/core/src/workflow/` domain／store／engine／waits／progress／scheduler、Telegram authorizer；durable-store、engine、waits、projector、scheduler suites |

`surface.telegram` 只在 **configVersion 2／3** 接受輸入；v1 輸入凍結，不能藉它啟用 Telegram。[Schema 預設值](../packages/utils/core-config/telegram-surface.ts)：

| 欄位 | 預設值與操作影響 |
| --- | --- |
| `enabled`、`token`、`botName`、`botUsername` | `false`、未設定、`lilac`、由 `getMe` 取得。啟用需要 token；token 存於受保護的 config，已移除的 `tokenEnv` 會被拒絕。 |
| `allowedChatIds`、`allowedUserIds` | Chat `[]` 拒絕全部；user `[]` 不額外限制使用者。Chat ID 為字串，群組 ID 可為負值。 |
| `dbPath`、`apiRoot` | `DATA_DIR/telegram-surface.db`、Telegram 官方 Bot API。Token／DB／API root 改動需 restart。 |
| `outputMode`、`parseMode`、`streamEditIntervalMs` | `preview`、`html`、1500 ms，範圍 500–60000；這是串流節流設定，不是測試同步等待。 |
| `outputNotification`、`commandMenu`、`workingIndicators` | `true`、`true`、複製的內建片語。 |
| `markdownTableRender.{enabled,style,maxWidth,fallbackMode}` | `true`、`unicode`、50、`list`；僅文字表格，可選 `ascii`，寬度 40–240。 |
| `inboundMedia.{enabled,maxBytesPerAttachment,maxBytesPerRequest}` | `true`、5 MiB、10 MiB；接受正整數 byte／友善單位。 |

F 的 `apps/core/package.json` 新增 `grammy: ^1.45.1`，反映於 `bun.lock`；清冊保留所有 dependency 路徑差異，不把每一行 lockfile 都算作 Telegram。測試使用本機 fake server；live-smoke scripts 與獨立 Docker helpers 的存在不證明本次有跑 live test。

起源為 `f7d71df2`（config）、`a6102605`（adapter）、`be56ab19`（runtime），之後包含 fork PR [#45](https://github.com/DF-wu/lilac-mono/pull/45)、[#75](https://github.com/DF-wu/lilac-mono/pull/75)、`6bb96840`（router）、`4d7d3057`（memory）。完整操作見 [Telegram 文件](./telegram-surface.md)，差距見 [Discord parity](./telegram-feature-parity.zh-TW.md)。尚無 webhook、inline query、business account 或轉錄；ask-user、session divider、`/model`、`/context`、reasoning 輸出、skipped-output cleanup 與部分 Level 2 操作仍限 Discord。Heartbeat 預設目的地只含 Discord／GitHub／native，本次不加入 Telegram。`/?ref=telegram:` 尚未支援；工具有私有 `t.me/c/` 連結指引，但 ID-only index 無法解析公開 username 連結。

**升級／回滾：**保留 Telegram DB 與配套 Core 狀態；改回純 upstream 後無法處理 Telegram 執行、target、設定。不能為解衝突而移除 allowlist／resource 檢查。衍生 memory index 可重建；bot 觀察到的歷史是原始資料，不能假設 Bot API 能補回。

## Native 記錄、搜尋與網頁修正

Native chat、永久 DM、裝置通知、歷史、權限與 web UI 都是共用上游基礎，以下擴充不代表整個 native 產品由 fork 提供。

| 功能 | U 上游 → F 現行 fork | Owner、測試及起源 |
| --- | --- | --- |
| F08 native-to-Discord 記錄 | 無 recorder → 選用的 post-commit observer，只記錄 **native 目的地實際可見**的人類／assistant 文字及 ready 附件。不含 reasoning、tools、questions、internal／service input、child／external stream 或歷史回填，也不讀 Discord／Telegram 歷史。投遞不阻塞 native 准入。 | [Recorder](../apps/core/src/surface/native/discord-mirror.ts)、webhook／attachment helpers、`store.ts`、`runtime.ts`、`discord-mirror.test.ts`；`e947ef43` |
| F08 分 thread 目的地 | 無 routing table → 預設 `flat`，可選每個 native 對話在一般 Discord text parent 建一個 public child。Native schema 8 的 `native_discord_threads` 在 HTTP create 前先 reserve；建立結果不明就阻擋並交由人工確認，不自動重建或退回 flat。 | [Routing](../apps/core/src/surface/native/discord-mirror-threads.ts)、`discord-mirror-threads.test.ts`、push／store tests；`ab3daf03`、`e80d3db2`、`2a381f1c` |
| N01 單對話搜尋（PR #121） | 先展開共用 message projection 再套 thread filter → 在 JSON 展開／window 排序前，以 index 限定指定 thread。保留權限、完整 thread ordinal、分頁、bounds；全域搜尋仍跨可見對話。 | [Search store](../apps/core/src/surface/native/store-search.ts)、[search tests](../apps/core/tests/surface/native/search.test.ts)；`c5104fa9`、`99e10428`、fork [#121](https://github.com/DF-wu/lilac-mono/pull/121) |
| N02 持久快取 recency | 時鐘時間可能相同 → transaction 內跨 instance 單調排序；safe integer 耗盡時 rebase，保留損壞列的其他資料及 draft。沿用 IndexedDB owner。 | [Cache](../apps/web/src/cache.ts)、`apps/web/tests/cache.test.ts`；`87127e42`、`9cd8074f`、`e9040d22`；U 也修改此檔，兩邊都要保留 |
| N03 composer selection | Activity 重建 editor 會失去 caret／selection → 重建後復原選取，沒有新增設定。 | [Editor](../apps/web/src/components/composer-editor.tsx)、`composer-editor.test.ts`；`a97fb2f1`；與 U 的附件／rewind 變更重疊 |
| N10 准入／署名 | Fork 額外保留撤權後 automatic-steer 的重新授權，以及 busy-send assistant 署名修正；採用 U 的 DM rewind／store 更新時不得遺失。 | Native `store.ts`、[execution regressions](../apps/core/src/surface/native/execution.test.ts)；`a060cb76` |

Recorder 只用環境變數：未設 `LILAC_NATIVE_DISCORD_WEBHOOK_URL` 即停用；`LILAC_NATIVE_DISCORD_ROUTING` 未設／`flat` 為預設，另可用 `threaded`。Compose 轉送兩者，installer 的 `secrets.env` 可直接提供，不新增 YAML 欄位或 UI。Threaded 重用 `surface.discord.tokenEnv` 選定的 bot token，不另設 token，也不要求開啟 gateway ingress；需相符的 webhook／parent 與 bot 權限。Compose 環境改動後需 recreate container，不在公開文件寫 secret 值。

Queue 與訊息對照均有記憶體上限；只有 child routing 持久化，沒有 durable message outbox、restart replay 或刪除保證。HTTP deadline 10 秒，在允許重試的操作中最多三次、等待 budget 30 秒；不盲目重試結果不明的 create。附件經 native 授權與 byte／integrity 驗證，不轉送私有 URL。詳細上限與 unresolved reservation 人工程序見 [native Discord 操作](./native-discord-mirror.md)。這些限額與下文 candidate 的 **web search** timeout 無關。

**升級／回滾：**Core 與 web 一起交付；storage migration 前備份 native SQLite，保留目的地 mapping，不可清空全部 unresolved row 強制重試。停用 recording 不會清除已送到 Discord 的副本。Cache／composer 無新設定；即使自動文字合併成功，仍須保留其原始碼與回歸測試。

## Hosted search、image script 與 provider execution

| 功能 | U 上游 | F 現行 fork | Owner、測試及起源 |
| --- | --- | --- | --- |
| F09 OpenAI hosted search | Tavily／Exa／Firecrawl chain，無 `openai` adapter | Chain 加入 `openai`。獨立 Responses mediator 強制呼叫 hosted `web_search`；回傳 citation 優先，再加去重的 retrieved sources。Snippet 標成模型摘要，不冒充網頁摘錄。 | [Provider](../apps/core/src/tool-server/tools/web-search/openai-web-search-provider.ts)、[endpoint resolver](../apps/core/src/tool-server/tools/web-search/openai-web-search-model.ts)、`web-search-openai.test.ts`、`web-search-openai-model.test.ts`、`web.test.ts`；`74acb7a1`、`737742e8` |
| F10 compatible image script | 上游 `generate.image({code})` runner 及 recipes | 有 compatible base URL 才加入 `providers.openaiCompatible`；提供 model list／generate／edit、具名 multipart、URL／base64 recipe，不復原結構化 routing。 | [Descriptor](../apps/core/src/tool-server/tools/image-script-openai-compatible.ts)、上游 `image-script.ts`、[recipe](../packages/utils/builtin-skills/image-generation/references/openai-compatible.md)、image-script／generation suites；`18204aaf` |
| F11 external custom-media | 共用 trusted Level 2 plugin，無此 example | Image generation／edit、video submit／poll／download／cancel、typed failure、output cleanup。是另一個外部 plugin contract，上游 image script 不能取代它。 | [Example／config](../examples/plugins/custom-media/README.md)、`src/`、`custom-media.test.ts`、`bundle-parity.test.ts`、已提交 `dist/index.js`；`ebddc6ec`、`8a02cddf`、fork [#30](https://github.com/DF-wu/lilac-mono/pull/30) |
| F12 compatible tool call | 共用 AI SDK 執行政策 | 已解析的 local tool calls 即使 finish reason 為 `other` 等非標準、非 length 值，仍經正常驗證及持久化執行。Length 截斷、provider 已執行的呼叫不會變成任意 local invocation。 | `packages/agent/adapters/ai-sdk/adapter.ts`、`ai-sdk-pi-agent.test.ts`；`1c58e532`、`36fff08a` |
| F13 compatible tool image | 一般 Chat Completions 投影 | 將 tool-result image 放在**全部平行 tool results 後**的具標籤 user image 訊息；保留文字及 canonical history。僅 `openai-compatible` Chat path 使用，官方 Responses 仍由上游負責。 | [Middleware](../packages/utils/openai-compatible-tool-images.ts)、`model-provider.ts`、`openai-compatible-tool-images.test.ts`；`579b17d7`、`ac899a8f` |
| F14 active-input compaction | 共用 canonical compaction／recovery | Soft threshold 前驗證指定 boundary，只摘要合格舊 prefix，當次 multipart／tool suffix 原樣保留；無舊 prefix 就跳過 soft compaction。無 boundary 的 caller 保留上游行為。 | [Compaction](../packages/agent/auto-compaction.ts)、runner lineage callback、`auto-compaction.test.ts`、`bus-agent-runner-lineage.test.ts`；`cf1897c9`、fork [#82](https://github.com/DF-wu/lilac-mono/pull/82) |

### 搜尋設定與 candidate timeout

`tools.web.extract.providers` 預設 `[tavily]`。選 `openai` 需 config v2／v3，v1 enum 凍結。V2 仍接受舊單數 `extract.provider`／`search.provider`，v3 需複數 `extract.providers`。[Fork schema](../packages/utils/core-config/openai-web-search.ts) 與 editor schema 使用同版本輸入；證據在 `core-config.web-search-provider.test.ts`、`core-config.fork-v3.test.ts`、versioning、Core schema tests。

`tools.web.openai.model` 預設 `openai/gpt-5-mini`，`searchContextSize` 預設 `medium`，可選 `low`／`medium`／`high`。Model spec **只**接受 `openai`／`openai-compatible`；舊 bare ID 視為 `openai`。前者用 `OPENAI_API_KEY`／`OPENAI_BASE_URL`，後者用 `OPENAI_COMPATIBLE_API_KEY`／`OPENAI_COMPATIBLE_BASE_URL`。Compatible search 需 base URL、key，且 endpoint 實作 Responses hosted `web_search`；只有 Chat Completions 的 gateway 不足。不支援的 provider 保持 unavailable，不暗換路由。Mediator 不收到對話 model／history；日期與 topic 僅為模型指示，`searchDepth` 忽略。`web.extract` 跳過 search-only 的 `openai`，要抽頁面須保留其他 provider。

| 狀態 | 每次 attempt／retry／cancel |
| --- | --- |
| 已合入 F | 有 hosted search 與既有依序 fallback，**尚無** U 新增的 per-attempt timeout／同 provider retry wrapper；不得寫成已具新政策。 |
| 待納入 U（`2d392956e2d90472c983ec23956c1146341a7775`） | 支援的 provider 每次 10 秒；retryable failure 同 provider 重試一次，再依條件 fallback；caller cancellation 提早終止。U 內建 provider 沒有 OpenAI adapter。 |
| **已解衝突的 C** | Hosted `openai` search **每次 30 秒**，包含 `openai-compatible` model route。Firecrawl／Exa／Tavily **每次 10 秒**。Retryable failure 同 provider 重試一次，再依設定 fallback；caller cancel 停止 retry／fallback。不新增 YAML 選項。 |

一次 retry 是第二次 attempt，不是整體 30 秒；兩次 hosted deadline 都耗盡，fallback 前約可用掉 60 秒，另加 queue／provider overhead。測試涵蓋兩種 model route 在 20 秒成功、獨立 30／10 秒 deadline、精確 timeout 訊息、retry／fallback，以及第 5 秒取消。雙方 HTTP-status 測試均保留：409／425／429／503 與非 JSON 500 可 retry；400 不 retry／fallback。`web.extract` 獨立處理並跳過 OpenAI。[搜尋詳細文件](./web-search-openai.md) 已描述整合後政策。

**Exa transport 限制：**已安裝的 `exa-js@2.11.0` 在 `search`、`request`、`rawRequest` 都沒有 signal 參數。既有 abort wrapper 可限制 tool 等待，caller cancel 後不再 retry／fallback，但不能中止 SDK 底層 request，重試時舊 request 可能仍在進行。未加入 dependency patch、替換 transport 或傳入不支援欄位。這是唯一延後處理、非阻擋性的 review finding；本機 fixture 不證明 live-provider transport 行為。

### Image 與 model 相容性

Image descriptor 只需 `OPENAI_COMPATIBLE_BASE_URL`，key 可省略；這點不同於 search。只有 key 不足以設定 image provider。Script 在新 Bun process 執行 trusted container code，拒絕 restricted caller、遮蔽已設定 key 的輸出，不自動 fallback。Provider／model ID 寫在 script／recipe；舊 `tools.generate.image` provider／routes／models 已退役。殘留 `tools.generate` 會被忽略並記 unknown-key warning，應移除。[Image migration](./generate-image-openai-compatible.md) 列出完整舊新 input／result 差異。

Custom-media 在 workspace discovery 外，有自己的 lock／package／config／build 與已提交 bundle。根目錄 `test:custom-media` 檢查 source／bundle 與 typecheck；repo 沒有安裝紀錄不代表外部無人使用。Tool-image shim 需要 vision endpoint，不能讓純文字 model 支援圖片。Active-input 保護也不能讓超大 request 自動塞入 context；真正 overflow 仍走 recovery／failure。這些機制都不是惡意程式 sandbox。

**升級／回滾：**保留 provider 專屬 credential 與已驗證 model route，不把 operator 設定複製到 repo。純 upstream 沒有 hosted search／`openaiCompatible` image script，舊設定如何拒絕或忽略取決於該版本 parser，不能保證任意 gateway 相容。改 example 應 rebuild 並驗證 source／bundle。採用下文上游 history／tool-search replay 時，保留 F12–F14。

## 授權、投遞與生命週期修正

| 功能 | U 上游 → F 現行 fork | Owner、測試及起源 |
| --- | --- | --- |
| F15 authenticated origin | 共用 capability／principal 驗證 → 保留 optional `originSessionId`／`requestInitiator` plugin context、Bash 的 `LILAC_ORIGIN_SESSION_ID`、bridge 的 `x-lilac-origin-session-id`。Surface 預設與 restricted 明確 target 依**已驗證 initiator**決定，synthetic workflow session 不取代 origin。Native raw／prefixed alias 正規化；跨 client 仍拒絕，單有 header 不授權。 | [Tool server](../apps/core/src/tool-server/create-tool-server.ts)、request-control authority、`tools/surface.ts`、Bash、bridge client、`packages/plugin-runtime/types.ts`；create-tool-server／surface／Bash／subagent／bridge suites；`8a02cddf`、PR #101 follow-up |
| F17 typed startup | 上游 create／start Result → `start-core-runtime.ts` 小型 adapter 保留 returned failure 及 throw／Panic 原 cause 給 main logging，不自動做 blob migration。 | [Helper](../apps/core/src/runtime/start-core-runtime.ts)、`start-core-runtime.test.ts`；PR #101 證據 |
| F18 Redis cleanup | 上游 lease／subscription lifecycle → 並行清理 single-flight、記住成功 stop／group work，失敗可 retry；保留 incarnation、maintenance、Panic 優先順序。 | `packages/event-bus/redis-streams-bus.ts`、其 test；`d4fc77b9` |
| F19 GitHub final publication | 共用 webhook／准入／reply → issue／review prompt 說明 Lilac 會發 final；直接發出 final 或成功手動 review 後回 `NO_REPLY`，避免正常自動再發一次。這是 prompt 政策，不是交易式去重。 | Webhook server、`github-webhook-dispatch.test.ts`；`1f8d7679`、fork [#56](https://github.com/DF-wu/lilac-mono/pull/56) |
| N04 GitHub／取消投遞 | Fork 派生 wire-valid UUID、正規化舊 persisted cancellation key。Prompt 已發出後仍保留未完成 review-interrupt retry，contract-error logging 遮蔽內容。無新設定。 | Webhook／GitHub state、workflow engine／store；durable delivery／workflow tests；`c1fc7ff2`、`3a5a2d1c`、`a97fb2f1` |
| N05 subagent convergence | 重用 transactional invocation receipt／run handle、跨 retry 穩定 keyed child identity、由 durable delivery 派生 missed-steer identity，process 內序列化 keyed live／ended decision。Durable replay 仍由既有 receipt 負責，記憶體 lock 不是新 durable queue。 | [Orchestration](../apps/core/src/tools/orchestrate.ts)、dispatcher／follow-up；orchestrate／convergence tests、hard-exit fixture；`a97fb2f1`、`28725017` |
| N06 previous-release 證據 | Generator 先完成歷史 schema export 再替換 fixture；驗證 predecessor ancestry，排除該 release 沒有的 endpoint。U 的現行 protocol 與 frozen predecessor 是不同 contract。 | `generate-client-protocol-compat.ts`、歷史 JSON、client-compat helper、previous-release／harness／wire-compat tests；`a97fb2f1` |

這些補丁維持上游 durable admission、resource authority、workflow persistence、canonical transcript owner。Compatibility header 不代表另一套授權系統；即使找不到直接 consumer，公開 plugin optional 欄位仍需遵守相容邊界。跨 persisted workflow／native／transcript 版本回滾，要配套 restore，不能只刪 TypeScript 欄位。

## Filesystem、SSH、preview 與驗證基礎

PR #119 已採用上游 **Rust** SSH runner，支援的遠端主機不再需要 JavaScript runtime 或 registry。Stdin EOF cancellation、共用 filesystem／tool contract、run-scoped native preview 都是上游行為。以下是 fork 對其 owner 的修正，沒有新 operator option：

| 功能 | 相對 U 的差異與影響 | Owner／測試 |
| --- | --- | --- |
| N07 SSH 有界終止 | ControlMaster 持有 pipe 時仍有 bounded output drain；處理 cancelled dispatch、async stdin failure、存活 process-group helpers，保留精確 Panic identity。 | `ssh/ssh-exec.ts`、ssh-exec／ssh-job-lifecycle／transport tests；`a934a89b`、`9b4761f3`、`7532e572` |
| N07 filesystem parity | 缺 optional metadata 時仍保留 glob path；明確傳 detail mode。Dotfile、否定字元 class／range／brace、literal-root exclusion 對齊 local／remote。Parent-relative patch／file resolution 使用 physical remote cwd。Prefix bounded read 可看到 metadata 後檔案增長；whole-file limit 在讀取時仍執行。 | `remote-filesystem-host.ts`、remote-fs／remote-apply-patch、`packages/fs/src/`、Rust `glob.rs`／`fsops.rs`；remote parity／glob-match／read-byte-prefix tests |
| N07 Rust build | 固定 Cargo target output／copy 位置，macOS linker input 留在 persistent cache，避免複製錯路徑或 cache key 漂移。清冊未隱藏已提交 runner binary 差異。 | `scripts/build-remote-runner.ts`、`__tests__/build-remote-runner.test.ts`；`9b4761f3` |
| N09 preview containment | 同一 opened handle 完成 containment 與 bounded read；visualize helper 解碼 asset URL、拒絕不支援的 document base。Run-scoped 單檔 capture／預先內嵌 asset 仍是上游行為。 | Native `resources-live.ts`／test、visualize build script／test；PR #119 |
| N11 failure settlement | Discord read-control 捕捉 config failure、保留 Panic identity；Bash spill defer Panic 後停止繼續 read。唯讀 Discord thread control 本身是共用功能。 | `discord-thread-control.ts`／test、`bash-output-sanitizer.ts`／test；PR #119 |
| N08 harness／N06 fixture | FIFO path 引號（含空白）、觀察 crash／drain／readiness、保留 cleanup error、continuation fixture 不被 mutation、真實 binary image materialization、歷史 endpoint 驗證、獨立 client 觀察 recovery。其他測試隔離 operator skills、用 ephemeral listener、區分 stdin EBADF／EOF、依實際完成同步。 | `apps/core/tests/e2e/`、operator／skills／SSH／Bash／Redis-load／heartbeat-real-bus suites；PR #113／#119 的逐路徑清冊 |

這些是工程差異，不是新產品。[DEVELOPMENT.md](../DEVELOPMENT.md#remote-runner) 說明 build，[MIGRATIONS.md](../MIGRATIONS.md#native-ssh-remote-runner) 說明 runner upgrade。下文 U 的 test temp-root 修正另列，C 已另行採用，candidate 的回歸修正與整合驗證另列於下方。

## 設定、dependency、CI 與 release

| 範圍 | U 上游 → F 現行 fork | 設定、owner、證據 |
| --- | --- | --- |
| F20 image identity | Source build 仍可用 upstream default；fork 發布 `catalina`／`claudia`、UID／GID 3000、各自 home、Catalina compatibility link、`rsync`、runtime `bunx`、`/app` cwd。Installer private bind mount 依實際 image account 準備，不假設固定 UID。 | `CONTAINER_USER`／`CONTAINER_UID` build args、[Dockerfile](../Dockerfile)、Compose、entrypoint／verifier、installer data-files；identity／build／installer tests；`d623de31`、`6e20251c`、`9b857397`、`f492e823` |
| F21 exact-SHA delivery | Build 發 variant／SHA tags，Catalina 擁有 `latest`，跨 invocation 序列化。Scheduled release 保留 versioned artifact／digest、驗證 exact SHA，但不讓 default-account image 覆蓋 fork Core `latest`。 | [Build workflow](../.github/workflows/build-image.yml)、release／CI、fork-delivery／release-gate tests；`58f2eefa`、[歷史 delivery 證據](./fork-integration-20261111/delivery.md) |
| F21 upstream sync | Fork-only，每六小時或手動執行。Pin baseline／upstream／candidate，full reusable CI、strict footprint，確認 main 未動後才 fast-forward 並發布同 SHA。衝突交人工 review PR，唯讀分析不修程式；非 conflict 的 CI 失敗保留 candidate 並停止。 | [Sync workflow](../.github/workflows/sync-upstream.yml)、[操作／token 政策](./upstream-sync.md)、workflow shell fixtures／delivery tests；`ef92844f` 等 |
| F21 review config | `.coderabbit.yaml` 選工程英文、自動 review／approval decision、各路徑 correctness／security 規則，排除 `ref/**`、停用 chat auto-reply。設定存在不證明遠端服務已批准或有特定 entitlement。 | `.coderabbit.yaml`；`1fea251b`、`5c658138` |
| F22 governance | 精確註冊 fork surface／codec／exception／Result 邊界及 footprint。Root lint／fmt／typecheck 包含 `scripts/fork`，gate 加入 custom-media；PR #119 修正 wrapped named continuation 分析、initialized `var`／getter false positive。 | [Footprint tool](../scripts/fork/check-upstream-footprint.ts)、[policy](../scripts/fork/upstream-footprint.txt)、architecture／oxlint-plugins／run-gates／root package；architecture／syntax／footprint tests |
| F23 schema／生成檔 | V1 凍結，v2／v3 組合 Telegram／OpenAI，default 各自獨立，alias 按版本。Editor JSON／web activity fixture 反映定義，不保證所有 config version 互通。 | `packages/utils/core-config/`、Core schema／activity generators、`apps/web/src/generated/tool-activities.ts`；runtime／editor／versioning／V3／default tests |
| D01–D05 文件／工具資料 | Fork 英文 canonical README／docs、繁中翻譯導覽、feature 文件、dated integration／research／plan、Star History、local-tool ignore／project metadata。與 runtime 分開歸類。 | `README*`、`docs/`、`.gitignore`、`.oxfmtrc.json`、`.serena/`；完整清冊。歷史文件保留原 pin 與測試限制。 |

F 的 root package manager 是 **Bun 1.4.4**。B 之後未修改的 dependency／patch declaration 屬 inherited；清冊涵蓋有差異的 root／Core／example manifest／lock，不把上游 AI SDK／storage／runner dependency 歸功於 fork。生成證據包含 editor schema、web activity、previous-release JSON、custom-media bundle；須依 owner generator／contract 檢查，不手改生成檔掩蓋失敗。

Footprint tool 比較 `git merge-base <upstream> HEAD` 與 **tracked working tree** 的 `--diff-filter=MDT --no-renames`，不管 untracked 與 fork 新增檔；`--strict` 另拒絕 stale row。因此通過不代表完整差異已盤點、合併乾淨或 runtime 已測試。清冊保留 B／F／U，並新增 C 的全部 path／status／mode 及 精確 policy rows。既有 checker 及原始測試未改。原始未提交 merge 的 HEAD 為 F，merge base 為 B；已提交的 C1 與其後續 revision 都包含 U，正常 CLI 現在可精確比較固定 U；candidate helper 另將 `git diff --name-only --diff-filter=MDT --no-renames U` 集合對照 C 的 policy。Merge commit 包含 U 後，對 U 的正常 CLI 才以 U 為 merge base。之後 upstream 前進時，merge-base 政策刻意排除 fork 尚未納入的上游變更，直接比較 tip 反而會誤判。Hosted CI 仍須依實際 fetched refs 重跑。

**操作：**Host mount 必須允許所選 image 的 numeric identity；不要依 source default 猜 production 帳號或權限。[Docker 文件](./docker-deployment.md)、[installer](./installation.md)、[sync 政策](./upstream-sync.md) 負責命令。`main` 為唯一長期分支，一般 feature／fix／docs 使用短期 PR；乾淨 sync candidate 為 `chore/sync-upstream-*`，conflict review 為 `automation/sync-upstream`。以 merge 保留 upstream history；先確認相等 contract，再移除重複 fork patch。

## 已採用的上游與既有共用功能

下列仍屬上游功能，與 fork 原創差異分開記錄。C 採用 B → U 的 **19 個非 merge commit**；清冊列出全部 source／test／UI／schema 路徑，包括 U → F 看似刪除、其實 F 尚未納入的新增檔。

| 上游功能 | 行為／相容性重點 | U 的 commit 證據 |
| --- | --- | --- |
| U01 DM rewind | 最近 native DM turn 可 rewind，含 backend policy、disabled-reason UI、附件／draft 還原。Protocol／Core／web 需一起納入，F 尚無此功能。 | `614a5fd6a18d2b8a1ae223c121250f89fba3cfcd`、`318dc32416eefcd8f9b5d7a225775f729930cff0`、`dd18abaa6e3d4d820865642a77a35ce6326b13ad`；U store-dm-rewind、client-protocol rewind、web hook／dialog／tests |
| U02 Anthropic search／replay | 支援路由用原生 deferred loading；tool reference 不混不相容 content。Normalize stored metadata、依 provider allowlist 投影 history、隔離跨 provider replay、invalid thinking 時保留 text recovery。保留 fork tool execution／images／compaction。 | `78efb707113ff8cc15aecce362ed23b54e63d46e`、`e292e1d2d676675a406e2449655720550adb77be`、`1d0f4029e0b3f254786d5f3b7e38656375110f48`、`7f91607fc90daaa37ce175d9abfadc896079ae4a`、`e2f987d0e076ec34115fb9f4a84aa606ee469a3d`；U provider-history／tool-search contract／production-fixture suites |
| U02 prompt caching | 僅第一方 Anthropic endpoint、無 explicit override／cache-marker 衝突時自動預設。保留 `anthropic_prompt_cache` true／false override 與 durable false，任意 gateway 不自動套用。 | `0a18f1ec86a91722156b494f17abf4b66e4bfd76`；U provider-options／model-slot tests |
| U02 Codex prompt | 移除 `codex_instructions`，改用 `basePrompt`／prompt files；移除 hard-coded base instructions，Codex 也走共用 base-prompt。V3 明確拒絕已移除欄位，不宣稱舊 config 全可沿用。 | `29b8e6c9b5a19feb7d8d303469badfc008a3cf7d`；U v3 schema／model-slot／prompt tests／migration docs |
| U03 heartbeat／U04 UI | 隔離 heartbeat context；nested subagent identity／panel tabs、檔案 reveal／download、favicon、reply-start gap、DM demo、Markdown contrast。這些屬 upstream，不是 fork 新產品；fork cache／composer／online-auth reload 修正仍要保留。 | `9826893b65bd8d143d35e3f27c59129c70e5d779`、`2556b377c3e52dcd211bd77ec222b69010d09bbb`、`15a567fdfff7288caec289ea79edcfc32e58d914`、`ebead8bee93925e21641b88776422e1c73b2b2f2`、`109a8c0add12298de69798b1cfb6a31ec72f7150`、`a769c8de182c6e55c32d1ad1d7cdde61d3d7e5b8`、`7613d519643005ee4574c085a534c74af9508f88` |
| Search bounds／temp roots | 前述 per-attempt deadline／retry；隔離測試 root 避免超出 POSIX Unix-socket 路徑上限。C 保留此行為，hosted-search 例外及回歸修正另列。 | `2d392956e2d90472c983ec23956c1146341a7775`、`e7af49eff6f61c913d2f55b866b7f6a2d0b58941` |

B 已含上游 Core execution／recovery、Discord／GitHub／native、resource／blob／S3、permissions／Bash／filesystem guardrail、plugins／MCP、durable workflows／subagents、heartbeat／questions、native DM window／notification、Rust runner、run-scoped preview。Exa 設定、`TAVILY_API_BASE_URL`、GitHub marker／self-trigger 防護、host-aware reply permalink 都已共用，不列 fork-only。既有紀錄分別對應 upstream PR #1、#4／#5、#13、#35；[permalink 文件](./github-reply-permalinks.md) 保留 contract。這是歷史證據，不是重新查核 GitHub 最新狀態。

已退役項目包括 Architecture Atlas、fork Discord working-indicator defaults、empty-reply flag、smart-search container experiment、舊 idle-watchdog／timer-injection patch、結構化 image routing，不從舊 branch／plan 復活。F16 的自動 startup blob migration／backup 也已移除：現行 Core 要求受支援 managed-blob schema；舊 transcript 5／workflow 25 需先經 `f2c90667ac5616796c992602ca5fb5be726cf40d` 的離線工具。[離線支援與 restore](./fork-integration-20261111/migration.md) 定義操作。F16 是歷史支援邊界，不是新增的現行 migration subsystem。

## Candidate 各區域修正

以下是 C 才有的修正或雙方組合，不代表 F 已發布。[完整路徑清冊](./fork-comparison-pr120/PATH-INVENTORY.md#every-changed-path) 保留每個 path 的分類與 object。

| 區域 | 保留／採用行為及精確修正 | 原始碼與回歸證據 |
| --- | --- | --- |
| Search 政策與衝突 | 保留 OpenAI model route、status-based retry、search-only；採用 U 的一次 retry／deadline／cancel wrapper。OpenAI 每次 30 秒，其餘內建 provider 10 秒，雙方測試群組皆保留。 | [web.ts](../apps/core/src/tool-server/tools/web.ts)、[web.test.ts](../apps/core/tests/tools/web.test.ts)、四組 provider suite；[搜尋文件](./web-search-openai.md)。 |
| Rewind 附件 undo／retry | Silent replacement 與送出清空前記住 reference-only attachment record，使 rewind Undo 與送出後 Undo 都仍可送出。無 reference 的 retained file 建立 controller／reservation command，並保留來源 question-draft key 到 ready callback。 | [composer-editor](../apps/web/src/components/composer-editor.tsx)、[uploads](../apps/web/src/uploads.ts)、[Chat](../apps/web/src/components/Chat.tsx)、[upload tests](../apps/web/tests/uploads.test.ts)、[真實 component fixture](../apps/web/tests/support/rewind-regressions.js)。 |
| Draft 持久化與順序 | Local／reply 清單保留純附件 draft；儲存 reference 依 composer key 排序，而非 upload 完成順序。兩個既有 hydration path 均可還原順序；不改 stored schema。保留 F 的 monotonic cache recency。 | [cache](../apps/web/src/cache.ts)、[cache tests](../apps/web/tests/cache.test.ts)、既有 App／queries reload。 |
| Pending paste／navigation | Rewind 換 draft 時取消尚未完成的 message-paste download；離開再返回時，running rewind 仍鎖住 composer。停止且等待 retry 的 attempt 可編輯。 | [Composer](../apps/web/src/components/Composer.tsx)、[Chat](../apps/web/src/components/Chat.tsx)；真實 DM paste／navigation 驗證。 |
| History availability／缺檔 | History page 失敗且 cursor 未變時重試一次；effect cleanup 後不重試。兩次都失敗後仍有界，使用既有 Load more／reconnect／navigation。未完成且 local file 不在的附件還原為 reattachment marker，文件同步澄清。 | [use-dm-rewind](../apps/web/src/use-dm-rewind.ts)、[browser fixture](../apps/web/tests/support/rewind-regressions.js)、[native 操作](./native-surface.md#permanent-direct-conversation)。 |
| Crash recovery／jobs | 從既有 command receipt 與保留的 canceled full-input 記錄還原被丟棄的 request ID，只停止這些 request 擁有的 active service jobs，並抑制其所有 pending 事件，包含已完成的 await output；時間重疊也不影響保留 turn 的 jobs。既有記憶體 job record 保留實際觀察到的終結結果，直到 compare-and-transition finish 寫入成功；cleanup 重試不會再次 signal 已結束的 process。List／finish／suppression 失敗會保留 mutationPending，重試時重選仍 pending 的事件。舊資料缺少或無法明確證明 ownership 時保留 pending，不退回時間推測；無新 persisted field、journal 或 recovery subsystem。 | [store](../apps/core/src/surface/native/store.ts)、[execution](../apps/core/src/surface/native/execution.ts)、[execution tests](../apps/core/src/surface/native/execution.test.ts)、[job ownership／suppression tests](../apps/core/tests/jobs/job-service.test.ts)。 |
| 重疊取消失敗 | Queued delivery 終結失敗時仍取消並等待 active runner drain；最後一個重疊 cancellation 完成 drain 後才釋放 input，回傳原錯誤，失敗的 durable delivery 仍可 recovery。 | [Native execution](../apps/core/src/surface/native/execution.ts)、[runner queue tests](../apps/core/tests/surface/bridge/bus-agent-runner-session-queue.test.ts)。 |
| Thinking repair／replay | 刪除尾端 tool result 後若只剩 assistant text，補入既有 user continuation。相鄰 Discord attribution line 一次移除且重跑不變。保留 Telegram metadata、fork compaction boundary，以及 U 的 provider-history／tool-search projection。 | [runner](../apps/core/src/surface/bridge/bus-agent-runner.ts)、[normalization](../apps/core/src/surface/bridge/request-composition/normalization.ts)、[thinking tests](../apps/core/tests/agent/anthropic-thinking-recovery.test.ts)、[runner tests](../apps/core/tests/surface/bridge/bus-agent-runner.test.ts)。 |
| 回歸測試品質 | Lifecycle 結束後才 assert repaired checkpoint，避免預期 provider failure 吞掉 assertion；新 signature 與舊 thinking 隔離。Upload expiry 使用固定時鐘。僅 dependency-streak fixture 停用 ambient main-isolate alarm，專門 memory-limit tests 保留。 | 上列 runner／upload tests；[health fixture](../apps/core/tests/tool-server-health-state.test.ts)。 |
| Contract／生成檔組合 | 保留 Telegram／OpenAI v2/v3 config、compatible image／tool middleware、非標準 finish-reason 執行、#121 scope、Activity caret、native recorder、歷史 protocol fixture。採用 U 的 caching／Codex／heartbeat／history；schema 與 architecture registration 通過既有 check。 | [PROJECT](../PROJECT.md)、[MIGRATIONS](../MIGRATIONS.md)、[config migration](./core-config-migrations.md)、清冊逐路徑證據。 |

Allowlist 保留每項差異原因，C 不含 gate implementation 變更。文件準備 clone 的 baseline-only 清冊及工具缺失不能當成 candidate 測試結果。

## 升級、回滾與最終更新

改 binary／config version 前讀 [MIGRATIONS.md](../MIGRATIONS.md) 與 [config upgrade](./core-config-migrations.md)。一致備份 DB、managed blobs、所需 state；drain／停止 producer，必要時先在拋棄式副本演練歷史 offline cutover，Core／web 配套交付。舊 binary 不能讀新 schema 時，要還原相符舊 binary **及配套備份**；切 Git branch 不會逆轉 native／workflow／transcript migration。Recorder child routing／Telegram observed history 與可重建的 cache／memory index 不同。

Bash／filesystem 檢查、trusted plugin／MCP stdio、programmatic workflow、container 同 UID 存取是 guardrail／trusted execution，不是惡意程式 sandbox。本文不授權部署，也不證明 gateway 相容或 live data 狀態；未讀寫 operator model／alias／preset／permission／credential／private runtime data。

C1 當時的 focused 回歸已通過：search／providers **88 tests**、native execution **71 tests**、thinking repair／normalization **15 tests**、upload／cache **56 tests**。Web suite **820 tests** 通過，所有 workspace typecheck 與 architecture check 也通過。這些 source-level 結果與最終 combined root gate 分別記錄。

C1 整合檢查使用 Bun 1.4.5（manifest 指定 1.4.4）及已安裝的 Rust 1.94.1。合併後 tree 的實際結果與精確數量見 [VERIFICATION.md](./fork-comparison-pr120/VERIFICATION.md)。本機通過不代表 hosted CI、image build、live-provider 或部署通過。

編輯 follow-up 時可重建目前 worktree，不建立 commit，也不改實際 index：

```sh
python3 docs/fork-comparison-pr120/reproduce.py --candidate-worktree
python3 docs/fork-comparison-pr120/reproduce.py --candidate-worktree --check
git diff --name-only --diff-filter=MDT --no-renames 7613d519643005ee4574c085a534c74af9508f88
git diff --check
git diff --cached --check
```

Helper 驗證 F／U ancestry（原始 merge 則驗證 HEAD／MERGE_HEAD），以 temporary `GIT_INDEX_FILE` snapshot，獨立核對每個 path／status、223 列精確 policy，逐 byte 重建 Markdown／JSON。不初始化 submodule、不建立 commit。三份 evidence file 的 path／mode 仍列入，但省略自身內容 hash 以避免自我參照；其餘內容（含 helper 與兩語 guide）均納入指紋。這是供審查的內容識別，不是完整 Git tree 的 release attestation。

乾淨且已提交的 checkout 請執行 `python3 docs/fork-comparison-pr120/reproduce.py --candidate HEAD --check`；它要求 F、U 同為祖先，不需捏造未發布 commit 連結。之後對 fetched upstream ref 執行未改的 `bun run fork:footprint -- --upstream=<fetched-upstream-ref> --strict`，並對同一 commit 完成 hosted CI／image checks。Source、policy 或非 evidence 文件改動都需刷新清冊；verification prose 雖排除 hash，仍須審查。

先前已發布的 follow-up `e2750297a144344ab67c490ef5bf9a417decba39` 通過六個 Core suite 共 **315 tests／1,389 assertions** 與 workspace typechecks。其後兩項 job-cleanup 修正通過 **117 focused tests／450 assertions**。完整最終 gate、八則 inline／三則 outside-diff／一則 unverified finding，以及 review 6007059282 的 await-event／completion-write 修正與限制，見 [verification](./fork-comparison-pr120/VERIFICATION.md)。C1 的 hosted CI 結果不代表後續 revision。
