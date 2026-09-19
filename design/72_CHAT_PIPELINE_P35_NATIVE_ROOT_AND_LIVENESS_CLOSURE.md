# Chat Pipeline P3.5 - Native Root and Liveness Closure

**Status:** frozen remediation prerequisite
**Parent:** `design/40_CHAT_PIPELINE_RELEASE_ENGINEERING_IMPLEMENTATION_PLAN.md`
**Supersedes:** the helper acceptance portion of `design/70_CHAT_PIPELINE_P35_HANDLE_BOUND_LOCK_RECLAIM.md`
**Trigger:** independent review of the design/70 candidate found ancestor-reparse traversal and caller-only owner-dead assertions.
**Scope:** fixed Windows stale-lock reclaimer and its Host protocol, build publication, and focused tests only. No P4c, provider, runtime, browser, ChatThread schema, or release-gate changes.

## 1. Blocking facts

The design/70 candidate retained a HANDLE for the final `.lock` leaf, but opened that leaf from an absolute pathname. `FILE_FLAG_OPEN_REPARSE_POINT` protects only the leaf. An ancestor junction substituted after the Host path check can redirect the open to an ordinary lock outside the intended durable root. A post-open leaf identity comparison does not repair that traversal.

The candidate also accepted `stale_valid_dead` as a caller-selected policy. The Host checked PID liveness before spawning the helper, but the helper did not revalidate the PID contained in the owner bytes read through its retained HANDLE. A candidate can be replaced between those steps by a stale record with a live owner PID and be deleted.

Its build script recursively removed a fixed output directory by path. A reparse point in that output tree can redirect destructive cleanup. None of these facts are acceptable P3.5 evidence.

## 2. Required topology

```text
ChatThreadStore
  -> withPathLock(containment root)
  -> path-lock derives Windows volume root + relative safe segments
  -> opaque fixed reclaimer capability
  -> GameBuddy.WindowsStaleLockReclaimer
       -> volume-root HANDLE
       -> one retained no-follow directory HANDLE per ancestor segment
       -> one retained no-follow regular leaf HANDLE
       -> native owner/PID revalidation
       -> handle-bound disposition only
```

The Host never supplies a helper path, arbitrary operation, arbitrary root, raw command, or pathname delete fallback. The helper does not accept an absolute leaf path.

## 3. Frozen request grammar

Only drive-rooted Windows paths are supported by v1. UNC, volume GUID, device, relative, wildcard, dot, dot-dot, empty and reserved segments are rejected. Unsupported paths fail closed.

Each request has `schemaVersion: 1`, `root`, and `segments`:

```ts
type Reclaim = {
  schemaVersion: 1;
  operation: "reclaim_stale_lock";
  policy: "stale_malformed" | "stale_valid_dead";
  root: `${string}:\\`;
  segments: readonly string[];
};

type Release = {
  schemaVersion: 1;
  operation: "release_owned_lock";
  token: string;
  root: `${string}:\\`;
  segments: readonly string[];
};
```

`root` is exactly an uppercase or lowercase drive root (`C:\\`); `segments` is non-empty, contains only one literal safe component each, and its final component ends in `.lock`. The Host derives this tuple from an already absolute lock path and never lets caller input choose it. The helper requires exact top-level fields and canonical UTF-8 JSON as in design/70.

## 4. Native no-follow chain

1. Open the drive root once and reject it unless it is a non-reparse directory.
2. For every non-leaf segment, use `NtCreateFile` with the retained parent as `RootDirectory`, `FILE_DIRECTORY_FILE`, `FILE_OPEN_REPARSE_POINT`, and synchronous no-follow behavior. Verify the opened object is a non-reparse directory before replacing the current retained parent HANDLE.
3. Open the final leaf relative to that retained parent with `FILE_NON_DIRECTORY_FILE`, `FILE_OPEN_REPARSE_POINT`, read/delete rights and only reviewed sharing. Reject directory, reparse, non-regular, share, filesystem or API ambiguity.
4. All owner classification, two observations, byte reread, and disposition use the same leaf HANDLE. A pathname is never re-resolved after the root/segment chain starts.
5. `release_owned_lock` uses the same chain and exact-token match on its leaf HANDLE.

A post-open replacement can change a name in an ancestor namespace, but cannot redirect a retained child directory or leaf HANDLE. It therefore survives; only the previously opened leaf receives a disposition.

## 5. Native liveness rule

For `stale_valid_dead`, the helper must require all of the following from its own retained leaf HANDLE:

- strict valid owner grammar;
- stale `createdAtMs` and stale `LastWriteTime`;
- `Process.GetProcessById(owner.pid)` reports no live process;
- after the observation interval, same file facts and same owner bytes; and
- a second native liveness check for the reread owner PID immediately before disposition.

Any live PID, PID check error, owner mutation, or ambiguity returns a conservative kept category. Host liveness only selects a candidate and cannot substitute for this native proof. PID reuse may conservatively keep a stale lock, never justify deletion.

## 6. Build publication rule

`build-windows-stale-lock-reclaimer.mjs` must not recursively remove the fixed `.dist/win-x64` output path. If a complete canonical helper/manifest pair already exists, it verifies and returns that pair. If it is absent, publish into the exact expected path only after bounded no-follow/reparse preflight of every existing ancestor; if any required ancestor or existing output object is missing, linked, reparse, non-directory, extra, incomplete, or ambiguous, fail closed. A later implementation may introduce a native handle-bound publisher, but this card does not authorize path-based cleanup.

The build test must demonstrate an existing output junction is rejected before `dotnet publish`, without touching its target. It must also prove a valid existing pair is verified/reused without deletion.

## 7. Required acceptance evidence

1. Protocol tests reject obsolete `path` requests and every malformed root/segment form; only exact root/segments grammar reaches the helper.
2. Native live test: an ancestor junction below the drive root returns `kept_not_regular` and leaves an outside victim byte-identical.
3. Native live test: a stale valid lock whose owner PID is the live test process returns a kept result even when the Host-facing policy requests `stale_valid_dead`.
4. Native live test: replace the leaf, an ancestor path component, and a reparse leaf after the helper starts; each replacement survives byte-identically and no external target is touched.
5. Native live test: stale zero-byte, malformed, and dead owner under a non-reparse path reclaim the exact opened leaf; normal exact-token release works.
6. Build test: output-tree junction/pre-existing malformed pair fails before publication and preserves external sentinel; valid pair is reused and no recursive delete occurs.
7. Focused Host, native, artifact and emitted production tests pass. The actual production artifact invokes only the published verified helper.
8. Fresh independent review finds no remaining path-resolution, owner-liveness, handle-disposition, build-cleanup, or non-Windows pathname fallback bypass.

## 8. Completion wording

Only after all evidence passes may P3.5 claim handle-bound Windows stale-lock recovery. This does not claim POSIX stale recovery, P4c implementation, reference-pipeline completion, or release. P2 Windows arbitrary-reparse live evidence remains independent.
