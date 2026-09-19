import {
  lazy,
  Suspense,
  useMemo,
  useCallback,
  useRef,
  useState,
  type KeyboardEvent,
  type ClipboardEvent,
  type DragEvent,
} from "react";
import { ArrowUp, Paperclip, Square, X, FileText, CornerDownRight } from "lucide-react";
import type { Completion } from "@stanley2058/lilac-client";
import type { ChatCommon, ComposerSubmission, Attachment } from "../types";
import { IconButton, VirtualList, ErrorNotice } from "./ui";
import type { ComposerEditorHandle } from "./composer-editor";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "./ui/select";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover";

const ComposerEditor = lazy(() => import("./composer-editor"));

import { inputDeliveryOptions } from "../input-mode";

export type ComposerProps = Pick<ChatCommon, "client" | "scope" | "catalog"> & {
  text: string;
  skillIds: string[];
  onSkills: (ids: string[]) => void;
  commandId?: string;
  onCommand: (id: string | undefined) => void;
  onText: (text: string) => void;
  attachments: readonly Attachment[];
  onAttach: (files: File[]) => void;
  onRemoveAttachment: (key: string) => void;
  onRetryAttachment: (key: string) => void;
  active: boolean;
  canCancel: boolean;
  disabled: boolean;
  submitting?: boolean;
  modelId?: string;
  onModelChange: (modelId: string) => void;
  onSubmit: (value: ComposerSubmission) => void;
  onCancel: () => void;
};

