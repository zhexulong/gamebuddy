# Production / Production-Release Handoff

**Status:** active handoff
**Scope:** production runtime integration and production-release coordination.
**Control action:** `equip_tool` is an already published, known-good control. Do not change its implementation, catalog/policy, Host visibility, action ID, argument semantics, receipt semantics, or release status.

## Purpose

The remaining work is to make production and release/control use one runtime path:

```text
CI-published immutable Host generation
→ Desktop exact Host runtime admission
→ Desktop ↔ Host Guardian broker
→ Guardian exact attempt settlement/recovery
→ Host-private Stardew installation registration
→ StardewProductionLifecycleCoordinator
→ production Game or one control scenario
```

Release/control differs from production only by a coordinator-private disposable fixture, a single control action, and bounded verification evidence. It must not launch a second game runtime, own a bridge, read a native-local profile, or construct a separate recovery path.

## Scope split

### External generation input

This line consumes an already published immutable Host generation. How CI/release produces, verifies, transports, or tests that generation is outside this handoff.

For this line, the only relevant rules are:

- Desktop admission consumes the selected immutable generation and its published pointer/sidecars;
- production/control never supplies a local runtime, runtime path, alternate generation, or fallback;
- if runtime test material is unavailable, record the missing CI fixture as an environment prerequisite rather than rebuilding a generation locally.

The current worktree contains concurrent publisher/runtime changes owned by other work. Do not reset, clean, revert broadly, or treat those paths as this handoff's work.

## Reuse versus implementation boundary

This section prevents duplicate authorities. **Reuse** means connect to the named source/seam; it does not mean copy its logic into a control-specific module. **Implement** means the seam is currently absent or explicitly incomplete.

### Reuse — do not implement a parallel version

| Existing authority or primitive | Source/seam | Boundary |
|---|---|---|
| One-shot child supervision | `packages/game-action-devkit/src/process-supervisor.mjs:runOneShotControlChild` | Adapter calls it; adapter does not spawn, read streams, drain, or recover. |
| Control data protocol and result verification | `integrations/stardew/action-development/src/stardew-control-protocol.mjs`, `equip-tool-control-result.mjs` | Do not define a second start/result shape or generic proof interpreter. |
| Action execution and same-lineage recovery | Existing `ActionExecutionCoordinator`, stable-scope journal, `StardewExecutionRecoverySupervisor` composition in `createHostGameRuntimeMaterializer().materializeEnter()` | Reuse the existing executor/journal/recovery owner; no control-specific executor or recovery owner. |
| Production lifecycle | `StardewProductionLifecycleCoordinator` | Add only a coordinator-private control/run seam; do not create a control coordinator. |
| Installation identity admission | `admitStardewInstallation()` and its branded consume/recheck primitives | Reuse for request-local fresh admission; do not persist or reuse `AdmittedStardewInstallation`. |
| Windows generation/Guardian primitives | `InstalledGenerationSelection`, `InstalledHostRuntimeAdmission`, `InstalledGenerationAdmission`, `GuardianSupervisor` | Freeze one selection and compose these primitives; do not add another selector, runtime verifier, or Guardian launcher. |
| Published action authority | `equip_tool` Mod/catalog/Host visibility/receipt/evidence/postcondition facts | Treat as immutable control input; do not repair the action when the platform path fails. |

### Existing but incomplete — finish the named seam, not a replacement

