# Stardew Product Installation Registration Design

**Status:** Proposed; implementation is authorized only after the deterministic verifier matrix in this document is frozen and independently reviewed.

**Owner:** The shipped two-role Stardew product lifecycle.

**Predecessors:** `AGENTS.md`; `design/00_CORE_PRODUCT.md`; `design/09_BDD_VALIDATION_PLAN.md`; `design/91_OPEN_GAMEPLAY_PIPELINE_RELEASE_IMPLEMENTATION_PLAN.md`; `design/99_STARDEW_PRODUCT_SESSION_MATERIALIZATION_DESIGN.md`; and the frozen Design 100 boundary (`design/100_STARDEW_OPERATIONAL_GATE_PRODUCT_COMPOSITION_DESIGN.md`), not Design 100's successor implementation.

**Successors:** Design 104's player installation-discovery/setup journey; Design 100's private coordinator headless activation; and the Task 10/11 operational-gate migration.

## 1. Purpose and non-goal

The existing product lifecycle accepts a selected folder only in a single coordinator closure:

```text
Host-native IFileDialog selection
→ admitStardewInstallation()
→ opaque AdmittedStardewInstallation
→ coordinator-owned Stage C/D consumption
```

`AdmittedStardewInstallation` is intentionally process-local and non-serializable. It is a fieldless, frozen object recognized only by module-private `WeakSet`/`WeakMap` state. It cannot survive process restart, and no structural substitute may be accepted.

This design adds one **Host-private installation locator registration** so a later fresh product process can rerun strict admission and mint a new opaque capability. It does not itself discover installations, launch sessions, connect bridges, expose browser paths, dispatch generically, or provide an operational-gate fallback. Design 104 may supply bounded Host-private discovery candidates, but every confirmed candidate must pass this design's same strict admission and publication path.

## 2. Ubiquitous language

| Term | Meaning |
| --- | --- |
| **Locator** | A private, untrusted Windows installation-root candidate string stored only to locate the directory for a later fresh strict admission. It is not a capability, identity proof, or readiness fact. |
| **Registration** | The single versioned durable record containing a locator and its stable deployment binding. |
| **Fresh admission** | A new `admitStardewInstallation(inspector, locator)` call in the consuming Host process. It repeats root-to-SMAPI identity-chain verification and returns a new opaque `AdmittedStardewInstallation`. |
| **Active registration lease** | The exact runtime-root-scoped registration path lock **plus durable attempt fence** held from final reread/fresh admission until the exact coordinator attempt reaches reverse teardown or durable quarantine. The lock excludes live contenders; the fence prevents a stale-lock reclaimer from authorizing a successor before cross-process containment recovery. Neither is a serialized capability or browser token. |
| **Terminal invalid** | A durable redacted registration state indicating the locator/record/binding can no longer be safely used and requires a new native picker registration. |
| **Registration readiness** | A redacted prerequisite projection only. It never proves a game process, Player Host attestation, AI attach, Game enter, or task ingress. |

## 3. Single-authority graph

```text
shipped Game browser command (no path)
→ authenticated Host-native picker callback
→ immediate strict admission
→ Host-private registration store publishes locator + deployment binding
→ redacted registration readiness projection

later product coordinator attempt
→ registration store read + stable binding validation + fresh admission while holding the active registration lease
→ new opaque AdmittedStardewInstallation in coordinator-private closure
→ existing Stage C Player Host launch / attestation
→ existing Stage D AI attach
→ Design 99 materializer
→ existing Game enter / STOP / teardown
```

The registration store ends at fresh `AdmittedStardewInstallation` input. It never launches a process, opens a bridge, constructs a runtime/facade, chooses a cabin, attaches a Farmhand, enters Game, publishes task ingress, or stops anything.

`StardewProductionLifecycleCoordinator` remains the only product owner of those effects.

## 4. Stable deployment binding

A registration record binds exactly these **stable** deployment facts, loaded and canonicalized by `loadHostDeploymentManifest()`:

```text
schemaVersion: 1
runtimeRoot: canonical manifest.runtimeRoot
principal: { continuityId, companionId, playerId }
authorityGeneration: manifest.authorityGeneration
```

It deliberately does **not** bind `bootstrapOperationId`. That identifier names an individual launch/bootstrap operation and changes between fresh processes; binding it would make a registration unusable precisely when it is needed after a restart. A consuming process must nevertheless load a valid manifest and match the four fields above before it can read, acquire the active registration lease, or fresh-admit a locator.

