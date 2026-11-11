#!/usr/bin/env python3
"""Rebuild the pinned fork-path inventory; reads Git and writes these reports only."""

import json
import subprocess
from pathlib import Path

BASE = "05c41baa7a45b728d1722d69d5e55d5dc9e580b4"
FORK = "3c01ce2c29a66fa9be573f573c9865b7cb20c030"
REFRESHED_FORK = "2e5159be7b23fa34a25a517275d20f327858f9f7"
UPSTREAM = "3493c0c6c06260e6c472bd230dc02d4b0308db43"
OUT = Path(__file__).resolve().parent
ROOT = Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def paths(*args):
    return set(filter(None, git(*args).splitlines()))


def owner(path):
    """Explicit ownership rules cover code, checks, documentation and metadata."""
    p = path.lower()
    if p.startswith("docs/fork-integration-20261111/"):
        return "Integration evidence", "Inventory, source decisions, migration, review and verification evidence", "Report/source reconciliation"
    if path not in original and path not in remaining and path not in followup:
        return "Inherited upstream", "Already landed through PR #101; candidate preserves the current upstream owner", "Full repository checks and applicable workspace tests"
    if p == "migrations.md":
        return "F07/F16/F23", "Shared schema transitions and explicit offline support boundary", "Migration, workflow reopen, config parity and backup/restore fixtures"
    if "migration" in p or "frozen-graceful" in p or "startup-blob" in p or "legacy-transient-blob-state" in p or "migrate-blob-storage" in p:
        return "F16", "Offline baseline replaces removed runtime legacy migration machinery", "Disposable historical migration and backup/restore fixtures"
    if p.startswith(".serena/") or p in (".gitignore", ".oxfmtrc.json"):
        return "Developer metadata", "Preserve existing developer metadata without including local WIP", "Diff review; no runtime behavior"
    if p.startswith("scripts/architecture/") or p.startswith("scripts/fork/") or p.startswith("scripts/oxlint-plugins/") or "footprint" in p or p == "scripts/run-gates.ts":
        return "F22", "Exact current architecture and upstream footprint ownership", "Architecture, lint-rule/type checks and strict footprint"
    if p.startswith(".github/") or "release-gate" in p or "fork-delivery-workflows" in p:
        return "F21", "Verified candidate, publication freshness and single image-tag ownership", "Release/sync gates and CI relationship tests"
    if "docker" in p or p in ("dockerfile", "compose.yaml"):
        if "telegram" in p:
            return "F01–F04", "Telegram disposable smoke and cleanup helpers", "Telegram fixture suites; no live smoke"
        return "F20", "Named identity/home delivery on upstream image/runtime architecture", "Docker script tests and default/Catalina/Claudia image smoke"
    if "custom-media" in p or p in ("apps/tool-bridge/index.ts", "apps/tool-bridge/index.test.ts"):
        return "F11", "External plugin compatibility, configuration availability and video protocol", "Source/bundle parity and plugin tests/typecheck/build"
    if p == "apps/core/tests/surface/native/operator-integration.test.ts":
        return "Inherited verification", "Real operator gateway fixture uses an ephemeral listener, preserving production port", "Operator integration and full repository test suite"
    if "discord-mirror" in p or "native-discord" in p:
        return "F08", "Committed visible native recording and scoped attachment authority", "Native mirror/store commit and exclusion regressions"
    if "image-script" in p or "image-generation" in p or "generate-image" in p:
        return "F10", "Compatible endpoint adapter over upstream image scripts; structured tool retired", "Image-script local generation/edit fixtures and restricted denial"
    if "openai-compatible-tool-images" in p or "tool-images" in p or p == "packages/utils/model-provider.ts":
        return "F13", "Compatible Chat provider-view projection; canonical history unchanged", "Middleware factories/parallel/replay/immutability tests"
    if "compaction" in p or p in ("packages/agent/auto-compaction.ts",):
        return "F14", "Protect current canonical input on upstream compaction owner", "Multipart, boundary, overflow, mapped/replayed and server fallback tests"
    if p.startswith("packages/agent/"):
        return "F12/F14", "Parsed local tools and active input on upstream execution owner", "Agent adapter and compaction suites"
    if "web-search" in p or p.endswith("/web.ts") or p.endswith("/web.test.ts") or "provider-page-extraction" in p:
        return "F09", "Hosted search adapter and search-only extraction fallback", "OpenAI search/model/web-chain tests"
    if "config" in p or p == "packages/utils/core-config/types.ts":
        return "F23", "Version-owned Telegram/OpenAI schema extensions and isolated defaults", "V1 freeze, V2/V3 runtime/editor parity and schema freshness"
    if "menu-alias" in p or "custom-commands" in p:
        return "F05", "Small Telegram command-menu grammar/alias adapter", "Alias/menu/router and ordinary command tests"
    if "/conversation/" in p or "conversation-thread" in p or "telegram-conversation-source" in p:
        return "F06", "Telegram source on upstream per-subject derived memory entries", "Worker pool, entries/offsets/generations/revisions/revocation tests"
    if "/workflow" in p or "workflow-authoring" in p:
        return "F07/F15", "Telegram origin/wait/progress authorization on schema28 workflow owner", "Reopen/cancel/replay, atomic waits and send/edit/fire authorization"
    if "telegram" in p:
        return "F01–F05", "Telegram protocol lifecycle/routing/output/media adapter", "Lifecycle, claims/interleavings, output/media/menu fixture suites"
    if "redis" in p or p.startswith("packages/event-bus/"):
        return "F18", "Concurrent subscription cleanup success/retry on current lease lifecycle", "Isolated Redis cleanup/scan/retry/incarnation tests"
    if "start-core-runtime" in p or p.endswith("/runtime/main.ts"):
        return "F17", "Minimal typed startup settlement, independent of blob migration", "Returned/thrown/Panic identity and operation tests"
    if "github-webhook" in p:
        return "F19", "Final publication/sentinel prompt policy over upstream admission", "Prompt policy plus collaborator/dispatch/failure tests"
    if "tool-activities" in p:
        return "F23", "Generated tool activity projection reflects current tool catalog", "Code generation freshness; web build/tests"
    if p in ("package.json", "bun.lock", "apps/core/package.json"):
        return "F01/F22/F23", "Existing Telegram dependency plus inherited dependency and verification ownership", "Frozen install, schema/build/typecheck/full checks"
    if p == ".env.example":
        return "F08/F09/F20", "Public empty-key examples for existing auth/provider/recording delivery contracts", "Diff review; no secret/runtime configuration changes"
    if "heartbeat" in p:
        return "Inherited/limit", "Preserve upstream heartbeat and explicit Telegram destination limitation", "Heartbeat suite; no Telegram destination feature added"
    if "permalink" in p:
        return "Inherited", "Accepted upstream contribution retained as historical documentation", "Upstream GitHub tests; no fork implementation resurrected"
    if p.startswith("docs/research/") or p.startswith("docs/superpowers/") or "fork-review" in p or "fork-integration-pr95" in p:
        return "Historical evidence", "Preserve dated research/plans as evidence for their stated baseline", "Documentation review; no current behavior inferred from history alone"
    if p.startswith("docs/") or p in ("readme.md", "readme.zh-tw.md", "project.md"):
        return "Documentation", "Current ownership/operator guidance; new integration report is authoritative for this pin", "Documentation and source reconciliation"
    if p.startswith("apps/tool-bridge/") or p.startswith("packages/plugin-runtime/") or "/bash" in p or "tool-server" in p or p.startswith("apps/core/tests/tools/") or p.startswith("apps/core/src/tools/"):
        return "F15", "Authenticated initiator default/restricted targets and public plugin compatibility", "Cross-session/forged/native-alias/MCP and bridge tests"
    if "/surface/native/" in p:
        return "F08/F15", "Upstream native owner plus committed-display observer/resource authority", "Native store/mirror/resource and authority tests"
    if "/surface/bridge/" in p or "/runtime/" in p or "/surface/" in p or "/transcript/" in p:
        return "F01–F08/F14/F15", "Surface registration/origin/resource seams on current upstream shared owners", "Runtime/runner/control/recovery/relay/transcript suites"
    if p.startswith("packages/utils/"):
        return "F05/F15/F23", "Shared command/schema/context export and protocol guidance", "Utils tests, typecheck and generated schema checks"
    raise RuntimeError(f"Unassigned inventory path: {path}")


