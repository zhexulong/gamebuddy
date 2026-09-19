# Chat Pipeline P3.5 — Windows Stale-Lock Reclaimer Adversarial Live Gate

**Status:** frozen release-evidence definition (the single serialized mutation gate for P3.5)
**Parent:** `design/70_CHAT_PIPELINE_P35_HANDLE_BOUND_LOCK_RECLAIM.md` §5 "Windows live gate"
**Inputs:** `design/70` (handle-bound reclaim protocol, authority surface, evidence list), `design/45_WINDOWS_REPARSE_LIVE_EVIDENCE_IMPLEMENTATION_PLAN.md` (live-gate evidence-authority pattern), current `windows-stale-lock-reclaimer` helper/adapter/build/artifact paths as of this card
**Scope:** freezes the exact Windows P3.5 adversarial live gate. This card defines only evidence; it changes no production, test, or configuration code. No fixture/mock/source helper/audit JSON is release evidence (see §2).

## 1. Why this card exists

`design/70` requires one serialized mutation gate that uses the **published emitted helper**, creates a real stale lock candidate in an isolated GameBuddy-owned root, replaces its pathname after open with each adversarial fixture, and proves the replacement remains byte-identical while the original handle object alone receives disposition. That requirement is not met by the existing unit tests: they bind the test-only synthetic capability (`windows-stale-lock-reclaimer/index.test-support.ts`), run on any platform, and never invoke the real emitted executable. A canonical all-`passed` result file is also not authority, exactly as established for the reparse inspector in `design/45`.

This card therefore freezes the exact gate contract — process selection, request grammar, adversary protocol, verdict semantics, assertion table, redacted outcome, and release wiring — so that a later implementation lane can build `host/scripts/run-windows-stale-lock-reclaimer-live-gate.mjs` without making any evidence decision itself.

## 2. Evidence authority: no fixture/fake capability is release evidence

- The only release evidence for P3.5 Windows stale-lock reclaim is a **current run of the frozen live gate** on Windows, which invokes the **emitted helper pair of the selected production generation** through the **emitted adapters of that same generation**.
- The test-only fake capability (`createTestWindowsStaleLockReclaimer` from `index.test-support.ts`) is never release evidence. Production generations cannot even contain it: `TEST_ARTIFACT` in `host/scripts/production-artifact.mjs` rejects `*.test-support.*` modules, and `resolveProductionModule` rejects test artifacts. The gate must never import, bind, or mint it.
- The source-tree build pair `host/native/windows-stale-lock-reclaimer/.dist/win-x64/` is never release evidence. The gate must never resolve it and must fail blocked if the selected generation's pair is missing (the emitted `requestWindowsStaleLockReclaimer()` fallback to the build pair is a dev convenience; the gate asserts the co-located published pair directly so that fallback is provably not in play).
- A previously written evidence file, a hand-authored all-`passed` JSON, or a stored audit artifact is never release authority. The release prerequisite checker invokes the gate afresh and accepts only a clean current exit plus an exact success result (§6).
- Fixtures (stale candidates, replacements, junctions) are real filesystem objects in the gate's private root; fixture creation failure is a **blocked** outcome, never a skipped pass.

## 3. Grounding in current helper/adapter/build paths

