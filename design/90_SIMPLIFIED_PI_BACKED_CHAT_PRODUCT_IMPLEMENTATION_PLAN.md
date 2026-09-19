# Simplified Pi-Backed Chat MVP Implementation Plan

> **Status: Active execution plan.** This replaces the evidence-first execution strategy in `design/40_CHAT_PIPELINE_RELEASE_ENGINEERING_IMPLEMENTATION_PLAN.md`, `design/78_CHAT_PIPELINE_FULL_PRODUCT_IMPLEMENTATION_PLAN.md`, `design/87_P8_MEMORY_NEXT_ROUND_RUNTIME_EVIDENCE_BRIDGE_IMPLEMENTATION_PLAN.md`, and `design/88_P8_PLAYER_VISIBLE_EVIDENCE_BACKED_MEMORY_MUTATION_IMPLEMENTATION_PLAN.md`. Those documents are historical records, not delivery gates.

## Relationship to distribution and the complete player journey

This plan owns the ordinary Chat runtime and its focused browser behavior. [Design 103](./103_WINDOWS_DISTRIBUTION_AND_DESKTOP_PRESENTATION_DESIGN.md) owns installation, launcher/tray, public bootstrap, roots, close/update semantics, the developer/QA-only Browser Preview, and the installed Desktop Browser Presentation → WebView2 replacement. [Design 104](./104_PLAYER_ONBOARDING_AND_SURFACE_JOURNEYS_DESIGN.md) owns the complete player-facing onboarding and Chat-library journey around this runtime.

A browser-only Chat MVP may close this plan's focused implementation steps, but it is not a Desktop Player Release claim. The final player journey additionally requires provider/credential readiness, Companion/persona/scenario/greeting management, Chat create/select/reopen/delete, player-visible Memory/World Info, localization/accessibility, and fresh-install Desktop proof from Designs 103/104. These successors consume this plan's Chat authority; they do not create another transcript, provider, cancel, or Memory owner.

## Goal

Ship a useful GameBuddy Chat MVP:

1. The player opens the existing mounted reference Chat.
2. The player sends one message; Host saves it, calls the embedded Pi session once, and shows the persisted reply.
3. The player can stop an in-flight reply, see a normal stopped or failure state, reload, and send again.
4. The player can manage basic Memory with ordinary create, edit, delete, and immediate safe read-back.
5. Existing basic Tavern management (list, title, draft, Memory read, World Info bind/unbind) continues to work.

This focused MVP does not by itself prove that a fresh player can configure a provider, create/select a Companion and Chat, or reach the mounted reference Chat without fixture/profile setup; Design 104 owns those end-to-end gaps.

This is a conventional local application: browser HTTP/SSE -> Host service -> embedded Pi `session.prompt()` -> SQLite transcript/Memory storage -> browser state refresh.

## Decision

GameBuddy does **not** use bespoke evidence protocols as product authority. A source marker, nonce, receipt, correlation, private attestation, formal-gate report, fresh-root proof, immutable artifact proof, or provenance charter must not block an ordinary Chat or Memory action.

Tests verify behavior; they do not mint a second runtime authority. A successful mutation means the application storage operation succeeded and its safe state was reread. It does not claim that a later provider round rendered, observed, or proved anything.

## Boundaries retained

Simplification does not mean removing normal application safeguards:

- Keep the fresh semantic SQLite Chat authority. Do not restore legacy JSON, import/migration, fallback, dual-read/write, or read-repair paths.
- Keep one embedded, tool-restricted Pi runtime using Design 103's canonical GameBuddy-owned durable root. Pi configuration/runtime data and surface-session JSONL remain in owner-specific continuity/surface partitions; Chat and Game never share raw Pi sessions. Never read a user's system Pi installation, sessions, credentials, configuration, extensions, skills, prompts, or SQLite data, and never use the development `~/.gamebuddy` fallback in a Desktop Player Release.
- Magic Context uses the Host-fixed continuity-local `.cortexkit/magic-context.jsonc` plus scoped continuity-local `XDG_DATA_HOME`. Only Magic Context-owned semantic Memory may cross Chat/Game when the manifest binds both to the same continuity; Host does not copy raw histories or read/write Magic Context SQLite. Cache, logs, presentation profiles, and system Magic Context data are never Chat/Memory recovery inputs.
- Keep same-origin loopback browser sessions, CSRF on writes, strict TypeBox DTO validation, request-size limits, browser-safe error responses, and normal submission idempotency for `chat.submit` only.
- Keep durable transcript/turn state, ordinary database transactions, and reread-after-write responses.
- Keep Chat and Stardew/Game as independent surfaces. This plan does not modify the Game/action safety model. A Design 103 app quit may request each surface owner to close independently; it is not a shared STOP coordinator.
- Browser code never receives provider credentials, prompts, raw vendor state tokens, raw Memory source references, or Pi session internals. Player-authored or player-managed Memory text is ordinary product content and may be shown to that authenticated player through a bounded browser DTO.

