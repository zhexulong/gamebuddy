# Game Session Survival and Reconnect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define and implement a cross-game Game session that can be created with an explicit integration/continuity choice, resumed against only its registered GameBuddy-owned world binding, and kept alive across AI/Host failure or ordinary GameBuddy close without automatically continuing an old task. Multi-game and third-party integration are current architectural requirements: the durable session record, adapter contract, and browser schemas stay integration-neutral, and any published integration can implement the same contract.

**Architecture:** A durable Game session is separate from a Game activation and its integration-owned world binding. The generic Host session owner stores only redacted cross-game identity/state and optional continuity binding; the selected Game integration owns world creation, binding, the minimum attachment handshake needed to establish that binding, observation, capabilities, and terminal-world facts. The Stardew lifecycle coordinator remains the Stardew product owner. Player process lifetime and AI authority lifetime are separate: Player uses non-kill-on-close containment, while AI may be freshly relaunched under a new activation. Browser and React consume only redacted lifecycle projections.

**Tech Stack:** TypeScript/Node Host, C# Windows Guardian/Desktop, C# Stardew Mod, TypeBox browser contracts, React browser shell, Node `node:test`, .NET tests, Windows disposable process fixtures.

**Spec:** `design/tasks/active/game-session-survival-and-reconnect-simplification.md`, `design/domains/stardew/integration.md`, `design/architecture/product-surfaces.md`.

## Global Constraints

- AI failure, controller EOF, and ordinary GameBuddy close must not terminate the Player Host/game world.
- Explicit endgame is a separate authenticated operation; ordinary close/disconnect never projects `gameended`.
- Resume performs one new activation attachment, current-world observation, and Game-owned companion conversation sync; it never resumes or replays an old task. The attachment check exists to prevent wrong-session/world connection, not to prove that every prior in-memory object was invalidated.
- `unknown` action results remain unknown/recovery-required and are never converted to `completed`, `cancelled`, or blind retry.
- Player/AI role ownership, installation admission, reservation, revision, deadline, idempotency, cancel, and game-state checks remain with their current owners. Keep only the identity/revision facts that cross a process or durable boundary or change an execution decision.
- The generic runtime and browser never receive raw paths, PIDs, Job handles, pipe names, bridge tokens, native frames, reservations, or launch facts.
- Independent Chat remains independent; reconnect only restores the Game-owned companion conversation runtime.
- No compatibility fallback, dual read/write path, arbitrary environment forwarding, new daemon, or real Stardew/live mutation is allowed.
- Multi-game and third-party integration are current architectural requirements: the generic session/binding contract stays integration-neutral and any published integration can implement it.
- Attaching an existing game is a separate future enrollment operation, never a Resume fallback; Resume attaches only the selected session's registered GameBuddy-owned world binding and never scans or guesses another game/install.
- This iteration has no multi-instance parallel activation: at most one active activation per Game session at a time.
- **Validation budget:** each retained check must name the concrete incident it prevents, its authority owner, and its boundary. Keep only checks that change a product/security decision: session/world binding for wrong-game attachment, install/version checks at install/start, action admission for native side effects, receipt/postcondition for outcome, and durable transaction/CAS only for real concurrent or uncertain writes. Do not add or retain duplicate hash, signature, generation, proof, lease, CAS, or attestation layers merely to make a lifecycle look more verified; activation-local callbacks/capabilities end with their owner and need no separate invalidation probe.

---

## Validation audit gate

Before any implementation slice changes source, the owner must inventory proof-like fields and classify each one as `keep`, `merge`, or `remove`:

| Fact family | Keep only when it changes this decision | Typical owner/boundary | Do not repeat as |
|---|---|---|---|
| Release/install identity (`inventoryDigest`, runtime/artifact admission facts) | Prevent selecting a wrong or altered installed generation | release/install and selected-version startup | per-message or per-action artifact proof |
| Session/world binding and attachment | Prevent Resume attaching to another session or the player's unrelated game | Game session owner + selected integration at attachment | process scanning, title/PID/path guesses, or a second identity chain |
| Process ownership (`guardianInstanceId`, role/containment facts) | Prevent an accidental role mix-up or wrong teardown across a live process boundary | Guardian/containment boundary | browser/session metadata or repeated artifact proof |
| Action identity (`requestId`, idempotency, revision, deadline, cancel) | Prevent duplicate/obsolete native effects and bound a live request | action admission and game thread | a generic generation/fingerprint proof |
| Durable transaction/CAS | Serialize a real concurrent durable write or settle an uncertain side effect | the owning durable store | every in-memory lifecycle transition |
| Receipt/postcondition | Decide whether the game actually produced the requested result | action terminal + fresh world read | transport success, test evidence, or self-signed proof |

