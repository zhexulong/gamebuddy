# retina-local-fs

`retina-local-fs` is the credential-free reference script provider for local filesystem and
Git predicates. It reads exactly one JSON request from stdin and writes exactly one JSON
response to stdout.

```json
{"scalar":null,"config":{"kind":"path_exists","path":"/workspace/result.json"}}
```

A successful check exits `0` and returns `{"events": [...], "scalar": {...}}`. An empty
`events` array means the filesystem or repository was checked and the condition did not fire.
A check that could not be performed exits nonzero, writes no stdout, and writes one JSON line
to stderr: `{"code":"...","message":"..."}`.

## Configuration

A request's `config` is one atomic predicate or `{ "any": [...] }` containing one to four
atomic predicates. Unknown fields are rejected. Every atomic predicate may also carry the optional
authoring audit field `resolved_path_exists`; authoring sets it to `false` when the source path was
relative or the resolved path did not exist yet, and the provider otherwise ignores it.

| Kind | Fields | Fires when |
| --- | --- | --- |
| `file_contains` | `path`, `needle`, optional `absent` | The readable file contains `needle`, or does not contain it when `absent` is true. |
| `path_exists` | `path`, optional `gone` | The path exists, or does not exist when `gone` is true. A missing path is an observation, not an error. |
| `mtime_after` | `path`, `since_ms` | The readable path's mtime is later than `since_ms`. Each later mtime is a new occurrence. |
| `git_commit_after` | `repo_path`, optional `ref`, `sha` | The local ref (default `HEAD`) is a strict descendant of `sha`. Each newly observed descendant commit is a new occurrence. |
| `git_tag_matching` | `repo_path`, `pattern`, optional `above` | A newly observed local tag matches Git's tag-list glob and, when supplied, is semantically newer than `above`. |

The scalar is opaque to callers and must be passed back unchanged. It is a scalar-diff value
(observed-vs-stored, emit-on-change) that records the last state of each predicate. The wire
field was renamed from `cursor` to `scalar` to match the contract note's scalar-diff naming pin
before any consumer existed, so no compatibility shim is needed. A condition fires on its first
matching observation and when it enters a matching state again; unchanged states emit nothing.
Each event has this shape:

```json
{
  "id": "provider-minted sha256",
  "kind": "path_exists",
  "path": "/canonical/path",
  "predicate": {"kind":"path_exists","path":"/requested/path"},
  "observed": {"exists":true},
  "fired_at_ms": 1786320000000
}
```

The identity preimage is
`local-fs:<canonical_path>:<canonical-predicate-sha256>:<occurrence_marker>`. Re-polling the
same state therefore preserves identity, while changed mtimes, commits, tags, and repeated
boolean transitions receive distinct occurrence markers.

## Path fence and carve-ins

Paths are made absolute and symlinks are resolved before the provider evaluates this belt.
The runner remains the authoritative fence.

| Rule | Exact match |
| --- | --- |
| Fenced roots | `~/.local/share/cortexkit/plexus/**`, `~/.local/share/cortexkit/claustrum/**`, and `~/.local/share/cortexkit/staging/**` |
| Fenced basenames | `*binding-key*` and `*.handle` at any location |
| Fenced event store | `~/.local/share/cortexkit/plexus/**/store.db*` (also covered by the plexus root fence) |
| Carve-in: catalogs | Any path with a complete `catalog` path segment (`**/catalog/**`) |
| Carve-in: module binaries | `~/.local/share/cortexkit/*/bin/**` |
| Carve-in: catalog JSON | Any basename matching `*catalog*.json` |

Carve-ins take precedence over the fenced-root and basename rules. This table is the
file-granular allowlist that condition migration must use; it deliberately admits files such
as `engram-catalog.json` and module `bin` mtimes without admitting neighboring key material.

## Local conformance

```sh
bun test
bunx tsc --noEmit
bunx biome check src examples
bun run smoke
```

The smoke example creates a real temporary file, invokes the executable twice, and verifies
that the returned scalar suppresses the unchanged second observation.
