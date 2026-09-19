# Chat Pipeline P3.5 - Handle-Bound Stale Lock Reclaim

**Status:** frozen remediation prerequisite
**Parent:** `design/40_CHAT_PIPELINE_RELEASE_ENGINEERING_IMPLEMENTATION_PLAN.md`
**Supersedes:** the automatic-unlink portion of `design/68_CHAT_CORE_ARCHITECTURE_AND_DIGEST_GOVERNANCE.md` §2.1
**Inputs:** `design/67_CHAT_CORE_REFERENCE_PIPELINE_AUDIT_REMEDIATION.md`, `design/68_CHAT_CORE_ARCHITECTURE_AND_DIGEST_GOVERNANCE.md`, independent TOCTOU review dated 2026-08-16
**Scope:** Windows production locking for ChatThread durable artifacts only. This card may make no P4c/P5/P7/provider/browser/runtime changes.

## 1. Blocking truth

The current `reclaimStaleLock()` performs a final `lstat` identity check and then calls path-based `rm(lockPath)`. A different process can replace the pathname between those operations. The later unlink can therefore delete a substituted ordinary file, a fresh valid lock owner, or a reparse entry.

Two `lstat` observations, an immediate pre-unlink re-check, a UUID owner record, or a longer delay do **not** close this gap. Node's pathname `rm`, POSIX `unlink`, and Windows `DeleteFile` resolve the pathname at deletion time. The current implementation must not be accepted as automatic stale-lock recovery.

Until this card passes, `ChatThreadStore` must treat a stale valid/malformed/zero-byte lock as a fail-closed `durable_path_lock_timeout` barrier. No caller may unlink, rename, quarantine, truncate, overwrite, or otherwise repair the lock path. This blocks P3.5 completion and P4c implementation.

## 2. Required primitive

Add a new sibling native helper. Do **not** modify or repurpose `GameBuddy.WindowsReparseInspector`:

```text
GameBuddy.WindowsStaleLockReclaimer
```

The existing inspector has frozen `inspect` schema-v1 provenance, manifest, request/response protocol, and release evidence. Combining delete authority with that passive inspection helper would silently expand a trusted capability and invalidate its evidence meaning.

The new helper must be a single-purpose, `win-x64`-pinned executable with its own:

- source directory and locked project file;
- fixed build script, trusted dotnet SDK check, output directory, SHA-256 manifest, schema and protocol version;
- exact production artifact descriptor and allowlisted pair;
- Host opaque capability minted only from its fixed verified emitted pair;
- narrow request/response schema and bounded UTF-8 stdin/stdout;
- emitted-artifact/provenance/inventory/recheck coverage;
- native current-user live evidence.

It is not a generic file deletion, move, cleanup, or inspection service. Its v1 protocol has exactly two fixed operations, `reclaim_stale_lock` and `release_owned_lock`; it never accepts a caller-selected operation, directory, glob, root, recursive flag, or arbitrary disposition. Both accept only one canonical absolute `.lock` leaf. The latter also accepts the owning UUID token and deletes only if bytes read through its opened HANDLE still prove that token.

## 3. Handle-bound reclaim protocol

The helper owns all file-object operations. Host never falls back to path deletion.

1. Validate a canonical request with exactly the frozen fields for one of two operations. Reject NUL, wildcards, relative paths, non-canonical JSON, duplicate keys, unknown keys, overlong input, and values outside the frozen grammar.
2. Open the leaf with `CreateFileW`, a handle that does not follow a reparse point (`FILE_FLAG_OPEN_REPARSE_POINT`), requests only the minimum read/delete rights, and opens no directory/reparse target.
3. Query the opened **HANDLE**, not the path: `FileIdInfo` (volume serial + 128-bit file ID), basic timestamps, standard size, and reparse attributes. Reject if not a regular non-reparse file.
4. Read bounded owner bytes through the same handle. Classify valid owner strictly (token/pid/createdAtMs), malformed, or zero-byte. Host supplies only a fixed policy selector; it may not weaken this classification.
5. `reclaim_stale_lock` accepts only `stale_malformed` or `stale_valid_dead` policy selectors. The native opened-handle facts must agree with the selector; Host's owner-dead proof is only a predicate for selecting `stale_valid_dead`, never identity evidence.
6. For `reclaim_stale_lock`, wait the bounded frozen observation interval **while retaining the same HANDLE**. Re-query the same handle's file ID, size, mtime and ctime and re-read its owner bytes. Any mutation, reparse/non-regular transition, read failure, handle failure, owner reclassification, or unexpected status keeps/fails closed.
7. `release_owned_lock` accepts only the original UUID token, immediately reads the opened HANDLE and requires an exact valid token match. It has no path pre-read or pathname fallback.
8. Delete only via `SetFileInformationByHandle` disposition on that same verified handle. It must be impossible for a post-open pathname replacement to be deleted. Close the handle in all paths.
9. Return only a schema-frozen status category. No raw path, owner bytes, headers, native Win32 diagnostics, IDs, timestamps, or process data may be logged or exposed outside focused test receipts.

