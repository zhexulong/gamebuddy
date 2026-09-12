# Stardew Action & Navigation Handoff

> **Audience:** the next agent continuing Stardew action release, Navigation publication, and BodyProgram work.
>
> **Read first:** `AGENTS.md`, `design/README.md`, `design/handbook/current-status.md`, `design/domains/stardew/integration.md`, `design/adr/006-verified-body-programs.md`, and `design/tasks/active/open-gameplay-release.md`.

## Current objective

The objective is to converge production use, bounded control verification, and the
first formal action gates onto **one registration-backed, Host-owned trusted
lifecycle**, then close the first published action gates without action-specific
runtime wiring. The Game surface also now has a cross-game session/resume design
precondition: Game UI must explicitly create or select a durable Game session,
optionally bind a continuity identity, and distinguish `Resume existing game` from
`Start new game`; neither path may scan or attach an external game. This is a
product/session boundary, not a Stardew-specific action path.

This handoff now tracks the complete **方案 A parallel implementation plan** for
converging the Desktop composition, cross-game GameSession/world binding, Windows
containment, and final browser-helper deletion. The plan is implementation work,
not evidence that any pending lane is already complete.

### 方案 A target topology and hard product semantics

- The final target is one formal Desktop composition that uniformly carries both
  Chat and Game. Desktop composition owns the long-lived Host product composition
  and presentation startup/close; Chat and Game remain independent product
  surfaces that may run concurrently and share only explicitly governed long-term
  Memory. There is no Chat-owned Game lifecycle and no Game-owned Chat lifecycle.
- Bootstrap performs runtime/generation admission, Host child authentication and
  the long-lived composition handoff only. It **does not decide or create**
  `GameSession`, activation, `fresh`/`known`, world binding, or selected Game
  integration. Those facts belong to the UI-driven GameSession owner and the
  selected integration adapter. `dataRoot`, bootstrap ID, generation, root layout,
  bootstrap lifetime and native launch facts are not substitutes for semantic
  authority or GameSession identity.
- Guardian is split into (1) reusable Windows containment infrastructure and
  (2) a Stardew-specific policy adapter. The infrastructure owns Windows Job,
  creation-time membership, drain, EOF/recovery transport and redacted outcomes;
  the adapter owns Stardew role policy, registration/attempt correlation,
  admission, reservation, launch recipe and product lifecycle semantics. Guardian
  itself is never a Stardew product/lifecycle owner.
- The physical helper/publication seam is destructively renamed from
  `windows-stardew-bootstrap-guardian` to `windows-bootstrap-guardian` (including
  native/source/build/publication paths and names as applicable), with **no old
  path fallback, alias, wrapper or compatibility read**. The Stardew lifecycle
  owner names remain Stardew-specific for now; this physical helper rename does
  not rename or relocate the Stardew lifecycle owner.
- Player/world survival is explicit: Player Host and its game world survive AI
  failure, controller EOF, Guardian failure and ordinary GameBuddy close. AI-only
  cleanup stops/drains AI authority and must not terminate, classify, recover or
  clear the Player world/parent fence. Player recovery is unavailable. Ordinary
  close is not `End Game`; only a separate authenticated explicit endgame may
  terminate the Player and project `gameended`.

The following are explicitly out of this plan: `ProductInputProducer`, a new
deployment-manifest authority, raw session/pipe/token/PID/Job/path handoff, a
 second product entry, a global registry/daemon/browser handoff, a generic
 fallback, a second Resume/reconnect API, action-runtime changes, and any live
 Stardew mutation. Do not add these to make a lane easier.

### Parallel lanes, ownership, dependencies and atomic commits

Each lane has one writer for its owned files. Lanes may prepare independent tests,
inventories and review material in parallel, but a connected authority seam is
implemented in dependency order. Every lane ends with focused validation, an
independent topology/security review, and one atomic commit containing only its
owned paths. Existing dirty WIP is not evidence for or against a lane and must
not be reset, stashed, cleaned, reformatted, or attributed to the current lane.

#### Lane 1 — Guardian policy split (Stardew policy adapter)

- **Owned files:**
  `host/src/games/stardew/lifecycle/stardew-bootstrap-guardian.private.ts`,
  `host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.core.ts`,
  `host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.internal.ts`,
  `host/src/games/stardew/lifecycle/stardew-private-bootstrap-owner-records.private.ts`,
  `host/src/stardew-production-lifecycle-coordinator.internal.ts`,
  `host/src/stardew-player-host-process-owner.ts`,
  `host/src/stardew-ai-client-process-owner.ts`, and corresponding focused tests.
  Keep the Stardew lifecycle owner names and product lifecycle files in this lane.
- **Dependency:** consumes the generic Windows containment contract/publication
  from Lane 2. The adapter and policy tests may use test-only closure-bound ports
  while Lane 4 is pending; only its final production delegation handoff consumes
  the Desktop composition/session. Lane 1 must not make the generic platform lane
  depend on Stardew.
- **Implementation order:** first write failing policy tests for Player survival,
  AI-only cleanup, explicit endgame, unavailable Player recovery, stale
  controller/settlement and no raw Guardian facts; then replace direct role
  spawn/kill authority with the narrow containment contract, preserving fresh
  admission, reservation, recipe, attachment, STOP, quarantine and lifecycle
  ownership. Create `RoleLaunchOperation` only after this lifecycle has completed
  fresh admission/preconditions and decided to launch.
- **Focused validation:** from `host/`, `pnpm run build:test`, the compiled
  Stardew policy/composer/process-owner/coordinator suites serially, the focused
  module-graph/physical-seam checks, and `pnpm run typecheck` when the worktree
  allows. Prove ordinary close/EOF/AI failure preserve Player/world, AI cleanup
  drains only AI, explicit authenticated End Game is separate, and recovery
  remains unavailable. No live Stardew.
- **Atomic commit:** `guardian-policy: tests + Stardew adapter/policy + owner
  delegation`, after Lane 2's reviewed generic contract is available and before
  Lane 4's final composition migration.

#### Lane 2 — Physical helper rename and generic publication

- **Owned files:** destructive rename of `host/native/windows-stardew-bootstrap-guardian/`
  to `host/native/windows-bootstrap-guardian/` and all native namespaces/project
  outputs; `host/src/windows-stardew-bootstrap-guardian/` to
  `host/src/windows-bootstrap-guardian/`; the corresponding `host/scripts/*guardian*`,
  `host/production-artifact.config.json`, `desktop/GameBuddy.Desktop/` admitted
  helper constants, fixture paths, publication descriptors and their focused tests.
  Update all current references in the renamed seam; do not edit unrelated dirty
  files merely to normalize names.
- **Dependency:** this lane precedes the policy adapter's generic infrastructure
  import and may proceed independently of GameSession and Desktop composition,
  provided it does not widen Guardian authority. Lane 1 consumes its generic
  contract; Lane 4 consumes its admitted artifact/publication result.
- **Implementation order:** introduce the neutral `windows-bootstrap-guardian`
  names in one tree-wide owned-path change, update canonical manifests/build
  outputs and inventory descriptors, then remove every old-path lookup. Do not
  retain a fallback, alias, wrapper, dual publication, compatibility import or
  Stardew-specific generic helper name. Keep Stardew lifecycle owner filenames and
  symbols unchanged unless Lane 1's policy boundary specifically requires a
  lifecycle edit.
- **Focused validation:** native build and deterministic Guardian fixture/live
  matrix; Host TypeScript build/tests for the renamed adapter/publication;
  Desktop admission/supervisor/broker tests; source-bound import/publication
  checks; `git diff --check` scoped to every renamed path. Assert the old path is
  absent from production publication and no alternate helper is admitted.
- **Atomic commit:** `guardian-physical-rename: destructive rename + publication
  inventory + focused native/Host/Desktop tests`, before Lane 1's final adapter
  commit and before Lane 4's runtime delegation commit.

#### Lane 3 — GameSession/world-binding resolver

