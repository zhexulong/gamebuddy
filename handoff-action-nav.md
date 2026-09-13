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
- The physical helper/publication seam was destructively renamed and verified in commit `23c749b` from
  `windows-stardew-bootstrap-guardian` to `windows-bootstrap-guardian` (including native/source/build/
  publication paths and names as applicable), with **no old path fallback, alias, wrapper or compatibility
  read**. The Stardew lifecycle owner names remain Stardew-specific; this physical helper rename does not
  rename or relocate the Stardew lifecycle owner.
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

### Verified checkpoint and open topology blockers (after `23c749b`)

`23c749b` ("Rename Windows bootstrap Guardian") is the current verified physical
publication checkpoint. It destructively renamed the native helper/project and Host
Guardian seam to the neutral names, updated the production artifact descriptor,
build/publication scripts, Desktop admitted-helper constants, fixtures and focused
seam tests, and removed the old physical identity from that publication path. The
canonical names are now:

```text
host/native/windows-bootstrap-guardian/
host/src/windows-bootstrap-guardian/
GameBuddy.WindowsBootstrapGuardian.exe
windows-bootstrap-guardian.manifest.json
production config key: windowsBootstrapGuardian
inventory kind: verified_windows_bootstrap_guardian
```

This commit proves a physical artifact/publication rename only. It does **not** prove
Guardian policy/recovery, Stardew role delegation, Desktop product composition,
GameSession/Resume, Chat migration, action execution, or a live gate. Do not reopen
the rename, retain the old name as an alias, or infer generic Guardian authority from
its neutral physical name. Stardew policy remains an adapter above generic Windows
containment; the Stardew lifecycle owner and its product semantics remain Stardew-
specific.

The formal Desktop entry/root admission and authenticated Desktop↔Guardian session
predecessor are accepted as focused slices. `DesktopPrivateHostComposition` is the
first capability-gated mutable owner, constructed only by the private bootstrap wire;
it currently retains the root capability and closure-bound authenticated Guardian
session and exposes only `close()`. It does not yet own Chat, Game, browser,
provider, installation, or action runtime. The current blocker is the unconnected
production authority graph: `stardew-production-lifecycle-coordinator.internal.ts`
still creates `createStardewPrivateBootstrapComposition()` independently, while the
Desktop bootstrap creates `DesktopPrivateHostComposition`; no accepted coordinator→
Desktop-session handoff currently gives the lifecycle owner the generic containment
session or creates its per-invocation `RoleLaunchOperation` after fresh admission and
the launch decision. The old direct role-spawn/fallback route must not be restored.

The Shape B semantic split is also still open: the physical contract/core paths exist,
but `contained-game-runtime.ts` still owns the `encodePrivateFacts`→`Uint8Array`
step. The accepted target keeps typed/private game facts at the game-facing contract,
binds the encoder/private transport in composition/platform/auth code, and never
exposes native frame bytes through the game contract. This is a focused composition
blocker, not permission to add a new public factory or generic action seam.

The GameSession/Resume blocker is independent: the semantic production SQLite
facade already owns Game-session metadata, but the published `game.resume` route is
transport/auth/schema plumbing only. No final Host/GameSession owner consumes that
facade, resolves the selected integration's private GameBuddy-owned world binding,
or establishes attachment plus fresh observation. `accepted` therefore means command
accepted, not attached, ready, or completed. The integration-private resolver and
owner callback must be located before browser fields or a second binding schema are
frozen.

### Remaining-work plan: five disjoint lanes

Each lane has one writer and one named commit boundary. A lane may prepare tests,
read-only inventories and review notes before its dependencies are accepted, but it
must not edit another lane's files to unblock itself. Existing dirty WIP is preserved
and is never attributed to a lane without source-bound evidence.

#### Lane A — Guardian policy and recovery (Stardew adapter)

- **Current state:** The Stardew adapter has durable owner transitions, Player/AI role
  policy, controlled close, settlement and a fail-closed recovery surface. The
  Desktop-backed native port is closure-bound and redacted, but the production
  lifecycle does not yet consume the Desktop session through the one accepted
  composition topology; launch remains unavailable unless its lawful typed/private
  authorization is supplied. Generic Windows containment owns Job membership,
  drain, EOF/recovery transport and redacted acknowledgements; this lane owns no
  generic physical helper or Windows process authority.
