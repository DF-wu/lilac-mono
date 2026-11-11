# Delivery integration

The Docker image keeps the fork's `lilac`, `Catalina`, and `Claudia` account variants on upstream's
Debian 13 image and architecture-aware Bun installation. Catalina and Claudia retain UID/GID
3000, their case-sensitive home directories, the Catalina-only `/home/Catalinna` compatibility
link, the root-owned runtime identity file, and environment restoration before privilege drop.
The runtime retains `rsync`, trusted Bun and `bunx`, `/app` as its working directory, native
clients, and the operator launcher. This integration adds no sudo grant.

The image verifier now tests exact package-manager/Bun agreement, the trusted `bunx` link,
`rsync`, the working directory, and read/write/ownership on a disposable bind mount. Existing
checks still cover token isolation, unprivileged native-runtime imports, TUI dependencies,
trusted launchers, readonly application files, output, and shutdown. It uses no deployment data.

## Exact commit publication

Ordinary main updates publish after successful push CI for that exact SHA. A completed CI event
supplies its `head_sha`; manual publication uses the invocation's fixed SHA. The image workflow
checks out that SHA and checks successful push-CI evidence and main freshness before building.
It checks main again immediately before pushing tags, so a build overtaken by a later main
update does not publish its convenience tags.

All invocations also share a repository/variant job concurrency group with cancellation disabled.
An already-started old upload therefore finishes before a new publisher for those tags can run;
it cannot finish after a newer successful publication and restore the old tag. Both main-freshness
checks remain, including for a job that waited. GitHub can replace pending jobs and does not promise
dispatch order; this is not a durable release queue or an atomic transaction with advancing main.

Scheduled upstream sync retains its fixed baseline/upstream/candidate SHAs, full reusable CI,
strict footprint gate, and main freshness/ancestry checks before fast-forward. Its image job
calls the reusable publisher only after verification and fast-forward succeed, passing that same
candidate SHA. This avoids dispatching a later `main` tip and does not incorrectly demand push-CI
from a `GITHUB_TOKEN` update, which does not trigger ordinary push workflows.

Git conflicts continue through the human review PR and read-only analysis path. The workflow does
not repair conflicts or publish an unverified candidate. Source CI, all three image identities,
and the computer-use integration job check out the requested candidate SHA.

Variant publication retains `catalina`, `claudia`, their short-SHA tags, and Catalina's `latest`.
OCI revision labels and `LILAC_BUILD_COMMIT` use the full publication SHA. The inherited scheduled
release continues producing versioned artifacts and image digests, but skips the fork Core
`latest` update so it cannot replace Catalina with its default `lilac` account image. Gateway
and runner convenience tags retain their upstream behavior.

## Verification evidence

Focused tests execute the actual YAML shell gates with disposable `git`, `gh`, and `docker`
stubs. They cover missing successful push-CI evidence, wrong checkout SHA, stale main, matching
versus mismatching verified candidates, conflict preparation without candidate publication,
the post-build freshness check, and fork release tag ownership. They also verify the real
reusable-workflow dependency edges and exact candidate checkout in every CI job.

Image builds use a frozen disposable context at
`/tmp/lilac-integration-image-context-avcp97i9`. Its sorted file-content manifest has SHA-256
`b4f3387220443f1c6e9bf90101fcced18a24274a1db7aba467ee6f3a2de56b98`, recorded at
`/tmp/lilac-image-context-manifest-20261111.txt`. Labels identify that context and pinned fork
`3c01ce2c29a66fa9be573f573c9865b7cb20c030` / upstream
`3493c0c6c06260e6c472bd230dc02d4b0308db43`. Build metadata records the fork HEAD with `dirty=true`;
these are local integration verification images, not a claimed final release commit.

All three unique amd64 builds completed and passed `bash docker/verify-image.sh IMAGE USER UID`:

| Local image tag | User / UID / GID | Image ID |
| --- | --- | --- |
| `lilac:pr101-integration-20261111-default` | `lilac` / 1000 / 1000 | `sha256:c356e9c73415ac86e905cbba205dcd83cfa7c4db9f348434f8a9017454933b30` |
| `lilac:pr101-integration-20261111-catalina` | `Catalina` / 3000 / 3000 | `sha256:ab0c60537061b0d8fa0747265cbce15f5d07a18d721dc0ce0905058daa361ae4` |
| `lilac:pr101-integration-20261111-claudia` | `Claudia` / 3000 / 3000 | `sha256:bfc6aefdb6a6c3180b7c445a6d6ec9e047fafe9c8ddd6eb1b711d3291cc5c5ea` |

The expanded verifier used the images' exact Bun **1.4.4**. No existing image tag was overwritten
and no production container, volume, or service was modified. Task smoke containers and scratch
bind mounts were removed by the verifier. Available workspace disk remained approximately 33 GB
after building the variants; no shared image/cache pruning was performed.

The focused Docker/build/publication test files passed **18 tests** on Bun 1.4.4. Entrypoint and
verifier shell syntax, changed-test formatting, and diff whitespace checks passed. The root
typecheck attempt was blocked by concurrent `scripts/telegram-live-smoke.ts` Result API updates,
which belong to the parent integration work.

The image context predates subsequent changes in `apps/core/src/runtime/start-core-runtime.ts`,
`apps/core/src/surface/telegram/telegram-request-router.ts`,
`apps/core/src/transcript/transcript-store.ts`, and `package.json`. These are snapshot smoke
results; the parent owns final repository checks and the final-tree rebuild. Local amd64 checks
do not certify arm64 or actual GitHub/GHCR publication.

Independent review correction: scheduled/manual releases now call the existing reusable CI at the fixed release SHA with a pinned upstream footprint reference. Artifact builds depend on that verification, including after token-authenticated syncs that do not create push-CI events. Failed verification or an unchanged scheduled release cannot publish artifacts.
