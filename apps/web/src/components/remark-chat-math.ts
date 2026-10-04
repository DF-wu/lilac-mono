import type { ComponentProps } from "react";
import type ReactMarkdown from "react-markdown";

type RemarkPlugin = Extract<
  NonNullable<ComponentProps<typeof ReactMarkdown>["remarkPlugins"]>[number],
  (...args: never[]) => unknown
>;
type MarkdownNode = {
  type: string;
  children?: MarkdownNode[];
  data?: { hProperties?: { className?: string[] } };
  position?: { start: { offset?: number }; end: { offset?: number } };
};
type Code = number | null;
type State = (code: Code) => State | undefined;
type Token = { type: string };
type Effects = {
  enter(type: string): Token;
  exit(type: string): Token;
  consume(code: Code): void;
};

const backslash = 92;
const openParen = 40;
const closeParen = 41;
const openBracket = 91;
const closeBracket = 93;
// micromark encodes line endings as -5..-3 and tabs and virtual spaces as -2..-1.
const isLineEnding = (code: Code) => code !== null && code < -2;
const isLineBoundary = (code: Code) => code === null || isLineEnding(code);
const isInlineSpace = (code: Code) => code === 32 || code === -2 || code === -1;
// CJK prose has no spaces between words, so only ASCII words block inline math.
const isAsciiAlphanumeric = (code: Code) =>
  code !== null && code > 0 && /[A-Za-z0-9]/u.test(String.fromCharCode(code));

// Reuses remark-math's token names so its mdast handler builds inlineMath nodes for \(...\) and \[...\].
// Display math must start and end on line boundaries so escaped prose brackets such as \[1\] stay literal.
function tokenizeBracketMath(
  this: { previous: Code },
  effects: Effects,
  ok: State,
  nok: State,
): State {
  const previous = this.previous;
  let openCode: number;
  let closeCode: number;
  let closingSequence: Token;
  const open: State = (code) => {
    if (code === openParen && !isAsciiAlphanumeric(previous)) closeCode = closeParen;
    else if (code === openBracket && isLineBoundary(previous)) closeCode = closeBracket;
    else return nok(code);
    openCode = code;
    effects.consume(code);
    effects.exit("mathTextSequence");
    return between;
  };
  const between: State = (code) => {
    if (code === null) return nok(code);
    if (isLineEnding(code)) {
      effects.enter("lineEnding");
      effects.consume(code);
      effects.exit("lineEnding");
      return between;
    }
    if (code === backslash) {
      closingSequence = effects.enter("mathTextSequence");
      effects.consume(code);
      return sequenceClose;
    }
    effects.enter("mathTextData");
    return data(code);
  };
  const data: State = (code) => {
    if (code === null || code === backslash || isLineEnding(code)) {
      effects.exit("mathTextData");
      return between(code);
    }
    effects.consume(code);
    return data;
  };
  const sequenceClose: State = (code) => {
    if (code === closeCode) {
      effects.consume(code);
      return closed;
    }
    // Stopping at the next opener keeps unclosed delimiters from rescanning the rest of the paragraph.
    if (code === openCode) return nok(code);
    // A backslash that does not close the math belongs to a TeX command such as \\ or \frac.
    closingSequence.type = "mathTextData";
    if (isLineBoundary(code)) return data(code);
    effects.consume(code);
    return data;
  };
  const closed: State = (code) => {
    if (closeCode === closeBracket && isInlineSpace(code)) {
      effects.consume(code);
      return closed;
    }
    if (closeCode === closeBracket && !isLineBoundary(code)) {
      closingSequence.type = "mathTextData";
      return data(code);
    }
    effects.exit("mathTextSequence");
    effects.exit("mathText");
    return ok(code);
  };
  return (code) => {
    effects.enter("mathText");
    effects.enter("mathTextSequence");
    effects.consume(code);
    return open;
  };
}

const bracketMath = {
  text: { [backslash]: { name: "bracketMath", tokenize: tokenizeBracketMath } },
};

type SourceEdit = { offset: number; remove: number; insert: string };

// Display math needs its own line; text after a heading or table-cell marker is prose.
const displayLinePrefix = /^[ \t]*(?:>[ \t]*|(?:[-*+]|\d{1,9}[.)])[ \t]+)*$/u;

function literalEdits(tree: MarkdownNode, source: string): SourceEdit[] {
  const edits: SourceEdit[] = [];
  const visit = (node: MarkdownNode) => {
    if (node.type !== "inlineMath") {
      node.children?.forEach(visit);
      return;
    }
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    const raw = source.slice(start, end);
    if (raw.startsWith("\\[")) {
      const linePrefix = source.slice(source.lastIndexOf("\n", start - 1) + 1, start);
      // A character reference renders "[" without starting math or link syntax.
      if (!displayLinePrefix.test(linePrefix))
        edits.push({ offset: start, remove: 2, insert: "&#91;" });
      return;
    }
    if (!/^\$(?!\$)/u.test(raw)) return;
    const closesBeforeAmount = /\d/u.test(source[end] ?? "");
    if (!/^\$\s|\s\$$/u.test(raw) && !closesBeforeAmount) return;
    edits.push({ offset: start, remove: 0, insert: "\\" });
    if (closesBeforeAmount) edits.push({ offset: end - 1, remove: 0, insert: "\\" });
  };
  visit(tree);
  return edits;
}

function markDisplayMath(node: MarkdownNode, source: string) {
  node.children?.forEach((child) => markDisplayMath(child, source));
  const start = node.position?.start.offset;
  if (node.type !== "inlineMath" || start === undefined || !source.startsWith("\\[", start)) return;
  node.data ??= {};
  node.data.hProperties = { className: ["language-math", "math-display"] };
}

export const remarkChatMath: RemarkPlugin = function () {
  // remark-parse registers micromarkExtensions on unified's Data, but its types are not visible here.
  const data: { settings?: object; micromarkExtensions?: object[] } = this.data();
  data.micromarkExtensions = [...(data.micromarkExtensions ?? []), bracketMath];
  return (tree: MarkdownNode, file: { toString(): string }) => {
    let source = file.toString();
    let parsed = tree;
    while (true) {
      const edits = literalEdits(parsed, source);
      if (!edits.length) break;
      for (const edit of edits.toSorted((left, right) => right.offset - left.offset)) {
        source = `${source.slice(0, edit.offset)}${edit.insert}${source.slice(edit.offset + edit.remove)}`;
      }
      // Reparse the document so emphasis and links spanning literal markers stay intact.
      parsed = this.parse(source);
    }
    markDisplayMath(parsed, source);
    tree.children = parsed.children;
  };
};