## What is explicitly no longer a gate

The following may remain temporarily only until the replacement product path is covered; new MVP code must not depend on or extend them:

- `PlayerMemoryNextRoundEvidenceCoordinator`, next-round source-marker matching, nonce binding, receipt/correlation validation, prompt permits, or marker settlement;
- P4/P5/P6/P8/P9 proof labels, formal attestation collectors, external release reports, and provider/fresh-root charters;
- cross-process cancellation arbitration, exactly-once/recovery proof systems beyond normal `chat.submit` request idempotency;
- opaque capability layers whose only role is proving in-process ownership rather than protecting a browser/API secret boundary.

The existing coordinator/P4/P5 implementation is not declared safe or deleted by this document. It is legacy implementation debt. MVP work first provides observable product behavior through the existing mounted runtime, then removes obsolete machinery in a focused cleanup task. It must not be allowed to block the MVP.

## Current baseline

Useful paths already exist:

- `host/src/dialogue-web-main.ts` composes the mounted reference Chat and management profiles.
- `host/src/tavern/chat-pipeline-service.ts` persists a player message before starting the provider path.
- `host/src/tavern/p4-provider-start-execution.ts` contains the current actual Pi `session.prompt()` call.
- `host/src/tavern/reference-pipeline-state.ts`, `host/src/reference-pipeline-dialogue-web.ts`, and `dialogue-web/src/components/ReferenceApp.tsx` provide bootstrap, state, submit, reload, and SSE-refresh behavior.
- `host/src/tavern/memory-management/memory-management.ts` provides safe Memory reading; management already mounts it.
- Management already has real title/draft/list and World Info bind/unbind routes.

Known missing user behavior:

- The reference profile has no mounted Stop route/operation and `ReferenceApp` deliberately renders no Stop control.
- Provider failure is not yet projected as a simple user-facing failure/retry experience.
- Memory mutation is only an unregistered browser-contract scaffold; management Memory is read-only.
- The vendor bridge exposes a read projection and an evidence-bound mutation facade, but **no ordinary application CRUD facade**. A normal facade must be introduced before Host can implement Memory CRUD; Host must not write Magic Context SQLite directly.

## Delivery order

Feature delivery takes precedence over cleanup. Do **not** begin by rewriting old coordinators, tests, scripts, or plans.

### Task 1 — Reference Chat: Send, Stop, failure, reload

**Outcome:** Reference Chat has a normal player-visible turn lifecycle: `queued`, `running`, `completed`, `cancelled`, or `failed`. The player can stop an active Pi prompt and retry after failure or cancellation.

**Owned files:**

- `host/src/tavern/chat-pipeline-service.ts`
- `host/src/tavern/p4-provider-start-execution.ts`
- `host/src/tavern/reference-pipeline-state.ts`
- `host/src/reference-pipeline-dialogue-web.ts`
- `host/src/tavern/browser-contract/index.ts`
- `host/src/tavern/reference-pipeline-static-shell-composition.ts`
- `host/src/dialogue-web-main.ts`
- `dialogue-web/src/reference-pipeline-api.ts`
- `dialogue-web/src/reference-pipeline-session.ts`
- `dialogue-web/src/components/ReferenceApp.tsx`
- `dialogue-web/src/i18n.ts`
- Direct Host/browser tests for the files above

**Implementation rules:**

