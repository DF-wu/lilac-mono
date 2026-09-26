import { toast } from "./ui/toast";
import { Kbd } from "./ui/kbd";
import { useEventCallback } from "../use-event-callback";
import { Result } from "better-result";
import { useOptionalWorkspace } from "../workspace-context";
import "./composer-rich.css";
import { Button } from "./ui/button";
import {
  memo,
  lazy,
  Suspense,
  useMemo,
  useEffect,
  useContext,
  useCallback,
  useRef,
  useState,
  type KeyboardEvent,
  type ClipboardEvent,
  type DragEvent,
} from "react";
import { ArrowUp, Paperclip, Square, X, Upload } from "lucide-react";
import { createPortal } from "react-dom";
import { hasFileDrag, installWindowFileDrop } from "../window-file-drop";
import "./composer-drop.css";
import type { Completion } from "@stanley2058/lilac-client";
import type { ChatCommon, ComposerSubmission, Attachment } from "../types";
import { readMessageClipboard, type MessageClipboard } from "../message-clipboard";
import { IconButton, VirtualList, attempt } from "./ui";
import type { ComposerEditorHandle } from "./composer-editor";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "./ui/select";
import { Popover, PopoverTrigger, PopoverContent } from "./ui/popover";

const ComposerEditor = lazy(() => import("./composer-editor"));

import { MessageIdentityContext } from "./message-identity";
import { inputDeliveryOptions } from "../input-mode";

export type ComposerProps = Partial<Pick<ChatCommon, "client" | "scope" | "catalog">> & {
  text: string;
  documentKey?: string;
  loadingDraft?: boolean;
  autoFocus?: boolean;
  skillIds: string[];
  onSkills: (ids: string[]) => void;
  commandId?: string;
  onCommand: (id: string | undefined) => void;
  onText: (text: string) => void;
  attachments: readonly Attachment[];
  onAttach: (files: File[], requireAll?: boolean) => Attachment[] | void;
  onRemoveAttachment: (key: string) => void;
  onRetryAttachment: (key: string) => void;
  active: boolean;
  canCancel: boolean;
  disabled: boolean;
  windowDrop?: boolean;
  submitting?: boolean;
  offline?: boolean;
  modelId?: string;
  onModelChange: (modelId: string) => void;
  onSubmit: (value: ComposerSubmission) => void;
  onCancel: () => void;
};

