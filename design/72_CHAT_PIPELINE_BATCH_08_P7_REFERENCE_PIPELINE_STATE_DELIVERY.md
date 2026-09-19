# Chat Pipeline Batch 08 — P7 Reference-Pipeline State Delivery and Reload/Restart Recovery Boundary

**Status:** frozen reference-pipeline boundary (read-only authoring lane; no production source/test file was modified to produce this card)
**Parent:** `design/40_CHAT_PIPELINE_RELEASE_ENGINEERING_IMPLEMENTATION_PLAN.md` §4.1a, §5.1 (ChatPipelineService), §6.2/§6.4/§6.7/§6.8, §7.2/§7.5, P7, P10 reference-pipeline predicate
**Predecessors:** P3 exact snapshot/bootstrap/draft and static-shell composition (`design/46`–`48`), P4a durable acceptance (`design/49`–`65`), P4b durable attempt claim (`design/66`), P3.5 storage gate (`design/67`/`68`/`70`/`72`), P4c provider-start observation (`design/69`), P5 runtime-owned presentation admission/commit/terminalization (frozen prerequisite — §13)
**Release status:** non-release foundation. P2 Windows arbitrary-reparse live evidence remains a separate release blocker.

## 1. Truthful result

For one genuine currently mounted exact Chat whose turn pipeline has passed P5 (durable typed companion presentation, `presentation_committed`, terminal `completed`/`failed` read-back), the shipped browser can, **without SSE**:

1. submit one player message and receive a `202` accepted representation whose message/turn are durable read-back facts, rendered **only** from that committed representation;
2. observe the turn and companion bubble through bounded `GET /state` polls, each an authoritative full snapshot of the sole `ChatThreadStore` owner, until a durable terminal state read-back;
3. recover the same result across **page reload** (cookie-authenticated `GET /state` + `GET /draft`, no new bootstrap, no optimistic resubmit) and across **Host restart** (fresh one-time bootstrap, re-read of the same durable transcript/presentation/terminal state, no duplicate message, no greeting replay, no new Chat);
4. recover an uncertain submit through the frozen `message-submission-status` route, whose dispositions are exactly `unknown | pending | accepted | terminal | expired`, with browser `sessionStorage` as retry bookkeeping only.

The demonstrated reference-pipeline assertion:

> Given a genuine mounted lease, a browser session, and a P5-capable turn pipeline, when the browser submits one message and the provider pipeline durably commits a presentation and a terminal state, then every browser-visible message bubble, turn state and terminal outcome is read back from a durable owner (`202` committed representation, `/state`, or `message-submission-status`), never from local inference; a reload or Host restart re-reads the identical result; and no request ever targets a Chat, generation, or turn other than the exact mounted identity the browser bound at bootstrap.

## 2. The one delivery decision: bounded polling / state fetch, not SSE

**Decision.** The reference pipeline freezes **bounded polling of `GET /state` plus the `202` committed representation and the `message-submission-status` route**. It does **not** mount `GET /api/tavern/v1/events`, does not instantiate `EventSource`, and keeps `eventStream: null` in every snapshot. Full P7 SSE (per-process stream epoch, bounded in-memory replay window, `stream.resync_required`, native EventSource `Last-Event-ID` reconnect precedence, generation-race journeys) remains Chat Core scope and is deliberately deferred here.

**Why this is sufficient for the reference pipeline.**