original = paths("diff", "--name-only", "--no-renames", BASE, FORK)
since_audit = paths("diff", "--name-only", "--no-renames", FORK, REFRESHED_FORK)
remaining = paths("diff", "--name-only", "--no-renames", UPSTREAM)
remaining |= paths("ls-files", "--others", "--exclude-standard")
remaining |= {str((OUT / name).relative_to(ROOT)) for name in ("PATH-INVENTORY.md", "path-inventory.json", "UPSTREAM-COMMITS.md")}
followup = paths("diff", "--name-only", "--no-renames", REFRESHED_FORK)
followup |= paths("ls-files", "--others", "--exclude-standard")
followup |= {str((OUT / name).relative_to(ROOT)) for name in ("PATH-INVENTORY.md", "path-inventory.json", "UPSTREAM-COMMITS.md")}
rows = []
for path in sorted(original | remaining | since_audit | followup):
    feature, reason, checks = owner(path)
    exists = (ROOT / path).exists()
    upstream_exists = bool(git("ls-tree", UPSTREAM, "--", path))
    if path not in remaining:
        disposition = "Inherited" if exists else "Retired/replaced"
    elif not exists:
        disposition = "Retired with offline support boundary" if feature == "F16" else "Retired/replaced"
    else:
        disposition = "Retained/refactored" if path in original else "Integration adaptation/evidence"
    rows.append(dict(path=path, original=path in original, remaining=path in remaining,
                     changedSinceAudit=path in since_audit, followup=path in followup,
                     upstreamOwned=upstream_exists, formerUpstreamOwned=bool(git("ls-tree", BASE, "--", path)), feature=feature, disposition=disposition,
                     reason=reason, checks=checks))