- **Owned files:**
  `host/src/games/stardew/lifecycle/stardew-bootstrap-guardian.private.ts`,
  `host/src/games/stardew/lifecycle/stardew-private-bootstrap-owner-records.private.ts`,
  `host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.core.ts`,
  `host/src/stardew-player-host-process-owner.ts`,
  `host/src/stardew-ai-client-process-owner.ts`, and their source-named focused tests
  and test-support files. Keep Stardew lifecycle owner names and product semantics.
- **Dependencies:** May proceed in parallel with Lanes B–C after the accepted neutral
  artifact from `23c749b`. It can use closure-bound test ports while Lane B and Lane D
  are open. Its final production delegation consumes Lane B's typed Desktop/Guardian
  predecessor and Lane D's composition-owned handoff; it must not make generic
  containment depend on Stardew.
- **Work:** Prove Player/world survival on AI failure, controller EOF, Guardian failure
  and ordinary close; AI-only cleanup and drain; separate authenticated explicit
  End Game; unavailable Player recovery; stale owner/settlement handling; same-tuple
  unknown-result recovery; and no raw PID, Job, path, pipe, token or native-frame
  facts. Remove only migration-before launch callbacks when the approved Shape B
  composition seam is ready; do not preserve them as fallback aliases.
- **Forbidden overlap:** Do not edit `desktop/GameBuddy.Desktop/*`,
  `host/src/bootstrap/{entry,wire}/*`, `host/src/composition/desktop-host-composition.ts`,
  `host/src/stardew-production-lifecycle-coordinator.internal.ts`,
  `host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.internal.ts`,
  `host/src/windows-bootstrap-guardian/*`, or shared publication files. Do not add
  `ProductInputProducer`, direct role spawn/kill authority, external scan/attach, old
  task/action replay, a registry/alias/fallback, or live Stardew mutation.
- **Focused validation:** Run the compiled Stardew Guardian, owner, process-owner and
  composer suites serially; source-bound checks for the generic contract and raw-fact
  leaks; and Host typecheck/build only when the worktree permits. Tests must show
  close/EOF/failure preserve Player/world, cleanup drains only AI, explicit End Game
  is distinct, recovery is unavailable/held, and uncertain effects are not replayed.
  No game or live target.
- **Atomic commit:** `guardian-policy-recovery`: Stardew policy/recovery tests,
  adapter and owner changes only. Review and accept this commit before Lane D's final
  coordinator handoff.

#### Lane B — Desktop runtime and Guardian predecessor

- **Current state:** The formal `desktop-host-entry.internal.js` entry, exact root-layout
  admission, generation admission and authenticated Desktop↔Guardian broker session
  have focused evidence. `DesktopPrivateHostComposition` is the approved first owner,
  not an inert placeholder. The remaining predecessor is to make the neutral admitted
  Guardian/runtime control path consumable by the later Host composition without
  exposing transport or Windows facts. The physical helper rename/publication is
  already complete in `23c749b`; this lane must not redo it.
- **Owned files:** `desktop/GameBuddy.Desktop/Program.cs`,
  `desktop/GameBuddy.Desktop/RuntimeSupervisor.cs`,
  `desktop/GameBuddy.Desktop/DesktopHostBootstrapBroker.cs`,
  `desktop/GameBuddy.Desktop/GuardianSupervisor.cs`, their focused Desktop tests,
  `host/src/bootstrap/entry/desktop-host-entry.internal.ts` and tests only if the
  accepted entry contract needs a correction, `host/src/bootstrap/wire/desktop-runtime-bootstrap.internal.ts`
  and tests, and `host/src/containment/auth/desktop-guardian-session.internal.ts`
  and tests. The renamed `InstalledGenerationAdmission`/artifact files are read-only
  inputs from `23c749b` unless a separately reviewed publication defect is found.
- **Dependencies:** Starts from the accepted entry/root and the `23c749b` neutral
  helper/publication. It is independent of GameSession/Resume and may proceed in
  parallel with Lane A and Lane C. Lane D consumes its closed typed predecessor;
  the final coordinator/composition handoff is serialized after this lane's review.
