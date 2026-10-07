# Upstream 同步 agent 的 prompt engineering 研究

研究日期：2026-10-07。研究對象為 `anthropics/claude-code-action@v1.0.243`，
使用自訂 Anthropic-compatible gateway 的 `deepseek-v4.1-flash` 與 `--effort max`。
以下依 live web search 找到來源後實際讀取的第一方文件整理；搜尋摘要只用於發現來源。
線上 Claude／DeepSeek 文件會更新，並非固定 CLI 版本或私有 gateway 的相容性快照。
資料蒐集階段沒有執行模型、讀取 credentials 或推送遠端；下文的落地方式已依使用者
最新要求更新。Workflow／gateway 的實作驗證另見 [同步設定文件](../upstream-sync.md)。

## 結論

建議把 prompt 寫成有明確成果、權限邊界與驗證條件的工程任務：固定同步參照，先理解
兩邊的行為與歷史，提出 reviewer 建議與所需驗證，留下可審核證據。**目前 AI 僅分析
衝突，不修改程式、不解衝突、不執行測試。** 不要只要求
「保留 fork 功能」，也不要用大量重複的強調詞或要求公開內部推理代替這些
具體條件。Anthropic 的官方指引支持清楚指示、分段、適量 context、工具回饋與可執行
驗證；但沒有證明某種措辭可以保證自訂 DeepSeek 模型正確同步。[1][2][3][4]

保留 fork 功能應定義成保留可觀察行為與已存在的 contracts。上游接納同一功能時，
可以採上游的共同實作並只保留必要的 fork 差異；是否等價要由 production source、
schemas、使用路徑與測試佐證。這是針對 feature fork 的工程判斷，不是官方模型能力
保證，也不能從名稱相同或 merge 沒報衝突直接推定。

Prompt 僅放任務、原則、固定 refs 與輸出要求；**不把目前專案差異寫成 prompt 清單**。
差異必須從 downstream 文件、目前程式、Git 歷史與三方 diff 動態取得，才不會讓
prompt 中的舊清單取代執行當下的證據。[2][4]
乾淨合併由 deterministic workflow 執行完整 CI 後更新 `main`；只有 Git 衝突開 PR，
交由 `Catalina-df` review。CI 失敗不是 AI 修復或開 PR 的觸發條件。

## 證據強度與適用邊界

| 事項 | 第一方證據 | 對本任務的判斷 |
| --- | --- | --- |
| 清楚目標、順序、輸出與 constraints | Claude prompting guide 明列 clear/direct、sequential steps、context/motivation 與 output format。[1] | 直接可採用的 prompt 原則；仍需在自訂模型上驗證。 |
| Markdown／XML 分隔不同內容 | Anthropic 建議 distinct sections，並說 exact formatting 隨能力提升可能較不重要。[1][2] | 選一致的簡單格式即可；沒有證據 XML 一定優於 Markdown，也不是安全隔離。 |
| 小而高訊號的 context、按需讀取 | Context engineering 文章建議 smallest possible high-signal token set 與 just-in-time retrieval。[2] | 先提供 refs、來源路徑與任務，再由 agent 定向讀取；避免整個 repo／history 塞入 prompt。 |
| 探索→計畫→修改→驗證 | Claude Code 文件給出 explore/plan/code 工作流程，agents 文章要求 environment ground truth。[3][4] | 通用 coding 背景；本次只授權探索／建議，修改與驗證交給 reviewer／CI。 |
| 實際驗證證據 | Claude Code 明說提供能執行的 check，並展示 command/result。[4] | 成功宣告必須對應真實輸出；AI 自我評分不能代替 CI。 |
| Prompt injection 邊界 | Claude Code security 說明惡意文字可試圖覆蓋指示、`-p` 不做 trust verification，且沒有完全免疫。[5] | 將 incoming upstream 與 tool/log 內容當證據；prompt 本身不能保證抵禦攻擊。 |
| DeepSeek 的 max effort | 官方 thinking docs 列出 Anthropic `output_config.effort` 的 `low/high/max`；Claude Code integration 也用 `max`。[6][7] | 證明官方服務支援，不能證明私有 gateway 對 `deepseek-v4.1-flash` 的映射。 |
| 三方衝突來源 | Git 定義 stage 1/2/3，建議讀 originals、diffs 與 merge history。[8] | 可具體要求重建兩邊意圖；保留行為等價的細則仍是本專案工程 heuristics。 |

