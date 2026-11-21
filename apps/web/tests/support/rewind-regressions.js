// Run in the fresh dev:web fixture: await (await import('/tests/support/rewind-regressions.js')).verifyRewindRegressions()
import React, { createRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ComposerEditor from "../../src/components/composer-editor";
import { referencedAttachment } from "../../src/attachment-reference";
import { useDmRewind } from "../../src/use-dm-rewind";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function waitForDom(host, condition) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Rewind regression condition timed out: ${host.textContent}`));
    }, 3_000);
    const observer = new MutationObserver(check);
    function check() {
      if (!condition()) return;
      clearTimeout(timer);
      observer.disconnect();
      resolve();
    }
    observer.observe(host, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    check();
  });
}

async function verifyReferenceUndo() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const ref = createRef();
  const record = referencedAttachment({
    key: "reference-a",
    resourceId: "resource-a",
    name: "A.txt",
    type: "text/plain",
    size: 1,
  });
  let replace;
  const restored = [];
  function Harness() {
    const [text, setText] = useState("[A.txt](attachment:reference-a)");
    const [attachments, setAttachments] = useState([record]);
    const [replacement, setReplacement] = useState();
    replace = () => setReplacement({ id: Symbol(), documentKey: "draft", text: "Restored prompt" });
    return React.createElement(ComposerEditor, {
      ref,
      text,
      attachments,
      replacement,
      documentKey: "draft",
      disabled: false,
      placeholder: "Message",
      expanded: false,
      onText: setText,
      onPlainText() {},
      onPrefix() {},
      onKeyDown() {},
      onPaste() {},
      onReplacementApplied() {
        setText("Restored prompt");
        setAttachments([]);
        setReplacement(undefined);
      },
      onRemoveAttachment(key) {
        setAttachments((items) => items.filter((item) => item.key !== key));
      },
      onPasteAttachments(items) {
        restored.push(...items);
        setAttachments(items);
        return items;
      },
    });
  }
  try {
    root.render(React.createElement(Harness));
    await waitForDom(host, () => ref.current && host.querySelector('[data-ui="composer-input"]'));
    assert(!ref.current.hasMissingAttachments(), "Initial reference is unavailable");
    replace();
    await waitForDom(host, () => host.textContent.includes("Restored prompt"));
    host.querySelector('[data-ui="composer-input"]').dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "z",
        code: "KeyZ",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await waitForDom(host, () => host.textContent.includes("A.txt"));
    assert(!ref.current.hasMissingAttachments(), "Rewind undo lost the reference-only attachment");
    assert(
      restored[0]?.reference?.resourceId === "resource-a",
      "Undo did not restore the attachment record",
    );
    return "reference-only rewind undo: pass";
  } finally {
    root.unmount();
    host.remove();
  }
}

async function verifyHistoryRetry() {
  let turn = {
    kind: "ready",
    slotId: "turn",
    turnId: "turn",
    position: 0,
    state: "complete",
    settledAt: Date.now(),
    partsCursor: "first-page",
    messages: [
      {
        id: "input",
        role: "user",
        metadata: { authorId: "owner", inputId: "input", inputMode: "prompt" },
        parts: [{ type: "text", text: "prompt" }],
      },
    ],
  };
  const listeners = new Set();
  let calls = 0;
  const store = {
    size: 1,
    checkpoint: { projectionRevision: 1 },
    at: () => turn,
    get: () => turn,
    subscribe(notify) {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
  };
  const client = {
    thread: () => store,
    rpc: { threads: { context: async () => ({ timestampGapMs: 1_800_000 }) } },
    async loadTurnPage() {
      calls++;
      // NativeClient reports an RPC error but resolves without advancing this cursor.
      if (calls === 1) return;
      turn = { ...turn, partsCursor: undefined };
      for (const notify of listeners) notify();
    },
  };
  const queries = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const host = document.createElement("output");
  document.body.append(host);
  const root = createRoot(host);
  function Harness() {
    const value = useDmRewind({
      client,
      threadId: "thread",
      ownerId: "owner",
      dm: true,
      online: true,
      busy: false,
    });
    return React.createElement("span", null, value?.reason || "available");
  }
  try {
    root.render(
      React.createElement(QueryClientProvider, { client: queries }, React.createElement(Harness)),
    );
    await waitForDom(host, () => host.textContent === "available");
    assert(calls === 2, `Expected one history-page retry, got ${calls} requests`);
    return "failed history-page retry: pass";
  } finally {
    root.unmount();
    queries.clear();
    host.remove();
  }
}

export async function verifyRewindRegressions() {
  return [await verifyReferenceUndo(), await verifyHistoryRetry()];
}
