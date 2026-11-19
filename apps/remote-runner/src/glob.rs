//! Glob and walk operations.
//!
//! `glob` follows `collectLocalGlobMatches` in `packages/fs/src/glob-walk.ts`: it walks from the
//! literal roots of the include patterns, prunes denied and excluded directories, and follows only
//! the root symlink. Matching uses `globset`, which differs from Node's `path.matchesGlob` in
//! extended glob syntax, so those patterns return `None` and Core filters a `walk` listing itself.
//! Core also re-checks every `glob` result with Node's matcher.

use std::fs;
use std::path::{Path, PathBuf};

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};
use serde::Serialize;

use crate::errors::{FsError, is_skippable};
use crate::fsops::{file_kind, lexical_resolve};
use crate::protocol::{GlobRequest, WalkRequest};

#[derive(Debug, Serialize)]
pub struct Entry {
    path: String,
    #[serde(rename = "type")]
    kind: &'static str,
    size: u64,
}

#[derive(Debug, Serialize)]
pub struct GlobOutput {
    paths: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    entries: Option<Vec<Entry>>,
    truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkEntry {
    path: String,
    is_directory: bool,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    kind: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    metadata_error: Option<FsError>,
}

#[derive(Debug, Serialize)]
pub struct WalkOutput {
    entries: Vec<WalkEntry>,
    truncated: bool,
}

/// Matches `isDeniedPathIn`: the path or anything below a deny path.
pub fn is_denied(path: &Path, deny_paths: &[String]) -> bool {
    let normalized = lexical_resolve(path);
    let normalized = normalized.to_string_lossy();
    deny_paths.iter().any(|deny| {
        normalized == deny.as_str()
            || (normalized.starts_with(deny.as_str())
                && normalized.as_bytes().get(deny.len()) == Some(&b'/'))
    })
}

fn normalize_pattern(pattern: &str) -> String {
    let mut trimmed = pattern;
    while let Some(rest) = trimmed.strip_prefix("./") {
        trimmed = rest.trim_start_matches('/');
    }
    trimmed.to_string()
}

fn uses_extended_glob(pattern: &str) -> bool {
    let bytes = pattern.as_bytes();
    bytes
        .windows(2)
        .any(|pair| matches!(pair[0], b'+' | b'@' | b'?' | b'!' | b'*') && pair[1] == b'(')
}

fn build_set(patterns: &[String]) -> Option<GlobSet> {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        // Node's single-segment `*` requires a nonempty segment, including after an appended `/`.
        let pattern = pattern
            .split('/')
            .map(|segment| if segment == "*" { "?*" } else { segment })
            .collect::<Vec<_>>()
            .join("/");
        let glob = GlobBuilder::new(&pattern)
            .literal_separator(true)
            .backslash_escape(true)
            .empty_alternates(true)
            .build()
            .ok()?;
        builder.add(glob);
    }
    builder.build().ok()
}

fn matches_contract(set: &GlobSet, path: &str) -> bool {
    set.is_match(path) || set.is_match(format!("{path}/"))
}

fn has_glob_meta(segment: &str) -> bool {
    segment.chars().any(|c| {
        matches!(
            c,
            '*' | '?' | '[' | ']' | '{' | '}' | '(' | ')' | '!' | '+' | '@'
        )
    })
}

fn literal_search_root(pattern: &str) -> String {
    let segments: Vec<&str> = pattern
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    let mut prefix: Vec<&str> = Vec::new();
    for segment in &segments {
        if *segment == "." || *segment == ".." {
            return String::new();
        }
        if has_glob_meta(segment) {
            return prefix.join("/");
        }
        prefix.push(segment);
    }
    prefix.pop();
    prefix.join("/")
}

/// Port of `getGlobSearchRoots`.
pub fn search_roots(patterns: &[String]) -> Vec<String> {
    let mut roots: Vec<String> = patterns
        .iter()
        .map(|pattern| literal_search_root(pattern))
        .collect();
    roots.sort_by_key(String::len);
    let mut deduped: Vec<String> = Vec::new();
    for root in roots {
        if root.is_empty() {
            return vec![String::new()];
        }
        if deduped
            .iter()
            .any(|existing| root == *existing || root.starts_with(&format!("{existing}/")))
        {
            continue;
        }
        deduped.push(root);
    }
    if deduped.is_empty() {
        vec![String::new()]
    } else {
        deduped
    }
}