- **Work:** Keep Desktop as the owner of Guardian process, stdin EOF, pipe/token/path
  handling and Windows containment transport. Close malformed/replayed/cross-session,
  Host-loss and EOF cases fail-closed; return only redacted acknowledgements; make
  predecessor lifetime and close ordering explicit. Do not decide `GameSession`,
  `fresh`/`known`, world binding, selected integration, or product lifecycle state.
- **Forbidden overlap:** Do not edit Lane A policy/owner files, Lane D's
  `host/src/composition/desktop-host-composition.ts` or coordinator/composer topology,
  Lane C semantic/browser files, `host/src/dialogue-web-main.ts`, or publication config.
  Do not pass raw session/pipe/token/PID/Job/path facts, create a second entry, scan or
  attach an external game, add a fallback/alias/registry, or spawn Stardew roles here.
- **Focused validation:** Focused Desktop admission/supervisor/broker tests and
  Host entry/wire/auth tests; exact neutral-helper inventory and old-physical-name
  absence checks; malformed/replay/cross-session/EOF/close ordering matrix. A native
  Guardian fixture/live protocol check is allowed only as non-product containment
  characterization; no Stardew launch or mutation.
- **Atomic commit:** `desktop-runtime-guardian-predecessor`: Desktop/runtime/wire
  predecessor and focused rejection matrix only. After review, the wire and auth seam
  are frozen for Lane D.

#### Lane C — GameSession and world-binding owner

- **Current state:** The durable Game-session metadata facade exists in the semantic
  production authority and already supports create/bind/fail/read/list operations.
  The current `game.resume` route still has transport/auth/schema plumbing only; its
  `accepted` result is not attachment or readiness. The integration-private
  world-binding resolver and final Host/GameSession owner callback are still missing.
- **Owned files:** The existing semantic owner and focused tests under
  `host/src/continuity-semantic-production-coordinator/` and
  `host/src/continuity-semantic-store/`; the selected-integration private resolver
  and adapter seam under `host/src/games/` and `host/src/game-browser/` only where
  the source audit assigns them; `host/src/stardew-owned-farmhand-game-session-materializer.internal.ts`
  and direct tests where the existing Stardew-owned binding is the correct consumer;
  then, only after the private owner/SPI is reviewed,
  `host/src/composed-reference-game-browser.ts`,
  `host/src/game-browser-contract/index.ts`,
  `host/src/game-browser/game-browser-state-provider.ts`, and focused browser tests
  for the redacted projection. Do not create a second store or generic Stardew DTO.
- **Dependencies:** The owner/resolver work may proceed in parallel with Lanes A–B
  and with Lane D's independent Chat/Shape-B preparation. It consumes the existing
  semantic SQLite authority and selected published integration; it does not depend on
  the physical Guardian rename. Final startup wiring waits for Lane D. Browser
  contract edits are a serialized sub-gate after the private SPI and owner callback
  exist; do not use the current route as a substitute.
- **Work:** Resolve a selected durable `gameSessionId` only to its registered
  GameBuddy-owned world binding; define the narrow integration-neutral private SPI
  equivalent to `createWorldBinding`, `resumeWorldBinding`, fresh observation/
  capabilities and terminal-world-state reporting; persist binding completion before
  projecting resumable. Missing/mismatched/terminal/unobservable binding is redacted
  `unavailable`/paused with Retry, Cancel and Start new game. Resume never scans
  processes/windows/paths/saves/timestamps, attaches an external game, replays an
  old task/action, or adds a signed/hashed second proof layer. New activation uses
  fresh authentication and observation sync; it never auto-runs old work or reopens
  independent Chat.
- **Forbidden overlap:** Before its private seam is accepted, do not edit the generic
  browser contract, `game.resume` result vocabulary, `game.reconnect`, Lane D's
  coordinator/composition topology, `host/src/dialogue-web-main.ts`, or shared
  publication files. Do not import Desktop/Guardian facts into generic DTOs or freeze
  speculative binding fields/API names. After the browser sub-gate, the projection
  files are frozen for Lane E.
