import { Result } from "better-result";
import { createStore } from "zustand/vanilla";
import { z } from "zod";
import type { CacheScope } from "@stanley2058/lilac-client";

export const panelSizes = {
  left: { initial: 288, min: 192, max: 512 },
  right: { initial: 360, min: 240, max: 640 },
};
type PanelLayout = { open: boolean; width: number };
export const defaultRightPanel: PanelLayout = { open: false, width: panelSizes.right.initial };
const defaultSidebar: PanelLayout = { open: true, width: panelSizes.left.initial };
const layoutSchema = (side: keyof typeof panelSizes) =>
  z
    .object({
      open: z.boolean(),
      width: z.number().int().min(panelSizes[side].min).max(panelSizes[side].max),
    })
    .strict();
const storedPanelsSchema = z
  .object({
    sidebar: layoutSchema("left"),
    threads: z.array(z.tuple([z.string(), layoutSchema("right")])),
  })
  .strict();
type PanelLayouts = { sidebar: PanelLayout; threads: Map<string, PanelLayout> };
type PanelStore = PanelLayouts & {
  selection?: { threadId: string; agentId: string };
  toggleSidebar: () => void;
  resizeSidebar: (width: number) => void;
  toggle: (threadId: string) => void;
  resize: (threadId: string, width: number) => void;
  select: (threadId: string, agentId: string) => void;
  back: () => void;
  moveThread: (from: string, to: string) => void;
};

function decodePanelLayouts(value: unknown): PanelLayouts | undefined {
  const decoded = storedPanelsSchema.safeParse(value);
  if (!decoded.success) return undefined;
  return { sidebar: decoded.data.sidebar, threads: new Map(decoded.data.threads) };
}

export function createPanelStore(
  scope?: Pick<CacheScope, "installationId" | "principalId">,
  storage?: Pick<Storage, "getItem" | "setItem">,
) {
  const key = scope
    ? `lilac-panels-v1:${JSON.stringify([scope.installationId, scope.principalId])}`
    : undefined;
  const defaults: PanelLayouts = { sidebar: defaultSidebar, threads: new Map() };
  const initial = key
    ? Result.try({
        try: (): unknown => {
          const raw = (storage ?? localStorage).getItem(key);
          return raw ? JSON.parse(raw) : null;
        },
        catch: () => "Storage unavailable",
      }).match({
        ok: (value) => decodePanelLayouts(value) ?? defaults,
        err: () => defaults,
      })
    : defaults;

  function save(layouts: PanelLayouts) {
    if (!key) return;
    Result.try({
      try: () =>
        (storage ?? localStorage).setItem(
          key,
          JSON.stringify({
            sidebar: layouts.sidebar,
            threads: [...layouts.threads],
          }),
        ),
      catch: () => "Storage unavailable",
    }).match({ ok: () => {}, err: () => {} });
  }

  return createStore<PanelStore>((set, get) => {
    function updateRight(threadId: string, change: Partial<PanelLayout>) {
      const threads = new Map(get().threads);
      threads.set(threadId, { ...(threads.get(threadId) ?? defaultRightPanel), ...change });
      set({ threads });
      save(get());
    }
    function updateSidebar(change: Partial<PanelLayout>) {
      set({ sidebar: { ...get().sidebar, ...change } });
      save(get());
    }
    return {
      ...initial,
      toggleSidebar: () => updateSidebar({ open: !get().sidebar.open }),
      resizeSidebar: (width) => updateSidebar({ width }),
      toggle: (threadId) =>
        updateRight(threadId, { open: !(get().threads.get(threadId) ?? defaultRightPanel).open }),
      resize: (threadId, width) => updateRight(threadId, { width }),
      select: (threadId, agentId) => {
        set({ selection: { threadId, agentId } });
        updateRight(threadId, { open: true });
      },
      back: () => set({ selection: undefined }),
      moveThread: (from, to) => {
        const layout = get().threads.get(from);
        if (!layout) return;
        const threads = new Map(get().threads);
        threads.delete(from);
        threads.set(to, layout);
        set({ threads });
        save(get());
      },
    };
  });
}
