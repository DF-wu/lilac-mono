# Native surface implementation progress

Active plan: [native-surface.md](native-surface.md). Product scope and stage exit gates are unchanged.

## Stage 0, in progress

The initial slice establishes a registered `packages/client-protocol` workspace, strict pre-release
replay schemas, typed oRPC sync contracts, a test-only reducer and real Bun WebSocket proofs. It does
not expose a gateway, change existing surfaces or persist native data.

Measured on Linux x86_64, AMD Ryzen 9 5950X, Bun 1.4.2, loopback with no injected latency:

| Proof | Result |
| --- | --- |
| Unchanged sync, representative IDs | 355 bytes including masked client and server WebSocket framing. |
| Unchanged sync, maximum schema identifier lengths and revisions | 753 bytes with framing. |
| Browser transport-only bundle | 24,647 bytes minified, 8,842 bytes gzip. No Core/server/schema/AI runtime imports. This excludes the future cache/reducer and UI. |
| Transport behavior | Runtime input/output validation, concurrent RPC during subscription, cancellation and socket-close subscription cleanup pass. |
| Replay model | Latest-first window, turn/range hydration, stale generation/revision fencing, independent unresolved coverage and retry are covered by executable fixtures. |

The transport byte proof excludes authentication/connection establishment and unrelated traffic, as
required by the plan. It does not yet prove server-side cursor expiry handling or real storage replay.
The proof server is test-only and binds loopback on an ephemeral port. Tests synchronize on promises
and socket events, with no fixed sleeps.

Production contracts currently contain only the display text subset needed by these proofs. Full
message/tool/resource parts, command receipts, authority, bootstrap catalogs, admission and cache
persistence remain unfinished. The reducer stays under test support until the shared client owns its
production implementation. The 256 KiB prototype frame budget and 128-slot batch bound are not new
Core configuration options.

Research evidence:

- [Admission, durable output, publication boundaries and rewind](native-stage0-handoffs.md).
- [Authentication and terminal dependencies/limits](native-stage0-auth-terminal.md).

The existing output stream cannot provide native durability unchanged. It expires and accepts only
tail subscriptions. The handoff audit identifies a durable native event path and WAL publication
ordering that require executable crash tests. Pending uploads must remain outside execution admission
until resources are ready, because its existing materialization timeout is 60 seconds.

## Remaining Stage 0 gates

- Complete versioned contracts and enumerate native store/config/event migration scope. Add bounded
  paging within huge single turns and wire hydration/live-update events into typed subscriptions.
- Prove authenticated bootstrap/socket/resource operation and principal normalization, local sessions,
  Clerk refresh and TUI PKCE. Real Clerk sign-in needs a configured test installation.
- Prove durable input/output handoffs, upload-ready/control races and rewind recovery at the identified
  owners. Confirm late steering disposition before freezing that contract.
- Exercise semantic text/step/phase/compaction publication, including abnormal termination and retry.
- Complete bootstrap/live ordering and persistent cache crash proofs.
- Verify OpenTUI clipboard and terminal behavior in Ghostty/Kitty and define the release fixture's
  latency/history windows and replay retention byte cap.
- Review the complete stage, fix blockers and repeat review before closing it.

## Initial slice review

Independent review found missing-target cursor advancement and a stale-generation resync race. The
proof reducer now preserves the committed checkpoint, requires resync for unsupported changes, and
retains the highest observed generation/revision while waiting for a valid replacement window.
Canonical ASCII identifiers make the maximum-length byte fixture cover permitted identifier values.
The reviewer repeated the review after fixes and reported no blockers for this slice. The empty
architecture exception-registry entry for the new workspace grants no exemptions.

Validation: all 20 package tests and the package typecheck passed. Full `bun run check` passed after
the workspace registration fix, including architecture, lint, formatting, repository typechecks and
tests.

No stage has been closed. Incremental commits do not imply stage completion.
