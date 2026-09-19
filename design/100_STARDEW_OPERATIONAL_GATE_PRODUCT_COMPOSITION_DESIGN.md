# Stardew Operational Gate Product Composition Design

**Status:** Blocked pending Design 102 crash-containment recovery and Design 101 product-owned installation registration predecessors.

**Owner:** The shipped two-role Stardew product lifecycle. This design extends, but does not reopen, [Design 99](./99_STARDEW_PRODUCT_SESSION_MATERIALIZATION_DESIGN.md).

**Primary references:** `AGENTS.md`, `design/00_CORE_PRODUCT.md`, `design/09_BDD_VALIDATION_PLAN.md`, `design/91_OPEN_GAMEPLAY_PIPELINE_RELEASE_IMPLEMENTATION_PLAN.md`, `design/99_STARDEW_PRODUCT_SESSION_MATERIALIZATION_DESIGN.md`, `design/101_STARDEW_PRODUCT_INSTALLATION_REGISTRATION_DESIGN.md`, `design/102_STARDEW_BOOTSTRAP_CONTAINMENT_RECOVERY_DESIGN.md`, `design/103_WINDOWS_DISTRIBUTION_AND_DESKTOP_PRESENTATION_DESIGN.md`, `design/104_PLAYER_ONBOARDING_AND_SURFACE_JOURNEYS_DESIGN.md`, `host/src/stardew-production-lifecycle-coordinator.internal.ts`, `host/src/main.ts`, and `tools/run-game-operational-gate.mjs`.

## 1. Problem

The production operational Game gate currently launches:

```text
run-game-operational-gate.mjs
  → start-production-artifact.mjs main.js <operator-config>
  → createKnownSemanticGameFacadeFromOperatorConfig()
  → caller-supplied pipeName + bridgeToken
```

That path builds a semantic Game runtime directly from raw caller-selected bridge facts. It bypasses the product-owned `StardewProductionLifecycleCoordinator`, including its private bootstrap owner, Player Host launch/attestation, AI-client launch generation, Farmhand attachment, and Design 99 materializer.

Changing the runner's config shape cannot fix this. Any config that supplies an installation path, bridge pipe/token, launch generation, profile path, manifest, process identity, discovery candidate, or equivalent persistent connection fact creates a second Stardew session authority. Designs 103/104 do not broaden this boundary: the desktop launcher and onboarding shell are presentation/selection consumers, not operational-gate launch roots.

## 2. Decision

The operational gate must become a **harness consumer of the existing product lifecycle**, not a Game launcher:

```text
private product-owned lifecycle prerequisites
  → StardewProductionLifecycleCoordinator
  → private bootstrap / owned Player Host / AI attach
  → Design 99 Farmhand session materializer
  → durable Game enter + committed ingress
  → production-game-task-ingress private IPC
  → operational runner nonce, timeout, terminal-evidence collection
```

The runner retains only its existing harness responsibilities:

- generate and correlate one nonce;
- launch the immutable Host artifact;
- dispatch one natural-language task after child readiness;
- accept only source-owned IPC terminal evidence;
- impose an external harness timeout and contain its direct child process tree.

It never owns or receives Stardew installation, profile, process, bridge, session, capability, credential, prompt, or native-game facts.

## 2.1. Historical clarification

The topology clarification discovered during this design's migration review is now owned by `design/domains/stardew/integration.md`: direct operator attach is transitional rather than a second shipped topology; the private materializer remains coordinator-only; Preview and Portfolio remain isolated; and no fallback or compatibility route is allowed. This numbered document is background only and cannot activate implementation.
## 3. Existing lawful product authority

`StardewProductionLifecycleCoordinator` is the only product lifecycle owner. It already owns:

1. private Player Host reservation and profile staging;
2. exact `AdmittedStardewInstallation` consumption and fresh recheck before Player Host and AI-client spawn;
3. Player Host generation attestation;
4. cabin/manifest handoff and one AI-client bridge connection;
5. the Design 99 private materializer;
6. receipt-backed `runEnter()`, committed ingress, attachment state, STOP, disconnect, quarantine and reverse teardown.

`AdmittedStardewInstallation` is intentionally opaque and process-local. Its only production producer is:

```text
Windows IFileDialog folder picker
  → immediate strict admitStardewInstallation()
  → coordinator-private closure
```

The deployment manifest is intentionally insufficient for this purpose. It contains only the canonical runtime root, principal, bootstrap operation ID and authority generation. It must not absorb installation paths or connection facts.

## 4. Current blocker