payload = dict(base=BASE, fork=FORK, refreshedFork=REFRESHED_FORK, upstream=UPSTREAM,
               originalPaths=len(original), changedSinceAuditPaths=len(since_audit),
               remainingPaths=len(remaining), followupPaths=len(followup), unionPaths=len(rows), rows=rows)
(OUT / "path-inventory.json").write_text(json.dumps(payload, indent=2) + "\n")
lines = ["# Complete fork-path inventory", "", f"Pins: original fork `{FORK}`, refreshed main `{REFRESHED_FORK}`, upstream `{UPSTREAM}`, prior base `{BASE}`.", "",
         f"This accounts for all {len(original)} original fork paths, all {len(since_audit)} paths changed by the externally merged PR #101 since that fork pin, all {len(remaining)} remaining upstream-to-integrated-tree differences, and all {len(followup)} follow-up paths ({len(rows)} union paths).",
         "No path is inferred from commit subjects. A path matching upstream is inherited; a removed legacy path has an explicit offline support boundary. Each row names its feature/evidence owner and relevant regression family. Executed outcomes and limits are in the verification and domain reports.", "",
         "Regenerate from the candidate root with `python3 docs/fork-integration-20261111/reproduce-inventory.py`. This reads pinned Git objects and the current candidate working tree, including new tracked-intent reports; it does not inspect runtime data.", "",
         "`Since audit` compares the two fork pins; `Follow-up` compares refreshed main with this candidate. Deleted obsolete migration files appear even when both upstream and the candidate omit them. These sets are deliberately distinct.", "",
         "| Path | Original | Since audit | Remaining | Follow-up | Source owner | Feature | Disposition | Reason | Regression family |",
         "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
for row in rows:
    link = f"[{row['path']}](../../{row['path']})" if (ROOT / row['path']).exists() else f"`{row['path']}`"
    lines.append(f"| {link} | {'yes' if row['original'] else 'no'} | {'yes' if row['changedSinceAudit'] else 'no'} | {'yes' if row['remaining'] else 'no'} | {'yes' if row['followup'] else 'no'} | {'Upstream seam' if row['upstreamOwned'] else 'Former upstream owner' if row['formerUpstreamOwned'] else 'Fork addition'} | {row['feature']} | {row['disposition']} | {row['reason']} | {row['checks']} |")
(OUT / "PATH-INVENTORY.md").write_text("\n".join(lines) + "\n")
commits = git("log", "--reverse", "--format=%H%x09%s", f"{FORK}..{UPSTREAM}").splitlines()
lines = ["# Upstream commits covered", "", f"All {len(commits)} commits reachable from `{UPSTREAM}` but absent from fork baseline `{FORK}` already landed in externally merged PR #101 and remain ancestors of this follow-up. Refreshed main is `{REFRESHED_FORK}`. No additional upstream commit arrived after the original audit pin.", "", "| Commit | Subject |", "| --- | --- |"]
for commit in commits:
    sha, subject = commit.split("\t", 1)
    lines.append(f"| [`{sha[:8]}`](https://github.com/stanley2058/lilac-mono/commit/{sha}) | {subject.replace('|', '&#124;')} |")
(OUT / "UPSTREAM-COMMITS.md").write_text("\n".join(lines) + "\n")
print(json.dumps({key: value for key, value in payload.items() if key != "rows"}))