export function Composer(props: ComposerProps) {
  const { text, onText, attachments, active, disabled, catalog } = props;
  const input = useRef<ComposerEditorHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const insertingCompletion = useRef(false);
  const [mode, setMode] = useState<"steer" | "followup">("steer");
  const commandId = props.commandId;
  const setCommandId = props.onCommand;
  const [error, setError] = useState<string>();
  const skillIds = props.skillIds;
  const setSkills = props.onSkills;
  const [editorValue, setEditorValue] = useState<{ text: string; plainText: string }>();
  const plainText = editorValue?.plainText ?? "";
  const editorReady = editorValue?.text === text;
  const updatePlainText = useCallback(
    (plainText: string, text: string) => setEditorValue({ text, plainText }),
    [],
  );
  const [prefix, setPrefix] = useState("");
  const [selected, setSelected] = useState(0);
  const [menuHidden, setMenuHidden] = useState(false);
  const [dragging, setDragging] = useState(false);
  const match = /(?:^|\s)([$/])([^$/\n]*)$/.exec(prefix);
  const trigger = match?.[1] === "$" ? "$" : "/";
  const query = match?.[2]?.replace(/^skill:/, "") ?? "";
  const completions = useMemo(
    () =>
      match && !menuHidden
        ? props.client.catalogs
            .complete(props.scope, trigger, query, 100)
            .filter((item) => !match[2]?.startsWith("skill:") || item.kind === "skill")
        : [],
    [props.client, props.scope, trigger, query, !!match, menuHidden, catalog],
  );
  const highlighted = Math.min(selected, Math.max(0, completions.length - 1));
  const matching =
    catalog?.commands.filter(
      (entry) => plainText.trim() === `/${entry.name}` || plainText.startsWith(`/${entry.name} `),
    ) ?? [];
  const unambiguous = matching.length === 1 ? matching[0] : undefined;
  const command = commandId ? matching.find((entry) => entry.id === commandId) : unambiguous;
  const custom = command?.kind === "custom" ? command : undefined;
  const delivery = inputDeliveryOptions(active, mode, props.modelId, !!custom);

  function choose(item: Completion) {
    insertingCompletion.current = true;
    input.current?.complete(item.insertText, (match?.[2]?.length ?? 0) + 1);
    if (item.kind === "skill") setSkills([...new Set([...skillIds, item.id])].slice(0, 32));
    if (item.kind !== "skill") setCommandId(item.id);
    setError(undefined);
    setMenuHidden(true);
  }

  function submit() {
    if (disabled || !editorReady || props.submitting || (!text.trim() && attachments.length === 0))
      return;
    if (text.length > 65_536) {
      setError("Messages can contain up to 65,536 characters.");
      return;
    }
    if (!commandId && matching.length > 1) {
      setError("Choose the command from the menu to resolve its name.");
      return;
    }
    if (commandId && !command) {
      setCommandId(undefined);
      setError("The selected command changed. Choose it again.");
      return;
    }
    if (command?.kind === "builtin" && command.id === "cancel") {
      props.onCancel();
      onText("");
      setCommandId(undefined);
      return;
    }
    if (command?.kind === "builtin" && command.id === "model") {
      document.getElementById("composer-model")?.focus();
      onText("");
      setCommandId(undefined);
      return;
    }
    props.onSubmit({
      text,
      skillIds,
      mode: delivery.mode === "prompt" ? mode : delivery.mode,
      modelId: delivery.modelId,
      command: custom
        ? { id: custom.id, arguments: plainText.slice(custom.name.length + 2) }
        : undefined,
      attachments: [...attachments],
    });
    setSkills([]);
    setCommandId(undefined);
    setError(undefined);
    setMenuHidden(true);
  }

  function keydown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing) return;
    if (
      completions.length &&
      ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)
    ) {
      event.preventDefault();
      if (event.key === "Escape") {
        setMenuHidden(true);
        return;
      }
      if (event.key === "ArrowDown") {
        setSelected((value) => (value + 1) % completions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        setSelected((value) => (value + completions.length - 1) % completions.length);
        return;
      }
      const completion = completions[highlighted];
      if (completion) choose(completion);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }
  function paste(event: ClipboardEvent<HTMLDivElement>) {
    const files = [...event.clipboardData.files];
    if (files.length) {
      event.preventDefault();
      props.onAttach(files);
    }
  }
  function drop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    props.onAttach([...event.dataTransfer.files]);
  }

  return (
    <div
      className={`composer-wrap ${dragging ? "is-dragging" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={drop}
    >
      <Popover
        open={completions.length > 0}
        onOpenChange={(open) => {
          if (!open) setMenuHidden(true);
        }}
      >
        <PopoverTrigger
          render={<span className="composer-completion-anchor" />}
          tabIndex={-1}
          aria-hidden
        />
        <PopoverContent
          side="top"
          align="start"
          initialFocus={false}
          finalFocus={false}
          className="completion-popover"
          id="composer-completions"
          role="listbox"
          aria-label={trigger === "$" ? "Skills" : "Commands and skills"}
        >
          <VirtualList
            items={completions}
            itemKey={(item) => `${item.kind}:${item.id}`}
            label="Suggestions"
            presentation
            activeIndex={highlighted}
            estimate={44}
            render={(item, index) => (
              <button
                type="button"
                role="option"
                aria-selected={index === highlighted}
                id={`completion-${index}`}
                className={`completion ${index === highlighted ? "selected" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(item)}
              >
                <span className="completion-name">
                  {trigger === "/" ? item.insertText : item.name}
                </span>
                <span className="completion-description">{item.description}</span>
                {item.source ? <span className="badge">{item.source}</span> : null}
              </button>
            )}
          />
        </PopoverContent>
      </Popover>
      <ErrorNotice message={error} onDismiss={() => setError(undefined)} />
      <div className="composer">
        {attachments.length ? (
          <div className="attachment-list">
            {attachments.map((attachment) => (
              <div className="attachment" key={attachment.key}>
                {attachment.preview ? (
                  <img src={attachment.preview} alt={attachment.file.name} />
                ) : (
                  <FileText />
                )}
                <span className="attachment-info">
                  <span>{attachment.file.name}</span>
                  <small>
                    {attachment.state === "failed"
                      ? attachment.error
                      : `${Math.round(attachment.file.size / 1024)} KB`}
                  </small>
                  {attachment.state === "uploading" ? (
                    <progress
                      value={attachment.progress}
                      max={1}
                      aria-label={`Uploading ${attachment.file.name}`}
                    />
                  ) : null}
                  {attachment.state === "failed" ? (
                    <button type="button" onClick={() => props.onRetryAttachment(attachment.key)}>
                      Retry
                    </button>
                  ) : null}
                </span>
                <IconButton
                  label={`Remove ${attachment.file.name}`}
                  onClick={() => props.onRemoveAttachment(attachment.key)}
                >
                  <X />
                </IconButton>
              </div>
            ))}
          </div>
        ) : null}
        {skillIds.length ? (
          <div className="skill-chips">
            {skillIds.map((id) => (
              <button
                type="button"
                className="badge"
                key={id}
                onClick={() => setSkills(skillIds.filter((item) => item !== id))}
              >
                {catalog?.skills.find((skill) => skill.id === id)?.name ?? id}
                <X />
              </button>
            ))}
          </div>
        ) : null}
        <Suspense fallback={<div className="composer-editor" aria-label="Loading editor" />}>
          <ComposerEditor
            ref={input}
            text={text}
            onText={(value, visibleText) => {
              setEditorValue({ text: value, plainText: visibleText });
              if (insertingCompletion.current) {
                insertingCompletion.current = false;
                onText(value);
                setMenuHidden(true);
                return;
              }
              const chosen = catalog?.commands.find((entry) => entry.id === commandId);
              if (
                chosen &&
                visibleText.trim() !== `/${chosen.name}` &&
                !visibleText.startsWith(`/${chosen.name} `)
              )
                setCommandId(undefined);
              setSkills(
                skillIds.filter((id) => {
                  const skill = catalog?.skills.find((item) => item.id === id);
                  return !!skill && hasSkillMention(visibleText, skill.name);
                }),
              );
              onText(value);
              setMenuHidden(false);
              setSelected(0);
            }}
            onPlainText={updatePlainText}
            onPrefix={setPrefix}
            onKeyDown={keydown}
            onPaste={paste}
            placeholder={active ? "Steer Lilac, or queue a follow-up…" : "Message Lilac…"}
            expanded={completions.length > 0}
            activeDescendant={completions.length ? `completion-${highlighted}` : undefined}
            disabled={disabled}
          />
        </Suspense>
        <footer className="composer-toolbar">
          <Select
            items={catalog?.models.map((model) => ({ value: model.id, label: model.label }))}
            value={props.modelId ?? catalog?.models[0]?.id ?? ""}
            disabled={disabled || delivery.mode === "steer"}
            onValueChange={(value) => {
              if (!value) return;
              props.onModelChange(value);
            }}
          >
            <SelectTrigger
              id="composer-model"
              aria-label="Response model"
              className="composer-model min-w-0 max-w-full"
            >
              <SelectValue className="min-w-0">
                <span className="truncate">
                  {
                    catalog?.models.find(
                      (entry) => entry.id === (props.modelId ?? catalog.models[0]?.id),
                    )?.label
                  }
                </span>
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {catalog?.models.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="toolbar-spacer" />
          {active ? (
            <div className="queue-mode">
              <CornerDownRight />
              <Select
                disabled={!!custom}
                value={delivery.mode}
                onValueChange={(value) => setMode(value === "followup" ? "followup" : "steer")}
              >
                <SelectTrigger
                  aria-label={
                    custom
                      ? "Custom commands queue as follow-ups"
                      : "When sent during an active run"
                  }
                >
                  <SelectValue>
                    {delivery.mode === "followup" ? "Follow-up" : "Steering"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="steer">Steering</SelectItem>
                  <SelectItem value="followup">Follow-up</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <input
            ref={fileInput}
            type="file"
            aria-label="Attach files"
            multiple
            className="sr-only"
            tabIndex={-1}
            onChange={(event) => {
              props.onAttach([...(event.target.files ?? [])]);
              event.target.value = "";
            }}
          />
          <IconButton
            label="Attach files"
            disabled={disabled}
            onClick={() => fileInput.current?.click()}
          >
            <Paperclip />
          </IconButton>
          {props.canCancel ? (
            <IconButton label="Cancel run" className="cancel-button" onClick={props.onCancel}>
              <Square />
            </IconButton>
          ) : null}
          <IconButton
            label={active && custom ? "Queue command as follow-up" : "Send message"}
            className="send-button"
            disabled={
              disabled || !editorReady || props.submitting || (!text.trim() && !attachments.length)
            }
            onClick={submit}
          >
            <ArrowUp />
          </IconButton>
        </footer>
      </div>
    </div>
  );
}

export function hasSkillMention(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)(?:\\$|/skill:)${escaped}(?=$|[^\\p{L}\\p{N}_-])`, "u").test(text);
}