| Concern | Exact current path |
|---|---|
| Native helper (frozen v1 protocol, handle-bound reclaim/release, 100 ms `ObservationIntervalMs`, 5 min `StaleIntervalMs`, `kept_path_replaced` via `PathStillNamesHandle`) | `host/native/windows-stale-lock-reclaimer/Program.cs` |
| Locked project (net8.0, win-x64 self-contained single-file) | `host/native/windows-stale-lock-reclaimer/GameBuddy.WindowsStaleLockReclaimer.csproj` |
| Fixed build (trusted SDK, locked `global.json` version, canonical manifest, output `host/native/windows-stale-lock-reclaimer/.dist/win-x64`) | `host/scripts/build-windows-stale-lock-reclaimer.mjs` |
| Host opaque capability mint (strict manifest/hash verify; fail-closed on non-Windows/non-x64), frozen request/response, `reclaimStaleLock`/`releaseOwnedLock`, `createPublishedWindowsStaleLockReclaimer`, `requestWindowsStaleLockReclaimer` | `host/src/windows-stale-lock-reclaimer/index.ts`, `internal.ts` |
| Test-only fake capability (never release evidence) | `host/src/windows-stale-lock-reclaimer/index.test-support.ts` |
| Lock policy: `withPathLock`, `reclaimStaleLock(lockPath)` typed recovery, `releaseOwnedPathLock`, `bindWindowsStaleLockReclaimer`, `STALE_LOCK_MS = 5 * 60_000`, `LOCK_TIMEOUT_MS = 10_000`, `durable_path_lock_timeout`, `unsafe_path_boundary` | `host/src/path-lock.ts` |
| ChatThread store (all mutations under `withPathLock` with `containmentRoot`, six artifacts: `thread.json`, `messages.json`, `draft.json`, `turn-ledger.json`, `idempotency.json`, `transaction.json`) | `host/src/tavern/chat-thread-store.ts` |
| Artifact descriptor `windowsStaleLockReclaimer` (`native/windows-stale-lock-reclaimer/win-x64`, helper + manifest, no optional audit file), `verifyWindowsStaleLockReclaimerPair`, `ensureWindowsStaleLockReclaimerPair`, inventory origin recording | `host/scripts/production-artifact.mjs` |
| Production generation selection: `resolveProductionEntry({hostRoot, outputRoot: resolve(hostRoot,"dist"), entry})`, `recheckProductionEntry`, `resolveProductionModule({selected, module})` | `host/scripts/production-artifact.mjs`, `host/scripts/start-production-artifact.mjs`, `host/scripts/check-production-artifact.mjs` |
| Emitted modules in a generation (adapter, policy, store) | `<artifactRoot>/windows-stale-lock-reclaimer/index.js`, `<artifactRoot>/path-lock.js`, `<artifactRoot>/tavern/chat-thread-store.js` |
| Release checker precedent (injectable live-gate runner, `windows_arbitrary_reparse_enforcement`) | `tools/check-tavern-release-prerequisites.mjs` |

## 4. Frozen gate contract

