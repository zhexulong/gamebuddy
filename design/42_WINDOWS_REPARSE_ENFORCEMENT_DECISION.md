# Windows Artifact Reparse Enforcement Decision

**Status:** blocking implementation decision for the Chat pipeline static-artifact release boundary.

## Decision

`dialogue-web` browser artifact generation and Host static-artifact verification must reject **every** Windows filesystem entry with `FILE_ATTRIBUTE_REPARSE_POINT` before accepting or serving an artifact. Rejecting only entries that Node classifies as symbolic links is insufficient.

## Why this is required

The Chat static artifact is an integrity boundary. A reparse point can redirect traversal or make a verified artifact root mutable through an unverified target. The production requirement is no-reparse containment, not merely no-symlink containment.

## Current fact

Node's public `fs.Stats` / `fs.promises.lstat()` API exposes `isSymbolicLink()`, but does not expose Windows `FILE_ATTRIBUTE_REPARSE_POINT` or a reparse tag for arbitrary Windows reparse entries. The current Node-only checks are therefore conservative for links/junctions observed as symlinks and have directory identity cycle protection, but **cannot prove the required arbitrary-reparse exclusion**.

## Required implementation seam

Add a version-locked, local Windows filesystem inspection helper under the production artifact owner. It must:

1. call Win32 `FindFirstFileW` / `WIN32_FIND_DATA` (or an equally authoritative Windows native boundary);
2. inspect `dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT` for every root, manifest, directory, entry HTML, and listed asset before traversal/open;
3. reject any matching entry without following it;
4. report only safe category/path-free failure to callers;
5. be invoked by both browser artifact generation and Host artifact verification through a shared, tested policy implementation;
6. include Windows tests for a junction, a directory symbolic link, and an available non-link reparse variant; and
7. fail closed if the Windows helper is missing, malformed, unavailable, or reports an indeterminate result on Windows.

The helper must not be an operator-configured shell command, PowerShell text invocation, temporary script, or mutable environment discovery. It must be bundled/version-locked with the GameBuddy artifact engineering boundary and must not write user data.

## Interim state

The current Batch 02 artifacts are **not release-eligible**. They may retain the existing `lstat` link rejection, physical containment, and directory identity cycle rejection as defense in depth, but must report `windows_arbitrary_reparse_enforcement_not_implemented` in release/prerequisite evidence until this decision is implemented and verified.

No Chat Core, Tavern management, static artifact, or browser release gate may pass while this blocker remains.
