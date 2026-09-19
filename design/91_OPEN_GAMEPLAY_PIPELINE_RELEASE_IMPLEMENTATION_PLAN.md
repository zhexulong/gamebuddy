# Open Gameplay Pipeline Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use the project's `subagent-driven-development` skill task-by-task. Use TDD for behavior changes and PBT only for stable laws with meaningful generated state spaces.

**Goal:** Make the production Game surface releaseable as an open-ended Agent gameplay loop with a complete **first-party Stardew** player path: the prompt defines the task; the game world, save, observations, mechanics, failures, time progression, and every implemented live capability remain as real as production permits; and a player can launch or attach Stardew from the shipped GameBuddy frontend without editing configuration or understanding Host/bridge internals. Apply category-theoretic structure only where it yields a smaller cross-game seam or executable law, remove the parallel SOP/category runtime, and make every ordinary action originate from one adapter-owned runtime registration. Future community game support is owned by `design/97_COMMUNITY_GAME_CONNECTOR_ARCHITECTURE.md`; it must not expand or delay this first vertical slice.

**Architecture:** Preserve one execution path and one player launch path:

```text
GameBuddy frontend
→ inspect/setup prerequisites
→ launch SMAPI/Stardew or attach to an existing player-owned instance
→ manage the separate Host and AI-client Stardew roles
→ production Game Pi session
→ adapter-owned live observation + current runtime action-catalog revision
→ Agent selects one typed action
→ fresh Host/Mod admission
→ native game-thread transition
→ terminal receipt + action-specific postcondition
→ fresh observation
→ Agent continues, replans, completes, or reports failure
```

The prompt defines the task boundary. Player policy, cancellation, idempotency, scope/revision checks, and native execution serialization protect execution integrity and player control; they must not become a preset route, release-only action subset, action quota, time quota, retry quota, or hidden gameplay objective. Product gameplay has no Host-owned turn, tool-call, wall-clock, model-retry, accepted-action, or action-family budget.

Each ordinary action is registered exactly once in the trusted adapter/Mod startup composition as one closed typed registration containing its identity, lifecycle/family metadata, Agent-facing parameter contract, typed argument codec, implementation binding, and runtime action-specific outcome/postcondition contract. Policy, routing, bridge publication, Host tool materialization, discovery, and diagnostics consume that registration or its authenticated restrictive runtime descriptor; none maintains another handwritten membership list. Host materializes one independently named Pi tool per descriptor and its closure uses the ordinary authenticated bridge transport; the Agent is never given a generic `execute(action,payload)` tool. Fixture setup, target-version source anchors, gate runners, and release acceptance remain separate **non-authoritative closure descriptors** keyed to that same versioned action identity; they may verify parity/coverage but cannot register, publish, enable, route, execute, or materialize an action. The Mod may atomically publish a new immutable action-catalog revision while a Game session is active. Host and the embedded Pi session refresh tools without restarting the session; stale tools recheck the revision and fail before write. Runtime hot-add means policy/live support may enable an action from the fixed startup-composed loaded registrations and the current Game/Pi session receives it. Adding a new registration/handler or loading a new C# binary follows the supported SMAPI Mod reload/game restart lifecycle; this plan does not add dynamic registration from config/Host/bridge input, an arbitrary assembly loader, or reflection dispatch.

**Category-theoretic use:** Treat actions as effectful typed transitions, the adapter as a structure-preserving projection, runtime action visibility as a restrictive publication, and receipt/postcondition correspondence plus cancellation/idempotency/terminality as laws. Effectful composition is causal sequencing: a following ordinary action is admitted only after the preceding action's Mod-owned terminal receipt and a fresh observation supply its real input state. This does not impose a count, time, turn, or tool-call limit; it permits the Agent to compose an unbounded prompt-defined sequence. A deep native action may itself span ticks only when it is one real Mod-owned capability with one execution lifecycle and action-specific terminal postcondition. Do not add a runtime category framework, generic action AST, generic Host composite dispatcher/batch, generic pullback receipt, or an independent Host action registry.

**Primary references:**

- `AGENTS.md`
- `design/00_CORE_PRODUCT.md`
- `design/26_TAVERN_FRONTEND_DESIGN_SPEC.md` — owning player-facing information architecture and design system; Game is one conditional single-drawer surface, not a dashboard
- `design/90_SIMPLIFIED_PI_BACKED_CHAT_PRODUCT_IMPLEMENTATION_PLAN.md` — current shipped reference Chat/browser composition execution authority; Game extends the same ordinary local browser→Host pattern without importing retired evidence gates
- `design/40_CHAT_PIPELINE_RELEASE_ENGINEERING_IMPLEMENTATION_PLAN.md` — retired execution plan; historical contract/artifact detail is usable only where design 90 and current product owners still retain it
- `design/83_TAVERN_FULL_MANAGEMENT_FRONTEND_BACKEND_INTEGRATION_PLAN.md` — versioned browser command/idempotency/read-back pattern; it does not itself authorize Game routes
- `design/92_NATIVE_CONTENT_CHAT_GAME_PRESENTATION_IMPLEMENTATION_PLAN.md` — latest Chat/Game native-content presentation ownership
- `design/38_STARDEW_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md`
- `design/review/ACTION_SYSTEM_SSOT_REFACTORING_PLAN.md`
- `design/78_GAME_PIPELINE_RELEASE_ARCHITECTURE.md`
- `design/79_GAME_PIPELINE_RELEASE_IMPLEMENTATION_PLAN.md`
- `design/85_CATEGORY_THEORETIC_ACTION_AND_EVIDENCE_ARCHITECTURE_SPEC.md`
- `design/86_CATEGORY_THEORETIC_ACTION_AND_EVIDENCE_IMPLEMENTATION_PLAN.md`
- `design/88_CATEGORY_THEORETIC_CORE_ARCHITECTURE_OPTIMIZATION_SPEC.md`
- `design/89_CATEGORY_THEORETIC_CORE_ARCHITECTURE_OPTIMIZATION_IMPLEMENTATION_PLAN.md`
- `design/research/open-ended-game-agent-architecture-2026.md`
- Pi SDK/extension docs for same-session runtime tool refresh (`AgentSession.agent.state.tools`, dynamic tool registration/activation)

---

## 1. Non-negotiable product semantics

1. **Prompt-defined, not infrastructure-bounded.** The prompt may constrain the requested outcome, game-world horizon, or player intent. The release runner must not prescribe the Agent's action sequence or hide otherwise implemented live capabilities to make the run predictable.
2. **Production facts stay real.** The real detected game, save, world state, time, mechanics, native failures, observations, receipts, and teardown come from production owners. Release evidence uses an explicitly verified environment, but ordinary product launch is not restricted to that exact tuple. Test code may observe these facts but may not manufacture authority.
3. **All implemented live capabilities are disclosed.** The Agent receives the normal production intersection of Mod-published capabilities, Host-known typed tools, and explicit player policy. There is no release manifest, scenario subset, or family quota that further narrows gameplay.
4. **Causally composable transitions, one native mutation in flight.** Agent-level composition remains `observe → typed action → Mod-owned terminal receipt/action-specific postcondition → fresh observe → next typed action`. This is sequential effectful composition, not a gameplay quota: the Agent can take any number of prompt-defined steps. Host must neither pre-admit/queue arbitrary future actions nor synthesize Mod execution receipts for un-dispatched steps. A concrete native deep action may span ticks only when it provides one real Mod-owned capability that this loop cannot equivalently express; it owns one execution lifecycle, cancellation, terminal receipt, and overall postcondition.
5. **No product gameplay quotas.** A production task ends because the Agent concludes the prompt-defined task, the player stops or redirects it, the game makes it impossible, the provider/runtime returns a real terminal failure, or the owning surface closes. Host counters and timers must not turn continued valid play into `blocked` or `cancelled`.
6. **Harness bounds are not product semantics.** Deterministic tests and a release runner may impose an external process timeout so automation cannot hang forever. That timeout kills the harness/run and records a gate failure; it is not delivered to the Agent, stored in the gameplay task, interpreted as a game outcome, or shipped as a product task limit.
7. **No proof-driven infrastructure.** Add only the IPC and content-free summaries needed to run and evaluate the real product loop. Do not add content hashes, synthetic scorers, arbitrary attestation layers, or a second execution pipeline.
8. **One action registration authority.** An action ID, family/lifecycle, typed input contract, implementation binding, and completion contract are declared together exactly once in the adapter-owned runtime registration. Generated artifacts and Host/browser projections are consumers, never parallel registries.
9. **Runtime action-catalog refresh.** The Mod can atomically publish availability additions from its fixed startup-composed registration set, withdrawals, or policy/live-support changes as a new immutable catalog revision. The active Host/Pi Game session updates its mounted typed tools at the next safe provider boundary without restarting the task. This is hot-add from the running Agent's perspective; adding new code/registration still follows SMAPI reload/restart. Withdrawal blocks new admission immediately; a stale captured tool fails before bridge write and again on the game thread.
10. **Easy player launch is a release hard gate.** A fresh player can use the shipped frontend to set up, launch, attach, stop, reconnect, and obtain safe diagnostics. The UI follows `design/26`'s Chat-first single-drawer model and never exposes paths, PIDs, pipe names, tokens, hashes, profile revisions, or operator configuration.
11. **Compatibility is guidance, not an allowlist or proof program.** Minimum-adapted, verified, and detected versions are separate facts. Set the advisory minimum conservatively from lightweight primary evidence such as official Stardew/SMAPI API documentation, the Mod manifest, and a bounded review of obvious load-time dependencies; do not require an action-by-action compatibility audit, a historical-version matrix, or live execution merely to choose it. An unverified/newer version produces a non-blocking warning and remains launchable. A below-minimum version requires an explicit warning/continue decision but is not policy-blocked. Only an actually detected loader/protocol/peer incompatibility may block AI attachment, and it must not block launching the player's game.
12. **Two Stardew processes remain the approved topology.** The player Host and isolated AI client are separately owned/profiled roles hidden behind one frontend action. Do not replace them with shadow farmers, input injection, split-screen automation, or a generic process picker.
13. **No legacy compatibility.** Remove retired experimental paths rather than preserving aliases, migrations, or fallback dispatch.

### Implementation discipline from `AGENTS.md`

- Build the smallest real end-to-end **first-party Stardew** player path first, then layer reconnect, diagnostics, and broader compatibility presentation onto that working path. Do not replace it with a universal launcher/profile/config framework. The later community connector ABI is separately owned by `design/97_COMMUNITY_GAME_CONNECTOR_ARCHITECTURE.md`; this plan neither loads third-party code nor invents its runtime.
- Reuse the existing Host browser contract, Pi session API, SMAPI lifecycle, version parsing utilities, and process-management facilities after reading their current documentation/type definitions. Add a dependency only when an existing dependency/platform API does not cover the need.
- Keep launcher ownership, action registration, Host tool projection, gameplay execution, browser presentation, and release harness as separate modules with narrow interfaces; do not combine them into a universal manifest or dispatcher.
- A check must prevent a named realistic failure. Prefer focused behavior tests and ordinary typed boundaries over hashes, source scanners, attestation chains, redundant parity layers, or compatibility databases.
- Compatibility guidance is deliberately approximate and non-authoritative. If official documentation plus the manifest supports a conservative advisory minimum, stop there; additional investigation is justified only by a concrete load/runtime failure or an ambiguous API dependency that changes player behavior.

---

## 2. Scope and completion boundary

This plan completes when all of the following are true:

- the duplicate SOP/category runtime is absent from source, protocol, Mod publication, generated/build artifacts, and tests;
- every ordinary Farmhand action has exactly one adapter-owned runtime registration and no duplicated Host registry, handler `SupportedActions` list, manual router-membership list, descriptor membership list, or release-manifest membership source remains;
- an authenticated immutable action-catalog revision can add, withdraw, or change availability while the Game session remains alive; Host atomically rematerializes Pi tools, a newly added loaded typed action is callable on the next provider turn, and stale/revoked tools fail before mutation;
- the Game integration seam exposes the source-owned facts needed to correlate action ID, action-catalog revision, terminal receipt, action-specific postcondition, and fresh observation without importing Stardew types into generic Host lifecycle code;
- the private gameplay worker has no product turn, tool-call, wall-clock, retry, accepted-action, or action-family quota; the prompt and real terminal events define task lifetime;
- from a fresh GameBuddy-owned installation state, the shipped frontend can discover or manually select and strictly register Stardew through the Design 101/104 product flow, setup prerequisites, launch SMAPI/Stardew, attach to an existing instance, manage the approved separate Host/AI-client roles, confirm attachment, stop/reconnect, and show actionable redacted diagnostics without command-line or manual config;
- ordinary launch distinguishes minimum-adapted, verified, and detected versions; exact target pins remain only in release/live harnesses; unverified versions warn rather than block and action availability can shrink independently;
- harmful player-facing hardcodes identified in Task 5 are removed, derived from product/runtime authority, or retained only with an explicit invariant and truthful UI consequence;
- the immutable production `main.js` can be launched by `tools/run-game-operational-gate.mjs`, receives one launch-owned prompt-defined task through a private IPC contract, uses the normal Game runtime and full production tool projection, and returns only a content-free terminal summary;
- one verified-environment Stardew live run demonstrates the same shipped frontend/launcher composition plus an Agent-chosen prompt-defined task; every typed transition that actually occurs is separated from any later action by a fresh observation and carries source-owned receipt/postcondition evidence, while honest zero/one/many-transition terminal outcomes, STOP/teardown closure, and no preset action sequence or capability subset are preserved;
- deterministic Host/browser tests, C# tests, selected PBT, production artifact checks, player journey checks, and the live gate pass;
- a Browser Preview milestone is labeled as such; a **Desktop Player Release** additionally satisfies Design 103 distribution/shell/update closure and Design 104 complete onboarding/Chat/Game journey closure. Browser Playwright evidence cannot be relabeled as tray/WebView2/installer proof.

