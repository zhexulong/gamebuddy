# 68 Chat Core Architecture and Digest Governance

**Status:** frozen architecture disposition
**Parent:** `design/40_CHAT_PIPELINE_RELEASE_ENGINEERING_IMPLEMENTATION_PLAN.md`
**Inputs:** `design/review/CODEBASE_QUALITY_AND_ARCHITECTURE_AUDIT.md`, `design/67_CHAT_CORE_REFERENCE_PIPELINE_AUDIT_REMEDIATION.md`
**Scope:** Chat Core/Tavern storage, authority, artifact and digest decisions only.
**Governing rule:** `AGENTS.md` — *"Avoid defensive over-engineering and ritualistic validation (such as arbitrary cryptographic hashes, intra-process attestation chains, or redundant verification gates)."*
**Non-goal:** a repository-wide SHA-256 removal, generic module flattening, legacy migration, or compatibility layer.

## 1. Decision

The audit correctly identifies that parts of the Host are mechanically complex, but algorithm names and directory counts are not architecture metrics. Chat Core changes must preserve the one-way authority graph and make its public interfaces deeper, rather than replacing evidence-carrying facts with readable strings or flattening private authority seams into callers.

The owned architecture is:

```text
browser/profile facade
  -> one private P4 bridge
  -> continuity coordinator opaque admission
  -> ChatThreadStore durable transaction owner
  -> strict bounded file/path-lock primitives
```

`ChatThreadStore` remains the only durable owner for an exact Chat's transcript, draft, turn ledger, idempotency, prepared journal, restart recovery and P4 attempt claim. The coordinator remains the only mint/consume owner of exact mounted-runtime admissions. Neither a second repository, a generic Saga framework, nor a caller-visible transaction choreography is permitted.

## 2. Audit dispositions

### 2.1 Accepted: malformed lock recovery is a Chat Core dependency

`ChatThreadStore` uses `withPathLock` for every durable mutation. `path-lock.ts` currently treats a malformed or zero-byte owner record as an ambiguous barrier: `readLockOwner()` returns `null`, and `reclaimStaleLock()` does not unlink it. This is safer than blind deletion, but a crash between exclusive lock-file creation and writing the owner record leaves a Chat write unavailable until the timeout rather than recoverable under a durable rule.

This is not correctly described as a permanent deadlock: the current caller receives `durable_path_lock_timeout`. It is nonetheless a real availability/recovery defect for the reference pipeline.

**Disposition:** accepted and promoted to the P3.5 storage gate.

The original path-based reclaim proposal is **superseded** by `design/70_CHAT_PIPELINE_P35_HANDLE_BOUND_LOCK_RECLAIM.md` and its native trusted-root/liveness closure `design/72_CHAT_PIPELINE_P35_NATIVE_ROOT_AND_LIVENESS_CLOSURE.md`. A final `lstat` followed by pathname `rm(lockPath)` is not identity-bound: a replacement can win after observation and be deleted. Leaf-only no-follow and Host-only owner-dead proof also remain insufficient because an ancestor reparse can redirect the open and a live owner can replace the candidate before native open. None are acceptable evidence for automatic recovery.

Until the handle-bound Windows helper passes, every stale malformed/zero-byte/valid lock remains a fail-closed barrier. The replacement repair is a narrow deep-module behavior in `path-lock`, not per-store cleanup:

1. retain fail-closed behavior while a malformed/zero-byte lock is fresh;
2. classify candidate recovery through a fixed, opaque native capability that opens the leaf no-follow and retains the same HANDLE across all observations;
3. delete only via a disposition bound to that verified HANDLE, never by a pathname operation; do not infer an owner PID from malformed bytes;
4. retain the existing valid-owner rule: only old plus locally dead owners are candidates;
5. on non-Windows, unavailable capability, reparse, mutation, substitution, share/access failure, or unrecognized result, keep the lock and fail closed;
6. produce typed results and focused tests for zero-byte crash residue, malformed residue, active writer non-reclamation, post-open ordinary/live-owner/reparse replacement, valid live/dead owner, and Windows emitted-helper provenance.

No durable Chat mutation may use a local `rm(lockPath)` workaround.

### 2.2 Rejected: flatten the coordinator or replace the Chat journal wholesale

The audit's broad `SQLite Saga` and `continuity-semantic` simplification proposals are not accepted into Chat Core. The established source has a single Chat journal owner and a private opaque admission chain. There is no demonstrated Chat failure that a new general SQLite repository would solve, while such a replacement would re-open accepted P4a/P4b recovery and authority proofs.

Future simplification may be considered only when it produces a smaller external interface for the same owner and preserves all current fail-closed recovery behavior without migration/fallback. It needs a separate measured design and independent review.

### 2.3 Deferred: root-derived management IDs and direct WorldBook file adapter