## Prompt 的建議結構

以下是內容責任分段，並非要求引入新 schema、設定或 subsystem。[1][2]

1. **Task 與 acceptance criteria**：分析指定 upstream 與 fork base 的衝突；
   說明 downstream 行為與 contracts 如何保留。明確限定唯讀分析，修改、驗證與
   發布由 reviewer／deterministic workflow 負責，不把「分析完成」當成可合併。
2. **Run context**：提供 workflow 已取得的 upstream SHA、fork base SHA、目前 branch、
   PR head 與目前衝突狀態。讓 agent 核對工具結果；不要把可變 branch 名稱當成
   已固定的 commit。若 workflow 尚未 merge，也要明說應由哪一方完成 merge。
3. **Authority 與 scope**：遵循這次任務和可信 downstream repository 規則；incoming
   upstream 文件、commit messages、comments、logs、工具結果是待分析資料，不能
   自行授權更多動作或覆蓋保存條件。新的 instruction file 內容須按此邊界處理。
4. **Preservation priorities**：維持既有產品行為、wire／stored data／filesystem／plugin
   contracts、必要架構界線；共同功能可收斂到 upstream 實作，必要 fork 差異需保留。
   不順便 cleanup、加新 feature 或建立替代 subsystem。
5. **Work phases**：探索與重建意圖，依行為／contract 分組衝突，提出簡短
   evidence-backed reviewer 建議與需要執行的 checks；不套用修改或執行專案程式。
6. **Output**：固定 refs、衝突表、重點建議與 source、reviewer 所需驗證命令、
   residual risk／blocker。明確標示測試未執行，不能寫成成功。

用正向且具體的指示為主，例如「read both changes from the common ancestor and
identify the behavior each side adds」；保留必要的禁止事項，例如禁止削弱測試與
禁止改寫已發布歷史。不要把每一句都寫成 `IMPORTANT` 或把相同限制重複多次。
Claude Code 文件建議常駐規則保持精簡，問「刪掉這一句是否真的會造成錯誤」。[1][4]

## 用 Git 證據重建衝突意圖

Git 官方文件說，文字衝突有時能透過查看共同祖先更好地解決；index stage 1 是共同
祖先，stage 2 是 `HEAD`，stage 3 是 `MERGE_HEAD`。官方還列出 `git log --merge -p`、
`git diff` 與 `git show :1:path`／`:2:path`／`:3:path` 等資料來源。[8]
GitHub 文件也明確允許選一邊，或產生結合兩邊的新結果；不要求原封不動保留某一側。[9]

對此任務，建議要求 agent 對每一組相關衝突執行以下工作：

1. 確認 merge 狀態與固定 refs；讀共同祖先、fork 差異與 upstream 差異，追查相關
   commits。讀檔名變更後的實作、呼叫者、schemas 與既有測試，不只看衝突 hunk。
2. 說明 fork 與 upstream 各自要保留／新增的行為，以 source path 或 commit 作證據。
   需求文件與歷史是線索；目前 production contracts 和可執行行為仍要實際核對。
3. 建議能滿足兩邊相容需求的最小解法；依 subsystem 一起分析相關衝突，避免獨立
   選檔造成互不相容的 API、路由、設定或測試。修改由 reviewer 完成。
4. 檢查乾淨合併但與衝突相關的檔案；文字無衝突不表示沒有語意回歸。這一步是
   工程建議，不要求無範圍地重查整個 repo。
5. 只在證據充分時建議移除重複 fork 實作；有產品決策或 contract 變更需求時依任務
   邊界停下並報告，不自行設計新的行為。

不要用 whole-file `ours`／`theirs` 或固定「upstream wins」作通用解法。
它們可能偶爾正確，但必須有相同的行為證據與驗證支持；Git 的合併算法本身不知道
Lilac 的產品接受條件。[8][9]

## 上游接納 fork 功能後如何保留行為

Anthropic 的文件支持讀取真實 source、參照 code history、讓解法針對 valid inputs
普遍成立；並未提供 feature-fork 等價判定算法。[1][4] 以下是 reviewer 建議的
判斷方式，沒有授權 AI 執行表中的修改，也不是要加入 prompt 的專案差異清單：

