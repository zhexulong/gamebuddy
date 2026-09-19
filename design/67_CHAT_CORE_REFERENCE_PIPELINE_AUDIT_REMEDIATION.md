# 67 Chat Core Reference Pipeline - Audit Remediation and P4c Entry Gate

**Status:** frozen prerequisite design
**Parent:** `design/40_CHAT_PIPELINE_RELEASE_ENGINEERING_IMPLEMENTATION_PLAN.md`
**Inputs:** `design/66_CHAT_PIPELINE_BATCH_06_P4B_ATTEMPT_CLAIM_ADMISSION.md`, `design/68_CHAT_CORE_ARCHITECTURE_AND_DIGEST_GOVERNANCE.md`, `design/70_CHAT_PIPELINE_P35_HANDLE_BOUND_LOCK_RECLAIM.md`, `design/72_CHAT_PIPELINE_P35_NATIVE_ROOT_AND_LIVENESS_CLOSURE.md`, `design/review/CODEBASE_QUALITY_AND_ARCHITECTURE_AUDIT.md`
**Current checkpoint:** P4a durable acceptance and P4b durable generation-one claim are accepted. This card is required before P4c provider-start implementation.
**Release status:** non-release. P2 Windows arbitrary-reparse live evidence remains an independent release blocker.

## 1. Purpose and bounded claim

The next goal is one narrow, real Chat Core reference pipeline. Its P3.5 storage prerequisite includes both artifact capacity and `path-lock` malformed-lock recovery from `design/68`; P4c may not bypass a stuck durable owner by adding a local cleanup path.

The pipeline is:

```text
fresh GameBuddy-owned root
  -> one exact mounted Chat
  -> browser submit
  -> durable accepted_queued
  -> exactly one durable attempt claim
  -> one runtime-bound provider-start observation
  -> durable typed companion presentation and terminal read-back
  -> authoritative browser state
  -> reload/restart recovery of the same result
```

This card does not implement provider start, presentation, cancellation, SSE, HTTP submit, or Tavern management. It removes two concrete prerequisites found in the quality audit so later stages do not build on an extension-hostile P3 decoder or a durable transcript that becomes unreadable at normal contract limits.

## 2. Audit disposition

### 2.1 Accepted: P3 browser decoder rejects compatible future snapshots

`dialogue-web/src/p3-browser-api.ts` currently rejects a response when any of these current P3 facts changes:

- `operations` is not exactly `[]`;
- navigation is not exactly the one Chat item;
- `chat.turn` or `chat.worldInfo` is non-null;
- Memory availability/revision differs from P3's absent projection;
- `eventStream` is non-null.

Those are negative capability assertions, not validation of data that the P3 UI consumes. A later additive, safe, version-compatible projection can therefore make the old browser fail reconciliation before it can ignore fields it does not render.

**Disposition:** accepted. This is a decoder compatibility defect, not permission to infer or surface an unknown operation.

### 2.2 Accepted: `ChatThreadStore` cannot represent its declared transcript envelope

`ChatThreadStore` persists `messages.json`, `transaction.json`, ledger, idempotency, draft, and thread artifacts through `readStrictJsonFile()`. That reader has one global 65,536-byte ceiling. The same Chat contract permits up to 500 transcript messages and up to 16,384 UTF-8 bytes of player text; the persisted message reader itself has no count cap. Consequently, normal durable growth can exceed the reader budget, after which reopen and recovery fail rather than returning a bounded state or an explicit capacity result.

**Disposition:** accepted. The problem is a missing artifact-capacity contract. It is not evidence that P4 must be replaced by a general distributed Saga or that the semantic coordinator must be flattened.

### 2.3 Not accepted into this pipeline

The audit's broad proposals to replace the Chat journal with an unspecified native SQLite transaction system and to flatten continuity-semantic modules are not accepted by this card:

- P4 now has one `ChatThreadStore` owner for transcript, draft, ledger, idempotency, journal and recovery. A general repository rewrite would reopen the P4a/P4b authority proof without a demonstrated Chat Core behavioral defect.
- No concrete compiling pre-admission/raw-store bypass or Chat Core correctness failure is supplied for a coordinator flattening. Existing private bridge and opaque-admission closure remain required.

These may be separately proposed only with a bounded measured problem, an owner-preserving migration-free design, and independent review. They are not prerequisites to the reference pipeline.

## 3. Required implementation order

The sole writer implements and verifies the following serially. No P4c code starts until both A and B pass.

### A. Additive P3 snapshot decoder

1. Keep exact P3 protocol identity checks: `apiVersion: 1`, `browserContract: "tavern_browser_api/v1"`, and `profileId: "gamebuddy.chat-core.p3"`.
2. Validate every field that the P3 renderer actually reads: exact selection shape, exact chat companion/title/transcript/draft shape, and each P3 message's safe scalar fields.
3. Treat `operations`, `navigation`, `turn`, `worldInfo`, `memory`, and `eventStream` as unrendered projection data. If present, validate only their container type where needed to prevent a malformed value from corrupting the P3 core; do not require P3-era exact values and do not render or infer any capability from them.
4. Do not add a fallback profile ID, downgraded API version, route alias, capability inference, or P3 UI controls.
5. Update browser/Host fixture tests to prove a snapshot containing additive safe operation/world-info/event data still renders the exact transcript and draft, while malformed required P3 fields, wrong contract identity, and wrong profile remain safe reconciliation failures.