export const Composer = memo(function Composer(props: ComposerProps) {
  const workspace = useOptionalWorkspace();
  const client = props.client ?? workspace?.client;
  const scope = props.scope ?? workspace?.scope;
  const { agent } = useContext(MessageIdentityContext);
  const { text, onText, attachments, active, disabled, catalog } = props;
  const placeholder = active
    ? `Steer ${agent.displayName}, or queue a follow-up…`
    : `Message ${agent.displayName}…`;
  const input = useRef<ComposerEditorHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const insertingCompletion = useRef(false);
  const [mode, setMode] = useState<"steer" | "followup">("steer");
  const commandId = props.commandId;
  const setCommandId = props.onCommand;
  const skillIds = props.skillIds;
  const setSkills = props.onSkills;
  const [editorValue, setEditorValue] = useState<{
    text: string;
    plainText: string;
    documentKey?: string;
  }>();
  const plainText = editorValue?.plainText ?? "";
  const editorReady = editorValue?.text === text && editorValue?.documentKey === props.documentKey;
  const updatePlainText = useCallback(
    (plainText: string, text: string) =>
      setEditorValue((current) =>
        current?.text === text &&
        current.plainText === plainText &&
        current.documentKey === props.documentKey
          ? current
          : { text, plainText, documentKey: props.documentKey },
      ),
    [props.documentKey],
  );
  const [prefix, setPrefix] = useState("");
  const [selected, setSelected] = useState(0);
  const [menuHidden, setMenuHidden] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [documentKey, setDocumentKey] = useState(props.documentKey);
  if (documentKey !== props.documentKey) {
    setDocumentKey(props.documentKey);
    setMode("steer");
    setPrefix("");
    setSelected(0);
    setMenuHidden(false);
    setDragging(false);
  }
  const dropProps = useRef(props);
  dropProps.current = props;
  useEffect(() => {
    if (!props.windowDrop) return;
    return installWindowFileDrop(window, {
      canAttach: () => !dropProps.current.disabled,
      show: setDragging,
      attach: (files) => dropProps.current.onAttach(files),
    });
  }, [props.windowDrop]);
  const match = /(?:^|\s)([$/])([^$/\n]*)$/.exec(prefix);
  const trigger = match?.[1] === "$" ? "$" : "/";
  const query = match?.[2] ?? "";
  const completions = useMemo(
    () =>
      match && !menuHidden && client && scope
        ? client.catalogs.complete(scope, trigger, query, 100)
        : [],
    [client, scope, trigger, query, !!match, menuHidden, catalog],
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
    setMenuHidden(true);
  }

  function submit() {
    if (
      disabled ||
      props.offline ||
      !editorReady ||
      props.submitting ||
      (!text.trim() && attachments.length === 0)
    )
      return;
    if (input.current?.hasMissingAttachments()) {
      toast.add({ title: "Reattach or remove the missing files before sending.", type: "error" });
      return;
    }
    if (text.length > 65_536) {
      toast.add({ title: "Messages can contain up to 65,536 characters.", type: "error" });
      return;
    }
    if (!commandId && matching.length > 1) {
      toast.add({ title: "Choose the command from the menu to resolve its name.", type: "error" });
      return;
    }
    if (commandId && !command) {
      setCommandId(undefined);
      toast.add({ title: "The selected command changed. Choose it again.", type: "error" });
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
      text: input.current?.submissionText() ?? text,
      ...(attachments.length ? { attachmentText: text } : {}),
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
      if (window.matchMedia("(pointer: coarse)").matches) return;
      event.preventDefault();
      submit();
    }
  }
  const pastes = useRef(new Set<{ controller: AbortController; cancel: () => void }>());
  useEffect(
    () => () => {
      for (const paste of pastes.current) {
        paste.controller.abort();
        paste.cancel();
      }
      pastes.current.clear();
    },
    [props.documentKey],
  );

  async function pasteMessage(message: MessageClipboard) {
    const editor = input.current;
    const resourceUrl = workspace?.resourceUrl;
    if (!editor || !resourceUrl) return;
    const documentKey = props.documentKey;
    const target = editor.capturePaste();
    const controller = new AbortController();
    const paste = { controller, cancel: target.cancel };
    pastes.current.add(paste);
    await attempt(
      async () => {
        const downloads = await Promise.all(
          message.resources.map(async (resource) => {
            const response = await fetch(resourceUrl(resource.resourceId), {
              signal: controller.signal,
            });
            if (!response.ok) return Result.err(`Could not copy attachment ${resource.name}`);
            return Result.ok(
              new File([await response.blob()], resource.name, { type: resource.mediaType }),
            );
          }),
        );
        const files = Result.all(downloads).match({
          ok: (files) => files,
          err: (message) => {
            if (!controller.signal.aborted && dropProps.current.documentKey === documentKey)
              toast.add({ title: message, type: "error" });
            return undefined;
          },
        });
        if (!files) return;
        const { restoreMessageAttachments } = await import("./composer-editor");
        if (
          controller.signal.aborted ||
          dropProps.current.documentKey !== documentKey ||
          dropProps.current.disabled
        )
          return;
        if (dropProps.current.attachments.length + files.length > 32) {
          toast.add({ title: "A message can contain at most 32 attachments.", type: "error" });
          return;
        }
        const added = dropProps.current.onAttach(files, true);
        if (!added || added.length !== files.length) {
          toast.add({ title: "A message can contain at most 32 attachments.", type: "error" });
          return;
        }
        target.insert(
          restoreMessageAttachments(
            message.text,
            new Map(
              message.resources.map((resource, index) => [resource.resourceId, added[index]!]),
            ),
          ),
        );
      },
      (message) => {
        if (!controller.signal.aborted && dropProps.current.documentKey === documentKey)
          toast.add({ title: message, type: "error" });
      },
    );
    controller.abort();
    target.cancel();
    pastes.current.delete(paste);
  }

  function paste(event: ClipboardEvent<HTMLDivElement>) {
    if (disabled) return;
    const message = readMessageClipboard(event.clipboardData.getData("text/html"));
    if (message && workspace) {
      event.preventDefault();
      void pasteMessage(message);
      return;
    }
    const files = [...event.clipboardData.files];
    if (files.length) {
      event.preventDefault();
      props.onAttach(files);
    }
  }
  function drop(event: DragEvent) {
    if (!hasFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    setDragging(false);
    if (disabled) return;
    props.onAttach([...event.dataTransfer.files]);
  }

  const changeText = useEventCallback((value: string, visibleText: string) => {
    setEditorValue({
      text: value,
      plainText: visibleText,
      documentKey: props.documentKey,
    });
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
  });
  const editorKeyDown = useEventCallback(keydown);
  const editorPaste = useEventCallback(paste);

  return (
    <div
      className={`composer-wrap relative ${dragging ? "is-dragging" : ""}`}
      onDragOver={
        props.windowDrop
          ? undefined
          : (event) => {
              if (!hasFileDrag(event.dataTransfer)) return;
              event.preventDefault();
              setDragging(!disabled);
            }
      }
      onDragLeave={props.windowDrop ? undefined : () => setDragging(false)}
      onDrop={props.windowDrop ? undefined : drop}
    >
      {props.windowDrop && dragging && !disabled
        ? createPortal(
            <div
              className="composer-window-drop fixed inset-3 z-100 flex items-center justify-center flex-col gap-4 rounded-lg [background:color-mix(in_srgb,_var(--ui-background)_88%,_transparent)] [backdrop-filter:blur(calc(var(--ui-space-unit)*1))] text-foreground text-xl font-medium pointer-events-none [box-shadow:inset_0_0_0_calc(var(--ui-space-unit)*1)_color-mix(in_srgb,_var(--ui-primary)_65%,_transparent)]"
              role="status"
            >
              <Upload aria-hidden="true" />
              <span>Add photos &amp; files</span>
            </div>,
            document.body,
          )
        : null}
      <Popover
        open={completions.length > 0}
        onOpenChange={(open) => {
          if (!open) setMenuHidden(true);
        }}
      >
        <PopoverTrigger
          nativeButton={false}
          render={<span className="composer-completion-anchor block w-full h-0" />}
          tabIndex={-1}
          aria-hidden
        />
        <PopoverContent
          side="top"
          align="start"
          initialFocus={false}
          finalFocus={false}
          className="completion-popover absolute left-0 right-0 bottom-[calc(100%_+_calc(var(--ui-space-unit)*2))] h-80 p-[calc(calc(var(--ui-space-unit)*1)_*_1.5)] rounded-lg bg-surface-raised shadow-overlay z-20"
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
                className={`completion flex items-center gap-2 w-full p-3 text-left rounded-sm text-sm ${index === highlighted ? "selected" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(item)}
              >
                <span className="completion-name font-[550] whitespace-nowrap">
                  {trigger === "/" ? item.insertText : item.name}
                </span>
                <span className="completion-description flex-1 whitespace-nowrap overflow-hidden text-ellipsis text-muted-foreground">
                  {item.description}
                </span>
                {item.source ? (
                  <span className="badge inline-flex items-center gap-1 bg-surface-hover text-muted-foreground rounded-sm py-1 px-2 text-xs whitespace-nowrap">
                    {item.source}
                  </span>
                ) : null}
              </button>
            )}
          />
        </PopoverContent>
      </Popover>
      <div className="composer bg-surface text-card-foreground rounded-lg p-3">
        {skillIds.length ? (
          <div className="skill-chips">
            {skillIds.map((id) => (
              <button
                type="button"
                className="badge inline-flex items-center gap-1 bg-surface-hover text-muted-foreground rounded-sm py-1 px-2 text-xs whitespace-nowrap"
                key={id}
                onClick={() => setSkills(skillIds.filter((item) => item !== id))}
              >
                {catalog?.skills.find((skill) => skill.id === id)?.name ?? id}
                <X />
              </button>
            ))}
          </div>
        ) : null}
        <Suspense
          fallback={
            <div role="status" aria-label="Loading editor">
              <div className="composer-formatting flex gap-1 px-1 flex-wrap" aria-hidden="true">
                {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((index) => (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="icon-button rounded-sm text-muted-foreground"
                    disabled
                    key={index}
                  />
                ))}
              </div>
              <div className="composer-editor" />
            </div>
          }
        >
          <ComposerEditor
            documentKey={props.documentKey}
            loadingDraft={props.loadingDraft}
            autoFocus={props.autoFocus}
            ref={input}
            text={text}
            attachments={attachments}
            onRemoveAttachment={props.onRemoveAttachment}
            onRetryAttachment={props.onRetryAttachment}
            onText={changeText}
            onPlainText={updatePlainText}
            onPrefix={setPrefix}
            onKeyDown={editorKeyDown}
            onPaste={editorPaste}
            placeholder={placeholder}
            expanded={completions.length > 0}
            activeDescendant={completions.length ? `completion-${highlighted}` : undefined}
            disabled={disabled}
          />
        </Suspense>
        <footer className="composer-toolbar pl-2 flex flex-wrap gap-1 items-center pt-2">
          <ComposerModel
            models={catalog?.models}
            modelId={props.modelId}
            disabled={disabled || delivery.mode === "steer"}
            onChange={props.onModelChange}
          />
          <span className="toolbar-spacer flex-1" />
          {active ? (
            <div className="queue-mode flex shrink-0 items-center text-muted-foreground">
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
                  <SelectValue>{delivery.mode === "followup" ? "Queue" : "Steer"}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="steer">Steer</SelectItem>
                  <SelectItem value="followup">Queue</SelectItem>
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <input
            ref={fileInput}
            type="file"
            aria-label="Attach files"
            multiple
            className="sr-only absolute w-px h-px overflow-hidden [clip:rect(0,_0,_0,_0)] whitespace-nowrap"
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
            <IconButton
              label="Cancel run"
              variant="destructive"
              className="rounded-full"
              onClick={props.onCancel}
            >
              <Square />
            </IconButton>
          ) : null}
          <IconButton
            label={active && custom ? "Queue command as follow-up" : "Send message"}
            tooltip={
              <>
                {active && custom ? "Queue command as follow-up" : "Send message"}
                <Kbd>Enter</Kbd>
              </>
            }
            aria-keyshortcuts="Enter"
            variant="default"
            className="rounded-full"
            disabled={
              disabled ||
              props.offline ||
              !editorReady ||
              props.submitting ||
              (!text.trim() && !attachments.length)
            }
            onClick={submit}
          >
            <ArrowUp />
          </IconButton>
        </footer>
      </div>
    </div>
  );
});

export function hasSkillMention(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\s)(?:\\$|/skill:)${escaped}(?=$|[^\\p{L}\\p{N}_-])`, "u").test(text);
}

const ComposerModel = memo(function ComposerModel({
  models,
  modelId,
  disabled,
  onChange,
}: {
  models: NonNullable<ComposerProps["catalog"]>["models"] | undefined;
  modelId?: string;
  disabled: boolean;
  onChange: (modelId: string) => void;
}) {
  return (
    <Select
      items={models?.map((model) => ({ value: model.id, label: model.label }))}
      value={modelId ?? models?.[0]?.id ?? ""}
      disabled={disabled}
      onValueChange={(value) => {
        if (!value) return;
        onChange(value);
      }}
    >
      <SelectTrigger
        id="composer-model"
        aria-label="Response model"
        className="composer-model [flex:0_1_auto] min-w-0 max-w-full"
      >
        <SelectValue className="min-w-0">
          <span className="truncate">
            {models?.find((entry) => entry.id === (modelId ?? models?.[0]?.id))?.label}
          </span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {models?.map((model) => (
          <SelectItem key={model.id} value={model.id}>
            {model.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
});