fn sorted_children(dir: &Path) -> Result<Vec<fs::DirEntry>, std::io::Error> {
    collect_children(fs::read_dir(dir)?)
}

fn collect_children(
    children_iter: impl Iterator<Item = Result<fs::DirEntry, std::io::Error>>,
) -> Result<Vec<fs::DirEntry>, std::io::Error> {
    let mut children = Vec::new();
    for child in children_iter {
        match child {
            Ok(child) => children.push(child),
            Err(error) if is_skippable(&error) => continue,
            Err(error) => return Err(error),
        }
    }
    children.sort_by_key(|entry| entry.file_name());
    Ok(children)
}

struct GlobWalk<'a> {
    base: PathBuf,
    includes: GlobSet,
    excludes: GlobSet,
    max_entries: u64,
    with_stats: bool,
    deny_paths: &'a [String],
    dangerously_allow: bool,
    seen: std::collections::HashSet<String>,
    paths: Vec<String>,
    entries: Vec<Entry>,
    truncated: bool,
}

impl GlobWalk<'_> {
    fn denied(&self, path: &Path) -> bool {
        !self.dangerously_allow && is_denied(path, self.deny_paths)
    }

    fn add_match(&mut self, rel: &str, abs: &Path) -> Result<(), FsError> {
        if !self.seen.insert(rel.to_string()) {
            return Ok(());
        }
        let count = if self.with_stats {
            self.entries.len()
        } else {
            self.paths.len()
        };
        if count as u64 >= self.max_entries {
            self.truncated = true;
            return Ok(());
        }
        if !self.with_stats {
            self.paths.push(rel.to_string());
            return Ok(());
        }
        match fs::metadata(abs) {
            Ok(metadata) => self.entries.push(Entry {
                path: rel.to_string(),
                kind: file_kind(metadata.file_type()),
                size: metadata.len(),
            }),
            Err(error) if is_skippable(&error) => {}
            Err(error) => return Err(FsError::from_io(&error, "stat", abs)),
        }
        Ok(())
    }

    fn walk(&mut self, rel_dir: &str) -> Result<(), FsError> {
        if self.truncated {
            return Ok(());
        }
        let abs_dir = if rel_dir.is_empty() {
            self.base.clone()
        } else {
            self.base.join(rel_dir)
        };
        if self.denied(&abs_dir) {
            return Ok(());
        }
        if !self.dangerously_allow {
            match fs::canonicalize(&abs_dir) {
                Ok(canonical) if self.denied(&canonical) => return Ok(()),
                Ok(_) => {}
                Err(error) if is_skippable(&error) => return Ok(()),
                Err(error) => return Err(FsError::from_io(&error, "realpath", &abs_dir)),
            }
        }
        if !rel_dir.is_empty() && matches_contract(&self.excludes, rel_dir) {
            return Ok(());
        }
        if !rel_dir.is_empty() && matches_contract(&self.includes, rel_dir) {
            self.add_match(rel_dir, &abs_dir)?;
            if self.truncated {
                return Ok(());
            }
        }
        let children = match sorted_children(&abs_dir) {
            Ok(children) => children,
            Err(error) if is_skippable(&error) => return Ok(()),
            Err(error) => return Err(FsError::from_io(&error, "opendir", &abs_dir)),
        };
        for child in children {
            if self.truncated {
                break;
            }
            let name = child.file_name().to_string_lossy().into_owned();
            let rel = if rel_dir.is_empty() {
                name
            } else {
                format!("{rel_dir}/{name}")
            };
            let abs = self.base.join(&rel);
            if self.denied(&abs) || matches_contract(&self.excludes, &rel) {
                continue;
            }
            if matches_contract(&self.includes, &rel) {
                self.add_match(&rel, &abs)?;
            }
            let kind = match child.file_type() {
                Ok(kind) => kind,
                Err(error) if is_skippable(&error) => continue,
                Err(error) => return Err(FsError::from_io(&error, "lstat", &abs)),
            };
            if kind.is_dir() {
                self.walk(&rel)?;
            }
        }
        Ok(())
    }
}