The deployment manifest remains free of installation, executable, bridge, profile, PID, session, token, generation, capability, identity-chain, inspector, or locator fields.

## 5. Durable record and projection

### 5.1 Private exact record

The store keeps one exact JSON registration record and one exact durable attempt-fence record under a runtime-root-contained internal registration directory. The filenames and directory are fixed constants; they contain no principal, locator, native identity, or user-controlled text.

The persisted registration record has a bounded, exact schema:

```ts
type StardewInstallationRegistrationRecordV1 = Readonly<{
  schemaVersion: 1;
  binding: Readonly<{
    runtimeRoot: string;
    principal: Readonly<{
      continuityId: string;
      companionId: string;
      playerId: string;
    }>;
    authorityGeneration: number;
  }>;
  revision: number;
  state: "ready" | "invalid";
  locator: string | null;
}>;
```

Rules:

- `ready` contains one non-empty absolute Windows root locator; `invalid` contains `null`.
- The registration record contains no capability or capability-shaped object, bridge pipe/token, launch generation, PID, endpoint, profile/session/config path, manifest, executable path, identity-chain output, inspector data, action policy, receipt, runtime/prompt/credential data, or error cause.
- Strict JSON parsing rejects duplicate keys, prototypes, symbols, unknown/missing fields, unsafe numbers, oversize data, invalid binding, invalid revision/state pairing, and unexpected locator syntax.
- The storage adapter returns the locator only to the registration core's private re-admission callback. No exported read API exposes it.

The attempt fence contains no locator or bridge/process secret. It records only the exact registration revision, stable deployment binding, opaque bootstrap-owner correlation required by the future recovery authority, and a bounded state such as `active` or `contained`. It is written before any coordinator effect, is cleared only after exact reverse teardown/quarantine has completed, and is never treated as evidence that cleanup succeeded merely because the lock owner PID is dead.

### 5.2 Public redacted projection

The only browser/state projection is:

