#!/usr/bin/env python3
"""Reproduce pinned baseline and explicit resolved-candidate Git-tree evidence."""
import argparse
import collections
import json
import hashlib
import os
import tempfile
import subprocess
from pathlib import Path

FORK = "4d8c0a8d799fcacd8aa51ca7613f48d7bb3f2327"
UPSTREAM = "7613d519643005ee4574c085a534c74af9508f88"
FIRST_PUBLISHED = "3292b12b99992aa648b28aa2b00252098aeb4663"
BASE = "90d71dbe9a2a86d8b0a39513e9eb67d65eb93683"
OUT = Path(__file__).resolve().parent
ROOT = OUT.parent.parent
POLICY = "scripts/fork/upstream-footprint.txt"
# Their contents describe the candidate, so hashing them into that description is recursive.
EVIDENCE = {f"docs/fork-comparison-pr120/{name}" for name in
            ("PATH-INVENTORY.md", "inventory.json", "VERIFICATION.md")}
ARTIFACTS = sorted(EVIDENCE | {"docs/fork-comparison-pr120/reproduce.py",
                             "docs/fork-differences.md", "docs/fork-differences.zh-TW.md"})


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT).decode().rstrip("\n")


def tree(ref):
    result = {}
    for record in git("ls-tree", "-rz", "--full-tree", ref).split("\0"):
        if not record:
            continue
        metadata, path = record.split("\t", 1)
        mode, kind, oid = metadata.split()
        result[path] = dict(mode=mode, kind=kind, oid=oid)
    return result


def delta(left, right):
    return {p: "A" if p not in left else "D" if p not in right else "T"
            if left[p]["mode"][:2] != right[p]["mode"][:2] else "M"
            for p in sorted(left.keys() | right.keys()) if left.get(p) != right.get(p)}