This plan does **not** require every Stardew action, arbitrary in-process C# binary hot swapping, a universal gameplay ontology, a community connector runtime, plugin marketplace, a second full game integration, an RL reward model, or an arbitrary composite-action DSL. It must leave game-specific launch facts inside the Stardew implementation so that the later connector ABI does not inherit SMAPI concepts.

---

## 3. Category-theoretic keep / fold / remove decision

| Existing work | Decision | Reason |
|---|---|---|
| `GameIntegrationModule` and restrictive live tool projection | **Keep/deepen** | This is the useful structure-preserving cross-game seam. |
| action-specific receipt/postcondition checks | **Keep/deepen** | They establish the real transition/outcome correspondence. |
| capability intersection and denial policy | **Keep** | Useful pullback-like law already integrated into the production path. |
| cancellation, idempotency, terminal monotonicity laws | **Keep and test** | These are executable invariants of effectful composition. |
| focused observation projections | **Keep only where consumed** | Useful when they improve Agent context without becoming authority. |
| generic action AST / SOP serialization | **Remove** | Re-expresses actions the Agent already composes. |
| Host preflight plan interpreter | **Remove** | Unused approximate shadow validation. |
| retired Host `dynamic-action-registry.ts` | **Remove** | Parallel in-memory authority with no Mod lineage. Replace it with authenticated revisions from the one adapter-owned action registry, not another Host registry. |
| generic pullback/equalizer receipt | **Remove** | Self-described expected values are not action-specific authority. |
| C# SOP pipeline, step handlers, live step runner | **Remove** | A second dispatcher with weaker per-step lifecycle semantics. |
| protocol codegen experiment and category verification gate | **Remove unless independently proven production-owned before execution** | They are not integrated into the current protocol authority/build path and are out of this release closure. |
| generic `Result<TValue,TError>` introduced only for SOP | **Remove** | No remaining consumer or independent product capability. |

---

## 4. Implementation sequence

### 4.0 Subagent delivery protocol and atomic-commit boundaries

Every mutation-capable implementation wave for this plan uses the project's `subagent-driven-development` skill. A numbered Task is a release-planning unit, not permission to launch an unbounded swarm or to make one oversized commit. Before dispatching a writer, the parent freezes the matching slice card below into the handoff with the exact changed paths, acceptance test names, current source facts, and stop condition. A child must stop rather than broaden the slice when it discovers a new product, authority, topology, or compatibility decision.

| Task | User-visible result | Producer → consumer → verifier assertion | Mutation lanes / launch budget | Stop or escalation condition |
|---|---|---|---|---|
| 1 | Agent can only use the existing atomic action loop; the retired SOP action cannot appear. | protocol/Mod publication → router/tool projection → Host/C# absence characterizations | One connected Host+Mod writer; one fresh read-only reviewer; no live mutation. | Any remaining production consumer requires an unapproved replacement execution semantic. |
| 2 | A policy/live-support-enabled loaded action appears as its own tool on the next safe Agent turn; a withdrawn one cannot execute. | closed Mod registration → authenticated catalog revision → Host descriptor view/rematerializer → next-turn tool/Mod admission test | One connected writer for registration/bridge/Host seams; one reviewer; no live mutation. | Pinned Pi SDK cannot provide a session-local idle-boundary refresh, or a change needs new binary loading. |
| 3 | A terminal action outcome is truthfully correlated to its fresh postcondition observation. | Mod ledger/capability surface → adapter projection → generic integration view contract test | One connected adapter writer; one reviewer; no live mutation. | Required lineage cannot be produced by the existing authoritative Mod ledger. |
| 4 | A valid prompt-defined task is not stopped by Host counts or clocks, while overlapping native mutation remains serialized. | worker/coordinator → runtime settlement → task-lifetime and concurrency tests | One Host writer; one reviewer; no live mutation. | A proposed removal would weaken explicit STOP, native cancellation, or ownership closure. |
| 5 | A player can launch/attach through truthful compatibility and two-role ownership rather than manual config/exact certified pins. | discovery/launcher → authenticated lifecycle state → process/compatibility tests | One **authority-spine** writer for each connected private-session stage; launch all disjoint Task 1, Task 4, and Task 6-kernel lanes in parallel; one reviewer per accepted lane; no live mutation. | Discovery, native peer negotiation, or loader facts require a new platform/support policy. |
| 6 | The Chat-first shipped UI offers a truthful “Play with companion” drawer backed by real operations. | lifecycle service → browser contract → drawer → fresh-root browser journey | One Host-contract writer followed by one frontend writer on disjoint paths; one final reviewer; no live mutation. | A required control lacks a mounted Host operation or design 26 needs a new UX decision. |
| 7 | The ordinary frontend launch path survives catalog add/withdraw, STOP, and reconnect without a task restart. | UI command → lifecycle composition → catalog revision/tool refresh → composed integration test | One connected composition writer; one reviewer; no live mutation. | The result requires a second action authority, a hidden operator route, or a binary hot loader. |
| 8 | The production gate can observe a minimal, source-owned transition aggregate without steering the Agent. | receipts/snapshots/STOP facts → one Host projection → aggregate/PBT tests | One Host evidence writer; one reviewer; no live mutation. | A field needs prompt/model/action payload content or a new evidence authority. |
| 9 | The immutable production entry accepts exactly one launch-owned prompt-defined task and returns only redacted evidence. | launcher nonce IPC → existing private worker → facade/evidence IPC tests | One production-composition writer; one reviewer; no live mutation. | It would expose a public task API or bypass the normal Game runtime. |
| 10 | The operational runner starts the shipped composition and fails honestly on malformed/missing production facts. | runner → production child IPC → evidence parser/exclusive report → deterministic negative tests | One runner writer; one reviewer; no live mutation. | The runner must inspect Agent planning, mint authority, or retry a native mutation. |
| 11 | One real Agent-chosen multi-step Stardew session closes through STOP/teardown. | shipped UI/launcher/runtime → native transitions/observations → reviewed live report | No mutation writer before preflight; one independent preflight reviewer; **one** live mutation allowance. | Any preflight fact is missing, teardown is unproven, or the live result reveals a defect. |
| 12 | Current designs state one coherent release authority and verified status. | verified command/live evidence → owning designs/status index → document review | One documentation writer; one reviewer; no live mutation. | The update would claim completion without evidence or conflict with a current owner. |

**Wave rules.** Each writer returns changed files, commands with exit codes, the newly proven or blocked producer→consumer→verifier assertion, residual risk, and any decision requiring approval. The parent runs the cheapest seam check after each connected edit, then the Task's focused combined checks. Only then does one fresh reviewer inspect the actual diff and evidence. A broad suite is run when the Task's risk warrants it, not mechanically after every local edit. Existing unrelated dirty work is never staged, changed, reverted, or used as validation evidence.

**Commit rules.** Commit only a green, reviewer-cleared Task slice with exact path/hunk staging. Keep implementation with its direct tests; do not include unrelated worktree changes, generated runtime roots, credentials, preview/session artifacts, or a failing partial refactor. Use the repository's imperative-message style and never add AI/co-author trailers. The `design/` directory is currently ignored: do not force-add ignored documents merely to satisfy a commit boundary. If design documents are deliberately promoted under a separately approved repository policy, use the indicated documentation commit after its source evidence exists.

| After verified slice | Atomic commit(s) | Notes |
|---|---|---|
| Task 1 | `Remove parallel SOP action runtime` | Includes only removals, direct absence tests, and tracked protocol/router changes. |
| Task 2 | `Consolidate Farmhand action registration` then `Refresh live action tools from Mod catalog` | The first closes the sole registration/projection seam; the second adds revision publication and idle-boundary refresh. Do not merge them if the first is independently green. |
| Task 3 | `Project source-owned action transition facts` | Includes bridge/adapter contracts and direct PBT only. |
| Task 4 | `Remove gameplay task quotas` | Includes worker lifetime tests and coordinator mutual-exclusion test. |
| Task 5 | `Add Stardew launcher compatibility service` then `Remove player launch hardcodes` | The first establishes discovery/ownership/classification; the second removes manual config, hidden model, and blanket-timeout blockers. |
| Task 6 | `Add Game browser lifecycle contract` then `Add Game launch drawer` | The browser contract/read-back lands before the UI. |
| Task 7 | `Compose Game launch with live action refresh` | Requires the complete composed acceptance scenario, not a mocked route. |
| Task 8 | `Emit source-owned game transition evidence` | Contains the minimal aggregate and its direct law tests. |
| Task 9 | `Add private production game task ingress` | IPC remains launch-owned and non-public. |
| Task 10 | `Run operational gate through production composition` | Includes deterministic forgery/timeout negatives. |
| Task 11 | No source commit for a clean live run; if a repository-approved redacted evidence location is tracked, `Record verified Stardew gameplay evidence` | A defect is fixed offline in its owning Task-sized commit before another live-mutation decision. Never commit mutable runtime data or secrets. |
| Task 12 | `Document prompt-defined Game release architecture` | Only after the referenced status is supported by verified command/live evidence and only if document tracking is explicitly enabled. |

### 4.1 Concurrent execution graph and Task 5 authority spine

This plan deliberately does **not** serialize unrelated deterministic work behind the Stardew launcher. The parent must launch every ready, disjoint mutation lane in the same wave. A lane is blocked only by a named producer it consumes; a shared file or authority decision remains single-writer. All writers and reviewers use their default configured models. A review starts only after its lane's writer has finished the focused checks; it does not block other ready writers.

```text
Wave A — ready immediately, disjoint paths
  A1 Task 5 Phase-B rollback correction
     composer core/test only
     → exact Player-Host bootstrap profile without AI/Bridge material
  A2 Task 1 retired SOP/category runtime removal
     action/Mod/router paths
     → no parallel action authority
  A3 Task 4 prompt-defined task lifetime
     gameplay worker/coordinator paths
     → no product task quota; native mutation remains serialized
  A4 Task 6 composed browser-session broker kernel
     browser contract/composition paths only
     → one bootstrap/session/CSRF owner; no mounted launcher command required

Wave B — start each lane at its own named predecessor
  B1 Task 5 closed Player-Host launch: after A1 acceptance only.
     It consumes the exact owned transaction and admitted installation inside the
     private composition. It must not stage AI material, provision a Farmhand,
     or wait for attestation.
  B2 Task 2 runtime action-catalog registration: after A2 acceptance.
  B3 Task 3 source-owned receipt/postcondition projection: after B2 acceptance.
  B4 Task 6 mounted Game drawer contract: after A4 and the Task 5 lifecycle
     operation it invokes exist. UI work remains blocked only by that operation,
     not by native AI launch or live evidence.

Wave C — explicit joins, never speculative parallel mutation
  C1 Task 5 native Player-Host provisioning → signed manifest → AI late-stage
     material/launch → matching role/generation hello attestation. This is one
     connected private-session authority chain and has one writer at a time.
  C2 Task 7 composed browser launch/reconnect: after B2, B3, B4, and C1.
  C3 Task 8 minimal transition aggregate: after B3 and A3; it does not wait for
     Task 5 UI composition.
  C4 Task 9 private production task ingress: after C2 and C3.
  C5 Task 10 operational runner: after C4.
  C6 Task 11 one-shot live mutation: after every required static predecessor,
     preflight, and independent review. It remains serial and has exactly one
     live allowance.

Task 12 documentation is a trailing evidence consumer. It may prepare an
inventory in parallel, but may claim only evidence that its owning lane has
already verified.
```

**Task 5 shared-authority rule.** `stardew-private-bootstrap-composer.core.ts`
and its direct test-support form one authority-spine mutation lane. Do not run
parallel writers against them. A later Task 5 writer may start only after the
previous core lane is green and reviewed. In contrast, Task 1, Task 4, and the
Task 6 broker kernel may run concurrently in the dirty shared worktree because
their owned paths are disjoint; each handoff must list the exact paths and
prohibit edits outside them. A finding in one lane does not restart, cancel, or
serialize an independent lane.

