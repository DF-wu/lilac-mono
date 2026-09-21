# Theme core

`builtin.ts` and imported VS Code theme data go through `resolveTheme`. It resolves a bounded set of
UI roles. `theme.ts` writes those roles as `--ui-*` properties on the document; `tailwind.css` exposes
them to components. `tokens.css` owns spacing, type, radius, control dimensions, shadows, and motion.

Use semantic utilities such as `bg-primary text-primary-foreground`, `bg-input-background
text-input-foreground`, and `bg-selection text-selection-foreground`. A supplied background must
travel with its foreground. Links use `text-link`, independently of button fill. Add a role only for a
distinct use with a source, fallback, and gallery example. `draft` aliases warning; shadcn names such
as destructive and ring are aliases too. The default Tailwind color palette is disabled.

## Registering a pair

The adapter accepts already resolved theme objects. For example, in application bootstrap:

```ts
import light from "./themes/example-light.json";
import dark from "./themes/example-dark.json";
import { resolveTheme } from "./resolve-theme";
import { installThemes } from "./theme";

installThemes({ light: resolveTheme(light, "light"), dark: resolveTheme(dark, "dark") });
```

The current user preference still selects Light, Dark, or System. Registration is internal and does
not add a picker or store imported data. Treat registered objects as immutable; replacing a theme
requires resolving and installing a new object.

`resolve-theme.ts` is the mapping table. Supplied hex colors, including alpha and transparent hex,
win. Missing roles use a related color or the built-in palette for the effective kind. Derived tints,
borders, and shadows are centralized there. The adapter maps editor, sidebar, widget, menu, button,
input, list selection, link, focus, and status roles. It does not duplicate the VS Code workbench.

Ordered TextMate `tokenColors` or resolved Shiki `settings` load through the existing shared
highlighter. Cache keys include theme identity. Only code-rendering leaves subscribe to syntax
changes; UI colors update through CSS without subscribing the workspace tree. File line estimates
read the code line-height token once at mount, and rendered rows retain virtualizer measurement.

Resolve extension `include` files and path-valued `tokenColors` before registration. This module does
not parse JSONC files, fetch extensions, or apply language-server semantic tokens. It supports the
resolved data rather than a VS Code extension package. Catppuccin file icons remain independent and
follow the effective Light/Dark kind.

## Checks

The gallery uses production controls and shows semantic role pairs in Foundations. Check light and
dark, narrow layout, focus, selection, disabled, invalid, open menus, and long labels. Theme tests
exercise bundled GitHub Light/Dark syntax data, sparse palettes, transparency, and cache isolation.
The token guard checks raw UI colors and palette utilities outside theme data and the icon palette.
