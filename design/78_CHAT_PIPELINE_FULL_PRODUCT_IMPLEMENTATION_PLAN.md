# Chat Pipeline Full Product Implementation Plan

> **Status: Retired as execution authority.** This document records the evidence-first Chat pipeline direction and its completed bounded slices. It must not gate or prescribe current Chat/Memory implementation. `design/90_SIMPLIFIED_PI_BACKED_CHAT_PRODUCT_IMPLEMENTATION_PLAN.md` is the current execution authority: it retains ordinary application reliability and removes marker/nonce/receipt/attestation/fresh-root proof gates from the product path.
>
> **For agentic workers:** Do not execute the unchecked tasks below. Read them only as historical context.

**Goal:** Complete the GameBuddy Chat pipeline from durable provider-backed conversation through the already-adapted browser UI and the approved Tavern management lifecycle, ending in a fresh-root production release journey.

**Architecture:** Keep the fresh semantic SQLite authority and `ChatThreadStore` as the sole durable Chat writer. Build every capability as a connected micro-pipeline: browser contract/profile -> authenticated Host route -> exact domain service -> durable read-back -> safe projection -> frontend operation -> browser/process evidence. Chat and Game remain independent surfaces. Existing P3/P4/P5 and P7 same-Chat recovery work is the foundation; the default React `App` is migrated only when the corresponding real Host capability exists, and UI-only behavior is removed rather than retained as a fallback.

**Tech Stack:** TypeScript 5.9, Node `node:sqlite`, existing Host semantic coordinator/store, TypeBox browser contract, React/Vite, Playwright, Windows mounted Host/provider harness, immutable production artifact checks.

**Spec:** `design/40_CHAT_PIPELINE_RELEASE_ENGINEERING_IMPLEMENTATION_PLAN.md` §§5-10; `design/28_TAVERN_MANAGEMENT_CAPABILITY_MATRIX.md`; `design/75_CHAT_PIPELINE_REFERENCE_P7_STATE_DELIVERY_IMPLEMENTATION_PLAN.md`; `design/77_CHAT_SAME_SELECTION_SUCCESSOR_RECOVERY_IMPLEMENTATION_PLAN.md`.

## Global Constraints

- The fresh semantic SQLite authority is the only production Chat authority; no legacy import/adoption, fallback, read-repair, dual root, or hidden operator setup is allowed.
- `ChatThreadStore` remains the sole durable Chat writer; browser and frontend state are projections and never authority.
- Chat and Game are independent surfaces and may not select, close, pause, recover, or take over one another.
- Browser inputs never provide raw durable IDs, provider secrets, prompts, Pi/runtime identities, Game scope, or capability authority.
- Every mutation uses exact auth/scope/CSRF/idempotency/revision validation and proves a durable postcondition before UI success.
- Existing dirty baseline changes are preserved; do not reset, checkout, or overwrite unrelated user work.
- The reference profile remains bounded while its unsupported routes are absent. A route enters a mounted profile only with its producer, consumer, negative matrix, browser journey, and artifact closure.
- Real GameBuddy-owned Host/SDK/runtime roots are required for live evidence; system Pi installation, user Pi data, credentials, and legacy continuity roots are forbidden.
- No P9 management slice is called released until its own contract, Host route, durable read-back, frontend control, browser journey, and production artifact evidence pass.

## Current Baseline

### Closed evidence carried forward

- P3 exact active Chat bootstrap/state/draft and static shell composition.
- P4 durable acceptance, idempotency, accepted-before-provider ordering, status read-back and provider-attempt claim.
- P5 presentation admission, durable response commit, completion/cancel arbitration internals, terminalization and authority fail-closed tests.
- P7 reference five-route submit/status browser flow with no SSE/cancel.
- P7 same-Chat successor lifecycle: terminal teardown -> Host-owned same-selection `select_chat` bridge -> known-root successor mount.
- P7 process recovery evidence: two child processes, same root, same terminal status, successor generation `+1`, exact Chat identity, second provider start `0`.

### Known incomplete surface

