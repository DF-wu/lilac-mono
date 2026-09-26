import { useState } from "react";
import { useStore } from "zustand";
import {
  bindingConflict,
  browserConflict,
  defaultKeybindings,
  editingConflict,
  formatBinding,
  recordedBinding,
  shortcutActions,
  shortcutLabels,
  type Keybinding,
  type KeybindingStore,
  type ShortcutAction,
} from "../keybindings";
import { Save, Trash, RotateCcw } from "lucide-react";
import { IconButton } from "./ui";
import { Input } from "./ui/input";

export function KeybindingsSettings({ store }: { store: KeybindingStore }) {
  const storageError = useStore(store, (state) => state.storageError);
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Select a shortcut and press new keys. Shortcuts use physical key positions. Saved in this
        browser.
      </p>
      {storageError ? (
        <p role="status" className="text-sm">
          {storageError}
        </p>
      ) : null}
      {shortcutActions.map((action) => (
        <KeybindingRow key={action} action={action} store={store} />
      ))}
    </div>
  );
}
function KeybindingRow({ action, store }: { action: ShortcutAction; store: KeybindingStore }) {
  const value = useStore(store, (state) => state.bindings[action]);
  const bindings = useStore(store, (state) => state.bindings);
  const [recording, setRecording] = useState(false);
  const [candidate, setCandidate] = useState<Keybinding | null>(value);
  const shown = recording ? candidate : value;
  const conflict = bindingConflict(bindings, action, shown);
  const warning = browserConflict(shown);
  const resetConflict = bindingConflict(bindings, action, defaultKeybindings[action]);
  function start() {
    if (recording) return;
    setCandidate(value);
    setRecording(true);
  }
  function save() {
    if (conflict) return;
    store.getState().setBinding(action, candidate);
    setRecording(false);
  }
  return (
    <div
      className="flex flex-col gap-1"
      data-shortcut-recorder={recording ? "true" : undefined}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setRecording(false);
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`shortcut-${action}`} className="flex-1 min-w-32 text-sm">
          {shortcutLabels[action]}
        </label>
        <Input
          id={`shortcut-${action}`}
          className="w-44 font-mono text-sm"
          readOnly
          value={formatBinding(shown) || "Unassigned"}
          aria-describedby={`shortcut-help-${action}`}
          aria-invalid={!!conflict}
          onFocus={start}
          onClick={start}
          onKeyDown={(event) => {
            if (event.key === "Tab") return;
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "Escape") {
              setRecording(false);
              event.currentTarget.blur();
              return;
            }
            if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey) {
              save();
              return;
            }
            const next = recordedBinding(event.nativeEvent);
            if (next) {
              setCandidate(next);
              setRecording(true);
            }
          }}
        />
        <IconButton label="Save" disabled={!recording || !!conflict} onClick={save}>
          <Save />
        </IconButton>
        <IconButton
          label="Clear"
          onClick={() => {
            store.getState().setBinding(action, null);
            setCandidate(null);
            setRecording(false);
          }}
        >
          <Trash />
        </IconButton>
        <IconButton
          label="Reset to default"
          disabled={!!resetConflict}
          title={resetConflict ? `Used by ${shortcutLabels[resetConflict]}` : undefined}
          onClick={() => {
            store.getState().setBinding(action, defaultKeybindings[action]);
            setRecording(false);
          }}
        >
          <RotateCcw />
        </IconButton>
      </div>
      <div
        id={`shortcut-help-${action}`}
        className="text-xs text-muted-foreground"
        aria-live="polite"
      >
        {conflict ? `Already used by ${shortcutLabels[conflict]}. Clear that binding first.` : null}
        {!conflict && recording
          ? "Press Ctrl/Cmd or Alt/Option with a key. Enter saves; Escape cancels."
          : null}
        {warning ? <p>{warning}</p> : null}
        {editingConflict(shown) ? (
          <p>Outside text fields. Editing shortcuts take priority.</p>
        ) : null}
      </div>
    </div>
  );
}
