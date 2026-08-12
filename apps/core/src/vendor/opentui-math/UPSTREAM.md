# Upstream

- Project: https://github.com/neriousy/opentui-math
- Version: 0.1.0
- Commit: `98457599bf48b65a5b52a20aa5d2dc8d25cebaa4`
- Copied files: `src/types.ts`, `src/limits.ts`, `src/symbols.ts`, `src/parser.ts`, `src/layout.ts`, `src/render.ts`, and `LICENSE`
- Status: copied source files are unmodified from the pinned commit.

## Scope

This vendor contains only the standalone Unicode cell parser, layout engine, and string renderer. It excludes the OpenTUI renderable, streaming, graphics, MathJax/resvg, React, and Solid integrations.

## Update Procedure

1. Pin a new upstream commit and fetch the same paths from it.
2. Review upstream license, API, and test changes.
3. Replace the vendored files without local edits and update this record.
4. Run `bun test apps/core/tests/vendor/opentui-math.test.ts` and `bunx tsc -p apps/core/tsconfig.json --noEmit` from the repository root.