```ts
type StardewInstallationRegistrationReadiness = Readonly<{
  status: "unregistered" | "ready" | "invalid" | "busy" | "unavailable";
  revision: number;
}>;

`revision` is `0` for `unregistered`; it is never an installation, attachment, or process generation. This projection is not a launch readiness, and it must not cause a browser to claim `prerequisites: met`, `instance: launching`, `instance: running`, attachment, catalog availability, or task availability.

Public errors are fixed redacted categories. Public messages, browser DTOs, state, logs, telemetry, IPC, operational reports, test snapshots, manifests, and exception serialization must not contain a locator or a derived executable path.

## 6. Producers and consumers

### 6.1 Sole publication producer

The sole durable write producer is the registration owner's private `registerAdmittedLocator` operation. It accepts a locator only after a user-initiated producer has completed strict admission. The currently implemented producer is the authenticated shipped Game command whose Host callback invokes the native Windows folder picker. Design 104 may add a second user-initiated candidate source—bounded automatic discovery plus explicit confirmation—but it receives no direct storage write and uses this exact publication operation. Raw locators remain inside Host-private callbacks:

```text
select native folder OR confirm one Host-private discovered candidate
→ strict admitStardewInstallation()
→ atomically publish locator only after admission succeeds
→ return redacted completion
```

The browser request carries no path. Cancel produces the existing redacted cancelled completion and does not alter a ready registration. An admission or persistence failure produces a redacted terminal outcome; it does not publish ready.

### 6.2 Sole consumer

Only a non-exported, composition-created method invoked by `StardewProductionLifecycleCoordinator` may consume registration:

```text
acquire exact registration path lock
→ reject any unresolved durable attempt fence
→ reread exact record
→ validate stable binding
→ fresh admitStardewInstallation(inspector, locator)
→ persist active attempt fence correlated to exact private bootstrap owner
→ establish exact coordinator reservation and active ownership while the same lock remains held
→ call coordinator-private callback with the new capability
→ Stage C/D, attachment and runtime lifecycle
→ exact reverse teardown or durable owner quarantine
→ durably clear/contain the attempt fence
→ release the registration path lock
```

The **active registration lease** is the held exact path lock plus durable attempt fence, not an in-memory claim. It remains effective for the complete coordinator-private attempt, including asynchronous Stage C/D, attachment, STOP/disconnect and reverse teardown/quarantine. The capability never leaves the coordinator-private closure. The coordinator consumes it through existing Stage C/D fresh recheck APIs.

A coordinator close before Stage C clears the fence and releases the lease without launch. An uncertain side-effect path retains an `active` fence until durable quarantine and reverse containment settle. If the process crashes, the existing Windows stale-lock reclaimer may establish only that the lock-file owner is dead; it cannot clear the fence or authorize another attempt. A successor must invoke the future bootstrap-owner-aware recovery/containment authority. Until it establishes durable containment or proves no owned side effect could survive, the registration remains `unavailable`.

Preview, Portfolio, operator selection, legacy `main.ts` selection, run manifests, operational runner config, child IPC, browser DTO handlers, generic integration launchers, and external harnesses have no import path to read/create/consume the registration.
## 7. Locking, revision, leases, fences and revocation

The store has an exact runtime-root-scoped internal lock using `withPathLock`; it is not a Chat/Game surface transition lock. The lock pathname is a fixed internal leaf and must be checked for containment/reparse safety. The lock is a live mutual-exclusion primitive—not a crash-recovery authorization primitive.

Within the lock:

1. **Register:** strict admission succeeds first; then publish `ready` at `revision + 1` atomically. A failed write publishes nothing. An unresolved attempt fence yields a redacted unavailable/busy outcome and prevents replacement.
2. **Consume:** acquire the exact registration lock, reject an unresolved attempt fence, reread the complete record, validate the stable binding, fresh-admit the locator, persist an active attempt fence correlated to the exact private bootstrap owner, and verify the same record/revision is still current before coordinator reservation. Retain the lock through the coordinator-private callback. The callback receives only the new opaque capability.
3. **Contain/clear:** only the coordinator's successful reverse teardown or its durable owner quarantine may atomically clear or mark the exact fence `contained`. A generic stale-lock reclaimer, elapsed time, browser action, registration reread, or a new picker selection may never clear it.
4. **Recover:** after a crashed lock owner, only a dedicated bootstrap-owner-aware recovery authority may inspect the fence and durable owner, verify and persist containment of all potentially surviving owned processes/effects, then transition the fence to `contained`. In its absence or on any uncertainty, the registration is unavailable and no callback/spawn is reached.
5. **Invalidate:** parsing, read, binding, locator, fresh-admission, reparse/identity, or durable-write failure is fail closed. Where a durable invalid record can be atomically written, it replaces the ready record with `invalid` and incremented revision; otherwise the operation remains unavailable and cannot infer readiness.
6. **Replace/revoke:** a new native picker registration or explicit private revocation cannot displace an active/unresolved fence. It returns a redacted busy/unavailable outcome until exact containment is durably established.

No process-local coordinator promise/map is treated as cross-process ownership. The lock plus fence establishes registration ownership; the existing bootstrap owner establishes launch/process ownership within that attempt.

A fresh admission succeeds only for the current attempt. It never silently repairs, refreshes, or revalidates the stored record for future attempts.

## 8. Failure and compatibility policy

- missing, malformed, unsafe, oversized, or binding-mismatched record/fence;
- missing/moved locator, reparse boundary, changed root-to-leaf identity chain, invalid file/object type, cross-volume replacement, or admission failure;
- required persistence/atomic publication/lock/fence safety failure;
- unresolved active attempt fence or failure to prove durable containment through the dedicated recovery authority.

This registration module performs no Steam/GOG/registry/VDF discovery, saved-path fallback, migration, read repair, adoption, or operator override. Design 104's discovery module may inspect only bounded supported installation records to produce untrusted candidates; it cannot bypass strict admission, silently select a fallback, or write this record directly.

`compatible_unverified` and `below_minimum_warning` remain advisory classifications under Design 91 and do not become registration-level revocation. The word **incompatible** here means a structural failure to satisfy strict admission or a required launcher/attachment prerequisite, not an advisory game-version warning.

The existing path-to-process TOCTOU window is not claimed eliminated by this design. The new store ensures fresh admission immediately before handing the capability to existing Stage C/D consumers; it neither weakens nor overstates the Windows-native object-to-process binding guarantees already provided by those consumers. A controlled characterization test must document this residual window.

## 9. State and lifecycle boundaries

Registration state is independent from Game lifecycle state:

| Registration | Game lifecycle implication |
| --- | --- |
| `unregistered` | The product may offer setup; no launch entitlement. |
| `ready` | A private candidate can be fresh-admitted in a later coordinator attempt; no process or attachment exists. |
| `busy` | A private register/consume/replace attempt holds the exact lock or active attempt fence. It is observational only; no browser-controlled retry token or claim exists. |
| `invalid` | The candidate must not be used; product requires new picker registration. |
| `unavailable` | A stale/crashed attempt fence lacks verified bootstrap-owner containment recovery; no new registration use or launch may occur. |

A product process must not project a registered locator as `prerequisites: met` until the existing coordinator's own truthful prerequisites/launch-readiness authority says so.

## 10. Deterministic acceptance matrix

Implementation must add focused tests for all of the following before any live mutation:

1. **Schema/capability:** serialize/clone a real admitted capability and prove the clone cannot pass recheck/consume; strict record parsing rejects unknown keys, capability-shaped fields, bridge/token/profile/PID/generation/identity-chain fields, duplicates, prototypes and oversize data.
2. **User-selection-to-register:** a native-picker selection or explicitly confirmed discovered candidate is strictly admitted before write; cancellation preserves existing ready record; admission/persistence failure publishes no ready state; returned completion/state/error/log captures contain no sentinel locator or derived executable.
3. **Binding:** changing canonical runtime root, any principal member or authority generation yields unregistered/invalid without admission/spawn. Changing only bootstrap operation ID does not invalidate an otherwise matching registration.
4. **Fresh admission/revocation:** each consume calls strict admission anew; replacing any chain identity, reparse status, volume/object type, or SMAPI leaf after registration prevents callback/spawn. No discovery fallback is called.
5. **Lease/concurrency:** a real two-process fixture proves that process A holding an active registration lease/fence for revision `R` prevents process B from reaching fresh admission, its callback, bootstrap reservation, or spawn seam; B receives only redacted busy/unavailable. Concurrent register/consume/replace/revoke attempts yield one deterministic winner. Replacement/revoke is rejected while the exact lease/fence is active. Close before Stage C clears its fence and releases the lease without launch.
6. **Crash containment:** a process-A crash leaves a durable active fence even after the generic Windows stale-lock reclaimer can reclaim the dead lock file. Process B remains unavailable and performs zero fresh admission/callback/spawn unless a bootstrap-owner-aware recovery authority has verified and durably recorded containment/quarantine of A's exact potential owned effects. Elapsed time alone never reopens it.
7. **Topology:** static/import tests prove Preview, Portfolio, operator config/selection, operational runner, run manifest and browser DTO code cannot import the private core/storage. Design 104 discovery imports only the private registration interface supplied by product composition, never storage. A registration never discovers/launches/attaches/materializes on its own.
8. **TOCTOU characterization:** a controllable inspector/spawn seam records behavior if the leaf/root changes after final admission and before spawn. The test documents the residual limit and forbids claims of complete post-check replacement immunity.

## 11. Migration order

1. Implement the dedicated bootstrap-owner-aware crash containment/recovery predecessor defined by Design 102. Until that predecessor is independently verified, no registration store or consume implementation is authorized.
2. Implement a private registration core and durable runtime-root-contained store with direct deterministic tests, including fence persistence/parse and recovery integration. It is not yet wired to browser or operational gate.
3. Wire the existing Host-native picker callback to the store, preserving its no-path browser contract and cancellation behavior. Add redacted readiness projection only; Design 104 discovery remains a later independent producer over the same registration interface.
4. Integrate the coordinator-private consume callback so an existing product process holds the exact registration lock/fence from final fresh admission through the coordinator's reverse teardown/quarantine, without a browser path round trip. Preserve existing setup/launch/attach idempotency and close behavior.
5. Independently review authority flow, redaction, cross-process recovery/locking, registration-to-coordinator exact-once consumption, topology boundaries, and the Design 102 guardian-lease recovery race.
6. Declare **Design 101 registration closure** only when Design 102 verified closure, all registration tasks, current artifact verification, and both authority/recovery and topology reviews are present with no unresolved fence/quarantine.
7. Design 100 exclusively owns the successor private headless coordinator activation / Task 10 operational-gate migration; it may begin only after this registration closure.
8. Only after Design 100 static gates and an independent review pass may the one Task 11 target-version live mutation be authorized.

## 12. Explicit exclusions

- No Task 11 live run, Player Host/AI spawn, save mutation, or operational runner change in this design's first implementation slice.
- No browser `game.launch`, `game.attach`, `game.reconnect`, diagnostics, Preview, Portfolio, or Tavern change.
- No serialized/adopted `AdmittedStardewInstallation`, raw bridge/operator config, discovery implementation inside registration, compatibility migration, or generic lifecycle abstraction.
