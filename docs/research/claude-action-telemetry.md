# Claude Code Action telemetry opt-out

研究日期：2026-10-07。目標版本為 Claude Code Action `v1.0.243`，固定 commit
`86d88e619d8e6caf07b5c3944dd14f441c533718`；該 commit 安裝 Claude Code `2.1.291`。[6]
以下依本次取得的官方文件及固定 Action 原始碼判斷；線上文件會繼續更新，並非該 CLI
版本的不可變快照。本次未執行模型呼叫或 telemetry 網路流量測試。

## 結論與精確值

關閉 Anthropic operational telemetry 與自訂 OpenTelemetry export 是兩組設定。
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` 關閉非必要流量；
`CLAUDE_CODE_ENABLE_TELEMETRY=0` 關閉可選的 OpenTelemetry collection，再以三種
exporter 的 `none` 明確關閉各訊號。[1][2][3]

| 環境變數 | 關閉值 | 官方證據與範圍 |
| --- | --- | --- |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` | 正式 umbrella 名稱，關閉 telemetry、error reporting、feedback、updates、release notes 及其他非必要流量；也停止 feature-flag fetching。[1][2] |
| `DISABLE_TELEMETRY` | `1` | 正式 operational telemetry opt-out；也停止 feature-flag fetching。[1][2] |
| `DISABLE_ERROR_REPORTING` | `1` | 正式 error reporting opt-out。[1][2] |
| `DO_NOT_TRACK` | `1` | 正式支援；和 `DISABLE_TELEMETRY` 效果相同，但採一般 boolean parsing，`0` 不會 opt out。[1] |
| `DISABLE_FEEDBACK_COMMAND` | `1` | 正式名稱，關閉 `/feedback`、`/bug`、`/share` 及 Claude-drafted feedback。[1][2] |
| `DISABLE_BUG_COMMAND` | `1` | 官方明確仍接受的舊名稱，等效於 `DISABLE_FEEDBACK_COMMAND`。文件稱 older name，並未宣告已移除。[1] |
| `CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY` | `1` | 關閉 session quality surveys，即使存在自訂 OTEL survey opt-in 也優先關閉。[1][2] |
| `CLAUDE_CODE_ENABLE_FEEDBACK_SURVEY_FOR_OTEL` | `0` | 關閉將 survey opt back in 到使用者自訂 collector 的開關；一般 boolean parsing。[1][2] |
| `CLAUDE_CODE_ENABLE_TELEMETRY` | `0` | OpenTelemetry collection 需要 `1`；一般 boolean parsing 以 `0` 關閉。[1][3] |
| `OTEL_METRICS_EXPORTER` | `none` | 文件明列「Use `none` to disable」。[3] |
| `OTEL_LOGS_EXPORTER` | `none` | 文件明列「Use `none` to disable」。[3] |
| `OTEL_TRACES_EXPORTER` | `none` | beta traces 文件明列「Use `none` to disable」。[3] |

前三個 `DISABLE` 開關採 **non-empty** 判斷：即使值為 `0` 或 `false` 仍關閉對應流量，
要重新啟用須 unset 或設空字串。其他一般 boolean 開關接受 `1`、`true`、`yes`、`on`
為開啟，`0`、`false`、`no`、`off` 為關閉。[1] 建議使用上表的明確字串值。

`DISABLE_NONESSENTIAL_TRAFFIC`（沒有 `CLAUDE_CODE_` 前綴）未列於本次取得的完整官方
environment variables reference，也未出現在上述固定 Action production source。
本次沒有找到它是支援 alias 的第一方證據；不能以它取代正式 umbrella 名稱。[1][6]

`OTEL_SDK_DISABLED=true` 是 **OpenTelemetry 標準**，其規格要求 `true` 使用 no-op SDK，
關閉所有 signals；此 boolean 只接受大小寫不敏感的 `true` 為真，不能用 `1` 代替。[9]
但是本次 Claude Code 官方 environment reference、monitoring 文件和固定 Action source
未建立 Claude Code native CLI 實際讀取此變數的證據。可將它視為標準 SDK 的補充 opt-out，
不能依靠它取代上表已確認的 Claude Code controls。[1][3][6][9]

