import { parseReferenceHref, referenceHref } from "@stanley2058/lilac-client-protocol";
import { ConversationBadge } from "./ConversationReference";
import { FileIcon } from "./FileIcon";
import { FileActions } from "./FileActions";
import { useOptionalWorkspace } from "../workspace-context";
import {
  memo,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  useRef,
  type Ref,
  type KeyboardEvent,
  type ClipboardEvent,
} from "react";
import {
  Plate,
  PlateContent,
  PlateElement,
  PlateLeaf,
  ParagraphPlugin,
  createPlateEditor,
  createPlatePlugin,
  usePlateEditor,
  type PlateEditor,
  type PlateElementProps,
  type PlateLeafProps,
  type RenderNodeWrapper,
} from "platejs/react";
import {
  KEYS,
  NodeApi,
  TextApi,
  type TElement,
  type TListProps,
  type Descendant,
  type TNode,
} from "platejs";
import {
  BoldRules,
  ItalicRules,
  StrikethroughRules,
  CodeRules,
  HeadingRules,
  BlockquoteRules,
} from "@platejs/basic-nodes";
import {
  BoldPlugin,
  ItalicPlugin,
  StrikethroughPlugin,
  CodePlugin,
  H1Plugin,
  H2Plugin,
  H3Plugin,
  BlockquotePlugin,
} from "@platejs/basic-nodes/react";
import { CodeBlockRules } from "@platejs/code-block";
import { CodeBlockPlugin, CodeLinePlugin } from "@platejs/code-block/react";
import { BulletedListRules, OrderedListRules, toggleList } from "@platejs/list";
import { ListPlugin } from "@platejs/list/react";
import { IndentPlugin } from "@platejs/indent/react";
import { MarkdownPlugin, defaultRules } from "@platejs/markdown";
import remarkGfm from "remark-gfm";
import { editableComposerLinks, protectComposerLinks } from "./composer-links";
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Heading2,
  Quote,
  List,
  ListOrdered,
  SquareCode,
  X,
  RotateCcw,
} from "lucide-react";
import { IconButton } from "./ui";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import type { Attachment } from "../types";

function Paragraph(props: PlateElementProps) {
  return <PlateElement {...props} as="p" />;
}
function HeadingOne(props: PlateElementProps) {
  return <PlateElement {...props} as="h1" />;
}
function HeadingTwo(props: PlateElementProps) {
  return <PlateElement {...props} as="h2" />;
}
function HeadingThree(props: PlateElementProps) {
  return <PlateElement {...props} as="h3" />;
}
function QuoteElement(props: PlateElementProps) {
  return <PlateElement {...props} as="blockquote" />;
}
function CodeBlock(props: PlateElementProps) {
  return (
    <PlateElement {...props} as="pre">
      <code>{props.children}</code>
    </PlateElement>
  );
}
function CodeLine(props: PlateElementProps) {
  return <PlateElement {...props} as="div" />;
}
function InlineCode(props: PlateLeafProps) {
  return <PlateLeaf {...props} as="code" />;
}

const attachmentType = "composer_attachment";
const emptyAttachments: readonly Attachment[] = [];
const AttachmentContext = createContext<{
  attachments: readonly Attachment[];
  disabled: boolean;
  retry?: (key: string) => void;
}>({ attachments: emptyAttachments, disabled: false });

function projectComposerNode(node: TNode): {
  key?: string;
  name: string;
  url?: string;
  attachment: boolean;
} {
  return {
    key: typeof node.attachmentKey === "string" ? node.attachmentKey : undefined,
    name: typeof node.name === "string" ? node.name : "File",
    url: typeof node.url === "string" ? node.url : undefined,
    attachment: node.type === attachmentType,
  };
}