- **Focused validation:** Fresh-root semantic SQLite owner/store tests; selected
  integration SPI/resolver tests; Game Resume idempotency and unavailable/paused
  outcomes; redacted state-provider/browser tests; source-bound checks proving no
  process discovery, external attach, second Resume API, native facts in DTOs,
  old-task/action replay, or Chat takeover. No live game.
- **Atomic commit:** `game-session-binding-owner`: owner facade, private resolver/SPI,
  binding tests and (only after the serialized owner review) the minimal redacted
  browser projection. If the browser sub-gate is not green, commit only the private
  owner/resolver boundary and leave browser files untouched.

#### Lane D — Host composition and presentation

- **Current state:** The bootstrap wire constructs and closes the first private Desktop
  owner, while the Stardew coordinator and the temporary `dialogue-web-main` path
  still construct product authorities separately. The `ContainedGameRuntime` physical
  contract/core split exists, but the composition-owned encoder/private transport
  boundary is not accepted. Chat and Game must become children of one long-lived
  Desktop composition without one surface owning, pausing, closing or recovering the
  other.
- **Owned files:** `host/src/composition/desktop-host-composition.ts` and focused
  tests; `host/src/stardew-production-lifecycle-coordinator.internal.ts` and direct
  tests; `host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.internal.ts`
  and direct tests only for the composition handoff; the Shape B files
  `host/src/containment/runtime/contract/game-runtime.ts` and
  `host/src/containment/runtime/core/contained-game-runtime.ts` with compiled tests;
  and narrowly selected composition-owned presentation/startup files under
  `host/src/continuity-semantic-*`, `host/src/farmhand-companion-presentation.ts`,
  `host/src/presentation.ts`, and `host/src/host-service.ts` when the source audit
  assigns the handoff. `host/src/dialogue-web-main.ts` remains Lane E-owned.
- **Dependencies:** Chat-only composition and Shape B tests may prepare in parallel
  with Lanes A–C. Final role delegation consumes Lane A's reviewed policy seam and
  Lane B's frozen Desktop/Guardian predecessor; final Game startup consumes Lane C's
  accepted private owner callback. The coordinator/composition topology has one
  writer and one serialized integration gate; no lane may land a parallel owner.
- **Work:** Keep bootstrap limited to runtime/generation admission, child
  authentication and long-lived composition handoff. Make composition own Chat and
  Game startup/close and presentation admission while preserving independent surface
  lifecycles. Delegate selected integration and GameSession Create/Resume only from
  the Game UI/owner. Create `RoleLaunchOperation` only after fresh lifecycle
  admission/preconditions and the launch decision. Complete the semantic Shape B
  encoder/private transport split without moving native bytes through the game
  contract. Close/EOF/AI failure stops AI authority and drains presentation while
  Player Host/game world survives; unknown side effects are not called complete.
- **Forbidden overlap:** Do not edit Lane A policy internals after its seam is handed
  off, Lane B's bootstrap wire/auth files after predecessor acceptance, Lane C's
  browser contract before its owner gate, Lane E's dialogue entry/publication files,
  or any action definition/handler/receipt/postcondition. Do not add
  `ProductInputProducer`, raw session/pipe/token/PID/Job/path handoff, a second
  product entry, direct/native-local route, external scan/attach, old-task replay,
  generic fallback/alias/registry, or live Stardew mutation.
- **Focused validation:** Compiled Host composition/coordinator/Shape B tests;
  Chat+Game concurrent startup/close and independent-surface tests; Desktop wire
  integration with redacted Guardian acknowledgements; source-bound checks proving
  bootstrap has no GameSession/fresh/known/selected-integration decisions, no
  `ProductInputProducer`, no raw frame/game-facts leak and no second entry. Verify
  Player/world survival, AI-only cleanup, failure propagation and no false success.
- **Atomic commit:** `host-composition-chat-game`: one formal Desktop composition,
  coordinator handoff, Shape B semantic seam, presentation lifecycle and focused
  tests. It lands only after Lanes A–C/B's required review gates and before Lane E.

#### Lane E — Final `dialogue-web` deletion and Chat migration

