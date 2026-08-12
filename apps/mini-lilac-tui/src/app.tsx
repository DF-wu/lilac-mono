import {
  CliRenderEvents,
  SyntaxStyle,
  decodePasteBytes,
  stripAnsiSequences,
  type KeyBinding,
  type KeyEvent,
  type MouseEvent,
  type PasteEvent,
  type ScrollBoxRenderable,
  type TextareaRenderable,
} from "@opentui/core";
import {
  useKeyboard,
  useRenderer,
  useSelectionHandler,
  useTerminalDimensions,
} from "@opentui/solid";
import {
  For,
  Index,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import {
  DEFAULT_WORKING_INDICATORS,
  createWorkingIndicatorQueue,
} from "@stanley2058/lilac-utils/working-indicators";
import {
  MINI_LILAC_REASONING_LEVELS,
  type MiniLilacRequestError,
  type MiniLilacStreamError,
  type MiniLilacModelSummary,
  type MiniLilacProfileSummary,
  type MiniLilacReasoning,
  type MiniLilacSessionSnapshot,
  type MiniLilacSkillSummary,
  type MiniLilacTodo,
  type MiniLilacTodoState,
  type MiniLilacTransport,
  type MiniLilacUIMessage,
  type MiniLilacUserUIMessage,
} from "@stanley2058/mini-lilac-client";

import {
  ClipboardImageTooLargeError,
  MAX_CLIPBOARD_IMAGE_BYTES,
  readClipboardImage,
} from "./clipboard";
import { registerCodeBlockParsers } from "./code-block-parsers";
import { Controller, type SessionBindingUpdate, type SessionBindings } from "./controller";
import {
  editorOffsetWidth,
  initialInputState,
  type DraftFile,
  type DraftPastedText,
} from "./input-state";
import { decodeDraftExtmarkData, type DraftExtmarkData } from "./opentui-boundary";
import {
  readTerminalStream,
  releaseTerminalStreamLock,
  type TerminalStreamReadFailed,
} from "./terminal-stream-adapter";
import {
  COMMAND_PALETTE_ITEMS,
  filterPaletteItems,
  isSlashPaletteKey,
  modelPaletteItems,
  movePaletteIndex,
  nextProfile,
  reasoningPaletteItems,
  sessionPaletteItems,
  skillPaletteItems,
  todoFloatingSummary,
  todoMarker,
  todoPaletteItems,
  type PaletteItem,
  type PaletteKind,
  type TodoFloatingSummary,
} from "./palette";
import {
  editTranscriptAction,
  groupNearbyEdits,
  isShellTranscriptCollapsible,
  explorationTranscriptText,
  shellTranscriptPreview,
  type EditOperation,
  type EditTranscript,
  type ExplorationOperation,
  type ExplorationTranscript,
  type ShellTranscript,
  type SubagentTranscript,
  type TranscriptEntry,
  type TranscriptTone,
} from "./render";
import { ChunkRenderer, renderInitialMessages } from "./render-boundary";
import type { ExistingSessionLoadError } from "./startup";
import {
  formatSessionTitle,
  formatTokenUsage,
  resolveContextWindow,
  sessionPresentation,
  type SessionPresentation,
} from "./presentation";
import { COLORS, createMarkdownSyntaxStyle, type ThemeColors } from "./theme";
import { createBufferedChunkOutput } from "./transcript-buffer";
import {
  projectMiniLilacStreamChunk,
  UIMessageChunkProjectionState,
} from "./ui-message-chunk-projection";

registerCodeBlockParsers();

const WORKING_INDICATOR_ROTATE_MIN_MS = 10_000;
const WORKING_INDICATOR_ROTATE_MAX_MS = 30_000;
const WORKING_STATUS_TICK_MS = 220;
const PULSING_SQUARE_FRAMES = [
  { glyph: "·", color: "border" },
  { glyph: "▪", color: "muted" },
  { glyph: "■", color: "accent" },
  { glyph: "▣", color: "success" },
  { glyph: "■", color: "accent" },
  { glyph: "▪", color: "muted" },
] as const satisfies readonly {
  readonly glyph: string;
  readonly color: keyof Pick<ThemeColors, "border" | "muted" | "accent" | "success">;
}[];

const COMPOSER_KEY_BINDINGS: KeyBinding[] = [
  { name: "return", shift: true, action: "newline" },
  { name: "return", action: "submit" },
  { name: "kpenter", shift: true, action: "newline" },
  { name: "kpenter", action: "submit" },
  { name: "linefeed", action: "newline" },
  { name: "j", ctrl: true, action: "newline" },
];

export interface MiniLilacAppProps {
  readonly transport: MiniLilacTransport;
  readonly cwd: string;
  readonly sessionId: string;
  readonly model: string | undefined;
  readonly profile: string | undefined;
  readonly reasoning: MiniLilacReasoning | undefined;
  readonly models: readonly MiniLilacModelSummary[];
  readonly profiles: readonly MiniLilacProfileSummary[];
  readonly initialSnapshot: MiniLilacSessionSnapshot | undefined;
  readonly initialMessages: readonly MiniLilacUIMessage[];
  readonly initialTodos: MiniLilacTodoState;
  readonly theme?: ThemeColors;
  readonly onBindingsChange?: (bindings: SessionBindings) => void;
  readonly onNewSession: (bindings: SessionBindings) => void;
  readonly onSessionSelect: (
    sessionId: string,
  ) => Promise<import("better-result").Result<void, ExistingSessionLoadError>>;
  readonly onExit: () => void;
}

interface PaletteState {
  readonly kind: PaletteKind;
  readonly selected: number;
  readonly query: string;
}

interface SubagentView {
  readonly subagent: SubagentTranscript;
  readonly entries: readonly TranscriptEntry[];
  readonly loading: boolean;
  readonly error?: string;
}

function truncateEnd(value: string, width: number): string {
  if (value.length <= width) return value;
  return `${value.slice(0, Math.max(1, width - 3))}...`;
}

function truncateStart(value: string, width: number): string {
  const characters = Array.from(value);
  if (characters.length <= width) return value;
  if (width <= 3) return ".".repeat(width);
  return `...${characters.slice(-(width - 3)).join("")}`;
}

function entryPrefix(entry: TranscriptEntry): string {
  switch (entry.kind) {
    case "compaction":
      return "COMPACTION / ";
    case "reasoning":
      return "* ";
    case "error":
      return "! ";
    case "status":
      return "- ";
    case "file":
      return "+ ";
    case "user":
    case "assistant":
    case "tool":
    case "shell":
    case "exploration":
    case "edit":
    case "source":
    case "subagent":
      return "";
  }
}

function shellPreviewRows(narrow: boolean): number {
  return narrow ? 4 : 8;
}

function isToolTranscriptEntry(entry: TranscriptEntry): boolean {
  return (
    entry.kind === "tool" ||
    entry.kind === "shell" ||
    entry.kind === "exploration" ||
    entry.kind === "edit" ||
    entry.kind === "subagent"
  );
}

function toolDisclosureLabel(narrow: boolean, expanded: boolean): string {
  if (!narrow) return expanded ? "hide" : "details";
  return expanded ? "−" : "+";
}

function toolDisclosureWidth(narrow: boolean): number {
  return narrow ? 2 : 5;
}

function transcriptEntryBackground(
  entry: TranscriptEntry,
  colors: ThemeColors,
): string | undefined {
  switch (entry.kind) {
    case "shell":
      return colors.raised;
    case "user":
      return colors.panel;
    case "assistant":
    case "reasoning":
    case "tool":
    case "exploration":
    case "edit":
    case "file":
    case "source":
    case "status":
    case "subagent":
    case "compaction":
    case "error":
      return undefined;
  }
}

function transcriptEntryBorder(entry: TranscriptEntry): ("top" | "left")[] | undefined {
  switch (entry.kind) {
    case "compaction":
      return ["top"];
    case "user":
    case "tool":
    case "shell":
    case "exploration":
    case "edit":
    case "subagent":
      return ["left"];
    case "assistant":
    case "reasoning":
    case "file":
    case "source":
    case "status":
    case "error":
      return undefined;
  }
}

function paletteName(kind: PaletteKind | undefined): string {
  switch (kind) {
    case "models":
      return "model";
    case "sessions":
      return "session";
    case "skills":
      return "skills";
    case "todos":
      return "todos";
    case "commands":
    case "reasoning":
    case undefined:
      return kind ?? "commands";
  }
}

function subagentViewBorderColor(view: SubagentView, colors: ThemeColors): string {
  if (view.error !== undefined) return colors.danger;
  return view.loading ? colors.accent : colors.success;
}

function subagentViewStatus(view: SubagentView): string {
  if (view.error !== undefined) return "transcript unavailable";
  return view.loading ? "streaming / read-only" : "read-only";
}

function ToolDisclosure(props: {
  readonly expanded: boolean;
  readonly narrow: boolean;
  readonly colors: ThemeColors;
}) {
  return (
    <text flexShrink={0} paddingLeft={1} fg={props.colors.muted} selectable={false}>
      {toolDisclosureLabel(props.narrow, props.expanded)}
    </text>
  );
}

function formatRunDuration(durationMs: number): string {
  const totalSeconds = Math.floor(Math.max(0, durationMs) / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function ShellView(props: {
  readonly shell: ShellTranscript;
  readonly expanded: boolean;
  readonly narrow: boolean;
  readonly width: number;
  readonly colors: ThemeColors;
}) {
  const previewRows = createMemo(() => shellPreviewRows(props.narrow));
  const characterLimit = createMemo(() => previewRows() * Math.max(20, props.width));
  const collapsible = createMemo(() =>
    isShellTranscriptCollapsible(props.shell, previewRows(), characterLimit()),
  );
  const preview = createMemo(() =>
    shellTranscriptPreview(props.shell, props.expanded, previewRows(), characterLimit()),
  );

  return (
    <box width="100%">
      <Show when={props.shell.cwd !== undefined}>
        <text width="100%" wrapMode="word" fg={props.colors.muted} selectable={true}>
          {`# Running in ${props.shell.cwd ?? ""}`}
        </text>
      </Show>
      <box width="100%" flexDirection="row" paddingTop={props.shell.cwd === undefined ? 0 : 1}>
        <text flexGrow={1} minWidth={0} wrapMode="word" fg={props.colors.text} selectable={true}>
          {`$ ${preview().command}`}
        </text>
      </box>
      <Show when={preview().output !== undefined}>
        <text width="100%" wrapMode="word" fg={props.colors.text} selectable={true}>
          {preview().output ?? ""}
        </text>
      </Show>
      <Show when={collapsible()}>
        <box paddingTop={1}>
          <text fg={props.colors.muted} selectable={false}>
            {props.expanded ? "Click to collapse" : "Click to expand"}
          </text>
        </box>
      </Show>
    </box>
  );
}

function ExplorationView(props: {
  readonly exploration: ExplorationTranscript;
  readonly running: boolean;
  readonly expanded: boolean;
  readonly narrow: boolean;
  readonly colors: ThemeColors;
}) {
  const counts = createMemo(() =>
    [
      props.exploration.reads > 0
        ? `${props.exploration.reads} read${props.exploration.reads === 1 ? "" : "s"}`
        : undefined,
      props.exploration.searches > 0
        ? `${props.exploration.searches} search${props.exploration.searches === 1 ? "" : "es"}`
        : undefined,
    ].filter((value) => value !== undefined),
  );

  const operationStatusColor = (operation: ExplorationOperation) => {
    switch (operation.status) {
      case "error":
        return props.colors.danger;
      case "denied":
        return props.colors.warning;
      case "cancelled":
        return props.colors.muted;
      case "pending":
        return props.colors.accent;
      case "success":
        return props.colors.success;
    }
  };

  return (
    <box width="100%">
      <box width="100%" flexDirection="row">
        <text flexShrink={0} fg={props.colors.text}>
          {props.running ? "Exploring" : "Explored"}
        </text>
        <text flexShrink={0} fg={props.colors.muted}>{` · ${counts().join(", ")}`}</text>
        <Show when={props.exploration.failures > 0}>
          <text flexShrink={0} fg={props.colors.warning}>
            {` · ${props.exploration.failures} failed`}
          </text>
        </Show>
        <Show when={(props.exploration.cancellations ?? 0) > 0}>
          <text flexShrink={0} fg={props.colors.muted}>
            {` · ${props.exploration.cancellations ?? 0} cancelled`}
          </text>
        </Show>
        <box flexGrow={1} />
        <ToolDisclosure expanded={props.expanded} narrow={props.narrow} colors={props.colors} />
      </box>
      <Show when={props.expanded}>
        <box width="100%">
          <For each={props.exploration.operations}>
            {(operation, index) => (
              <box width="100%" flexDirection="row">
                <text flexShrink={0} fg={props.colors.border}>
                  {index() === props.exploration.operations.length - 1 ? "└─ " : "├─ "}
                </text>
                <text
                  flexShrink={0}
                  width={7}
                  fg={operation.action === "Read" ? props.colors.success : props.colors.accent}
                >
                  {operation.action.toUpperCase()}
                </text>
                <text flexGrow={1} wrapMode="word" fg={props.colors.text} selectable={true}>
                  {truncateEnd(operation.detail, 240)}
                </text>
                <text flexShrink={0} paddingLeft={1} fg={operationStatusColor(operation)}>
                  {operation.status.toUpperCase()}
                </text>
                <Show when={operation.error !== undefined}>
                  <text
                    flexGrow={1}
                    minWidth={0}
                    paddingLeft={1}
                    wrapMode="word"
                    fg={props.colors.danger}
                    selectable={true}
                  >
                    {operation.error ?? ""}
                  </text>
                </Show>
              </box>
            )}
          </For>
        </box>
      </Show>
    </box>
  );
}

function EditOperationView(props: {
  readonly operation: EditOperation;
  readonly width: number;
  readonly toneColors: Record<TranscriptTone, string>;
  readonly colors: ThemeColors;
}) {
  const additions = props.operation.added > 0 ? ` +${props.operation.added}` : "";
  const removals = props.operation.removed > 0 ? ` -${props.operation.removed}` : "";
  const detail = props.operation.detail ?? "";
  const fixedWidth =
    props.operation.action.length + 1 + additions.length + removals.length + detail.length;
  const path = truncateStart(props.operation.path, Math.max(1, props.width - fixedWidth));
  return (
    <text width="100%" wrapMode="none" truncate={true} selectable={true}>
      <span style={{ fg: props.colors.tool, bold: true }}>{`${props.operation.action} `}</span>
      <span style={{ fg: props.colors.text }}>{path}</span>
      <span style={{ fg: props.colors.success }}>{additions}</span>
      <span style={{ fg: props.colors.danger }}>{removals}</span>
      <span style={{ fg: props.toneColors[props.operation.tone] }}>{detail}</span>
    </text>
  );
}

function EditView(props: {
  readonly edit: EditTranscript;
  readonly expanded: boolean;
  readonly narrow: boolean;
  readonly width: number;
  readonly toneColors: Record<TranscriptTone, string>;
  readonly colors: ThemeColors;
}) {
  const collapsible = props.edit.operations.length > 1;
  return (
    <Show
      when={!collapsible || props.expanded}
      fallback={
        <box width="100%" flexDirection="row">
          <text flexShrink={0} wrapMode="none" selectable={true}>
            <span style={{ fg: props.colors.tool, bold: true }}>
              {editTranscriptAction(props.edit)}
            </span>
            <span
              style={{ fg: props.colors.muted }}
            >{` ${props.edit.operations.length} files`}</span>
          </text>
          <box flexGrow={1} />
          <ToolDisclosure expanded={props.expanded} narrow={props.narrow} colors={props.colors} />
        </box>
      }
    >
      <box width="100%">
        <For each={props.edit.operations}>
          {(operation, index) => {
            const showsDisclosure = collapsible && index() === 0;
            return (
              <box width="100%" flexDirection="row">
                <box flexGrow={1} minWidth={0}>
                  <EditOperationView
                    operation={operation}
                    width={Math.max(
                      1,
                      props.width - (showsDisclosure ? toolDisclosureWidth(props.narrow) : 0),
                    )}
                    toneColors={props.toneColors}
                    colors={props.colors}
                  />
                </box>
                <Show when={showsDisclosure}>
                  <ToolDisclosure
                    expanded={props.expanded}
                    narrow={props.narrow}
                    colors={props.colors}
                  />
                </Show>
              </box>
            );
          }}
        </For>
      </box>
    </Show>
  );
}

function todoColor(status: MiniLilacTodo["status"], colors: ThemeColors): string {
  switch (status) {
    case "completed":
      return colors.success;
    case "in_progress":
      return colors.warning;
    case "cancelled":
      return colors.muted;
    case "pending":
      return colors.text;
  }
}

function TodoOverlay(props: {
  readonly state: MiniLilacTodoState;
  readonly summary: TodoFloatingSummary;
  readonly expanded: boolean;
  readonly narrow: boolean;
  readonly colors: ThemeColors;
  readonly onToggle: (event: MouseEvent) => void;
  readonly onViewport: (viewport: ScrollBoxRenderable) => void;
}) {
  return (
    <box
      position="absolute"
      right={0}
      bottom={0}
      zIndex={30}
      width="100%"
      height={props.expanded ? Math.min(4, props.state.todos.length) : 1}
      paddingLeft={1}
      border={["left"]}
      borderColor={todoColor(props.summary.todo.status, props.colors)}
      backgroundColor={props.colors.raised}
      onMouseUp={props.onToggle}
    >
      <Show
        when={props.expanded}
        fallback={
          <box width="100%" flexDirection="row">
            <text flexShrink={0} fg={todoColor(props.summary.todo.status, props.colors)}>
              {`${todoMarker(props.summary.todo.status)} `}
            </text>
            <text flexGrow={1} minWidth={0} wrapMode="none" truncate={true} fg={props.colors.text}>
              {props.summary.todo.content}
            </text>
            <text flexShrink={0} paddingLeft={1} wrapMode="none" fg={props.colors.muted}>
              {`(${props.summary.completed} completed; ${props.summary.coming} coming)`}
            </text>
          </box>
        }
      >
        <scrollbox
          ref={props.onViewport}
          width="100%"
          height={Math.min(4, props.state.todos.length)}
          scrollY={true}
          viewportCulling={true}
          verticalScrollbarOptions={{
            visible: props.state.todos.length > 4,
            trackOptions: {
              backgroundColor: props.colors.raised,
              foregroundColor: props.colors.border,
            },
          }}
        >
          <For each={props.state.todos}>
            {(todo, index) => (
              <box
                width="100%"
                flexDirection="row"
                backgroundColor={
                  index() === props.summary.index ? props.colors.selection : undefined
                }
              >
                <text flexShrink={0} fg={todoColor(todo.status, props.colors)}>
                  {`${todoMarker(todo.status)} `}
                </text>
                <text
                  flexGrow={1}
                  minWidth={0}
                  wrapMode="none"
                  truncate={true}
                  fg={todo.status === "completed" ? props.colors.muted : props.colors.text}
                >
                  {todo.content}
                </text>
              </box>
            )}
          </For>
        </scrollbox>
      </Show>
    </box>
  );
}

function imageMediaType(bytes: Uint8Array, hinted?: string): string | undefined {
  if (hinted?.startsWith("image/")) return hinted;
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  const header = Buffer.from(bytes.subarray(0, 12)).toString("ascii");
  if (header.startsWith("GIF8")) return "image/gif";
  if (header.startsWith("RIFF") && header.endsWith("WEBP")) return "image/webp";
  return undefined;
}

function imageExtension(mediaType: string): string {
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/gif") return "gif";
  if (mediaType === "image/webp") return "webp";
  return "png";
}

function steeringPreview(message: MiniLilacUserUIMessage): string {
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  const attachments = message.parts
    .filter((part) => part.type === "file")
    .map((part) => part.filename ?? "image");
  const attachmentText =
    attachments.length === 0
      ? ""
      : `[${attachments.length === 1 ? attachments[0] : `${attachments.length} attachments`}]`;
  return [text, attachmentText].filter(Boolean).join(" ");
}

export function MiniLilacApp(props: MiniLilacAppProps) {
  const colors = props.theme ?? COLORS;
  const toneColors: Record<TranscriptTone, string> = {
    normal: colors.text,
    muted: colors.muted,
    accent: colors.accent,
    success: colors.success,
    warning: colors.warning,
    danger: colors.danger,
  };
  const markdownStyle = createMarkdownSyntaxStyle(colors);
  const composerStyle = SyntaxStyle.fromStyles({
    default: { fg: colors.text },
    "draft.part": { fg: colors.selectedText, bg: colors.warning, bold: true },
  });
  const dimensions = useTerminalDimensions();
  const terminalRenderer = useRenderer();
  const narrow = createMemo(() => dimensions().width < 64);
  const steeringQueueHeight = createMemo(() =>
    narrow() ? 2 : Math.max(2, Math.min(8, dimensions().height - 10)),
  );
  const [state, setState] = createSignal(initialInputState());
  const active = createMemo(() => state().phase === "active");
  const compacting = createMemo(() => state().phase === "compacting");
  /** Any long-running server operation that should show a live elapsed timer. */
  const busy = createMemo(() => active() || compacting());
  const [entries, setEntries] = createSignal<readonly TranscriptEntry[]>([]);
  const [steering, setSteering] = createSignal<readonly MiniLilacUserUIMessage[]>([]);
  const steeringQueueItemHeight = createMemo(() => (narrow() || steeringQueueHeight() < 4 ? 1 : 2));
  const steeringQueueVisibleCount = createMemo(() =>
    Math.max(
      1,
      Math.min(
        3,
        Math.floor(
          (steeringQueueHeight() - 1 - (steering().length > 1 ? 1 : 0)) / steeringQueueItemHeight(),
        ),
      ),
    ),
  );
  const steeringQueueShowsOverflow = createMemo(
    () =>
      steering().length > steeringQueueVisibleCount() &&
      steeringQueueHeight() >= 1 + steeringQueueVisibleCount() * steeringQueueItemHeight() + 1,
  );
  const [subagentView, setSubagentView] = createSignal<SubagentView | undefined>();
  const displayEntries = createMemo(() => groupNearbyEdits(subagentView()?.entries ?? entries()));
  const [todos, setTodos] = createSignal(props.initialTodos);
  const floatingTodo = createMemo(() => todoFloatingSummary(todos()));
  const [todoExpanded, setTodoExpanded] = createSignal(false);
  const [notice, setNotice] = createSignal<string | undefined>();
  const [noticeTone, setNoticeTone] = createSignal<"warning" | "danger">("danger");
  const [palette, setPalette] = createSignal<PaletteState | undefined>();
  const [availableSessions, setAvailableSessions] = createSignal<
    readonly MiniLilacSessionSnapshot[]
  >([]);
  const [availableSkills, setAvailableSkills] = createSignal<readonly MiniLilacSkillSummary[]>([]);
  const [bindings, setBindings] = createSignal<SessionBindings>({
    model: props.model,
    profile: props.profile,
    reasoning: props.reasoning,
  });
  const [session, setSession] = createSignal<SessionPresentation>(
    sessionPresentation(props.initialSnapshot),
  );
  const [bindingBusy, setBindingBusy] = createSignal(false);
  const [profileCycleBusy, setProfileCycleBusy] = createSignal(false);
  const [expandedEntries, setExpandedEntries] = createSignal<ReadonlySet<string>>(new Set());
  const [workingNowMs, setWorkingNowMs] = createSignal(Date.now());
  const [workingStartedAtMs, setWorkingStartedAtMs] = createSignal(Date.now());
  const [workingIndicator, setWorkingIndicator] = createSignal("Working");
  const [lastRunDurationMs, setLastRunDurationMs] = createSignal<number | undefined>();
  let composer: TextareaRenderable | undefined;
  let transcript: ScrollBoxRenderable | undefined;
  let todoViewport: ScrollBoxRenderable | undefined;
  let subagentAbortController: AbortController | undefined;
  let subagentOpenGeneration = 0;
  let parentTranscriptScrollTop: number | undefined;
  let draftGeneration = 0;
  let draftPartTypeId = 0;
  let restoringDraft = false;
  let nextImageNumber = 0;
  let draftExtmarkGeneration = 0;
  const draftParts = new Map<string, DraftFile | DraftPastedText>();

  function showNotice(message: string | undefined, tone: "warning" | "danger" = "danger"): void {
    setNoticeTone(tone);
    setNotice(message);
  }

  useSelectionHandler((selection) => {
    const text = selection.getSelectedText();
    if (text.length > 0) terminalRenderer.copyToClipboardOSC52(text);
  });

  const controller = new Controller({
    transport: props.transport,
    cwd: props.cwd,
    sessionId: props.sessionId,
    initialSnapshot: props.initialSnapshot,
    initialMessages: props.initialMessages,
    initialTodos: props.initialTodos,
    initialBindings: bindings(),
    onExit: props.onExit,
    ui: {
      onState: setState,
      onOutput: (next) => setEntries([...next]),
      onSteering: (next) => setSteering([...next]),
      onSession: setSession,
      onNotice: showNotice,
      onTodos: (next) => {
        setTodos(next);
        const summary = todoFloatingSummary(next);
        if (summary === undefined) setTodoExpanded(false);
        else if (todoExpanded()) scrollTodoToCurrent(todoViewport, summary.index);
        const currentPalette = palette();
        if (currentPalette?.kind !== "todos") return;
        if (next.todos.length === 0) {
          closePalette();
          return;
        }
        const length = filterPaletteItems(todoPaletteItems(next), currentPalette.query).length;
        setPalette({
          ...currentPalette,
          selected: Math.max(0, Math.min(currentPalette.selected, length - 1)),
        });
      },
      onBindings: (next) => {
        setBindings(next);
        props.onBindingsChange?.(next);
      },
    },
  });

  const profileHint = createMemo(() =>
    props.profiles.filter((profile) => !profile.subagentOnly).length > 1 ? "tab profile" : "",
  );
  const phaseText = createMemo(() => {
    const current = state();
    if (notice() !== undefined) return notice() ?? "";
    if (current.exitArmed) return "ctrl+c again to exit";
    if (current.phase === "active") return "";
    // `workingStatus` already names compaction, so repeating a phase word here
    // is what produced the old "Ready · submitting" composite.
    if (current.phase === "compacting") return "";
    if (profileCycleBusy()) return profileHint();
    if (current.phase === "submitting") return "submitting";
    if (current.phase === "disconnected") return "disconnected / esc cancel";
    return profileHint();
  });

  const phaseColor = createMemo(() => {
    if (notice() !== undefined) return noticeTone() === "warning" ? colors.warning : colors.danger;
    if (state().phase === "disconnected") return colors.danger;
    if (profileCycleBusy()) return colors.muted;
    if (state().phase === "active") return colors.success;
    if (state().phase === "compacting") return colors.warning;
    if (state().phase === "submitting") return colors.warning;
    return colors.muted;
  });

  const workingStatus = createMemo(() => {
    if (busy()) {
      const elapsedSeconds = Math.floor(Math.max(0, workingNowMs() - workingStartedAtMs()) / 1_000);
      // Compaction is not a prompt run, so it names itself rather than borrowing
      // the rotating "Working…" indicator.
      const label = compacting() ? "Compacting" : workingIndicator();
      return `${label}... ${elapsedSeconds}s`;
    }
    const durationMs = lastRunDurationMs();
    return durationMs === undefined ? "Ready" : `Ready · Ran for ${formatRunDuration(durationMs)}`;
  });
  const workingStatusFrame = createMemo(() => {
    if (!busy()) return { glyph: "▣", color: colors.accent };
    const elapsedMs = Math.max(0, workingNowMs() - workingStartedAtMs());
    const index = Math.floor(elapsedMs / WORKING_STATUS_TICK_MS) % PULSING_SQUARE_FRAMES.length;
    const frame = PULSING_SQUARE_FRAMES[index] ?? PULSING_SQUARE_FRAMES[0];
    return { glyph: frame.glyph, color: colors[frame.color] };
  });
  const workingHint = createMemo(() => {
    if (compacting()) return "esc cancel";
    const queued = state().queuedSteeringCount;
    return queued > 0 ? `${queued} queued / esc interrupt` : "esc interrupt";
  });

  createEffect(() => {
    if (!busy()) return;

    const queue = createWorkingIndicatorQueue(DEFAULT_WORKING_INDICATORS);
    const startedAtMs = Date.now();
    let nextRotationAtMs = startedAtMs;
    const rotate = (nowMs: number) => {
      const next = queue.shift() ?? "Working";
      queue.push(next);
      setWorkingIndicator(next);
      const spread = WORKING_INDICATOR_ROTATE_MAX_MS - WORKING_INDICATOR_ROTATE_MIN_MS;
      nextRotationAtMs = nowMs + WORKING_INDICATOR_ROTATE_MIN_MS + Math.random() * spread;
    };

    setWorkingStartedAtMs(startedAtMs);
    setWorkingNowMs(startedAtMs);
    setLastRunDurationMs(undefined);
    rotate(startedAtMs);
    const interval = setInterval(() => {
      const nowMs = Date.now();
      setWorkingNowMs(nowMs);
      if (nowMs >= nextRotationAtMs) rotate(nowMs);
    }, WORKING_STATUS_TICK_MS);
    const wasRun = active();
    onCleanup(() => {
      clearInterval(interval);
      // "Ran for" describes a prompt run; a compaction reports its own duration
      // on its transcript entry instead.
      if (wasRun) setLastRunDurationMs(Date.now() - startedAtMs);
    });
  });

  const profileLabel = createMemo(() => bindings().profile ?? "default");
  const currentProfile = createMemo(
    () =>
      props.profiles.find((profile) => profile.id === bindings().profile) ??
      props.profiles.find((profile) => profile.isDefault === true),
  );
  const composerBorderColor = createMemo(() => {
    const workspaceWrites = currentProfile()?.workspaceWrites;
    if (workspaceWrites === true) return colors.success;
    if (workspaceWrites === false) return colors.model;
    return colors.accent;
  });
  const modelLabel = createMemo(() => bindings().model ?? "server default");
  const reasoningLabel = createMemo(() => bindings().reasoning ?? "default");
  const cwdLabel = createMemo(() =>
    truncateStart(props.cwd, Math.max(1, Math.floor(dimensions().width * 0.3))),
  );

  const currentModel = createMemo(() =>
    props.models.find((model) => model.id === bindings().model),
  );

  const tokenUsage = createMemo(() =>
    formatTokenUsage(
      session().inputTokens,
      resolveContextWindow(session().contextWindow, currentModel()?.contextWindow),
      {
        estimated: session().inputTokensEstimated,
        compactionThreshold: session().compactionThreshold,
      },
    ),
  );

  function itemsForPaletteKind(kind: PaletteKind): readonly PaletteItem[] {
    switch (kind) {
      case "models":
        return modelPaletteItems(props.models);
      case "reasoning":
        return reasoningPaletteItems(currentModel());
      case "sessions":
        return sessionPaletteItems(availableSessions());
      case "skills":
        return skillPaletteItems(availableSkills());
      case "todos":
        return todoPaletteItems(todos());
      case "commands":
        return COMMAND_PALETTE_ITEMS;
    }
  }

  const paletteItems = createMemo<readonly PaletteItem[]>(() => {
    const current = palette();
    const items = current === undefined ? COMMAND_PALETTE_ITEMS : itemsForPaletteKind(current.kind);
    return filterPaletteItems(items, current?.query ?? "");
  });

  const paletteTitle = createMemo(() => {
    const current = palette();
    const name = paletteName(current?.kind);
    return current?.query ? `${name} ${current.query}` : name;
  });

  const visiblePaletteItems = createMemo(() => {
    const current = palette();
    if (current === undefined) return [];
    const items = paletteItems();
    const start = Math.max(0, Math.min(current.selected - 3, items.length - 7));
    return items.slice(start, start + 7).map((item, offset) => ({
      item,
      index: start + offset,
    }));
  });

  function paletteItemColor(kind: PaletteKind, item: PaletteItem): string {
    switch (kind) {
      case "models":
        return colors.model;
      case "reasoning":
        return colors.warning;
      case "skills":
        return colors.success;
      case "sessions":
        return colors.accent;
      case "todos":
        if (item.todoStatus !== undefined) return todoColor(item.todoStatus, colors);
        break;
      case "commands":
        break;
    }
    if (item.id === "model") return colors.model;
    if (item.id === "reasoning" || item.id === "compact") return colors.warning;
    if (item.id === "undo" || item.id === "redo") return colors.danger;
    if (item.id === "skills") return colors.success;
    return colors.accent;
  }

  function transcriptEntryColor(entry: TranscriptEntry): string {
    if (entry.kind === "tool" && (entry.tone === "accent" || entry.tone === "success")) {
      return colors.tool;
    }
    return toneColors[entry.tone];
  }

  function toolStateColor(entry: TranscriptEntry): string {
    if (entry.running === true) return colors.accent;
    if (entry.tone === "danger") return colors.danger;
    if (entry.tone === "warning") return colors.warning;
    if (entry.tone === "muted") return colors.muted;
    return colors.success;
  }

  function transcriptEntryBorderColor(entry: TranscriptEntry): string | undefined {
    switch (entry.kind) {
      case "compaction":
        return colors.warning;
      case "tool":
      case "shell":
      case "exploration":
      case "edit":
      case "subagent":
        return toolStateColor(entry);
      case "user":
        return colors.accent;
      case "assistant":
      case "reasoning":
      case "file":
      case "source":
      case "status":
      case "error":
        return undefined;
    }
  }

  function openPalette(kind: PaletteKind): void {
    const items = itemsForPaletteKind(kind);
    let currentId: string | undefined;
    switch (kind) {
      case "models":
        currentId = bindings().model;
        break;
      case "reasoning":
        currentId = bindings().reasoning;
        break;
      case "commands":
      case "sessions":
      case "skills":
      case "todos":
        currentId = undefined;
    }
    const selected = Math.max(
      0,
      items.findIndex((item) => item.id === currentId),
    );
    showNotice(undefined);
    setPalette({ kind, selected, query: "" });
    composer?.blur();
  }

  function closePalette(): void {
    setPalette(undefined);
    queueMicrotask(() => composer?.focus());
  }

  function toggleTodoOverlay(event: MouseEvent): void {
    if (event.button !== 0 || terminalRenderer.getSelection()?.getSelectedText()) return;
    event.preventDefault();
    event.stopPropagation();
    const next = !todoExpanded();
    setTodoExpanded(next);
  }

  function scrollTodoToCurrent(viewport: ScrollBoxRenderable | undefined, index: number): void {
    if (viewport === undefined) return;
    terminalRenderer.once(CliRenderEvents.FRAME, () => {
      if (!viewport.isDestroyed) viewport.scrollTo(Math.max(0, index - 1));
    });
  }

  function toggleTranscriptEntry(event: MouseEvent, entry: TranscriptEntry): void {
    if (
      event.button === 0 &&
      !terminalRenderer.getSelection()?.getSelectedText() &&
      entry.subagent?.sessionId !== undefined
    ) {
      event.preventDefault();
      event.stopPropagation();
      void openSubagent(entry.subagent);
      return;
    }
    const previewRows = shellPreviewRows(narrow());
    const shellCharacterLimit =
      previewRows * Math.max(20, dimensions().width - (narrow() ? 4 : 10));
    const togglesShell =
      entry.shell !== undefined &&
      isShellTranscriptCollapsible(entry.shell, previewRows, shellCharacterLimit);
    const togglesExploration =
      entry.exploration !== undefined && entry.exploration.operations.length > 0;
    const togglesEdit = entry.edit !== undefined && entry.edit.operations.length > 1;
    if (
      event.button !== 0 ||
      terminalRenderer.getSelection()?.getSelectedText() ||
      (!togglesShell && !togglesExploration && !togglesEdit)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setExpandedEntries((current) => {
      const next = new Set(current);
      if (next.has(entry.id)) next.delete(entry.id);
      else next.add(entry.id);
      return next;
    });
  }

  async function openSubagent(subagent: SubagentTranscript): Promise<void> {
    if (subagent.sessionId === undefined) return;
    subagentAbortController?.abort();
    const abortController = new AbortController();
    subagentAbortController = abortController;
    const generation = ++subagentOpenGeneration;
    if (subagentView() === undefined) parentTranscriptScrollTop = transcript?.scrollTop;
    const initialEntry: TranscriptEntry = {
      id: `subagent:${subagent.sessionId}:prompt`,
      kind: "user",
      tone: "accent",
      text: subagent.prompt,
    };
    setSubagentView({ subagent, entries: [initialEntry], loading: true });
    setPalette(undefined);
    composer?.blur();
    let bufferedOutput: ReturnType<typeof createBufferedChunkOutput> | undefined;
    let latestEntries: readonly TranscriptEntry[] = [initialEntry];
    let positionedAtBottom = false;
    const fail = (
      error: MiniLilacRequestError | MiniLilacStreamError | TerminalStreamReadFailed,
    ) => {
      const bufferedEntries = bufferedOutput?.snapshot();
      bufferedOutput?.dispose();
      if (abortController.signal.aborted) return;
      setSubagentView((current) =>
        generation === subagentOpenGeneration &&
        current !== undefined &&
        current.subagent.sessionId === subagent.sessionId
          ? {
              ...current,
              loading: false,
              error: error.message,
              entries: [
                ...(bufferedEntries ?? latestEntries),
                {
                  id: `subagent:${subagent.sessionId}:error`,
                  kind: "error",
                  tone: "danger",
                  text: error.message,
                },
              ],
            }
          : current,
      );
    };
    while (generation === subagentOpenGeneration) {
      bufferedOutput?.dispose();
      bufferedOutput = undefined;
      const [messagesResult, snapshotResult] = await Promise.all([
        props.transport.getMessagesResult(subagent.sessionId, { signal: abortController.signal }),
        props.transport.getSessionResult(subagent.sessionId, { signal: abortController.signal }),
      ]);
      if (messagesResult.status === "error") {
        fail(messagesResult.error);
        return;
      }
      if (snapshotResult.status === "error") {
        fail(snapshotResult.error);
        return;
      }
      const messages = messagesResult.value;
      const snapshot = snapshotResult.value;
      const canonicalEntries = renderInitialMessages(messages, { cwd: props.cwd });
      latestEntries = canonicalEntries;
      setSubagentView((current) =>
        generation === subagentOpenGeneration &&
        current !== undefined &&
        current.subagent.sessionId === subagent.sessionId
          ? { ...current, entries: canonicalEntries, loading: snapshot.activeRunId !== null }
          : current,
      );
      if (!positionedAtBottom) {
        positionedAtBottom = true;
        setTimeout(() => {
          if (
            generation === subagentOpenGeneration &&
            subagentView()?.subagent.sessionId === subagent.sessionId
          ) {
            transcript?.scrollTo(transcript.scrollHeight);
          }
        }, 0);
      }
      if (snapshot.activeRunId === null) return;
      bufferedOutput = createBufferedChunkOutput(
        `subagent:${subagent.sessionId}`,
        canonicalEntries,
        (entries) => {
          latestEntries = entries;
          setSubagentView((current) => {
            if (
              generation !== subagentOpenGeneration ||
              current === undefined ||
              current.subagent.sessionId !== subagent.sessionId
            ) {
              return current;
            }
            return { ...current, entries };
          });
        },
      );
      const renderer = new ChunkRenderer(
        bufferedOutput.output,
        {
          onSnapshot: () => {},
          onTranscriptReset: () => {},
        },
        { cwd: props.cwd },
      );
      const streamProjection = new UIMessageChunkProjectionState({ cwd: props.cwd });
      const streamResult = await props.transport.streamSessionResult(subagent.sessionId, {
        signal: abortController.signal,
      });
      if (streamResult.status === "error") {
        fail(streamResult.error);
        return;
      }
      const stream = streamResult.value;
      if (stream === null) continue;
      const reader = stream.getReader();
      while (generation === subagentOpenGeneration) {
        const read = await readTerminalStream(reader);
        if (read.status === "error") {
          fail(read.error);
          releaseTerminalStreamLock(reader);
          return;
        }
        if (read.value.done) break;
        if (read.value.value.status === "error") {
          fail(read.value.value.error);
          releaseTerminalStreamLock(reader);
          return;
        }
        const projected = projectMiniLilacStreamChunk(read.value.value.value, streamProjection);
        switch (projected.kind) {
          case "finish":
            renderer.handleProjected({ kind: "rendered", chunk: projected.chunk });
            continue;
          case "renderer":
            renderer.handleProjected(projected.chunk);
            continue;
          case "cursor":
          case "steering":
          case "steering-committed":
            continue;
        }
        const exhaustive: never = projected;
        return exhaustive;
      }
      releaseTerminalStreamLock(reader);
    }
  }

  function closeSubagent(): void {
    subagentOpenGeneration += 1;
    subagentAbortController?.abort();
    subagentAbortController = undefined;
    const restoreScrollTop = parentTranscriptScrollTop;
    parentTranscriptScrollTop = undefined;
    setSubagentView(undefined);
    if (restoreScrollTop !== undefined) {
      setTimeout(() => transcript?.scrollTo(restoreScrollTop), 0);
    }
    queueMicrotask(() => composer?.focus());
  }

  function entryText(entry: TranscriptEntry): string {
    const expanded = expandedEntries().has(entry.id);
    if (entry.kind === "exploration" && entry.exploration !== undefined) {
      return explorationTranscriptText(entry.exploration, entry.running === true, expanded);
    }
    return entry.text;
  }

  async function applyBindings(update: SessionBindingUpdate): Promise<void> {
    if (bindingBusy()) return;
    setBindingBusy(true);
    await controller.updateSessionBindings(update);
    setBindingBusy(false);
  }

  async function openSessionPalette(): Promise<void> {
    closePalette();
    showNotice("loading sessions");
    const listed = await props.transport.listSessionsResult(props.cwd);
    if (listed.status === "error") {
      showNotice(listed.error.message);
      return;
    }
    const sessions = listed.value.filter((candidate) => candidate.id !== props.sessionId);
    if (sessions.length === 0) {
      showNotice("no other sessions in this directory");
      return;
    }
    setAvailableSessions(sessions);
    openPalette("sessions");
  }

  async function startNewSession(): Promise<void> {
    closePalette();
    setBindingBusy(true);
    props.onNewSession(bindings());
  }

  async function openSkillsPalette(): Promise<void> {
    closePalette();
    showNotice("loading skills");
    const requestedProfile = bindings().profile;
    const listed = await props.transport.listSkillsResult(props.cwd, requestedProfile);
    if (listed.status === "error") {
      showNotice(listed.error.message);
      return;
    }
    const skills = listed.value;
    if (bindings().profile !== requestedProfile) {
      showNotice("profile changed; reopen skills");
      return;
    }
    if (skills.length === 0) {
      showNotice("no skills available for this profile");
      return;
    }
    setAvailableSkills(skills);
    openPalette("skills");
  }

  function openTodoPalette(): void {
    if (todos().todos.length === 0) {
      closePalette();
      showNotice("no todos for this session");
      return;
    }
    openPalette("todos");
  }

  async function selectPaletteItem(): Promise<void> {
    const current = palette();
    const item = current === undefined ? undefined : paletteItems()[current.selected];
    if (current === undefined || item === undefined || bindingBusy()) return;

    if (current.kind === "commands") {
      if (item.id === "new") {
        await startNewSession();
        return;
      }
      if (item.id === "todo") {
        openTodoPalette();
        return;
      }
      if (item.id === "compact") {
        closePalette();
        controller.compact();
        return;
      }
      if (item.id === "undo") {
        closePalette();
        controller.undo();
        return;
      }
      if (item.id === "redo") {
        closePalette();
        controller.redo();
        return;
      }
      if (item.id === "session") {
        await openSessionPalette();
        return;
      }
      if (item.id === "skills") {
        await openSkillsPalette();
        return;
      }
      openPalette(item.id === "model" ? "models" : "reasoning");
      return;
    }

    closePalette();
    if (current.kind === "todos") return;
    if (current.kind === "sessions") {
      setBindingBusy(true);
      const selected = await props.onSessionSelect(item.id);
      if (selected.status === "error") {
        showNotice(selected.error.message);
        setBindingBusy(false);
      }
      return;
    }
    if (current.kind === "skills") {
      const token = `@skills:${item.id} `;
      queueMicrotask(() => {
        composer?.insertText(token);
        if (composer !== undefined) controller.setEditor(composer.plainText);
      });
      return;
    }
    if (current.kind === "reasoning") {
      const reasoning = MINI_LILAC_REASONING_LEVELS.find((candidate) => candidate === item.id);
      if (reasoning === undefined) {
        showNotice("unsupported reasoning level");
        return;
      }
      await applyBindings({ reasoning });
      return;
    }

    const selectedModel = props.models.find((model) => model.id === item.id);
    const currentReasoning = bindings().reasoning;
    const reasoningSupported =
      selectedModel?.supportsReasoning !== false ||
      currentReasoning === undefined ||
      currentReasoning === "provider-default" ||
      currentReasoning === "none";
    await applyBindings(
      reasoningSupported ? { model: item.id } : { model: item.id, reasoning: "provider-default" },
    );
  }

  async function cycleProfile(): Promise<void> {
    if (bindingBusy()) return;
    const profile = nextProfile(props.profiles, bindings().profile);
    if (profile === undefined || profile.id === bindings().profile) return;
    setProfileCycleBusy(true);
    try {
      await applyBindings({ profile: profile.id });
    } finally {
      setProfileCycleBusy(false);
    }
  }

  function createDraftExtmark(id: string, placeholder: string, start: number): void {
    if (composer === undefined || draftPartTypeId === 0) return;
    composer.extmarks.create({
      start,
      end: start + editorOffsetWidth(placeholder),
      virtual: true,
      styleId: composerStyle.getStyleId("draft.part") ?? undefined,
      typeId: draftPartTypeId,
      data: {
        kind: "mini-lilac-draft",
        id,
        generation: draftExtmarkGeneration,
      } satisfies DraftExtmarkData,
    });
  }

  function insertDraftPart(
    id: string,
    placeholder: string,
  ): { readonly start: number; readonly end: number } {
    if (composer === undefined) return { start: 0, end: 0 };
    const start = composer.cursorOffset;
    composer.insertText(`${placeholder} `);
    createDraftExtmark(id, placeholder, start);
    return { start, end: start + editorOffsetWidth(placeholder) };
  }

  function restoreDraftExtmarks(): void {
    if (composer === undefined) return;
    composer.extmarks.clear();
    draftExtmarkGeneration += 1;
    draftParts.clear();
    const parts = [...state().files, ...state().pastedTexts];
    parts.forEach((part) => {
      draftParts.set(part.id, part);
      createDraftExtmark(part.id, part.placeholder, part.start);
      const imageNumber = /^\[Image (\d+)\]$/u.exec(part.placeholder)?.[1];
      if (imageNumber !== undefined)
        nextImageNumber = Math.max(nextImageNumber, Number(imageNumber));
    });
  }

  function syncExtmarkedDraftParts(): void {
    if (composer === undefined || draftPartTypeId === 0) return;
    const extmarks = composer.extmarks.getAll().flatMap((extmark) => {
      const data = decodeDraftExtmarkData(extmark.data);
      if (data === undefined) return [];
      return [{ extmark, data }];
    });
    if (extmarks.some(({ data }) => data.generation !== draftExtmarkGeneration)) {
      restoreDraftExtmarks();
      return;
    }
    const parts = extmarks.flatMap(({ extmark, data }) => {
      const part = draftParts.get(data.id);
      return part === undefined ? [] : [{ ...part, start: extmark.start, end: extmark.end }];
    });
    controller.syncDraftParts(
      parts.filter((part): part is DraftFile => "file" in part),
      parts.filter((part): part is DraftPastedText => "text" in part),
    );
  }

  function attachImage(bytes: Uint8Array, hintedMediaType?: string): void {
    const mediaType = imageMediaType(bytes, hintedMediaType);
    if (mediaType === undefined) {
      showNotice("unsupported clipboard image");
      return;
    }
    if (bytes.length > MAX_CLIPBOARD_IMAGE_BYTES) {
      showNotice("image exceeds 10 MB");
      return;
    }
    nextImageNumber += 1;
    const placeholder = `[Image ${nextImageNumber}]`;
    const filename = `clipboard-${nextImageNumber}.${imageExtension(mediaType)}`;
    const id = crypto.randomUUID();
    const position = insertDraftPart(id, placeholder);
    const file: DraftFile = {
      id,
      placeholder,
      ...position,
      file: {
        type: "file",
        mediaType,
        filename,
        url: `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`,
      },
    };
    showNotice(undefined);
    draftParts.set(file.id, file);
    batch(() => {
      if (composer !== undefined) controller.setEditor(composer.plainText);
      controller.addFile(file);
    });
  }

  function attachPastedText(text: string): void {
    const pastedContent = text.trim();
    const lineCount = (pastedContent.match(/\n/gu)?.length ?? 0) + 1;
    const id = crypto.randomUUID();
    const position = insertDraftPart(id, `[Pasted ~${lineCount} lines]`);
    const pastedText: DraftPastedText = {
      id,
      placeholder: `[Pasted ~${lineCount} lines]`,
      ...position,
      text: pastedContent,
    };
    draftParts.set(pastedText.id, pastedText);
    batch(() => {
      if (composer !== undefined) controller.setEditor(composer.plainText);
      controller.addPastedText(pastedText);
    });
  }

  async function onPaste(event: PasteEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();

    const mediaType = imageMediaType(event.bytes, event.metadata?.mimeType);
    if (event.metadata?.kind === "binary" || mediaType !== undefined) {
      attachImage(event.bytes, mediaType);
      return;
    }

    const text = stripAnsiSequences(decodePasteBytes(event.bytes))
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n");
    if (text.length > 0) {
      const pastedContent = text.trim();
      const lineCount = (pastedContent.match(/\n/gu)?.length ?? 0) + 1;
      if (lineCount >= 3 || pastedContent.length > 150) attachPastedText(text);
      else composer?.insertText(text);
      return;
    }

    await pasteClipboardImage();
  }

  async function pasteClipboardImage(): Promise<void> {
    const generation = draftGeneration;
    const read = await readClipboardImage();
    if (read.status === "error") {
      if (ClipboardImageTooLargeError.is(read.error) && generation === draftGeneration) {
        showNotice("image exceeds 10 MB");
      }
      return;
    }
    if (read.value !== undefined && generation === draftGeneration) {
      attachImage(read.value.bytes, read.value.mediaType);
    }
  }

  useKeyboard((event: KeyEvent) => {
    const currentSubagent = subagentView();
    if (currentSubagent !== undefined) {
      if (event.name === "escape") {
        event.preventDefault();
        event.stopPropagation();
        closeSubagent();
        return;
      }
      if (event.name === "pageup" && transcript !== undefined) {
        event.preventDefault();
        transcript.scrollBy(-Math.max(1, transcript.height - 2));
        return;
      }
      if (event.name === "pagedown" && transcript !== undefined) {
        event.preventDefault();
        transcript.scrollBy(Math.max(1, transcript.height - 2));
        return;
      }
      if (event.ctrl && event.name === "c") {
        event.preventDefault();
        event.stopPropagation();
        controller.ctrlC();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const currentPalette = palette();
    if (currentPalette !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      if (event.ctrl && event.name === "c") {
        closePalette();
        draftGeneration += 1;
        controller.ctrlC();
        return;
      }
      if (event.name === "escape") {
        closePalette();
        return;
      }
      if (
        event.name === "up" ||
        event.name === "down" ||
        (event.ctrl && (event.name === "p" || event.name === "n"))
      ) {
        const delta = event.name === "up" || event.name === "p" ? -1 : 1;
        setPalette({
          ...currentPalette,
          selected: movePaletteIndex(currentPalette.selected, delta, paletteItems().length),
        });
        return;
      }
      if (event.name === "backspace") {
        if (currentPalette.query.length === 0) {
          closePalette();
          return;
        }
        const characters = Array.from(currentPalette.query);
        characters.pop();
        setPalette({ ...currentPalette, query: characters.join(""), selected: 0 });
        return;
      }
      if (["return", "kpenter", "linefeed"].includes(event.name)) {
        void selectPaletteItem();
        return;
      }
      if (!event.ctrl && !event.meta && /^[^\p{C}]+$/u.test(event.sequence)) {
        setPalette({
          ...currentPalette,
          query: currentPalette.query + event.sequence,
          selected: 0,
        });
      }
      return;
    }

    if (bindingBusy()) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (
      (event.ctrl && (event.name === "-" || event.name === ".")) ||
      (event.super === true && event.name === "z")
    ) {
      // OpenTUI restores extmark history independently from text history.
      queueMicrotask(syncExtmarkedDraftParts);
    }

    if (
      state().phase === "idle" &&
      state().editor.length === 0 &&
      state().files.length === 0 &&
      !event.ctrl &&
      !event.meta &&
      isSlashPaletteKey(event)
    ) {
      event.preventDefault();
      event.stopPropagation();
      openPalette("commands");
      return;
    }
    if (
      event.name === "tab" &&
      !event.shift &&
      !event.ctrl &&
      !event.meta &&
      state().phase === "idle"
    ) {
      event.preventDefault();
      event.stopPropagation();
      void cycleProfile();
      return;
    }
    if (event.name === "escape") {
      event.preventDefault();
      event.stopPropagation();
      controller.escape();
      return;
    }
    if (event.ctrl && event.name === "c") {
      event.preventDefault();
      event.stopPropagation();
      draftGeneration += 1;
      controller.ctrlC();
      return;
    }
    if (event.ctrl && event.name === "v") {
      event.preventDefault();
      event.stopPropagation();
      void pasteClipboardImage();
      return;
    }
    if (event.name === "pageup" && transcript !== undefined) {
      event.preventDefault();
      transcript.scrollBy(-Math.max(1, transcript.height - 2));
      return;
    }
    if (event.name === "pagedown" && transcript !== undefined) {
      event.preventDefault();
      transcript.scrollBy(Math.max(1, transcript.height - 2));
      return;
    }

    if (!event.defaultPrevented && composer !== undefined && !composer.focused) composer.focus();
  });

  createEffect(() => {
    const value = state().editor;
    if (composer === undefined || composer.isDestroyed || composer.plainText === value) return;
    restoringDraft = true;
    try {
      composer.setText(value);
      restoreDraftExtmarks();
      composer.gotoBufferEnd();
    } finally {
      restoringDraft = false;
    }
  });

  onMount(() => {
    controller.start();
    queueMicrotask(() => composer?.focus());
  });
  onCleanup(() => {
    subagentAbortController?.abort();
    controller.dispose();
    markdownStyle.destroy();
    composerStyle.destroy();
  });

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={colors.background}>
      <scrollbox
        id="transcript-scrollbox"
        ref={(value: ScrollBoxRenderable) => (transcript = value)}
        flexGrow={1}
        minHeight={0}
        stickyScroll={true}
        stickyStart="bottom"
        viewportOptions={{ paddingRight: narrow() ? 0 : 1 }}
        verticalScrollbarOptions={{
          visible: !narrow(),
          trackOptions: { backgroundColor: colors.background, foregroundColor: colors.border },
        }}
      >
        <box
          width="100%"
          paddingLeft={narrow() ? 1 : 3}
          paddingRight={narrow() ? 0 : 2}
          paddingTop={1}
          paddingBottom={1}
          gap={1}
        >
          <Index each={displayEntries()}>
            {(entry) => (
              <Show
                when={entry().kind === "assistant"}
                fallback={
                  <box
                    width="100%"
                    flexShrink={0}
                    backgroundColor={transcriptEntryBackground(entry(), colors)}
                    border={transcriptEntryBorder(entry())}
                    borderColor={transcriptEntryBorderColor(entry())}
                    paddingLeft={
                      entry().kind === "user" ||
                      entry().kind === "compaction" ||
                      isToolTranscriptEntry(entry())
                        ? 1
                        : 0
                    }
                    paddingRight={entry().kind === "user" || isToolTranscriptEntry(entry()) ? 1 : 0}
                    paddingTop={entry().kind === "user" || entry().kind === "shell" ? 1 : 0}
                    paddingBottom={entry().kind === "user" || entry().kind === "shell" ? 1 : 0}
                    onMouseUp={(event: MouseEvent) => toggleTranscriptEntry(event, entry())}
                  >
                    <Show
                      when={entry().shell}
                      fallback={
                        <Show
                          when={entry().exploration}
                          fallback={
                            <Show
                              when={entry().edit}
                              fallback={
                                <text
                                  width="100%"
                                  wrapMode={entry().singleLine ? "none" : undefined}
                                  truncate={entry().singleLine === true}
                                  fg={transcriptEntryColor(entry())}
                                  selectable={true}
                                >
                                  {entryPrefix(entry())}
                                  {entryText(entry())}
                                </text>
                              }
                            >
                              {(edit) => (
                                <EditView
                                  edit={edit()}
                                  expanded={expandedEntries().has(entry().id)}
                                  narrow={narrow()}
                                  width={Math.max(1, dimensions().width - (narrow() ? 4 : 9))}
                                  toneColors={toneColors}
                                  colors={colors}
                                />
                              )}
                            </Show>
                          }
                        >
                          {(exploration) => (
                            <ExplorationView
                              exploration={exploration()}
                              running={entry().running === true}
                              expanded={expandedEntries().has(entry().id)}
                              narrow={narrow()}
                              colors={colors}
                            />
                          )}
                        </Show>
                      }
                    >
                      {(shell) => (
                        <ShellView
                          shell={shell()}
                          expanded={expandedEntries().has(entry().id)}
                          narrow={narrow()}
                          width={Math.max(1, dimensions().width - (narrow() ? 4 : 10))}
                          colors={colors}
                        />
                      )}
                    </Show>
                  </box>
                }
              >
                <markdown
                  width="100%"
                  content={entry().text}
                  syntaxStyle={markdownStyle}
                  streaming={entry().streaming === true}
                  conceal={true}
                  concealCode={false}
                  internalBlockMode="top-level"
                  tableOptions={{ style: "grid" }}
                  fg={colors.text}
                  bg={colors.background}
                  codeBlockBg={colors.panel}
                  codeBlockLabelBg={colors.raised}
                  codeBlockLabelFg={colors.syntaxType}
                />
              </Show>
            )}
          </Index>
        </box>
      </scrollbox>

      <box
        flexShrink={0}
        width="100%"
        paddingLeft={narrow() ? 1 : 3}
        paddingRight={narrow() ? 1 : 3}
        paddingBottom={1}
        gap={0}
      >
        <Show when={subagentView() === undefined && palette()}>
          <box
            width="100%"
            flexShrink={0}
            backgroundColor={colors.raised}
            border={true}
            borderColor={colors.border}
            title={paletteTitle()}
            titleColor={colors.accent}
            paddingTop={1}
            paddingBottom={1}
          >
            <For each={visiblePaletteItems()}>
              {(entry) => (
                <box
                  width="100%"
                  flexDirection="row"
                  maxHeight={
                    palette()?.kind === "sessions" || palette()?.kind === "todos" ? 2 : undefined
                  }
                  overflow={
                    palette()?.kind === "sessions" || palette()?.kind === "todos"
                      ? "hidden"
                      : undefined
                  }
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={
                    palette()?.selected === entry.index ? colors.selection : undefined
                  }
                >
                  <Show
                    when={palette()?.kind === "sessions" || palette()?.kind === "todos"}
                    fallback={
                      <text
                        width={narrow() ? 16 : 24}
                        flexShrink={0}
                        fg={paletteItemColor(palette()?.kind ?? "commands", entry.item)}
                      >
                        <span style={{ fg: colors.accent }}>
                          {palette()?.selected === entry.index ? "> " : "  "}
                        </span>
                        {entry.item.label}
                      </text>
                    }
                  >
                    <text
                      flexGrow={1}
                      flexShrink={1}
                      minWidth={0}
                      maxHeight={2}
                      overflow="hidden"
                      wrapMode="word"
                      fg={paletteItemColor(palette()?.kind ?? "commands", entry.item)}
                    >
                      <span style={{ fg: colors.accent }}>
                        {palette()?.selected === entry.index ? "> " : "  "}
                      </span>
                      {entry.item.label}
                    </text>
                  </Show>
                  <Show when={!narrow() && entry.item.description !== undefined}>
                    <text
                      flexGrow={
                        palette()?.kind === "sessions" || palette()?.kind === "todos" ? 0 : 1
                      }
                      flexShrink={0}
                      paddingLeft={
                        palette()?.kind === "sessions" || palette()?.kind === "todos" ? 1 : 0
                      }
                      wrapMode="none"
                      fg={colors.muted}
                    >
                      {entry.item.description}
                    </text>
                  </Show>
                </box>
              )}
            </For>
            <text fg={colors.muted}>
              {palette()?.kind === "todos"
                ? " ↑/↓ browse | type search | esc close"
                : " ↑/↓ select | type search | enter confirm"}
            </text>
          </box>
        </Show>
        <Show when={subagentView() === undefined && floatingTodo()}>
          {(summary) => (
            <box width="100%" height={1} position="relative" overflow="visible">
              <TodoOverlay
                state={todos()}
                summary={summary()}
                expanded={todoExpanded()}
                narrow={narrow()}
                colors={colors}
                onToggle={toggleTodoOverlay}
                onViewport={(viewport) => {
                  todoViewport = viewport;
                  if (todoExpanded()) scrollTodoToCurrent(viewport, summary().index);
                }}
              />
            </box>
          )}
        </Show>
        <Show when={subagentView() === undefined && steering().length > 0}>
          <box
            id="steering-queue"
            width="100%"
            flexShrink={0}
            maxHeight={steeringQueueHeight()}
            overflow="hidden"
            backgroundColor={colors.raised}
            border={["left"]}
            borderColor={colors.warning}
            paddingLeft={1}
            paddingRight={1}
          >
            <box width="100%" height={1} flexDirection="row">
              <text flexShrink={0} wrapMode="none" fg={colors.warning}>
                queued
              </text>
              <Show when={steering().length > 1}>
                <text flexGrow={1} minWidth={0} wrapMode="none" fg={colors.muted}>
                  {` ${steering().length} messages · send in order`}
                </text>
              </Show>
            </box>
            <For each={steering().slice(0, steeringQueueVisibleCount())}>
              {(message, index) => (
                <box
                  width="100%"
                  maxHeight={steeringQueueItemHeight()}
                  overflow="hidden"
                  flexDirection="row"
                >
                  <text flexShrink={0} wrapMode="none" fg={colors.warning}>
                    {`${index() + 1}. `}
                  </text>
                  <text
                    flexGrow={1}
                    minWidth={0}
                    maxHeight={steeringQueueItemHeight()}
                    overflow="hidden"
                    wrapMode={narrow() ? "none" : "word"}
                    truncate={narrow()}
                    fg={colors.text}
                    selectable={true}
                  >
                    {steeringPreview(message)}
                  </text>
                </box>
              )}
            </For>
            <Show when={steeringQueueShowsOverflow()}>
              <text height={1} wrapMode="none" fg={colors.muted}>
                {`+${steering().length - steeringQueueVisibleCount()} more queued`}
              </text>
            </Show>
          </box>
        </Show>
        <Show when={subagentView() === undefined}>
          <box
            id="composer-frame"
            width="100%"
            position="relative"
            backgroundColor={colors.panel}
            border={["left"]}
            borderColor={composerBorderColor()}
            paddingLeft={1}
            paddingRight={1}
            paddingTop={1}
            paddingBottom={1}
          >
            <textarea
              id="composer"
              ref={(value: TextareaRenderable) => {
                composer = value;
                draftPartTypeId = value.extmarks.registerType("draft-part");
                restoreDraftExtmarks();
              }}
              width="100%"
              minHeight={1}
              maxHeight={6}
              wrapMode="word"
              syntaxStyle={composerStyle}
              keyBindings={COMPOSER_KEY_BINDINGS}
              placeholder={
                state().phase === "active" ? "Steer the active run..." : "Ask anything..."
              }
              placeholderColor={colors.muted}
              textColor={colors.text}
              focusedTextColor={colors.text}
              backgroundColor={colors.panel}
              focusedBackgroundColor={colors.panel}
              cursorColor={colors.accent}
              onPaste={onPaste}
              onContentChange={() => {
                if (composer !== undefined) {
                  showNotice(undefined);
                  controller.setEditor(composer.plainText);
                  if (!restoringDraft) syncExtmarkedDraftParts();
                }
              }}
              onSubmit={() => {
                if (bindingBusy()) {
                  showNotice("switching session");
                  return;
                }
                const value = composer?.plainText ?? "";
                const command = value.trim().toLowerCase();
                if (command === "/todo") {
                  controller.setEditor("");
                  openTodoPalette();
                  return;
                }
                if (
                  command === "/new" ||
                  command === "/model" ||
                  command === "/reasoning" ||
                  command === "/session" ||
                  command === "/skills"
                ) {
                  if (state().phase !== "idle") {
                    showNotice("interrupt active work before switching");
                    return;
                  }
                  controller.setEditor("");
                  if (command === "/new") {
                    void startNewSession();
                  } else if (command === "/session") {
                    void openSessionPalette();
                  } else if (command === "/skills") {
                    void openSkillsPalette();
                  } else {
                    openPalette(command === "/model" ? "models" : "reasoning");
                  }
                  return;
                }
                controller.setEditor(value);
                draftGeneration += 1;
                controller.submit();
              }}
            />
            <Show when={busy()}>
              <text
                position="absolute"
                top={1}
                right={1}
                zIndex={20}
                wrapMode="none"
                fg={colors.success}
                bg={colors.panel}
              >
                {workingHint()}
              </text>
            </Show>
          </box>
        </Show>
        <Show when={subagentView()}>
          {(view) => (
            <box
              width="100%"
              flexDirection="row"
              justifyContent="space-between"
              backgroundColor={colors.panel}
              border={["left"]}
              borderColor={subagentViewBorderColor(view(), colors)}
              paddingLeft={1}
              paddingRight={1}
              paddingTop={1}
              paddingBottom={1}
            >
              <text fg={colors.accent}>{`${view().subagent.profile} subagent`}</text>
              <text fg={colors.muted}>{subagentViewStatus(view())}</text>
            </box>
          )}
        </Show>
        <box width="100%" flexDirection="row" paddingLeft={1} paddingRight={1} paddingTop={1}>
          <text
            flexGrow={1}
            flexShrink={1}
            minWidth={0}
            wrapMode="none"
            truncate={true}
            fg={colors.text}
          >
            {subagentView() === undefined
              ? formatSessionTitle(session().title)
              : truncateEnd(subagentView()?.subagent.prompt ?? "Subagent", 80)}
          </text>
          <text flexShrink={0} wrapMode="none" fg={colors.muted}>
            {` | ${cwdLabel()}`}
          </text>
        </box>
        <box
          id="session-status"
          width="100%"
          flexDirection="row"
          justifyContent="space-between"
          paddingLeft={1}
          paddingRight={1}
        >
          <Show
            when={subagentView() === undefined}
            fallback={
              <>
                <text flexGrow={1} minWidth={0} wrapMode="none" truncate={true}>
                  <span style={{ fg: colors.accent }}>
                    {subagentView()?.subagent.profile ?? "subagent"}
                  </span>
                  <span style={{ fg: colors.muted }}> | subagent transcript | </span>
                  <span style={{ fg: colors.warning }}>read-only</span>
                </text>
                <text flexShrink={0} fg={colors.accent}>
                  esc parent | page up/down scroll
                </text>
              </>
            }
          >
            <text flexGrow={1} flexShrink={1} minWidth={0} wrapMode="none" truncate={true}>
              <span style={{ fg: workingStatusFrame().color }}>
                {`${workingStatusFrame().glyph} `}
              </span>
              <span style={{ fg: colors.text }}>{workingStatus()}</span>
              <Show when={phaseText().length > 0}>
                <span style={{ fg: phaseColor() }}>{` · ${phaseText()}`}</span>
              </Show>
            </text>
            <text flexShrink={1} minWidth={0} wrapMode="none" truncate={true}>
              <span style={{ fg: colors.accent }}>{profileLabel()}</span>
              <span style={{ fg: colors.muted }}> | </span>
              <span style={{ fg: colors.model }}>{modelLabel()}</span>
              <span style={{ fg: colors.muted }}> | </span>
              <span style={{ fg: colors.warning }}>{reasoningLabel()}</span>
              <span style={{ fg: colors.muted }}>
                {tokenUsage() === undefined ? "" : ` | ${tokenUsage()}`}
              </span>
            </text>
          </Show>
        </box>
      </box>
    </box>
  );
}
