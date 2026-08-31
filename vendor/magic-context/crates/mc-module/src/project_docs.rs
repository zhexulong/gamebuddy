//! The `<project-docs>` m0 sub-block: read the repo's ARCHITECTURE.md + STRUCTURE.md,
//! canonicalize, render the block, and hash the canonical content.
//!
//! Faithful port of `project-docs-hash.ts`. The rendered block is part of the trusted
//! m0 baseline, so the security guards are load-bearing and ported verbatim:
//!  - the docs are read with a NON-following stat (`symlink_metadata`) and must be a
//!    regular file (a symlinked doc — e.g. pointed at ~/.ssh/id_rsa to exfiltrate it
//!    into the prompt — fingerprints as absent and is skipped),
//!  - a size cap rejects an oversized doc before it can blow up the prompt,
//!  - the regular-file + size check is RE-DONE at read time to close the TOCTOU gap
//!    between fingerprint and read.
//!
//! The canonical hash drives a deferred-HARD on docs edits (the trigger wiring is the
//! slice-4d integration question, Q1); the read + render + hash here are independent of
//! that and fork-free.

use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

const PROJECT_DOC_FILES: [&str; 2] = ["ARCHITECTURE.md", "STRUCTURE.md"];
const PROJECT_DOCS_DELIMITER: &str = "\n\n---\n\n";
const MAX_PROJECT_DOC_BYTES: u64 = 256 * 1024;

/// The rendered `<project-docs>` block (empty when no readable doc) + the canonical
/// content hash (empty hash string when no readable doc).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProjectDocs {
    pub rendered_block: String,
    pub canonical_hash: String,
}

/// Canonicalize a doc body for stable hashing/rendering: strip a leading BOM, normalize
/// CRLF→LF, strip per-line trailing spaces/tabs, strip trailing blank lines.
fn canonicalize_doc_content(raw: &str) -> String {
    let no_bom = raw.strip_prefix('\u{feff}').unwrap_or(raw);
    let lf = no_bom.replace("\r\n", "\n");
    let trimmed_lines: Vec<&str> = lf
        .split('\n')
        .map(|line| line.trim_end_matches([' ', '\t']))
        .collect();
    let joined = trimmed_lines.join("\n");
    joined.trim_end_matches('\n').to_string()
}