function AttachmentElement(props: PlateElementProps) {
  const workspace = useOptionalWorkspace();
  const context = useContext(AttachmentContext);
  const metadata = projectComposerNode(props.element);
  const key = metadata.key ?? "";
  const attachment = context.attachments.find((item) => item.key === key);
  const name = attachment?.file.name ?? metadata.name;
  return (
    <PlateElement {...props} as="span" className="composer-attachment-node inline">
      <FileActions
        disabled={attachment?.state !== "ready" || !attachment.resourceId}
        target={{
          type: "resource",
          href: attachment?.resourceId
            ? (workspace?.resourceUrl(attachment.resourceId) ??
              `/api/resources/${encodeURIComponent(attachment.resourceId)}`)
            : "",
          name,
          mediaType: attachment?.file.type || "application/octet-stream",
          resourceId: attachment?.resourceId,
        }}
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                data-ui="composer-attachment-chip"
                className="composer-attachment-chip relative inline-flex items-center gap-1 max-w-full px-1 rounded-sm bg-muted text-foreground text-sm align-middle whitespace-nowrap [line-height:1.5]"
                contentEditable={false}
                data-state={attachment?.state ?? "missing"}
              />
            }
          >
            {attachment?.preview ? (
              <img src={attachment.preview} alt="" />
            ) : (
              <FileIcon name={name} mediaType={attachment?.file.type} />
            )}
            <span className="composer-attachment-name overflow-hidden text-ellipsis">{name}</span>
            <small>{attachment ? attachmentSize(attachment.file.size) : "Reattach file"}</small>
            {attachment?.state === "reserving" ? (
              <span className="sr-only absolute w-px h-px overflow-hidden [clip:rect(0,_0,_0,_0)] whitespace-nowrap">
                Preparing upload
              </span>
            ) : null}
            {attachment?.state === "uploading" ? (
              <progress value={attachment.progress} max={1} aria-label={`Uploading ${name}`} />
            ) : null}
            {attachment?.state === "failed" ? (
              <IconButton
                label={`Retry ${name}`}
                disabled={context.disabled}
                onClick={() => context.retry?.(key)}
              >
                <RotateCcw />
              </IconButton>
            ) : null}
            <IconButton
              label={`Remove ${name}`}
              disabled={context.disabled}
              onClick={() => {
                const path = props.editor.api.findPath(props.element);
                if (path) props.editor.tf.removeNodes({ at: path });
                props.editor.tf.focus();
              }}
            >
              <X />
            </IconButton>
          </TooltipTrigger>
          <TooltipContent>{attachment?.error ?? name}</TooltipContent>
        </Tooltip>
      </FileActions>
      {props.children}
    </PlateElement>
  );
}

export function attachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const referenceType = "composer_reference";
function ReferenceElement(props: PlateElementProps) {
  const href = projectComposerNode(props.element).url ?? "";
  const target = parseReferenceHref(href);
  return (
    <PlateElement {...props} as="span">
      <span contentEditable={false}>{target ? <ConversationBadge target={target} /> : href}</span>
      {props.children}
    </PlateElement>
  );
}
const ReferencePlugin = createPlatePlugin({
  key: referenceType,
  node: { isElement: true, isInline: true, isVoid: true, component: ReferenceElement },
});

const AttachmentPlugin = createPlatePlugin({
  key: attachmentType,
  node: { isElement: true, isInline: true, isVoid: true, component: AttachmentElement },
});

function mapComposerNodes(nodes: Descendant[], map: (node: TElement) => Descendant): Descendant[] {
  return nodes.map((node) => {
    if (TextApi.isText(node)) return node;
    node.children = mapComposerNodes(node.children, map);
    return map(node);
  });
}

function mapComposerValue(value: TElement[], map: (node: TElement) => Descendant): TElement[] {
  return structuredClone(value).map((node) => {
    node.children = mapComposerNodes(node.children, map);
    return node;
  });
}

function attachmentKeys(editor: PlateEditor): Set<string> {
  const keys = new Set<string>();
  for (const [node] of editor.api.nodes({ at: [], match: { type: attachmentType } })) {
    const key = projectComposerNode(node).key;
    if (key) keys.add(key);
  }
  return keys;
}