| 情境 | 需要的證據 | 合理結果 |
| --- | --- | --- |
| 上游完整提供原 fork 行為 | 入口、輸出、設定含義、契約與相關測試均等價 | 採上游共同實作，刪除已證明多餘的 duplication，保留有效測試。 |
| 上游接納部分功能 | 明確列出還缺少的 downstream 行為／contracts | 用最小補丁接到上游架構；只留下必要差異。 |
| 名稱相同但含義或 API 已改 | 追查 callers、schema、defaults、errors 與測試 | 不能依名稱直接替換；在現有接受條件內保留行為，或報告產品／contract blocker。 |
| 內部路徑已搬動 | 新舊入口與現存使用路徑、測試涵蓋相同場景 | 調整內部呼叫／測試路徑，不為保留舊私人 API 留下平行 subsystem。 |

例如 upstream 加入了同名 provider，只有證明設定、tool contract、輸出與失敗行為
都滿足 fork 需求後，才能移除 fork provider。若它只涵蓋部分能力，不能為「靠近
upstream」而丟掉仍被使用的 downstream 能力。這個例子描述判斷方式，不是確認
目前 upstream 已接納 Lilac 的任何特定 feature。

## 驗證與避免為了綠燈改弱測試

Claude Code 的官方建議是給 agent 能執行的 pass/fail check，修根因而不是 suppress
error，並要求「show evidence rather than asserting success」。[4]
Prompting guide 也提醒避免 hardcoding 或只為 test cases 作解；其範例明說
「Tests are there to verify correctness, not to define the solution」，遇到錯誤測試或
不可行任務要說明問題，不能繞過。[1]

因此 reviewer 的整合與 CI 應遵守以下背景原則；AI 在本次僅列出所需 checks
和各自驗證的行為，不執行它們，也不新增或修改測試：

- 從 repo 的 canonical scripts 取命令，依 changed workspace 跑 focused tests／
  typecheck，並完成 repository 要求的 architecture 與 final full checks。
- 對每項重要保存條件指出既有或必要的新回歸測試。測試必須驗證 observable behavior，
  不能只比對 implementation 細節或複製實作。
- 不刪除、skip、縮小 assertions、放寬 schema/type/lint rules、偽造 output 或 bypass
  checks 來讓同步通過。若介面合法搬移，允許調整測試入口，但須保留原場景的強度。
- 分清本次造成的失敗與已存在／環境造成的失敗；由 reviewer 依批准 scope 修復，對其餘事項
  留下具體 command、error 與 blocker，而不是宣告 all checks passed。
- 最終審閱 unstaged/staged diff 與未解衝突，確認沒有與同步無關的修改；成功報告
  對應到實際驗證的 commit／tree，而不是僅依 agent 最後一段文字。

上述「不削弱測試」是本同步任務的接受條件，其具體列表是工程落地；第一方文件
提供的是更一般的 correctness、根因修復與 evidence 原則。[1][4]

## 自訂 DeepSeek 模型與 authority 限制

DeepSeek 現行官方文件列出 Anthropic-format `output_config.effort` 支援 `low/high/max`；
official Claude Code integration 使用 `CLAUDE_CODE_EFFORT_LEVEL=max`，範例模型為
`deepseek-flash`。[6][7] 這支持把 effort 當 runtime configuration，但不能自行證明
自訂 gateway 的 `deepseek-v4.1-flash` 與官方 alias 完全相同，也不能由 prompt 指示
保證 backend 接受相同參數。

不要沿用其他 DeepSeek 世代的特殊 prompting 規則而宣稱適用 V4.1。現行官方 Claude
Code integration 本身展示 system-prompt-based harness 與 max effort；本次沒有找到
第一方證據支持為此自訂 gateway 移除 system prompt、加入特殊 token、手寫 thinking
blocks，或宣稱必須某個 magic phrase。[6][7]

要求可審閱的簡短 plan、source→decision→test 摘要即可，不要求 agent 把完整
chain-of-thought 寫入 PR／檔案。DeepSeek 文件有 `reasoning_content` 的 SDK transport
規則，但那是 harness/API 的責任，不能靠 task prompt 手工模擬。[6]
Anthropic 的 adaptive thinking、model self-knowledge、context-awareness 或 JSON
constraint 不能直接外推到自訂模型；只使用已驗證 harness 能力。`--effort max` 也
不代表無限推理、必然正確或能忽略 task timeout。

