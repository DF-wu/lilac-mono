# @stanley2058/lilac-remote-fs-runner

Remote filesystem helper used by Lilac SSH tools.

The CLI starts or reuses a short-lived local daemon on the remote machine, then serves JSON filesystem requests over a Unix socket. It uses `@ff-labs/fff-node` for warm indexed search when available. Fuzzy file search falls back to an on-demand filesystem walk ranked by `fzf` when an FFF index is unavailable or unsafe for the requested path.

This package is intended to be launched by Lilac via `npx`/`bunx`, not called directly by users.