**Current Task 5 cut line.** The durable Phase-A owned binding, installation
admission, production artifact/package closure, endpoint source-of-truth, and
public-owner authority closure are prerequisite evidence. Initial Phase B now
has one remaining correction: it may materialize only the Player-Host bootstrap
profile. The AI profile, bridge pipe/token, Farmhand provisioner config, and
manifest consumption are a later C1 consumer of a native Player-Host signed
manifest and must not be written by Phase B. The Phase-B rollback correction
and the Player-Host-only profile test are the sole current Task 5 core writer
lane; no Player-Host or AI process may be spawned by it.

**Frozen C1 no-spawn materialization successor.** After the composition-private,
fieldless `StardewManifestAdmission` has been minted from the native signed
manifest, its only first consumer is the same closed composer. It consumes the
admission exactly once and prepares a fixed isolated `ai-client/Mods/GameBuddy`
profile under the exact transaction root. The leaf `ai-client` is a
core-private topology constant, not a caller, browser, operator, or manifest
input. It writes the verified published Mod package and an exact
`FarmhandProvisioner` config whose `ManifestPath` points directly to the
already verified, Host-owned `<transaction>/session/stardew-farmhand-manifest.json`;
it never copies, rereads, or becomes a second authority for that signed
manifest. Its `SessionToken` and integration version come only from the
existing owner-private Stage-B material.

This first C1 consumer writes neither `EnableLocalBridge`, `PipeName`,
`BridgeToken`, nor any bridge scope/endpoint/role/generation field: the signed
manifest does not establish the Mod's local bridge `PlayerId` or a pipe/token
derivation, and those facts remain for the later launch plus matching
role/generation-hello slice. It consumes no AI reservation, starts neither
role, opens no pipe, creates no native client, and projects no ready/connected
state. All publication remains under the owner lock with a static owned
inventory, create-only writes, byte rereads, identity-safe rollback, and
terminal quarantine on any write, reread, expiry, correlation, cleanup, or
persistence uncertainty. The one-shot admission remains consumed even if this
materialization fails. The public facade continues to expose no admission,
manifest, path, secret, or materialization operation.

**Frozen C1 Player-Host signed-advertisement attestation precursor.** The next
connected C1 slice closes the existing prerequisite that *every directly
launched Mod* returns its manager-minted role/generation before it can advance
past awaiting attestation. It changes neither the AI bridge topology nor the
public lifecycle surface. A directly launched Player Host must derive its
opaque `launchGeneration` only from
`GAMEBUDDY_STARDEW_LAUNCH_GENERATION`; if HostFarmhandProvisioning is enabled
and that value is missing or invalid, the Mod fails closed and publishes no
advertisement. The sole existing signed `stardew-session.json` producer adds
`runtimeRole: "player_host"` and the exact `launchGeneration`, and the values
are covered by its existing HMAC.

The existing attachment verifier is the sole Host verifier: it rejects a
missing, malformed, wrong-role, or invalid role/generation pair before any
consumer sees a session, and includes both fields in same-session binding
correlation. In the same private composer that owns the direct Player-Host
reservation, manifest coordinator `select()` consumes a one-shot,
concurrency-safe Player-Host advertisement-attestation check before minting a
cabin selection. It compares the fresh verified `player_host` generation to
the exact private `StardewPlayerHostLaunchRegistration` generation. A mismatch
is terminal quarantine and mints no selection; a missing/transient
advertisement may restore the check only within the original absolute owner
deadline. This never writes Bridge config, starts/attests the AI client,
consumes its reservation, connects a pipe, creates an action Bridge role,
projects ready/connected, or exposes generation/session/path/token/PID through
any browser, public composer, public test-support, owner record addition, or
lifecycle DTO. `player_host` remains outside `BridgeRuntimeRole`: its evidence
is the signed provisioning advertisement, not a Player-Host action bridge.

**Acceptance scenario:** Given an owned Player Host was directly launched with
generation G and its native Mod publishes a fresh HMAC-signed `player_host` advertisement
with G, when the same closed composition selects a cabin, then it mints one
selection and consumes the Player-Host advertisement attestation while leaving
the AI reservation pending and spawning no AI client. Given a missing,
malformed, unauthenticated, wrong-role, wrong-generation, expired,
forged/cross-composition, duplicate, or concurrently replayed attempt, then no
selection is minted; a generation mismatch quarantines the exact owner, while
transient absence can retry only before its original deadline.

**Owned implementation paths:**
`integrations/stardew/ModEntry.cs`,
`integrations/stardew/FarmhandProvisioningModels.cs`,
`integrations/stardew/HostFarmhandProvisioner.cs`, their focused integration
tests, `host/src/stardew-attachment.{ts,test.ts}`,
`host/src/stardew-private-bootstrap-composer.{core.ts,test.ts}`, and only a
necessary dedicated internal test adapter. Do not modify the public composer,
browser, generic Bridge protocol, C# AI provisioner, or lifecycle facade.

### Task 1 — Retire the parallel SOP/category runtime

#### Current bounded execution slice — receipt-to-snapshot admission fence

```text
User-visible result:
  A gameplay worker may continue an open-ended multi-step task, but cannot send
  a following ordinary native action from a stale world view.

In scope / explicit non-goals:
  Add only the restrictive Host fence and an actual worker-tool acceptance
  characterization. Do not add a workflow engine, task quota, Host receipt
  authority, action batching, bridge protocol field, or Mod queue change in
  this slice.

Required topology and authority boundary:
  Mod produces terminal receipt {requestId, executionId, actionId, revision}
  and snapshot {revision, activeExecution}. The adapter projects both. The
  worker remembers only the terminal receipt revision as a restrictive local
  minimum; it may not synthesize, repair, or infer either fact.

Acceptance scenario:
  Given action A was admitted from snapshot N and Mod later publishes its
  terminal receipt at revision R, when the adapter still exposes snapshot N or
  any snapshot < R, then ordinary action B is rejected and writes no bridge
  request. And when the normal adapter state exposes a Mod snapshot >= R with
  activeExecution null, B is admitted and dispatched using that snapshot.

Scenario-batch boundary:
  This receipt→snapshot→next-dispatch proof lands as one connected Host slice.

Cheapest checks:
  Focused gameplay-task worker test after the test/implementation seam, then
  Host test typecheck and its compiled focused test. Run diff --check at batch
  end.

Mutation lane / owned paths:
  One writer: host/src/gameplay-task-subagent.ts and
  host/src/gameplay-task-subagent.test.ts. No other edits.

Independent review question:
  Does the fence only subtract admission while preserving Mod as the producer
  of receipt/snapshot facts, and does the test exercise the normal adapter
  state path rather than a pure helper?

Launch budget / stop condition:
  One writer, one final read-only review, no live mutation. Stop if satisfying
  the scenario needs a new protocol field, a new authority owner, or a gameplay
  lifetime/count/time limit.
```

**Files:**