pub fn glob(request: &GlobRequest) -> Result<Option<GlobOutput>, FsError> {
    let mut includes = Vec::new();
    let roots = search_roots(
        &request
            .patterns
            .iter()
            .filter(|pattern| !pattern.is_empty() && !pattern.starts_with('!'))
            .cloned()
            .collect::<Vec<_>>(),
    );
    let mut excludes = Vec::new();
    for pattern in &request.patterns {
        if pattern.is_empty() {
            continue;
        }
        match pattern.strip_prefix('!') {
            Some(excluded) => {
                let excluded = normalize_pattern(excluded);
                if !excluded.is_empty() {
                    excludes.push(excluded);
                }
            }
            None => includes.push(normalize_pattern(pattern)),
        }
    }
    if includes
        .iter()
        .chain(&excludes)
        .any(|pattern| uses_extended_glob(pattern))
    {
        return Ok(None);
    }
    let (Some(include_set), Some(exclude_set)) = (build_set(&includes), build_set(&excludes))
    else {
        return Ok(None);
    };
    let mut walk = GlobWalk {
        base: PathBuf::from(&request.cwd),
        includes: include_set,
        excludes: exclude_set,
        max_entries: request.max_entries,
        with_stats: request.with_stats,
        deny_paths: &request.deny_paths,
        dangerously_allow: request.dangerously_allow,
        seen: Default::default(),
        paths: Vec::new(),
        entries: Vec::new(),
        truncated: false,
    };
    for root in roots {
        walk.walk(&root)?;
    }
    Ok(Some(GlobOutput {
        paths: walk.paths,
        entries: request.with_stats.then_some(walk.entries),
        truncated: walk.truncated,
    }))
}

/// Lists every entry under the roots in sorted depth-first order, for Core to match itself.
pub fn walk(request: &WalkRequest) -> Result<WalkOutput, FsError> {
    let base = PathBuf::from(&request.base);
    let mut entries = Vec::new();
    let mut truncated = false;
    let denied = |path: &Path| !request.dangerously_allow && is_denied(path, &request.deny_paths);
    let mut stack: Vec<(String, bool)> = request
        .roots
        .iter()
        .rev()
        .map(|root| (root.clone(), true))
        .collect();
    while let Some((rel_dir, is_directory)) = stack.pop() {
        let abs_dir = if rel_dir.is_empty() {
            base.clone()
        } else {
            base.join(&rel_dir)
        };
        if denied(&abs_dir) {
            continue;
        }
        if is_directory && !request.dangerously_allow {
            match fs::canonicalize(&abs_dir) {
                Ok(canonical) if denied(&canonical) => continue,
                Ok(_) => {}
                Err(error) if is_skippable(&error) => continue,
                Err(error) => return Err(FsError::from_io(&error, "realpath", &abs_dir)),
            }
        }
        if !rel_dir.is_empty() {
            if entries.len() as u64 >= request.max_entries {
                truncated = true;
                break;
            }
            entries.push(entry_for(&rel_dir, &abs_dir, is_directory));
        }
        if !is_directory {
            continue;
        }
        let children = match sorted_children(&abs_dir) {
            Ok(children) => children,
            Err(error) if is_skippable(&error) => continue,
            Err(error) => return Err(FsError::from_io(&error, "opendir", &abs_dir)),
        };
        for child in children.into_iter().rev() {
            let name = child.file_name().to_string_lossy().into_owned();
            let rel = if rel_dir.is_empty() {
                name
            } else {
                format!("{rel_dir}/{name}")
            };
            let abs = base.join(&rel);
            if denied(&abs) {
                continue;
            }
            let is_directory = match child.file_type() {
                Ok(kind) => kind.is_dir(),
                Err(error) if is_skippable(&error) => continue,
                Err(error) => return Err(FsError::from_io(&error, "lstat", &abs)),
            };
            stack.push((rel, is_directory));
        }
    }
    Ok(WalkOutput { entries, truncated })
}