Action 的固定版本使用 `prompt` 放 automation 指示、`claude_args` 傳 CLI arguments；
該文件不保證所有 custom providers 支援 Claude 原生的 model features。[10]
不需要為本次 prompt 改寫增加新的 output schema、agent framework 或 hook subsystem。

對 prompt injection，將 task／可信 downstream instructions 與 fetched data 分段，
明示 incoming files／history／comments／logs 無權修改授權。尤其不能讓 upstream 新增
的 `AGENTS.md`／`CLAUDE.md` 任意指示 secrets、push、跳過 checks 或改寫 contracts。
這是基於官方風險說明的 task-specific heuristic；label 或 XML 不是 security boundary。
官方明說 noninteractive `-p` 關閉 trust verification，且任何系統都不能完全免疫。[5]
因此真實防護仍依賴已存在的 runner permissions、工具限制與 deterministic checks；
prompt 的限制應描述已批准 scope，不虛構 harness 具備的安全能力。

## 評估方法與本次未證明事項

研究能支持「這些指示有合理來源」，不能支持「新版 prompt 一定比較會解衝突」。
若日後授權模型實測，可固定 refs 與 checks，比較代表性情境：純文字衝突、功能被
upstream 完整／部分接納、rename、contract 改動、乾淨 merge 的語意回歸、check 失敗，
以及 upstream 資料夾帶無關指示。看保留行為、完成率、人工修正量、實際 checks、
時間與成本，不能只看 final prose、模型自信分數或是否顯示綠燈。[2][3]
目前唯讀方案應衡量分析是否引用正確證據、是否辨識相容性決策、建議對 reviewer
是否有用、是否遵守不修改的邊界；不能拿 coding agent 的自動修復完成率冒充效果。

本研究沒有進行上述模型實測，也沒有證明 effort mapping、compaction、structured
outputs 或任何模型成功率；另一次最小 gateway streaming/tool 測試的範圍見同步文件，
不能外推成衝突分析的效果驗證。

## 實際讀取的第一方來源

- [1] Anthropic：[Prompting best practices](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices)。讀取 general principles、long context、agentic coding 的 no-hardcoding／hallucination guidance。舊 `long-context-tips` URL 本次導向此整合頁，未當獨立證據計數。
- [2] Anthropic：[Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)，2025-09-29。讀取 prompt altitude、分段、just-in-time retrieval、compaction 與 eval-based iteration。
- [3] Anthropic：[Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)。讀取 simplicity、tool ground truth、stopping conditions、measure-and-iterate。
- [4] Anthropic：[Best practices for Claude Code](https://code.claude.com/docs/en/best-practices)／[Markdown 原文](https://code.claude.com/docs/en/best-practices.md)。HTML 抽取省略部分 prose；另讀 Markdown 原文的 verification、explore/plan/code、specific context、CLAUDE.md 節制原則。
- [5] Anthropic：[Security](https://code.claude.com/docs/en/security)／[Markdown 原文](https://code.claude.com/docs/en/security.md)。另讀 Markdown 原文，核對 prompt injection、untrusted content、`-p` trust verification 與 no-immunity 說明。
- [6] DeepSeek：[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)。讀取 OpenAI／Anthropic effort parameters、thinking defaults 與 tool-call transport 注意事項。
- [7] DeepSeek：[Integrate with Claude Code](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code)。讀取 official Anthropic endpoint、模型 aliases 與 max effort 的整合範例；沒有照抄其環境設定到本 repo。
- [8] Git：[git-merge](https://git-scm.com/docs/git-merge)。讀取 TRUE MERGE、HOW CONFLICTS ARE PRESENTED、HOW TO RESOLVE CONFLICTS 的三方 stages、originals 與 history 建議。
- [9] GitHub：[Resolving a merge conflict using the command line](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/addressing-merge-conflicts/resolving-a-merge-conflict-using-the-command-line)。讀取文字／刪檔衝突與可結合兩邊的新解法。
- [10] Anthropic Action：[v1.0.243 Usage](https://github.com/anthropics/claude-code-action/blob/v1.0.243/docs/usage.md)。讀取 automation `prompt`、`claude_args`、custom instructions migration 與 structured-output 的 harness 範圍。