- **Owned files:** existing semantic Game-session owner facade and focused tests
  under `host/src/continuity-semantic-production-coordinator/` and
  `host/src/continuity-semantic-store/`; the selected-integration private resolver
  and adapter contract under `host/src/games/`/`host/src/game-browser/` only where
  the source audit assigns them; `host/src/game-browser-contract/index.ts`,
  `host/src/game-browser/game-browser-state-provider.ts`, and their focused browser
  tests. Do not create a second store or generic Stardew fields in browser DTOs.
- **Dependency:** requires Lane 4's long-lived Desktop composition boundary for
  final startup wiring, but does not depend on Guardian policy or the physical
  helper rename for its semantic owner work. It consumes the existing semantic
  SQLite owner and selected published integration registry.
- **Implementation order:** finish the narrow integration-neutral SPI
  (`createWorldBinding`, `resumeWorldBinding`, fresh observation/capabilities and
  terminal-world-state reporting); resolve a selected durable `gameSessionId`
  only to its registered GameBuddy-owned binding; persist binding completion
  before projecting resumable. Missing/mismatched/terminal/unobservable binding
  is redacted `unavailable`/paused with Retry, Cancel and Start new game. Resume
  never scans processes/windows/paths/saves/timestamps, never attaches an
  external game, never replays old tasks/actions and never introduces a signed or
  hashed second proof layer.
- **Focused validation:** semantic owner/store tests from a fresh root, selected
  integration adapter contract tests, `game.resume` browser/state-provider and
  composed projection tests, and source-bound checks proving no process discovery,
  no external attach, no `game.reconnect` parallel API, no native facts in DTOs.
  Verify Chat remains untouched and independent.
- **Atomic commit:** `game-session-binding: owner facade + resolver/SPI + redacted
  browser projection/tests`, after the existing semantic owner is confirmed and
  before final presentation migration. This lane may commit independently of
  Lanes 1–2.

#### Lane 4 — Desktop composition for Chat + Game

- **Owned files:** `desktop/GameBuddy.Desktop/Program.cs`,
  `desktop/GameBuddy.Desktop/RuntimeSupervisor.cs`,
  `desktop/GameBuddy.Desktop/DesktopHostBootstrapBroker.cs`,
  `desktop/GameBuddy.Desktop/GuardianSupervisor.cs` and focused Desktop tests;
  `host/src/bootstrap/entry/desktop-host-entry.internal.ts`,
  `host/src/bootstrap/wire/desktop-runtime-bootstrap.internal.ts`,
  `host/src/composition/desktop-host-composition.ts`,
  `host/src/deployment-manifest.ts` only when consuming its existing authority
  contract (not creating a new authority), and focused composition/bootstrap
  tests. Lifecycle handoff consumers are coordinated with Lane 1, not copied into
  this lane.
- **Dependency:** consumes the exact admitted neutral Guardian artifact from
  Lane 2, the existing Host deployment/semantic authority contracts, and Lane
  1's reviewed typed policy/delegation seam. It may expose only typed
  closure-bound capabilities. Lane 3 consumes this composition for final startup
  wiring; Desktop bootstrap itself must not decide any lane's product facts.
- **Implementation order:** keep Phase 1 runtime admission, exact Host child
  authentication, root-layout revalidation and long-lived composition handoff;
  add composition-owned startup/close for both existing Chat and Game services;
  route selected Game integration and GameSession Create/Resume only from the
  Game UI owner; keep `dialogue-web-main` as a temporary helper until final
  acceptance. Close stops AI authority and drains presentation without ending
  Player/world; failures propagate and cannot be reported as success.
- **Focused validation:** Desktop broker/supervisor admission and EOF tests;
  Host bootstrap/composition tests; Chat and Game concurrent startup/close,
  independent-surface and redacted-projection tests; source-bound checks that
  Bootstrap has no `GameSession`/`fresh`/`known`/selected-integration decisions,
  no `ProductInputProducer`, no raw session handoff, and no second entry.
- **Atomic commit:** `desktop-composition-chat-game: formal root + long-lived
  composition + lifecycle handoff tests`, after Lane 2's artifact acceptance and
  before Lane 5's deletion. It must not silently implement Lane 1's policy or
  Lane 3's resolver.

#### Lane 5 — Final `dialogue-web` deletion

- **Owned files:** `host/src/dialogue-web-main.ts`, its sole entry/config/import
  references, and only the focused artifact/module-graph/browser tests that name
  that entry. If a generated publication manifest names it, update the owning
  publication configuration in the same atomic commit; do not leave an alias.
- **Dependency:** last lane. Requires Lane 3's `game.resume` owner callback and
  world-binding resolver, Lane 4's composition-owned Chat+Game presentation
  startup/close and exact concurrency tests, and a clean import/publication
  inventory proving no caller remains. It is blocked until both surfaces work
  through the formal composition.
- **Implementation order:** move the existing browser listener/presentation
  wiring into composition-owned startup, delete `dialogue-web-main.ts` and its
  entry/import/config references in one destructive change, remove wrappers,
  aliases, second entries, global registries and fallbacks, then update source-bound
  tests to assert absence rather than compatibility.
- **Focused validation:** fresh artifact build/publication, Host module graph,
  Chat/Game browser and close/error propagation suites, `game.resume` projection
  suites, and scoped `git diff --check`. Confirm exactly one Desktop composition
  root and zero `dialogue-web-main` production references.
- **Atomic commit:** `remove-dialogue-web-entry: composition migration + destructive
  helper/entry deletion + focused artifact/module-graph tests`, only after Lanes
  3–4 are reviewed and accepted.