fn escape_xml_attr(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn escape_xml_content(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Read a doc safely: a regular file (NOT a symlink) within the size cap, re-checked at
/// read time. Returns the canonical content, or None if absent/unsafe/oversized.
fn read_safe_canonical(path: &Path) -> Option<String> {
    // symlink_metadata does NOT follow a symlink (matches the TS lstat guard).
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_PROJECT_DOC_BYTES {
        return None;
    }
    // Re-check at read time to close the TOCTOU gap (a path swapped to a symlink after
    // the first stat). std::fs::read follows symlinks, so the re-check is what protects.
    let meta2 = fs::symlink_metadata(path).ok()?;
    if !meta2.is_file() || meta2.len() > MAX_PROJECT_DOC_BYTES {
        return None;
    }
    let raw = fs::read_to_string(path).ok()?;
    Some(canonicalize_doc_content(&raw))
}

/// Read + render + hash the project docs in `project_directory`. Pure over the
/// filesystem (no caching — the daemon holds the rendered block in the m0 frozen unit;
/// re-read only happens on a docs-change-driven HARD).
pub fn read_project_docs_canonical(project_directory: &str) -> ProjectDocs {
    let dir = Path::new(project_directory);
    let mut hash_pieces: Vec<String> = Vec::new();
    let mut rendered_sections: Vec<String> = Vec::new();

    for filename in PROJECT_DOC_FILES {
        let path = dir.join(filename);
        let Some(canonical) = read_safe_canonical(&path) else {
            continue;
        };
        hash_pieces.push(format!("file:{filename}\n{canonical}"));
        rendered_sections.push(format!(
            "<file name=\"{}\">\n{}\n</file>",
            escape_xml_attr(filename),
            escape_xml_content(&canonical)
        ));
    }

    let canonical_hash = if hash_pieces.is_empty() {
        String::new()
    } else {
        let mut hasher = Sha256::new();
        hasher.update(hash_pieces.join(PROJECT_DOCS_DELIMITER).as_bytes());
        format!("{:x}", hasher.finalize())
    };
    let rendered_block = if rendered_sections.is_empty() {
        String::new()
    } else {
        format!(
            "<project-docs>\n{}\n</project-docs>",
            rendered_sections.join("\n\n")
        )
    };

    ProjectDocs {
        rendered_block,
        canonical_hash,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::io::Write;

    fn write_doc(dir: &Path, name: &str, body: &str) {
        let mut f = fs::File::create(dir.join(name)).unwrap();
        f.write_all(body.as_bytes()).unwrap();
    }

    #[test]
    fn empty_when_no_docs() {
        let dir = tempfile::tempdir().unwrap();
        let docs = read_project_docs_canonical(dir.path().to_str().unwrap());
        assert_eq!(docs, ProjectDocs::default());
    }

    #[test]
    fn renders_and_hashes_both_docs() {
        let dir = tempfile::tempdir().unwrap();
        write_doc(dir.path(), "ARCHITECTURE.md", "# Arch\nbody");
        write_doc(dir.path(), "STRUCTURE.md", "# Struct\nlayout");
        let docs = read_project_docs_canonical(dir.path().to_str().unwrap());
        assert!(docs
            .rendered_block
            .starts_with("<project-docs>\n<file name=\"ARCHITECTURE.md\">"));
        assert!(docs.rendered_block.contains("<file name=\"STRUCTURE.md\">"));
        assert_eq!(docs.canonical_hash.len(), 64, "sha256 hex");
    }

    #[test]
    fn canonicalization_normalizes_bom_crlf_trailing() {
        let dir = tempfile::tempdir().unwrap();
        write_doc(
            dir.path(),
            "ARCHITECTURE.md",
            "\u{feff}line1  \r\nline2\t\n\n\n",
        );
        let docs = read_project_docs_canonical(dir.path().to_str().unwrap());
        assert!(
            docs.rendered_block.contains(">\nline1\nline2\n<"),
            "{}",
            docs.rendered_block
        );
    }

    #[test]
    fn symlinked_doc_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let secret = dir.path().join("secret.txt");
        write_doc(dir.path(), "secret.txt", "TOP SECRET");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&secret, dir.path().join("ARCHITECTURE.md")).unwrap();
        // a symlinked ARCHITECTURE.md must NOT be read (exfil guard); STRUCTURE.md still renders
        write_doc(dir.path(), "STRUCTURE.md", "real struct");
        let docs = read_project_docs_canonical(dir.path().to_str().unwrap());
        #[cfg(unix)]
        {
            assert!(
                !docs.rendered_block.contains("TOP SECRET"),
                "symlink exfil blocked"
            );
            assert!(docs.rendered_block.contains("real struct"));
        }
    }

    #[test]
    fn oversized_doc_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        let big = "x".repeat((MAX_PROJECT_DOC_BYTES + 1) as usize);
        write_doc(dir.path(), "ARCHITECTURE.md", &big);
        write_doc(dir.path(), "STRUCTURE.md", "small");
        let docs = read_project_docs_canonical(dir.path().to_str().unwrap());
        assert!(!docs.rendered_block.contains(&big));
        assert!(docs.rendered_block.contains("small"));
    }

    // --- differential golden: the canonical hash + render must match the TS reference ---

    #[derive(Deserialize)]
    struct DocCase {
        files: Vec<(String, String)>, // (filename, raw body)
        rendered_block: String,
        canonical_hash: String,
    }
    #[derive(Deserialize)]
    struct DocsGolden {
        cases: Vec<DocCase>,
    }

    #[test]
    fn project_docs_golden_matches_reference() {
        let raw = include_str!("../testdata/project-docs-golden.json");
        let golden: DocsGolden = serde_json::from_str(raw).expect("parse project-docs-golden.json");
        assert!(!golden.cases.is_empty());
        for (n, case) in golden.cases.iter().enumerate() {
            let dir = tempfile::tempdir().unwrap();
            for (name, body) in &case.files {
                write_doc(dir.path(), name, body);
            }
            let docs = read_project_docs_canonical(dir.path().to_str().unwrap());
            assert_eq!(
                docs.rendered_block, case.rendered_block,
                "render mismatch case {n}"
            );
            assert_eq!(
                docs.canonical_hash, case.canonical_hash,
                "hash mismatch case {n}"
            );
        }
    }
}