- `dialogue-web/src/components/ReferenceApp.tsx` consumes the real five-route reference contract, but intentionally has no cancel, SSE, Memory mutation, or management drawers.
- `dialogue-web/src/components/App.tsx` still contains local/mock behavior for Chats, Characters, Persona, World Info, Memory, New Chat, export, and stop. Those controls are not production evidence and must not be treated as durable capability.
- `host/src/tavern/browser-contract/index.ts` declares draft, cancel, events, and Memory schema families, but the mounted reference profile intentionally excludes them.
- P6 authenticated Chat cancel, P7 live SSE/replay, P8 governed Memory/context management, and P9 Tavern management are not complete.
- The final P10 fresh-root journey, provider live charter, responsive/locale/a11y matrix, and immutable release tuple are not complete.

## Execution Policy

Each batch has one connected writer for shared producer/consumer/verifier seams, independent read-only scouts only for distinct questions, and one final review after the batch. A batch stops on an authority, lifecycle, product-contract, or live-gate blocker; it does not add fallback behavior to make a test pass. Every task ends with source checks, emitted focused checks, and a named acceptance scenario before the next batch.

## Batch Order

1. Chat Core P6 cancel and browser surface.
2. Chat Core P7 live SSE and authoritative reconnect.
3. Chat Core real provider settlement and fresh-root black-box journey.
4. P8 governed source/Memory read projection and mutation evidence.
5. P9 title/draft and Chat list/open/switch lifecycle.
6. P9 explicit New Chat with Persona/Scenario/Greeting.
7. P9 Character and inert import/export lifecycle.
8. P9 World Info lifecycle.
9. P9 player-visible Memory lifecycle.
10. P9 connection/provider/model/credential and preferences.
11. P10 cumulative fresh-root release closure.

Do not start a later batch merely because its UI already exists. The frontend is adapted presentation work, not proof of the Host capability.

---

### Task 1: Freeze the next-batch capability ledger

**Files:**
- Create: `design/78_CHAT_PIPELINE_FULL_PRODUCT_IMPLEMENTATION_PLAN.md`
- Modify: `design/40_CHAT_PIPELINE_RELEASE_ENGINEERING_IMPLEMENTATION_PLAN.md` only if a status pointer is needed after implementation review.
- Inspect: `dialogue-web/src/components/App.tsx`, `dialogue-web/src/components/ReferenceApp.tsx`, `host/src/tavern/browser-contract/index.ts`, current Host composition/tests.

**Produces:** A reviewed target/implemented/mounted/released matrix for the next batch, with existing frontend adapters classified as presentation-only until a real route exists.

- [x] Record the current P3/P4/P5/P7 evidence and incomplete lanes in this plan.
- [ ] After each completed batch, update the status table with exact commands and evidence paths; do not change a capability to `released` from a typecheck or mock browser test alone.

### Task 2: P6 durable cancel contract and service

**Frozen slice card:**

- **User-visible result:** a mounted Chat Core browser profile can cancel exactly one opaque-bound turn and read back the durable winner.
- **In scope:** additive P6 profile, authenticated `chat.cancel` route, cancel-specific durable idempotency, queued and active cancel CAS, exact turn/generation binding, P5 drain/terminal read-back, and focused Host evidence.
- **Explicit non-goals:** the frozen five-route reference profile, SSE, draft mutation, Memory, Chat switching, Game STOP, and provider/UI fallbacks.
- **Authority boundary:** `ChatThreadStore` remains the sole durable writer; the service receives only a coordinator-minted mounted cancel port and public opaque browser facts; no store, lease, interruption epoch, or transition token crosses the route boundary.
- **Acceptance scenario:** Given one accepted Chat turn, when an authenticated exact-bound cancel is submitted, then the durable cancel claim precedes provider/presentation drain and the response returns `cancelled`, `completion_won`, or `already_terminal` with exact terminal read-back. The same scenario must separately prove queued cancellation, active cancellation, duplicate-key replay, changed-payload conflict, foreign handle, wrong generation, completion-first, and zero mutation on rejection.
- **Scenario-batch boundary:** service, store/coordinator authority, profile/dispatcher, contract projection, and focused tests land together; if queued cancellation cannot be implemented without violating the existing pre-arm activation invariant, stop with a named owner decision instead of mounting an active-only route.
- **Cheapest checks:** store CAS tests after the durable transition seam; service tests after binding/idempotency; dispatcher contract tests after route wiring; emitted mounted suite and production boundary/artifact checks at batch end.
- **Mutation ownership:** one writer owns `host/src/tavern/chat-thread-store.ts`, `host/src/tavern/chat-pipeline-service.ts`, `host/src/tavern/reference-pipeline-state.ts`, `host/src/reference-pipeline-dialogue-web.ts`, `host/src/dialogue-web-main.ts`, the coordinator cancel facade, and their focused tests. Frontend changes wait for the Host DTO/profile to be frozen.