export function insertComposerAttachment(
  editor: PlateEditor,
  attachment: Pick<Attachment, "key" | "file">,
) {
  if (!editor.selection) editor.tf.select(editor.api.end([])!);
  const focus = editor.selection?.focus;
  const previous = focus && editor.api.before(focus, { distance: 1, unit: "character" });
  if (
    focus &&
    previous &&
    editor.api.isCollapsed() &&
    /\S/.test(editor.api.string({ anchor: previous, focus }))
  )
    editor.tf.insertText(" ");
  editor.tf.insertNodes({
    type: attachmentType,
    attachmentKey: attachment.key,
    name: attachment.file.name,
    children: [{ text: "" }],
  });
  editor.tf.move({ distance: 1, unit: "offset" });
  editor.tf.insertText(" ");
}

// Plate's flat list model wraps each block, preserving selection paths while rendering list markers.
type ListElementProps = PlateElementProps<TElement & Partial<TListProps>>;
const BlockList: RenderNodeWrapper = (props: ListElementProps) => {
  if (!props.element.listStyleType) return;
  return (props: ListElementProps) =>
    props.element.listStyleType === "decimal" ? (
      <ol start={typeof props.element.listStart === "number" ? props.element.listStart : 1}>
        <li>{props.children}</li>
      </ol>
    ) : (
      <ul>
        <li>{props.children}</li>
      </ul>
    );
};

export const composerPlugins = [
  AttachmentPlugin,
  ReferencePlugin,
  ParagraphPlugin.withComponent(Paragraph),
  BoldPlugin.configure({
    inputRules: [BoldRules.markdown({ variant: "*" }), BoldRules.markdown({ variant: "_" })],
  }),
  ItalicPlugin.configure({
    inputRules: [ItalicRules.markdown({ variant: "*" }), ItalicRules.markdown({ variant: "_" })],
  }),
  StrikethroughPlugin.configure({ inputRules: [StrikethroughRules.markdown()] }),
  CodePlugin.configure({ inputRules: [CodeRules.markdown()], node: { component: InlineCode } }),
  H1Plugin.configure({ inputRules: [HeadingRules.markdown()], node: { component: HeadingOne } }),
  H2Plugin.configure({ inputRules: [HeadingRules.markdown()], node: { component: HeadingTwo } }),
  H3Plugin.configure({ inputRules: [HeadingRules.markdown()], node: { component: HeadingThree } }),
  BlockquotePlugin.configure({
    inputRules: [BlockquoteRules.markdown()],
    node: { component: QuoteElement },
  }),
  CodeBlockPlugin.configure({
    inputRules: [CodeBlockRules.markdown({ on: "match" })],
    node: { component: CodeBlock },
  }),
  CodeLinePlugin.withComponent(CodeLine),
  createPlatePlugin({
    key: KEYS.a,
    node: { isElement: true, isInline: true },
    parsers: {
      html: {
        deserializer: {
          rules: [{ validNodeName: "A" }],
          parse: ({ element }) => {
            const url = element.getAttribute("href");
            const label = element.textContent ?? "";
            return { text: !url || label === url ? label : `[${label}](${url})` };
          },
        },
      },
    },
  }),
  IndentPlugin.configure({
    inject: {
      targetPlugins: [KEYS.p, ...KEYS.heading, KEYS.blockquote, KEYS.codeBlock],
      nodeProps: {
        transformNodeValue: ({
          element,
          getOptions,
        }: {
          element?: TElement & Partial<TListProps>;
          getOptions: () => { offset?: number; unit?: string };
        }) => {
          const indent = typeof element?.indent === "number" ? element.indent : 0;
          const depth = element?.listStyleType ? Math.max(0, indent - 1) : indent;
          const { offset = 24, unit = "px" } = getOptions();
          return `${depth * offset}${unit}`;
        },
      },
    },
  }),
  ListPlugin.configure({
    inputRules: [
      BulletedListRules.markdown({ variant: "-" }),
      BulletedListRules.markdown({ variant: "*" }),
      OrderedListRules.markdown({ variant: "." }),
    ],
    render: { belowNodes: BlockList },
  }),
  MarkdownPlugin.configure({ options: { remarkPlugins: [remarkGfm, editableComposerLinks] } }),
];