A fresh headless production child has no lawful source for an `AdmittedStardewInstallation` capability:

- it cannot call the browser-only activation flow without forging browser admission;
- it cannot serialize or reload a prior capability;
- it cannot receive a raw installation path from the operational runner;
- it cannot reuse Farmhand Preview's fixture profile/session/bridge material;
- it cannot obtain the path from a Steam/GOG discovery guess, registry scrape, VDF parse, or caller-selected operator config.

Therefore a headless entry that invokes the existing coordinator would stall before Player Host launch. Adding a fallback would violate the same single-authority boundary this design exists to preserve.

This is a real architecture prerequisite, not a missing local config file.

## 5. Required predecessor: product-owned installation registration

Before the operational gate can consume the product coordinator in a fresh process, the product needs one separate, explicitly designed installation-registration authority.

It must satisfy all of the following before any implementation is authorized:

1. **Producer:** a user-initiated native folder selection in the shipped Game product, followed immediately by the existing strict admission checks.
2. **Ownership:** registration is Host-owned and bound to the exact deployment/runtime identity; browser callers never receive filesystem paths or a serializable capability.
3. **Persistence:** if registration must survive a process restart, its persistence format and re-admission/recheck semantics must be designed explicitly. It may not serialize `AdmittedStardewInstallation`, copy a path into an operator config, or weaken identity-chain verification.
4. **Use:** the coordinator consumes a fresh, product-owned admission only after a fresh recheck at spawn time. It remains the sole owner of reservation, process lifecycle, attachment and teardown.
5. **Revocation:** invalid, moved, reparse-altered, stale or incompatible installations fail closed and require a new user registration; there is no discovery fallback.
6. **Projection:** browser state may report only redacted prerequisite readiness. It never reports, logs or sends the path, executable, identity chain, inspector output or profile location.
7. **Isolation:** Preview, Portfolio, external operator config, `main.ts` legacy operator selection and operational runner config cannot create, read or consume registration state.

This is not implemented by this design. It changes the established path-lifetime rule and must receive its own boundary design and verification plan first. Design 101 freezes that boundary. Its implementation is itself blocked on Design 102's cross-process bootstrap containment/recovery authority: a generic stale Node-lock reclaimer cannot permit a successor if Player Host or AI Client effects from a crashed attempt might survive.

## 6. Future operational-gate migration, after both predecessors close

Only after Design 102 containment/recovery and the product-owned Design 101 registration predecessor both exist and are independently verified:

1. Add a private, one-shot headless activation operation inside the coordinator. It calls the same private core as browser activation; it does not manufacture a browser admission.
2. The operation consumes the product-owned fresh installation admission, then follows the existing stage → Player Host launch/attestation → manifest handoff → AI attach → Design 99 materialization sequence.
3. `main.ts` operational-gate mode loads a Host deployment manifest and invokes only that private product composition. It does not import `LocalStardewBridgeClient`, the Design 99 materializer, Preview, Portfolio, browser composition or operator selection.
4. `run-game-operational-gate.mjs` removes `gameOperatorConfigPath`. Its config may retain only harness preflight references and the task fixture; the child receives a validated deployment-manifest reference plus the per-run IPC nonce, never raw Stardew facts.
5. Publish readiness only after durable Game enter, STOP attachment and committed ingress activation. Dispatch remains one-time IPC after that barrier.
6. Preserve existing source-owned terminal evidence and reverse teardown. The harness timeout remains external and never becomes a Game task budget.

## 7. Forbidden alternatives

- Keeping `createKnownSemanticGameFacadeFromOperatorConfig()` as an operational-gate fallback.
- Adding `pipeName`, `bridgeToken`, `launchGeneration`, installation path, profile path, PID, native endpoint or equivalent fields to runner/operator configuration.
- Persisting or rehydrating `AdmittedStardewInstallation` as a structural object.
- Treating Preview readiness/manifest/evidence or Portfolio inputs as product registration.
- Driving a browser endpoint, cookie, CSRF token or UI automation to obtain headless activation.
- Creating a second materializer, attach operation, generic dispatcher or universal launcher.

## 8. Acceptance and stop condition

No Task 11 target-live gameplay mutation is authorized by this design while Section 5 is absent.

The current Task 11 preflight must report a fail-closed composition blocker, not `passed`, `ready`, or an inferred lack of a live game session. Task 12 release consolidation remains unavailable.

A successor design may authorize implementation only after Design 102 verifies crash containment/recovery and Design 101 verifies the product-owned installation registration's persistence, exact re-admission/recheck, revocation, state projection, isolation, and coordinator-span lease matrix.
