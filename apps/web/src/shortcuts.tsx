import { useEffect, useLayoutEffect, useRef } from "react";
import { useStore } from "zustand";
import { useOptionalWorkspace } from "./workspace-context";
import { useEventCallback } from "./use-event-callback";
import {
  ariaBinding,
  editingConflict,
  formatBinding,
  isMacKeyboard,
  previewKeybindings,
  recordedBinding,
  sameBinding,
  shortcutActions,
  threadActions,
  threadShortcutTarget,
  type ShortcutAction,
} from "./keybindings";

export function useShortcut(action?: ShortcutAction) {
  const workspace = useOptionalWorkspace();
  const binding = useStore(workspace?.keybindings ?? previewKeybindings, (state) =>
    action ? state.bindings[action] : null,
  );
  return { label: formatBinding(binding), aria: ariaBinding(binding) };
}
export function useThreadShortcut(id?: string) {
  const workspace = useOptionalWorkspace();
  const store = workspace?.keybindings ?? previewKeybindings;
  const action = useStore(store, (state) => {
    const index = id ? (state.heldTargets ?? state.targets).indexOf(id) : -1;
    return threadActions[index];
  });
  const binding = useStore(store, (state) => (action ? state.bindings[action] : null));
  const held = useStore(store, (state) => state.showThreadHints);
  return { label: formatBinding(binding), aria: ariaBinding(binding), held };
}
export function useThreadTargets(ids: readonly string[], select: (id: string) => void) {
  const workspace = useOptionalWorkspace();
  const keybindings = workspace?.keybindings ?? previewKeybindings;
  const onSelect = useEventCallback(select);
  useLayoutEffect(() => {
    const next = [...new Set(ids)];
    const current = keybindings.getState();
    if (
      current.selectThread === onSelect &&
      next.length === current.targets.length &&
      next.every((id, index) => current.targets[index] === id)
    )
      return;
    keybindings.setState({ targets: next, selectThread: onSelect });
  });
  useLayoutEffect(
    () => () => {
      if (keybindings.getState().selectThread === onSelect)
        keybindings.setState({
          targets: [],
          heldTargets: undefined,
          showThreadHints: false,
          selectThread: undefined,
        });
    },
    [keybindings, onSelect],
  );
}
export function ThreadShortcutTargets({
  ids,
  select,
}: {
  ids: readonly string[];
  select: (id: string) => void;
}) {
  useThreadTargets(ids, select);
  return null;
}
export function blurForThreadNavigation() {
  if (window.matchMedia("(pointer: coarse)").matches) return;
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}
export function focusMainComposer() {
  if (window.matchMedia("(pointer: coarse)").matches) return;
  document
    .querySelector<HTMLElement>('#chat [data-ui="composer-input"][contenteditable="true"]')
    ?.focus({ preventScroll: true });
}
export function shortcutOverlayOpen() {
  return !!document.querySelector(
    '[role="dialog"], [role="alertdialog"], [role="menu"], [data-shortcut-recorder="true"]',
  );
}
export function useAppShortcuts(options: {
  enabled: boolean;
  blocked: boolean;
  newThread: () => void;
  settings: () => void;
  sidebar: () => void;
  rightPanel: () => void;
}) {
  const workspace = useOptionalWorkspace();
  const keybindings = workspace?.keybindings ?? previewKeybindings;
  const hintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clear = useEventCallback(() => {
    clearTimeout(hintTimer.current);
    hintTimer.current = undefined;
    if (keybindings.getState().heldTargets)
      keybindings.setState({ heldTargets: undefined, showThreadHints: false });
  });
  const showHints = useEventCallback(() => {
    hintTimer.current = undefined;
    if (!options.enabled || options.blocked || shortcutOverlayOpen()) {
      clear();
      return;
    }
    if (keybindings.getState().heldTargets) keybindings.setState({ showThreadHints: true });
  });
  const handle = useEventCallback((event: KeyboardEvent) => {
    if (!options.enabled || options.blocked || shortcutOverlayOpen()) {
      clear();
      return;
    }
    if (event.isComposing || event.repeat || event.getModifierState("AltGraph")) return;
    const state = keybindings.getState();
    if ((isMacKeyboard() ? event.metaKey : event.ctrlKey) && !state.heldTargets) {
      keybindings.setState({ heldTargets: state.targets.slice(0, 10) });
      hintTimer.current = setTimeout(showHints, 500);
    }
    if (event.defaultPrevented) return;
    const pressed = recordedBinding(event);
    if (!pressed) return;
    const action = shortcutActions.find((action) => sameBinding(state.bindings[action], pressed));
    if (!action) return;
    const editable =
      event.target instanceof Element &&
      !!event.target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]');
    if (editable && editingConflict(pressed)) return;
    const index = threadActions.findIndex((entry) => entry === action);
    if (index >= 0) {
      const id = threadShortcutTarget(state.targets, state.heldTargets, index);
      if (!id || !state.selectThread) return;
      event.preventDefault();
      state.selectThread(id);
      return;
    }
    event.preventDefault();
    switch (action) {
      case "newThread":
        options.newThread();
        return;
      case "settings":
        options.settings();
        return;
      case "sidebar":
        options.sidebar();
        return;
      case "rightPanel":
        options.rightPanel();
        return;
    }
  });
  useEffect(() => {
    const release = (event: KeyboardEvent) => {
      if (!(isMacKeyboard() ? event.metaKey : event.ctrlKey)) clear();
    };
    const focus = () => {
      if (shortcutOverlayOpen()) clear();
    };
    const visibility = () => {
      if (document.hidden) clear();
    };
    window.addEventListener("keydown", handle);
    window.addEventListener("keyup", release);
    window.addEventListener("blur", clear);
    window.addEventListener("focusin", focus);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("keydown", handle);
      window.removeEventListener("keyup", release);
      window.removeEventListener("blur", clear);
      window.removeEventListener("focusin", focus);
      document.removeEventListener("visibilitychange", visibility);
      clear();
    };
  }, [handle, keybindings, clear]);
  useEffect(() => {
    if (options.blocked || !options.enabled) clear();
  }, [options.blocked, options.enabled, clear]);
}
