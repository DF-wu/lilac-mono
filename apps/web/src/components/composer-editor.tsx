import {
  useEffect,
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
  usePlateEditor,
  type PlateEditor,
  type PlateElementProps,
  type PlateLeafProps,
  type RenderNodeWrapper,
} from "platejs/react";
import { KEYS, NodeApi, TextApi, type TElement, type TListProps } from "platejs";
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
import { LinkRules } from "@platejs/link";
import { LinkPlugin } from "@platejs/link/react";
import { BulletedListRules, OrderedListRules, toggleList } from "@platejs/list";
import { ListPlugin } from "@platejs/list/react";
import { IndentPlugin } from "@platejs/indent/react";
import { MarkdownPlugin } from "@platejs/markdown";
import remarkGfm from "remark-gfm";
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
} from "lucide-react";
import { IconButton } from "./ui";
import "./composer-rich.css";

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
function LinkElement(props: PlateElementProps) {
  return <PlateElement {...props} as="span" className="composer-link" />;
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
  LinkPlugin.configure({
    inputRules: [
      LinkRules.markdown(),
      LinkRules.autolink({ variant: "paste" }),
      LinkRules.autolink({ variant: "space" }),
    ],
    node: { component: LinkElement },
  }),
  IndentPlugin.configure({
    inject: { targetPlugins: [KEYS.p, ...KEYS.heading, KEYS.blockquote, KEYS.codeBlock] },
  }),
  ListPlugin.configure({
    inputRules: [
      BulletedListRules.markdown({ variant: "-" }),
      BulletedListRules.markdown({ variant: "*" }),
      OrderedListRules.markdown({ variant: "." }),
    ],
    render: { belowNodes: BlockList },
  }),
  MarkdownPlugin.configure({ options: { remarkPlugins: [remarkGfm] } }),
];

function deserializeComposer(editor: PlateEditor, text: string) {
  const value = editor.getApi(MarkdownPlugin).markdown.deserialize(text);
  const trailing = /[ \t]+$/.exec(text)?.[0];
  if (trailing && value.length) {
    const last = NodeApi.last(value[value.length - 1]!, [])?.[0];
    if (TextApi.isText(last)) last.text += trailing;
  }
  return value;
}

export function createComposerEditor(text = "") {
  return createPlateEditor({
    plugins: composerPlugins,
    value: (editor) => deserializeComposer(editor, text),
  });
}

export function composerMarkdown(editor: PlateEditor): string {
  if (!editor.children.some((node) => NodeApi.string(node))) return "";
  return editor
    .getApi(MarkdownPlugin)
    .markdown.serialize()
    .replace(/\n$/, "")
    .replace(/(?:&#x20;)+(?=\n|$)/g, (spaces) => " ".repeat(spaces.length / 6));
}

export function composerPlainText(editor: PlateEditor): string {
  return editor.children.map((node) => NodeApi.string(node)).join("\n\n");
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

export type ComposerEditorHandle = { complete: (text: string, replaceLength: number) => void };
export type ComposerEditorProps = {
  ref?: Ref<ComposerEditorHandle>;
  text: string;
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

export default function ComposerEditor(props: ComposerEditorProps) {
  const lastText = useRef(props.text);
  const editor = usePlateEditor({
    plugins: composerPlugins,
    value: (editor) => deserializeComposer(editor, props.text),
  });
  useEffect(() => {
    props.onPlainText(composerPlainText(editor), lastText.current);
  }, [editor, props.onPlainText]);
  useEffect(() => {
    if (props.text === lastText.current) return;
    lastText.current = props.text;
    editor.tf.setValue(deserializeComposer(editor, props.text));
  }, [editor, props.text]);
  useImperativeHandle(
    props.ref,
    () => ({
      complete(text, length) {
        insertComposerCompletion(editor, text, length);
        editor.tf.focus();
      },
    }),
    [editor],
  );
  function change() {
    const text = composerMarkdown(editor);
    lastText.current = text;
    props.onText(text, composerPlainText(editor));
    props.onPrefix(composerPrefix(editor));
  }
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
    <Plate
      editor={editor}
      readOnly={props.disabled}
      onValueChange={change}
      onSelectionChange={() => props.onPrefix(composerPrefix(editor))}
    >
      <div
        className="composer-formatting"
        role="toolbar"
        aria-label="Text formatting"
        onMouseDown={(event) => event.preventDefault()}
      >
        <IconButton label="Bold" disabled={props.disabled} onClick={() => mark(KEYS.bold)}>
          <Bold />
        </IconButton>
        <IconButton label="Italic" disabled={props.disabled} onClick={() => mark(KEYS.italic)}>
          <Italic />
        </IconButton>
        <IconButton
          label="Strikethrough"
          disabled={props.disabled}
          onClick={() => mark(KEYS.strikethrough)}
        >
          <Strikethrough />
        </IconButton>
        <IconButton label="Inline code" disabled={props.disabled} onClick={() => mark(KEYS.code)}>
          <Code />
        </IconButton>
        <IconButton label="Heading" disabled={props.disabled} onClick={() => block(KEYS.h2)}>
          <Heading2 />
        </IconButton>
        <IconButton label="Quote" disabled={props.disabled} onClick={() => block(KEYS.blockquote)}>
          <Quote />
        </IconButton>
        <IconButton label="Bulleted list" disabled={props.disabled} onClick={() => list("disc")}>
          <List />
        </IconButton>
        <IconButton label="Numbered list" disabled={props.disabled} onClick={() => list("decimal")}>
          <ListOrdered />
        </IconButton>
        <IconButton
          label="Code block"
          disabled={props.disabled}
          onClick={() => {
            editor.getTransforms(CodeBlockPlugin).code_block.toggle();
            editor.tf.focus();
          }}
        >
          <SquareCode />
        </IconButton>
      </div>
      <PlateContent
        className="composer-editor"
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
        onPaste={props.onPaste}
      />
    </Plate>
  );
}