- **Current state:** `host/src/dialogue-web-main.ts` remains the temporary Chat/browser
  entry and still has production artifact, TypeScript, package/script, module-graph
  and live-gate callers. It cannot be deleted while the composition-owned Chat/Game
  startup, Lane C's real Resume owner callback, or fresh-root Chat/Tavern final gate
  is incomplete. This is a destructive migration, not a compatibility exercise.
- **Owned files:** `host/src/dialogue-web-main.ts`; its focused entry test(s);
  `host/production-artifact.config.json`, `host/tsconfig.production.json`,
  `host/tsconfig.test.json`, `host/tsconfig.chat-live.json`,
  `host/package.json`, `host/knip.json`/root `knip.json` only where the entry is
  named; `host/scripts/build-chat-live-artifact.mjs`,
  `host/scripts/start-chat-live-artifact.mjs`,
  `host/scripts/chat-live-artifact-support.mjs`,
  `host/scripts/test-artifact-protocol.test.mjs`, focused artifact/module-graph
  tests, and the exact `tools/run-tavern-narrative-gate.mjs`/
  `tools/run-player-managed-memory-http-live.mjs` callers. Update a generated
  publication manifest only through its owning publication configuration in this
  same commit. Do not rewrite unrelated Chat/Tavern runtime code.
- **Dependencies:** Last. Requires Lane C's accepted `game.resume` owner callback
  and redacted projection, Lane D's single composition-owned Chat+Game startup/
  close and concurrency/error tests, and a fresh-root production Chat/Tavern final
  gate that does not depend on a fixture or operator setup. Before deletion, perform
  an exact import/publication inventory; no caller may be left to a fallback.
- **Work:** Move the existing browser listener/presentation startup into the formal
  composition-owned owner, delete the entry and every production caller in one
  destructive change, remove wrappers/aliases/second entries/global registries and
  fallbacks, and update tests to assert absence. Preserve Chat/Game independence,
  AI-only cleanup and Player/world survival; ordinary close is not End Game.
- **Forbidden overlap:** No edits to Lane C's owner/SPI or frozen browser contract,
  Lane D's coordinator/composition topology, Lane A/B policy/Guardian files, action
  runtime, or live target. Do not retain `dialogue-web-main` as a hidden alias or
  add another browser/CLI/daemon entry.
- **Focused validation:** Fresh-root production artifact build/publication; Host
  module-graph/import-boundary and Chat/Game browser/close/error suites; Resume
  projection suites; exact inventory proving one Desktop composition root and zero
  `dialogue-web-main` production references; scoped `git diff --check`. No live
  Stardew action.
- **Atomic commit:** `remove-dialogue-web-entry-chat-migration`: composition migration,
  destructive entry/config/script deletion and focused artifact/module-graph tests,
  with no unrelated source or generated output.

### Parallelism map and serialized gates

The safe parallel work is: Lane A policy/recovery tests and Lane B Desktop predecessor
can proceed independently after `23c749b`; Lane C can build the semantic owner and
private selected-integration resolver in parallel with both; Lane D can prepare Chat
composition and Shape B tests while those lanes are under review. None of those
parallel preparations is a production completion claim.

The following gates are serialized:

1. **Physical publication gate:** `23c749b` is already accepted. Do not reopen or
   duplicate the rename. Any later artifact/publication change must be reviewed by
   the publication owner and must use only `windows-bootstrap-guardian`.
2. **Desktop predecessor gate:** Lane B's exact entry/root/session/Guardian
   predecessor must be green before Lane D consumes a Desktop Guardian session.
3. **Guardian policy gate:** Lane A's Player-survival, AI-only cleanup, recovery and
   redacted-policy seam must be accepted before Lane D connects the coordinator.
4. **Coordinator/composition topology gate:** only Lane D edits the connected
   `desktop-host-composition.ts` → `stardew-production-lifecycle-coordinator.internal.ts`
   → Stardew private bootstrap path. No second composition, product entry or direct
   role-spawn route may land.
5. **Browser-contract gate:** Lane C's private GameSession/world-binding owner and
   selected-integration SPI are reviewed first; only then may it edit
   `composed-reference-game-browser.ts`, `game-browser-contract/index.ts` or the
   state provider. Once accepted, those browser files are frozen while Lane D wires
   startup and Lane E migrates the entry.
