# Web theme and styling unification

Status: proposal, not an approved implementation plan.

## Outcome

Define Lilac's design variables once, expose them through Tailwind, and use utilities in production components. A VS Code color theme should supply UI colors and code highlighting through one adapter. Components should not know which theme supplied a value.

Keep the current layout and interaction behavior during migration. This work does not redesign the UI.

## Audit

Source audit at `cbe69694`:

- 14 CSS files contain 2,404 lines. `src/styles.css` accounts for 1,537 lines. There are 66 TSX files.
- `styles.css:15` bridges semantic colors into Tailwind, but does not unify spacing, control sizes, fonts, shadows, and the full radius scale.
- `styles.css:38` defines app variables. Its spacing scale differs from Tailwind's numeric scale: `--space-5` is 1.5rem, `--space-6` is 2rem, and `--space-7` is 3rem. They correspond to Tailwind's `6`, `8`, and `12`, not `5`, `6`, and `7`.
- Shared primitives use Tailwind utilities, while feature components layer custom classes over them. `IconButton` adds `.icon-button` to a `Button` with its own size/radius utilities. Attachments, inputs, dialogs, and message bubbles have similar overlapping ownership.
- Custom radius values stop at `lg`; primitives also use Tailwind's `xl` and `2xl`. The current custom `lg` is larger than Tailwind's default `xl`.
- `styles.css` repeats selectors such as `.sidebar`, `.sidebar-header`, `.sidebar-toggle`, and `.thread-header`. Some repetitions are responsive rules; others are later component overrides. Feature CSS is often unlayered while general styles use cascade layers, allowing custom rules to override utilities regardless of apparent class order.
- The dialog backdrop uses `bg-black/10`, bypassing `--overlay`. Note alerts define their own blue pair. Warning alerts reuse `--draft`. These need semantic ownership rather than more isolated colors.
- Buttons, links, highlights, and syntax keywords reuse `--primary`. That works for the current palette but cannot preserve VS Code themes that give these roles different colors. Input borders and input backgrounds also share values in the current Tailwind mapping.
- Font families are repeated. File source rows have a 24px CSS line height and a matching virtualizer estimate in `FileCode.tsx`; changing only CSS can invalidate sizing assumptions.
- Shiki uses a handcrafted CSS-variable theme. It follows app colors, but does not load an imported theme's TextMate rules. Its token cache is keyed only by source and language.
- Mermaid's sanitized SVG is recolored with app variables. This is a useful generated-content CSS exception.
- File icons use a separate Catppuccin palette. Keep Mocha/Latte, as requested; icon themes and UI color themes are separate concerns.
- Some classes are behavior hooks: preview dismissal and image copying in `ResourcePreview.tsx`, row actions in `ThreadQueue.tsx`, and message interaction in `Timeline.tsx`. Removing those classes blindly would change behavior.
- The design-system page renders production components, but mostly offers light/dark switching and happy-path specimens. It needs imported-theme and interaction-state coverage to verify this migration.

## Target ownership

The flow is:

`built-in or VS Code theme → resolved app variables → Tailwind aliases → components`

Syntax follows a parallel path through the same selected theme:

`theme tokenColors → existing Shiki highlighter → chat code and file source`

Suggested organization:

- `src/theme/tokens.css`: non-color design variables for spacing, typography, radii, control dimensions, shadows, and motion.
- `src/theme/tailwind.css`: the complete Tailwind bridge, without independent visual values.
- `src/theme/resolve-theme.ts`: normalize supported theme input and resolve all UI roles with a single fallback table.
- `src/theme/themes/`: built-in theme data, using the same color input shape as imported themes.
- `src/theme/apply-theme.ts`: apply a resolved palette and effective light/dark mode to the document. Keep preferences and DOM application separate.
- `styles.css`: imports and minimal document defaults. Small dedicated stylesheets remain for the exceptions below.

These are ownership targets, not a requirement to create a module for every function.

Use an app-prefixed namespace such as `--ui-*` for source variables. Tailwind's `--color-*`, `--spacing`, `--text-*`, and `--radius-*` become aliases, preventing accidental collisions between Tailwind defaults and app definitions.

For example:

```css
@theme inline {
  --color-canvas: var(--ui-canvas);
  --color-canvas-foreground: var(--ui-canvas-foreground);
  --color-link: var(--ui-link);
  --spacing: var(--ui-space-unit);
  --radius-md: var(--ui-radius-md);
  --font-sans: var(--ui-font-sans);
  --font-mono: var(--ui-font-mono);
  --text-sm: var(--ui-text-sm);
  --text-sm--line-height: var(--ui-line-normal);
}
```