1. Keep the current single `session.prompt()` call; never call Pi again to prove a completed/cancelled state.
2. Add one ordinary `abort` capability to the mounted runtime/service boundary. It is only callable through the authenticated, CSRF-protected `chat.cancel` route for the current projected turn; it does not expose a Pi session to browser code. Add the route to the reference profile and compose it into the static shell before the handler dispatches it.
3. Map the existing durable turn data to the five UI states above. Do not require an initial rewrite of the current internal ledger; obsolete internal variants may be mapped to `queued`/`running` temporarily.
4. On Stop, call Pi `session.abort()` once when a prompt is active, persist/project `cancelled`, reread state, and enable a later Send. On prompt rejection, persist/project `failed`, reread state, and enable a later Send. If current P4/P5 code prevents this direct outcome, simplify that owner implementation rather than add a second cancellation protocol beside it.
5. Mount `chat.cancel` only in the reference profile. Require the existing session authentication, same-origin check, CSRF header, strict TypeBox request validation, and opaque current-turn handle validation.
6. `ReferenceApp` renders Stop only from the latest `/state` operation and turn projection. It performs state reread after Stop/failure and never invents a companion message or terminal state locally.

**Tests before acceptance:**

- Host service: one prompt invocation; normal completion; provider rejection; stop while running; stale/unknown turn handle; second message after terminal state.
- HTTP handler: unauthenticated/CSRF/invalid request rejection; cancel success returns reread state. Update the existing route/profile contract tests alongside the handler.
- Browser: send -> reply -> reload; send -> Stop -> reload; provider failure -> visible error -> Send enabled.
- Commands: Host production/test typecheck, relevant Host tests, web typecheck/build, and the mounted listener browser test. Browser tests use the real Host listener, never `page.route()` for Host API behavior.

### Task 2 — Ordinary Memory CRUD with immediate safe read-back

**Outcome:** Management Memory supports create, edit, and delete/archive through normal Host service calls. A durable write returns an immediate safe reread. It does not wait for, activate, or settle a future Pi marker.

**Owned files:**

- `vendor/magic-context/packages/pi-plugin/src/gamebuddy-player-memory-evidence.ts` (replace evidence-only mutation export with a normal, Host-owned CRUD facade; do not retain a compatibility facade)
- `vendor/magic-context/packages/pi-plugin/src/index.ts`
- `host/src/magic-context-memory-facade.d.ts`
- `host/src/tavern/memory-management/memory-management.ts`
- `host/src/tavern/browser-contract/index.ts`
- `host/src/tavern/tavern-management-static-shell-composition.ts`
- `host/src/dialogue-web-main.ts`
- `host/src/tavern-management-dialogue-web.ts`
- `host/src/tavern/tavern-management-state.ts`
- `dialogue-web/src/management-pipeline-api.ts`
- `dialogue-web/src/management-pipeline-session.ts`
- `dialogue-web/src/components/ManagementApp.tsx`
- `dialogue-web/src/i18n.ts`
- Direct vendor/Host/browser tests for the files above

**Implementation rules:**

1. The Magic Context extension owns database access. A private Host composition mints one opaque CRUD scope from the validated manifest identity binding (`playerId + companionId + continuityId`) and the already-derived continuity runtime; browser/caller input never selects `runtimeCwd` or a naked `continuityId`. Export one normal CRUD facade consuming only that opaque scope; it must not accept a provider binding, evidence, nonce, receipt, Pi session ID, filesystem path, or browser-selected identity.
2. The Host-owned Memory service boundary dynamically resolves the Magic-Context-owned CRUD facade, maps opaque projected handles to the current vendor rows inside the service, performs create/update/archive/delete through that facade, then calls `read()` and returns the current player-safe projection. Host does not import a SQLite driver, Magic Context schema/path, or database file.
3. The player-authored/player-managed Memory text is product content and is included in a bounded, authenticated browser DTO so edit is usable. The browser receives no CAS `stateToken`, `sourceRefs`, receipt, marker, nonce, correlation, provider binding, or Pi session fact. Opaque handles are retained.
4. Register and export one strict `MemoryMutationCommandV1`/result schema and a bounded `MemoryItemV1.content` field in the browser contract. Use content bounded to 4096 UTF-8 bytes; use a current opaque `projectionRevision` for update/delete conflict detection. This CRUD route has no idempotency/replay key.
5. Mount `memory.mutate` in the **management** profile only, with normal same-origin auth and CSRF. Add the route/operation to the composed management profile, static shell, state projection, and handler as one connected change. The mutation response and subsequent `GET /memory` use the same safe read model.
6. UI controls are capability-gated. Create/edit/delete use returned read-back; on conflict, reread state and show a localized message. No optimistic Memory row is retained after a failed request.