- Host publisher/runtime-admission changes in the dirty worktree are concurrent owner work. This handoff consumes their published generation; it does not rebuild the publisher or create a local runtime fixture as production input.
- `host/src/desktop-runtime-bootstrap.internal.ts` now contains the private bootstrap-frame consumer, first-write root-layout validation, and authenticated Guardian hello/session consumer. It still does not hand the session to Stardew lifecycle composition or construct the full Host product surface.
- Desktop exact Host-child admission and a resident Desktop↔Host Guardian broker tracer bullet are implemented on top of the existing generation/Guardian admission primitives. Recovery E2E, full broker closure, and production Stardew role delegation remain incomplete.
- Bootstrap owner v4 remains the sole `owner.json` CAS/binding authority. Owner-private registration prepare-bind, matching settlement-release, strict marker reconciliation, and exact settlement proof are implemented; full cross-file crash/orphan recovery evidence and production role delegation remain incomplete.
- Host-private registration storage/parser exists and is owner-transaction aware, but coordinator setup/launch still uses the transitional picker-retained capability; the required request-local Stage C/Stage D choreography is not yet wired.
- The coordinator-private fixture port and Host control runner do not yet exist. The native-local `equip_tool` route remains until the replacement route is implemented, verified, reviewed, and cut over atomically.

### Implement — remaining production seams

1. Complete the Desktop/Host/Guardian source-bound E2E closure, including recovery-session evidence and the canonical published-generation fixture.
2. Consume the authenticated Host Guardian session from the Stardew private composer and replace production direct Node role spawn/kill with acknowledgement-backed Guardian delegation.
3. Complete cross-file registration crash/orphan evidence and the exact fresh-lifecycle recovery successor; do not add another authority.
4. Wire Host-private registration into coordinator setup/launch and independent request-local Stage C/Stage D admission.
5. Implement the coordinator-private `equip_tool_control` fixture port, then the Host-owned one-shot control runner and in-process run port.
6. Wire the thin adapter to the existing Devkit helper and Host runner, only after the runner seam is accepted.
7. Atomically delete only the manifest-listed native-local `equip_tool` live edges.

### Never implement in this handoff

- A second lifecycle coordinator, action executor, receipt recovery owner, installation admission, generation selector, runtime verifier, Guardian launcher, registration fence, fixture framework, or browser registration DTO.
- A control-specific process/bridge owner, adapter-side retry/recovery, native-local fallback, profile import/adoption, PowerShell live route, system Node/PATH runtime, arbitrary path input, or generic command bridge.
- Changes to `equip_tool` implementation, Mod policy, catalog/publication, Host action ID/arguments/visibility, receipt/evidence/postcondition semantics, or release status.
- Merging Preview or Portfolio into the production coordinator topology.

### Production integration — ordered work

1. **Consume:** use the CI-published immutable generation and one frozen `InstalledGenerationSelection`; close only the named publisher/fixture verification gap in its owning lane.
2. **Implement:** exact Host child bootstrap and Host root-layout validation.
3. **Implement:** Desktop↔Host Guardian broker.
4. **Implement:** owner joint prepare-bind/settlement-release, then authorize production role delegation through the closed broker.
5. **Implement:** unified Host-private installation registration and coordinator multi-request choreography.
6. **Implement:** coordinator-private fixture port and Host-owned control runner.
7. **Integrate:** thin adapter with the existing Devkit supervisor and existing action verifier.
8. **Cut over:** remove the legacy native-local `equip_tool` live route atomically.
9. **Verify:** offline gates, aggregate review, non-mutating production preflight, then one authorized control live.

## Immutable action control

`equip_tool` is the platform control, not an action under redevelopment.

Given the published action and a candidate platform/runtime path, failures default to the candidate platform/runtime unless independent evidence shows an `equip_tool` regression. Never respond to a control failure by changing:

- `equip_tool` handler or Mod policy;
- publication/catalog state;
- Host tool visibility;
- typed slot contract;
- receipt/evidence/postcondition semantics.

## Current verified work

### Platform Host-independent core

Already implemented and independently reviewed:

- `packages/game-action-devkit` one-shot control-child supervision:
  - single bounded start/result framing;
  - `AbortSignal` cancellation;
  - bounded process-tree termination/drain;
  - invalid post-spawn surface cleanup;
  - explicit 32 KiB control-line limit;
  - generic `runBoundedChild` retains 64 KiB capture.
- bounded Stardew control start/result/proof protocol;
- action/harness/cleanup outcome separation;
- `equip_tool` proof consumer with restrictive slot validation (`0..36`).