### B. Bounded ChatThread artifact and lock-recovery contract

1. Keep the generic strict reader's UTF-8, duplicate decoded-key, stable-file identity, reparse, and fail-closed semantics. Do not replace it with an unbounded `readFile + JSON.parse` path.
2. Give `readStrictJsonFile` an explicit caller-selected maximum byte budget with a conservative default retained for small configuration files. A caller cannot request an unbounded read.
3. Define `ChatThreadStore` artifact budgets as named constants and enforce them both before write and before parse. The initial frozen JSON-encoded budgets are: `thread.json` 64 KiB, `draft.json` 32 KiB, `turn-ledger.json` 16 KiB, `idempotency.json` 1 MiB, `messages.json` 20 MiB, and prepared `transaction.json` 21 MiB. The message/journal budgets cover at most **500 total persisted transcript entries**, including a greeting/opening when present, each constrained to NFC, no C0/C1 controls, and at most 16,384 UTF-8 bytes, including JSON escaping and bounded metadata. No caller may request an unlimited budget.
4. Add a store-level maximum of 500 total transcript entries, including an opening. All append/accept/response paths must reject the next append with the stable `chat_thread_capacity_exceeded` failure before any journal/draft/idempotency mutation. Recovery rejects malformed or over-budget artifacts before repair writes.
5. Make all persisted normal message text use the same NFC, control-character, and UTF-8 byte policy as P4 player input. Response/opening paths may not retain a looser character-count-only rule.
6. Keep P3's initial full-snapshot ceiling at the same 500 total entries, including an opening. It must either project the complete bounded transcript or return a stable unavailable/problem state; it must never silently truncate. The 64 KiB HTTP JSON-body default limits **incoming requests only**. Bootstrap/state responses have a separately enforced 21 MiB JSON-encoded maximum, sufficient for the frozen complete-snapshot envelope but still finite. A larger transcript or response feature requires a separately versioned page/cursor contract before store or response limits change.
7. Add tests for: a legal near-limit persisted/reopened state; exactly 500 total entries both with and without an opening; 501st append/accept rejection with zero mutation; every named artifact budget's boundary; over-budget `messages.json` and `transaction.json` rejection with byte-for-byte no-repair behavior; a P3 state at the declared maximum; and an over-budget bootstrap/state response safe failure.
8. Repair shared `path-lock` exclusively under `design/70` and `design/72`: a fresh malformed/zero-byte lock remains a barrier; only the fixed opaque Windows handle-bound reclaim capability may delete a stale candidate after a trusted drive-root no-follow ancestor-handle chain and same-leaf-HANDLE proof; the native helper itself revalidates valid-owner PID death; any unavailable capability, non-Windows runtime, ancestor/leaf link or reparse, mutation, path substitution, liveness ambiguity, or identity mismatch fails closed. Prove the exact ChatThread mutation route recovers only through the emitted helper and never performs its own lock cleanup or pathname delete.

## 4. P4c admission criteria

P4c may be designed only after this card passes its focused tests, Host typecheck/build-test, P3 browser typecheck/Playwright coverage, the Windows handle-bound emitted-helper trusted-root/liveness live gate from `design/70` and `design/72`, `git diff --check`, and one independent read-only review. The P3.5 checkpoint covers one mounted Chat only. Before the wider P3 phase may be called complete or release evidence may rely on it, its decoder/projection must additionally handle the already-specified `selection: null` / `chat: null` truthful empty state; this card does not silently weaken that obligation.

P4c owns only:

```text
attempt_starting generation 1
  -> source-owned provider-start observation
  -> running | provably_not_started | uncertain
```

It must define, before calling the embedded session:

- the durable write/read-back order for every provider-start crash boundary;
- how a provable pre-effect refusal differs from an effect that may have escaped;
- how `attempt_starting`, `running`, and uncertain attempts reopen without automatic duplicate prompt;
- the private runtime-owned consumer of P4b's one-shot invocation admission;
- zero `DialogueController` turn authority, no browser/HTTP/SSE/presentation/cancel scope expansion, and no Host prompt assembly or Memory-store access.

P4c does not itself close the reference pipeline. P5, the minimum authoritative state delivery/recovery slice, and the production live gate remain necessary.

## 5. Explicitly deferred issues

The following become tracked follow-up work rather than reference-pipeline scope unless a direct blocker is demonstrated:

- Tavern management P9 capabilities, including character/chat management, artifacts, World Info management, import/export, settings, credentials, and player-visible Memory management;
- complete SSE replay/concurrency polish beyond the minimum authoritative-state recovery necessary for the reference pipeline;
- broad continuity-semantic structural simplification;
- unrelated EventPump, card-import, direct-file WorldBook-adapter retirement, voice, Stardew, IPC, and Windows helper findings in the audit. `path-lock` malformed-lock recovery is explicitly in scope through design/68.

The P2 Windows reparse live-evidence gate remains a release blocker, not a reason to expand this functional card.

## 6. Required evidence and completion wording

Passing this card permits only:

```text
Chat Core audit remediation complete; P4c provider-start design may begin.
```

It does not permit `chat_core_reference_pipeline_v1 complete`, `chat_core_v1 released`, or any Tavern-management claim.