**Tests before acceptance:**

- Magic Context extension/Host service boundary: create/edit/delete; stale projection conflict; unavailable facade/storage mapping; same continuity string with different player/companion remains isolated; Chat/Game bound to the same exact manifest identity may consume the same semantic Memory; returned DTO includes only the authenticated player's bounded Memory text and no forbidden internal fact.
- Static/import boundary: Host calls only the typed Magic Context facade and cannot import a SQLite driver/schema/path or open Magic Context database files.
- HTTP: auth/CSRF/strict request/409 conflict/read-back.
- Browser: create -> reload, edit -> reload, delete -> reload, stale edit recovery using the mounted Host listener.
- Commands: Host production/test typecheck, vendor focused test(s), web typecheck/build, and management browser test.

### Task 3 — MVP browser and ordinary regression release

**Outcome:** The MVP is tested like a normal application, not promoted through a bespoke proof protocol.

**Checks:**

```bash
pnpm --dir host exec tsc --project tsconfig.production.json --noEmit
pnpm --dir host exec tsc --project tsconfig.test.json --noEmit
pnpm --dir host run build:test
pnpm --dir dialogue-web run typecheck
pnpm --dir dialogue-web run build
pnpm --dir dialogue-web exec playwright test tests/reference-pipeline-browser.spec.ts tests/management-pipeline-browser.spec.ts
```

Record only the commands run and observable browser outcomes: submit/reply/reload, Stop/retry, and Memory CRUD/reload. A real embedded-provider smoke run is desirable when provider credentials are available, but missing credentials must not cause a fake proof artifact to be created. A deterministic Pi stub covers CI behavior.

### Task 4 — Remove retired evidence-first machinery (post-MVP cleanup)

**Outcome:** Delete—not extend—the evidence machinery that has no remaining product consumer.

**Preconditions:** Tasks 1–3 are green, and a repository search identifies every remaining production import/caller.

**Likely removal targets:**

- `host/src/player-memory-next-round-evidence.ts`
- runtime marker registration/clear hooks that become unused
- coordinator nonce/marker/permit fields and test-only bridges that exclusively support the retired feature
- the vendor evidence-only mutation facade and marker plumbing replaced by Task 2
- `tools/run-player-memory-next-round-attestation.mjs` and its dedicated test, if no package or CI command invokes them
- obsolete P4/P5 proof-only facades and tests, after the normal submit/abort path has replaced them

Do not write a new test that merely proves a retired command is retired. Delete it and remove its callers. Preserve ordinary Chat tests, session/CSRF checks, SQLite tests, and browser journeys.

## Historical-plan disposition

`design/40`, `design/78`, `design/87`, and `design/88` carry a top-level retirement notice. They retain historical findings but cannot set priorities or block this MVP. In particular, P6/P8/P9 labels and their prior formal gates do not define current delivery order.

## MVP status

| Capability | Current status | Acceptance |
|---|---|---|
| Reference Chat submit/reply/reload | Partial existing path | Task 1 browser journey |
| Reference Chat Stop/failure/retry | Missing | Task 1 service/HTTP/browser tests |
| Management title/draft/list | Existing bounded capability | Existing regression coverage retained |
| Management World Info bind/unbind | Existing bounded capability | Existing regression coverage retained |
| Management Memory read | Existing bounded capability | Existing regression coverage retained |
| Management Memory CRUD through Host service boundary backed by Magic-Context-owned CRUD | Missing | Task 2 service/HTTP/browser tests |
| New/switch Chat, Character, Persona, Scenario, Greeting, import/export, settings | Deferred | Separate small product slices |
| Evidence/attestation/fresh-root gate removal | Deferred cleanup | Task 4, after MVP |

## Plan self-review

- This plan does not confuse Pi with application storage or browser security: Host still owns ordinary request handling, persistence, safe projection, and error reporting.
- It also does not make Host manufacture proof records around Pi. One normal prompt, one normal abort, ordinary database writes, and end-to-end tests are sufficient for this MVP.
- The two user-visible gaps are deliberately small and independently releasable: first Chat Stop/failure, then Memory CRUD. Existing deep machinery is not a prerequisite and is removed only after replacement behavior is green.