function deserializeComposer(editor: PlateEditor, text: string) {
  const value = editor.getApi(MarkdownPlugin).markdown.deserialize(text);
  const trailing = /[ \t]+$/.exec(text)?.[0];
  if (trailing && value.length) {
    const block = value[value.length - 1]!;
    const child = block.children.at(-1);
    if (child && !TextApi.isText(child) && editor.api.isInline(child))
      block.children.push({ text: trailing });
    else {
      const last = NodeApi.last(block, [])?.[0];
      if (TextApi.isText(last)) last.text += trailing;
    }
  }
  return mapComposerValue(value, (node) => {
    const target =
      node.type === KEYS.a ? parseReferenceHref(projectComposerNode(node).url ?? "") : undefined;
    if (target)
      return { type: referenceType, url: referenceHref(target), children: [{ text: "" }] };
    if (node.type !== KEYS.a || !projectComposerNode(node).url?.startsWith("attachment:"))
      return node;
    return {
      type: attachmentType,
      attachmentKey: projectComposerNode(node).url?.slice("attachment:".length),
      name: NodeApi.string(node),
      children: [{ text: "" }],
    };
  });
}

export function replaceComposerDocument(editor: PlateEditor, text: string) {
  editor.tf.withoutSaving(() => {
    editor.tf.deselect();
    if (composerMarkdown(editor) !== text) editor.tf.setValue(deserializeComposer(editor, text));
  });
  editor.history = { undos: [], redos: [] };
  editor.marks = null;
}

export function createComposerEditor(text = "") {
  return createPlateEditor({
    plugins: composerPlugins,
    value: (editor) => deserializeComposer(editor, text),
  });
}

function trimEmptyInlineText(nodes: Descendant[]): Descendant[] {
  const visible = nodes.some((node) => NodeApi.string(node).length > 0);
  return nodes.flatMap<Descendant>((node) => {
    if (TextApi.isText(node)) return visible && node.text === "" ? [] : [node];
    node.children = trimEmptyInlineText(node.children);
    return [node];
  });
}