- `design/40` invariant 12: *"Snapshot + owning durable stores can reconstruct the whole UI without an SSE connection."* Invariant 11: SSE is *"a live, duplicate-tolerant projection, never persistence or completion authority"*.
- `design/40` §6.4: `GET /state` *"is the only authoritative full refresh"* and is the exact recovery surface named for bootstrap, restart, stream gap and selection change. A poll is therefore not a degraded substitute for an event; it is the authoritative channel.
- `design/40` §4.1a permits deferring *"non-blocking SSE ergonomics only when they do not weaken the authoritative state/recovery proof"*. Polling full authoritative snapshots does not weaken that proof: every poll is a complete atomic snapshot, so a missed poll cannot lose an ordering fact (there is no ordering to miss).
- `design/47` §4 froze `eventStream: null` to mean *no event-stream capability is mounted*, and reserved a non-null `{epoch, cursor}` for P7's *real replay authority*. The reference pipeline does not fabricate that authority.
- `design/67` §5 explicitly defers *"complete SSE replay/concurrency polish beyond the minimum authoritative-state recovery necessary for the reference pipeline"*. This card implements exactly that minimum.
- `design/40` P10 reference-pipeline predicate requires only: *"the minimum P7 state delivery/recovery implementation provides a browser-authoritative state after submit and reload/restart, without claiming unsupported cross-process replay."* Polling satisfies it and claims nothing about replay.

**What polling is forbidden from being.** Polling never infers state. It never renders a message, turn transition, or terminal outcome that was not present in a validated snapshot or committed representation. It never derives success from elapsed time or from the number of polls. It is bounded in frequency (§9) and stops on the frozen conditions (§9.3). It never issues a mutation.

**Consequence for the mounted profile.** The `events` route stays outside the reference-pipeline profile's `routeIds` (absent operation is absent from UI, `design/40` §3.1/§4.4); a direct `/events` request returns `404 profile_operation_unavailable`.

## 3. Frozen boundary claims

### C1 — Authoritative state delivery

Exactly three delivery surfaces may change browser-visible state, and all three are durable read-back surfaces owned by the sole `ChatThreadStore` owner:

1. **`202 SubmitMessageResultV1`** — the committed player message + projected turn, returned strictly after durable acceptance read-back and strictly before the provider attempt starts (`design/40` §7.2 ordering). Emitted only by `ChatPipelineService.submitMessage`.
2. **`GET /api/tavern/v1/state`** — the authoritative full snapshot (`design/40` §6.4), used at bootstrap, reload, and polling. The snapshot now includes `chat.turn` projected from the durable TurnLedger (§7) and `operations` projected from the mounted profile plus the same ledger (§8). `eventStream` remains `null`.
3. **`POST /api/tavern/v1/message-submission-status`** — durable idempotency/ledger read-back keyed by the exact browser key, with dispositions and `committedResult` per `design/40` §6.7.