- Delete: `host/src/action-ast.ts`
- Delete: `host/src/action-ast.test.ts`
- Delete: `host/src/action-preflight-interpreter.ts`
- Delete: `host/src/action-preflight-interpreter.test.ts`
- Modify: `host/src/action-execution-coordinator.internal.ts` — retain admission, receipt-order, correlation, and cancellation ownership; delete only generic `ActionBatch`/`executeBatch`.
- Modify: `host/src/action-execution-coordinator.internal.test.ts` — remove batch tests; retain only ordinary admission/correlation/cancel coverage.
- Modify: `host/src/gameplay-task-subagent.ts` — retain the Mod receipt's terminal revision as a restrictive next-action admission fence; do not mint transition facts.
- Modify: `host/src/gameplay-task-subagent.test.ts` — verify `receipt revision R` plus a stale snapshot `< R` still blocks the next action, and a current Mod snapshot `>= R` with no active execution permits it.
- Delete: `host/src/dynamic-action-registry.ts
- Delete: `host/src/dynamic-action-registry.test.ts`
- Delete: `host/src/pullback-receipt.ts`
- Delete: `host/src/pullback-receipt.test.ts`
- Delete: `host/src/protocol.generated.ts`
- Delete: `host/src/protocol-roundtrip.test.ts`
- Delete: `tools/generate-protocol.mjs`
- Delete: `tools/verify-category-theoretic-architecture.mjs`
- Delete: `integrations/stardew/src/Core/Protocol/Protocol.Generated.cs`
- Delete: `integrations/stardew/src/Core/Abstractions/IStepHandler.cs`
- Delete: `integrations/stardew/src/Core/Algebra/Result.cs`
- Delete: `integrations/stardew/src/Core/Algebra/SopStepPipeline.cs`
- Delete: `integrations/stardew/src/Core/Algebra/PullbackEvidence.cs`
- Delete: `integrations/stardew/src/Core/Handlers/StepHandlers.cs`
- Delete: `integrations/stardew/src/Core/Handlers/SopCompositeActionHandler.cs`
- Delete: `integrations/stardew/Handlers/SmapiLiveStepRunner.cs`
- Delete: SOP/category-only tests under `integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/`
- Modify: `integrations/stardew/ModEntry.cs`
- Modify: `integrations/stardew/ExecutionManager.cs` — remove unused generic pending-action queue; retain single native-action lifecycle ownership.
- Delete: `integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/ExecutionManagerQueueTests.cs`
- Modify: `integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs`
- Modify: `host/src/protocol.ts`
- Modify: `protocol/bridge-v1.schema.json`
- Modify: affected protocol/policy/router characterization tests
- Modify: `design/85_CATEGORY_THEORETIC_ACTION_AND_EVIDENCE_ARCHITECTURE_SPEC.md`
- Modify: `design/86_CATEGORY_THEORETIC_ACTION_AND_EVIDENCE_IMPLEMENTATION_PLAN.md`
- Modify: `design/88_CATEGORY_THEORETIC_CORE_ARCHITECTURE_OPTIMIZATION_SPEC.md`
- Modify: `design/89_CATEGORY_THEORETIC_CORE_ARCHITECTURE_OPTIMIZATION_IMPLEMENTATION_PLAN.md`

- [ ] **Step 1: Write the failing absence characterizations.** Add source-level and runtime characterizations asserting that `sop_composite_pipeline`, Host `ActionBatch`/`executeBatch`, and `ExecutionManager.EnqueueAction`/`pendingActionQueue` are not a protocol action, are not Mod-published, are not router-registered, and cannot materialize as an Agent tool. Assert the normal published atomic tool projection is unchanged.
- [ ] **Step 2: Write the causal-composition negatives.** For an ordinary action whose immediate bridge response is `accepted`, `running`, or any non-terminal state, prove no subsequent ordinary action is dispatched until its Mod-owned terminal receipt has been received and a fresh snapshot at/after that receipt revision with `activeExecution: null` is available to the worker's normal adapter state. The worker records the receipt's Mod-owned revision only as a restrictive local minimum; it does not calculate, repair, or fabricate transition facts. Prove STOP/redirect before the next admission yields no next bridge write and no Mod execution receipt for that un-dispatched step. These are Agent/worker + bridge integration tests, not a replacement batch runtime.
- [ ] **Step 3: Run the focused Host and C# characterizations and confirm failure while the retired paths remain.**
- [ ] **Step 4: Delete the parallel modules and remove every production reference.** Remove only the generic `ActionBatch`/`executeBatch` portion of `ActionExecutionCoordinator`; retain its ordinary admission, receipt-order, correlation, and exact cancellation ownership. Its Host-synthetic `cancelled` records are not Mod receipts. Delete the unused generic `ExecutionManager` queue and its tests rather than adapting it into a workflow engine; no ordinary bridge request may become an automatically executed closure based on an old observation. Preserve `ExecutionManager` ownership of one active native action lifecycle and `StardewBodyController` only as its movement/native-controller dependency. Do not retain aliases, compatibility parsing, or a hidden diagnostic lifecycle entry.
- [ ] **Step 5: Rewrite designs 85/86/88/89 as superseded records.** Preserve the useful laws and explicitly point to this plan; record that effectful composition is terminal-receipt-plus-fresh-observation sequencing, while a true native deep action is one Mod-owned typed action rather than a Host batch/DSL.
- [ ] **Step 6: Remove generated test artifacts (`host/dist-test`) through the normal clean/build path, not manual production edits.**
- [ ] **Step 7: Run:**

```bash
pnpm --filter @gamebuddy/companion-host typecheck
pnpm --filter @gamebuddy/companion-host test
dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/GameBuddy.Stardew.Core.Tests.csproj
dotnet test integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/GameBuddy.Stardew.Integration.Tests.csproj
rg -n "sop_composite_pipeline|SopComposite|SopStepPipeline|createDynamicActionRegistry|serializeDomainActionPipeline" host integrations protocol tools
```

**Expected:** test suites pass; the final `rg` has no production/test hits outside explicitly superseded design history. The causal-composition negative proves a terminal receipt and fresh observation are both required before the next ordinary bridge write.

**Commit checkpoint:** after the connected Host+Mod slice is green and a fresh reviewer confirms that the atomic tool projection and single-active-native-action lifecycle are unchanged, stage only this Task's tracked source/tests and commit `Remove parallel SOP action runtime`. Do not force-add ignored superseded design records; record their final path/status in the implementation handoff instead.

---

### Task 2 — Consolidate one action registration and support safe runtime catalog refresh

**Files:**

- Modify: `integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs`
- Modify: `integrations/stardew/src/Core/Abstractions/IFarmhandActionHandler.cs`
- Modify: `integrations/stardew/src/Core/Routing/FarmhandActionRouter.cs`
- Modify: `integrations/stardew/ModEntry.cs`
- Modify: ordinary Farmhand handler files under `integrations/stardew/Handlers/`
- Modify: `integrations/stardew/ModConfig.cs`
- Modify: `integrations/stardew/src/Core/Policy/ActionPolicyEngine.cs`
- Modify: `integrations/stardew/src/Core/Policy/FarmhandCapabilitySurface.cs`
- Modify: `integrations/stardew/BridgeSession.cs`
- Modify: `integrations/stardew/ExecutionManager.cs`
- Modify: `protocol/bridge-v1.schema.json`
- Modify/regenerate: bridge protocol generated artifacts only through their owner
- Modify: `host/src/integration.ts`
- Modify: `host/src/integration-module.ts`
- Modify: `host/src/integration-module.test.ts`
- Modify: `host/src/stardew-integration-module.ts`
- Modify: `host/src/game-tools.ts`
- Replace/delete: `host/src/action-registry.ts` as an independent handwritten registry
- Modify: `host/src/runtime.ts`
- Modify: focused Mod/router/capability/Host runtime tests

**Registration rule:** `FarmhandActionCatalog` remains the adapter/Mod authority, but its entries deepen from policy-only identity rows into closed typed ordinary-action registrations. A central trusted **startup composition** registers each action once by supplying its definition, JSON-schema-compatible Agent contract, typed argument codec, concrete handler factory, and runtime action-specific completion/evidence contract. Handler classes do not repeat action ID membership through `SupportedActions`; `ModEntry` does not repeat router membership; Host does not maintain a TypeScript action registry or per-action adapter map. The Mod serializes a bounded runtime descriptor from the same registration, and Host validates that descriptor before dynamically creating the independently named typed Pi tool. `IntegrationActionCatalog` becomes only an immutable authenticated cache/view of the exact Mod descriptor revision; it does not accept static Host entries, calculate a replacement authority revision, or add membership. Do not introduce a second language-neutral registry, generated action-membership catalog, source scraping, or first-text-match anchors.

Action live-gate/fixture requirements stay in separate non-authoritative closure descriptors as required by design 38 §2.3. They reference the canonical versioned action identity and pass structural parity checks, but their presence/absence cannot change runtime publication, routing, tool materialization, or success.

A registration must not contain arbitrary delegates supplied by Host/config/Agent, native member names, reflection tokens, or caller-controlled raw native dispatch. Concrete typed codecs and implementation factories remain closed inside the trusted Mod composition. Startup and runtime validation prove every published ID has exactly one typed native binding and a valid materializable descriptor; malformed or duplicate registration fails before publication. Browser clients receive only a redacted capability summary, not executable descriptors.

The bridge keeps one generic **transport envelope** (`actionId`, revision, identity/deadline/idempotency fields, and JSON arguments) because cross-game/runtime action membership is dynamic. It is not an Agent tool or native dispatcher. The exact revision descriptor validates arguments before Host write, the matching Mod registration decodes them into a typed request, and game-thread admission/handler validation runs again. Remove handwritten action-ID unions and per-action membership branches from Host protocol validation once this path is proven; retain structural envelope validation and action-specific schema/codec validation from the one registration.

**Runtime catalog semantics:**

```text
one loaded registration catalog
∩ fresh Mod policy/settings
∩ live integration/world support
→ immutable ActionCatalogRevision N
→ authenticated hello/update/snapshot projection
→ Host restrictive typed tool materialization for N
→ embedded Pi active tools replaced atomically at a safe turn boundary
```

- Add/enable: policy or fresh live-world support may enable one action from the fixed startup-composed loaded registration set in revision `N+1` while the Game session remains alive. No config, Host message, bridge payload, or Agent input may create a registration or select a native handler.
- Withdraw/disable: new admission is revoked immediately in `N+1`; an active already-linearized native execution follows its existing cancel/terminal rules and is not rewritten after side effects.
- Stale closure: every tool execute rechecks exact current revision and membership before bridge write; Mod rechecks again on the game thread.
- Provider boundary: do not mutate `session.agent.state.tools` while a provider call/tool batch is active. Queue the latest revision and swap once the Agent is idle/before the next provider request. Pi SDK explicitly supports replacing `AgentSession.agent.state.tools`; extension APIs also support runtime registration/activation, but GameBuddy should use one Host-owned rematerializer rather than player/global Pi extensions.
- New registration/C# code: adding a registration or handler outside the startup-composed set requires a supported Mod/game restart. Do not add arbitrary assembly loading or mislabel policy/live-support refresh as binary hot reload.

- [ ] **Step 1: Write failing exact-registration coverage tests.** Each registrable ordinary action appears once in startup composition, has one typed codec/handler factory/runtime completion contract and a materializable runtime descriptor, and has no separate handwritten handler membership, `ModEntry.router.Register(...)` list, TypeScript action registry, or per-action Host adapter map. Duplicate, unknown, missing, malformed, and unprojectable registrations fail closed. Config, Host, bridge, and Agent inputs cannot create a registration or choose a handler. Separate non-authoritative closure descriptors have exact identity parity but no execution influence.
- [ ] **Step 2: Replace `SupportedActions`, manual router composition, independent Host/`IntegrationActionCatalog` membership, and handwritten protocol action membership.** Route, policy, runtime descriptors, dynamic typed-tool materialization, and discovery consume the canonical registration projection. Refactor `createIntegrationActionCatalog` into a passive exact-revision descriptor view received from the authenticated Mod; it cannot accept static Host entries or mint its own membership revision. The bridge protocol retains only its generic structurally validated transport envelope; exact action arguments are validated/decoded by the revision descriptor and matching Mod registration. Closure planning stays separate and non-authoritative. Delete replaced lists and compatibility aliases; do not replace them with a generated cross-language membership catalog.
- [ ] **Step 3: Add an immutable Mod-owned monotone action-availability revision and authenticated runtime publication.** Static registration identity is projected once in `hello_ack`; a session-scoped `catalogRevision` means only the current enabled-action publication, never a registration hash or second authority. `hello_ack`, `snapshot`, and a dedicated authenticated `catalog_update` message carry the same complete, sorted, unique `{ catalogRevision, enabledActionIds }` replacement projection. The update does not repeat registration family/lifecycle/version metadata. It is scoped to the current authenticated bridge generation, accepts only a strictly newer revision, and atomically replaces Host state; an older/duplicate-conflicting/unknown/unsorted list fails closed. A revision jump is allowed because every update is a complete replacement. Snapshot and hello must expose the same exact revision/list.
- [ ] **Step 4: Implement game-thread config/policy reload.** Read/validate through one Mod-owned reload seam, derive a fresh immutable availability publication from the fixed startup registrations, atomically install it for execution admission, hello, snapshot, and update, then publish it only when its enabled set changed. Never mutate an existing publication or reload from an arbitrary thread. Withdrawals immediately block new admission but do not rewrite an already-linearized native execution; runtime add only re-enables an action from the fixed startup registration set.
- [ ] **Step 5: Characterize the pinned Pi SDK before implementing rematerialization.** Prove from the installed SDK/type definitions and a focused test that replacing session-local tools is supported, observed by the next provider request, and not applied during an active prompt/tool batch. Then rebuild typed tools from `authenticated runtime descriptors ∩ current revision ∩ player policy` and update the same embedded Agent session at the proven idle boundary. If direct replacement cannot provide this semantic, use the documented session-local activation mechanism; do not use global/player Pi extensions or silently restart/fork the gameplay task.
- [ ] **Step 6: Add runtime refresh tests.** Prove startup-composed disabled-action enablement, withdrawal, rapid coalesced revisions, reconnect, stale closure rejection, no action leakage to a foreign generation, no mid-turn tool-array mutation, and a newly enabled action callable through its own typed Pi tool on the following provider turn. Prove new registration/code still requires Mod/game restart.
- [ ] **Step 7: Add PBT for catalog laws.** Registration IDs are unique; revisions are monotone; order/duplicate inputs cannot alter semantic membership; Host projections can only subtract; withdrawn actions cannot remain executable in a newly materialized tool set.
- [ ] **Step 8: Commit in two green boundaries.** After Steps 1–2 close the one-registration projection and focused checks/review pass, stage only the registration/bridge/Host projection refactor and commit `Consolidate Farmhand action registration`. After Steps 3–7 prove revision publication and safe same-session refresh, stage that disjoint follow-up with its tests and commit `Refresh live action tools from Mod catalog`. If the first boundary is not independently green, keep one connected writer and do not stage a partial authority migration.

---

### Task 3 — Make the adapter preserve action/outcome/freshness structure

**Files:**

- Modify: `host/src/integration-module.ts`
- Modify: `host/src/integration-module.test.ts`
- Modify: `host/src/integration-types.ts`
- Modify: `host/src/stardew-integration-module.ts`
- Modify: `host/src/stardew-integration-module.test.ts`
- Modify: `host/src/integration.ts`
- Modify: `host/src/bridge.ts`
- Modify: `host/src/protocol.ts`
- Modify: `protocol/bridge-v1.schema.json`
- Modify: `integrations/stardew/BridgeSession.cs`
- Modify: `integrations/stardew/src/Core/Policy/FarmhandCapabilitySurface.cs`
- Modify: focused bridge/protocol/schema tests

**Required production projection:**

```ts
export type IntegrationStateView = Readonly<{
  connected: boolean;
  sessionId: string | null;
  capabilities: readonly string[];
  capabilityRevision: number | null;
  snapshotRevision: number | null;
  activeExecution: Readonly<{
    actionId: string;
    requestId: string;
    executionId: string;
    state: string;
  }> | null;
  latestReceipt: (IntegrationExecutionReceipt & Readonly<{ actionId: string }>) | null;
  latestReasonCode: string | null;
}>;
```

The exact wire representation may differ after inspecting the current bridge models, but these facts must be source-owned. Host must not infer `actionId` from a tool call after the fact or pretend snapshot revision is capability revision.

#### Current bounded execution slice — content-free authoritative terminal projection

```text
User-visible result:
  The operational Game gate can emit its deliberately content-free terminal
  evidence only for a Mod-originated, correlated terminal receipt that carries
  its ledger-owned action identity and passes that action's exact completion
  predicate after a fresh snapshot.

In scope:
  `host/src/game-operational-gate-evidence.ts` and its direct test. Consume the
  existing generic `IntegrationStateView` fields only.

Explicit non-goals:
  No protocol/schema/model changes, no Host action inference, no receipt
  synthesis, no new registry, and no change to the evidence's redacted wire
  schema.

Authority and causal boundary:
  Mod ledger receipt (`requestId`, `executionId`, `actionId`, revision,
  evidence) → authenticated adapter state → exact terminal fact correlation
  → action-specific adapter predicate + fresh snapshot/capability revision
  → content-free gate projection. The Host may only reject missing or
  inconsistent source facts.

Acceptance scenario:
  Given a connected adapter state whose current terminal receipt exactly
  matches an incoming terminal fact, has a non-empty source-owned action ID,
  capability revision, and evidence, and whose snapshot revision is at least
  the receipt revision; when the integration catalog confirms that exact
  action's postcondition; then `next()` resolves once with only the permitted
  redacted evidence fields. Any mismatched identity, missing/invalid action
  lineage, false action-specific predicate, absent capability revision, or
  stale snapshot must not resolve it.

Cheapest checks:
  compile Host tests, run the focused compiled operational-gate evidence test,
  then `git diff --check` for the two paths. One final independent reviewer
  reads the actual diff and test evidence.

Mutation lane:
  One writer owns only the two files above. Stop if making the scenario pass
  requires a new adapter/bridge authority field or schema change; that is a
  separate Task 3 slice.