## Action 環境傳遞與 settings

固定 Action 的 `action.yml` 明確轉送 `CLAUDE_CODE_ENABLE_TELEMETRY`、
`OTEL_METRICS_EXPORTER`、`OTEL_LOGS_EXPORTER` 及 OTLP 設定。[6]
其 `parse-sdk-options.ts` 複製完整 `process.env` 到 SDK options 的 `env`，只移除
OIDC token request variables 與 `ALL_INPUTS`；不存在 telemetry allowlist。[7]

不要將 `action.yml` 中「env block shadows job-level env」的註解解讀為其他 env keys
全部消失。GitHub runner 的 composite handler 先合併 global env、呼叫端 composite-step
env，最後合併 embedded-step env；後者只覆寫同名 key。這是 runner 的可見原始碼行為，
與該註解的廣泛說法不同。[6][10]

CLI 支援 shell environment 及 settings 的 `env` object，
`~/.claude/settings.json` 是所有專案的 user settings；`.claude/settings.json` 是共享
project settings；`.claude/settings.local.json` 是本機 project settings。[1][4]
Action `settings` input 會合併寫入 runner 的 `~/.claude/settings.json`。[8]

**在 CLI `2.1.291`，不要只把 `CLAUDE_CODE_ENABLE_TELEMETRY=0` 放在 project/local
settings。** 自 `2.1.282` 起，project/local settings 的 `env` 不允許設定這個開關及多種
exporter variables。三種 exporter selectors 的 `none` 值例外可以套用，但不能覆寫 launch
environment、`--settings` 或 managed settings 的同名值。使用 workflow job/step environment
或 user settings，才能避開此限制。[3][5]

OpenTelemetry 在啟動時讀取設定，修改後須重啟 Claude Code session。[1]
umbrella opt-out 同時關閉 feature-flag fetching 及部分功能，例如 Remote Control；它沒有
關閉模型 API 呼叫，也不涵蓋 WebFetch domain safety check 或官方 plugin marketplace
auto-install。這些並非 telemetry，是否停用屬於另一個需求。[1][2]

## 第一方來源

1. [Claude Code environment variables](https://code.claude.com/docs/en/env-vars.md)：完整 reference，本次取得全文；精確名稱、boolean rules、舊 feedback alias 與 `DO_NOT_TRACK`。
2. [Claude Code data usage](https://code.claude.com/docs/en/data-usage.md)：Telemetry services、Session quality surveys、Default behaviors by API provider。
3. [Claude Code monitoring](https://code.claude.com/docs/en/monitoring-usage.md)：Common configuration variables、Traces (beta)、Administrator configuration。
4. [Claude Code settings](https://code.claude.com/docs/en/settings.md)：設定位置與 precedence。
5. [Claude Code settings reference](https://code.claude.com/docs/en/settings-reference.md#variables-claude-code-ignores-in-env)：project/local exporter restrictions；明列 `2.1.282` 版本門檻及 off-value 例外。
6. 固定 Action 原始碼：[action.yml](https://github.com/anthropics/claude-code-action/blob/86d88e619d8e6caf07b5c3944dd14f441c533718/action.yml#L374)、[CLI version](https://github.com/anthropics/claude-code-action/blob/86d88e619d8e6caf07b5c3944dd14f441c533718/src/entrypoints/run.ts#L80)。
7. [Action SDK environment propagation](https://github.com/anthropics/claude-code-action/blob/86d88e619d8e6caf07b5c3944dd14f441c533718/base-action/src/parse-sdk-options.ts#L278)。
8. [Action user settings setup](https://github.com/anthropics/claude-code-action/blob/86d88e619d8e6caf07b5c3944dd14f441c533718/base-action/src/setup-claude-code-settings.ts)。
9. [OpenTelemetry SDK environment variable specification](https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/#general-sdk-configuration)：`OTEL_SDK_DISABLED` 及 Boolean parsing。
10. [GitHub Actions runner CompositeActionHandler](https://github.com/actions/runner/blob/main/src/Runner.Worker/Handlers/CompositeActionHandler.cs)：Initialize env context、Merge global env、Merge composite-step env、Evaluate and merge embedded-step env。
