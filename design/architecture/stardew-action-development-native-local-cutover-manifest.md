---
id: ARCH-STARDEW-ACTION-DEVELOPMENT-NATIVE-LOCAL-CUTOVER-MANIFEST
type: architecture
status: draft
owner: stardew-integration
---

# `equip_tool` native-local live route cutover manifest

## Decision and gate

This is the T1 enumeration required by [the active convergence task](../tasks/active/stardew-action-development-platform-convergence.md). It identifies the **candidate Platform** native-local live route for `equip_tool`; it is not a production-action inventory and it grants no execution or publication capability.

The proposed replacement is the active task's frozen data-only route:

```text
Devkit one-shot control-child supervisor
→ thin Stardew production adapter
→ Host-owned one-shot Action Development Control Runner
→ StardewProductionLifecycleCoordinator
→ private in-process StardewActionDevelopmentRunPort
→ existing authenticated Mod action path
```

The replacement route must not accept a native-local profile, game/Mods/fixture/release path, pipe endpoint, token, PID, journal, recovery capability, admitted revision, `requestId`, or `idempotencyKey`. Its one start frame carries `scenarioId: "equip_tool_control"`, never action arguments; after authenticated attachment and a live snapshot, Host fixture preparation derives the action arguments and slot. The Host runner alone derives the admission revision, request identity, idempotency identity, execution identity, and persisted journal tuple.

**Atomic cutover is BLOCKED.** The production materializer recovery successor is now accepted: `createHostGameRuntimeMaterializer().materializeEnter()` reopens the stable-scope journal, establishes a fresh authenticated binding, and invokes the exact receipt query before ingress. This does not unblock cutover: the remaining blockers are registration-plan closure, the coordinator-private fixture port, the Host runner composition, and the Host-dependent adapter. T4 must reuse the accepted successor and must not create another recovery path; the blockers are not a reason to retain or repair the native-local route as a fallback.

## Protected production facts and scope

The following `equip_tool` facts are outside every `delete` or `replace` disposition in this manifest and require positive behavioral characterization at implementation time:

- Mod handler, `FarmhandActionDefinitions` catalog value, and live policy publication;
- Host tool exposure/visibility, action ID `equip_tool`, and existing typed arguments;
- same-logical-action receipt semantics; and
- release status.

Mod policy and game-thread checks remain the only action authority. Host registry, Platform records, descriptors, inventory, source projection, evidence, and this document are restrictive or diagnostic projections only.

Historical action evidence and historical design artifacts remain read-only. They cease to be current authority after cutover: they cannot route a live request, prove a new control run, seed recovery, or supply a fallback. This cutover also expressly excludes unrelated `tools/run-stardew-native-local-player-*-smoke.mjs` tooling for other published actions.

## Candidate route disposition today

The package still contains native-local profile, fixture, lease, and PowerShell
components as **legacy candidate wiring**, but the production action registry no
longer exposes a `runLive` function. `equipToolActionRegistration` instead has the
fail-closed policy:

```text
blockedPolicy: { state: "BLOCKED", reasonCode: "host_runner_not_registered" }
```

Consequently `action:run-live` currently terminates as blocked whether or not an
invocation supplies a `profileFile`; it does not enter the old chain. The old chain
below is a deletion inventory, not an active or authorized route:

```text
former package run-live dispatch
→ former `equipToolActionRegistration.runLive`
→ native-local profile preflight, lease, release-bundle and lifecycle components
→ PowerShell fixture/SMAPI/bridge transaction
```

No operator may use these retained files to re-enable, test as live, or bypass the
blocked registry. They remain only until the inventory-led T4 cutover removes or
classifies them.

## Enumerated manifest

`Direct callers` means a direct import, registration, script invocation, or explicit file-reference established by the current source paths named in the row. `Evidence confidence` distinguishes source-confirmed edges from a required future replacement or an intentionally bounded non-claim.