```

- [ ] **Step 1: Add failing adapter-neutral contract tests.** Verify that a correlated terminal transition cannot be projected without exact `actionId`, source-owned capability revision, non-empty evidence, and a snapshot revision at or after the receipt revision.
- [ ] **Step 2: Add failing Stardew protocol/bridge tests.** A live capability surface publishes an immutable revision tied to the exact action set; execution receipt/query facts preserve the action ID belonging to the request/execution lineage.
- [ ] **Step 3: Implement the minimum source-owned fields.** Reuse the existing Mod capability surface and execution ledger. Do not add a Host-minted digest, second registry, or test-only declaration.
- [ ] **Step 4: Update generic module projections and Stardew adapter mapping.** Generic Host code consumes only `GameIntegrationModule`; Stardew parsing remains inside the adapter.
- [ ] **Step 5: Add focused PBT for preservation laws:**
  - capability order/duplicates do not change the revision's semantic set;
  - any action-set addition/removal changes the revision;
  - foreign request/execution/action tuples never correlate;
  - terminal state never projects with stale postcondition observation.
- [ ] **Step 6: Run focused protocol, bridge, integration module, and schema suites.**
- [ ] **Step 7: Commit checkpoint.** Once source-owned facts, adapter mapping, focused suites, and fresh review all pass, stage only Task 3 paths and commit `Project source-owned action transition facts`.

---

### Task 4 — Remove product gameplay quotas

**Files:**

- Modify: `host/src/gameplay-task-subagent.ts`
- Modify: `host/src/gameplay-task-subagent.test.ts`
- Modify: `host/src/game-tools.ts` and the navigation observation tests when removing Host cumulative disclosure accounting
- Modify: `host/src/runtime.ts`, `host/src/host-service.ts`, and direct runtime composition tests when removing task-ingress budget plumbing
- Modify: `design/03_AGENT_RUNTIME.md`
- Modify: `design/36_STARDEW_RUNTIME_NAVIGATION_AND_INTERACTION_READY_MOVEMENT.md`
- Modify: `design/78_GAME_PIPELINE_RELEASE_ARCHITECTURE.md`
- Modify: `design/79_GAME_PIPELINE_RELEASE_IMPLEMENTATION_PLAN.md`
- Modify: `design/91_OPEN_GAMEPLAY_PIPELINE_RELEASE_IMPLEMENTATION_PLAN.md`
- Modify: `design/93_STARDEW_NAVIGATION_V1_IMPLEMENTATION_PLAN.md`

Remove `GameplayTaskBudget`, `DEFAULT_GAMEPLAY_TASK_BUDGET`, every product gameplay budget field/counter, budget admission wrapper, budget-exhaustion terminal reason, and constructor/configuration input that exists only to cap product gameplay. This includes Host cumulative navigation disclosure accounting; retain only source-owned per-result projection limits that prevent one oversized DTO from entering Agent context. In particular remove:

```text
maxTurns
maxToolCalls
maxWallClockMs
maxModelRetries
maxAcceptedActions
maxAcceptedActionsPerFamily
acceptedActionsByFamily
```

`maxActiveExecutions: 1` also leaves the budget model. The existing execution coordinator may preserve one active native mutation for a single embodied actor as a structural mutual-exclusion invariant. It rejects overlapping execution; it does not limit the number, duration, or families of sequential actions and is not configurable as a gameplay quota.

- [ ] **Step 1: Replace quota tests with failing task-lifetime tests.** A task may use arbitrarily many turns, tool calls, retries, sequential actions, repeated action families, and repeated bounded navigation reads without Host counters terminating it. Use deterministic explicit completion/cancellation signals in tests rather than a clock limit.
- [ ] **Step 2: Remove the entire product budget model.** Delete budget types/defaults, record fields, counters, wrappers, timers, task-ingress accounting, assertions, budget-exhaustion reason codes, and budget-derived blocked/cancelled projection. Do not preserve deprecated constructor parameters or compatibility parsing. Keep per-result navigation DTO size/entry validation as a projection contract, not as a task quota.
- [ ] **Step 3: Keep native execution serialization in its owning coordinator.** Add a focused concurrency test: an overlapping mutation is rejected while the first is active, but any number of sequential mutations is admitted after settlement. Do not call this a budget and do not copy it into `GameplayTaskRecord`.
- [ ] **Step 4: Tighten the private worker system prompt.** It must state that the delegated prompt is the task, observations/game outcomes are authoritative, all mounted live tools may be used, and it must not invent completion. Do not inject a hidden route, action plan, or artificial stopping count.
- [ ] **Step 5: Add model-independent tests proving the worker receives the normal adapter tool set, not a release/test subset, and that only explicit player/parent STOP, real runtime/provider terminal failure, integration closure, or the Agent's own task conclusion settles the worker.**
- [ ] **Step 6: Run the gameplay worker and runtime tests.**
- [ ] **Step 7: Commit checkpoint.** After the lifetime and mutual-exclusion scenario is green and reviewed, stage only Task 4 code/tests/design status if tracked and commit `Remove gameplay task quotas`.

---

### Task 5 — Build the first-party two-role Stardew launcher, compatibility policy, and hardcode remediation

**Hard entry gate:** Production process ownership and installation consumption proceed only in this order:

```text
Design 102 independently verified guardian containment/recovery closure
→ Design 101 installation registration closure
→ this Task's product-lifecycle consumers
→ Design 100 headless migration only for the operational gate
```

Before Design 102/101 close, this Task may keep or complete pure compatibility classification and other no-spawn/no-registration analysis only. No worker may add or retain Node-owned production `spawn`, post-create Job assignment, profile/session writer, registration consumer, or runner wiring as a fallback. Every production role-process owner must consume the Design 102 guardian adapter; Design 101 fresh admission is the sole installation capability producer.

**Cross-game constraint:** Task 5 is Stage 0 of `design/97_COMMUNITY_GAME_CONNECTOR_ARCHITECTURE.md`, not an implementation of its Stage 1 community connector host. All SMAPI installation admission, immutable Mod package verification, private profile/session material, two-role process ownership, bridge endpoint/token, Farmhand provisioning, and role/generation attestation remain private Stardew implementation facts. Generic Host code must continue to consume only existing adapter-neutral lifecycle, connection, observation, action, receipt, cancellation, and close facts. Do not add a generic `modPath`, `executable`, `profile`, `process`, `plugin`, or `connector` field to `IntegrationLauncher`, `PreparedIntegrationLaunch`, browser profiles, or operator config to make this task easier.

A later community connector must be out-of-process and protocol-mediated. That does not make the first-party Stardew Mod or its native bridge an untrusted connector, and it does not authorize dynamic Host imports, arbitrary package discovery, a launcher manifest DSL, or community code in this Task.

**Files:**

- Create: Host-owned Stardew prerequisite/discovery/process-role manager modules
- Modify: `host/src/stardew-integration-launcher.ts`
- Modify: `host/src/integration-launcher.ts` only for adapter-neutral lifecycle facts genuinely needed by the player flow
- Modify: `integrations/stardew/ModConfig.cs`
- Modify: `integrations/stardew/HostFarmhandProvisioner.cs`
- Modify: `integrations/stardew/FarmhandProvisioner.cs`
- Modify: `integrations/stardew/PortfolioBridgeProtocol.cs` only where ordinary product version policy improperly shares a harness constant
- Modify: `integrations/stardew/manifest.json`
- Modify: `integrations/stardew/config.example.json` or retire it from ordinary player setup
- Modify: `host/src/local-host-config.ts`
- Modify: `host/src/gameplay-task-subagent.ts` model selection only; quota removal remains Task 4
- Modify: `host/src/runtime.ts`
- Modify: `host/src/settings/model-profile-store.ts`
- Modify: model/runtime composition owners
- Modify: `host/src/local-stardew-bridge.ts`
- Modify: safe browser compatibility/diagnostic projections and focused tests

**Approved topology:** Maintain two separately owned/profiled **first-party** Stardew+SMAPI roles:

```text
player Host Stardew/SMAPI (may already be running and remain player-owned)
AI-client Stardew/SMAPI (GameBuddy-launched and GameBuddy-owned)
```

The product uses Design 104's bounded Steam/GOG discovery and manual native picker, Design 101's fresh admission/registration, and Design 102's guardian-owned process containment. It can launch the player Host through SMAPI, can attach to an already authenticated compatible player instance only where a separately released authority exists, creates/uses an isolated GameBuddy AI-client profile, and tears down only processes/resources it owns. It never automates save selection, injects input, picks an arbitrary PID, steals an occupied profile, or kills an externally owned player process.

**Compatibility policy:**

```ts
type CompatibilityStatus =
  | "verified"
  | "compatible_unverified"
  | "below_minimum_warning"
  | "hard_incompatible";
```

- `minimum-adapted`: a conservative **advisory** lower bound derived with the smallest useful investigation: official Stardew/SMAPI documentation, the Mod's declared `MinimumApiVersion`, and a bounded check of obvious runtime/load-time APIs that could prevent the Mod from loading. Do not inspect every action, construct a compatibility database, install historical game versions, or execute old-version live runs merely to set this value. `1.6.15 build 24356` is currently only the verified evidence tuple and is not automatically the minimum; `manifest.json` currently declares SMAPI `4.0.0`, which is the initial declared lower bound unless lightweight primary evidence reveals an obvious contradiction. When evidence is incomplete, choose a conservative warning value, explain its basis, and still allow “Try anyway”.
- `verified`: exact combinations actually passed immutable-artifact build and target-live evidence, initially expected to include Stardew `1.6.15 build 24356` + SMAPI `4.5.2`.
- `compatible_unverified`: at/above minimum but not in verified evidence. Show a non-blocking first-use warning and continue.
- `below_minimum_warning`: show stronger explicit “仍然尝试 / Try anyway”; continue if the Mod/loader can actually load.
- `hard_incompatible`: only a concrete structural failure such as Mod binary loader failure, incompatible GameBuddy bridge protocol major, host/client native multiplayer protocol/version mismatch for the same attachment, or missing required runtime. Block AI attachment with remediation; do not block launching the player's game.

Ordinary product config must not require exact certified `ExpectedGameVersion`, build, or SMAPI patch. Exact pins remain in live-gate fixtures/runners only. A new game patch may reduce runtime action availability through Task 2's catalog revision instead of disabling the entire Game surface.

**Confirmed harmful-hardcode inventory and required treatment:**

| Current hardcode | User harm | Required treatment |
|---|---|---|
| Stardew `1.6.15` / build `24356` / SMAPI `4.5.2` exact checks in Farmhand provisioning and Portfolio-shared constants | Newer/alternate compatible installs cannot attach | Move exact tuple to verified evidence/harness; use compatibility classification and peer/protocol checks in ordinary launch |
| absolute Windows paths, caller-configured fixed endpoint, save identity, Farmhand IDs in `config.example.json` | manual error-prone setup and false Host authority over a game-owned listener | Launcher derives GameBuddy-owned paths and per-launch credentials, while the Mod derives the target-version native LAN endpoint only after `Game1.server` exists; example becomes operator/test-only or disappears from player flow |
| non-empty manual `AuthorizedCompanionIds` | newly created valid Companion cannot attach | Browser confirmation + authenticated launch manifest authorizes the exact Companion binding; retain exact binding, remove manual list editing |
| duplicated session token/path/endpoint across Host and AI-client config | copy/paste mismatch and secret exposure | One launcher-owned session object writes both private role configs/manifests; no token reaches UI/config docs/logs |
| `LocalHostConfig.model = "deepseek-v4-flash"`, `GAMEPLAY_SUBAGENT_MODEL_CONFIG = cpa-oai/gpt-5.6-luna/medium`, runtime narrow model unions, model-profile-store constants, and literal model labels in `SettingsDrawer` | unrelated hidden Chat/Game model gates and misleading UI | Select both parent and gameplay worker models from the GameBuddy-owned provider/model registry and exact mounted product profile; frontend renders source-owned configured readiness/model facts through the owning management contract |
| bridge response timeout fixed at `5_000` ms and gameplay-worker receipt waits clipped to five seconds | false timeout/uncertain retry during save/load, long native actions, or world transition | Use operation-owned cancellation/deadline plus durable terminal receipt query/recovery; distinguish handshake/observe/control/native execution rather than one blanket timeout; remove all task-budget-derived deadlines |
| exact Stardew version embedded in generic Host Portfolio protocol fingerprints | hidden coupling between a verified slice and reusable lifecycle/protocol identity | Keep exact version only where Portfolio's independently reviewed target-specific topology truly owns it; otherwise carry detected/versioned adapter facts rather than a global literal |
| preview/session artifacts under source-tree `host/contexts/` | accidental packaging, stale authority, or user-data leakage | Production uses a GameBuddy-owned data root outside source/artifact; build/release checks reject mutable runtime roots, previews, credentials, and manifests in shipped/source artifacts |
| browser/control TTLs and request timeout constants | surprise expiry on slow/open sessions | Keep loopback, bounded dedupe, and finite credentials as safety invariants; expose truthful re-bootstrap/retry state and derive operation-specific policy rather than silent fixed failure |
| fixture save prefixes/scenarios and exact live target pins | none if isolated | Keep test-only and prove they cannot enter ordinary player launch/config |
| Portfolio default-deny allowlist and single-player topology | protective, not harmful | Keep; improve UI/setup wording only. Never inherit Farmhand policy |

#### Current bounded execution slice — pure advisory compatibility classification

```text
User-visible result:
  The future Game launch surface has one truthful, deterministic classification
  of detected Stardew role facts: verified, compatible-unverified,
  below-minimum warning, or concrete hard incompatibility. It makes explicit
  that warnings remain launchable while structural failures block attachment.

In scope:
  Create only `host/src/stardew-compatibility.ts` and
  `host/src/stardew-compatibility.test.ts`. The module is pure; it consumes
  detected values / check outcomes and produces a browser-safe classification.

Explicit non-goals:
  No process discovery/launch, browser API, attachment/protocol/schema change,
  C# gate removal, config write, or game execution. This slice does not claim
  that the current product launcher has begun applying the result.

Authority and policy boundary:
  Adapter/launcher later owns detected version tuple and named check outcomes;
  this Host module owns only the product classification. Current authoritative
  advisory evidence is Mod `manifest.json` `MinimumApiVersion: 4.0.0`, so only
  SMAPI receives a minimum comparison. There is no invented Stardew minimum;
  `1.6.15 / 24356 / 4.5.2` is verified evidence only.

