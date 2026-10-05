import { expect, it } from "bun:test";
import { Editor } from "@tiptap/core";
import { EditorState, TextSelection, AllSelection } from "@tiptap/pm/state";
import { history, undo } from "@tiptap/pm/history";
import {
  readComposerDocument,
  writeComposerDocument,
  composerText,
  composerSchema,
  editorAttachmentKeys,
  composerExtensions,
  attachmentNode,
  referenceNode,
  captureEditorPaste,
  composerCompletionPrefix,
  completeEditor,
} from "../src/components/composer-tiptap";
import { createComposerEditor, composerMarkdown } from "../src/components/composer-document";

function headlessEditor(text: string) {
  const editor = new Editor({
    element: null,
    extensions: [...composerExtensions, attachmentNode, referenceNode],
    content: readComposerDocument(text).toJSON(),
  });
  // Tiptap treats an unmounted editor as destroyed even though its transactions work headlessly.
  Object.defineProperty(editor, "isDestroyed", { get: () => false });
  return editor;
}

it("pastes copied message fragments inline at a tracked position", () => {
  const editor = headlessEditor("before after");
  editor.commands.setTextSelection(8);
  const paste = captureEditorPaste(editor);
  editor.view.dispatch(editor.state.tr.insertText("typed "));
  paste.insert("**middle** [file](attachment:key)");
  expect(writeComposerDocument(editor.state.doc)).toBe(
    "before typed **middle** [file](attachment:key)after",
  );
  expect(editor.state.doc.childCount).toBe(1);
  const cancelled = captureEditorPaste(editor);
  cancelled.cancel();
  cancelled.insert("discarded");
  expect(composerText(editor.state.doc)).not.toContain("discarded");
  editor.destroy();
});

it("completes a mention after a soft line break without deleting preceding text", () => {
  const editor = headlessEditor("hello\n$sk");
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  expect(composerCompletionPrefix(editor)).toBe("hello\n$sk");
  completeEditor(editor, "$skill", 3);
  expect(writeComposerDocument(editor.state.doc)).toBe("hello\n$skill ");
  editor.destroy();
});

it("preserves existing draft and submission syntax through the Tiptap document", () => {
  for (const text of [
    "",
    "first\n\n\nlast",
    "\nfirst",
    "first\n",
    "first\n\n",
    "**first**\n_last_",
    "# Heading\n\n**bold** _italic_ ~~strike~~ `code`\n\n* one\n* two\n\n1. first\n2. second\n\n> quote\n\n[link](https://example.com)\n\n```ts\nconst x = 1;\n```",
    "* one\n  * nested\n* two",
    "#### Fourth\n\n##### Fifth\n\n###### Sixth",
    "* [x] done\n* [ ] pending\n  * [x] nested",
    "before\n\n---\n\nafter",
    "3. third\n4. fourth",
    "> first\n> next\n>\n> paragraph",
    "**注意：**粗體 ~~刪除：~~文字",
    "https://example.com/a_b?q=one&next=two",
    '[example](https://example.com/a_(b) "A title")',
    "Before [**label**](https://example.com) after",
    "[line\nbreak](https://example.com)",
    "Before \uE0000\uE000 [example](https://example.com) after",
    "$my_skill",
    "/fixture-status ",
    "Compare [my_\\[draft\\].txt](attachment:file) after",
    "[x](attachment:a) [x](attachment:b)",
    "[Discussion](/?ref=discord%3Achannel&range=first..last)",
    "[#native:thread](/?ref=native%3Athread&message=message)",
  ]) {
    const expected = composerMarkdown(createComposerEditor(text));
    const actual = writeComposerDocument(readComposerDocument(text));
    expect(actual).toBe(expected);
    expect(writeComposerDocument(readComposerDocument(actual))).toBe(actual);
    expect(actual).not.toContain("\uFEFF");
  }
});

it("keeps attachment identity and position through deletion and undo", () => {
  let state = EditorState.create({
    schema: composerSchema,
    doc: readComposerDocument(
      "**Before** [same.png](attachment:first) [same.png](attachment:second) after",
    ),
    plugins: [history()],
  });
  let position = 0;
  state.doc.descendants((node, pos) => {
    if (node.attrs.attachmentKey === "first") position = pos;
  });
  state = state.apply(state.tr.delete(position, position + 1));
  expect([...editorAttachmentKeys(state.doc)]).toEqual(["second"]);
  expect(writeComposerDocument(state.doc, false)).toBe("**Before**  same.png after");
  expect(
    undo(state, (transaction) => {
      state = state.apply(transaction);
    }),
  ).toBe(true);
  expect([...editorAttachmentKeys(state.doc)]).toEqual(["first", "second"]);
  expect(writeComposerDocument(state.doc)).toBe(
    "**Before** [same.png](attachment:first) [same.png](attachment:second) after",
  );
});

it("clears text and chips with select all and restores a valid empty paragraph", () => {
  let state = EditorState.create({
    schema: composerSchema,
    doc: readComposerDocument("**Text** [file](attachment:key)\n\nlast"),
  });
  state = state.apply(state.tr.setSelection(new AllSelection(state.doc)).deleteSelection());
  expect(writeComposerDocument(state.doc)).toBe("");
  expect([...editorAttachmentKeys(state.doc)]).toEqual([]);
  expect(state.doc.firstChild?.type.name).toBe("paragraph");
  state = state.apply(state.tr.insertText("hello"));
  expect(composerText(state.doc)).toBe("hello");
});

it("inserts a pasted reference into an empty document without a leading space", () => {
  let state = EditorState.create({ schema: composerSchema, doc: readComposerDocument("") });
  state = state.apply(
    state.tr
      .setSelection(TextSelection.create(state.doc, 1))
      .replaceSelectionWith(
        composerSchema.nodes.composer_reference!.create({ url: "/?ref=native%3Athread" }),
      ),
  );
  expect(writeComposerDocument(state.doc)).toBe("[#native:thread](/?ref=native%3Athread)");
});
