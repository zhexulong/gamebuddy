# Frontend convergence — one frontend, one profile

Owner ruling: the product converges to ONE frontend. Today `dialogue-web/src/main.tsx`
dispatches three by `#profile`:

- `#profile=reference` → `ReferenceApp` (21 KB)
- `#profile=composed-reference-game` → `ComposedReferenceGameApp` (the product, 68 KB) — **survivor**
- `#profile=management` → `ManagementApp` (18 KB)

Survivor identity: `#profile=composed-reference-game`. It is the marker the composed
specs, the composed Host composition (`launchUrl = ${origin}/#profile=composed-reference-game&boot=…`)
and the artifact identity (`gamebuddy.tavern.browser.v1`) already use.

## Inventory — every capability the two removed apps have

Ordering runs before any code. Each row is one behaviour, and the plan for it.

### A. `ReferenceApp.tsx`

| id | capability / behaviour | in the product today? | disposition |
|----|------------------------|-----------------------|-------------|
| R1 | profile marker `reference` + `data-profile="reference-pipeline"` | n/a | delete with the file |
| R2 | bootstrap redeem once (`POST /bootstrap`), then strip the one-time `boot` from the fragment keeping the profile marker | yes (`composedApiRef.bootstrap`, rewrite to `profile=composed-reference-game`, keeps a restored `panel`) | covered |
| R3 | reload path re-reads `/state` through the HttpOnly session cookie, never a second redeem | yes | covered |
| R4 | draft/snapshot reconciliation guard (`draft.revision === chat.draft.revision && (draft.text!==null) === chat.draft.present`) | yes | covered |
| R5 | SSE `openEvents` with cursor, ordered `work` queue, `resync`/epoch-change → authoritative `/state` reread, non-durable `companion.delta` preview | yes (same code path) | covered |
| R6 | bounded `/state` + `/status` poll for a pending submission (250 ms first, 1 s interval, 1/2/4/5 s backoff, 60 attempts), never re-sends | yes | covered |
| R7 | `chat.submit` with a CSPRNG 22-char idempotency key; the 202 is never appended locally; non-retryable rejection clears the pending key | yes | covered |
| R8 | **Timeline swipe selection (`selectSwipe` prev/next) and regenerate (`regenerate`) with a fresh idempotency key** | **NO** — `Timeline` is mounted with neither `onSwipe` nor `onRegenerate`, so `MessageBubble` renders no swipe/regenerate controls | **bring across** |
| R9 | **`Composer` receives `voice={snapshot.voice}` → the mic status dot (`ready`/`speaking`/`unavailable`)** | **NO** — the product `Composer` call passes no `voice` | **bring across** |
| R10 | `chat.cancel` STOP gated on `turn.canCancel` + the `chat.cancel` operation, then authoritative reread | yes | covered |
| R11 | terminal-turn notice (`chatStopped` / `chatFailed`) as `role="status"` | yes | covered |
| R12 | saved-draft section `aria-label=savedDraft` (durable text or the honest "no saved draft") | yes | covered |
| R13 | loading placeholder (`state-placeholder` / `openingChat`) | yes | covered |
| R14 | problem view: retryable → temporarily-unavailable, else reconciliation-failed | yes, and the product's `composedProblemView` is the superset (session-expired / absent-route / bounded internal code+cause) | covered (better in survivor) |
| R15 | `SkipLink` to the main region | yes | covered |
| R16 | `applyDocumentLocale` on mount | yes | covered |
| R17 | AppBar carries the companion name | yes (Requirement: the product's `AppBar` adds brand, status tone, surface entries) | covered |

### B. `ManagementApp.tsx`

| id | capability / behaviour | in the product today? | disposition |
|----|------------------------|-----------------------|-------------|
| M1 | profile marker `management` + `data-profile="management"` | n/a | delete with the file |
| M2 | **`createManagementPipelineApi(fetch, observer)` with the opt-in `#record=operations` observation hook writing `gamebuddy.tavern.ui.operation-observations` into `sessionStorage`** | **NO** — the product calls `createManagementPipelineApi()` with no observer, so nothing is recorded | **bring across, same fragment param and same storage key** |
| M3 | mount reads selection + chat from its own snapshot, then `listChats()` + `readDraft()` with the reconciliation guard | product reads the composed root + `/draft` | covered (composed root is the product's authority) |
| M4 | **durable draft authoring: textarea + Save/Discard gated on `draft.save`/`draft.discard`, validated read-back replaces the draft, and on rejection the authoritative draft is re-read *before* the failure notice so a stale local textarea cannot survive a 409** | **NO** — the product's Chat surface renders the draft read-only | **bring across** |
| M5 | one `role="status"` banner that every panel reports its outcome into (`onNotice`) | no `onNotice` is passed, and that is the documented composed behaviour: `useSurfaceNotice` renders the outcome **in place** when the mount does not own a banner | covered by design (panels report in place) — no change |
| M6 | `renameAvailable` / `retentionAvailable` capability flags on `ChatsSurfacePanel` taken from the mounted snapshot's `operations` | the product passes neither; `undefined` is the documented composed meaning ("this mount cannot see the management projection, so the served list is the capability") | covered by design — no change |
| M7 | rename read-back folded into the mounted session so the transcript heading follows the rename (`applyRenamedTitle`) | the product re-reads the composed root (`handleRenamedTitle` → `reread`), whose Chat projection *is* the heading's authority | covered (equivalent, stronger for the composed contract) |
| M8 | **Characters availability probe (`companion.list`) gating the Characters panel** — "a profile without the Character routes answers `unavailable`, so the UI never shows controls that could not work" | **NO** — the product always offers the Characters entry and always mounts `CharactersPanel` | **bring across** (probe → gate the entry and the surface) |
| M9 | Memory toggle button gated on `memory.readAvailable` | the product offers a Memory surface entry gated only on `managementPanelsAvailable`; the composed Chat projection pins `memory.readAvailable: false`, so the flag cannot be read there | covered by design (see `management-surface-panels.tsx` header) — no change |
| M10 | World Info read through the mounted snapshot (`chat.worldInfo`) | the product reads the dedicated `GET /world-info` route, because the composed Chat projection pins `chat.worldInfo: null` | keep the survivor's (documented, and the only honest read on that contract) |
| M11 | Settings surface with `uiLocale` + `onSelectUiLocale` persisting the UI language and re-applying the document locale | yes (`handleUiLocale`) | covered |
| M12 | `MemorySurfacePanel` `mutationAvailable` from the snapshot | the product passes nothing (`undefined` = the served route is the capability) | covered by design — no change |
| M13 | draft mutation success/failure notice | absent because M4 is absent | arrives with M4 |
| M14 | `problemView` mapping `runtime_unavailable`/`storage_unavailable` (plus retryable) to temporarily-unavailable | the survivor's `composedProblemView` maps every retryable problem to temporarily-unavailable and gives the rest bounded codes | covered (better in survivor) |
| M15 | loading placeholder, `ProblemView`, `SkipLink`, `applyDocumentLocale` | yes | covered |
| M16 | `ChatsDrawer` chrome around the Chats panel | the survivor mounts `ChatsSurfacePanel` in a peer `SurfaceView` region (design/104 §2 peer-surface model, frozen) | covered |
| M17 | single-shot characters probe ref (probe once per mount) | — | arrives with M8 |

### C. Assets only the removed profiles use

| id | asset | disposition |
|----|-------|-------------|
| C1 | `main.tsx` `#profile` dispatch branches for `reference` / `management` | removed; the product profile becomes the only render path |
| C2 | `host/src/tavern/reference-pipeline-static-shell-composition.ts` (`launchUrl = #profile=reference`) | deleted; `startChatOnlyPresentationAdmission` re-points at the composed composition |
| C3 | `host/src/tavern/tavern-management-static-shell-composition.ts` (`launchUrl = #profile=management`) | deleted; `startTavernManagementPresentationAdmission` re-points at the composed composition |
| C4 | a second browser artifact / HTML entry per profile | **does not exist**: one Vite entry (`index.html` → `/src/main.tsx`) and one artifact identity `gamebuddy.tavern.browser.v1` shared by all three compositions; nothing to remove |
| C5 | `dialogue-web/tests/management-surface-panels.spec.ts` — self-declared "TEMPORARY lane probe (deleted before the change lands)", in no `package.json` script | re-pointed at the single profile and kept as the route-mocked panel probe, or deleted; decided when the specs are migrated |

### D. Consumers that must not stop working

| id | consumer | note |
|----|----------|------|
| D1 | `tools/run-tavern-management-operation-evidence.mjs` (surface `management`) | talks to `/api/tavern/v1/*` directly; it reads **only** `boot` out of the launchUrl hash, so a launchUrl that now carries `#profile=composed-reference-game` is transparent to it |
| D2 | `tools/live-run/memory/run-memory-live-loop.mjs` (surfaces `management`, `chat-only`) | same: `new URLSearchParams(url.hash.slice(1)).get("boot")` |
| D3 | `tools/run-tavern-narrative-gate.mjs` (surface `chat-only`) | same |
| D4 | `host/src/composition/desktop-host-composition.ts` `input.surface` variants | **not mine**; the two admission entry points keep their names and signatures, so this file is untouched |
| D5 | `tools/record-tavern-ui-operation-evidence.mjs` contract | documents the `gamebuddy.tavern.ui.operation-observations` sessionStorage key as the *only* admissible source; the hook is preserved verbatim (M2). No automated in-repo producer reads it today — the operator browser journey is the producer |

## Work order (one unit per commit, never more than one unit uncommitted)

1. **U1** this inventory (commit).
2. **U2** survivor absorbs R8, R9, M2, M4, M8 (product app only; no file deleted yet).
3. **U3** delete `ReferenceApp.tsx` + `ManagementApp.tsx`, collapse `main.tsx` to the one render path.
4. **U4** host: delete the two static-shell compositions, re-point the two admissions at the composed composition.
5. **U5** specs: re-point `reference-pipeline-browser.spec.ts`, `management-pipeline-browser.spec.ts`,
   `management-surface-panels.spec.ts` and `mounted-reference-composition.ts` at the single profile,
   folding their behaviour into the composed profile's specs without dropping a pinned behaviour.
6. **U6** evidence: `tsc`, `test:mounted-composed`, `check:dialogue-web-boundaries`, `check-head-typecheck`, host production typecheck.

## Evidence log

(filled in as units land)