Input and ordering contract:
  Each structural check is tri-state, never a vague boolean:
  `confirmed_ok`, `confirmed_failure`/`confirmed_mismatch`, `unknown`, or
  `not_applicable` where appropriate. Priority is: concrete missing runtime,
  loader failure, bridge-major mismatch, or applicable native peer mismatch
  → hard_incompatible; otherwise valid SMAPI < 4.0.0 → below_minimum_warning;
  otherwise exact verified tuple plus affirmative required checks → verified;
  otherwise compatible_unverified. Invalid/missing SMAPI is unverified, not
  hard/below-minimum. `attachmentAllowed` is false only for hard incompatibility.

Acceptance scenario:
  Given all detected facts/check outcomes are affirmative and the verified
  tuple matches, `classify` returns verified. Given a newer or incomplete
  nonstructural tuple, it returns compatible_unverified and allows attachment.
  Given SMAPI 3.x with no concrete failure, it returns below_minimum_warning
  and allows attachment. Given each named structural failure, it returns
  hard_incompatible and blocks attachment. A non-applicable peer check is not
  treated as an affirmative peer check.

Cheapest checks:
  Host test typecheck, focused compiled `stardew-compatibility` test, and
  `git diff --check` for these paths, followed by one independent diff review.

Mutation lane:
  One writer owns only the two files above. Stop if the desired result requires
  a new detected source fact or changing any adapter/C# policy; record that as
  the next Task 5 integration slice.
```

#### Task 5 evidence-backed partials and current prerequisite boundary

**Current architecture correction — deep Stardew launch module, not a generic asset owner.** The next Stage 0 implementation must compose the already-admitted installation, shipped Stardew Mod assets, private profiles, role reservations, durable owner record, process launch, and authenticated `hello_ack` checks behind one private Stardew launch module. It must expose only adapter-neutral redacted lifecycle/connection outcomes to generic Host callers. Do not create a public runtime package owner, expose paths/identities/snapshots as structural DTOs, or prematurely implement the Stage 1 community connector ABI. Before this module writes profiles or spawns processes, its internal composition must be able to derive its exact production artifact root from its own first-party entrypoint, verify the fixed Stardew package, and freshly revalidate the admitted SMAPI installation; if these facts cannot be kept inside the same closed composition, stop for a Task 5 architecture decision rather than widening generic interfaces.

The following bounded Host-only slices have focused tests and independent reviews, but are **not** a completed player launcher or a mounted product path: the pure compatibility classifier; authenticated session → compatibility projection; direct-child Windows process ownership with PID + creation-time revalidation; a redacted two-role lifecycle reduction view; mounted-Game-model injection into `GameplayTaskSubagent`; and operation-owned named-pipe response timeouts. They remain uncommitted in the shared dirty worktree and do not prove a launched/attached AI client.

**Frozen prerequisite — launcher-owned private session topology.** The next necessary Task 5 architecture is one per-launch, Host-owned private session capability. After a player confirms a specific Companion binding, the launcher must mint it under the GameBuddy-owned runtime root, with random credential material and a bounded lifetime. The Host does **not** choose a LAN endpoint: the target-version native `LidgrenServer.initialize()` binds its own `defaultPort` after `Multiplayer.StartServer()` creates `Game1.server`; only the Mod may derive and publish the loopback endpoint after game-thread confirmation of that native server. The private session then writes only:

1. the isolated GameBuddy-owned AI-client profile/config and its launch manifest; and
2. a player-Host launch manifest **only when that player Host is itself launched through a reviewed launcher-owned profile**.

The session owns its secret, role-specific config paths, exact requested player/companion binding, launch generation, expiry and cleanup bookkeeping. It is never an operator `LocalHostConfig` value, browser DTO, static config example, stdout/log field, run manifest, or source-tree artifact. The Browser can request a confirmation and see only redacted pending/failed lifecycle state. It cannot receive, select, edit, or replay a pipe name, credential, save/world identity, native ID, profile path, PID, or handle.

An already-running player-owned Host is a different topology: the current Mod can advertise/attach only after manual `HostFarmhandProvisioning` fields have supplied a session directory, token and authorized Companion list; the endpoint is a Mod-derived native fact, never a manual field. The current sources have **no authenticated first-run discovery/bootstrap authority** that lets Host replace those fields without editing a running external profile. The launcher must never write an external running Mod config, infer a process/profile, or treat a raw session file as authority. Therefore implementation of the private-session writer is blocked until a separate, reviewed Player-Host bootstrap protocol defines all of: Mod installation/discovery ownership, local-user authentication before Host learns a session, exact browser-confirmed binding, concurrent-launch/profile locking, stale-session expiry/revocation, and role + generation attestation carried by authenticated Bridge hello/snapshot facts.

**Stop condition:** do not implement a session/config writer, browser launch/attach command, or production wiring until that bootstrap protocol and Bridge role/generation attestation exist. Do not substitute a fixed data path, copied token, manual config mutation, arbitrary process discovery, or test-only manifest for either authority.

**Frozen Player-Host bootstrap protocol (Task 5 prerequisite).** A private bootstrap transaction is admitted only from one exact, already-authenticated local browser session after an explicit confirmation containing the mounted product `playerId` and `companionId`. The Host mints a one-shot opaque bootstrap identity and absolute expiry, reserves a new exclusive directory below the already-admitted GameBuddy runtime root, and records a versioned durable owner record before any later role-profile work. The Phase A-external branch may identify an already-running external Player Host only as `external_unattested`; it never adopts or mutates that profile, claims its process, or invents a launch generation for it. The Phase A-owned branch applies only to a Player Host that GameBuddy launches from a GameBuddy-owned private Mod profile, and remains blocked until its real process owner exists. A durable record binds the exact player/companion pair, lifecycle state, expiry, cleanup disposition, and only the real manager-minted role generations available for that topology; it contains no reusable browser credential. The launcher owns and may terminate only its exact direct children after PID + creation-time revalidation. Every directly launched Mod must return the matching role/generation before that role can advance beyond awaiting attestation. Mismatch, timeout, expiry, duplicate confirmation, occupied path, reparse/unreadable path, concurrent active transaction, or cleanup uncertainty fails closed. Cleanup removes only paths named by its own durable record; cleanup failure retains the record as quarantined for safe retry. Browser projection is limited to redacted lifecycle categories. This protocol supplies no action, attachment, connection, native identity, capability, receipt, or ready fact.

The reviewed protocol is staged by topology. Phase A1 is a pure/exclusive browser-confirmed bootstrap admission capability with deterministic tests; it writes no filesystem artifact and spawns no process. Phase A2 is split by Player-Host topology. **Phase A-external is the current closed implementation target:** `host/src/stardew-private-bootstrap-composer.ts` owns one closed constructor that internally creates and wires the browser broker, AI-client process owner, nominal-identity WeakMaps, and v2 persistence. Its public result exposes only `broker`, `aiClientProcessOwner`, and `reserveExternalPlayerHostPhaseA`; registrar callbacks, structural trusted facts, generations, and the persistence writer are not public surfaces. The dedicated `stardew-private-bootstrap-composer.test-support.ts` accepts only raw spawn/probe, identity-generation, and clock dependencies and returns that same closed composition. The authority binds the exact nominal browser claim to one exact manager-minted AI-client reservation, then durably records the player/companion binding and expiry together with `playerHost: { kind: "external_unattested" }` and `aiClient: { kind: "launch_reserved", launchGeneration }`. It neither invents nor records a Player-Host launch generation. **Phase A-owned is closed:** a reviewed GameBuddy-owned Player-Host process owner now mints and directly owns that role's real launch reservation, and the durable record binds its exact manager-minted generation alongside the AI-client generation; no synthetic Player-Host generation is permitted. Phase B consumes exact real reservations once to stage private profiles and launch directly owned roles; it is not part of Phase A-external. Existing authenticated Bridge role/generation projection is the only attestation consumer. An external player-owned Host remains manual and unattested at this boundary. The process manager exposes AI generation only inside the closed composition; ordinary lifecycle/browser status remains redacted, and no second module may independently mint or override a role launch generation. Phase A-external must not be marked complete until its migrated tests and independent review pass; the production writer alone is not completion evidence.

#### Frozen installation-root admission prerequisite (Task 5 Phase B)

`gameDirectoryCandidate` is an untrusted operator-selected candidate for the exact Windows Stardew/SMAPI installation root. This is the one fixed installation-layout contract for the first launcher path:

```text
player-Host cwd        = exact admitted gameDirectoryCandidate
SMAPI executable       = <exact admitted gameDirectoryCandidate>\\StardewModdingAPI.exe
```

The contract is grounded in the SMAPI Windows player installation instructions, which direct players to `StardewModdingAPI.exe` in the Stardew game folder; it is not a detected-version, compatibility, attachment, ready, or process-ownership claim. There is no executable path field, directory search, Steam/GOG registry discovery, `.bat` fallback, `realpath` substitution, or caller-selected cwd. A candidate that is an executable, UNC/device/relative path, contains dot/empty components, or cannot produce that exact direct-child executable fails closed.

The next bounded consumer creates `AdmittedStardewInstallation` as a frozen nominal capability with no enumerable properties and module-private state only. It consumes the fixed nominal Windows reparse inspector capability and twice reads the entire root-to-leaf identity chain for the derived executable. Both reads must match every object kind, reparse verdict, volume identity, and file ID; every component must be non-reparse; the leaf must be `regular_file`; and the direct parent must be the candidate directory. Any malformed/missing/helper/identity/reparse/replacement/non-Windows failure maps to `stardew_installation_admission_failed` without exposing path or identity. The capability is only admission-time evidence: the later exact launch consumer must freshly re-read and compare the same chain immediately before spawning. This slice writes no private profile/config, does not spawn, reads no version resource, and does not mount Browser/Bridge/C# authority.

Acceptance scenario:

```text
Given an exact local Windows installation root and fixed direct-child SMAPI executable,
When two consecutive complete identity-chain inspections are stable and non-reparse,
Then Host mints only a redacted nominal admission capability.

