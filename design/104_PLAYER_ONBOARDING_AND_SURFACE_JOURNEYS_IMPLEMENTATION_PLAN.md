# Player Onboarding and Surface Journeys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill task-by-task. Every task ends in a real-listener browser journey. Use the existing React/Vite/vanilla CSS stack and Design 26 tokens; do not rewrite the app.

**Goal:** Connect existing Host Chat/Game capabilities into one understandable fresh-root player shell, add missing provider/content/game setup journeys, and close the concrete pipeline gaps found by the parallel player audit.

**Architecture:** One Host-owned composed player bootstrap mounts independent Chat and optional Game domains under one browser session and one Chat-first shell. Contextual drawers consume strict redacted projections; service existence alone is not capability. Game discovery feeds Design 101 registration, and Game task input feeds the attached Game facade rather than Chat submit. Desktop launch/close/update are owned by Design 103.

**Tech Stack:** TypeScript/Node Host, strict TypeBox browser contracts, React 19, Vite, vanilla CSS three-tier tokens, Playwright real-listener tests, existing native folder picker and Stardew admission.

**Spec:** `design/104_PLAYER_ONBOARDING_AND_SURFACE_JOURNEYS_DESIGN.md`

## Global constraints

- Design 90 owns ordinary Chat execution; Design 91/99–102 own Game execution and lifecycle.
- Design 103 owns installer/tray/WebView2 and app quit.
- Browser receives no credential, raw path, provider internals, Pi internals, bridge/process facts, raw receipt, or generic native interface.
- One drawer/sheet, Chat-first timeline, en/zh-CN parity, Design 26 tokens/a11y.
- No page-route mocks for final acceptance; deterministic service tests may use typed fakes.
- Do not make all tasks one rewrite. Deliver each producer→consumer→verifier slice independently.
- Consume Design 103's canonical root/owner contract; React never receives raw roots or Pi/Magic Context internals, and clear-cache/forget/remove/purge remain distinct owner operations.

---

## Task 1 — Fix and characterize the current composed Game mount

**Outcome:** The existing composed Game shell starts truthfully; mounted profile operations exactly match callbacks, and lifecycle activation has one reachable owner.

**Files:**
- Modify: `host/src/dialogue-web-main.ts`
- Modify: `host/src/tavern/composed-reference-game-static-shell-composition.ts`
- Modify: `host/src/composed-reference-game-browser.ts`
- Modify exact tests only

- [ ] Reproduce the audited `game.launch` profile/callback mismatch with a production-composition test that proves no listener launches.
- [ ] Make profile and mounted callbacks exact; do not relax the strict mismatch check.
- [ ] Add the one missing lifecycle activation producer/consumer so coordinator transitions from inactive through its existing strict state machine; do not invent a second activation path.
- [ ] Prove setup cannot call picker before activation and activation replay/drift remains fail closed.
- [ ] Run focused Host tests/typechecks and review the operation topology.

## Task 2 — Compose one public player shell and navigation

**Outcome:** Missing/unknown profile never renders blank; one bootstrap opens Chat-first shell with Chats, Characters, Game, and Settings entries only when backed by mounted capabilities.

**Files:**
- Create/modify one versioned composed player browser contract and Host composition
- Modify: `host/src/dialogue-web-main.ts`, `dialogue-web/src/main.tsx`
- Add composed session/client tests

- [ ] Write failing fresh-root tests for no hash, unknown hash, Chat-only, Chat+Game, management capabilities, and one bootstrap/session/CSRF owner.
- [ ] Replace public reliance on operator-selected hash profiles with Host-owned composed root/navigation; retain internal test profiles only as fixtures.
- [ ] Keep one cookie/session/CSRF issuer and delegate to Chat/Game providers without widening legacy `tavern_browser_api/v1` polymorphically.
- [ ] Prove absent capability means absent navigation/control, not a disabled lookalike.
- [ ] Run real-listener first-open/reload/Back tests.

## Task 3 — Provider credential setup, readiness, and Settings journey

**Outcome:** A fresh player can configure the shipped `cpa-oai` companion service through a Host-owned Windows credential vault, then understand ready/setup-needed/unavailable without secret disclosure. Environment-variable setup remains contributor-only.

