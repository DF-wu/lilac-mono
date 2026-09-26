# Web frontend

Keep the web app responsive and preserve existing interaction performance.

## Performance

- Avoid prop drilling. Use Zustand for shared client state and TanStack Query for server state; keep
  local state local.
- Eliminate unnecessary rerenders and remounts. Subscribe narrowly so typing, streaming, and dragging
  update only the components that need to change.
- Keep wire schemas and transfers minimal: send only data shown on screen or needed to determine what
  is shown. Filter and project on the backend; prioritize visible content and incremental updates.
- Review frontend changes with the `vercel-react-best-practices` skill; install it if unavailable.
  Apply the React/Vite-relevant rules using this project's chosen libraries and fix bad patterns
  introduced or exposed by the change.

## UI

- Keep copy minimal and concrete. Labels and tooltips name the action or destination in familiar user
  terms. Omit redundant headings, explanatory filler, and internal terminology such as "surfaces".
- Use shared shadcn/ui components. When a task benefits from a component missing from the repo, add it
  and adapt it to the current design and shared tokens. Adding that component and its required
  dependencies is preauthorized.
- Keep layouts compact, spacing and radii consistent, and controls optically aligned. Wrap or bound
  content to prevent overflow; use borders only when spacing, color, or shadow cannot provide enough
  separation.
- Use recognizable Lucide icons with short tooltips. Reveal secondary actions on hover or in context
  menus and details on expansion. Keep temporarily unavailable controls in place but disabled.
- Preserve control positions and interaction state. Give immediate action feedback and use subtle
  motion to explain changes, honoring the shared animation preference.
- Render production components in the design-system page with matching styles and behavior. Keep
  relevant states and demos current, and verify changes in the real screen too.
- Preserve attachments and references across composing, sending, previewing, and copying. Keep
  previews usable with long text, large media, and zoom.

## Styling and themes

- Define design values in `src/theme/` first. Use their Tailwind aliases for component layout,
  spacing, typography, colors, and states. Shared primitive variants own repeated control styles.
- Keep custom CSS for generated content, coordinated animation, panel and virtualizer layout
  invariants, and the Catppuccin icon palette. Use `--ui-*` variables in these exceptions.
- Use data attributes for behavior and test selectors. Keep dynamic measurements in inline styles.
- When changing theme roles or registering theme data, read `src/theme/README.md` for the mapping,
  fallback policy, and syntax integration. Extend the gallery and theme tests with any new role.

## Verification and handoff

- Verify affected interactions in the running app. Compare performance before and after changes to
  rendering or data flow; treat added lag, flicker, layout shifts, and lost input or scroll state as
  regressions.
- When changing the UI, capture the changed UI in the running app and include a screenshot in the
  final response.
- When interaction feel, animation, or delay matters to the change, leave the dev server running and
  include a working link to the affected screen in the final response so the user can test it directly.
- Frontend work is complete after the required interaction checks and handoff. If the backend is unavailable,
  inspect the existing browser fixture and development instructions before declaring verification blocked.