**Commit/dependency order:** Lane 2 publication → Lane 1 Guardian policy and
Lane 3 GameSession resolver may run in parallel after their predecessors → Lane 4
Desktop composition and integrated Chat+Game verification (consuming Lane 1's
reviewed policy seam and Lane 2's accepted artifact) → Lane 5 final
`dialogue-web` deletion. Lane 1's policy tests and adapter work may begin before
Lane 4, but its production session handoff is not accepted until Lane 4's typed
composition boundary is green. Every commit is atomic and must stage only that
lane's owned paths. If the existing dirty worktree
contains overlapping edits, first record the overlap and attribute no hunk to a
lane without source-bound evidence; preserve the WIP and split/rebase the lane
rather than resetting it.

### Parallel-lane review and worktree safety

Before a lane's commit, capture `git status --short`, `git diff --stat` and
`git diff --cached --stat`; use `git diff --check -- <owned paths>` and the lane's
focused tests. A pre-existing failure or dirty hunk is residual only when it is
shown to predate the lane, lies outside owned paths, and all scoped gates pass.
Never use `git reset`, `git clean`, `git stash`, broad checkout/restore or mass
formatting to make a lane appear green. A lane cannot claim completion from a
source-only inventory, fixture, mock, Preview, direct/native-local route or an
unrelated dirty WIP. The final review must independently confirm the target
composition, Player/world survival and no-fallback/destructive rename rules.

```text
Game UI integration + optional continuity choice
→ existing Game-session persistence owner
→ selected Game integration creates or resumes its private world binding
→ minimum binding handshake + current observation
→ redacted resumable Game projection
→ Game action admission only after a new Game instruction
```

The cross-game Game-session slice is no longer just a search task: the existing
semantic SQLite Game-session metadata owner has been located and the `game.resume`
contract/transport/UI waiting semantics have partial slices, but the private world-
binding resolver and adapter Resume SPI are still missing. Do not add a parallel
store, promote Stardew launch facts into the generic browser contract, scan for an
external game, or claim Resume from the currently declared-but-unwired
`game.reconnect` operation. A new activation may reuse an available AI process or
create one through the selected integration's existing authority; that
implementation choice is not a second Resume operation or a new proof layer.


```text
published Host generation → Desktop exact Host child → Host root-layout capability
→ Guardian/containment → ready installation registration → request-local admission
→ profile-free Host control runner → published live capability surface
→ action-owned receipt/evidence/postcondition/cleanup gates
```

### Frozen Shape B seam

The game-facing contract exposes only a typed/private game-facts producer capability; it never exposes `Uint8Array` or native private-frame bytes. Its exact launch signature is `ContainedGameRuntime.launchRole(role: ContainmentRole, operation: RoleLaunchOperation, produceAuthorization: TypedPrivateGameAuthorizationProducer): Promise<RedactedRoleLaunchOutcome>`. `RoleLaunchOperation` is private and per-invocation, created by the game lifecycle only after fresh admission/preconditions and the launch decision; only `launch_role` carries its deadline. The producer receives/uses typed private game facts or capability and never accepts or returns native frame bytes. Host composition privately binds the selected game producer to a platform encoder/private launch transport and authenticated session. The generic runtime core owns one-shot authorization, role/deadline binding, serialization, terminal states, and redacted outcomes, but does not know game facts. Platform/auth modules alone handle native frame bytes. Chat and Game lifecycles remain independent; this adds no global registry, daemon, browser handoff, fallback, hash, signature, or redundant gate.

The old `Uint8Array` producer and deferred launch plan are explicitly migration-before material. They are not compatibility, fallback, or parallel production authority; the file carrying the old callback has been removed, but the semantic boundary (composition-owned encoder/private transport versus the core holding native frame serialization) remains unaccepted and must be closed with dedicated compiled tests before Shape B implementation acceptance.

### Cross-game containment architecture (current)

The long-term seam is the generic Host-private `ContainedGameRuntime`, owned by Host composition rather than a Stardew-specific Desktop/Guardian composition. Its only narrow game-facing contract is `host/src/containment/runtime/contract/game-runtime.ts`; implementation-private `host/src/containment/runtime/core/contained-game-runtime.ts` is imported only by `host/src/composition`, which may assemble one selected game adapter; public/browser/runner cannot import composition. Its fixed physical directories are `host/src/bootstrap/{entry,wire,roots}`, `host/src/containment/runtime/{contract,core}`, `host/src/games/stardew/{lifecycle,launch,bridge}`, and `host/src/composition`. It consumes a one-shot opaque game-owned launch authorization and returns redacted launch/containment outcomes through a narrow private lifecycle seam. Stardew supplies only a typed/private authorization capability whose game-owned facts remain inside the composition closure; it does not supply native private-frame bytes. The runtime privately derives, encodes, and consumes the native frame, while the opaque authorization remains an internal runtime capability and native private frame bytes never cross the game-facing seam. A role means only the OS process role `player_host` or `ai_client`, not an in-game NPC or AI companion. Game runtime duration is lifecycle termination, STOP, or crash—not a timeout. Each game lifecycle owns installation admission, role recipe, reservation, attestation, STOP, recovery and product state, and creates one per-invocation `RoleLaunchOperation` deadline only after fresh admission/preconditions and the launch decision. Only `launch_role` carries that deadline. Arm/contain/recover use transport/operation wait budgets only if their wire requires them; those budgets are neither launch deadline nor game lifetime. Bootstrap timeout, browser admission expiry, and owner/attempt expiry must not be reused, while every other budget requires a distinct failure model and owner. The seam exposes no raw session/pipe/PID/Job/token/path and uses no global registry/daemon/browser handoff or fallback. Windows Guardian is a platform containment adapter; it must not know Stardew, SMAPI, Mod/catalog/action names or game recipes. Stardew is the first consumer, and `equip_tool`/`till_soil` remain unchanged action inputs. Each directory-local `README.md`, when the directory lands, defines `Owns`, `Does not know`, `Dependency direction`, `Placement and move rule`, and `Required verification`; this handoff does not create README files. See [ADR-0007](design/adr/0007-contained-game-runtime-and-game-owned-launch-authorization.md).

The ownership boundary is explicit: Stardew-specific process-owner implementations and their results belong under `host/src/games/stardew/lifecycle`, specifically `stardew-process-implementations.ts`, `stardew-player-host-process-owner.ts`, and `stardew-ai-client-process-owner.ts`. The already-relocated Stardew process-owner paths must not return to `host/src/containment/windows`; their old paths are migration-before state only. Other still-current Stardew authority files (including installation registration, installation admission, and the lifecycle coordinator) may remain at `host/src/stardew-*` until a separately approved physical relocation; they are not generic-layer owners. Stardew may import only `host/src/containment/runtime/contract/game-runtime.ts`; it must not import runtime/core, auth transport, bootstrap roots, Desktop/Guardian/Windows/native. `host/src/containment/runtime/core/contained-game-runtime.ts` is Host-private and composition-only; only generic `bootstrap/**` and `containment/runtime/**` must never import Stardew; composition may assemble the selected adapter. The staged move of `stardew-process-implementations.ts` out of `containment/windows` is therefore intentional relocation into the Stardew lifecycle owner, not deletion. Runtime lifetime remains lifecycle-owned termination/STOP/crash; it is never represented as a timeout. Non-launch budgets are concrete transport/operation waits: arm is owned by the generic runtime/Guardian operation and yields `arm unavailable` with no launch; contain is owned by generic runtime/Guardian cleanup and yields `containment uncertain`/quarantine, never success; recover is owned by the Guardian recovery state machine and yields `recovery unavailable`/held while the old lease remains authoritative. These are not game lifetime or launch deadline.

The separation is a hard architectural obligation, not a Knip result. Knip is reachability/orphan inventory only. dependency-cruiser and source-bound tests are the TypeScript gates: the former rejects containment → game imports/cycles, the latter rejects public/dynamic authorization seams and direct role spawn. ArchUnitNET applies only after an actual stable C# namespace seam exists. Windows integration tests prove one-shot authorization, EOF cancellation, containment and redacted outcomes as real process semantics.

`equip_tool` is an already published native action and a migration input, not a
prototype to be redesigned. It is **not** a BodyProgram runtime action, tracer,
scheduler target, production fact producer, or native-kernel target. This correction
is recorded in design commit `62fdd3e`. A second, already published action from a
different family must traverse the resulting generic path with **zero action-runtime
changes**; choose it from the real Mod-advertised capability surface, not from the
legacy action-development registry.

Navigation is a real product target. The user chose the end-state **complete Navigation publication and live run**, not permanent withdrawal. Do not run the old direct/native-local Navigation smoke route as a substitute for formal admission; it is not the current live gate.

## Non-negotiable live-mutation discipline

Before any target mutation:

```text
non-mutating preflight
→ complete required deterministic/offline evidence
→ aggregate independent review with no blocker
→ explicit live authorization
→ one serial target mutation
→ receipt/postcondition/cleanup/evidence finalization
```

Do not start Stardew, acquire a runtime lease, prepare or restore a fixture, or invoke a live action until every preflight item is proven. Do not retry an uncertain live mutation with a new identity.

The former documented `equip_tool` commands accepting `--profile` are native-local
candidate wiring and are no longer valid control-live instructions. The production
registry presently returns `BLOCKED: host_runner_not_registered` for `run-live`,
regardless of whether a profile is supplied. Do not use `action:preflight` or
`action:run-live` with a profile to launch or mutate a target.

The future control command is intentionally not named until the registration-backed,
coordinator-owned Host runner, fixture boundary, and cutover are implemented and
accepted. Do not invent an alternate devkit command or bypass the current blocked
state.

### `equip_tool`: published native action; legacy control wrapper BLOCKED

`equip_tool` remains a Mod-catalog `Published` execution action (`body_tools`,
`slot: integer`) with its existing native handler, game-thread policy, bridge
contract, receipt/evidence, and postcondition semantics. **Do not modify those action
runtime seams to perform this migration.**

What is blocked is only the historical action-development control wrapper:

```text
profile → fixture/lease/release-bundle → PowerShell/SMAPI/local bridge → equip_tool
```

The prior readiness audit correctly established that no real legacy target profile
or publication manifest was available. That is no longer the prerequisite to pursue:
the current architecture has superseded the profile-based native-local control route.

The current source is fail-closed for that wrapper:

```text
integrations/stardew/action-development/src/action-registry.mjs
→ equipToolActionRegistration.blockedPolicy: host_runner_not_registered
```

This status was introduced by `9413fde` when it removed only
`runEquipToolRegistration → runEquipToolLive`; it did not modify the Mod's published
`equip_tool` capability. The action-development registry currently contains only
this historical wrapper and is neither the product capability catalog nor the future
Host control-runner action directory. A supplied `profileFile` does not change the
blocked wrapper result and must not be used to recover or bypass it.

Required prerequisites for the future profile-free control gate are:

```text
1. Completed registration-plan and guardian/bootstrap containment prerequisites.
2. Coordinator-private fixture prepare/restore boundary.
3. Host-owned one-shot control runner using the shared private lifecycle core.
4. Atomic deletion of the native-local profile/lease/fixture route.
5. Successful non-mutating factual preflight against the registered target.
6. Aggregate independent review and explicit project-owner authorization.
```

`gamebuddy-action-target-profile/v1` is legacy action-development-local harness
configuration. It must never be imported, translated, or adopted into the product
registration record or control start/result protocol. Its `timeoutMs` is a
native-local harness timeout and must be deleted with that route, not moved into
registration. The future bounded control intent instead carries `deadlineEpochMs`;
Host derives the admitted action deadline and identities after attachment.

The installation registration's desktop binding is only `rootLayoutVersion: 1`.
`productInstallationId` is unowned and must not appear in registration schema,
fixtures, validation, serialized records, or control protocols; records carrying
it are rejected rather than migrated or compatibility-read.

### Generic action migration invariant

The new lifecycle/control path must accept only a Mod-authoritative live capability,
its existing descriptor, the action ID and the existing arguments. It must not
import, branch on, or special-case `equip_tool`; it must not use
`equip-tool-live.mjs`, `equip-tool-preflight.mjs`, `profile.mjs`, an action-specific
fixture/lease, or the legacy PowerShell child. If either `equip_tool` or the selected
second published action requires a change to its Mod handler, descriptor, protocol,
policy, receipt, or postcondition to reach the generic path, stop: that proves a
generic lifecycle/control-runner defect, not an action migration task.

### Navigation: BLOCKED

Current design says all three Navigation operations are not live-closed; `navigate_to_destination` is explicitly withdrawn pending its own generic ordinary-pipeline conformance and separate gate.

The intended eventual state, per the user, is complete publication and a formal serial Navigation live run. That requires an explicit republish decision after the following have closed:

```text
- accepted multi-source/topology characterization
- digest-bound passed production receipt
- Task 5D / Task 5E acceptance evidence
- aggregate independent review
- Navigation-specific formal target profile/runbook/preflight
- explicit re-publication decision
- separate explicit target-mutation authorization
```

The existing mutation-capable runner:

```text
tools/run-stardew-native-local-player-navigation-mutation-smoke.mjs
```

is a legacy/direct native-local smoke route. It is not the formal current Navigation live gate and must not be used to bypass withdrawal.

A safe no-path preflight was run only to establish a negative result:

```text
node tools/preflight-stardew-navigation-agent-live.mjs
→ BLOCKED: game-path and release-dir are required strings
→ mutationCount: 0; executionReceiptCount: 0
```

This does not establish target readiness.

## Navigation authority contradiction — resolve before republish

Current design authority conservatively says all of:

```text
inspect_world_map
find_destination
navigate_to_destination
```

are not production-materialized/live-closed. However current Mod source currently registers all three as published actions, and the normal v1 policy path can enable them. This produces a live Mod→bridge→Host projection despite the documented withdrawal state.

The next agent must create one authoritative reconciliation decision and then a single fail-closed withdrawal/republish plan. The future target is complete Navigation release, but immediate source must not be treated as approval.

Until republish admission is explicit:

```text
- Mod catalog/default policy must not publish unclosed Navigation operations.
- Host/tool/schema source is permitted only as a restrictive unavailable projection.
- Source presence, fixtures, schemas, or offline tests do not authorize a live run.
- Do not add destinationRef compatibility; the public selector key is only ref.
```

Required documents for this reconciliation:

```text
design/36_STARDEW_RUNTIME_NAVIGATION_AND_INTERACTION_READY_MOVEMENT.md
design/94_STARDEW_NAVIGATION_MULTIHOP_RECOVERY_IMPLEMENTATION_PLAN.md
design/tasks/active/open-gameplay-release.md
design/adr/006-verified-body-programs.md
```

## BodyProgram status

BodyProgram Core/protocol foundations were advanced, but production composition is not complete.

### Completed Core foundations

Recent relevant commits include:

```text
2724a9c Complete Stardew BodyProgram bridge protocol
8bc1aff feat(stardew): persist body program execution lineage
0f511cb Fix BodyProgram completion binding lineage
d507226 fix: allow factless body program success
3696b00 fix: require exact body program fact sets
```

Current invariant:

```text
descriptor declares zero output facts
→ success must have zero RuntimeFacts

descriptor declares N output facts
→ success must have exactly the complete declared fact set,
  matching names/types and exact producing program/node/attempt provenance
```

Execution lineage is exact:

```text
{ programId, nodeId, nodeAttempt, requestId, idempotencyKey, executionId }
```

A terminal success requires a matching terminal succeeded receipt, non-empty action-specific evidence, and a fresh passed action-specific postcondition. Host/latest receipts, route results, `TryRoute`, evidence text parsing, or transport success are never substitutes.

### Do not resume BodyProgram runtime with `equip_tool`

`equip_tool` was briefly and incorrectly proposed as a BodyProgram tracer. This was reversed in design. Keep it outside BodyProgram runtime.

The first real Body Program A→B pair is frozen as A=`machine_inspect` (read-only) → B=`machine_load` (real native mutation). A declares the typed output fact `machine_target_id` (`string`, the action-verified opaque machine target identity); A may not write the world but still requires an action-owned receipt, non-empty action-specific evidence and a fresh passed postcondition. B's `expectedTargetId` argument must bind via RFC 6901 to A's exact `{programId,nodeId,nodeAttempt}` `machine_target_id` RuntimeFact, and B must be the real native mutation. Navigation, `equip_tool` and synthetic/development-only/final-acceptance evidence cannot satisfy any part of that A→B proof shape. The live release stays separate: only the single explicitly authorized target-version serial gate (open-gameplay-release Task 6) may run the frozen player request through the real Main Pi Agent on the production topology; this handoff does not announce that gate closed.

### Production composition blockers

Do not wire `ModEntry`, `BridgeSession`, the four `program_*` handlers, or scheduler yet unless their upstream contracts are actually closed:

```text
- documented target-version Stardew per-user data-root admission
- fresh root identity/reopen proof for BodyProgram journal storage
- Mod lifecycle ownership and Saving/ReturnedToTitle quarantine fence
- Mod-owned catalog + policy identity composition
- private authenticated program bridge topology
- real product action native receipt/evidence/postcondition producer
- receipt-backed scheduler and cancellation/recovery semantics
```

`WindowsBodyProgramJournalStore` is lower-level persistence mechanics; it is not a root-discovery/admission authority. Never pass it guessed AppData, installation, Mods, Host GameBuddy data root, or SMAPI global-data paths.

## Action-development closure status

The canonical Mod descriptor/source closure was completed and reviewed. Important commits:

```text
eedc415 Complete Stardew action development source closure
0cea991 fix(stardew): align standalone action projection
6eaea80 Fix standalone action projection producer root
d6528b6 Fix action source projection gate authority
```

(Use `git log --oneline` to resolve/check exact hashes; worktree can contain unrelated dirty changes.)

The closure uses:

```text
Mod registrations
→ gamebuddy-action-descriptors/v1 artifact with numeric catalogRevision
→ package and standalone consumers
→ restrictive Host-supported executable intersection
```

Read-only and experimental descriptors remain metadata partitions; Host/gate projection cannot expand them. Gate descriptors are integrity metadata, not executable membership authority.

## Worktree / Git rules

The repository and design repository are intentionally dirty from independent lanes. Preserve unrelated changes.

Before any commit:

```bash
git status --short
git diff --stat
git diff --cached --stat
```

Stage only exact owned paths/hunks. Keep one rollbackable behavior and direct tests in an atomic commit. Do not reset, stash, restore, clean, or broadly reformat the worktree.

Design repository has many unrelated dirty/current files. Commits were made in its own Git repository; do not assume project-root Git status includes design changes.

## Desktop ↔ Guardian ↔ Host completion slice card (2026-09-01)

**User-visible result:** the admitted formal Desktop Host entry is the only process
that can authenticate a resident Guardian broker session; a private Host owner then
uses only the closure-bound session to request exact redacted Guardian acknowledgements.
Desktop retains Guardian process, stdin EOF, ingress, paths, tokens and handles;
Guardian retains OS containment; Host retains durable lifecycle semantics.

**In scope:** current `TASK-WINDOWS-DESKTOP-RUNTIME-SUPERVISOR-GUARDIAN-BROKER`
Tasks 1–3 and containment plan Tasks 3–4, including source-bound disposable
Desktop/Host/Guardian evidence and independent reviews. **Non-goals:** installation
registration/control runner/profile cutover/action execution/live Stardew.

**Accepted first-owner decision (corrected after review):**
`DesktopPrivateHostComposition` is the first real mutable owner. It is constructed only
through the private bootstrap wire (`host/src/bootstrap/wire/desktop-runtime-bootstrap.internal.ts`)
invoked by the formal Desktop Host entry; the wire atomically consumes the minted
`WeakSet`-branded, one-shot opaque root and guardian capabilities (rejecting forged/replayed
objects) and authenticates the one Guardian session before constructing the composition,
which owns the Desktop-bound Guardian-session lifetime and exposes only a closure-bound
`DesktopGuardianSession` to later private Stardew composition.
It cannot use a module-global or production-exported test factory: only the exact
Host child can derive the broker pipe from its private bootstrap binding and complete
strict `hello` before bootstrap acknowledgement. It creates no
Chat/Game/browser/provider/installation/action runtime and is not an inert
placeholder: it owns the one authenticated local session and must close it before
process termination. `main.ts`, browser entries, Chat, Preview and direct product
composition cannot mint, receive or substitute its capabilities. The later
coordinator/private composer remains the sole product lifecycle owner and may use
that session only after its own lawful lifecycle admission.

**Hard predecessor:** the formal Host entry/root-validation slice is green. Do not
hand a Guardian session to an inert bootstrap process or bypass
`DesktopPrivateHostComposition`; no second entry, raw pipe/token/root exposure, or
synthetic owner is allowed.

**Acceptance scenario:** Given a selected immutable generation and its exact Desktop
Host child, when that child validates the private bootstrap and its first private
owner authenticates the one Guardian session, then only that owner receives redacted
`arm/launch/contain` acknowledgements after matching native acknowledgements; and
on malformed/replayed/cross-session traffic, Host loss or EOF, Desktop closes Guardian
control and no durable success is projected.

**Authority/seams:** one writer owns the connected formal-entry → first-owner →
Desktop broker integration. Independent lanes may own (a) broker/Guardian fixture
and rejection matrix, (b) Task-3 process-owner delegation tests/implementation after
broker acceptance, and (c) static leak/review matrices, only once each has a named
producer→consumer→verifier path and disjoint files. No live mutation is authorized.

## Immediate next sequence

1. **Do not run a live gate or profile-based preflight.** Do not request, create, or
   use a real `equip_tool` target profile. Its native-local route is legacy
   candidate wiring, not a valid control path.
2. Close the trusted startup predecessors in dependency order: published Host
   generation → Desktop exact child → Host fresh root-layout capability →
   Guardian/containment. Keep one integration writer per connected authority seam,
   while running independent consumer inventories, test-matrix, CI-evidence and
   adversarial-review lanes in parallel.

   **Accepted Host-entry topology:** Desktop will launch only
   `runtime/node.exe desktop-host-entry.internal.js`. That entry is the one formal
   Desktop Host entry; it calls the private `desktop-runtime-bootstrap.internal.js`
   frame/root admission helper, then acknowledges and remains the admitted Host
   lifetime. The old fixed entry name has no alias. `main.ts`, dialogue, preview,
   browser and CLI roots remain non-Desktop entrypoints and cannot mint/receive the
   opaque root capability. Do not export the capability, spawn/replace into `main.ts`,
   or import normal product composition into the bootstrap helper.

   The current task's disposable-fixture constraint forbids opening a product owner,
   Guardian, installation, provider, browser or Stardew. Therefore it must not create
   an inert placeholder owner merely to consume the capability. The entry proves
   capability mint/revalidation; the bootstrap wire then consumes the root and guardian
   capabilities and constructs the accepted first capability-gated owner
   (`DesktopPrivateHostComposition`) around the one authenticated Guardian session.
   Guardian/control work may proceed only through that wire while the later
   coordinator/private-composition handoff remains its own open slice.

   **Entry-split evidence (current workspace):** `desktop-host-entry.internal.ts`
   now owns the sole `import.meta.main` guard and statically imports the non-executable
   helper. The artifact config/publisher and Desktop admission agree on
   `desktop-host-entry.internal.js`; no old fixed identity remains in that contract.
   Focused Host build/publisher/entry tests passed (78 total, 69 passed and 9
   approved-runtime-acquisition skips). Focused Desktop tests first exposed and fixed
   the fixture-only incompatible `PublishAot` + `PublishSingleFile` declaration, then
   stopped before entry assertions because the canonical publisher's browser build
   cannot obtain its required published Windows reparse-inspector
   (`windows_reparse_inspection_unavailable`). This is an external fixture-publication
   prerequisite, not an accepted Desktop entry failure; diagnose/restore that owned
   artifact without fallback, then rerun the Desktop matrix and independent review.

   **Entry closure review resolved:** publisher verification now includes the frozen
   `desktop-host-entry.internal.js` descriptor as a private verification root and
   recursively verifies its static helper closure. It neither adds the entry to public
   `entryRoots` nor uses a broad JavaScript exemption; old
   `desktop-runtime-bootstrap.internal.js` and unrelated unreachable JS still reject.
   Focused publisher tests passed (60 pass, 1 platform skip), followed by independent
   review with no findings. The first Host→Dialogue explicit URL handoff was rejected
   by canonical fixture evidence: the emitted adapter did not export the requested
   build capability, and review found its URL descriptor could name another run plus
   browser build/timeout still resolved commands through `PATH`. The first successor
   fixed the exported build capability and stripped PATH from the child environment,
   but canonical fixture evidence then found Host's post-Vite verifier did not reuse
   the adapter policy; independent review further rejected its generated `file:`
   import specifiers and Windows `.CMD` wrapper (which still resolves `node` through
   PATH), plus fire-and-forget timeout `taskkill`. The active successor must use
   generated relative static imports, direct `process.execPath` + repository `vite.js`
   on all platforms, awaited verified absolute `taskkill.exe`, and one
   Host-constructed adapter policy shared by Vite/post-build verification. Canonical
   fixture publication subsequently exposed and closed a missing default taskkill
   resolver and an obsolete Windows `windowsVerbatimArguments` flag that broke direct
   `process.execPath` invocation. Canonical generation now passes and the focused
   Desktop admission/bootstrap matrix is green (25/25). The minted root capability now
   has its approved consumer: the bootstrap wire consumes the root and guardian
   capabilities and constructs `DesktopPrivateHostComposition` as the first mutable
   owner, which owns and must close the authenticated Guardian session before process
   termination. A final independent review found no concrete blocker in the
   fixed-entry/runtime-admission/direct-Node-Vite/bootstrapping slice; the earlier
   "no approved mutable-owner consumer" limitation is superseded by that wire. Do not
   construct an inert placeholder, mint capabilities outside the wire, or add a second
   entry or consumer.
3. In parallel, inventory the real Mod-published capability surface and freeze
   `equip_tool` plus one different-family published action as **no-action-runtime-
   change migration invariants**. Do not add the second action to the legacy
   action-development registry.
4. Complete registration/containment closure, coordinator-private fixture boundary,
   Host-owned profile-free control runner, profile-boundary inventory/tests, and
   atomic removal of the old profile/lease/fixture route. Until then, retain
   `host_runner_not_registered` only for the historical wrapper.
5. After that route is implemented and independently reviewed, run its named
   profile-free factual preflight against a ready registration; capture every
   readiness result before seeking live authorization.
6. Resolve the Navigation current-authority contradiction: document current
   withdrawal, remove live publication paths if required, then close its multi-hop
   ordinary pipeline/recovery evidence and formal republish prerequisites.
5. Request one explicit Navigation republish decision and a separate serial
   live-mutation authorization.
6. Run serial gates only after their individual readiness/review conditions are
   green:

   ```text
   equip_tool profile-free preflight → equip_tool live run → evidence/cleanup
   afterward:
   Navigation preflight → Navigation live run → evidence/cleanup
   ```

7. Resume BodyProgram production composition only after the two action gates and
   the documented-root/lifecycle/native-action prerequisites are closed.

## Primary documents

```text
AGENTS.md
design/README.md
design/handbook/current-status.md
design/domains/stardew/integration.md
design/adr/006-stardew-action-development-control-live-owner.md
design/architecture/stardew-installation-runtime-registration-plan.md
design/tasks/active/stardew-action-development-platform-convergence.md
design/adr/006-verified-body-programs.md
design/tasks/active/open-gameplay-release.md
design/36_STARDEW_RUNTIME_NAVIGATION_AND_INTERACTION_READY_MOVEMENT.md
design/94_STARDEW_NAVIGATION_MULTIHOP_RECOVERY_IMPLEMENTATION_PLAN.md
integrations/stardew/action-development/ACTION_RUNBOOK.md
```

## Evidence locations

Read-only live readiness artifacts from this session:

```text
D:/PiData/agent/sessions/--E--projects-ai-game-companion--/subagent-artifacts/outputs/965f2712-2701-48c6-bba8-26b3b421a188/artifacts/equip-live-readiness.md
D:/PiData/agent/sessions/--E--projects-ai-game-companion--/subagent-artifacts/outputs/473cfb0a-c334-4d88-aff9-92876788aa7b/artifacts/navigation-live-readiness.md
D:/PiData/agent/sessions/--E--projects-ai-game-companion--/subagent-artifacts/outputs/b9fe0c79-b900-46a2-9cb3-42ca616af9b8/artifacts/action-development-readiness.md
D:/PiData/agent/sessions/--E--projects-ai-game-companion--/subagent-artifacts/outputs/1bb74908-18a8-43fc-988d-d7c5484bd7c6/artifacts/navigation-authority-reconciliation.md
```

## Game session creation / Resume boundary (current)

The product meaning of Game Resume is the same as Chat Resume: reopen a
persisted Game session in a new activation. It is not a bridge retry, an AI-only
restart command, or an old-task continuation. Automatic reconnect after a
controller interruption, reopening GameBuddy, and a player selecting Resume all
use the same resume pipeline.

A Game session has three separate layers:

- `Game session`: durable product record, analogous to a Chat thread;
- `Game activation`: one runtime opening of that record;
- `world binding`: a Game-integration-owned association with a GameBuddy-owned
  game instance, kept private except for redacted status.

Creating a new session is a user-visible flow. The UI displays the published
Game integration choice, an optional continuity identity choice (default
unbound), the effect that only governed long-term Memory may be shared, and
creation/binding/observation progress. The backend may project the session as
resumable only after the selected integration, requested continuity binding, and
new world binding have all succeeded and been durably recorded by the existing
Game-session persistence owner. No new parallel store is allowed.

Resume first attempts the selected session's registered GameBuddy-owned world
binding. It must not scan processes or attach an external game based on title,
PID, path, launch time, or matching installation. If the binding cannot be
verified, the UI offers `Retry`, `Cancel`, and `Start new game`; it must not
silently create a new world. `Start new game` creates a new Game session/world
binding and can ask for a new continuity choice, but it never migrates old
world, action, task, bridge, or launch authority. A selected integration owns
creation, rebinding, the minimum attachment handshake needed to confirm the
registered binding, fresh observation, capability read and terminal-world facts;
Stardew is one adapter, not the generic contract.

The generic browser contract may expose only redacted integration/session/world
status. It must not expose installation paths, PID/Job, pipe/token, native
frame, launch generation, reservation, or adapter-private facts. Existing
`game.reconnect` is not a second product API; until the full `game.resume`
contract and owner callback are wired, it remains not wired.

### Stardew exact-auth and projection-liveness slice status (2026-09-11)

Current source state has closed the narrow Stardew connection-authentication and
retained-projection liveness slice. This is a prerequisite safety boundary for
Resume/fresh activation work, not a Resume implementation.

Completed behavior:

```text
launcher-owned authenticated Stardew bridge
→ exact frozen connection wrapper minted once
→ adapter entry points assert that exact wrapper and current liveness
→ structural copies / forged wrappers / closed connections reject
```

Specific closed boundaries:

- `host/src/game-connection.ts` is back to a type/facade-only role for Stardew; it
  must not export a registrar, mint function, WeakMap, or liveness predicate.
- The authenticated `WeakMap` and registrar are lexical to
  `host/src/stardew-integration-launcher-body-program.internal.ts`; only the narrow
  `assertAuthenticatedStardewConnection()` assertion is exported for the adapter.
- `host/src/stardew-game-integration-adapter.ts` gates `actorId`, identity binding,
  `worldScope`, tool creation, `status`, `readState`, and `cancelExecution` through
  the exact-auth assertion before reading scope/state or dispatching work.
- Native `invalidated` receipts freeze the execution gate and publish the wake, but
  do **not** close the native pipe, cancel, retry, replay, or synthesize completion.
- Newly requested preview/materializer ports and already-retained `presentation` /
  `bodyProgram` projections fail closed after invalidation, explicit close, or bridge
  disconnect, before forwarding any native frame.
- The retained-projection guard is shared; individual method-by-method tests remain
  optional follow-up coverage, not a new authority requirement.

Focused evidence already collected for this slice:

```text
pnpm typecheck                         → pass
pnpm build:test                        → pass
compiled focused suites                → 56/56 pass
retained projection focused coverage   → 32/32 pass
git diff --check                       → pass
merge conflict scan                    → none
independent review                     → approve / no blocker
```

The lock failure seen during validation was `host_test_artifact_lock_ownership_lost`
from a dead build process. Only the stale lock for the confirmed-dead PID was reclaimed;
other worktree test processes were not killed.

This slice does **not** prove any of the following:

- complete Game Session Resume;
- complete Stardew production lifecycle;
- Desktop↔Guardian role delegation;
- live target readiness;
- cleanliness or acceptance of the whole dirty worktree.

### Multi-game and third-party integration clarification

The product must support multiple games, including GameBuddy-compatible Mods and
integrations authored by third parties. This is a current architectural requirement,
not a reason to hard-code Stardew until a later rewrite. Generic session creation,
selection, binding and Resume must dispatch through the selected admitted integration;
Stardew's dual-process topology, file artifacts and launch recipe are not universal
integration requirements. Third-party authorship does not by itself mean an external
or unregistered world, and GameBuddy-owned binding does not mean first-party authorship.

`Attach existing game` is a separate initial-enrollment operation for an already
running world, not a synonym for supporting another game or a third-party Mod. It is
not approved as an implicit Resume fallback. A future explicit enrollment must define
player consent and the integration-owned binding before that world can participate in
Resume; this handoff does not select its transport or approve arbitrary process scans.

This iteration does not expand multi-instance parallel activation. Preserve multiple
durable sessions and integration-neutral identities; do not turn that scope limit into
a permanent global singleton or a Stardew-only schema.

The community-connector document is currently draft and defers its runtime. Follow-up
owner-document reconciliation must distinguish the current multi-game/third-party
extensibility requirement from delivery of a connector SDK/runtime, packaging or
marketplace. Do not silently promote the draft external-process protocol to an accepted
implementation, or use its deferred schedule to prohibit third-party-compatible seams.

### Remaining Game Session Resume work

The missing Resume authority is the product-owned chain from a selected durable
`gameSessionId` to the selected integration's private world binding. Do not fill this
gap by scanning processes, windows, installation paths, save folders, launch times, or
matching titles.

Required next implementation tasks:

1. Add/finish the Game-session owner facade around the existing semantic SQLite owner
   so the UI/API can create/select a `gameSessionId` and read only redacted session /
   world status. The generic record must stay limited to product facts such as
   `gameSessionId`, published `integrationId`, optional `continuityIdentityId`, status,
   and revision.
2. Define the selected-integration private SPI equivalent to
   `createWorldBinding`, `resumeWorldBinding`, `readObservation`, `readCapabilities`,
   and `readTerminalWorldState`. Exact names can change, but the boundary cannot carry
   Stardew-only fields in the generic browser/session schema.
3. For Stardew, implement a private binding resolver that maps the selected
   `gameSessionId` to the one registered GameBuddy-owned world owner. It may reuse an
   existing private attachment transport only where that owner already requires it;
   Resume must not introduce a signed advertisement, SHA/HMAC digest, or a second
   identity/proof layer. A live response from the selected binding owner/Mod, compared
   with the persisted binding and fresh observation, is the authority. Private paths,
   endpoints, and rendezvous data are routing inputs, not identity. Never scan or
   guess.
4. Resume must attempt only that registered binding. If the binding is missing,
   terminal, mismatched, expired, or cannot produce a fresh observation, return a
   redacted `unavailable`/paused result and let UI offer `Retry`, `Cancel`, and
   `Start new game`.
5. `Start new game` creates a new Game session/world binding. It never migrates the
   old world, task, action, bridge, launch generation, or runtime authority.
6. A successful Resume creates a new activation, new connection authority, fresh
   observation/capability read, and Game-owned conversation sync. It must not replay old
   action attempts or reopen independent Chat.
7. Wire the real `game.resume` owner callback through broker/API/UI only after the
   private binding resolver exists. Until then, `accepted` means command accepted, not
   attached/ready/completed.

Documentation updates still required after the implementation boundary is frozen:

- `design/105_GAME_SESSION_SURVIVAL_RECONNECT_IMPLEMENTATION_PLAN.md`: replace the
  placeholder "exact names frozen later" wording with the accepted Game-session owner
  facade and integration SPI names, then mark which slice is still open.
- `design/tasks/active/game-session-survival-and-reconnect-simplification.md`: add the
  exact-auth/projection-liveness slice as completed prerequisite evidence and keep the
  private world-binding resolver as the next blocker.
- `design/domains/stardew/integration.md`: document Stardew's private Resume binding
  owner once implemented, including that it does not scan or attach external games.
- Browser/API/UI docs or tests for `game.resume`: distinguish `accepted`, `attached`,
  `unavailable`, `Retry`, `Cancel`, and `Start new game`; do not project old
  `game.reconnect` as a second product API.
- Any release/readiness document that cites Stardew lifecycle evidence must explicitly
  state that exact-auth/projection-liveness is only a safety prerequisite, not a live
  gate or full lifecycle acceptance.

### Resume acceptance items

A Game-session Resume slice is accepted only when all of the following hold:

- a selected durable `gameSessionId` resolves through the product-owned chain to
  exactly one registered GameBuddy-owned world binding, and the generic record stays
  limited to product facts (`gameSessionId`, published `integrationId`, optional
  `continuityIdentityId`, status, revision);
- Resume attempts only that registered binding; a missing, terminal, mismatched,
  expired, or unobservable binding returns a redacted `unavailable`/paused result
  with `Retry`, `Cancel`, and `Start new game`, and never scans processes, windows,
  installation paths, save folders, launch times, or matching titles, nor attaches an
  external game;
- a successful Resume creates a new activation, new connection authority, fresh
  observation/capability read, and Game-owned conversation sync; it never replays an
  old action attempt, reopens independent Chat, or auto-runs an old task;
- action admission stays paused until a new explicit Game instruction, `game.resume`
  remains the only recovery operation, and `game.reconnect` is not projected as a
  second product API;
- no new hash/signature/generation/lease/CAS/attestation/proof layer is added to
  Resume, and every kept check names its concrete incident, authoritative owner, and
  decision boundary;
- `Start new game` creates a new Game session/world binding and never migrates old
  world, task, action, bridge, launch generation, or runtime authority.

### Minimal verification budget

The design must not grow a ceremonial proof stack. Every retained check must name the incident it prevents, the authority that owns the fact, and the boundary where it runs. Keep session/world binding checks for wrong-game or wrong-session attachment; use an existing minimum attachment handshake when it actually establishes that binding; keep install/version checks at install/update/start; action admission for possible native side effects; receipt/postcondition for real outcomes; and a durable transaction or CAS only where concurrent writes, retries, or uncertain side effects require one. For the current local-owner Resume threat model, a signed advertisement or SHA/HMAC digest is not an identity decision: it authenticates file contents only when a secret is already available, does not prove that the live endpoint is the selected world, and creates replay/expiry/protocol machinery. Do not add one to Resume. Existing Stardew provisioning signatures are a separate protocol surface and must be classified keep/merge/remove against their concrete incident before being reused or deleted; they are not automatic Resume authority. Do not add duplicate hash, signature, generation, proof, lease, CAS, or attestation layers merely to make Resume appear safer. Activation-local callbacks, connections, and capabilities end with their owner and do not need a separate invalidation probe. Any existing mechanism without an independent incident, owner, or decision boundary must be classified for merge/removal before new implementation work proceeds.

### Required follow-up: remove ceremonial verification

This is implementation work, not only a prohibition on new checks. In each affected
owner slice, inventory existing hash/signature, generation, lease/CAS, attestation and
repeated admission checks; record the concrete incident, authoritative fact, decision
boundary and keep/merge/remove disposition. Merge or delete redundant mechanisms and
their obsolete tests/docs with that owner change. Preserve checks needed for wrong-world
attachment, concurrent controllers, installation integrity or unknown native effects.
Do not block unrelated work on a repository-wide proof audit or introduce a new proof
registry. Completion requires simpler production paths plus focused behavior tests,
not a longer evidence chain. Stardew provisioning signatures are an explicit audit item;
third-party trust checks must be justified by their own boundary, not copied from Resume.
Record the keep/merge/remove dispositions as explicit acceptance evidence for the
affected owner slice: a slice that adds or retains any
hash/signature/generation/lease/CAS/attestation layer without a named incident,
owner and decision boundary is not accepted.

### Stardew attachment artifact disposition (2026-09-12)

The existing `stardew-session.json`, `stardew-attachment-request.json`,
`stardew-attachment-response.json`, and `stardew-farmhand-manifest.json` form a
file-based first-attachment/provisioning flow. They are not automatically the
protocol or identity authority for cross-activation Game Resume.

For the intended GameBuddy-owned Resume topology:

- The **request operation** remains conceptually necessary when the Player Host
  Mod must create or reuse a Farmhand binding. Its user choice, correlation, and
  asynchronous save outcome affect a real game-thread side effect. Prefer a
  typed command over the authenticated integration-local owner/bridge rather
  than a durable request JSON file.
- The **response operation** remains conceptually necessary because the native
  save can settle asynchronously and can fail. Prefer a typed correlated result
  or owner callback (`awaiting_save`, `attached`, `rejected`/`unavailable`) rather
  than a response file. `requestId` may remain as operation correlation where it
  prevents duplicate or stale side effects; it is not a new identity proof.
- The **manifest data** may still be needed as activation-private native join
  input (for example the current endpoint and Farmhand scope). It must not be a
  durable Game-session binding, a discovery record, or a Resume proof. Prefer
  passing typed private launch material directly to the new AI activation. If a
  target-version Mod startup temporarily requires a file, it may remain an
  activation-scoped mechanical handoff, generated after the live binding query
  and deleted with that activation; do not add HMAC/signature solely for this
  handoff.
- The **session advertisement** is likewise a current live-state publication,
  not an identity authority. In the owner-based topology it should be replaced
  by a typed live binding query. The existing file flow may keep it only as an
  isolated migration source until its replacement exists, never a parallel production
  attachment fallback.
- `stardew-fixture-readiness.json` is diagnostic fixture data and is not part of
  Resume.

Thus the final goal is: **no three-file JSON exchange as the generic Resume
protocol, while retaining the request/response semantics and the native join
facts where the actual integration needs them.** If the Player Host is still
externally started and no GameBuddy-owned owner/bridge can be resolved, Resume
remains an unavailable prerequisite; do not remove the current attachment files and
then call the result Resume. `Attach existing game` is not an approved fallback: it
remains a separate initial-enrollment operation requiring its own explicit enrollment
decision with player consent and an integration-owned binding; third-party integration
support alone does not authorize that operation.
Existing Stardew provisioning HMAC/signatures remain an independent keep/merge/
remove audit item and must not be promoted into Resume authority.

## Current Desktop↔Guardian↔Host status

The formal Host entry, exact Desktop child admission, private root/session capability binding, and authenticated Desktop↔Host broker handshake have focused evidence (Host 123/123; Desktop 29/29; broker/Host 17/17), but they do not establish full Desktop↔Guardian↔Host completion. The private relay is present; real Guardian-owned `arm → launch → contain` and production role delegation remain fail-closed because two production authorities are unconnected: (1) the Desktop bootstrap constructs `DesktopPrivateHostComposition` closure-bound to the authenticated Guardian session, while `StardewProductionLifecycleCoordinator` independently constructs its own Stardew-private bootstrap composition and never receives that Desktop session or any cross-game collaborator; (2) `createStardewBootstrapGuardianOwner` has no production caller deriving a lifecycle-owned per-invocation `RoleLaunchOperation` deadline. staged Player Host/D still own the admitted-installation callback, exact OS role recipe, registration attempt, and one-shot launch reservation through `OwnedPlayerHostBootstrapFacts`; direct Node launch must be atomically replaced only after a coordinator→private-composition handoff delivers the existing phase-A owner and creates the per-invocation deadline after fresh admission/preconditions and the launch decision. Do not reuse bootstrap timeout, browser admission expiry, or owner/attempt expiry; do not treat game runtime lifetime as a timeout. Do not manufacture a plan, expose installation/recipe facts, retain a Node fallback, or modify action definitions. Do not introduce direct Node role spawning, action-specific changes, registration changes, profile fallbacks, or live mutation while closing this boundary.

## Handoff completion criterion

The next agent should not claim a live gate, Navigation publication, or BodyProgram
production runtime completion until it can cite:

```text
- the exact current authority decision;
- successful profile-free factual preflight against the same ready registration;
- review admission and explicit live authorization;
- one serial live action result with receipt, fresh postcondition, cleanup,
  and complete evidence; and
- no unresolved authoritative blocker for that surface.
```


## Physical seam relocation handoff (2026-09-01)

The physical seam extraction is complete and independently reviewed. Published Stardew package/reparse staging dependency construction moved to `host/src/bootstrap/roots`. Stardew lifecycle retains staged Player Host/D, reservation, recipe, Guardian CAS, action semantics, and Stardew-specific process-owner implementations/results. Generic Windows containment retains only game-neutral primitives and contracts; Stardew consumes a narrow generic contract without importing the raw generic platform implementation; generic `bootstrap/**` and `containment/runtime/**` remain game-independent and never import `games/stardew`, while `composition` may assemble the selected game adapter. The staged move of `stardew-process-implementations.ts` out of `containment/windows` is intentional relocation, not deletion.

Production and test typecheck passed. Physical seam tests passed (`6/6`), the checker passed with `11` production files, scoped diff checks passed, and independent review found no blocker. Checker hardening covers test-support exclusion, source extension resolution, import-equals/`require`, and fail-closed handling for unresolved dynamic, non-relative, escaped, and symlink imports.

This is not full Desktop↔Guardian↔Host completion, not role delegation, not registration, and not control-runner completion. No action runtime changed. Other worktree failures and existing design-repository checks are out of scope for this slice.

The next ready slice is stable generic containment runtime/authorization gate design or subsequent Desktop↔Guardian lifecycle work. Do not claim either next slice, a live gate, Navigation publication, or BodyProgram production runtime completion from this physical extraction alone.


## Registration lifecycle facade slice (current)

The installation-registration mutation boundary now exposes only
`withStardewLifecycleInstallationRegistrationOwner`. It remains the registration
module's owner of the path lock, strict parsing, record/marker CAS, atomic writes,
and canonical rereads. `stardew-private-bootstrap-composer.core.ts` is the only
production consumer of this privileged facade for prepare/bind, owner-authorized
active-attempt locator replacement, and settlement/recovery.

The facade mutation operations fail closed unless the expected registration revision,
exact bootstrap correlation, and durable transaction marker agree. Locator replacement
also requires an active pointer for that exact correlation and no active transaction
marker. Settlement uses the exact `settlement_release` marker and retains the existing
owner-fence and terminal-owner revision checks in the composer. This is a physical-seam
restriction, not a claim of deep-import cryptographic uncallability. Ordinary
registration reads remain available to the lifecycle coordinator solely for
state/admission inputs; it receives no facade mutation authority, bootstrap correlation,
or transaction storage.

Focused registration and physical-seam tests passed; the full Host typecheck was blocked
by the unrelated existing syntax error in `host/src/tavern/chat-thread-store.ts:560`.


## Runtime contract/core split status (2026-09-06)

The generic runtime behavior and physical-seam gate are green. The physical
contract/core paths now exist: `host/src/containment/runtime/contract/game-runtime.ts`
holds the game-facing typed/private game-facts contract with no `Uint8Array` or native
frame fields, and `host/src/containment/runtime/core/contained-game-runtime.ts` is the
composition-private implementation; the old
`host/src/containment/runtime/contained-game-runtime.internal.ts` (whose producer
callback accepted native `Uint8Array` bytes) has been removed and must not be
reintroduced. Do not mechanically move that file into `contract/` or preserve the old
callback under a new path: that would violate the Shape B boundary. The **semantic
boundary remains unaccepted**: the core currently derives and serializes the native
private frame internally (`encodePrivateFacts` → `Uint8Array` passed to arm/launch),
so the approved composition-owned encoder/private-transport split, in which platform/
auth modules alone create and consume native frame bytes, is not yet proven by
dedicated compiled tests.

The approved target is:

```text
host/src/containment/runtime/contract/game-runtime.ts
  typed/private game-facts producer contract only;
  no Uint8Array, native frame, executable, cwd, args, env, PID, Job, pipe, token, path

host/src/containment/runtime/core/contained-game-runtime.ts
  composition-private sequencing, one-shot authorization, role terminality,
  deadline/serialization/close and redacted outcomes
```

The missing semantic seam is the composition-owned encoder/private transport:
Stardew (and future games) supplies typed/private game facts inside a private
producer closure; composition binds that producer to the platform encoder and
authenticated session; only the platform/auth implementation creates and consumes
native private-frame bytes. No public mint factory, global registry, daemon,
browser/CLI handoff, fallback, or action-specific special case is allowed.

Attempts to implement this split were stopped without accepted source changes while
the `Uint8Array` callback and the new game-facing contract were semantically
incompatible. The physical split is now in place, but the next implementation must
first preserve this Shape B boundary, then prove the semantic core/contract split
with dedicated compiled tests before Shape B implementation acceptance.
`equip_tool`, `till_soil`, Stardew lifecycle behavior, Desktop/Guardian transport,
and registration schema remain unchanged by this slice.