No other path (local state, timers, storage, another route, a second tab's UI) may change browser-visible Chat state. Every snapshot render is an **atomic replace** of the previous projection after full contract and identity validation; there is no partial or merged render.

### C2 — No optimistic submit

- The player bubble is rendered **only** from the `202` response's `message` field or from `message-submission-status` `committedResult`. The browser never inserts the typed text as a message before the `202`, never echoes it after a failure, and never fabricates a companion bubble.
- The composer is disabled at click time (a UI fact, not a data fact), stays disabled while a pending key or a non-terminal turn exists, and is re-enabled only from a validated snapshot showing `turn: null` and no pending bookkeeping.
- On an uncertain send (network error, timeout, lost response), the browser never generates a new key; it retains the pending key and reconciles through the status route (§6).
- `sessionStorage` holds only a **non-content binding** (`design/40` §6.7): `{ idempotencyKey, selectionGeneration, stateRevision, expectedDraftRevision }`. Player text never enters browser storage. `sessionStorage` is retry bookkeeping, never acceptance authority.

### C3 — Mounted exact identity

- At bootstrap (or first cookie-authenticated state read), the browser binds the **mounted identity fingerprint** from the validated snapshot: `build.profileId`, `selection.chatHandle`, `selection.generation`, `selection.stateRevision`.
- Every subsequent `/state` poll, `/draft` read and status query is accepted only if the fingerprint matches exactly. Any mismatch → the browser enters the `state_reconciliation_required` problem state, stops all polling and submit, clears nothing, and never adopts the mismatched projection.
- Re-binding to a new fingerprint happens **only** through a fresh one-time bootstrap (new Host-minted session). A refresh from a missing/invalid cookie never mints authority (`design/40` §9.1).
- Every submit carries `selectionGeneration` from the mounted snapshot; the Host revalidates it against the exact mounted binding through the existing P4a admission chain. No browser field selects a thread, surface, generation, or turn (`design/40` invariant 13/14).
- The reference pipeline freezes the single-interactive-session model (`design/40` P7 item 5, minimum): Host-side linearization (one non-terminal turn CAS per exact Chat, idempotency CAS, generation validation) already makes concurrent different-key submits have exactly one winner and wrong-generation mutations fail. The explicit two-tab stale-projection journeys and resync UX remain full-P7 Chat Core scope; this deferral does not weaken identity validation, which is Host-enforced on every mutation.

### C4 — Reload/restart recovery

| Event | Browser action | Required outcome |
|---|---|---|
| Page reload, same Host process, session cookie valid | No bootstrap. `GET /state` + `GET /draft` with the cookie; validate identity against `sessionStorage` fingerprint when present; cross-check draft revision/presence against the snapshot (P3 rule); then run the pending-key reconciliation (§6) | Same transcript, same turn, same terminal result; composer enabled only when `turn: null` and no pending key |
| Page reload, cookie missing/expired, no `#boot=` fragment | `401` → explicit "session expired — relaunch GameBuddy" problem; no retry, no self-minted bootstrap | No new authority from a missing cookie (`design/40` §9.1) |
| Host process restart | Launcher opens the browser with a fresh one-time fragment; new session minted; re-bind fingerprint; `GET /state` re-reads the same manifest generation, exact active Chat authority and durable records | Identical terminal result; no duplicate player message; no greeting replay; no new Chat (`design/40` §7.5) |
| Restart with the old tab still alive | Old cookie is invalid (session is Host-memory) → `401` → relaunch problem; a surviving `sessionStorage` pending key is reconciled through the status route **after** the fresh bootstrap, because the durable idempotency record is scoped to the exact (principal, route, Chat binding, generation) and survives restart | `accepted`/`terminal` returns the committed result; no double submit |

Restart recovery never fabricates a turn classification: the browser projects exactly the durable ledger facts present after reopen (P4c classifications and P5 terminalization are consumed, not re-derived). An `uncertain` mid-flight turn remains `queued`/blocked until the existing owner-death/reopen adjudication boundary (see §13) yields a durable terminal fact; the browser never invents one.

## 4. Frozen mounted profile

The reference pipeline replaces the P3 profile in production composition in the same artifact generation as the first P5-complete journey (`design/40` §13: one artifact generation, one mounted profile; P3's profile remains valid only for P3-era tests/diagnostics, never co-mounted):

```ts
composeTavernProfile({
  profileId: "gamebuddy.chat-core.reference-pipeline",
  releaseTier: "chat_core",
  routeIds: ["bootstrap", "state.read", "draft.read", "chat.submit", "chat.submission_status"],
  operationIds: ["chat.submit"],
  navigationItemIds: ["chat"],
})
```

Route ownership is closed (`design/40` §5.1):

| Route family | Owner |
|---|---|
| static shell/assets | artifact/static server (unchanged, `design/48`) |
| bootstrap | browser-session composer, then `ChatPipelineService.readState()` |
| `state.read`, `draft.read`, `chat.submit`, `chat.submission_status` | `ChatPipelineService` (reference-pipeline slice, §5) |
| `draft.save`, `draft.discard`, `chat.cancel`, `events` | unmounted in this profile; direct requests → `404 profile_operation_unavailable` |

The browser wire surface used by the reference pipeline is exactly the frozen `design/40` §6.2 registry entries `bootstrap`, `state.read`, `draft.read`, `chat.submit`, `chat.submission_status` with their existing request/response/header contracts (`x-csrf-token`, `Idempotency-Key`, 202, `application/problem+json` codes). **No new API is invented.** Explicitly unused: `PUT`/`DELETE /draft`, `POST /turns/:turnHandle/cancel`, `GET /events`, `If-None-Match`/ETag (optional per contract; the reference pipeline polls full `no-store` snapshots), `memoryDelegation`, non-null `eventStream`.

## 5. Host seams

One connected authority/composition chain; the sole durable writer remains `ChatThreadStore` (`design/40` §5.1, `design/68`). No second repository, event log, or browser authority is created.

1. **`host/src/tavern/reference-pipeline-state.ts` + focused tests** — new exact-state facade sibling to `p3-exact-chat-state.ts` (reuses its binding/read/lease-projection helpers and the `isCurrentMountedChatRuntimeLease` guard). Adds to the P3 projection:
   - `turn: BrowserTurnV1 | null` via the frozen mapping (§7);
   - the `202` message projection for the accepted player message (same `projectMessageHandle` seam);
   - `operations` projection from the mounted profile + the same durable ledger (§8).
   The P3 facade/`turn: null` behavior is unchanged for P3-era tests/diagnostics.
2. **`host/src/tavern/chat-pipeline-service.ts` + focused tests** — the `design/40` §5.1 deep module, reference-pipeline slice: `readState()`, `readDraft()`, `submitMessage(command)`, `readMessageSubmissionStatus(query)`, `close()`. It composes the reference-pipeline state facade, the existing P4a acceptance facade (`p4-durable-turn-acceptance.ts`), the P4b claim + P4c/P5 provider chain (consumed, not redefined), and the store's durable idempotency/ledger read-back (via `ChatThreadState.turnLedger` + `ChatThreadState.idempotency`). It never exposes stores, SQLite, paths, Pi sessions, source markers, continuity IDs, receipts, or raw provider data. It owns the asynchronous attempt-chain trigger that runs **after** the `202` has been emitted (§7.2 ordering) and drains it in `close()`.
3. **`host/src/tavern/chat-thread-store.ts`** — no new durable schema. The card only consumes the frozen P4a/P4b/P4c/P5 ledger states and the frozen `idempotency` records. The status seam maps durable facts to dispositions: no record for (key, exact binding) → `unknown`; record present, ledger turn not terminal → `accepted` (with `committedResult`); ledger turn terminal → `terminal` (with `committedResult`). P4a froze no retention expiry; therefore the reference pipeline never emits `expired` (the disposition is handled if a later owner adds expiry).
4. **`host/src/dialogue-web.ts` + tests** — add the two routes `POST /api/tavern/v1/messages` (202) and `POST /api/tavern/v1/message-submission-status` (200), gated by the mounted profile's `routeIds`/`operationIds`; every domain route maps to exactly one `ChatPipelineService` operation; `dialogue-web.ts` imports no domain repository/store (`design/40` §5.1).
5. **`host/src/dialogue-web-main.ts`** — compose the reference-pipeline profile + service (replaces the P3 profile/`p3Facade` production wiring).
6. **`host/src/continuity-semantic-production-coordinator/…internal.ts` + tests** — the mounted lease projection gains one new opaque handle domain `turn` (`projectTurnHandle(turnId)`), minted from the same per-lease secret and construction as `design/47` §2 (`base64url(HMAC-SHA-256(secret, "turn" + "\0" + exact binding fields + "\0" + turnId))`); same no-cross-restart-stability rule; never a storage ID or retrieval capability.

## 6. Frozen browser submission/recovery state machine

Browser files (§10 of `design/40` file plan): `dialogue-web/src/api/v1.ts` (client + validators mirroring the frozen contract shapes; the sole browser DTO authority for the reference pipeline; no Host imports), `dialogue-web/src/state/tavern-reducer.ts` (identity-bound session: `createReferencePipelineSession(initialSnapshot)`, `applySnapshot(next)` with fingerprint validation and atomic replace, pending-key bookkeeping helpers), `dialogue-web/src/main.tsx` (composer, turn banner, poll loop, reload path; no DTO definitions).

**Submit path (frozen order):**

```text
validated snapshot shows operation chat.submit available and turn == null and no pending key
  → write sessionStorage non-content binding { key, selectionGeneration, stateRevision, expectedDraftRevision }
  → disable composer
  → POST /messages { apiVersion, selectionGeneration, text, locale: "en", expectedDraftRevision } + x-csrf-token + Idempotency-Key
  → 202 accepted/duplicate: render message + turn from the committed representation only; start bounded polling (§9)
  → 409 turn_busy: render problem; composer stays disabled until a validated snapshot shows turn == null
  → 409 idempotency_conflict / 410 idempotency_expired: clear bookkeeping; explicit player resubmission (new key)
  → 409 idempotency_in_progress: treat as pending; reconcile through the status route after the in-flight request settles
  → network error / timeout / 5xx: keep the pending key; reconcile through the status route
```

**Recovery path (frozen dispositions, `design/40` §6.7):**

| Status route disposition | Browser action |
|---|---|
| `unknown` | Re-read `/draft` (already done on reload); if the durable draft revision still equals the stored `expectedDraftRevision`, re-enable the composer with the **same key** (same text, locale, draft revision ⇒ same fingerprint ⇒ accepted at most once). If a same-key retry returns `409 idempotency_conflict`, abandon the old key (clear bookkeeping) and require explicit player resubmission with a new key. |
| `pending` | Keep bookkeeping; composer stays disabled; resume/continue bounded polling until a validated snapshot shows a terminal turn or `turn: null`. |
| `accepted` | Render `committedResult.message` + `committedResult.turn`; start bounded polling from that turn; clear bookkeeping only at terminal read-back. |
| `terminal` | Render `committedResult`; clear bookkeeping. |
| `expired` | Clear bookkeeping; never re-execute the old command; explicit player resubmission with a new key. |

Bookkeeping is cleared **only** by durable terminal read-back, an explicit `expired` disposition, or an explicit conflict abandonment (`design/40` §6.7). A status result `accepted`/`pending` combined with a `/state` snapshot showing `turn: null` is an inconsistency → `state_reconciliation_required`, fail closed.

## 7. Frozen turn projection (durable TurnLedger → BrowserTurnV1)

The reference-pipeline `/state` and the `202`/`committedResult` project the sole ledger through one mapping; every transition is read back before projection (`design/40` §7.3). `projectionRevision` is the literal `1` (browser-projection fact, not a durable claim — the P3 `revision: 1` precedent from `design/46`); full P7 may assign per-transition values when SSE event dedupe has a consumer. `canCancel` is always `false` in this profile (no cancel operation mounted). `problemCode` is projected only from P5/P6's durable terminal classification (interrupted → `interrupted`; terminal `failed` without committed presentation → `no_visible_presentation`; storage/runtime causes → `storage_unavailable`/`runtime_unavailable`); absent otherwise.

| Durable ledger state (sole `ChatThreadStore` owner) | Projected `BrowserTurnV1.state` |
|---|---|
| (no ledger) | `turn: null` |
| `accepted_queued` | `queued` |
| `attempt_starting` (with or without `observation`) | `queued` (provider start not yet durably observed) |
| `running` (P4c `observation: running`) | `running` |
| `presentation_committed` (P5) | `response_visible` |
| `cancel_claimed` (P6) | `stopping` |
| `completed` (P5 terminal) | `completed` |
| `failed` | `failed` |
| `cancelled` (P6) | `cancelled` |

## 8. Frozen operations projection

`TavernStateSnapshotV1.operations` is projected from the mounted profile plus the same durable ledger read-back, never from browser input or a runtime flag:

- `chat.submit` availability: `available` ⇔ ledger `turnLedger === null`; `busy` ⇔ any non-terminal turn exists; `unavailable` ⇔ the facade's exact-state read failed (problem response, no snapshot).
- The composer renders an enabled submit control **only** when the snapshot contains the mounted `chat.submit` operation entry with `availability: "available"` (absent operation ⇒ absent control; `design/40` §3.1/§4.4).

## 9. Frozen bounded polling schedule

1. **Start conditions:** after a `202` whose turn is non-terminal; after a reload whose validated snapshot shows a non-terminal turn; after status `pending`/`accepted` with a non-terminal turn. There is **no polling before the first submit**; a never-submitting session issues exactly the bootstrap/reload reads.
2. **Requests:** `GET /state` only (with the session cookie; no CSRF, no query, no body). Never `GET /draft` in the loop. At most one poll in flight. Polls are read-only and idempotent; a missed poll is harmless because every poll is a full snapshot.
3. **Schedule:** first poll at 250 ms after the triggering read; steady interval 1 s; on network error or retryable problem (`storage_unavailable`, `runtime_unavailable`) bounded exponential backoff 1 s → 2 s → 4 s, capped at 5 s, reset to 1 s on the next successful poll. `document.hidden` pauses timers; `visibilitychange` to visible performs one immediate `/state` read then resumes. No hard poll count; termination is by stop conditions, not by budget.
4. **Stop conditions:** validated snapshot shows a terminal turn (`completed`/`cancelled`/`failed`) or `turn: null`; identity fingerprint mismatch; `401` (session expired → relaunch problem); `404 profile_operation_unavailable` (profile mismatch → problem); a new submit begins (polling pauses until its `202`). Non-retryable problems stop permanently; retryable problems back off and continue.
5. **Render rule:** each poll validates the full snapshot against the frozen contract shapes and the identity fingerprint, then atomically replaces the projection. No diffing, no delta inference, no local merge.

## 10. Acceptance tests

### A. Host contract (focused; real temporary durable thread/draft, scripted provider adapter for deterministic P5 mechanics)

1. `202` accepted representation passes `SubmitResultV1Schema`; message handle is a lease-projected opaque handle; turn is `queued`; a subsequent `/state` read-back shows the player message and `turn` from the ledger; the exact draft is cleared when `expectedDraftRevision` matched; **no provider call occurs before the `202` completes** (fake provider counts requests).
2. Same-key replay returns the same `202` `duplicate` representation; zero second append, zero draft mutation.
3. Concurrent/different key while a non-terminal turn exists → `409 turn_busy` with zero mutation (no append, no draft clear, no idempotency record).
4. `message-submission-status`: unknown (never-accepted key) / accepted (durable, non-terminal) / terminal (after P5 completion) with `committedResult`; foreign key or foreign generation → `unknown` (non-disclosing).
5. Wrong `selectionGeneration` submit/status → fail closed (`selection_conflict` / non-disclosing).
6. `/state` turn projection: every row of the §7 table is read back exactly; `turn: null` when the ledger is empty; a fresh store reopen sees the identical projection.
7. Restart: close and reopen the store (new process) → identical terminal result; status returns `terminal` with the same `committedResult`; no duplicate message.
8. Profile gate: the reference-pipeline profile mounts exactly the five route IDs; the P3 profile still answers `404 profile_operation_unavailable` for `chat.submit`/`chat.submission_status`; `events`/`cancel`/draft-mutation routes are unmounted in both.
9. Privacy negatives: no transcript/draft text, provider bytes, session/CSRF tokens, or raw IDs in problem bodies or test logs (`design/40` §9.3).

### B. Browser (Playwright against the real composed listener + shipped build; no `page.route()` mocks; synthetic SFW thread; scripted provider adapter)

1. **No optimistic submit:** with a delayed scripted provider, the player bubble is absent during flight and appears only from the `202` committed representation; a failed send leaves no bubble.
2. **Poll progression:** `queued → running → response_visible → completed` are observed through `/state` polls; the companion bubble appears only from a snapshot containing the durably committed message.
3. **Poll stop:** after terminal read-back, no further `/state` requests (network log assertion with a margin).
4. **No SSE:** no `EventSource` is ever instantiated, no `/events` request occurs, and every captured snapshot has `eventStream: null`.
5. **Reload mid-turn:** `sessionStorage` pending key → reload → status `pending` → composer blocked → polling resumes → terminal renders → bookkeeping cleared.
6. **Reload after terminal:** cookie-authenticated `/state` + `/draft` render the identical transcript/terminal state; no new bootstrap request; composer re-enabled.
7. **Restart recovery:** Host process stopped and restarted, fresh bootstrap fragment → same terminal result rendered; no duplicate player message; no greeting replay; no new Chat; a surviving pending key reconciles to `terminal` through the status route under the new session.
8. **Identity fail-closed:** a tampered snapshot (different `chatHandle` / `generation` / `stateRevision`) → problem state, polling stops, no adoption.
9. **Session expiry:** invalidated cookie → `401` → explicit relaunch problem; refresh never mints a new authority.
10. **Unknown retry:** lost response before durable acceptance → reload → status `unknown` → same-key retry after draft read → accepted exactly once; a same-key retry whose payload changed → `409` → bookkeeping cleared → explicit resubmission with a new key.

### C. Process (production artifact)

- One serialized process journey on a fresh GameBuddy-owned root: mount → submit → scripted provider → presentation → terminal → reload → restart → identical result; combined with the A7 store-reopen and B7 browser journeys.

## 11. Verification order

1. Focused store-consumption/service tests (status seam, turn projection, operations projection) and Host typecheck.
2. `dialogue-web.ts` route tests (submit/status/profile gate) against a real temporary durable thread.
3. Browser unit tests (reducer identity validation, bookkeeping transitions) and `dialogue-web` typecheck/build through the existing verified production builder path.
4. Real-browser Playwright journeys (B1–B10) on the composed listener with the scripted provider adapter.
5. Production artifact build/recheck and the process journey (C).
6. `git diff --check` and one fresh independent read-only review of the actual diff and evidence. A review cannot substitute for a failed/missing check.

## 12. Completion wording

Passing this card permits only:

```text
P7 reference-pipeline state delivery and reload/restart recovery boundary frozen and implemented on the P5-complete pipeline.
```

It does **not** permit `chat_core_reference_pipeline_v1 complete` (the fresh-root production journey, P3.5/P4c/P5 closure and remaining predicate items from `design/40` P10 are still required), `chat_core_v1 released`, any SSE/replay claim, any cancel/P6 or Tavern-management claim, or any release claim (P2 Windows arbitrary-reparse live evidence remains a blocker).

## 13. Hard gates and dependencies

- **P5 is a hard implementation precondition.** This card is authored in a read-only lane and may be implemented only after the P5 presentation-admission/commit/terminalization card is frozen and passes its own gate (the presentation binding `{turn, attemptGeneration, cancelEpoch, sourceEventId}`, `presentation_committed`, `completion_claimed`, terminal read-back). No P7-state-delivery code may start on a pipeline that cannot produce the durable presentation/terminal facts this card projects.
- The P3.5 storage gate (`design/67` B + `design/70` + `design/72`) and the P4c provider-start card (`design/69`) remain preconditions of the P4c/P5 chain this card consumes.
- The cross-process runtime-owner-death/reopen adjudicator (`design/40` §5.1 restart policy, `design/66` §3.3) remains a later card. Until it exists, a restart-recovered `uncertain` mid-flight turn projects only the durable `queued` fact and blocks; the reference-pipeline restart evidence is defined for the terminal case, and the browser never fabricates a classification.
- Retention expiry is not frozen by P4a; the reference pipeline therefore never emits `expired` (§5). If a later owner freezes a retention window, the status seam maps it without browser changes.

## 14. Stop conditions / next decision

Stop this card and return a new prerequisite if implementation requires:

1. mounting `events`/SSE or a non-null `eventStream` to satisfy the reference-pipeline acceptance (e.g., a demonstrated requirement that polling cannot meet — no such requirement exists in the bounded journey);
2. a second durable authority, a durable event log, or a change to the P4a/P4b/P4c/P5 admission/ledger mechanics;
3. cancel (P6), draft editing, Memory, Chat switch/list/create (P9), ETag/304 semantics, or a new browser wire surface absent from the frozen `tavern_browser_api/v1` registry;
4. any automatic re-prompt, generation 2, local success inference, or optimistic data render;
5. a release claim or a change to the P2 Windows reparse evidence requirement.