The audit must record the incident, authoritative source, boundary, and failure meaning for every retained fact. If a field cannot be justified there, no worker may add a new check around it; the field is a cleanup candidate. This gate is a design/code inventory, not a request to create another proof artifact.

## Current evidence and boundary

- Player non-kill-on-close and AI-only ordinary cleanup are implemented and covered by fresh native survival evidence; recovery returns Player `unavailable` rather than killing or falsely claiming containment.
- `game.resume` is declared in `host/src/game-browser-contract/index.ts` (idempotency key + expected attachment generation; strict `accepted`/`attached`/`unavailable` result vocabulary) and mounted in `host/src/composed-reference-game-browser.ts` behind exact mismount guards. Composed tests prove authenticated one-shot resume (exact-auth), strict frozen typed outcomes, forged-callback rejection, and unmounted-route unavailability (projection-liveness). These are completed prerequisite evidence only; automatic reconnect triggers the same `game.resume` pipeline and adds no parallel API.
- The durable Game-session metadata owner facade exists at `host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.ts` (`createGameSessionMetadata` / `completeGameSessionBinding` / `failGameSessionCreation` / `readGameSessionMetadata` / `listResumableGameSessions`, with cooperation-idempotency and close-rejection tests) and is the `host/src/game-session/**` composition target. No generic browser creation/binding flow is mounted end-to-end yet.
- **Next blocker:** the durable Game-session metadata owner facade is located, but the integration-private world-binding resolver and its final composition/owner consumer are not yet located; exact API names are not frozen. Slice 0 states only the narrow accepted seam rather than inventing implementation.
- `consumeOwnedFarmhandBridgeConnection` is a one-shot bridge consumer and `ConnectedSemanticGameLease` has no rebind operation.
- The current coordinator disconnect path tears down the semantic facade; it cannot be reused as reconnect.
- The AI process owner can create a fresh launch reservation after a stopped AI process, but the current bootstrap owner stores a consumed, generation-bound AI registration. Resume must use the selected integration's existing launch authority for the new activation; it must not replay a consumed registration. Whether AI is recreated or an existing process is attached is an implementation choice, not a separate product proof.

## Slice 0: Cross-game Game session creation and world binding

**User-visible result:** The Game UI lets a player choose a published Game integration, optionally choose a continuity identity binding, create a new Game session, and see creation/binding/observation progress. A session is resumable only after its integration-owned world binding and initial observation are durably recorded. The UI offers `Resume existing game` and `Start new game` as distinct choices; a failed Resume never silently starts a new world.

**Owned paths:**

- Existing fresh semantic SQLite / current Game session persistence owner — durable Game-session metadata facade already located at `host/src/continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.ts`; no parallel store
- `host/src/game-session/**` only if the located owner facade lacks a composition surface; this must remain a composition facade, not a second durable authority
- `host/src/game-browser-contract/index.ts`
- `host/src/composed-reference-game-browser.ts`
- `dialogue-web/src/composed-reference-game-browser-api.ts`
- `dialogue-web/src/components/ComposedReferenceGameApp.tsx`
- corresponding contract/server/API/UI and fresh-root persistence tests
- selected Game integration adapter contract tests, without Stardew-specific fields in the generic schema

**Generic contract:** The existing fresh semantic SQLite/current Game session owner remains the only durable authority; this slice must not create a second database or JSON store. Its durable record contains only `gameSessionId`, published `integrationId`, optional `continuityIdentityId`, activation/world-binding redacted status, and product status. It must not contain paths, PIDs, Job handles, pipe names, bridge tokens, native frames, installation locators, launch generations, reservations, or action authority. The selected adapter privately supplies the equivalent of `createWorldBinding`, `resumeWorldBinding`, `readObservation`, `readCapabilities`, and `readTerminalWorldState` — the narrow accepted seam; exact implementation names are frozen only after the integration-private world-binding resolver and its final composition/owner consumer are located (the next blocker; see Current evidence).

**Acceptance:**