Given a non-Windows, malformed candidate, wrong leaf kind, reparse component, helper failure,
or any first→second chain change,
Then admission fails closed and mints no capability.
```

Producer → consumer → verifier is: fixed Windows identity helper → private installation admission state → focused stable/replacement/reparse/invalid-candidate tests. The helper's lack of a safe non-link reparse *fixture producer* remains a separately recorded release-evidence gap; it does not license a fallback implementation or an affirmative release claim.

- [x] **Step 1 (bounded slice): Define the advisory minimum with a short documented evidence note, then write compatibility classification tests.** The current authoritative advisory source is `manifest.json` `MinimumApiVersion: 4.0.0`; the pure Host classifier and focused tests are complete. Exact `1.6.15 / 24356 / 4.5.2` remains verified evidence only. Do not perform an action-by-action audit or historical-version live matrix. Deterministically test minimum, verified, newer-unverified, below-minimum, host/client mismatch, protocol-major mismatch, and an observed loader failure; prove warning statuses remain launchable.
- [ ] **Step 2: After Design 102 closure, write failing guardian-consumer ownership tests.** Distinguish existing player Host, GameBuddy-launched player Host, and GameBuddy-owned AI client; ambiguous candidates fail safely; teardown never kills externally owned Stardew. No direct Node spawn fallback is permitted.
- [ ] **Step 3: After Design 101 closure, consume Design 104 discovery/manual setup through fresh admission and implement only reviewed first-run transactions.** Install/update GameBuddy Mod/profile only within reviewed owned paths; no unmanaged-file deletion, running-profile mutation, or UI automation.
- [ ] **Step 4: Replace exact production version gates with compatibility negotiation.** Keep native host/client peer compatibility exact where Stardew multiplayer truly requires it and keep bridge protocol major fail-closed.
- [ ] **Step 5: Replace manual Companion/token/path/model setup with owning product flows.** Do not broaden authorization to every Companion; mint one exact confirmed binding. Remove the gameplay worker's independent fixed provider/model/thinking constant and resolve it from the exact mounted Game profile/readiness owner.
- [ ] **Step 6: Replace blanket bridge timeout behavior.** An action past write/admission resolves through receipt/uncertain recovery, not blind retry. Add save/load/world-transition tests.
- [ ] **Step 7: Resolve the bounded harmful-hardcode inventory in this task.** Inspect the known player launch/config/runtime surfaces listed above for exact certified versions, machine/user paths, fixed Companion/Farmhand IDs, fixture scenario names, fixed/narrow model IDs, copied token fields, source-tree runtime roots, and blanket/task-budget-clipped action timeouts. Remove or derive harmful values; retain a literal only when it is a clear structural invariant, truthful default/warning, verified evidence value, or test fixture. Add focused regression tests for each removed user-facing blocker. Do not build a recurring repository-wide scanner, hash catalogue, or classification gate unless a concrete recurrence demonstrates that ordinary tests/review are insufficient.
- [ ] **Step 8: Commit in two green boundaries.** Commit `Add Stardew launcher compatibility service` after discovery, ownership, compatibility classification, and their focused tests/review are independently green. Commit `Remove player launch hardcodes` only after the second slice resolves manual config/binding/model/timeout/source-root blockers with direct tests. Do not stage unrelated launch artifacts or secrets.

---

### Task 6 — Add the shipped frontend Game launch and attachment journey

**Owning references:**

- `design/26_TAVERN_FRONTEND_DESIGN_SPEC.md` owns information architecture, player vocabulary, tokens, accessibility, responsive behavior, and the single-drawer model.
- `design/90_SIMPLIFIED_PI_BACKED_CHAT_PRODUCT_IMPLEMENTATION_PLAN.md` owns the current ordinary local browser→Host reference composition. Game uses the same simple application pattern and does not revive retired proof/attestation gates.
- `design/40_CHAT_PIPELINE_RELEASE_ENGINEERING_IMPLEMENTATION_PLAN.md` is retired as execution authority; only still-compatible contract/artifact details retained by current owners may be reused.
- `design/83_TAVERN_FULL_MANAGEMENT_FRONTEND_BACKEND_INTEGRATION_PLAN.md` supplies useful strict browser command/idempotency/read-back patterns where current owners still retain them, but does not itself grant Game operations.
- `design/92_NATIVE_CONTENT_CHAT_GAME_PRESENTATION_IMPLEMENTATION_PLAN.md` owns native Chat/Game content presentation and forbids treating Game action evidence as dialogue.
- `design/101_STARDEW_PRODUCT_INSTALLATION_REGISTRATION_DESIGN.md` owns Host-private durable registration and fresh re-admission; `design/104_PLAYER_ONBOARDING_AND_SURFACE_JOURNEYS_DESIGN.md` owns automatic discovery, explicit candidate confirmation, player setup copy, and final Game journey.
- `design/103_WINDOWS_DISTRIBUTION_AND_DESKTOP_PRESENTATION_DESIGN.md` owns launcher/tray/single-instance/public bootstrap/roots/close/update, keeps Browser Preview developer/QA-only, and owns the installed Desktop Browser Presentation → WebView2 replacement. It does not own Game lifecycle or STOP.

**Files:**

- Create: versioned Game browser contract under `host/src/game-browser-contract/`
- Create: Host Game lifecycle/browser service modules
- Modify: composed browser profile and `host/src/dialogue-web-main.ts`
- Keep narrow: existing P3-only `host/src/dialogue-web.ts`; do not silently broaden its exact profile
- Create: `dialogue-web/src/game-browser-api.ts`
- Create: `dialogue-web/src/components/drawers/GameDrawer.tsx`
- Modify: `dialogue-web/src/components/App.tsx`
- Modify: `dialogue-web/src/components/AppBar.tsx`
- Modify: `dialogue-web/src/types.ts`
- Modify: `dialogue-web/src/i18n.ts`
- Modify: frontend styles only through design/26 token/component rules
- Create/modify: Host contract tests, frontend tests, and real shipped-browser journey tests

#### Task 6 current composition blocker — one browser session, two versioned domains

The current checked-in browser architecture cannot safely mount the already-written `game_browser_api/v1` state provider as another route in the existing Tavern dispatcher:

- `game_browser_api/v1` and `tavern_browser_api/v1` have different strict root snapshot schemas, independently branded profile types, different navigation universes, and independently minted CSRF/session fields.
- `startReferencePipelineStaticShellComposition` sends every `/api/` request to the exact reference dispatcher. That dispatcher asserts an exact Tavern profile and consumes the one-time bootstrap token. It cannot accept a structural or branded `ComposedGameProfile`.
- The shipped React app parses only Tavern/P3 snapshot shapes and has no Game navigation item, Game drawer state, or Game browser client. Giving it a second bootstrap/session or an unpaired Game endpoint would create conflicting session/CSRF owners and would not make the default Chat page + contextual drawer journey real.

Therefore **do not wire `game.state.read` to the existing Tavern API by a path-prefix exception, share/reuse the Tavern cookie without a composed browser-session owner, or add a Game nav item to a Tavern profile that has no corresponding Game handler.** The current `host/src/game-browser-contract/` and `host/src/game-browser/game-browser-state-provider.ts` are a redacted, read-only kernel only; their focused tests do not prove a shipped browser route.

**Required predecessor slice — composed browser session broker.** Before Step 1, define and test one mounted browser composition which owns: one bootstrap capability, one loopback cookie/session and CSRF issuer, an explicit immutable capability set for its mounted Tavern and Game domains, and a single root state shape that contains the existing Tavern snapshot plus an optional/versioned Game projection. It must expose `game` navigation and `game.state.read` only when the exact Game profile and state provider are both mounted; a Chat-only composition produces byte-for-byte the current navigation/operations and has no Game API surface. The broker delegates to the Tavern and Game providers; it does not derive lifecycle, bridge, capability, receipt, process, or attachment facts. If this requires changing the currently frozen `tavern_browser_api/v1` root contract rather than adding a new versioned composed root, stop for a browser-contract ownership decision; do not silently widen the legacy contract.

**Player journey:** After the composed browser-session predecessor is green, the default page remains the Chat conversation. A Game affordance appears only in a Game-capable composed profile and opens the one contextual right drawer (`width: min(420px, 100vw)`) or mobile full-height sheet. It is not a route-level dashboard or permanent column. The primary action is **“和伙伴一起玩 / Play with companion”**. It chooses launch or attachment from authoritative Host state; advanced engineering concepts are hidden.

The final drawer and onboarding use Design 104's phase/state model; the following lifecycle states remain a compatibility-oriented projection, not permission to expose one generic status soup:

```text
unconfigured
→ prerequisites_missing | prerequisites_ready
→ discovering
→ launch_pending | attach_pending
→ compatibility_warning | awaiting_confirmation
→ connecting
→ connected_idle ↔ active
→ stopping | reconnecting
→ stopped | failed | disconnected
```

The UI exposes only player facts: prerequisite status, detected game, verified/unverified warning, `Your game` status, `Companion connection` status, selected Companion/Farmhand, safe world/save display, connection state, safe capability summary, latest authoritative outcome, Stop, Reconnect, Disconnect, and bounded diagnostics. `Player Host`, `AI client`, role/process identity, and two-process topology remain coordinator-private attestation facts rather than browser DTO or player vocabulary. It never exposes PID, process path, pipe/token, endpoint, native ID, hash, runtime/session ID, action-catalog revision, raw receipt, prompt, model output, or logs.

**Minimum versioned operations:**

```text
game.prerequisites.read
game.prerequisites.setup
game.instances.read
game.state.read
game.launch
game.attach
game.stop
game.reconnect
game.disconnect
game.diagnostics.read
```

Mutations use authenticated cookie + CSRF, browser-stable idempotency where applicable, exact attachment generation/expected revision, strict schemas, and fresh state read-back. `202 Accepted` means pending, never connected. If attachment confirmation is a separate state, it has one atomic operation; otherwise fold it into `game.attach` rather than creating duplicate confirmations.

- [ ] **Predecessor: Specify and test the composed browser-session broker.** Freeze the new versioned composed root and its exact session/CSRF ownership before implementation. Prove that the Game state route is unreachable and the Game affordance is absent when Game is not mounted; prove that an exact mounted Game profile/provider can read only its validated redacted state through the same browser session without changing Chat snapshot semantics. Stop if the only way to do this is to reinterpret `tavern_browser_api/v1` as a polymorphic root contract.
- [ ] **Step 1: Write failing browser-contract/profile drift tests.** Game controls are absent from Chat-only profiles and present exactly when the Game profile mounts matching handlers; frontend imports only browser-safe contract types.
- [ ] **Step 2: Implement redacted read projections.** Prerequisites, instances, compatibility, attachment state, latest outcome, and diagnostics must all originate from Host/adapter owners. Browser defaults cannot fabricate a connected or ready state.
- [ ] **Step 3: Implement command admission and reconciliation.** Add strict CSRF/idempotency/generation contracts, pending states, read-back, duplicate request behavior, stale selection rejection, and no optimistic success.
- [ ] **Step 4: Implement the design/26 + Design 104 Game drawer.** Reuse the single-drawer focus trap, Escape/backdrop behavior, 44px targets, en/zh-CN complete localization, reduced motion, responsive sheet, and existing three-tier tokens. Keep Chat timeline/draft mounted and unchanged while Game operates. Use phase hierarchy, calm status surfaces and actionable recovery; do not create a route-level dashboard, card grid, metric wall or generic `Setup` copy.
- [ ] **Step 5: Add UI tests.** Cover first setup, primary launch, existing-instance attach, compatibility warning, two-role identity, attachment confirmation, STOP, reconnect, diagnostics, failure preservation, mobile/accessibility, and absence of raw internal fields.
- [ ] **Step 6: Add a fresh-root shipped-browser journey with no route mocks, hidden setup endpoint, command line, manual config edit, or fixture authority. This closes Browser Preview evidence only. Design 104's complete player journey and, for Desktop Player Release, Design 103's launcher/shell journey remain separate final gates.**
- [ ] **Step 7: Commit in dependency order.** When Steps 1–3 make the redacted mounted browser contract independently green, commit `Add Game browser lifecycle contract`. After Steps 4–6 deliver the design/26 drawer and real browser journey, commit `Add Game launch drawer`. Keep the two commits separate unless an indivisible contract correction requires a tiny paired hunk.

---

### Task 7 — Prove player launch and runtime action refresh as one product composition

**Files:**

- Modify: Host Game lifecycle/browser service
- Modify: action-catalog rematerializer from Task 2
- Modify: embedded Game Pi runtime composition
- Create/modify: composed integration and shipped-browser tests

- [ ] **Step 1: Start a Game Pi session from the frontend path, not an operator-created `LocalHostConfig`.** The same launch manifest owns player/companion/integration identity, role processes, bridge generation, provider/model readiness, and exact confirmed attachment. This composition test runs only after Task 5's real lifecycle backend and Task 6's mounted drawer/commands both exist.
- [ ] **Step 2: Demonstrate runtime action hot-add.** With the session alive and no task restart, enable one disabled action from the fixed startup-composed registration set through the Mod-owned policy/live-support reload seam, publish revision `N+1`, update Host/Pi tools at a safe boundary, and let the Agent call its newly visible typed tool on the next turn. Do not imply that new C# code was loaded.
- [ ] **Step 3: Demonstrate runtime withdrawal.** Withdraw one action while the session remains alive; old closures reject before write, Mod rejects stale revision on the game thread, fresh tools omit it, and unrelated actions continue.
- [ ] **Step 4: Demonstrate UI truthfulness.** The Game drawer updates safe capability summary and compatibility/connection state from authoritative snapshots without exposing action IDs/revisions unless a later player-facing design explicitly needs them.
- [ ] **Step 5: Demonstrate STOP/reconnect across the two-role topology.** STOP settles current Agent/native work; reconnect targets the exact prior binding with fresh generation/world validation; Chat remains independent throughout.
- [ ] **Step 6: Commit checkpoint.** After the unmocked composition scenario and fresh review pass, stage only Task 7's composition paths and commit `Compose Game launch with live action refresh`.

---

### Task 8 — Produce a source-owned transition-law projection for the production gate

**Current scoped deterministic characterization:** `gamebuddy-game-operational-gate-evidence/v2` implements a content-free aggregate over two exact distinct terminal transitions and STOP settlement. It remains useful focused law coverage, but its fixed count is **not** a Task 10/11 acceptance contract, target-live evidence, product task boundary, or release gate. It cannot reject, prolong, rerun, or relabel a naturally terminal prompt-defined task because fewer than two mutations occurred.

**Required successor before Task 10/11 closure:** the production gate projection/report must describe all transitions actually observed during the one task with variable non-negative counts. Every reported successful transition must have a source-owned receipt, action-specific postcondition, and later fresh observation. Zero or one transition is valid when it reflects the honest natural terminal outcome. The report records the count for audit only; no minimum, distinct-action minimum, family quota, or hidden multi-step target controls pass/fail. Replay lineage remains deduplicated, and stale/regressed/unreadable/disconnected reread fails the affected transition/report honestly rather than waiting for an arbitrary count.

**Files and ownership:**

- Modify: `host/src/game-operational-gate-evidence.ts` and `.test.ts` — strict v2 schema plus a one-shot internal transition collector; it owns no game execution, STOP admission, or lifecycle mutation.
- Modify: `host/src/host-service.ts` and `.test.ts` — export a narrow read-only STOP-settlement listener that publishes only after the existing accepted STOP has awaited ledger/worker/voice/Pi cancellation *and* the authenticated Mod `body_settled` observation exactly matches that STOP's source event and epoch. This is an observation of the existing STOP authority, not a second STOP API.
**Existing characterization debt:** current source still contains a `gamebuddy-game-operational-gate-evidence/v2` collector whose private focused law fixture waits for exactly two successful transitions before emitting `completed`. It established useful receipt/postcondition/fresh-observation/STOP correlation, but its shape and waiter semantics are not a production-runner or release contract. Do not copy its literal count into a new schema, artifact wrapper, runner, live fixture, or acceptance assertion.

**Required release-facing successor:**

```ts
export type GameOperationalTaskReport = Readonly<{
  schema: "gamebuddy-game-operational-task-report/v1";
  surface: "game";
  capabilityRevision: number;
  capabilityCount: number;
  transitions: Readonly<{
    observedCount: number;
    freshObservationCount: number;
    allSuccessfulTransitionsHavePostconditions: boolean;
  }>;
  terminalState:
    | "completed"
    | "failed"
    | "cancelled"
    | "expired"
    | "invalidated"
    | "rejected"
    | "uncertain";
  stopSettled: boolean;
  teardownSettled: boolean;
}>;
```

The counts are non-negative observations, never pass thresholds. The owning task/runtime boundary supplies the terminal class; the collector cannot infer completion from action count. Every successful transition that actually occurred must correlate a source-owned receipt, non-empty evidence, adapter completion predicate, and later fresh snapshot. Replay lineage is deduplicated. Private action/request/execution/STOP correlation remains process-local and never enters the report. A failed/cancelled/uncertain task produces that honest class rather than waiting for another mutation.

- [x] **Step 1: Preserve focused characterization coverage.** The existing fixed-two v2 tests remain evidence for transition-law correlation only until the successor closes; they are not release acceptance.
- [ ] **Step 2: Write variable-count report tests first.** Cover honest terminal outcomes with zero, one, and many transitions; successful transitions without postcondition/fresh reread fail their evidence invariant; duplicate lineage counts once; no case waits for a minimum count.
- [ ] **Step 3: Bind terminal class to the owning task boundary and STOP/teardown observations.** The read-only collector cannot call STOP, mutate runtime, choose actions, or invent completion.
- [ ] **Step 4: Migrate production artifact wrapper and Task 10 runner to v1.** Remove fixed-two validation and readiness dependencies rather than retaining a compatibility fallback.
- [ ] **Step 5: Verify no action-count gate remains.** Search source, schemas, runner, fixtures, tests, and release copy; counts may be reported only as observations.
- [ ] **Step 6: Commit checkpoint.** Stage only Task 8 successor paths and commit `Generalize source-owned game transition evidence`.

---

---

### Task 9 — Add private launch-owned task ingress to the immutable production Game entry

**Files:**

- Modify: `host/src/main.ts`
- Modify: `host/src/semantic-main-config.ts`
- Modify: `host/src/semantic-main-config.test.ts`
- Modify: `host/src/continuity-semantic-deployment-composition/continuity-semantic-game-facade.internal.ts`
- Modify: `host/src/continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.internal.ts`
- Modify: materializer/facade tests
- Modify: `host/scripts/start-production-artifact.mjs`
- Modify: `host/scripts/production-artifact.test.mjs`

**Contract:** The runner sends one prompt-defined task to the already verified production child over Node IPC after the child publishes its receipt-owned Game Pi session identity and runtime readiness. This launch-only control message is private and nonce-bound. It is not a stable product API, operator config, run manifest, continuity record, environment prompt, stdout payload, or file.

- [ ] **Step 1: Write failing launcher/entry tests.** Reject missing IPC, wrong nonce, duplicate task delivery, task delivery before committed ingress, task text outside the bounded size/Unicode contract, and any task on a non-Game surface.
- [ ] **Step 2: Expose one narrow facade method that invokes the existing private `GameplayTaskSubagent`.** Do not mount a new action executor and do not bypass `delegate_game_task` semantics.
- [ ] **Step 3: Enable the gameplay worker in the production Game composition.** It uses GameBuddy-owned embedded Pi/runtime/data and the normal full integration tool projection.
- [ ] **Step 4: Return only the aggregate v2 evidence over IPC.** Child stdout remains untrusted and cannot satisfy the gate.
- [ ] **Step 5: Verify STOP or launcher termination closes the exact worker, active execution, integration, Pi session, and facade in existing reverse ownership order.**
- [ ] **Step 6: Commit checkpoint.** After private ingress, nonce/duplicate negatives, reverse-close tests, and review pass, stage only Task 9 paths and commit `Add private production game task ingress`.

---

### Task 10 — Turn the operational runner into a real prompt-defined product runner

**Files:**

- Modify: `tools/run-game-operational-gate.mjs`
- Modify: `tools/run-game-operational-gate.test.mjs`
- Modify: `tools/lib/game-operational-gate-preflight.mjs`
- Modify: `tools/lib/game-operational-gate-marker.mjs` only if the current marker contract genuinely remains part of this runner
- Create: `fixtures/stardew/game-operational-task.example.json`
- Modify: `.github/workflows/ci.yml` only for deterministic checks; do not put the verified-environment mutation gate on ordinary CI

**Task fixture semantics:** The fixture supplies a natural-language task, not an action list, route, expected tool IDs, tile sequence, capability subset, scripted world mutation, or product runtime limit. It may bind the target game version and a release-owned save/profile selected before the run. A separate runner-only process timeout may be supplied by the operator/harness; it is never forwarded to the product child as task semantics.

- [ ] **Step 1: Replace the permanent `BLOCKED` branch with failing runner tests for the production child IPC handshake.**
- [ ] **Step 2: Spawn `host/scripts/start-production-artifact.mjs main.js` with `stdio: ["ignore", "pipe", "pipe", "ipc"]`, the verified deployment-manifest reference, and one per-run nonce only.** The runner receives no product run manifest, STOP credential, installation/profile/process/bridge/session fact, capability, task route, or lifecycle token. Product composition obtains Design 101 registration and Game-owned STOP authority internally through Design 100; the runner only observes authenticated IPC results and may terminate its exact direct child tree on harness failure.
- [ ] **Step 3: Deliver the task exactly once after receipt-owned readiness.** The runner does not inspect or modify the Agent plan.
- [ ] **Step 4: Give the release harness an external process timeout and kill/close the exact process tree on harness timeout or malformed IPC.** The child does not receive this value, no gameplay task record contains it, and timeout means `gate_failed: harness_timeout`, never product `blocked`, `cancelled`, or game-task completion. Preserve failure evidence; do not retry live mutation automatically.
- [ ] **Step 5: Validate the v2 content-free report and write it with exclusive creation.** Report only artifact identity, target versions, counts/booleans, terminal class, STOP/teardown outcome, and reason code.
- [ ] **Step 6: Prove negative cases deterministically:** fixture adapter, stdout forgery, wrong nonce, foreign Pi session, duplicate evidence, one transition without fresh observation, success without action-specific postcondition, and missing teardown all fail closed.
- [ ] **Step 7: Commit checkpoint.** After the runner and all deterministic negatives are green and reviewed, stage only Task 10 runner/tests/CI deterministic wiring and commit `Run operational gate through production composition`.

---

### Task 11 — Run one verified-environment open-ended Stardew session

**Files:**

- Create on execution: one release evidence report under the existing release-owned evidence location chosen by the runner
- Modify only if a real failure reveals a production defect: the owning Host/adapter/Mod module and its focused test

- [ ] **Step 1: Freeze only environment facts:** exact Stardew version, SMAPI version, Mod build, immutable Host artifact generation, GameBuddy-owned runtime root, selected release save/profile, model profile, and the natural-language task. The task may itself request a game-world horizon (for example, “play until tonight”), but infrastructure does not add a hidden turn/action/wall-clock limit.
- [ ] **Step 2: Static preflight:** build/typecheck/tests, protocol parity, Mod publication parity, production artifact verification, verified Design 102 containment, Design 101 registration closure, Design 100 product-lifecycle composition, product-owned lifecycle readiness, bridge availability, STOP authority, and clean evidence target. If the run is used for a Desktop Player Release claim, Design 103/104 closure is also required; otherwise label it as Game pipeline/live evidence only.
- [ ] **Step 3: Review the task fixture.** Confirm it contains no action sequence, expected tool names, route, capability subset, action-count target, test authority, or fabricated world result. If a one-time external release exercise seeks multi-step evidence, that expectation remains outside the product prompt/runtime and failure to hit a count is reported as insufficient release coverage, never as product task failure or a reason to rerun mutation automatically.
- [ ] **Step 4: Execute exactly one verified-environment mutation run.** The Agent chooses its own actions. Do not rerun merely to obtain a better-looking report.
- [ ] **Step 5: Accept only if:**
  - the production Game Pi session and authenticated bridge are real;
  - the normal full live capability projection is mounted;
  - the prompt-defined task reached an honest natural terminal outcome without any hidden action-count requirement;
  - every successful typed transition that did occur has action-specific evidence and a later fresh observation;
  - every later action that did occur was selected only after the preceding fresh post-transition observation became available, rather than being supplied by a runner script;
  - completion/blocked status is honest;
  - STOP and teardown settled without an owned active execution;
  - the player-visible game state reflects the native result.
- [ ] **Step 6: If a production defect appears, preserve the failed record, fix offline with a focused regression test, and follow the repository's single-mutation review rule before considering another live mutation.**
- [ ] **Step 7: Commit/evidence rule.** A clean live run creates no source commit. If the repository has an explicitly approved tracked redacted evidence location, commit only that report as `Record verified Stardew gameplay evidence`; never commit mutable runtime roots, session/config manifests, logs, prompts, model output, credentials, or save data. A defect is fixed offline in the owning Task-sized atomic commit before another live-mutation decision.

---

### Task 12 — Consolidate release architecture and implementation status

**Files:**

- Modify: `design/78_GAME_PIPELINE_RELEASE_ARCHITECTURE.md`
- Modify: `design/79_GAME_PIPELINE_RELEASE_IMPLEMENTATION_PLAN.md`
- Modify: `design/03_AGENT_RUNTIME.md`
- Modify: `design/README.md` if it indexes current Game release authority

- [ ] **Step 1: Make design 78 the owning architecture for prompt-defined open gameplay.** Remove frozen action manifest, canonical route, preset capability subset, and proof-driven scenario semantics.
- [ ] **Step 2: Make design 79 a status/index document pointing to this plan for the remaining closure.** Do not maintain two competing step-by-step plans.
- [ ] **Step 3: Record what category theory contributed:** effectful transition boundary, restrictive capability intersection, structure-preserving adapter, and executable laws. Record the retired runtime as superseded.
- [ ] **Step 4: Update status only from verified command/live evidence.** Do not mark Game releaseable because deterministic tests pass alone.
- [ ] **Step 5: Documentation commit checkpoint.** After a fresh review confirms every status statement has cited command/live evidence, commit `Document prompt-defined Game release architecture` only if document tracking is explicitly enabled. Do not force-add the currently ignored `design/` tree merely to create a commit.

---

## 5. Verification matrix

### Deterministic required checks

```bash
pnpm --filter @gamebuddy/dialogue-web typecheck
pnpm --filter @gamebuddy/dialogue-web test
pnpm --filter @gamebuddy/dialogue-web build
pnpm --filter @gamebuddy/companion-host typecheck
pnpm --filter @gamebuddy/companion-host test
pnpm --filter @gamebuddy/companion-host build
pnpm --filter @gamebuddy/companion-host check:production-artifact
pnpm --filter @gamebuddy/voice-protocol test
dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/GameBuddy.Stardew.Core.Tests.csproj
dotnet test integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/GameBuddy.Stardew.Integration.Tests.csproj
node --test tools/run-game-operational-gate.test.mjs
```

Use narrower commands during TDD. Run the complete matrix only after focused tests pass.

### PBT laws worth keeping

- capability projection is restrictive and insensitive to input ordering/duplicates;
- action/request/execution correlation rejects every foreign tuple;
- duplicate terminal facts do not create duplicate transitions;
- a successful counted transition always has action-specific postcondition evidence and a later snapshot;
- terminal states are monotone;
- cancellation absorbs work not yet past the native mutation linearization point;
- no following ordinary action dispatch occurs before the preceding Mod-owned terminal receipt and a fresh snapshot at/after its revision; un-dispatched workflow intent is never an execution receipt;
- idempotent replay produces at most one native side effect;
- removal of a live capability cannot leave a stale executable tool in a newly constructed runtime.

Do **not** write PBT for arbitrary action-sequence associativity in a live, time-progressing game: intermediate observations and native time make that law false in general.

### Manual/target-live required check

One reviewed, verified-environment, prompt-defined run using the immutable production artifact, shipped frontend/launcher composition, and normal production runtime action projection. The run records the exact detected version tuple as evidence; it does not turn that tuple into an ordinary product allowlist. This check is required for release and is intentionally separate from ordinary CI.

---

## 6. Residual work after this plan

This plan already includes the release-required first-run setup, ordinary player launch/attachment, safe diagnostics, compatibility policy, and two-role process ownership. They are not deferred behind the autonomous-play proof. Later release engineering may broaden storefront packaging, signing, automatic update channels, additional installation locations, richer diagnostics, and exploratory compatibility coverage, but the shipped release cannot omit the fresh-player frontend journey defined here.

A second real open-source game adapter should follow after Stardew closure to challenge the generic seam. It validates portability; it does not justify delaying the first real Stardew release or adding a universal ontology now.