Latest known focused evidence:

```text
Devkit serial suite: 84 passed, 0 failed, 3 environment skips
process-supervisor: 22 passed
Stardew control protocol/result mapping: 12 passed
```

These are protocol and supervision foundations only. They are not a Host runner, fixture, cutover, or live proof.

### Production receipt recovery composition

Implemented and independently reviewed in the current Host worktree:

```text
stable-scope recovery journal
→ journal-backed ActionExecutionCoordinator
→ fresh authenticated receipt query before ordinary ingress
→ exact same-lineage recovery only, no action resend
→ awaited journal close
```

Known focused evidence:

```text
Host typecheck: passed
compiled recovery suite: 58/58
materializer response-loss regression: 16/16
```

Stable recovery identity is exactly:

```text
product, continuityId, integrationId, saveId, worldId
```

Do not compare `bindingDigest`, owner/epoch, PID, generation, or other runtime-local data across a restart.

### CI generation → Desktop consumer work

The target contract is frozen and the Desktop consumer/tracer implementation is present in the current dirty worktree:

```text
CI-published generation current.json exact four fields
  schema
  generation
  inventoryDigest
  runtimeAdmissionSha256
→ one frozen InstalledGenerationSelection
→ InstalledHostRuntimeAdmission + Guardian admission consume the same selection
```

Desktop hashes raw `host-runtime-admission.json` bytes before parsing and consumes only the selected generation; it does not rebuild inventory/closure or establish a second runtime authority.

Desktop must:

- hash raw `host-runtime-admission.json` bytes before parsing and compare to `runtimeAdmissionSha256`;
- verify only fixed `runtime/node.exe` and `desktop-runtime-bootstrap.internal.js` through locked non-reparse handles and their hashes;
- not rebuild inventory, closure, or Node supply-chain provenance;
- not select a runtime/entry from PATH, environment, old generation, or caller data.

Desktop source/build review accepted the current admission and resident broker tracer-bullet boundaries. Focused C# source/build checks pass, but full runtime execution remains blocked until CI supplies the canonical disposable test-generation fixture; no full Desktop↔Host↔Guardian E2E closure is claimed.

**Residual:** `guardian-admission.json` pointer-byte association is not solved by `runtimeAdmissionSha256`; treat it as a separate Guardian admission follow-up. The Host-side session is still not consumed by Stardew private composition.

## Unified Stardew installation registration: storage implemented, lifecycle wiring pending

One active registration per Windows user:

```text
Host-private durable locator registration
→ fresh strict admission at each native effect
→ process-local opaque AdmittedStardewInstallation
→ same coordinator for production and control
```

Durable registration may contain only:

```text
schema, revision, state, locator,
desktop binding { rootLayoutVersion, productInstallationId },
activeAttempt pointer when occupied
```

It must not contain:

- opaque admitted capability or identity chain;
- Mods paths, release path, bridge config, pipe/token;
- fixture/template/save/slot facts;
- action identities, receipt/evidence, journal/recovery state;
- PID/Job/Guardian handles, launch generation, timeout, lease, profile fields.

Picker policy:

```text
first registration / explicit reselection / registration repair only
```

It is not a per-run release picker. Production and control both consume the same registration. The locator remains Host-private and is never sent to browser, Devkit, adapter, control start/result, logs, or evidence.

### Cross-request lifecycle choreography

Do not revive the discarded long-lived `withFreshRegisteredInstallation(callback)` design.

Required order:

```text
setup: picker → strict admission → publish/reselect locator only

game.launch:
  bootstrap-owner atomic prepare-and-bind
  → consume Phase A reservation
  → Stage B
  → request-local fresh admission immediately before Stage C

cabin confirm:
  independent request-local fresh admission immediately before Stage D

close/recovery:
  exact Guardian/bootstrap contained settlement proof
  → release matching activeAttempt pointer
```