function serializeComposer(editor: PlateEditor, references: boolean): string {
  const value = mapComposerValue(editor.children, (node) => {
    if (node.type === referenceType) {
      const target = parseReferenceHref(projectComposerNode(node).url ?? "");
      if (target)
        return {
          type: KEYS.a,
          url: referenceHref(target),
          children: [
            {
              text: `#${target.surface}:${target.sessionId}${target.messageId ? `/${target.messageId}` : ""}`,
            },
          ],
        };
    }
    if (node.type !== attachmentType) return node;
    const metadata = projectComposerNode(node);
    const text = metadata.name;
    if (!references) return { text };
    return { type: KEYS.a, url: `attachment:${metadata.key}`, children: [{ text }] };
  });
  if (!value.some((node) => NodeApi.string(node))) return "";
  for (const block of value) block.children = trimEmptyInlineText(block.children);
  const restoreLinks = protectComposerLinks(editor, value);
  return restoreLinks(editor.getApi(MarkdownPlugin).markdown.serialize({ value }))
    .replace(/\n$/, "")
    .replace(/(?:&#x20;)+(?=\n|$)/g, (spaces) => " ".repeat(spaces.length / 6));
}

export function composerMarkdown(editor: PlateEditor): string {
  return serializeComposer(editor, true);
}

export function composerSubmissionMarkdown(editor: PlateEditor): string {
  return serializeComposer(editor, false);
}

export function resolveComposerAttachments(
  text: string,
  resourceIds: ReadonlyMap<string, string>,
): string {
  const editor = createComposerEditor(text);
  editor.children = mapComposerValue(editor.children, (node) => {
    const metadata = projectComposerNode(node);
    if (!metadata.attachment) return node;
    const id = metadata.key ? resourceIds.get(metadata.key) : undefined;
    if (!id) return { text: metadata.name };
    return {
      type: KEYS.a,
      url: `/api/resources/${encodeURIComponent(id)}`,
      children: [{ text: metadata.name }],
    };
  });
  return composerMarkdown(editor);
}

export function restoreMessageAttachments(
  text: string,
  attachments: ReadonlyMap<string, Attachment>,
): string {
  const editor = createComposerEditor(text);
  const byUrl = new Map(
    [...attachments].map(([id, attachment]) => [
      `/api/resources/${encodeURIComponent(id)}`,
      attachment,
    ]),
  );
  const value = editor.getApi(MarkdownPlugin).markdown.deserialize(text, {
    remarkPlugins: [remarkGfm, () => editableComposerLinks(new Set(byUrl.keys()))],
    rules: {
      img: {
        deserialize: (node, decoration, options) => {
          const attachment = byUrl.get(node.url);
          if (!attachment) return defaultRules.img!.deserialize!(node, decoration, options);
          return { type: KEYS.a, url: node.url, children: [{ text: attachment.file.name }] };
        },
      },
    },
  });
  if (value.length) editor.children = value;
  const used = new Set<string>();
  editor.children = mapComposerValue(editor.children, (node) => {
    const attachment = byUrl.get(projectComposerNode(node).url ?? "");
    if (!attachment) return node;
    used.add(attachment.key);
    return {
      type: attachmentType,
      attachmentKey: attachment.key,
      name: attachment.file.name,
      children: [{ text: "" }],
    };
  });
  for (const attachment of attachments.values()) {
    if (!used.has(attachment.key)) insertComposerAttachment(editor, attachment);
  }
  return composerMarkdown(editor);
}

export function captureComposerPaste(editor: PlateEditor) {
  const end = editor.api.end([])!;
  const range = editor.api.rangeRef(editor.selection ?? { anchor: end, focus: end });
  return {
    cancel: () => {
      range.unref();
    },
    insert(text: string) {
      const at = range.unref();
      if (!at) return;
      editor.tf.select(at);
      editor.tf.insertFragment(deserializeComposer(editor, text));
    },
  };
}

export function remapComposerAttachments(text: string, keys: ReadonlyMap<string, string>): string {
  const editor = createComposerEditor(text);
  editor.children = mapComposerValue(editor.children, (node) => {
    const metadata = projectComposerNode(node);
    if (!metadata.attachment || !metadata.key) return node;
    const key = keys.get(metadata.key);
    if (!key) return node;
    return {
      type: attachmentType,
      attachmentKey: key,
      name: metadata.name,
      children: [{ text: "" }],
    };
  });
  return composerMarkdown(editor);
}

export function composerPlainText(editor: PlateEditor): string {
  return mapComposerValue(editor.children, (node) => {
    if (node.type === attachmentType) return { text: projectComposerNode(node).name };
    if (node.type === referenceType) return { text: projectComposerNode(node).url ?? "" };
    return node;
  })
    .map((node) => NodeApi.string(node))
    .join("\n\n");
}

export function composerPrefix(editor: PlateEditor): string {
  if (!editor.selection || !editor.api.isCollapsed()) return "";
  const block = editor.api.block();
  if (!block || block[0].type === KEYS.codeLine) return "";
  const start = editor.api.start(block[1]);
  return start ? editor.api.string({ anchor: start, focus: editor.selection.anchor }) : "";
}

export function insertComposerCompletion(editor: PlateEditor, text: string, replaceLength: number) {
  if (!editor.selection) return;
  const focus = editor.selection.anchor;
  const anchor = editor.api.before(focus, { distance: replaceLength, unit: "character" });
  if (!anchor) return;
  editor.tf.insertText(`${text} `, { at: { anchor, focus } });
}

export type ComposerEditorHandle = {
  capturePaste: () => ReturnType<typeof captureComposerPaste>;
  complete: (text: string, replaceLength: number) => void;
  submissionText: () => string;
  hasMissingAttachments: () => boolean;
};
export type ComposerEditorProps = {
  ref?: Ref<ComposerEditorHandle>;
  text: string;
  documentKey?: string;
  loadingDraft?: boolean;
  attachments?: readonly Attachment[];
  onRemoveAttachment?: (key: string) => void;
  onRetryAttachment?: (key: string) => void;
  disabled: boolean;
  placeholder: string;
  onText: (text: string, plainText: string) => void;
  onPlainText: (text: string, markdown: string) => void;
  onPrefix: (prefix: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onPaste: (event: ClipboardEvent<HTMLDivElement>) => void;
  expanded: boolean;
  activeDescendant?: string;
};

const ComposerEditor = memo(function ComposerEditor(props: ComposerEditorProps) {
  const lastText = useRef(props.text);
  const documentKey = useRef(props.documentKey);
  const attachments = props.attachments ?? emptyAttachments;
  const seenAttachments = useRef(new Set<string>());
  const referencedAttachments = useRef(new Set<string>());
  const editor = usePlateEditor({
    plugins: composerPlugins,
    value: (editor) => deserializeComposer(editor, props.text),
  });
  useLayoutEffect(() => {
    if (props.loadingDraft) return;
    const switched = documentKey.current !== props.documentKey;
    if (switched) {
      documentKey.current = props.documentKey;
      seenAttachments.current.clear();
      referencedAttachments.current.clear();
      replaceComposerDocument(editor, props.text);
    } else if (props.text !== lastText.current) {
      editor.tf.setValue(deserializeComposer(editor, props.text));
    }
    lastText.current = props.text;
    props.onPlainText(composerPlainText(editor), props.text);
  }, [editor, props.documentKey, props.loadingDraft, props.text, props.onPlainText]);
  useEffect(() => {
    if (props.loadingDraft) return;
    const currentKeys = new Set(attachments.map((attachment) => attachment.key));
    const references = attachmentKeys(editor);
    for (const key of seenAttachments.current) {
      if (currentKeys.has(key)) continue;
      editor.tf.removeNodes({
        at: [],
        match: (node) => {
          const metadata = projectComposerNode(node);
          return metadata.attachment && metadata.key === key;
        },
      });
    }
    for (const attachment of attachments) {
      if (seenAttachments.current.has(attachment.key) || references.has(attachment.key)) continue;
      insertComposerAttachment(editor, attachment);
    }
    seenAttachments.current = currentKeys;
    referencedAttachments.current = attachmentKeys(editor);
  }, [editor, attachments, props.loadingDraft]);
  useImperativeHandle(
    props.ref,
    () => ({
      capturePaste: () => captureComposerPaste(editor),
      submissionText: () => composerSubmissionMarkdown(editor),
      hasMissingAttachments: () =>
        [...attachmentKeys(editor)].some(
          (key) => !attachments.some((attachment) => attachment.key === key),
        ),
      complete(text, length) {
        insertComposerCompletion(editor, text, length);
        editor.tf.focus();
      },
    }),
    [editor, attachments],
  );
  function change() {
    if (props.loadingDraft) return;
    const references = attachmentKeys(editor);
    for (const key of referencedAttachments.current) {
      if (!references.has(key) && attachments.some((attachment) => attachment.key === key))
        props.onRemoveAttachment?.(key);
    }
    referencedAttachments.current = references;
    const text = composerMarkdown(editor);
    lastText.current = text;
    if (text !== props.text) props.onText(text, composerPlainText(editor));
    props.onPlainText(composerPlainText(editor), text);
    props.onPrefix(composerPrefix(editor));
  }
  return (
    <AttachmentContext
      value={{ attachments, disabled: props.disabled, retry: props.onRetryAttachment }}
    >
      <Plate
        editor={editor}
        readOnly={props.disabled}
        onValueChange={change}
        onSelectionChange={() => props.onPrefix(composerPrefix(editor))}
      >
        <ComposerFormatting editor={editor} disabled={props.disabled} />
        <PlateContent
          className="composer-editor"
          style={{
            minHeight: "calc(1lh + calc(var(--ui-space-unit) * 3) * 2)",
            overflowWrap: "anywhere",
          }}
          aria-label="Message"
          role="textbox"
          aria-multiline="true"
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-controls={props.expanded ? "composer-completions" : undefined}
          aria-activedescendant={props.activeDescendant}
          placeholder={props.placeholder}
          onKeyDown={(event) => {
            props.onKeyDown(event);
            if (event.defaultPrevented || event.nativeEvent.isComposing) return;
            if (event.key === "Enter" && event.shiftKey) {
              event.preventDefault();
              editor.tf.insertBreak();
            }
          }}
          onPaste={(event) => {
            props.onPaste(event);
            if (!event.defaultPrevented) {
              const target = parseReferenceHref(
                event.clipboardData.getData("text/plain").trim(),
                location.origin,
              );
              if (target) {
                event.preventDefault();
                captureComposerPaste(editor).insert(
                  `[#${target.surface}:${target.sessionId}](${referenceHref(target)})`,
                );
              }
            }
            // Plate requires a handled result to skip its HTML deserializer.
            return event.defaultPrevented;
          }}
        />
      </Plate>
    </AttachmentContext>
  );
});

export default ComposerEditor;

const ComposerFormatting = memo(function ComposerFormatting({
  editor,
  disabled,
}: {
  editor: PlateEditor;
  disabled: boolean;
}) {
  function mark(key: string) {
    editor.tf.toggleMark(key);
    editor.tf.focus();
  }
  function block(type: string) {
    editor.tf.toggleBlock(type);
    editor.tf.focus();
  }
  function list(listStyleType: string) {
    toggleList(editor, { listStyleType });
    editor.tf.focus();
  }
  return (
    <div
      className="composer-formatting flex gap-1 px-1 flex-wrap"
      role="toolbar"
      aria-label="Text formatting"
      onMouseDown={(event) => event.preventDefault()}
    >
      <IconButton label="Bold" disabled={disabled} onClick={() => mark(KEYS.bold)}>
        <Bold />
      </IconButton>
      <IconButton label="Italic" disabled={disabled} onClick={() => mark(KEYS.italic)}>
        <Italic />
      </IconButton>
      <IconButton
        label="Strikethrough"
        disabled={disabled}
        onClick={() => mark(KEYS.strikethrough)}
      >
        <Strikethrough />
      </IconButton>
      <IconButton label="Inline code" disabled={disabled} onClick={() => mark(KEYS.code)}>
        <Code />
      </IconButton>
      <IconButton label="Heading" disabled={disabled} onClick={() => block(KEYS.h2)}>
        <Heading2 />
      </IconButton>
      <IconButton label="Quote" disabled={disabled} onClick={() => block(KEYS.blockquote)}>
        <Quote />
      </IconButton>
      <IconButton label="Bulleted list" disabled={disabled} onClick={() => list("disc")}>
        <List />
      </IconButton>
      <IconButton label="Numbered list" disabled={disabled} onClick={() => list("decimal")}>
        <ListOrdered />
      </IconButton>
      <IconButton
        label="Code block"
        disabled={disabled}
        onClick={() => {
          editor.getTransforms(CodeBlockPlugin).code_block.toggle();
          editor.tf.focus();
        }}
      >
        <SquareCode />
      </IconButton>
    </div>
  );
});