- [ ] Define a provider-neutral browser contract with redacted readiness read plus exact `set`, `check`, and `remove` operations; the first Host adapter supports only `cpa-oai` API-key credentials.
- [ ] Implement current-user Windows Credential Manager/vault persistence behind a narrow Host credential owner. Do not write API keys to browser storage, product config, model preference store, runtime root files, logs, command line, environment dumps, or Game state.
- [ ] `set` accepts the secret only in an authenticated same-origin/CSRF-protected bounded request, writes it once, performs a bounded provider probe, and returns only authoritative `ready | setup_needed | unavailable`. Never echo/account-identify the secret.
- [ ] Cancel preserves the prior credential/readiness; invalid input stays setup-needed; temporary provider outage stays unavailable without deleting the credential; restart rereads through the vault; remove requires explicit confirmation and reread.
- [ ] Render Settings drawer with Set up/Replace/Check again/Remove using safe vocabulary, Design 26 tokens, en/zh-CN copy, password-manager/autocomplete policy, accessible validation/focus, and no arbitrary provider/model console.
- [ ] Test missing, cancel, invalid, valid, replace, unavailable, restart, remove, ACL/vault failure, and concurrent write. Snapshot request/response redaction, DTO, DOM, browser storage/history, logs, crash categories, and Game projection for secret absence.
- [ ] Prove Chat and Game consume readiness but cannot read credential material; Game drawer never contains a key field.
- [ ] Run a real-provider setup/restart/removal journey in a disposable user environment before Desktop Player Release. CI may use a deterministic typed vault/provider fake but cannot substitute for the release journey.

## Task 4 — Companion and Chat library journey

**Outcome:** Player can create/import/select a companion, choose Persona/Scenario/Opening, create/open Chat, and recover it after reload.

**Files:**
- Existing Tavern library/new-companion/persona/scenario/greeting services
- Browser contracts/routes/composed profile
- Dialogue Web drawers/forms

- [ ] Characterize every existing service and publish only operations with complete Host route + browser client + UI.
- [ ] Implement Characters and Chats drawers, short New Chat form, safe catalogs, opening semantics, and exact selection generation/CAS.
- [ ] New Chat success requires durable message 0 or honest blank state; activation only when Host confirms it.
- [ ] Add open/switch/reload/failure-preservation tests; stale handles retain current conversation and show failure.
- [ ] Add import review only for currently supported safe fields; unsupported scripts/macros/HTML remain absent.

## Task 5 — Complete ordinary Chat interaction journey

**Outcome:** Send/stream/persist/reload, Stop/failure/send-again, and Memory/World Info are reachable from one player shell.

- [ ] Complete Design 90 Task 1 ordinary Chat Stop/failure/reload through the mounted composed shell.
- [ ] Complete Design 90 Task 2 ordinary Memory CRUD and retain authoritative reread.
- [ ] Integrate management drawers into the one player shell instead of a separate operator profile.
- [ ] If redirect/steer is shipped, add a distinct authenticated route and durable semantics; otherwise keep it absent and do not simulate cancel+resubmit.
- [ ] Run no-route-mock mounted journeys and remove obsolete evidence machinery only after replacement is green.

## Task 6 — Add Host-private Stardew discovery candidates

**Outcome:** Player can Find automatically or Choose game folder; both routes strict-admit before registration and never expose paths.

**Files:**
- Create: `host/src/stardew-installation-discovery.private.ts` and tests
- Create bounded Steam/GOG adapters only after reading their official formats/installed records
- Modify Game setup contract/composition after Design 101 registration interface is available

- [ ] Write failing tests for unique/multiple/none/malformed/stale candidates and drive-scan prohibition.
- [ ] Implement bounded discovery sources as untrusted locator producers; no candidate is authority.
- [ ] Strict-admit every candidate before projecting an opaque short-lived choice; return source label/safe hint only.
- [ ] Require explicit confirmation before Design 101 registration; manual native picker remains available.
- [ ] Prove launch never silently falls back to another discovered candidate after registration invalidation.

## Task 7 — Complete game setup/prerequisite/registration UI

**Outcome:** Setup outcomes are understandable and persist across app restart through Design 101.

- [ ] Extend Host projection with redacted setup outcomes: cancelled, rejected, registered, needs_smapi, needs_gamebuddy_mod, warning, incompatible, unavailable.
- [ ] Implement Game drawer first-run states, Find/Choose/Check again/Forget actions, safe instructions for selecting the game folder, and no raw path.
- [ ] Wire valid manual/confirmed discovery to Design 101 registration; do not equate registration ready with launch ready.
- [ ] Test cancel preserves prior registration, invalid selection gives next step, moved/reparse/missing/SMAPI failure requires setup, warning remains launchable.
- [ ] Run fresh-root and restart journeys in en/zh-CN.

## Task 8 — Implement the Design 26 Game drawer and truthful lifecycle sequence

**Outcome:** Game is one accessible contextual drawer with one primary Play action and safe launch/attach/cabin/reconnect recovery.

- [ ] Replace inline `composed-game-drawer` section with an AppBar Game opener and one drawer/sheet using existing drawer interaction primitives.
- [ ] Map protocol enums to localized player states; never render raw enums or hard-coded English.
- [ ] Sequence setup → Play → confirmation → connecting → ready; refetch cabin choices only from safe lifecycle state and add safe uncertain reconciliation.
- [ ] Mount attach/reconnect/diagnostics only when real Host operations exist; failure retains prior readable Chat and Game state.
- [ ] Add focus trap/restore, Escape/backdrop/Back, 44px, live region, reduced motion, and viewport/locale visual tests.