- [ ] Before source mutation, the validation audit classifies existing proof-like fields by incident, owner, boundary, and failure meaning; it does not add a separate audit hash or attestation artifact.
- [ ] A strict create command persists integration choice, explicit continuity choice (default unbound), and the new session/world binding only after creation and initial observation succeed.
- [ ] Any creation, binding, observation, or durable-write failure produces a retryable redacted state and no resumable half-record.
- [ ] Resume uses only the selected session's registered GameBuddy-owned binding; it never scans processes or falls back to attaching an external game (existing-game attach is a separate future enrollment operation, not a Resume fallback).
- [ ] Resume failure offers Retry, Cancel, and `Start new game`; Start new game creates a new session/world binding and never migrates old world/action/task authority.
- [ ] A fake second Game integration can satisfy the same adapter contract without Stardew fields in browser/session schemas, verifying the current multi-game/third-party requirement rather than defining it.
- [ ] The Slice 0 design review records the incident, authority owner, and boundary for each validation it keeps, and rejects checks that duplicate an existing decision without changing behavior.

**Producer → consumer → verifier:** Game UI strict create/resume command → generic Game session owner → selected integration adapter → durable session/world-binding record → redacted state provider/browser/UI. Contract validators, fresh-root persistence tests, fake-adapter contract tests, and UI command-deduplication tests provide evidence.

**Non-goals:** No Stardew reconnect implementation, Shape B/native change, independent Chat resume, external-game attach/enrollment (separate future operation), multi-instance parallel activation, or live game.

## Slice 1: Integration-owned activation Resume authority

**User-visible result:** After an activation interruption or ordinary GameBuddy close, the Player Host remains alive, the Game session can be opened again, and the selected integration can attach the current registered world. Recreating an AI Client is an internal implementation choice of that new activation, not a separate product operation or proof layer.

**Owned paths:**

- `host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.core.ts`
- `host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.internal.ts`
- `host/src/stardew-ai-client-process-owner.ts`
- `host/src/local-stardew-bridge.ts`
- `host/src/stardew-owned-farmhand-game-session-materializer.internal.ts`
- focused tests for the above

**Non-goals:** browser route, React UI, old task recovery, Shape B, Player relaunch, Mod/native protocol changes.

**Acceptance (Given/When/Then):**

- [ ] Given a valid active Player owner and materialized AI profile, when the AI bridge closes or AI process is stopped, then the current activation ends, Player ownership remains active, and no reconnect path reuses the old activation object.
- [ ] Given a persisted session world binding and a new Resume activation, when the selected integration attempts attachment, then it uses only that binding and either attaches the current GameBuddy-owned world or returns a redacted unavailable result; it does not scan or guess another game. If the AI process must be recreated, that is an implementation step of the new activation, not a separate product proof.
- [ ] Given a new bridge attachment, when the integration's minimum hello/instance-binding check and first observation complete, then the result is a redacted connection capability for the new activation.
- [ ] Given a durable binding or action-lineage mismatch that crosses the Resume or action boundary, when it is presented, then it is rejected and no native action is sent. Activation-local callbacks, connections, capabilities, and leases are not separately probed after close.
- [ ] Given Resume fails after Player remains alive, then the result is `unavailable`/paused and no Player termination occurs.

**Producer → consumer → verifier:**

- Producer: the selected integration's owner resolves the persisted world binding and, only if needed for the new activation, creates a new AI process/attachment under its existing launch authority.
- Consumer: coordinator-owned Resume composition attaches the current world, creates the integration bridge client, and materializes a new Game semantic facade.
- Verifier: process/bridge tests cover wrong-binding rejection and Player survival; action-lineage tests cover unknown-result non-replay; activation-local object teardown is verified by normal ownership, not by a second invalidation protocol.

## Slice 2: Coordinator Resume state and action pause

**User-visible result:** Coordinator truthfully projects `disconnected → reconnecting → syncing → ready-actions-paused` or `unavailable`, while preserving the Player world and blocking new actions until a new Game instruction is admitted. `reconnecting` is a visible phase label; the product operation remains `game.resume`.

**Owned paths:**

- `host/src/stardew-production-lifecycle-coordinator.internal.ts`
- `host/src/stardew-role-lifecycle-facade.ts`
- `host/src/local-stardew-bridge.ts`
- `host/src/game-browser/game-browser-state-provider.ts`
- coordinator/state/bridge tests

**Interfaces:**

- Add a coordinator-owned Resume operation with the existing browser admission/idempotency/current-attachment tuple. An attachment revision is retained only where it prevents a concurrent or stale cross-process command; it is not a general proof that old in-memory objects were invalidated.
- Add a redacted action-authority projection; `ready-actions-paused` must be distinct from `unavailable` and `gameended`.
- Resume creates a new activation attachment and new semantic lease as ordinary ownership of the new runtime; it must not call the closed activation's `dispatchPromptDefinedTask` or resurrect its `promptTaskConsumed` state. No separate probe of the closed lease is required.