Use `@theme inline` for aliases to runtime variables. Define breakpoint values as build-time constants; runtime CSS variables cannot drive media-query breakpoints. See [Tailwind theme variables](https://tailwindcss.com/docs/theme).

## Color system

Use a closed set of semantic roles based on actual consumers. Do not copy every VS Code color ID into a second application-wide palette, and do not add a color for every component or state.

Resolve meaningful foreground/background pairs together. Do not use one generic primary color as both link text and button fill. The following is the proposed mapping, finalized against the component inventory in the first implementation step:

| App role | Preferred VS Code source |
| --- | --- |
| Chat and file canvas | `editor.background`, `editor.foreground` |
| Sidebar | `sideBar.background`, `sideBar.foreground` |
| Raised surfaces and dialogs | `editorWidget.background`, `editorWidget.foreground` |
| Menus | `menu.background`, `menu.foreground` |
| Secondary/disabled text | `descriptionForeground`, `disabledForeground` |
| Primary action | `button.background`, `button.foreground`, `button.hoverBackground` |
| Secondary action | `button.secondaryBackground`, `button.secondaryForeground`, `button.secondaryHoverBackground` |
| Input | `input.background`, `input.foreground`, `input.border`, `input.placeholderForeground` |
| Hover and selection | `list.hoverBackground`/`list.hoverForeground`, `list.activeSelectionBackground`/`list.activeSelectionForeground` |
| Links | `textLink.foreground`, `textLink.activeForeground` |
| Borders and focus | Context-appropriate `panel.border`, `widget.border`, `focusBorder`; honor `contrastBorder` where provided |
| Status colors | `editorInfo.foreground`, `editorWarning.foreground`, `errorForeground`, `testing.iconPassed` |
| Code line numbers and selection | `editorLineNumber.foreground`, `editor.selectionBackground` |

Fallback policy:

1. Use the corresponding supplied color, including valid alpha and explicit transparency.
2. Use a documented related role when that pair is suitable.
3. Use the built-in defaults for the effective theme kind when needed. Do not import the whole VS Code runtime to obtain defaults.

Keep hover, disabled, and selection logic here. Derive missing tints and overlays centrally; remove per-component lightness calculations and arbitrary opacity choices where a semantic state exists. Retain authored values, and test contrast rather than silently replacing a theme's palette.

`draft` becomes an alias of the warning role unless a separate product meaning is approved. `destructive`, `ring`, and existing shadcn names may remain compatibility aliases, not independently configurable colors. Every new role must name a distinct use, its source/fallback, and a design-system specimen.

VS Code supports UI color keys and alpha-bearing hex values, with distinct roles for controls and states. See the [theme color reference](https://code.visualstudio.com/api/references/theme-color).

## VS Code compatibility

The first deliverable is a theme adapter and a way to register a theme in the app/design gallery without manually translating its colors. It is not a Marketplace client.

- Accept resolved theme data containing a light/dark kind, `colors`, and ordered TextMate `tokenColors`. Use the same path for built-in themes.
- Support self-contained exported VS Code theme JSON/JSONC as the initial file format. Reuse an existing suitable parser if available; do not parse JSONC by stripping comments with regex. A new direct dependency needs approval before implementation.
- Theme kind comes from theme metadata or an explicit registration value. Keep effective kind separate from the user's system/light/dark preference.
- Theme files can reference another file through `include`, or reference a `.tmTheme` through `tokenColors`. The core adapter receives resolved data. The initial loader must report unresolved references clearly; packaged-theme resolution requires a separately scoped loader and supplied referenced files. Do not silently claim full extension compatibility.
- Load the theme's actual TextMate rules through Shiki, including foreground, background, and font styles. Do not collapse its syntax colors into the small UI palette.
- Cache highlighted results by theme identity/revision as well as source and language. Notify code-rendering leaves when syntax changes, without remounting the composer, sidebar, panels, or message tree.
- Keep UI theme application at the document level. Theme colors should not become props threaded through every component.
- VS Code semantic-token rules rely on language-service data. Lilac's current grammar highlighter cannot reproduce those rules fully; do not add an LSP as part of theming.
- Keep Catppuccin file icons independent, choosing Latte or Mocha from effective light/dark kind.
- Exercise contrast-border themes in the gallery. Do not advertise complete VS Code high-contrast parity until all interactive states have been verified.

VS Code documents [UI and syntax theme separation](https://code.visualstudio.com/api/extension-guides/color-theme), and its [theme loader](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/themes/common/colorThemeData.ts) handles referenced theme files. Shiki supports [loading custom themes](https://shiki.style/guide/load-theme).

A user-facing import/picker and persistence of imported files are a separate product step. They introduce stored data and need explicit approval under `AGENTS.md`. This proposal establishes compatibility and verifies it in the gallery without adding that storage contract.

## Styling rules

- Use Tailwind utilities for ordinary layout, spacing, typography, borders, colors, and states. Shared primitive variants own repeated utility combinations.
- Reset Tailwind's unused default color namespace after migrating existing uses. Expose only approved semantic aliases; do not retain a second arbitrary palette alongside the theme.
- Use one spacing unit with normal Tailwind numeric utilities. Translate existing spacing by computed value, not by matching the old token's suffix.
- Define complete typography/radius/shadow scales used by production primitives. Map control and icon sizes consistently. Check the existing `cn` merger against any named custom utilities before adopting them.
- Prefer explicit `data-slot`, `data-state`, and accessibility attributes for state and behavior. Use Tailwind variants for their styling.
- Keep dynamic measurements in inline styles or CSS variables: dragged panel widths, virtualizer offsets, image zoom, and measured heights are runtime data, not theme tokens.
- Avoid moving each old class into an `@apply` wrapper. That would retain two style ownership systems.

Allowed custom CSS:

1. Token definitions, Tailwind bridging, and minimal document defaults.
2. Keyframes and coordinated transitions where CSS is clearer, including reduced-motion handling.
3. Generated content selectors for Markdown, Plate, Mermaid, MathJax, and highlighted tokens when utilities cannot reasonably be attached to the generated nodes.
4. Small layout invariants such as the panel grid calculations and hidden-tab measurement rule. Ordinary presentation around these moves to utilities.
5. Vendored file-icon palette definitions.

Keep each exception local, token-driven, and justified. Normal hover/focus/selected styling is not an animation exception. Class names needed only as behavior hooks migrate to data attributes rather than becoming permanent styling dependencies.

## Incremental implementation

1. **Capture the baseline and finalize the role map.** Inventory each primitive's states and effective styles. Record light/dark screenshots and representative performance traces. Identify behavior/test selectors and the CSS exceptions before editing.
2. **Unify variables and the Tailwind bridge.** Introduce the single sizing/type/radius/shadow source. Preserve existing built-in colors. Keep temporary aliases while migrating callers; verify a changed spacing unit, font, and radius reaches every primitive. Preserve the current 760px responsive transition during the refactor.
3. **Add the theme adapter and syntax integration.** Route built-in and two self-contained VS Code theme fixtures through the same resolver. Test missing colors, alpha, kind resolution, TextMate styles, and switching between themes with distinct link/button/selection colors. Add gallery preview selection without persistent import storage.
4. **Migrate shared primitives.** Buttons, icon buttons, inputs, selects, tabs, overlays, menus, tooltips, toasts, avatars, bubbles, and attachments. Remove duplicate custom styling once its caller is migrated. Preserve focus, disabled, invalid, selected, and open states.
5. **Migrate feature areas in reviewable slices.** Settings/login and agent views; then sidebar/thread cards; then composer/messages; then attachments/previews/file tabs; finally workspace layout and the gallery. Move behavior hooks first in each slice. Retain panel and virtualizer invariants throughout.
6. **Remove compatibility leftovers and prevent drift.** Delete only proven-unused selectors and aliases. Centralize generated-content exceptions. Add a focused repository check for raw UI colors/default palette utilities outside approved token/asset files. Document the utility-first rule and the exception list in the frontend instructions.

Each slice should pass focused tests, workspace typechecking, and browser checks. Run `bun run check` against final changes before each requested commit. Do not bundle a behavior redesign with a styling conversion.

## Acceptance and verification

- All ordinary component styling uses utilities derived from the defined app variables. No independent raw UI palette remains in feature components.
- The design gallery includes normal, hover, focus-visible, active, selected, disabled, invalid, loading, and open states where applicable, plus long labels and narrow layouts.
- Registering a self-contained VS Code theme requires no component edits or manual per-component color mapping. Its actual TextMate colors appear in chat and file source.
- Test the built-in pair, a distinct light/dark imported pair, a sparse theme, alpha colors, and a contrast-border fixture. Verify background/foreground pairings on menus, selected rows, controls, and code.
- Theme switching does not reset input, drafts, editor selection, focus, scroll position, open dialogs, panel widths, or file tabs. Changing UI colors does not rerender the workspace tree; syntax work is limited to the relevant rendering leaves.
- Compare baseline and migrated behavior for thread switching, composer typing, panel dragging/toggling, file-tab switching, wrapped source lines, and attachment previews. Preserve current mount counts and investigate any new rendering or layout work.
- Test desktop and narrow layouts in Chromium and Firefox, including system theme changes and reduced motion. Keep screenshots as review evidence; do not substitute snapshot churn for behavior checks.
- Confirm production output, theme assets, and any vendored fixtures retain required licensing. No new dependency or persistence contract is assumed approved by this draft.