def category(path):
    p = path.lower()
    if p.startswith("docs/fork-comparison-pr120/") or p.startswith("docs/fork-differences"):
        return "D01 current fork comparison"
    if p.startswith("docs/fork-integration-20261111/"):
        return "D02 historical PR101 evidence"
    if p.startswith(("docs/research/", "docs/superpowers/")) or "fork-review" in p or "fork-integration-pr95" in p:
        return "D03 historical research and plans"
    if "custom-media" in p:
        return "F11 external media plugin and committed bundle"
    if "discord-mirror" in p or "native-discord" in p:
        return "F08 native Discord recording and routing"
    if "menu-alias" in p or "custom-commands" in p:
        return "F05 Telegram command menus"
    if "telegram-conversation" in p or "/conversation/" in p or "conversation-thread" in p or "auto-inject-thread-search" in p:
        return "F06 Telegram and shared conversation memory"
    if "telegram" in p:
        return "F01-F04 Telegram lifecycle, routing, rendering and media"
    if "image-script" in p or "image-generation" in p or "generate-image" in p:
        return "F10 compatible image-script provider"
    if "web-search" in p or "provider-page-extraction" in p or p.endswith(("/tools/web.ts", "/tools/web.test.ts")):
        return "F09 hosted search and pending attempt policy"
    if "compaction" in p:
        return "F14 protected current-input compaction"
    if "openai-compatible-tool-images" in p:
        return "F13 compatible Chat tool-image projection"
    if p.startswith("packages/agent/") or "/agent/" in p or "anthropic-tool-search" in p or "provider-metadata" in p:
        return "F12 and U02 provider execution, search and history"
    if "store-search" in p or p.endswith("/surface/native/search.test.ts"):
        return "N01 scoped native conversation search (PR121)"
    if p in ("apps/core/src/jobs/job-service.ts", "apps/core/tests/jobs/job-service.test.ts", "apps/core/tests/surface/native/job-lifecycle.test.ts"):
        return "U01 native rewind job ownership and suppression"
    if "rewind" in p or p.endswith("/client-protocol/src/domain.ts") or p.endswith("/client-protocol/src/index.ts"):
        return "U01 incoming native DM rewind and protocol"
    if "cache" in p and p.startswith("apps/web/"):
        return "N02 persistent web cache recency"
    if "composer-editor" in p:
        return "N03 composer selection across Activity recreation"
    if p.startswith("apps/web/"):
        return "U04 web presentation and generated activity seams"
    if "/compat/previous-release/" in p or "generate-client-protocol-compat" in p or "client-compat" in p:
        return "N06 verified historical protocol fixtures"
    if "github" in p:
        return "F19 and N04 GitHub publication and delivery identity"
    if "/workflow" in p or "workflow-authoring" in p or "orchestrate" in p:
        return "F07 and N05 Telegram workflows and durable subagent identity"
    if "start-core-runtime" in p or p.endswith("/runtime/main.ts"):
        return "F17 typed Core startup"
    if "redis" in p or p.startswith("packages/event-bus/"):
        return "F18 Redis cleanup and lifecycle checks"
    if "ssh" in p or p.startswith(("packages/fs/", "apps/remote-runner/")) or "remote-runner" in p or "remote-fs" in p or "remote-apply-patch" in p:
        return "N07 SSH, filesystem and Rust runner corrections"
    if "bash-output-sanitizer" in p:
        return "N07 SSH, filesystem and Rust runner corrections"
    if p.startswith(("scripts/architecture/", "scripts/oxlint-plugins/", "scripts/fork/")) or "footprint" in p or p == "scripts/run-gates.ts":
        return "F22 architecture, syntax and footprint governance"
    if p.startswith(".github/") or "release-gate" in p or "fork-delivery" in p or p == ".coderabbit.yaml":
        return "F21 CI, upstream sync, review and publication"
    if "docker" in p or p == "compose.yaml" or p.startswith("apps/installer/"):
        return "F20 container identities and installer ownership"
    if "generate-design-tool-activities" in p:
        return "F23 generated tool activity fixture types"
    if "config" in p:
        return "F23 versioned configuration and generated editor schema"
    if p.startswith("apps/core/tests/e2e/") or p.startswith("__tests__/test-"):
        return "N08 regression harness and temporary-root corrections"
    if "heartbeat" in p:
        return "U03 shared heartbeat with Telegram destination limitation"
    if "visualize" in p or p.endswith("/resources-live.ts") or p.endswith("/resources-live.test.ts"):
        return "N09 run-scoped previews and opened-handle containment"
    if "codex-instructions" in p or "agent-prompts" in p or "model-slot" in p or "model-provider-option-validation" in p:
        return "U02 incoming provider and prompt policy"
    if p == "packages/utils/model-provider.ts":
        return "F13 and U02 compatible middleware and incoming provider projection"
    if p.startswith("apps/tool-bridge/") or p.startswith("packages/plugin-runtime/") or "tool-server" in p or p.endswith("/tools/bash-impl.ts") or p.endswith("/tools/bash.test.ts") or p.endswith("/tools/subagent.test.ts"):
        return "F15 authenticated origin and standalone tool bridge"
    if "/surface/native/" in p:
        return "F08 and N10 native observer, routing, admission and upstream integration"
    if "/surface/discord/" in p:
        return "N11 Discord read-control failures and inherited context"
    if "/surface/" in p or "/runtime/" in p or "/transcript/" in p:
        return "F01-F08/F14/F15 shared runtime and surface seams"
    if p in ("package.json", "bun.lock", "apps/core/package.json"):
        return "F20-F23 dependencies and verification commands"
    if p in (".gitignore", ".oxfmtrc.json") or p.startswith(".serena/"):
        return "D04 developer metadata"
    if p == ".env.example":
        return "F08/F09/F20 public environment examples"
    if p.startswith("docs/") or p in ("readme.md", "readme.zh-tw.md", "project.md", "development.md", "migrations.md"):
        return "D05 operator, architecture and migration documentation"
    if p.startswith("packages/utils/"):
        return "F05/F15/F23 shared exports and prompt guidance"
    raise ValueError(f"Unassigned path; add an explicit owner rule: {path}")


def parse_policy(text):
    entries = {}
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        path, reason = line.split("  #", 1)
        assert path not in entries and reason.strip(), line
        entries[path] = reason.strip()
    return entries


def footprint(ref, snapshots, base_ref):
    changed = {p for p, status in delta(tree(base_ref), snapshots).items() if status in "MDT"}
    entries = parse_policy(git("show", f"{ref}:{POLICY}"))
    return dict(comparisonBase=base_ref, covered=sorted(changed & entries.keys()),
                unlisted=sorted(changed - entries.keys()), stale=sorted(entries.keys() - changed),
                rows=[dict(path=p, category=category(p), reason=reason,
                           state="covered" if p in changed else "stale")
                      for p, reason in sorted(entries.items())])