6. **Shared publication gate:** `host/production-artifact.config.json`, Host
   `tsconfig*`, package/start scripts, module-graph roots and live-gate callers are
   owned by Lane E for the final deletion. Lanes A–D must not opportunistically edit
   them; the only exception is a separately reviewed blocker in the already-accepted
   Guardian publication, which cannot reintroduce the old name.
7. **Final deletion gate:** Lane E is last and serial after the accepted composition,
   Resume/browser projection and fresh-root Chat/Tavern checks. Its destructive commit
   must leave zero production `dialogue-web-main` references and no alias/fallback.

After each lane, capture status/diff evidence without resetting or staging unrelated
WIP. Stage only that lane's owned paths when its owner (not this handoff) commits.

### Parallel-lane review and worktree safety

Before a lane's commit, capture `git status --short`, `git diff --stat` and
`git diff --cached --stat`; use `git diff --check -- <owned paths>` and the lane's
focused tests. A pre-existing failure or dirty hunk is residual only when it is shown
to predate the lane, lies outside owned paths, and all scoped gates pass. Never use
`git reset`, `git clean`, `git stash`, broad checkout/restore or mass formatting to
make a lane appear green. A lane cannot claim completion from a source-only inventory,
fixture, mock, Preview, direct/native-local route or unrelated dirty WIP. The final
review must independently confirm the target composition, Player/world survival,
Resume no-scan/no-replay rules, and no-fallback/destructive-rename rules.

```text
Game UI integration + optional continuity choice
→ existing Game-session persistence owner
→ selected Game integration creates or resumes its private world binding
→ minimum binding handshake + current observation
→ redacted resumable Game projection
→ Game action admission only after a new Game instruction
```

The cross-game Game-session slice is no longer just a search task: the durable
Game-session metadata facade exists under the semantic production authority, while
the published `game.resume` route currently provides transport/auth/schema plumbing
only. The integration-private world-binding resolver and final Host/GameSession owner
consumer have not been located. Do not add a parallel store, promote Stardew launch
facts into the generic browser contract, scan for an external game, or claim Resume
from the currently declared-but-unwired `game.reconnect` operation. A new activation
may reuse an available AI process or create one through the selected integration's
existing authority; that implementation choice is not a second Resume operation or
a new proof layer.


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
 7. Request one explicit Navigation republish decision and a separate serial
    live-mutation authorization.
 8. Run serial gates only after their individual readiness/review conditions are
    green:

   ```text
   equip_tool profile-free preflight → equip_tool live run → evidence/cleanup
   afterward:
   Navigation preflight → Navigation live run → evidence/cleanup
   ```

 9. Resume BodyProgram production composition only after the two action gates and
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

### Current GameSession/Resume implementation status

The durable metadata facade is present under the semantic production authority, but
it is not yet consumed by the final Host/GameSession owner. The published
`game.resume` route is transport/auth/schema plumbing only: it does not resolve a
registered world binding, invoke an integration-private Resume resolver, establish
attachment/readiness, or prove completion. The integration-private world-binding
resolver and the final Host/GameSession owner consumer are not located yet.

Resume therefore remains binding-only. It may attempt only the selected durable
session's registered GameBuddy-owned world binding; it must not scan processes,
windows, paths, saves, timestamps, or matching titles, attach an external game,
replay an old task or action, or introduce a second identity/proof layer such as a
signed advertisement or hash. `game.reconnect` is not a second product API, and
`accepted` from the current route means command accepted only, not attached, ready,
or completed.

Until the owner seam is found, defer choosing API names and durable world-binding
fields. Do not freeze those names in the generic browser/session contract or add a
parallel binding schema; the owner must first establish the integration-private
boundary and its redacted projection.

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

1. Use the existing durable Game-session metadata facade under the semantic SQLite
   production authority so the UI/API can create/select a `gameSessionId` and read
   only redacted session/world status; locate and wire the final Host/GameSession
   owner consumer before freezing API names or durable binding fields. The generic
   record must stay limited to product facts such as `gameSessionId`, published
   `integrationId`, optional `continuityIdentityId`, status, and revision.
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