**Recon findings:** the five-route profile is exact and must remain unchanged; browser contract schemas for `chat.cancel` already exist; the private P5 STOP seam currently rejects `accepted_queued`/`attempt_starting`, has no cancel idempotency record, and resolves at `cancel_claimed` while P4c owns terminal `cancelled`. These are implementation requirements, not reasons to expose a partial route.

**Files:**
- Modify: `host/src/tavern/chat-thread-store.ts` only through the existing P5 cancel CAS ownership.
- Modify: `host/src/tavern/chat-pipeline-service.ts` to expose a narrow `cancelTurn()` returning a browser-safe `CancelTurnResultV1`.
- Modify: `host/src/tavern/browser-contract/index.ts` to use the existing exact cancel schemas and route metadata.
- Modify: `host/src/tavern/reference-pipeline-dialogue-web.ts` or a new management dispatcher selected by a revised profile; do not widen the five-route reference profile implicitly.
- Test: `host/src/tavern/chat-pipeline-service.test.ts`, `host/src/reference-pipeline-dialogue-web.test.ts`, and the selected contract test boundary.

**Interface:**

```ts
type ChatPipelineService = Readonly<{
  cancelTurn(
    turnHandle: string,
    command: CancelTurnCommandV1,
    idempotencyKey: string,
  ): Promise<CancelTurnResultV1>;
}>;
```

**Acceptance:** Given one accepted running turn, an authenticated exact-bound cancel writes the cancel epoch/claim before abort, drains the provider/presentation path, and returns terminal read-back. Repeated cancel is stable; cancel-first rejects a late presentation; completion-first remains completed; queued cancellation and active cancellation are separately proven; browser disconnect does not cancel.

- [x] Add characterization coverage proving the current ledger has no legal queued-cancel artifact and that rejected queued/attempt-starting cancel leaves the later P4c path unpoisoned.
- [ ] Obtain an owning-domain decision for queued cancel representation and cancel-specific durable idempotency before changing the P5 ledger schema. The current P6 HTTP route remains unmounted.
- [ ] Implement the service by consuming the existing private P5 cancel authority only after the queued-cancel and idempotency policy is frozen; do not export the store, lease, interruption epoch, or cancel token.
- [ ] Add a real response projection and explicit profile operation; keep the old reference profile unchanged until the profile replacement has its own browser contract.
- [ ] Run emitted cancel/store/presentation suites, production typecheck, import-boundary checker, and affected diff check.

### Task 3: P6 frontend cancel integration

**Files:**
- Modify: `dialogue-web/src/reference-pipeline-api.ts` and `dialogue-web/src/reference-pipeline-session.ts` only after Task 2's DTO/profile is frozen.
- Modify: `dialogue-web/src/components/ReferenceApp.tsx` to render cancel only when the snapshot operation is available and the turn is cancellable.
- Create/Modify: `dialogue-web/tests/reference-pipeline-cancel-browser.spec.ts` using a real composed listener, not `page.route()`.

**Acceptance:** A player can submit, see only durable projected turn state, cancel through the authenticated route, and observe terminal cancelled/completion-won read-back. Reload after cancel does not re-send or synthesize a message. No cancel control is shown in the bounded reference profile.

