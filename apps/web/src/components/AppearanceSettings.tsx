import { useEffect, useState, type CSSProperties } from "react";
import { Moon, Sun } from "lucide-react";
import {
  cachedThemePair,
  loadThemePair,
  themeCatalog,
  type ResolvedThemePair,
  type ThemeId,
} from "../theme/catalog";
import type { ResolvedTheme, ThemeKind } from "../theme/resolve-theme";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { selectTheme, themeStyle, useInstalledThemes, useThemeSelection } from "../theme/theme";

const schemes = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;
const swatchRoles = ["background", "info", "danger", "primary"] as const;
type SwatchStyle = CSSProperties & {
  "--swatch-count"?: number;
  "--swatch-index"?: number;
  "--swatch-distance"?: number;
};

export function AppearanceSettings({
  theme,
  onTheme,
}: {
  theme: string;
  onTheme: (value: string) => void;
}) {
  return (
    <>
      <div className="mb-8">
        <span className="block py-2 mb-2">Color scheme</span>
        <div className="grid grid-cols-3 gap-3" role="group" aria-label="Color scheme">
          {schemes.map((scheme) => (
            <button
              key={scheme.value}
              type="button"
              aria-pressed={theme === scheme.value}
              className="flex flex-col gap-2 rounded-lg bg-surface p-2 text-sm text-surface-foreground outline-none transition-shadow hover:bg-surface-hover focus-visible:ring-3 focus-visible:ring-ring/50 aria-pressed:ring-2 aria-pressed:ring-primary"
              onClick={() => onTheme(scheme.value)}
            >
              <SchemePreview scheme={scheme.value} />
              {scheme.label}
            </button>
          ))}
        </div>
      </div>
      <div className="mb-8">
        <span className="block py-2 mb-2">Theme</span>
        <ThemePicker />
      </div>
    </>
  );
}

function SchemePreview({ scheme }: { scheme: (typeof schemes)[number]["value"] }) {
  const themes = useInstalledThemes();
  return (
    <span className="relative block h-16 overflow-hidden rounded-md" aria-hidden="true">
      {scheme === "dark" ? null : <SchemeMock theme={themes.light} />}
      {scheme === "light" ? null : (
        <SchemeMock
          theme={themes.dark}
          className={scheme === "system" ? "[clip-path:inset(0_0_0_50%)]" : undefined}
        />
      )}
    </span>
  );
}

function SchemeMock({ theme, className = "" }: { theme: ResolvedTheme; className?: string }) {
  return (
    <span className={`absolute inset-0 flex bg-background ${className}`} style={themeStyle(theme)}>
      <span className="flex w-1/4 flex-col gap-1 bg-sidebar p-1.5">
        <span className="h-1.5 rounded-full bg-selection" />
        <span className="h-1.5 w-3/4 rounded-full bg-muted-foreground/30" />
      </span>
      <span className="flex flex-1 flex-col gap-1.5 p-2">
        <span className="h-2.5 w-1/2 self-end rounded-md bg-surface-raised" />
        <span className="h-1.5 w-3/4 rounded-full bg-muted-foreground/40" />
        <span className="mt-auto flex h-3 items-center justify-end rounded-md bg-input-background px-1">
          <span className="size-1.5 rounded-full bg-primary" />
        </span>
      </span>
    </span>
  );
}

function useThemePairs() {
  const [pairs, setPairs] = useState(() => {
    const entries = themeCatalog.map((entry) => [entry.id, cachedThemePair(entry.id)] as const);
    return new Map<ThemeId, ResolvedThemePair | undefined>(entries);
  });
  useEffect(() => {
    let active = true;
    for (const entry of themeCatalog) {
      if (cachedThemePair(entry.id)) continue;
      void loadThemePair(entry.id).then((result) => {
        if (!active) return;
        result.match({
          ok: (pair) => setPairs((current) => new Map(current).set(entry.id, pair)),
          err: () => {},
        });
      });
    }
    return () => {
      active = false;
    };
  }, []);
  return pairs;
}

function ThemePicker() {
  const selection = useThemeSelection();
  const pairs = useThemePairs();
  return (
    <div
      className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(11rem,1fr))]"
      role="group"
      aria-label="Theme"
    >
      {themeCatalog.map((entry) => {
        const pair = pairs.get(entry.id);
        return (
          <div
            key={entry.id}
            className="relative flex flex-col gap-4 rounded-lg bg-surface p-3 text-surface-foreground has-[[data-theme-card-select]:hover]:bg-surface-hover"
          >
            <button
              type="button"
              data-theme-card-select
              className="self-start rounded-sm text-sm font-medium outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:ring-3 focus-visible:ring-ring/50"
              aria-label={`Use ${entry.name} for light and dark`}
              onClick={() => void selectTheme(entry.id, ["light", "dark"])}
            >
              {entry.name}
            </button>
            <div className="flex justify-around pb-1">
              <SwatchStack
                name={entry.name}
                id={entry.id}
                kind="light"
                theme={pair?.light}
                selected={selection.light === entry.id}
              />
              <SwatchStack
                name={entry.name}
                id={entry.id}
                kind="dark"
                theme={pair?.dark}
                selected={selection.dark === entry.id}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SwatchStack({
  name,
  id,
  kind,
  theme,
  selected,
}: {
  name: string;
  id: ThemeId;
  kind: ThemeKind;
  theme?: ResolvedTheme;
  selected: boolean;
}) {
  const Icon = kind === "light" ? Sun : Moon;
  const center = (swatchRoles.length - 1) / 2;
  const stackStyle: SwatchStyle = { "--swatch-count": swatchRoles.length };
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="theme-swatches group relative z-10 rounded-full outline-none hover:z-20 focus-visible:z-20 focus-visible:ring-3 focus-visible:ring-ring/50 aria-pressed:ring-2 aria-pressed:ring-primary aria-pressed:ring-offset-3 aria-pressed:ring-offset-surface"
            style={stackStyle}
            aria-pressed={selected}
            aria-label={`Use ${name} ${kind} theme`}
            onClick={() => void selectTheme(id, [kind])}
          />
        }
      >
        {swatchRoles.map((role, index) => {
          const style: SwatchStyle = {
            "--swatch-index": index,
            "--swatch-distance": Math.abs(index - center),
            backgroundColor: theme?.variables[role],
          };
          return (
            <span
              key={role}
              className="theme-swatch absolute top-0 rounded-full border-2 border-surface bg-muted ring-1 ring-foreground/15"
              style={style}
            />
          );
        })}
        <span className="absolute -right-1.5 -bottom-1.5 grid size-4 place-items-center rounded-full bg-surface-raised text-muted-foreground [&_svg]:size-3 group-aria-pressed:bg-primary group-aria-pressed:text-primary-foreground">
          <Icon />
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{`${name} ${kind}`}</TooltipContent>
    </Tooltip>
  );
}