def validate_worktree_base(head):
    if head == FORK:
        assert git("rev-parse", "MERGE_HEAD") == UPSTREAM, "Unexpected MERGE_HEAD"
        return
    for pin in (FORK, UPSTREAM):
        subprocess.run(["git", "merge-base", "--is-ancestor", pin, head], cwd=ROOT, check=True)
    merging = subprocess.run(["git", "rev-parse", "--verify", "MERGE_HEAD"], cwd=ROOT,
                             capture_output=True, text=True)
    assert merging.returncode != 0, "Finish the active merge before capturing a follow-up candidate"


def candidate_ref(args):
    if args.candidate_worktree:
        head = git("rev-parse", "HEAD")
        validate_worktree_base(head)
        indexed_links = {}
        for entry in git("ls-files", "--stage", "-z").split("\0"):
            if not entry:
                continue
            metadata, path = entry.split("\t", 1)
            mode, oid, stage = metadata.split()
            if mode == "160000":
                indexed_links[path] = dict(mode=mode, kind="commit", oid=oid)
        expected_links = {p: obj for p, obj in tree(head).items() if obj["mode"] == "160000"}
        assert indexed_links == expected_links, "Staged gitlink changes cannot be excluded from the candidate snapshot"
        assert not git("ls-files", "-u"), "Resolve the real index conflicts first"
        # A disposable index leaves the actual merge index and all worktree bytes untouched.
        with tempfile.TemporaryDirectory(prefix="lilac-pr120-index-") as directory:
            env = {**os.environ, "GIT_INDEX_FILE": str(Path(directory) / "index")}
            def staged(*argv):
                return subprocess.check_output(["git", "-c", "submodule.recurse=false", *argv],
                                               cwd=ROOT, env=env).decode().strip()
            staged("read-tree", head)
            staged("add", "--all", "--", ".", ":(exclude)ref")
            return staged("write-tree")
    if not args.candidate:
        return None
    commit = subprocess.run(["git", "rev-parse", "--verify", f"{args.candidate}^{{commit}}"],
                            cwd=ROOT, text=True, capture_output=True)
    if commit.returncode == 0:
        ref = commit.stdout.strip()
        for pin in (FORK, UPSTREAM):
            subprocess.run(["git", "merge-base", "--is-ancestor", pin, ref], cwd=ROOT, check=True)
        return ref
    validate_worktree_base(git("rev-parse", "HEAD"))
    return git("rev-parse", "--verify", f"{args.candidate}^{{tree}}")


def public_object(path, label, obj):
    if label != "candidate" or path not in EVIDENCE or obj is None:
        return obj
    return {"mode": obj["mode"], "kind": obj["kind"], "content": "evidence; oid omitted to avoid self-reference"}