- [ ] Add reducer tests for cancel pending/terminal/reload identity behavior.
- [ ] Add API tests for exact method/path/headers/body and protocol rejection.
- [ ] Run Chromium cancel journey on a fresh GameBuddy-owned mounted root and confirm no SSE or optimistic transcript append.

### Task 4: P7 live SSE and snapshot reconnect

**Files:**
- Create/Modify: `host/src/tavern/chat-event-stream.ts` and its tests.
- Modify: `host/src/tavern/browser-contract/index.ts`, selected composed profile, and dispatcher.
- Modify: `dialogue-web/src/reference-pipeline-api.ts`, `dialogue-web/src/reference-pipeline-session.ts`, and `ReferenceApp.tsx`.
- Test: Host stream contract/race tests and `dialogue-web/tests/reference-pipeline-sse.spec.ts`.

**Interface:**

```ts
type ChatEventStream = Readonly<{
  subscribe(input: { epoch: string; after: number | null; generation: number }): AsyncIterable<BrowserEventV1>;
  close(): Promise<void>;
}>;
```

**Acceptance:** A real same-epoch disconnect replays committed events without loss; duplicate sequence is harmless; epoch change/gap emits `stream.resync_required`; browser atomically reads `/state`, rejects stale generation, and never treats SSE as durable authority. Multiple readers do not own lifecycle.

- [x] Freeze one composed reference profile with `events` before changing frontend EventSource code; P3 and management remain event-disabled.
- [x] Write Host event epoch/sequence/gap/restart, forged-cursor, concurrent-reader, and no-cross-generation tests.
- [x] Use native Chromium `EventSource` and real mounted listener behavior; the browser test proves same-epoch TCP-close replay is gapless and duplicate-free without treating SSE as durable state.
- [x] Run the immutable production browser suite and focused Host emitted stream/HTTP suites; production artifact and import-boundary checks are required for the bounded slice.
- [x] Add mounted-browser forced-gap recovery and stale-generation rejection; the mounted browser suite proves one authoritative `/state` recovery, state-cursor reconnect, no recovery loop, and a stale-generation frame rejected without UI mutation.
- [ ] Add mounted-browser epoch-change recovery for the app-managed recovery path. A real foreign-epoch cursor can only come from replacing/restarting the stream authority; the Host/HTTP epoch-resync contract is covered, but no in-process browser fixture may rotate the production stream without violating the bounded authority rules.
- [ ] Prove duplicate-sequence harmlessness at browser level for the same consumer. The reducer is idempotent, Host concurrent-reader/replay evidence is complete, and cross-consumer duplicate observation is legal; the current single-source topology cannot deliver the same frame twice to one app consumer without a test-only/architecture change, so this remains an explicit topology boundary rather than a release claim.
- [x] Prove a native Chromium retry carrying the HTTP `Last-Event-ID` header with an isolated passive native `EventSource` probe; app-managed recovery intentionally closes its failed source and resumes with the validated `cursor` query instead.
- [x] Run the production artifact checker and Host import-boundary checker for the current bounded P7 browser/recovery matrix.
- [ ] Repeat the production artifact/import-boundary checks after any remaining epoch-change evidence is closed; the duplicate same-consumer item is an explicit topology boundary under the current single-source design.

### Task 5: Real provider settlement and Chat Core black-box closure

**Files:**
- Modify only the existing P4c/P5 provider composition seam if a live finding requires it.
- Create/Modify: the existing Host process/browser harness for fresh-root provider settlement.
- Modify: `design/40` status records with the exact live evidence.

**Acceptance:** On a fresh root and immutable shipped artifact: durable submit -> one real embedded provider prompt -> typed presentation commit -> terminal status -> browser read-back; after clean Host restart the same terminal result is returned and `promptCalls === 1`. No Host prompt assembly or UI mock route is used.

- [ ] Run non-mutating provider preflight: selected GameBuddy-owned root, provider fixture/provenance, manifest/profile/artifact identity, cleanup path, and terminal postcondition read-back.
- [ ] Run one controlled live provider charter only after preflight and independent review.
- [ ] Record `succeeded`, evidence, and postcondition separately; ambiguous provider settlement remains failed/uncertain and blocks release.