`AdmittedStardewInstallation` must not survive across browser requests. The registration `activeAttempt` is only a durable pointer to the exact bootstrap/Guardian owner; it is not a second containment/cleanup authority.

## Current hard production blockers

Do not work around these with native-local profile, PowerShell, raw path, stale lock, PID inspection, timeout inference, or a second fence.

1. **Desktop Host child admission and private bootstrap closure**
   - exact child admission, one-shot bootstrap, first-write root validation, and resident broker tracer are present;
   - canonical published-generation fixture and source-bound Desktop↔Host↔Guardian E2E closure remain outstanding.

2. **Production Stardew Guardian consumption**
   - Desktop resident/recovery transport tracers and Host hello/session consumer are present;
   - Stardew private composer does not yet consume the session as production native ports;
   - Node player/AI process owners still directly spawn/kill and recovery E2E remains incomplete.

3. **Production Stardew role delegation and full attempt closure**
    - owner-private registration prepare-bind/settlement-release and exact settlement proof are present, with marker reconciliation;
    - the cross-file crash/orphan matrix is not yet a full OS-atomic proof;
    - production Player/AI role launch still uses the transitional direct Node owner path;
    - the Host session is not yet consumed by the Stardew private composer as production native ports.

4. **Unified registration and control path**
    - strict registration storage exists, but coordinator request-local Stage C/Stage D consumption is not wired;
    - fixture port, Host runner, adapter replacement route, native-local cutover, preflight, and live remain blocked.

## Legacy native-local action-development route

This is a candidate/migration route, not production authority:

```text
profileFile → gameInstallPath/modsPath/releaseDir
→ PowerShell lifecycle → native-local bridge/session
→ action-development lease/evidence
```

It must be atomically deleted only after the production/control path is implemented, verified, and reviewed. Do not preserve a fallback or profile import/adoption path.

Old profile fields are not the unified registration model:

| Old profile category | Correct owner |
|---|---|
| `gameInstallPath` | Host-private durable locator + fresh admission |
| `modsPath`, client config | per-attempt Host transaction profiles |
| release/bundle paths | CI/release generation producer |
| fixture/save/template/slot | coordinator-private run-local fixture |
| lease/timeout/evidence | run-local lifecycle/evidence |
| pipe/token/PID | ephemeral private lifecycle only |

## Required implementation sequence

Use the following order; do not start a downstream item by guessing an upstream seam:

1. **Consume:** use the CI-published generation, one frozen `InstalledGenerationSelection`, and existing runtime/Guardian admission primitives. The publisher lane owns any remaining runtime-contract tests or fixture publication.
2. **Implemented tracer:** exact Desktop Host-child bootstrap, Host first-write root-layout validation, and resident Desktop ↔ Host Guardian broker; complete the recovery/E2E closure before treating this as production-ready.
3. **Implemented foundation:** owner-private registration storage, prepare-bind/settlement-release reconciliation, and exact settlement proof; complete crash/orphan evidence and production role delegation through the authenticated broker.
4. **Next:** wire unified Host-private registration consumption into coordinator request-local Stage C/Stage D admissions.
5. **Then:** implement the coordinator-private fixture port and Host-owned one-shot control runner/run port.
6. **Integrate:** thin adapter with `runOneShotControlChild()` and the existing action verifier.
7. **Cut over:** atomically delete only manifest-listed native-local `equip_tool` live edges.
8. **Verify:** offline gates → aggregate review → non-mutating preflight → one authorized control live.

A missing predecessor is a blocker, not a reason to add a fallback, compatibility path, local runtime, or duplicate authority.

## Important current documents

Read in this order before modifying the corresponding area:

1. `AGENTS.md`
2. `design/README.md`
3. `design/domains/stardew/integration.md`
4. `design/architecture/release-model.md`
5. `design/adr/006-stardew-action-development-control-live-owner.md`
6. `design/tasks/active/stardew-action-development-platform-convergence.md`
7. `design/architecture/stardew-installation-runtime-registration-plan.md`
8. `design/tasks/active/stardew-bootstrap-containment-recovery.md`
9. `design/tasks/active/windows-desktop-host-runtime-admission.md`
10. `design/tasks/active/windows-desktop-runtime-supervisor-guardian-broker.md`
11. `design/tasks/active/host-bundled-runtime-bootstrap-contract.md`