def counts(values):
    return dict(sorted(collections.Counter(values).items()))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--candidate", help="Resolved descendant commit or tree based on a verified integration HEAD")
    source.add_argument("--candidate-worktree", action="store_true", help="Snapshot the merge or post-merge worktree with a temporary index")
    parser.add_argument("--check", action="store_true", help="Check generated files byte for byte without writing")
    args = parser.parse_args()
    assert git("merge-base", FORK, UPSTREAM) == BASE
    refs = dict(base=BASE, fork=FORK, upstream=UPSTREAM, firstPublished=FIRST_PUBLISHED)
    snapshots = {key: tree(ref) for key, ref in refs.items()}
    candidate = candidate_ref(args)
    if candidate:
        snapshots["candidate"] = tree(candidate)
        assert set(ARTIFACTS) <= snapshots["candidate"].keys(), "Missing comparison documentation"
    b, f, u = (snapshots[key] for key in ("base", "fork", "upstream"))
    comparisons = {"baseToFork": delta(b, f), "baseToUpstream": delta(b, u), "upstreamToFork": delta(u, f)}
    pairs = [("baseToFork", BASE, FORK), ("baseToUpstream", BASE, UPSTREAM), ("upstreamToFork", UPSTREAM, FORK)]
    if candidate:
        c = snapshots["candidate"]
        comparisons.update(forkToCandidate=delta(f, c), upstreamToCandidate=delta(u, c), firstPublishedToCandidate=delta(snapshots["firstPublished"], c))
        pairs += [("forkToCandidate", FORK, candidate), ("upstreamToCandidate", UPSTREAM, candidate), ("firstPublishedToCandidate", FIRST_PUBLISHED, candidate)]
    # Independent Git comparisons include execute modes and gitlinks, without rename heuristics.
    for key, left, right in pairs:
        expected_paths = set(filter(None, git("diff", "--name-only", "--no-renames", "-z", left, right).split("\0")))
        records = git("diff", "--name-status", "--no-renames", "-z", left, right).split("\0")
        expected_status = dict(zip(records[1::2], records[0::2]))
        assert set(comparisons[key]) == expected_paths, key
        assert comparisons[key] == expected_status, key
    union = set().union(*(set(d) for d in comparisons.values()))
    rows = []
    for path in sorted(union):
        fork_changed = path in comparisons["baseToFork"]
        incoming = path in comparisons["baseToUpstream"]
        state = "fork and upstream both changed; reconcile" if fork_changed and incoming else "shipped fork delta" if fork_changed else "incoming upstream; absent from shipped baseline"
        if f.get(path) == u.get(path):
            state = "shared at both pins" if path in f else "absent at both baseline tips; candidate addition"
        row = dict(path=path, category=category(path), state=state,
                   changes={key: d.get(path, "=") for key, d in comparisons.items()},
                   objects={key: public_object(path, key, t.get(path)) for key, t in snapshots.items()})
        if candidate:
            value = c.get(path)
            if path in ARTIFACTS:
                disposition = "comparison documentation included in candidate"
            elif value == u.get(path):
                disposition = "upstream adopted or already shared"
            elif value == f.get(path):
                disposition = "fork delta retained"
            else:
                disposition = "resolved combination or integration repair; see capability guide"
            row["candidateDisposition"] = disposition
        rows.append(row)
    trial = subprocess.run(["git", "merge-tree", "--write-tree", "--name-only", FORK, UPSTREAM], cwd=ROOT, text=True, capture_output=True)
    assert trial.returncode in (0, 1), trial.stderr
    conflict_paths = trial.stdout.split("\n\n", 1)[0].splitlines()[1:]
    assert all(p in union for p in conflict_paths)
    footprints = {"fork": footprint(FORK, f, git("merge-base", UPSTREAM, FORK))}
    if candidate:
        footprints["candidate"] = footprint(candidate, c, UPSTREAM)
        fp = footprints["candidate"]
        expected = set(filter(None, git("diff", "--name-only", "--diff-filter=MDT", "--no-renames", "-z", UPSTREAM, candidate).split("\0")))
        assert expected == set(fp["covered"]) | set(fp["unlisted"])
        assert not fp["unlisted"] and not fp["stale"], "Candidate footprint must exactly match its policy"
    gitlinks = {key: {p: obj for p, obj in t.items() if obj["mode"] == "160000"} for key, t in snapshots.items()}
    generated = [r["path"] for r in rows if "/generated/" in r["path"] or "/compat/previous-release/" in r["path"] or "/dist/" in r["path"]]
    payload = dict(pins=refs, comparisons={key: dict(paths=len(d), statuses=counts(d.values())) for key, d in comparisons.items()},
                   unionPaths=len(rows), categories=counts(r["category"] for r in rows),
                   states=counts(r["state"] for r in rows), textualConflicts=conflict_paths,
                   footprints=footprints, gitlinks=gitlinks, generatedArtifactPaths=generated,
                   treeCounts={key: dict(paths=len(t), modes=counts(obj["mode"] for obj in t.values()),
                                         kinds=counts(obj["kind"] for obj in t.values())) for key, t in snapshots.items()},
                   rows=rows)
    if candidate:
        stable = {p: public_object(p, "candidate", obj) for p, obj in c.items()}
        payload["candidate"] = dict(
            contentSha256=hashlib.sha256(json.dumps(stable, sort_keys=True, separators=(",", ":")).encode()).hexdigest(),
            requiredParents=[FORK, UPSTREAM], documentationArtifacts=ARTIFACTS,
            omittedEvidenceContentPaths=sorted(EVIDENCE),
            identity="Complete candidate tree except evidence-output content; presence and modes remain inventoried")
    lines = ["# Pinned PR #120 path inventory", "", "Generated by [reproduce.py](reproduce.py). Read the [capability comparison](../fork-differences.md) and [verification record](VERIFICATION.md) for behavior and test evidence.", "",
             "B/F/U and firstPublished (C1) columns are immutable committed baselines. Candidate (C) columns describe the final resolved commit/tree or temporary-index snapshot. C1 is the first published integration, not a deployment claim. A blob/mode delta establishes source differences, not feature ownership or a passed test. `A/M/D/T` describes the right tree relative to the left; `=` means equal. Rename detection is disabled.", "", "## Pins and scope", "", "| Role | Full SHA |", "| --- | --- |"]
    for key, ref in refs.items():
        repo = "stanley2058" if key in ("base", "upstream") else "DF-wu"
        lines.append(f"| {key} | [`{ref}`](https://github.com/{repo}/lilac-mono/commit/{ref}) |")
    if candidate:
        lines += ["", "Candidate content fingerprint (SHA-256): `" + payload["candidate"]["contentSha256"] + "`.", "",
                  "This is a content identity, **not a commit SHA or published release**. It covers every candidate path/mode/object except the content of the three evidence files below. Those files describe this tree, so their own hashes would be self-referential; their paths, presence and modes are still counted. The generator, both language guides and all code are hashed normally. The same candidate content reproduces before and after a commit without inventing a commit or linking an unpublished SHA.", ""]
        lines += [f"- [{Path(p).name}]({Path(p).name}): evidence content hash omitted." for p in sorted(EVIDENCE)]
        lines += ["", "All six comparison artifacts are included documentation, not omitted paths:", ""]
        lines += [f"- `{p}`" for p in ARTIFACTS]
    lines += ["", "| Comparison (left → right) | Paths | Status counts |", "| --- | ---: | --- |"]
    for key, d in payload["comparisons"].items():
        lines.append(f"| {key} | {d['paths']} | {d['statuses']} |")
    lines += ["", f"Union: **{len(rows)} changed paths**. Baseline trial merge has **{len(conflict_paths)} textual conflict** ({', '.join('`'+p+'`' for p in conflict_paths) or 'none'}). Its diagnostic tree is never the candidate.", "", "## Reproduce and refresh", "", "From the repository root:", "", "```sh",
              "# Before a follow-up commit: HEAD must contain F and U; snapshots without changing the real index.",
              "python3 docs/fork-comparison-pr120/reproduce.py --candidate-worktree",
              "python3 docs/fork-comparison-pr120/reproduce.py --candidate-worktree --check",
              "# A precomputed write-tree object also works on the validated integration checkout:",
              "python3 docs/fork-comparison-pr120/reproduce.py --candidate <tree-object> --check",
              "# After committing/publishing: verifies both pinned parents are ancestors.",
              "python3 docs/fork-comparison-pr120/reproduce.py --candidate HEAD --check",
              "```", "",
              "The helper writes only PATH-INVENTORY.md and inventory.json. `--check` compares both byte for byte; it never writes them. With no candidate option it produces only the historical B/F/U/C1 ledger and therefore does not match this combined report. Temporary-index mode includes tracked changes and nonignored additions, preserves HEAD gitlinks without opening submodules and rejects differing staged gitlinks, and creates only Git tree/blob objects, never commits. Reproduction also uses the repository's already-installed oxfmt to match the JSON formatting gate; install the existing frozen dev dependencies first. The helper never downloads tooling. No network is needed during reproduction. Prefix commands with the repository's required wrapper where applicable.", "",
              "Every path/status set is checked independently with `git diff --name-only` and `--name-status --no-renames -z`. The JSON includes complete-tree mode/kind counts, all gitlinks and exact policy reasons. Candidate-only files must have a named category; duplicate/empty policy rows fail. Historical [PR101 evidence](../fork-integration-20261111/PATH-INVENTORY.md) remains unchanged.", "", "## Complete tree mode and kind counts", "", "| Snapshot | Paths | Modes | Object kinds |", "| --- | ---: | --- | --- |"]
    for key, values in payload["treeCounts"].items():
        lines.append(f"| {key} | {values['paths']} | {values['modes']} | {values['kinds']} |")
    lines += ["", "## Categories", "", "| Named owner category | Paths |", "| --- | ---: |"]
    for name, count in payload["categories"].items():
        lines.append(f"| {name} | {count} |")
    keys = list(comparisons)
    lines += ["", "## Every changed path", "", "Links are repository-relative and open the resolved candidate files. Deleted paths are plain text; their pinned blob identities remain in JSON. Baseline disposition describes F, while candidate disposition describes the integrated content.", "", "| Path | " + " | ".join(keys) + " | Baseline disposition | Candidate disposition | Category |", "| --- | " + " | ".join("---" for _ in keys) + " | --- | --- | --- |"]
    for row in rows:
        path = row["path"]
        link = f"[{path}](../../{path})" if path in snapshots.get("candidate", f) else f"`{path}`"
        lines.append("| " + link + " | " + " | ".join(row["changes"][key] for key in keys) + f" | {row['state']} | {row.get('candidateDisposition', 'not supplied')} | {row['category']} |")
    lines += ["", "## Every exact footprint row", "", "The unchanged production gate compares the merge base of its fetched upstream ref and HEAD with tracked worktree MDT changes; strict mode also rejects stale policy rows. This deliberately excludes newer upstream work that the fork has not incorporated. Direct-tip comparison is **only** the pinned candidate check here: after a merge commit containing U, its merge base with U is U, so the same policy check is equivalent. During the original uncommitted merge HEAD was F and the CLI used B. C1 and its follow-ups contain U, so the normal pinned-U CLI now checks the exact candidate. Advancing upstream may change the merge base after publication, so rerun the normal CI gate on its fetched refs as well.", ""]
    for name, fp in footprints.items():
        lines += [f"### {name}", "", f"Comparison base `{fp['comparisonBase']}`: **{len(fp['rows'])} policy rows; {len(fp['covered'])} covered, {len(fp['unlisted'])} unlisted, {len(fp['stale'])} stale**.", "", "| Path | Gate state | Category | Exact policy reason |", "| --- | --- | --- | --- |"]
        for row in fp["rows"]:
            lines.append(f"| `{row['path']}` | {row['state']} | {row['category']} | {row['reason'].replace('|', '&#124;')} |")
        if fp["unlisted"]:
            lines += ["", "Unlisted: " + ", ".join(f"`{p}`" for p in fp["unlisted"])]
    lines += ["", "## Generated artifacts and submodules", "", f"Generated/schema/bundle delta paths: **{len(generated)}**, listed below. Comparison evidence files are separately declared above. Gitlink objects are read from parent trees only; no submodule object or working directory is needed.", ""]
    lines += [f"- `{p}`" for p in generated]
    lines += ["", "| Gitlink path | " + " | ".join(snapshots) + " |", "| --- | " + " | ".join("---" for _ in snapshots) + " |"]
    for path in sorted(set().union(*(set(t) for t in gitlinks.values()))):
        lines.append("| `" + path + "` | " + " | ".join("`" + t.get(path, {}).get("oid", "absent") + "`" for t in gitlinks.values()) + " |")
    lines += ["", "## Evidence limits", "", "The fingerprint excludes evidence content, so it is not a complete-tree cryptographic release attestation. Byte-for-byte reproduction validates generated output; VERIFICATION.md is reviewed test evidence. Neither tree generation nor a footprint pass certifies provider traffic, Docker images, deployment or remote CI. The immutable baseline columns and integrated candidate columns must not be conflated.", ""]
    # Use the already-declared repository formatter; never install tooling during reproduction.
    formatter = ROOT / "node_modules/.bin/oxfmt"
    assert formatter.exists(), "Install the repository's frozen dev dependencies before reproduction"
    encoded = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"
    formatted = subprocess.check_output(
        [str(formatter), f"--stdin-filepath={OUT / 'inventory.json'}"],
        input=encoded, text=True, cwd=ROOT,
    )
    outputs = {"inventory.json": formatted, "PATH-INVENTORY.md": "\n".join(lines)}
    for name, content in outputs.items():
        if args.check:
            assert (OUT / name).read_text() == content, f"Stale output: {name}"
        else:
            (OUT / name).write_text(content)
    print(json.dumps({key: payload[key] for key in ("pins", "comparisons", "unionPaths", "states", "textualConflicts")}))


if __name__ == "__main__":
    main()