### Task 6: P8 governed context and Memory read

**Files:**
- Modify: Host canonical manifest/context projection only through the owner-approved Magic Context facade.
- Create/Modify: `host/src/tavern/memory-management/*` and browser contract/profile.
- Modify: `ReferenceApp.tsx` only after a read route is real.

**Acceptance:** The browser can read a safe Memory capability/projection tied to the exact Chat without seeing prompts, SQLite, raw candidates, provider data, or internal IDs. Missing/uncertain Memory evidence remains unavailable. Host never assembles prompt messages or writes Magic Context SQLite.

- [x] Confirm owner-approved Magic Context read projection before adding a route: the locked Magic Context facade is the sole runtime ingress, loaded through the declared production external-runtime closure; Host has no direct SQLite, prompt assembly, or mutation path.
- [x] Write and run read-only projection, continuity mismatch, lease-revocation, storage failure, bounded-row, content-redaction, profile-injection, and idempotent-close evidence: fresh emitted Host Memory/management/contract suites pass `31/31`.
- [x] Mount the UI only when `readAvailable` and durable read-back are real: the fresh immutable `tavern_management` Chromium suite passes `3/3`, including a real `/memory` request from the mounted exact Chat and the safe empty projection. The Memory panel has no mutation controls.

**Released bounded slice:** `memory.read` is mounted only on `tavern_management` with exact lease/continuity binding, a fixed safe DTO label (never a content-derived title), `mutationAvailable: false`, strict same-origin session reads, and a profile route/navigation double-check. Dynamic Magic Context ingress is explicitly declared and checked by the production artifact boundary. P9 Memory mutation, raw/provenance display, prompt construction, and Task 13 fresh-root/provider release remain out of scope and incomplete.

### Task 7: P9 title/draft and Chat list/open/switch

**Files:**
- Modify/Create: `host/src/tavern/chat-management/*`, `host/src/tavern/browser-contract/index.ts`, selected dispatcher/profile.
- Modify: `dialogue-web/src/components/App.tsx` or replace it with a real profile shell; remove local `Date.now()` Chat/companion state for mounted operations.
- Test: Host contract tests, fresh-root browser list/open/switch journey, and failure/revision matrix.

**Acceptance:** A player lists exact safe Chat projections, opens one exact Chat, renames with revision CAS, saves/discards draft, and switches without transcript loss or guessed/latest selection. Failed mutation preserves the prior authoritative UI. No UI-only New Chat or export claims remain in the mounted profile.

- [ ] Freeze opaque browser DTOs and exact route/profile operation IDs.
- [x] Freeze opaque browser DTOs and exact route/profile operation IDs for the list + rename micro-pipeline (contract routes `chat.list`, `chat.rename`; profile `gamebuddy.tavern-management.chat-list-title`).
- [x] Connect the existing title/draft services to the dispatcher with auth/CSRF/revision/read-back for metadata list/title rename and draft save/discard.
- [x] Replace local Chat drawer mutations with API-backed reducer state; keep unsupported controls absent until their slices are mounted (management shell; P3/reference shells unchanged).
- [x] Run the real mounted-listener browser journey for the list + title + draft slice: fresh immutable English Chromium management journey `2/2` with save/reload/discard/reload durable read-back plus two-page stale title/draft conflict re-read; production artifact rebuilt after the Host/web contract changes.
- [x] Run the management journey in `zh-CN` and a narrow viewport: fresh immutable Chromium management journey `3/3` passes, including the English durable/stale-revision cases and a real `zh-CN` `375x667` mounted journey with translated chrome, durable draft/title read-back, no horizontal overflow, and unsupported controls absent.
- [ ] Extend the same real-listener journey for exact open/switch. Unsupported New Chat/select/export controls remain absent and are asserted by the current management journey.

### Task 8: P9 explicit New Chat with Persona/Scenario/Greeting