| Source path / symbol | Direct callers | Native-local edge | Published observable preserved | Disposition | Replacement caller | Other-action impact | Evidence confidence |
|---|---|---|---|---|---|---|---|
| `integrations/stardew/action-development/src/project-adapter-core.mjs` / `runActionProjectWithRegistry()` | `src/project-adapter.mjs` / `runActionProject`; Devkit project invocation | Resolves `ACTION_REGISTRY`; production `run-live` returns its registration's fail-closed `blockedPolicy` until a Host runner is registered | Neutral action-project report and verifier-only pass projection; not Mod authority | replace | Thin Stardew production adapter through the frozen Devkit helper | No registry-wide deletion; non-`equip_tool` registrations remain independently governed | Source-confirmed current blocked behavior; replacement required by active task |
| `integrations/stardew/action-development/src/action-registry.mjs` / `equipToolActionRegistration.blockedPolicy` | `project-adapter-core.mjs` / `runActionProjectWithRegistry()` | Current fail-closed terminal state; there is no current `runLive`, `runEquipToolRegistration`, or live native-local dispatch edge | `equip_tool` registration identity, contract checker, status reader, receipt/evidence/postcondition verifier, cleanup verifier, and protected production facts | replace | Frozen adapter supervision of the Host control runner; preserve non-live verifier surface | Only the `equip_tool` candidate control dispatch changes | Source-confirmed current behavior |
| `integrations/stardew/action-development/src/equip-tool-live.mjs` / former `runEquipToolLive()` orchestration | No current production registry caller; historical/native-local candidate inventory only | Former candidate orchestration root: profile preflight, lease, immutable staging, lifecycle, evidence finalization | Action ID, bounded live report shape, status semantics, and verifier inputs; no capability grant | delete | New thin production adapter and Host control-runner result consumer | No other action imports this `equip_tool`-specific live owner | Inventory-led deletion blocked on remaining T2/T3 prerequisites |
| `integrations/stardew/action-development/src/equip-tool-live.mjs` / `readEquipToolLiveStatus()` | `action-registry.mjs` / `equipToolActionRegistration.status` | Reads latest native-local evidence root | Status is observational only; it must not publish or change `equip_tool` | replace | Minimal control-run record/evidence status reader defined by the replacement route | Do not change project-wide status without a separate owner decision | Source-confirmed; replacement contract not implemented |
| `integrations/stardew/action-development/src/equip-tool-live.mjs` / `verifyEquipToolReceiptEvidencePostcondition()` and `verifyEquipToolCleanup()` | `action-registry.mjs` verifier wrappers | Consumes the candidate live owner's embedded verification payload | Action-specific receipt/evidence/postcondition and cleanup verification requirements | preserve | Existing registry verifier consumer, adapted only to bounded Host control result when that result exists | `equip_tool` only; no generic passing fallback | Source-confirmed; preservation is required |
| `integrations/stardew/action-development/src/equip-tool-preflight.mjs` / `preflightEquipTool()` and `consumeReadyEquipToolProfile()` | `action-registry.mjs`; `equip-tool-live.mjs` | Validates and binds native-local profile, release bundle, fixture, local client config, and lifecycle files | Readiness remains distinct from execution and cannot prove live success | delete | Coordinator-owned factual preflight/fixture boundary, only after its separately frozen implementation | No other action may inherit this profile binding | Source-confirmed; replacement deliberately unavailable |
| `integrations/stardew/action-development/src/profile.mjs` / target-profile parser and validator | `equip-tool-preflight.mjs` | Parses native-local game/Mods/fixture/release/client-config/lease fields | No player-visible action semantics or publication fact | delete | No Host control start/result field may carry this profile. A separately owned non-live fixture tool, if any, must introduce its own isolated configuration rather than retain this legacy live-profile schema | Delete only after the required inventory confirms no independently owned non-live consumer remains; do not retain compatibility parsing | Source-confirmed current consumer; deletion remains blocked on the inventory and T4 prerequisites |
| `integrations/stardew/action-development/src/target-runtime-lease.mjs` / `acquireTargetRuntimeLease()` | `equip-tool-live.mjs` | Native-local runtime-root lease surrounds fixture and PowerShell lifecycle | Mutual exclusion remains a product/coordinator invariant, not a route-specific observable | delete | `StardewProductionLifecycleCoordinator`'s lifecycle ownership; exact implementation is pending | Do not alter other action lease users without direct inventory evidence | Source-confirmed caller; replacement blocked |
| `integrations/stardew/action-development/src/immutable-release-bundle.mjs` / `createImmutableReleaseBundleBinding()` | `equip-tool-live.mjs` | Stages/attests native-local Mod release directory for PowerShell deployment | Protected production catalog/behavior and evidence distinction | delete | Coordinator-owned production lifecycle/fixture sequence, if it needs a separately approved bundle input | No shared release-bundle deletion inferred | Source-confirmed caller; replacement blocked |
| `integrations/stardew/action-development/src/equip-tool-lifecycle.mjs` / `runEquipToolLifecycle()` | `equip-tool-live.mjs` | Creates action/lifecycle private claims, calls closure backend, parses scenario proof | Exact action-specific proof requirement and cleanup fact; not a receipt authority | delete | Thin adapter consumes only bounded control result; Host owns dispatch/lifecycle | `equip_tool` only | Source-confirmed; deletion blocked |
| `integrations/stardew/action-development/src/stardew-closure-backend.mjs` / `runStardewClosureBackend()` | `equip-tool-lifecycle.mjs` | Constructs and supervises PowerShell native-local lifecycle command | Bounded failure redaction only; no action-success judgment | delete | Devkit generic supervisor plus Host control runner, each within its approved boundary | Do not repurpose it for other actions | Source-confirmed; deletion blocked |
| `integrations/stardew/action-development/src/write-lifecycle-result.mjs` / lifecycle result serializer/writer | `scenarios/write-lifecycle-result.mjs`; closure-backend parser contract | Native-local private lifecycle terminal transport | No public action result; lifecycle completion cannot make an action pass | delete | Bounded Host control result protocol; it is not a lifecycle-result compatibility layer | `equip_tool` route only | Source-confirmed; deletion blocked |
| `integrations/stardew/action-development/scenarios/write-lifecycle-result.mjs` / CLI main | `tools/run-stardew-native-local-player-move-fixture.ps1` | PowerShell emits completed/failed native-local lifecycle result | None beyond bounded diagnostic lifecycle code | delete | Host control runner emits the replacement bounded terminal result | No other action caller established by this manifest | Source-confirmed |
| `integrations/stardew/action-development/scenarios/equip-tool-live-child.mjs` / CLI main | `tools/run-stardew-native-local-player-move-fixture.ps1` | Connects harness-owned local client, preflights, invokes `runEquipToolSmoke`, writes private scenario result | Existing typed request, receipt/evidence/postcondition requirements; not its native-local transport | delete | Host runner uses existing authenticated production path through its private port | Preserve `tools/run-stardew-native-local-player-equip-tool-smoke.mjs` itself until a separately approved disposition names it | Source-confirmed |
| `tools/run-stardew-native-local-player-move-fixture.ps1` / parameterized transaction | `stardew-closure-backend.mjs` / `runStardewClosureBackend()` | Launches fixture/SMAPI/bridge transaction; for `equip_tool`, invokes both package scenario CLIs; publishes lifecycle result | Fixture is Given only; no fixture outcome is action success; protected Mod/Host facts remain untouched | replace | Host coordinator owns preflight → offline prepare → launch/attachment → one action → teardown/containment → restore → cleanup | Preserve script's unrelated action branches and unrelated native-local smoke tooling. Before deleting `equip_tool` child-file references, make shared PowerShell validation action-conditional so non-`equip_tool` branches do not require those files; only then remove the listed `equip_tool` branch | Source-confirmed; selective action-conditional edit required, never broad deletion |
| `integrations/stardew/action-development/package.json` / `action:run-live` | Operator command; `ACTION_RUNBOOK.md` | Invokes generic `game-action.mjs run-live`, which reaches project adapter/registry candidate edge | Canonical command naming and explicit action invocation; command does not itself publish capability | replace | Same package command invokes the replacement adapter path after registry cutover | Preserve `test`, `action:inventory`, `action:check`, `action:status`, `action:ci`, extraction, portfolio, and publication scripts unless separately listed | Source-confirmed |
| `integrations/stardew/action-development/ACTION_RUNBOOK.md` / “Live `equip_tool` gate” | Human/operator consumer of `action:run-live` | Documents the native-local profile and lifecycle sequence | Requirement for preflight/review/authorization, receipt/evidence/postcondition, cleanup, and no uncertain retry | replace | Current active-task control-runner runbook after implementation | No documentation instruction may retain a native-local live fallback | Source-confirmed |
| `integrations/stardew/action-development/src/tool-inventory.mjs` and `tool-inventory.json` / `pilotLegacyClosure` | `action:inventory`; package/project inventory validators; standalone inventory mirror | Classifies the PowerShell transaction, `equip_tool` smoke, harness, registry reader, descriptor, and runner resolver as the pilot legacy closure | Inventory remains non-executable and cannot become publication authority | replace | Inventory entry set updated atomically with actual T4 dispositions | Preserve every unrelated native-local tool entry; no filename-pattern deletion | Source-confirmed |
| `integrations/stardew/action-development/src/action-source-projection-producer.mjs`, `contracts/projection/action-source-projection.v1.json`, and `src/action-source-projection-check.mjs` | package portfolio's `action-source-projection-check`; projection/parity tests | Fixed source projection reads root `tools` runner sources and records `equip_tool` projections | Mod catalog/bridge/router and Host restrictive projection remain protected; development-only projection never grants live capability | replace | Updated fixed source list and regenerated development-only snapshot after T4, with guards for preserved production facts | Other action projections require their own source facts; do not remove all runner-source coverage | Source-confirmed |
| `integrations/stardew/action-development/portfolio.json` / `action-source-projection-check`, `package-deterministic-tests`, and `equip-tool-contract-check` | `src/portfolio.mjs`; `action:ci` | Deterministic consumers exercise candidate-route tests and source projection | Contract check and deterministic portfolio remain non-live; no test artifact may claim publication | replace | Retain appropriate deterministic checks; remove/replace only native-local live-route assertions after T4 | Other portfolio entries remain scoped to their declared checks | Source-confirmed |
| `integrations/stardew/action-development/artifacts/action-runs/stardew/equip_tool/*` and `latest.json` / evidence status reader | `readEquipToolLiveStatus()` | Historical native-local evidence bundles and latest pointer | Historical evidence stays immutable and cannot be reclassified as current authority or new live proof | preserve | Read-only historical access only; new control-run evidence uses its replacement owner | No deletion, overwrite, or replay-as-success for any action | Source-confirmed historical consumer |
| `integrations/stardew/action-development/standalone/` mirror: `tool-inventory.json`, `src/tool-inventory.mjs`, `contracts/projection/*`, `src/action-source-projection-*`, `portfolio.json`, and `standalone-extraction-manifest.json` | standalone tests and extraction rehearsal | Frozen/extraction mirror consumes inventory and source-projection artifacts, not the package's native-local `runLive` implementation | Standalone deterministic/extraction claims only; it has no runtime input and cannot resurrect a live route | replace | Regenerate mirror from post-cutover package-owned deterministic artifacts; retain its no-former-root read policy | No standalone path may reintroduce a native-local live caller or fallback | Source-confirmed mirror relationship; no live-route direct caller found |
| `tools/run-stardew-native-local-player-*-smoke.mjs` for published actions other than `equip_tool`, plus their fixtures/tests | Their own action-specific runners/tests, not this `equip_tool` registration edge | Native-local smoke tooling outside the enumerated `equip_tool` route | Their current independent diagnostic/test availability | preserve | None | Explicitly out of scope; no broad grep or pattern deletion | Scope constraint; confirmed by manifest boundary, not an exhaustive action inventory |

The Devkit helper and pure Stardew data protocol may proceed in T3 after T1 review accepts their frozen shape. The Host-dependent adapter remains **BLOCKED** until the coordinator-owned fixture port, Host-runner composition, and registration-plan prerequisites are accepted. T4 may begin only after T2 and T3 complete their frozen work. Its closure guard must:

1. reject every `delete`/`replace` **native-local edge** listed above, not merely filenames or text tokens;
2. positively characterize the protected `equip_tool` production facts;
3. prove no diagnostic/live fallback, alias, alternate native-local profile route, or new action identity remains;
4. preserve unrelated other-action native-local smoke tools; and
5. update package inventory, source projection, standalone mirror, runbook, status, portfolio, and evidence consumer together with the landed route.

Until then, this manifest is a review artifact only. It authorizes neither deletion nor a live action.