fn entry_for(rel: &str, abs: &Path, is_directory: bool) -> WalkEntry {
    let (metadata, metadata_error) = match fs::metadata(abs) {
        Ok(metadata) => (Some(metadata), None),
        Err(error) if is_skippable(&error) => (None, None),
        Err(error) => (None, Some(FsError::from_io(&error, "stat", abs))),
    };
    WalkEntry {
        path: rel.to_string(),
        is_directory,
        kind: metadata
            .as_ref()
            .map(|metadata| file_kind(metadata.file_type())),
        size: metadata.as_ref().map(|metadata| metadata.len()),
        metadata_error,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn glob_paths_do_not_depend_on_optional_metadata() {
        let root = std::env::temp_dir().join(format!(
            "lilac-glob-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        symlink("missing.txt", root.join("a-dangling.txt")).unwrap();
        fs::write(root.join("b-present.txt"), "present\n").unwrap();
        let mut request = GlobRequest {
            cwd: root.to_str().unwrap().to_string(),
            patterns: vec!["*.txt".to_string()],
            max_entries: 10,
            deny_paths: vec![],
            dangerously_allow: false,
            with_stats: false,
        };
        let without_stats = glob(&request).unwrap().unwrap();
        request.with_stats = true;
        let with_stats = glob(&request).unwrap().unwrap();
        request.max_entries = 1;
        let limited = glob(&request).unwrap().unwrap();
        fs::remove_dir_all(root).unwrap();

        assert_eq!(without_stats.paths, ["a-dangling.txt", "b-present.txt"]);
        assert!(without_stats.entries.is_none());
        assert!(with_stats.paths.is_empty());
        let entries = with_stats.entries.unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path, "b-present.txt");
        assert_eq!(limited.entries.unwrap()[0].path, "b-present.txt");
        assert!(!limited.truncated);
    }

    fn fixture(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "lilac-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&root).unwrap();
        fs::canonicalize(root).unwrap()
    }

    #[test]
    fn directory_iteration_preserves_io_errors_and_skips_missing_entries() {
        let error = collect_children(std::iter::once(Err(std::io::Error::from_raw_os_error(
            nix::libc::EIO,
        ))))
        .unwrap_err();
        assert_eq!(
            FsError::from_io(&error, "opendir", Path::new("/root")).code,
            "EIO"
        );
        let skipped = collect_children(std::iter::once(Err(std::io::Error::from_raw_os_error(
            nix::libc::ENOENT,
        ))))
        .unwrap();
        assert!(skipped.is_empty());
    }

    #[test]
    fn walk_carries_metadata_errors_without_losing_paths() {
        let root = fixture("walk-stat-error");
        symlink("loop.txt", root.join("loop.txt")).unwrap();
        let output = walk(&WalkRequest {
            base: root.to_str().unwrap().into(),
            roots: vec![String::new()],
            deny_paths: vec![],
            dangerously_allow: false,
            max_entries: 10,
        })
        .unwrap();
        assert_eq!(output.entries.len(), 1);
        assert_eq!(output.entries[0].path, "loop.txt");
        assert_eq!(
            output.entries[0].metadata_error.as_ref().unwrap().code,
            "ELOOP"
        );
        assert!(output.entries[0].kind.is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn leading_dot_patterns_keep_local_search_roots() {
        let root = fixture("glob-roots");
        fs::create_dir(root.join("target")).unwrap();
        fs::write(root.join("target/file.txt"), "hello").unwrap();
        symlink("target", root.join("linked")).unwrap();
        for (pattern, expected) in [
            ("linked/*", vec!["linked/file.txt"]),
            ("./linked/*", vec![]),
            ("././linked/*", vec![]),
        ] {
            let output = glob(&GlobRequest {
                cwd: root.to_str().unwrap().into(),
                patterns: vec![pattern.into()],
                max_entries: 10,
                deny_paths: vec![],
                dangerously_allow: false,
                with_stats: false,
            })
            .unwrap()
            .unwrap();
            assert_eq!(
                output.paths.contains(&"linked/file.txt".to_string()),
                !expected.is_empty(),
                "{pattern}"
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn directory_wildcard_does_not_spend_a_limit_slot_on_the_root() {
        let root = fixture("glob-root-limit");
        fs::create_dir(root.join("target")).unwrap();
        fs::write(root.join("target/file.txt"), "hello").unwrap();
        symlink("target", root.join("linked")).unwrap();
        for pattern in ["linked/*", "./linked/*", "././linked/*"] {
            for with_stats in [false, true] {
                for max_entries in [1, 2] {
                    let output = glob(&GlobRequest {
                        cwd: root.to_str().unwrap().into(),
                        patterns: vec![pattern.into()],
                        max_entries,
                        deny_paths: vec![],
                        dangerously_allow: false,
                        with_stats,
                    })
                    .unwrap()
                    .unwrap();
                    let matched = if with_stats {
                        output
                            .entries
                            .unwrap()
                            .into_iter()
                            .map(|entry| entry.path)
                            .collect::<Vec<_>>()
                    } else {
                        output.paths
                    };
                    let expected = if pattern.starts_with('.') {
                        vec![]
                    } else {
                        vec!["linked/file.txt"]
                    };
                    assert_eq!(
                        matched, expected,
                        "{pattern}, with_stats={with_stats}, max_entries={max_entries}"
                    );
                    assert!(!output.truncated);
                }
            }
        }
        let output = glob(&GlobRequest {
            cwd: root.to_str().unwrap().into(),
            patterns: vec!["linked/**".into()],
            max_entries: 10,
            deny_paths: vec![],
            dangerously_allow: false,
            with_stats: false,
        })
        .unwrap()
        .unwrap();
        assert_eq!(output.paths, ["linked", "linked/file.txt"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn selected_roots_cannot_follow_aliases_into_denied_directories() {
        let root = fixture("glob-deny");
        fs::create_dir(root.join("protected")).unwrap();
        fs::write(root.join("protected/secret.txt"), "secret").unwrap();
        symlink("protected", root.join("linked")).unwrap();
        let deny_paths = vec![root.join("protected").to_str().unwrap().into()];
        let output = glob(&GlobRequest {
            cwd: root.to_str().unwrap().into(),
            patterns: vec!["linked/*".into()],
            max_entries: 10,
            deny_paths: deny_paths.clone(),
            dangerously_allow: false,
            with_stats: false,
        })
        .unwrap()
        .unwrap();
        assert!(output.paths.is_empty());
        let output = walk(&WalkRequest {
            base: root.to_str().unwrap().into(),
            roots: vec!["linked".into()],
            deny_paths,
            dangerously_allow: false,
            max_entries: 10,
        })
        .unwrap();
        assert!(output.entries.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn walk_is_depth_first_and_limits_explicit_roots() {
        let root = fixture("walk-order");
        fs::create_dir(root.join("a")).unwrap();
        fs::write(root.join("a/child"), "hello").unwrap();
        fs::write(root.join("b"), "hello").unwrap();
        let mut request = WalkRequest {
            base: root.to_str().unwrap().into(),
            roots: vec![String::new()],
            deny_paths: vec![],
            dangerously_allow: false,
            max_entries: 10,
        };
        let output = walk(&request).unwrap();
        assert_eq!(
            output
                .entries
                .iter()
                .map(|entry| entry.path.as_str())
                .collect::<Vec<_>>(),
            ["a", "a/child", "b"]
        );
        request.roots = vec!["a".into()];
        request.max_entries = 0;
        let output = walk(&request).unwrap();
        assert!(output.entries.is_empty());
        assert!(output.truncated);
        request.max_entries = 2;
        let output = walk(&request).unwrap();
        assert_eq!(output.entries.len(), 2);
        assert!(!output.truncated);
        fs::remove_dir_all(root).unwrap();
    }
}