**Files:**
- Modify: `host/src/tavern/catalog-service.ts` only through exact catalog ownership.
- Modify/Create: `host/src/tavern/chat-creation/*`, browser contract and dispatcher.
- Modify: Characters/Persona/Scenario/Greeting UI components to consume read-back DTOs.
- Test: Durable message-zero, source revision, locale, failure and browser journey suites.

**Acceptance:** A player creates a new exact Chat from selected approved sources and one greeting/blank opening; message zero is durable exactly once; changing authored content never rewrites an existing Chat; rejected source/revision leaves the prior UI unchanged.

### Task 9: P9 Character and inert import/export

**Files:**
- Modify/Create: Host character lifecycle and reviewed interchange services.
- Modify: browser contract/profile and CharactersDrawer.
- Test: staged import disposition/loss report, safe export, script/regex/HTML/extension rejection, fresh browser journey.

**Acceptance:** Character browse/create/detail/reviewed inert card import/export is durable and player-readable. Unsupported content is reported as excluded and never executed or exported.

### Task 10: P9 World Info lifecycle

**Files:**
- Modify/Create: existing world-info management/binding services, browser contract/profile, dispatcher, WorldInfoDrawer.
- Test: exact-chat bind/unbind, revision conflict, locked state, export and recovery journey.

**Acceptance:** World Info catalog/edit/bind/unbind/export is exact-chat scoped, durable, conflict-safe and safe-projected. Existing chat content remains intact on failure.

### Task 11: P9 Memory mutation lifecycle

**Files:**
- Modify: owner-approved Memory facade only; no direct SQLite access from Host/browser.
- Modify: browser contract/profile, MemoryDrawer, reducer.
- Test: evidence-backed mutation, active-turn serialization, conflict/reopen and player-visible failure.

**Acceptance:** Memory mutation is available only with runtime-owned evidence; mutation/read-back/revision conflict is player-visible; absent or uncertain evidence remains unavailable.

### Task 12: P9 connection/model/credential and preferences

**Files:**
- Create/Modify: approved connection catalog, DPAPI CurrentUser credential adapter, Chat profile/preferences service.
- Modify: browser contract/profile, dispatcher, settings UI and API client.
- Test: secret non-disclosure, failed test no activation, busy-turn rejection, activation persistence, restart and locale/viewport journeys.

**Acceptance:** A player can configure an approved connection, test, save, select an approved model/reasoning setting, activate while idle, and read back readiness. Keys never enter browser storage, payloads, exports, logs or evidence. Game configuration remains separate.

### Task 13: P10 cumulative production release closure

**Files:**
- Modify: `design/40`, `design/28`, `design/27`, `design/33` with per-slice evidence only.
- Modify: production artifact/profile manifests and final browser/process harness as required by prior tasks.

**Acceptance:** A fresh GameBuddy-owned root using the immutable shipped Host/browser artifact can configure an approved connection, create the first Companion/Chat, select approved Persona/Scenario/Greeting/World Info, send and receive through the real provider, cancel/reconnect/restart/reopen, create and switch another Chat, perform released lifecycle/import-export/Memory operations, and read back durable results in en/zh-CN, responsive, accessibility, security/privacy, and failure/recovery matrices.

- [ ] Run all prior focused emitted suites serially against one immutable generation.
- [ ] Run the fresh-root production browser journey without `page.route()`, hidden setup APIs, or fixture-created Tavern state.
- [ ] Run final artifact/import-boundary/static-asset checks and preserve privacy-safe evidence.
- [ ] Mark the plan complete only when every approved `design/28` row is released; otherwise record the exact blocked row and do not claim full pipeline completion.

## Status Ledger