**Acceptance:**

- [ ] Disconnect immediately rejects new action admission and cancels only safe-to-stop continuation; accepted unknown effects remain unknown.
- [ ] Resume success requires the minimum bridge/instance-binding check, current observation, and Game-owned conversation sync before projecting `ready-actions-paused`.
- [ ] A new explicit Game instruction is the only path that reopens action admission; arbitrary Chat input, reconnect itself, or old task context cannot do so.
- [ ] Canceling reconnect leaves Player alive and projects `unavailable` or `disconnected` without stale reconnect work completing later.
- [ ] Duplicate idempotency key returns the same Resume result; a changed payload/session/current-attachment tuple fails closed where that tuple is needed to prevent a concurrent or stale cross-process command.

## Slice 3: Browser contract, server, API, and UI

**User-visible result:** The Game drawer displays the Resume phase, explains that actions are paused, and offers cancel/retry without chat spam or duplicate Resume commands.

**Owned paths:**

- `host/src/game-browser-contract/index.ts`
- `host/src/composed-reference-game-browser.ts`
- `dialogue-web/src/composed-reference-game-browser-api.ts`
- `dialogue-web/src/components/ComposedReferenceGameApp.tsx`
- corresponding contract/server/API/UI tests and localization strings

**Acceptance:**

- [ ] The schema exposes stable redacted connection/action state and remains strict about extra fields; it does not expose proof metadata or private process facts.
- [ ] The server mounts the single `game.resume` operation only when the coordinator callback is present; missing callback remains `not_found`, never a fake success.
- [ ] The API validates idempotency and the current attachment tuple only where it prevents a concurrent or stale cross-process command, then rereads authoritative state after command success/failure; it does not require a generic generation proof.
- [ ] The UI shows `disconnected`, `reconnecting`, `syncing`, `ready-actions-paused`, `unavailable`, and truthful `gameended` states.
- [ ] Resume click dedupes by the current attachment/attempt only where duplicate work would change a durable or live decision, cancel prevents stale completion, retry uses a new Resume attempt identity, and independent Chat controls remain unchanged.

## Slice 4: Explicit endgame and unknown-result closure

**User-visible result:** Only an explicit authenticated endgame operation can terminate Player; unknown action effects remain honest across reconnect.

**Owned paths:** current coordinator/bridge/Mod action receipt owners and focused tests, only after Slice 2 is green.

**Acceptance:**

- [ ] Ordinary close, AI crash, EOF, and reconnect failure never invoke Player termination or produce `gameended`.
- [ ] Explicit endgame performs graceful game exit when available, terminates only once if force termination is unavoidable, and projects `gameended` only from authoritative game state.
- [ ] A sent-but-unsettled action is queried/reconciled by its existing lineage owner; it is never replayed with a new identity.

## Verification matrix

- Focused TypeScript compile and `node --test --test-concurrency=1` for every changed Host seam.
- Native Guardian build and Windows disposable survival/recovery fixtures for Player survival and AI cleanup.
- Desktop focused source and integration tests for recovery relay and no Player CAS/termination.
- Browser contract/API/UI tests for strict schema, idempotency, state projection, cancel/retry, and independent Chat behavior.
- No real Stardew, SMAPI, provider, live action, runtime download, or live gate.

## Stop conditions

Stop and report a blocker instead of inventing a seam if the selected integration cannot attach the registered world binding without scanning or guessing, or if semantic conversation resync cannot be performed without reopening independent Chat. Do not solve either blocker by silently starting a different world, relaunching Player as a Resume side effect, reusing a closed activation's semantic lease, or adding a second production topology. Whether the integration recreates an AI process is implementation detail; stop only when it cannot establish the required new activation under its existing authority. Also stop any validation expansion when its claimed incident, owner, or decision boundary cannot be stated; classify the mechanism as `remove` or `merge` during the owner review rather than adding another proof layer.

## Execution order

- [ ] Slice 0: Cross-game Game session creation and world binding
- [ ] Slice 1: Integration-owned activation Resume authority (Stardew implementation after Slice 0 contract)
- [ ] Slice 2: Coordinator Resume state and action pause
- [ ] Slice 3: Browser contract/server/API/UI
- [ ] Slice 4: Explicit endgame/unknown-result closure

After each slice: run focused checks, inspect the actual diff, and perform one fresh review before starting the next slice.