Use current documents, not numbered root migration sources, as authority.

## Working-tree safety

The worktree contains extensive concurrent dirty and staged work in Host, Desktop, Guardian, Stardew, tools, design, and generated directories.

Before any edit:

1. inspect exact diff/status for target paths;
2. assign one writer per overlapping cwd/file group;
3. do not reset, checkout, clean, stash, mass-format, or stage unrelated paths;
4. use explicit paths / partial index for any commit;
5. keep `artifacts/`, historical evidence, and other owners' untracked files untouched.

## Verification expectations

- Use RED → GREEN → the cheapest meaningful focused test → one independent review for each seam.
- Validation is tiered, not ritualistic: after a seam changes, run only its affected focused check and type/build check; at the end of a connected batch, run one combined affected check plus `git diff --check`. Do not rerun broad suites after every edit.
- Run full package/Host/Desktop suites, design checks, and aggregate review only at a closure/release gate or when a concrete risk or failed check justifies them. The Task 5 command list is a closure gate, not a per-edit checklist.
- Do not repeat an unchanged failing command. Retry only after a changed hypothesis, changed input, or repaired environment; record environment blockers separately from product-code failures.
- AFT transport/cache failure is `UNKNOWN`, never proof of pass/fail.
- Distinguish test environment missing CI fixture from production-code test failures.
- Do not claim a completed full suite if a command times out; record completed focused evidence exactly.
- Existing hashes, identity checks, and gates remain only where the runtime/artifact contract requires them; do not add redundant validation, signatures, or attestations without a concrete failure they prevent.
- Do not start a game, mutate a save, invoke old native-local live, or run control live until every production/control prerequisite and reviewer gate is closed.

## Handoff completion criterion

A successor has understood this handoff when they can state:

```text
CI produces a trusted immutable Host generation.
Production admits and safely runs that generation.
Release/control consumes the same production lifecycle.
The published equip_tool is a control, not a target for modification.
```


## Current batch A — owner transaction and private registration

**User-visible result:** a Host-private Stardew registration can publish one admitted locator, and one lifecycle attempt can be prepared/settled through the sole bootstrap owner without exposing a registration view or creating a second attempt authority.

**In scope:** strict registration record/parser/storage; admission-before-publication; owner-private crash-safe prepare-and-bind marker and matching settlement-release; exact contained settlement proof boundary; focused crash-window tests.

**Explicit non-goals:** no coordinator/browser wiring in this batch; no fixture, control runner, adapter cutover, action change, process-owner delegation, live Stardew, fallback, migration, or second recovery/fence.

**Authority:** `owner.json` v4 remains the only durable attempt authority. Registration `activeAttempt` is only a matching pointer. A private transaction marker is coordination metadata, not an attempt fence or recovery owner. Only the owner core may prepare/bind or settle/release; registration cannot clear, recover, or infer an attempt.

**Acceptance:** admission precedes a ready write; strict record rejects unsafe data; prepare exposes either no public pair or an exact owner-prepared + matching-pointer pair; settlement requires a module-private exact guardian containment proof and clears only the matching pointer after owner terminalization; persistence failures remain unavailable/quarantined; no public/browser/path/capability leakage.

**Owned paths for the mutation lane:** `host/src/stardew-installation-registration.internal.ts`, its focused test, `host/src/stardew-private-bootstrap-composer.core.ts`, `host/src/stardew-private-bootstrap-composer.internal.ts`, `host/src/stardew-bootstrap-guardian.private.ts` and focused tests only where needed for the proof boundary. Do not edit Desktop, action-development, browser, Preview, Portfolio, or unrelated Host files.