`persona-management`, `greeting-management`, and `scenario-management` derive singleton artifact IDs from a SHA-256 digest of their root. `tavern-paths` similarly derives private path partitions from identity strings. These are deterministic opaque namespace mappings, not authorization capabilities; replacing them with readable slugs would expose player/identity inputs in durable paths and does not improve authorization.

They are not a reference-pipeline blocker. P9 must replace root-derived *management artifact IDs* with owner-minted opaque IDs persisted by the managing domain, with fresh-only cutover and no hash-derived ID fallback. The initial owner-minted ID should be generated once at creation/provisioning, validated as an opaque ID, and never be shown as a player-facing name.

`host/src/worldbook.ts` is a separate direct-file adapter whose file-embedded `canonicalHash` rejects manual edits. This must not be weakened by simply trusting changed bytes: existing canonical hashes bind WorldBook content into managed artifact/Chat source selection and release evidence. P9 must first establish the unique managed World Info/WorldBook authoring owner. Once production no longer imports the direct-file adapter, remove it rather than preserving a manual-edit fallback. Managed revisions then provide the authoring/write authority, and canonical content hashes remain integrity facts on immutable revisions/bindings.

## 3. SHA-256 classification

SHA-256 is retained only where it represents an explicit integrity or binding fact. It must not be treated as a capability, a user-visible name, or a substitute for authorization.

| Class | Current Chat/Tavern examples | Decision |
|---|---|---|
| Artifact byte integrity | static asset manifest `sha256`, shipped browser/Host release tuple | Required. Keep byte hash plus exact allowlist/size/MIME/reparse checks. |
| Canonical immutable-content integrity | Tavern artifact envelope `canonicalHash`, Persona/Scenario/Greeting/World Info bindings, import/export integrity | Required. Keep canonicalization plus revision/read-back. A hash detects mismatch; it does not authorize a caller. |
| Runtime binding consistency | `runtimeBindingDigest`, exact content receipt digest, P4 idempotency fingerprint | Required. Keep only behind coordinator/store authority; bind an already-authorized identity tuple, never mint authority from a caller hash. |
| Opaque path partition | `tavern-paths` player/companion directory digest | Retain for current fresh authority. It is a private partition mapping, not security authorization and not a public identifier. Any future replacement must use owner-minted opaque mappings, not readable slugs. |
| Root-derived singleton management ID | `player-persona-*`, `greeting-set-*`, `player-scenario-*` | Do not extend. Replace in P9 with owner-minted persisted opaque IDs; no compatibility fallback. |
| File-local self-checksum | direct `worldbook.ts` `canonicalHash` field | Retire only with the direct-file adapter after managed ownership replaces it; do not remove the integrity binding from managed artifacts. |

Rules:

1. New code must name the fact it needs: `sha256`, `canonicalHash`, `idempotencyFingerprint`, or `runtimeBindingDigest`; it may not use a generic `hash` for unrelated semantics.
2. Hash equality is only one input to an already-authorized operation. Scope, revision, root, principal, lease and read-back checks remain required.
3. A hash must not appear in player-visible names, logs, browser DTOs, path error messages or capability tokens.
4. Do not introduce a secret-less hash as a claim of confidentiality. A digest of a guessable identity is a pseudonym, not a secret.
5. No performance-driven replacement occurs without a measured hot-path profile. The reference pipeline has no evidence that SHA-256 is its bottleneck.

## 4. Required sequencing

### P3.5 storage gate

Before P4c, implement and independently review:

- the `ChatThreadStore` artifact budget and transcript-capacity work from design/67; and
- handle-bound Windows malformed/zero-byte `.lock` stale recovery in the shared `path-lock` deep module, with the trusted-root ancestor chain and native owner-liveness evidence listed in `design/70` and `design/72`.

No P4c provider invocation starts while either recovery foundation is unresolved.

### P9 management identity cutover

Before a Tavern-management release, freeze a separate implementation card that:

- makes the relevant management domain mint/persist opaque artifact identities;
- routes all management artifact lookup through that owner;
- deletes root-derived management-ID implementation and tests from production once replaced;
- proves managed World Info/WorldBook revisions own authoring and content binding;
- deletes the unused direct-file WorldBook adapter instead of accepting manual filesystem editing;
- preserves canonical-hash binding for immutable revisions, imports and selected Chat sources.

### Future module simplification

A later refactor may only proceed after interface inventory shows callers can use a smaller interface with equal or stronger recovery evidence. Line count and number of directories are insufficient acceptance criteria.

## 5. Completion wording

Passing the P3.5 portions of this card permits only:

```text
Chat storage, digest governance, and handle-bound Windows stale-lock recovery prerequisites complete; P4c provider-start implementation may begin.
```

It does not permit a Chat Core release, a P9 management release, deletion of any digest class, or a claim that SHA-256 has been removed from GameBuddy.