## Task 9 — Connect player Game task ingress and fresh outcomes

**Outcome:** A player's Game task reaches the attached Game facade, while Chat composer remains Chat-only.

- [ ] Define one browser-safe Game task command/projection consuming the existing attached prompt-defined task ingress; no raw prompt/plan/tool/receipt in public DTO beyond player-authored task text and safe state.
- [ ] Add a distinct Game task input/control in the drawer or explicit Game task mode; do not route through Tavern submit.
- [ ] Project safe active/progress/latest outcome and capability summary from source owners.
- [ ] Add Game-owned event epoch or bounded polling independent of Chat SSE.
- [ ] Implement `Stop game task` availability from Game owner, settlement reread, and independence from Chat Stop.
- [ ] Test task dispatch/progress/success/failure/cancel/uncertain, stale generation, reload, and no duplicate effect.

## Task 10 — Reconnect, close, and restart player journeys

**Outcome:** Page close, tray reopen, Host restart, Game disconnect/reconnect, and app Quit match Design 103 and never duplicate work.

- [ ] Implement Game reconnect only after Design 102/101 lifecycle recovery supports fresh generation/world validation.
- [ ] Project current owner state after browser reconnect/Host restart; stale sessions and generations fail closed with a real next action.
- [ ] Add Settings privacy/storage outcomes using existing owners only: consume Design 103's shell-owned `clearTemporaryPresentationData`, forget game installation, remove provider credential, and explicit remove-all-data handoff. Do not add raw paths, generic storage CRUD, Pi-session/Magic Context database access, browser-side deletion, or whole-root backup/import.
- [ ] Prove clear-temporary enforces updater-idle and affected-owner close/reopen, deletes only its declared disposable categories, and preserves Chat/Memory/game registration; prove forget-game preserves Stardew/SMAPI and Chat, credential removal preserves Chat/Game data, and explicit purge blocks on active/uncertain owners or root mismatch.
- [ ] Prove Chat/Game Pi-session partitions remain isolated and only same-continuity Magic Context-owned semantic Memory crosses surfaces; system Pi/Magic Context roots are never consumed.
- [ ] Integrate Design 103 close disclosure and tray reopen; page close remains presentation disconnect.
- [ ] Prove simultaneous active Chat/Game: Chat Stop affects only Chat, Game Stop only Game, Quit independently closes both.
- [ ] Run crash/restart/update journeys with no duplicate Chat prompt/Game task/cabin confirm/launch/action.

## Task 11 — Final player-experience gate

**Entry gate:** Design 103 Task 8 verifier infrastructure is already versioned and green for signer/install/start/real-listener/report mechanics, and Design 104 Tasks 1–10 are complete. This task is the shared Design 103/104 final execution gate; it does not create a second verifier.

Use that versioned Design 103 release-verifier entrypoint and strict report schema. Run the complete Design 104 acceptance journeys against:

1. fixed Browser Preview artifact only for developer/QA browser regression, clearly labeled non-desktop;
2. signed `Setup.exe` → signed `GameBuddy.exe` → exact installed generation after Design 103 closure, using Desktop Browser Presentation or WebView2 according to the claimed release;
3. a disposable current-user vault and real provider readiness where release credentials are available, with deterministic typed fake only for CI;
4. real target-version Stardew only after Design 102 verified containment/recovery closure → Design 101 registration closure → Design 100 private headless activation/static gates and independent review → the owning operational-gate live preflight → one authorized target-version live mutation;
5. Design 103 canonical-root fixture plus unmanaged sentinels and isolated system Pi/Magic Context decoys, proving no adoption and correct preserve/purge behavior.

The runner inputs are signed Setup path, expected product version, independently published `gamebuddy-windows-signer-policy/v1`, and disposable Windows-user/VM fixture. It verifies per-file Authenticode policy outcomes and installed generation, prohibits route mocks, records verifier version, Setup file identity/version, signer-policy version/outcomes, generation identity, OS/user fixture, per-journey results, commands, screenshots, accessibility artifacts, redacted reason categories, source-owned lifecycle outcomes, teardown, uninstall, and cleanup. It adds no redundant installer content digest. It asserts no system Node/pnpm/Pi/Magic Context or arbitrary root adoption, no cross-surface raw Pi/transcript/tool/world/receipt leakage, no secret in process/URL/history/DTO/DOM/log artifacts, correct temporary-data/forget/credential/default-uninstall/explicit-purge outcomes, and no residual owned process. Any missing/failed journey, signature/generation mismatch, secret leak, residual process, accessibility failure, or cleanup failure blocks Desktop Player Release. The report does not mint runtime authority or hide unresolved missing operations.
