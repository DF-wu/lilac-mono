# Mini Lilac

The installable Mini Lilac command. It bundles the terminal client and server behind one extensible
entry point:

```sh
./dist/main.js                         # terminal client
./dist/main.js tui --session <id>      # explicit terminal client
./dist/main.js server                  # server
./dist/main.js server auth codex       # server administration
```

The package is not currently published to the public npm registry. Build the current checkout with
Bun, which remains the runtime because the server uses Bun APIs:

```sh
bun install --frozen-lockfile
cd apps/mini-lilac
bun run build
./dist/main.js --help
```

## First Run

Create the default server configuration, authenticate with Codex, and start the server:

```sh
./dist/main.js server init
./dist/main.js server auth codex
./dist/main.js server
```

In another terminal, start the client from the workspace you want Mini Lilac to use:

```sh
cd /path/to/your/project
/path/to/lilac-mono/apps/mini-lilac/dist/main.js
```

`server init` writes `config.yaml`, `providers.yaml`, and `auth.json` under
`$XDG_STATE_HOME/mini-lilac` (or `~/.local/state/mini-lilac`). Existing files are skipped; use
`./dist/main.js server init --force` to replace them.

Build and exercise the publication-ready package from this directory:

```sh
bun run build
./dist/main.js --help
./dist/main.js server --help
npm pack ./dist
```

`bun run pack:npm` creates the npm tarball. `bun run publish:npm` publishes the staged `dist/`
package, leaving workspace-only source, scripts, and dependencies out of the registry metadata.

The `install:local` maintainer helper currently assumes an older `npm pack --json` output shape and
is not a supported installation path with npm 12. Use the direct built executable above until the
package is published or the helper is updated.

The client, server, their internal workspace dependencies, and the patched `@opentui/core`
JavaScript are bundled into `dist/main.js`. `@opentui/core` remains a package dependency so the
package manager installs its worker dependency and the correct native binary for the target
platform. No other Mini Lilac workspace package is required after publishing.