The gate is one Windows-only, repository-owned, serialized script: `host/scripts/run-windows-stale-lock-reclaimer-live-gate.mjs` (to be implemented after this card; its focused tests live at `run-windows-stale-lock-reclaimer-live-gate.test.mjs`). One gate process owns fixture creation, helper invocation, and every assertion. No other lane may run the mutations. The elements run in the frozen serialized order: E1 (§4.3) → E2 (§4.4) → E3 (§4.5) → E4 (§4.6) → E5 artifact layer (§4.7) → E6 (§4.8) → E5 policy-layer control (§4.7, last because it mutates the emitted policy's capability binding).

### 4.1 Generation selection and bootstrapping (emitted helper from selected production generation)

1. `process.platform` must be `win32`; otherwise the gate returns the frozen blocked result `windows_platform_required` and exits nonzero.
2. Resolve the same selected generation the production launcher uses:
   `selected = await resolveProductionEntry({ hostRoot, outputRoot: resolve(hostRoot, "dist"), entry: "main.js" })`.
   Any failure is `production_generation_unavailable` (blocked) — the gate never compiles current source as a substitute, deliberately unlike the reparse gate.
3. `await recheckProductionEntry({ hostRoot, selected })` — full inventory digest + `windowsStaleLockReclaimer` pair verification of the selected generation. Failure is `production_generation_integrity_mismatch` (blocked). Record `helperSha256` from the generation manifest (`windows-stale-lock-reclaimer.manifest.json`) and the generation id for the redacted outcome.
4. Resolve and import only generation-emitted modules:
   `windows-stale-lock-reclaimer/index.js` (adapter), `path-lock.js` (policy), `tavern/chat-thread-store.js` (store) via `resolveProductionModule({ selected, module })`. Import of any other path (including source `dist/` and any `test-support` module) is a gate fault.
5. Assert the co-located published mint succeeds: `adapter.createPublishedWindowsStaleLockReclaimer(selected.artifactRoot)` must resolve. This proves the generation pair is usable through the exact production mint path and that the emitted default policy cannot be silently falling back to the source build pair.
6. All helper invocations go through the emitted adapter's `reclaimStaleLock`/`releaseOwnedLock` or the emitted policy's typed functions. The gate never executes the helper directly and never obtains its path.

### 4.2 Candidate and fixture grammar (real lock leaf)

- The gate creates a private fixture root via `mkdtemp` under the system temp directory (`gamebuddy-stale-lock-live-gate-*`) on the same volume; the §4.7 tamper cases use their own private pair-copy roots. All roots are removed on every outcome.
- The lock candidate is a real regular `.lock` leaf with exactly one of the frozen byte forms:
  - zero-byte: 0 bytes;
  - malformed: the 13 bytes `partial write` (no newline);
  - valid: one line `{"token":"<uuid>","pid":<pid>,"createdAtMs":<ms>}` (canonical, no trailing newline) — the same bytes `path-lock.ts` writes on acquisition.
- Stale means mtime (and for valid owners `createdAtMs`) at least `5 * 60_000` ms in the past; the gate ages by 6 minutes with `utimes`.
- A dead PID is obtained deterministically: spawn a real child (`node -e ""`), wait for its exit, use its PID. PID reuse ambiguity is a residual risk (§8), never a skip.
- Fixtures (adversarial replacements): (a) ordinary file — 13 fresh bytes `not-a-lock-file` (fresh mtime = now); (b) valid fresh live owner — frozen valid form with the gate's own PID and `createdAtMs = Date.now()` (fresh mtime); (c) reparse entry — a real junction and a real directory symlink created with `fs.symlink(..., "junction" | "dir")`. Fixture creation failure is `blocked`, never `passed`.

### 4.3 E1 — Stale candidate reclaim (positive and negative controls)

At the adapter layer (emitted `reclaimStaleLock(capability, path, policy)`) and the policy layer (emitted `path-lock.reclaimStaleLock(lockPath)`), in fresh roots, no adversary:

| Candidate | Adapter category | Policy result (frozen) |
|---|---|---|
| stale zero-byte | `reclaimed` | `{outcome:"reclaimed", reason:"malformed_stale_identity_stable"}` |
| stale malformed (`partial write`) | `reclaimed` | `{outcome:"reclaimed", reason:"malformed_stale_identity_stable"}` |
| stale valid dead owner | `reclaimed` | `{outcome:"reclaimed", reason:"valid_owner_stale_and_dead"}` |
| fresh zero-byte / fresh malformed | `kept_malformed_fresh` | `{outcome:"kept", reason:"malformed_fresh"}` |
| valid fresh owner (gate PID, fresh) | `kept_valid_fresh` | `{outcome:"kept", reason:"valid_owner_fresh"}` |
| valid old owner, live PID (gate PID, old `createdAtMs`, fresh mtime) | `kept_valid_fresh` | `{outcome:"kept", reason:"valid_owner_fresh"}` |

For every `reclaimed` row the gate asserts the leaf is `ENOENT` and every other file in the root is byte-identical to its pre-run snapshot. For every `kept_*` row the leaf is byte-identical to its pre-run bytes. This proves "the original handle object alone receives disposition" for the plain reclaim path.

### 4.4 E2 — Post-open pathname replacement survival (adversarial)

Layering note: E2 runs at the **adapter layer only** (frozen request → frozen category). The policy layer's pre-reads would observe the adversary and abort before the helper, which cannot produce the categorical post-open proof.

Protocol (frozen), one attempt:

1. Fresh root: `candidate.lock` (family A: stale malformed, policy `stale_malformed`; family B: stale valid dead, policy `stale_valid_dead`), fixture (a)/(b)/(c) from §4.2 in the same directory, reserved free names `adversary-stash.bin` and `adversary-fixture.bin`. Snapshot both byte-hashes.
2. The fixture initially lives at its own name `adversary-fixture.bin`. Start the in-process adversary loop before the invocation: every ≤2 ms, perform (i) `rename(candidate.lock → adversary-stash.bin)` and (ii) `rename(adversary-fixture.bin → candidate.lock)`, each exactly once, retrying each until it succeeds or a 5 s deadline expires (deadline expiry is blocked). Both renames are atomic, same volume, same directory. The loop stops at settle + 50 ms grace.
3. Invoke `adapter.reclaimStaleLock(capability, candidate.lock, policy)`; record the category.
4. Assert per the frozen table:

| Result | Proof / assertions after settle |
|---|---|
| `kept_path_replaced` | **Categorical post-open replacement proof** (the category is emitted only when the opened object no longer matches the pathname at the final path-check). Assert: `candidate.lock` bytes = fixture bytes (replacement survived); `adversary-stash.bin` bytes = original candidate bytes; no other file changed. |
| `kept_malformed_fresh` / `kept_policy_mismatch` / `kept_valid_fresh` / `kept_not_regular` | Conservative pre-open ordering (helper opened the fresh/non-regular fixture). Assert replacement and stash (if any) byte-identical; nothing deleted. |
| `missing` | Replacement installed in the rename gap before open. Assert replacement and stash byte-identical; nothing deleted. |
| `reclaimed` | The original opened object received disposition. Assert `candidate.lock` is `ENOENT` or byte-identical to the fixture (fixture landed after disposition — the safe interleaving where the original alone was deleted), `adversary-stash.bin` byte-identical to the original or absent (absent means the original was deleted in place, i.e., the path-check passed before the adversary moved it), and no other file changed. |

Fixed combinations (frozen): (A × ordinary), (A × valid-live), (A × reparse), (B × ordinary), (B × valid-live), (B × reparse) — 6 combos, up to 5 attempts each.

Pass rule per combo: at least one attempt returned `kept_path_replaced` **and** no attempt in the combo violated the table (any deleted replacement, any deleted stash without the matching `reclaimed` case, or any modified unrelated file). A combo that never observes `kept_path_replaced` within its 5 attempts is **blocked** — never a skipped pass. Because the helper's frozen observation window is 100 ms and the adversary loop steps ≤2 ms, the pass rule is a deterministic verdict rule over real observations, not a statistical estimate.

### 4.5 E3 — Reparse refusal

- Adapter layer: a stale *reparse candidate* (junction and directory symlink each) via `adapter.reclaimStaleLock(capability, path, policy)` → `kept_not_regular`; the reparse entry and its target remain byte-identical.
- Policy layer: emitted `path-lock.reclaimStaleLock(reparseLeaf)` → `{outcome:"unsafe", reason:"reparse_or_link"}`; leaf and target untouched.
- Store layer: covered by E6 rejection case (a).

### 4.6 E4 — Normal owner release exact token

All deterministic (no timing), at the policy layer (`emitted path-lock.releaseOwnedPathLock`):

1. Exact token: plant valid owner (token T, gate PID, now) → `releaseOwnedPathLock(lockPath, T)` → `{outcome:"released", reason:"exact_token_released"}`; leaf `ENOENT`.
2. Token mismatch: plant valid owner T → release with a different valid UUID → `{outcome:"kept", reason:"token_mismatch"}`; leaf byte-identical.
3. Replaced path (normal release must not delete a replacement after its token check): plant original lock (token T), rename it to `adversary-stash.bin`, install a fresh valid owner (token T2, gate PID, now) at the leaf, then `releaseOwnedPathLock(leaf, T)` → `{outcome:"kept", reason:"token_mismatch"}`; replacement and stashed original both byte-identical. The helper opened the *replacement*, whose bytes do not prove T, so nothing is deleted.
4. Missing: release a path with no lock → `{outcome:"released", reason:"lock_already_missing"}` (frozen vacuous success).

### 4.7 E5 — Tamper / unavailable rejection

Artifact layer (direct, via the emitted adapter, on **copies** of the selected generation pair in a private root — the selected generation is never modified):

1. Tampered binary: flip one byte of the copied helper → `createPublishedWindowsStaleLockReclaimer(tamperedRoot)` must reject with `windows_stale_lock_reclaimer_unavailable`.
2. Tampered manifest: wrong SHA-256; extra key; malformed JSON — each must reject identically.
3. Missing pair (helper absent; manifest absent): reject identically.
4. For each rejection, assert the mint failure is total: no capability object is ever produced, the copied pair's candidate lock bytes in the tampered root stay byte-identical, and a subsequent `reclaimStaleLock`/`releaseOwnedLock` invocation against that root also throws `windows_stale_lock_reclaimer_unavailable` without deleting anything.

Policy layer (fail-closed control, run last because it mutates the emitted policy's binding): with the emitted `path-lock`, `bindWindowsStaleLockReclaimer(undefined)` (the production fail-closed switch, same behavior as every non-Windows runtime) → `reclaimStaleLock` on a stale candidate → `{outcome:"kept", reason:"windows_reclaimer_unavailable"}`, leaf intact; `releaseOwnedPathLock` → `{outcome:"unavailable", reason:"windows_reclaimer_unavailable"}`, leaf intact. This control proves the unbound/fail-closed path leaves the barrier in place; it is not helper evidence.

### 4.8 E6 — ChatThreadStore stale recovery (emitted store, genuine mutation)

In a fresh isolated GameBuddy-owned root, via the emitted `tavern/chat-thread-store.js` (`createChatThreadStore(root, continuityKey, now)` with `now` returning the real clock):

1. `createThread("thread_01", ...)`; snapshot all six artifact files (hash + bytes).
2. Recovery flows (each: plant lock residue on `thread.json.lock`, then a genuine mutation, then assert): stale zero-byte → `appendPlayer` succeeds, lock `ENOENT`, read-back correct; stale malformed → succeeds, lock `ENOENT`; stale valid dead owner (dead child PID) → succeeds, lock `ENOENT`.
3. Rejection flows (each: plant residue, assert mutation **rejects**, then assert all six artifact files remain **byte-identical** — the "prepared journal, transcript, draft, ledger and idempotency stay byte-identical when reclaim is rejected" evidence):
   - (a) reparse lock at `thread.json.lock` → mutation rejects with `unsafe_path_boundary` (immediate, fail-closed);
   - (b) fresh malformed lock (mtime now) → mutation rejects with `durable_path_lock_timeout` after the frozen `LOCK_TIMEOUT_MS` (10 s); the gate's total budget accounts for this bounded wait.
4. Every mutation goes through the emitted store's `withPathLock` → emitted policy → emitted adapter → selected-generation helper. The gate never binds a capability and never performs any local lock-file deletion.

### 4.9 Frozen redacted outcome and budgets

stdout gets exactly one line: the frozen schema

```json
{"schemaVersion":1,"gate":"windows_stale_lock_reclaimer_live_gate/v1","status":"passed|blocked","reason":"<fixed lowercase underscore token>","generation":"<selected g-…>","helperSha256":"<64 hex>","elements":{"reclaimZeroByte":"passed|blocked","reclaimMalformed":"passed|blocked","reclaimValidDead":"passed|blocked","replacementOrdinary":"passed|blocked","replacementValidLive":"passed|blocked","replacementReparse":"passed|blocked","reparseRefusal":"passed|blocked","releaseExactToken":"passed|blocked","releaseTokenMismatch":"passed|blocked","releaseReplacedPath":"passed|blocked","tamperBinary":"passed|blocked","tamperManifest":"passed|blocked","tamperMissing":"passed|blocked","unavailableFailClosed":"passed|blocked","chatThreadRecover":"passed|blocked","chatThreadRejectByteIdentical":"passed|blocked"}}
```

`status` is `passed` only when `reason === "passed"` and every element is `passed`; every other outcome is `blocked` with a fixed reason (`windows_platform_required`, `production_generation_unavailable`, `production_generation_integrity_mismatch`, `fixture_unavailable`, `attempt_budget_exhausted`, `assertion_failed`, `live_gate_internal_failure`). Exit code 0 only for `passed`.

Redaction is frozen: no absolute or relative fixture paths, no tokens, no owner bytes, no raw helper output, no timestamps beyond the schema fields. The gate's own logging (for diagnosis) must never contain paths, tokens, or bytes.

Budgets (frozen): every adapter invocation stays within the adapter's own 5 s timeout and 64 KiB output limit; the adversary per-attempt budget is 5 s; each combo ≤ 5 attempts; the fresh-malformed store rejection includes the frozen 10 s `LOCK_TIMEOUT_MS`; the whole gate must settle within 300 s or exit blocked `live_gate_internal_failure`. All fixture/emitted-copy roots are removed on every outcome.

## 5. Ownership and lanes

| Lane | Owner |
|---|---|
| `host/scripts/run-windows-stale-lock-reclaimer-live-gate.mjs` + focused tests | evidence producer (this card's later implementation) |
| `tools/check-tavern-release-prerequisites.mjs` + tests | release-checker lane |
| native helper `Program.cs`, adapter `index.ts`, policy `path-lock.ts` | consumed unchanged; may be fixed only for a concrete protocol defect found by this gate, then this card's frozen evidence must be re-run |
| `tools/run-tavern-release-live-gate.mjs` | unchanged by this card |

The gate changes no HTTP mounting, React, browser contract, Chat state, provider runtime, Tavern management, or Stardew paths.

## 6. Release wiring

`check-tavern-release-prerequisites.mjs` gains one check, `windows_stale_lock_handle_bound_reclaim`, with an injectable runner defaulting to `runWindowsStaleLockReclaimerLiveGate` (same pattern as `windowsReparseLiveGateRunner`):

- Windows: `passed` only for a clean current exit and an exact success result with every element `passed`. Any malformed output, timeout, nonzero exit, blocked element, platform mismatch, or helper failure is `blocked` with the safe fixed reason.
- Non-Windows: `blocked` (`windows_platform_required`). No static source or stored JSON substitutes for the run.

Per `design/70` §6, P4c implementation may begin only after this gate is green together with the rest of the P3.5 evidence; this gate alone is not `chat_core_reference_pipeline_v1 complete`, `chat_core_v1 released`, or a cross-platform stale-lock recovery claim.

## 7. Required tests and acceptance (for the gate's later implementation)

1. A hand-written all-`passed` JSON does not make the release check pass.
2. On non-Windows the gate returns the frozen `windows_platform_required` blocked result and nonzero exit.
3. Malformed/missing production generation, inventory digest mismatch, or missing/tampered generation pair → blocked with the frozen reason, never `passed`.
4. Fixture creation failure (including junction/symlink creation) is blocked, never skipped.
5. Each E2 combo passes only with an observed `kept_path_replaced` plus a clean assertion table; budget exhaustion is blocked.
6. Existing frozen unit tests (`path-lock.test.ts`, `windows-stale-lock-reclaimer/index.test.ts`, `production-artifact.test.mjs`, `build-windows-stale-lock-reclaimer.test.mjs`) remain green and are untouched by this card.
7. The gate's stdout/stderr contains no absolute path, token, owner byte, or raw helper output.
8. `tools/check-tavern-release-prerequisites.test.mjs` covers the new check's injectable runner (passed/blocked shapes) without running Windows mutations on non-Windows CI.

## 8. Residual risks (frozen, non-blocking for the gate's own evidence)

- Same-user hostile TOCTOU racing remains a threat-model residual: the gate proves the frozen protocol's post-open replacement survival for its frozen fixtures; it does not claim protection against an adversary that wins a race against the gate's own observation, nor against non-reparse link types without a safe approved fixture. This matches the `tavern_ordinary_link_reparse_containment` framing.
- PID reuse after the dead-child PID is consumed is theoretically possible but bounded by the helper's own `createdAtMs` + mtime + same-handle identity checks; the gate's dead PID comes from a just-exited child.
- The 100 ms observation window makes `kept_path_replaced` observationally near-certain, but the pass rule remains a verdict rule over real attempts; an environment where the helper cannot keep its 100 ms schedule (e.g., pathological scheduler starvation) can only produce `blocked`, never a false `passed`.