| Batch | Status at plan update | Evidence / blocker |
|---|---|---|
| P3/P4/P5 | Complete foundation | Existing focused Host suites and artifact checks; carried forward from prior plans |
| P7 reference submit/status | Complete bounded slice | Existing real Chromium 2/2 and Host emitted suites |
| P7 same-Chat restart | Complete | Two-child process evidence, terminal status preserved, second provider start 0 |
| P6 cancel | Blocked at authority prerequisite | Characterization proves no legal queued-cancel ledger shape; owner decision required before route/profile |
| P7 SSE | Bounded browser/recovery matrix released; app-managed epoch-change and same-consumer duplicate remain explicit boundaries | Durable-after-read-back producer, reference `/events`, live/replay/resync raw HTTP evidence, Origin-less EventSource auth, forged/ambiguous cursor guards, cursor precedence matrix, concurrent-reader stream tests, and immutable mounted Chromium evidence for same-epoch loss-free replay, forced-gap `/state` recovery, stale-generation rejection, and passive native Chromium `Last-Event-ID` retry are evidenced. A stream instance mints one immutable epoch, so an app-managed foreign-epoch journey requires a real Host restart/authority replacement and remains outside this bounded slice. The reducer's duplicate guard, Host concurrent-reader evidence, and browser exact-once/single-source evidence establish the current topology boundary; delivering the same frame twice to one app consumer would require a test-only or architecture change and is not a release claim. |
| P8 Memory/context | Read-only bounded slice and internal exact-next runtime evidence bridge released; player-visible mutation lifecycle remains incomplete | `memory.read` is mounted on the eight-route `tavern_management` profile with exact lease/continuity binding, strict safe DTO projection, `mutationAvailable: false`, and no direct SQLite/prompt path. Fresh emitted Host Memory/management/contract suites pass `31/31`; immutable Chromium management suite passes `3/3`, including a real mounted `/memory` empty projection. The released internal P8-A bridge mints a Host-private 64-hex nonce at runtime construction, binds the next-round coordinator only after materialization returns the actual Pi session ID, exposes neither session ID nor evidence facts through the public mounted lease, and holds/release-checks a private permit around the one P4c prompt; fresh emitted bridge/coordinator/P4c suites pass `35/35` after the non-disclosure regression. No `memory.mutate` HTTP/UI/DTO/read-back lifecycle, raw/provenance UI, or Task 13 fresh-root/provider closure is released. |
| P9 management | List/title/draft + locale/responsive micro-pipeline and bounded World Info exact-binding tracer released; full Task 10 lifecycle remains incomplete | Metadata-only Chat list + exact title rename + durable draft save/discard remain mounted on the management profile. The World Info tracer adds safe catalog projection of existing immutable managed revisions plus exact current-pristine-Chat bind/unbind only: opaque browser handles/revisions, composed-profile and lease-bound Host authority, CSRF-protected `world-info.bind`, durable read-back, and no catalog edit/import/export/recovery, Chat switch, provider, or raw identity/content exposure. Fresh immutable artifact `g-mt1nqk6p-20372-c6d4c67b0ece4a8791596ffc80f7707f` passed artifact and import-boundary gates; management Chromium `6/6` includes durable bind/unbind/reload, real content-lock `409 → /state` read-back, and two-page stale-projection `409 → /state` replacement, alongside title/draft and `zh-CN` `375x667`. Exact open/switch and later management slices remain.
| P10 release | Blocked | P6/P7 SSE/P8/P9 and real fresh-root provider/release gates remain |

## Verification Commands

Run commands from the owning package and obey the existing artifact-lock protocol:

```bash
pnpm --dir host exec tsc --project tsconfig.test.json --noEmit
pnpm --dir host exec tsc --project tsconfig.production.json --noEmit
pnpm --dir dialogue-web run typecheck
pnpm --dir dialogue-web run build
node tools/check-host-production-import-boundary.mjs
pnpm --dir host run check:production-artifact
pnpm --dir host run build:test
pnpm --dir dialogue-web exec playwright test
```

Every emitted run must identify its immutable generation and run serially. A failed lock acquisition, missing helper, or stale artifact is a verification failure, not permission to use old output.

## Historical Handoff

This historical plan is superseded. Do not execute P6/P8/P9/P10 proof-gated tasks or infer current priorities from this ledger. Current work is defined only by `design/90_SIMPLIFIED_PI_BACKED_CHAT_PRODUCT_IMPLEMENTATION_PLAN.md`.