The helper must fail closed on any unavailable API, unsupported filesystem, access/share failure, malformed request, output overflow, timeout, missing file, reparse point, not-regular leaf, identity mismatch, or unrecognized native result. `missing` is not successful reclaim; Host may retry normal exclusive create only after a typed `missing` result.

## 4. Authority and Host surface

`path-lock.ts` owns recovery policy and maps native categories to its existing typed recovery result. It may request the opaque capability but does not gain native delete rights, a helper path, a raw command, or a general filesystem API.

```text
ChatThreadStore
  -> withPathLock
  -> path-lock policy
  -> opaque Windows stale-lock reclaimer capability
  -> fixed verified helper pair
  -> handle-bound delete of the opened lock object only
```

The capability must be unavailable/fail-closed on non-Windows. This card deliberately does not create a POSIX implementation or reduce POSIX stale locks to best-effort pathname operations. Until an equivalent descriptor-relative primitive and evidence exist, POSIX stale locks remain barriers.

The helper may invoke `reclaim_stale_lock` only on a candidate after `withPathLock` received `EEXIST`; it may invoke `release_owned_lock` only for the current successful owner record. A normal owner release must use `release_owned_lock` with exact token validation. It must never perform token-read -> pathname `rm`, nor may it conservatively strand every normal release as a later stale barrier.

## 5. Required evidence

### Native protocol and provenance

- rejection of schema mismatch, duplicate/unknown fields, invalid UTF-8/BOM/newline, relative/wildcard/NUL paths, overlong input/output, timeout/stderr/nonzero/malformed response;
- fixed `win-x64` build provenance, manifest SHA-256, exact helper/manifest pair, descriptor rejection, emitted artifact inventory and recheck;
- old reparse inspector protocol and manifest stay byte/behavior compatible.

### Object-identity safety

- stale zero-byte, stale malformed, stale valid dead owner: delete exactly the originally opened object;
- fresh malformed/zero-byte and valid fresh/live owner: never delete;
- same-handle size/mtime/file-ID mutation: no delete;
- post-open path replacement by ordinary file, valid live owner, and reparse fixture: replacement survives; helper returns conservative non-reclaimed result;
- missing/rename/share violation/access denied/filesystem unsupported: no delete and typed fail-closed result;
- normal owner release cannot delete a replacement after its token check;
- Windows production emitted helper is the process invoked, not a source-tree or test shim.

### Chat integration

- direct stale lock tests use a test-only fake opaque capability; production code cannot mint the fake;
- genuine ChatThread write/recovery under stale zero-byte/malformed/dead owner uses the helper only on Windows and no local `rm` workaround;
- all non-Windows tests assert stale candidate blocks rather than silently invoking path deletion;
- prepared journal, transcript, draft, ledger and idempotency remain byte-identical when reclaim is rejected;
- source and emitted import/artifact topology proves this helper cannot be used as a generic deletion process.

### Windows live gate

One serialized mutation gate in an isolated GameBuddy-owned root must create a stale lock candidate, use the **published emitted helper**, replace its pathname after open with each adversarial fixture above, and prove the replacement remains byte-identical while the original handle object alone receives disposition. No fixture/mock/source helper/audit JSON proves release evidence.

## 6. Completion wording

Only after all evidence passes may P3.5 say:

```text
Chat capacity and handle-bound Windows stale-lock recovery complete; P4c implementation may begin.
```

This is not `chat_core_reference_pipeline_v1 complete`, `chat_core_v1 released`, or a cross-platform stale-lock recovery claim. P2 Windows arbitrary-reparse evidence remains independently required for any release.
