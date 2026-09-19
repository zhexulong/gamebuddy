---
id: ARCH-STARDEW-ACTION-DEVELOPMENT-T1-INTERFACE-FREEZE
type: architecture
status: draft
owner: stardew-integration
---

# Stardew Action Development T1 interface freeze

## Status and reading boundary

**PROPOSED — T1 freeze:** This card freezes the interface that T2/T3 may implement only after interface review acceptance. It does not claim a live-ready route, fixture API, production preflight, Guardian fact, installation registration fact, or release result.

**CLOSED — recovery composition blocker:** The accepted production materializer `host/src/continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.ts:createHostGameRuntimeMaterializer().materializeEnter()` now opens the stable-scope journal, constructs the journal-backed runtime coordinator through a fresh binding, awaits exact receipt recovery before ordinary ingress activation, and includes journal close in the awaited runtime close path. This closes only the recovery-composition blocker. **T2 remains blocked on its next work: the fixture port is still unimplemented**; it must not invent a second recovery owner, guessed runner, or fixture API.

**VERIFIED — governing owners:** [ADR 006](../adr/006-stardew-action-development-control-live-owner.md), [release model](release-model.md), [Stardew integration](../domains/stardew/integration.md), and the [active convergence plan](../tasks/active/stardew-action-development-platform-convergence.md) govern this card. This card records their T1 code-facing facts without replacing their product decisions.

**VERIFIED — terminology:** `VERIFIED` means the cited current source or Host scout trace established the fact. `PROPOSED` means this is the approved T1 shape, unavailable until implementation. `MISSING-BLOCKER` means an essential existing seam was not found; no implementation inference is permitted.

## Accepted recovery-composition trace

**CLOSED — accepted production composition:** `host/src/continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.ts:createHostGameRuntimeMaterializer().materializeEnter()` is the concrete production materializer entrypoint. It calls `StardewLogicalActionRecoveryJournal.open(...)` at lines 73–84 with its stable binding identity, supplies that journal/binding/fresh exact-receipt port to `createMaterializedGameRuntime(...)` at lines 89–107, and awaits `runtime.recoverStardewExecutionReceipts(...)` at lines 113–117 **before** it creates the `CompanionLoop` or makes ingress activatable (lines 119–124 and 197–205). Its returned materialization object supplies `closeRecoveryJournal: () => recoveryJournal.close()` at line 221; the materialized runtime's close path awaits that close hook.

**Acceptance evidence:**

- `host/src/continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.test.ts` — `retains a durable uncertain action journal across materializer close without resending a missing execute response` (lines 463–579) proves journal reopen, a fresh coordinator/binding recovery query, no action resend, and awaited closes.
- `host/src/stardew-logical-action-recovery-journal.test.ts` — `stable scope reopens across Host lifecycles while retaining historical owners and epochs` (lines 30–47).
- `host/src/stardew-execution-recovery-supervisor.test.ts` — exact-tuple fresh-binding admission/no-retry coverage (starting line 77).
- Accepted implementation validation: `pnpm --dir host run typecheck`, `pnpm --dir host test`, and aggregate independent review all passed for this recovery composition.

These paths are the traceable acceptance links for the closed recovery blocker. They do **not** implement or expose a fixture port; `host/src/stardew-action-development-fixture-port.internal.ts` remains absent and is the next T2 work.

## Verified Host composition trace

| Status | Source symbol | Direct caller(s) / role | Finding |
|---|---|---|---|
| **VERIFIED** | `host/src/runtime.ts:createCompanionRuntime` | Host runtime construction; calls `createRuntimeDispatchController(integration)` at lines 848–852 when an integration exists | This is the current runtime composition point. |
| **VERIFIED** | `host/src/runtime.ts:createRuntimeDispatchController` | `createCompanionRuntime`; directly calls `createActionExecutionCoordinator(connection)` at lines 336–340 | It constructs a lifecycle-local coordinator without a journal option. |
| **VERIFIED** | `host/src/action-execution-coordinator.internal.ts:createActionExecutionCoordinator` | `createRuntimeDispatchController`; tests also construct it directly | It provides `createAdmission`, `receiveReceipt`, correlation-ledger handling, and optional journal rehydration only when a caller supplies `options.recoveryJournal`. |
| **VERIFIED** | coordinator `createAdmission` and its `observer.beforeWrite` | `host/src/game-tools.ts:executeBridge` at lines 1202–1224 | The integration path creates admission, builds dispatch, awaits `beforeWrite`, invokes `integration.execute(request)`, binds the receipt, and marks uncertainty on exceptions. |
| **VERIFIED** | coordinator `receiveReceipt` | `host/src/runtime.ts:bindIntegrationReceipt` closure at lines 1227–1228; recovery supervisor | It routes receipt facts through replay and correlation-ledger checks before binding. |
| **VERIFIED** | `host/src/stardew-execution-recovery-supervisor.ts:StardewExecutionRecoverySupervisor` | private closure in `createCompanionRuntime`; its public closure is `recoverStardewExecutionReceipts` | It queries only the original `{ requestId, idempotencyKey }`, verifies returned identity, then calls `coordinator.receiveReceipt`; it does not retry an action. |
| **VERIFIED** | `host/src/local-stardew-bridge.ts` exact receipt-query implementation | attached as `receiptRecovery` by `host/src/stardew-integration-launcher.ts` at lines 255–263 | The fresh binding supplies a narrow receipt-recovery capability. |
| **VERIFIED** | `host/src/stardew-logical-action-recovery-journal.ts:StardewLogicalActionRecoveryJournal.open` | `createHostGameRuntimeMaterializer().materializeEnter()`; `host/src/stardew-logical-action-recovery-journal.test.ts` | It durably creates/reopens the materializer's stable scope. |
| **VERIFIED** | `host/src/stardew-production-lifecycle-coordinator.internal.ts:createStardewProductionLifecycleCoordinator` | `host/src/dialogue-web-main.ts:main` at lines 107–109 | It owns production lifecycle materialization but does not compose the action coordinator or recovery journal. |
| **VERIFIED** | `host/src/farmhand-companion-preview.ts:relaunchFarmhandCompanionPreview` → private `relaunchPreview` | production preview relaunch caller; CLI starts only initial preview | This is a preview-specific fresh-binding recovery sequence. It recovers predecessor runtime before successor preview composition and is not a forced-exit Host control-runner successor. |
| **VERIFIED** | `host/src/dialogue-web-main.ts` signal shutdown path | `main`; waits for `SIGINT`/`SIGTERM` and closes the lifecycle coordinator | No crash/forced-exit-to-fresh-Host recovery activation is present. |

**CLOSED — required successor:** `createHostGameRuntimeMaterializer().materializeEnter()` now performs the required production composition: reopen the same stable-scope journal → fresh authenticated Host binding with a journal-backed coordinator → `StardewExecutionRecoverySupervisor` exact receipt query → only then ordinary ingress/admission. The preview relaunch is no longer the sole recovery sequence and remains preview-specific.

**VERIFIED — accepted order:** The materializer uses the existing order: open stable-scope journal → fresh authenticated binding → create `ActionExecutionCoordinator` with that journal → construct/use `StardewExecutionRecoverySupervisor` → recover exact receipts → only then admit ordinary control work. The only live action path remains `createAdmission`/`beforeWrite` → existing `integration.execute` → `receiveReceipt`/correlation ledger.

## Devkit control-child helper freeze

**VERIFIED — reusable base:** `packages/game-action-devkit/src/process-supervisor.mjs:runBoundedChild` is exported through `packages/game-action-devkit/src/index.mjs` and `@gamebuddy/game-action-devkit`. Its existing public constants are `DEFAULT_SUITE_TIMEOUT_MS = 15 * 60_000` and `CLEANUP_TIMEOUT_MS = 5_000`; `runBoundedChild` uses `CLEANUP_TIMEOUT_MS` as its default `cleanupTimeoutMs`. `packages/game-action-devkit/tests/process-supervisor.test.mjs` is the direct test location.

**VERIFIED — relevant existing behavior:** `runBoundedChild` owns spawn, stdout/stderr capture, timeout, bounded cleanup, tree termination, and child close merging. Its implementation-private `MAX_CAPTURE_BYTES` is `64 * 1024`; it combines public output after separately capturing streams. It does not implement the required one-line control protocol, stdin start write, caller cancellation/close, or terminal-result parsing.

**PROPOSED — selected helper:** Add a Devkit-owned generic helper adjacent to `runBoundedChild` in `packages/game-action-devkit/src/process-supervisor.mjs`, export it through `src/index.mjs`, and test it in `tests/process-supervisor.test.mjs`. The helper alone spawns the Host control child and owns all child stdin/stdout/stderr handling. It reuses `CLEANUP_TIMEOUT_MS` for its five-second drain/termination budget and the existing bounded-capture approach for separately bounded stderr diagnostics. No concrete incident justifies changing either existing constant.

**MISSING-BLOCKER — current caller:** No existing generic one-shot helper, Host control-child runner, or thin `stardew-production-adapter.mjs` direct caller exists. The Devkit helper and pure Stardew data protocol may proceed in T3 after their freeze is accepted, but the proposed Host-dependent adapter caller cannot be implemented until the remaining T2 fixture port and Host-runner work is accepted.

**PROPOSED — profile rule:** A generic Devkit profile is optional. Each adapter validates independently whether its own Platform concerns require one; the Stardew adapter may select one only when that validation succeeds. The start/result protocol and new Host route contain no `profile` field and do not require a profile. Existing native-local profile paths are not transferable to the new route.

## Frozen data protocol

**PROPOSED — wire types:**

```ts
type ControlRunStart = Readonly<{
  protocolVersion: 1;
  runId: string;             // opaque UTF-8, 1..128 bytes
  correlationId: string;     // Platform correlation only, opaque UTF-8, 1..128 bytes
  scenarioId: "equip_tool_control";
  deadlineEpochMs: number;   // finite integer > 0; external deadline intent
  cancellationId: string;    // opaque UTF-8, 1..128 bytes; cancellation correlation only
}>;

type ControlRunProof = Readonly<{
  issuer: "host_control_runner";
  binding: Readonly<{
    runId: string;
    correlationId: string;
    requestId: string;       // Host-minted only
    executionId: string;     // Host-minted only
    actionId: "equip_tool"; // Host-selected only
  }>;
  data: Readonly<Record<string, unknown>>; // bounded JSON data only
}>;

type ControlRunResult = Readonly<{
  protocolVersion: 1;
  runId: string;
  correlationId: string;
  terminalCode:
    | "succeeded" | "blocked" | "cancelled" | "deadline_exceeded"
    | "protocol_error" | "child_exit" | "supervisor_closed" | "recovery_incomplete";
  actionOutcome: "succeeded" | "failed" | "not_started" | "indeterminate";
  harnessOutcome: "succeeded" | "failed" | "cancelled" | "not_started";
  cleanupOutcome: "succeeded" | "failed" | "not_started";
  proof: ControlRunProof;                  // bounded data-only proof; generic layer does not interpret it
  cleanupFacts: Readonly<Record<string, unknown>>; // bounded data-only cleanup facts
}>;
```

**PROPOSED — framing and failure rules:** The helper writes exactly one UTF-8 JSON start line of at most 32,768 bytes to stdin and accepts exactly one UTF-8 JSON terminal-result line whose **total encoded line** is at most 32,768 bytes from stdout. `proof.data` and `cleanupFacts` are JSON data only; the generic helper validates only framing, bounds, result identity, and structural data shape. It never interprets proof or cleanup meaning; the action-owned verifier consumes them. stderr is diagnostic-only and separately bounded. EOF before the required message, malformed JSON, duplicate keys or messages, oversize input, unknown version, deadline expiry, cancellation, child exit before result, and supervisor close fail closed and never produce action success.

**PROPOSED — cancellation, drain, and forced exit:** Cancellation is supplied only through the Devkit helper's `AbortSignal` and out-of-band bounded termination. The helper never writes a second stdin frame; `cancellationId` is start-frame correlation only and is not a child cancellation command. On abort, deadline, or close, the helper stops acceptance, drains for no more than `CLEANUP_TIMEOUT_MS` (5,000 ms), then terminates an unexited child and merges child exit with any terminal result. A forced exit following a potential write returns `terminalCode: "recovery_incomplete"` and `actionOutcome: "indeterminate"`; the adapter does not recover, retry, replay, create a second action, or mint a new live identity.

**PROPOSED — non-transferable fields:** Start data never carries `requestId`, `idempotencyKey`, execution identity, live/admitted revision, receipt identity, recovery identity, bridge token, session, process handle, pipe, PID, path, generation, journal, fixture capability, action envelope authority, or run port. The Host runner may emit only its Host-minted `requestId`, `executionId`, and selected `actionId` inside the bounded proof binding; these do not grant authority and are interpreted only by the action-owned verifier. `correlationId` is only Platform correlation; it is neither receipt nor recovery identity.

## Host-only identity, port, and outcomes

**PROPOSED — Host authority:** After authenticated attachment and a live-snapshot revision read, the Host runner alone derives/mints `requestId`, `idempotencyKey`, and `executionId`, persists the journal tuple before dispatch, and creates the coordinator-local run port. `scenarioId: "equip_tool_control"` causes Host fixture preparation to derive the typed action arguments and slot later; child start data cannot select, supply, or override those values or any Host identity.

**PROPOSED — port lifetime:** The private run port is minted for one admitted run in the coordinator process, dispatches at most once, and closes after terminal action processing and teardown. It rejects expired scope, cancellation, live-revision mismatch, deadline expiry, close, and replay. It is neither serializable nor proxyable and is unavailable to Devkit, Platform, adapter, browser, fixture service, and child process.

**PROPOSED — outcome separation:** `actionOutcome`, `harnessOutcome`, and `cleanupOutcome` remain bounded and independent. Harness or cleanup success cannot establish action success. Only the same logical action's succeeded receipt, non-empty evidence, fresh action-specific postcondition, and accepted cleanup can support the control-live acceptance defined by the release model.

## Fixture boundary and phase order

**MISSING-BLOCKER — fixture API:** No `host/src/stardew-action-development-fixture-port.internal.ts` exists and no fixture `prepare`/`restore` production API has been verified. No fixture capability, handle, `selectedSlot`, or fixture fact is currently available or implied by this card.

**PROPOSED — future narrow boundary:** If T2 separately implements and reviews a fixture boundary, only `StardewProductionLifecycleCoordinator`/Host process may invoke its `prepare` and `restore` or internally receive its port, handle, `selectedSlot`, and fixture facts. Its request/result types must carry prerequisite state only; they must reject process launch, bridge material, action envelope, receipt, evidence-publication, journal, and recovery authority. Platform and every other non-coordinator role receive neither the port, handle, `selectedSlot`, nor any fixture fact.

**PROPOSED — fixed phase order:** external factual preflight → offline/disposable save prerequisite prepare before game/process/bridge → coordinator launch and authenticated attachment → one admitted action → Host runtime/bridge teardown plus containment → fixture restore → cleanup outcome. A failure still follows permitted fail-closed drain, restore, and cleanup stages; cleanup failure does not erase an existing action fact.

## Candidate native-local cutover inventory

**VERIFIED — scope:** The following entries are discovered candidate/native-local participants. The inventory is not cutover authorization; T4 must validate every listed direct caller and add any then-discovered participant before deletion. Published `equip_tool` authority remains preserved.

| Status | Source path / symbol | Direct caller(s) | Native-local edge | Disposition after accepted T2/T3/T4 | Preserved observable / other-action impact |
|---|---|---|---|---|---|
| **VERIFIED** | `src/action-registry.mjs:REGISTRATIONS.equip_tool.runLive` | `src/project-adapter-core.mjs` resolves and invokes `registration.runLive` | candidate route to `runEquipToolRegistration` | **PROPOSED: replace** with thin adapter/helper only after T2 unblocks | Published action ID, catalog, Host visibility, arguments, receipt semantics, and release status stay unchanged. |
| **VERIFIED** | `src/project-adapter-core.mjs` `run-live` branch | Devkit CLI via `package.json` `action:run-live` | requires `profileFile`; dispatches candidate registration | **PROPOSED: replace/delete only listed native-local requirement** | The new Host route accepts no native-local profile/path. |
| **VERIFIED** | `src/equip-tool-live.mjs:runEquipToolRegistration` | `action-registry.mjs` | consumes ready profile, target lease, and evidence lifecycle | **PROPOSED: delete/replace** | No change to published action behavior; no other action claim is made. |
| **VERIFIED** | `src/equip-tool-lifecycle.mjs` | `equip-tool-live.mjs` lifecycle composition | native-local lifecycle result with `profileIdentity` and claim scope | **PROPOSED: delete/replace** | Historical evidence is read-only and not live proof. |
| **VERIFIED** | `src/stardew-closure-backend.mjs` | native-local lifecycle composition | child/backend, PowerShell route, result files | **PROPOSED: delete/replace** | New route has no native-local path/profile field. |
| **VERIFIED** | `ACTION_RUNBOOK.md` `Live equip_tool gate` | operator command documentation | requires `--profile` and native-local run-live command | **PROPOSED: replace** when route exists | Preserve the release gate, not this obsolete operator topology. |
| **VERIFIED** | `package.json` `action:run-live` | operator/package script | Devkit CLI entry to candidate `run-live` | **PROPOSED: replace/delete** with only the accepted control route | Other package commands require separate manifest review. |
| **VERIFIED** | `portfolio.json` and `src/portfolio.mjs` | portfolio command | lists/executes action scenarios | **PROPOSED: preserve unless a listed `equip_tool` native-local edge is replaced** | Unrelated native-local smoke tooling for other published actions is preserved and out of scope. |
| **VERIFIED** | `contracts/equip_tool.json`, `contracts/projection/action-source-projection.v1.json`, `descriptors/equip_tool.static.json`, `tool-inventory.json` | contract/projection/static verification tests | action contract and source projections | **PROPOSED: preserve** | These protect published `equip_tool` identity and must not be deleted by broad route cleanup. |
| **VERIFIED** | `artifacts/action-runs/stardew/equip_tool/` | status/evidence readers | historical native-local evidence | **PROPOSED: preserve read-only** | It neither becomes production authority nor proves the new live route. |

## Required test cards

**PROPOSED — Devkit tests:** Extend `packages/game-action-devkit/tests/process-supervisor.test.mjs` and run the package's existing test command. Assert one start, separate bounded stdout terminal result/stderr diagnostics, framing/protocol mapping, cancellation and close, reuse of `CLEANUP_TIMEOUT_MS`, bounded drain/termination, and child-exit/result merge.

**PROPOSED — adapter tests:** Add tests beside the future thin adapter in `integrations/stardew/action-development/tests/`. Assert it validates Stardew inputs, independently validates any optional generic profile it elects to use, invokes the Devkit helper, consumes bounded result data only through the action-owned verifier, and cannot spawn a child, read/write control streams, access a port, or receive lifecycle/bridge/fixture/recovery authority.

**MISSING-BLOCKER — fixture and Host-runner implementation:** The recovery-composition tests cited above are accepted, but T2 Host protocol/non-exposure tests and fixture tests cannot be truthfully added until the next T2 fixture port and Host-runner composition work is implemented and reviewed. The existing supervisor remains the recovery query/admission authority; no fixture port exists.

## Review gate

**MISSING-BLOCKER — acceptance condition:** Interface review has accepted the recovery successor composition above. It must still reject Host-dependent T2 work and the Host-dependent T3 adapter until the next T2 fixture port/Host-runner work is implemented and accepted. The review must verify the helper/caller/constants, protocol bounds and negative fields, Host-only identities/revision, port non-exposure, outcome separation, fixture non-claim and order, this inventory, and preservation of unrelated smoke tooling.

**PROPOSED — subsequent status:** With the recovery successor accepted without creating another recovery owner, T2 may begin its fixture-port work; no fixture implementation exists yet. Until the remaining work is accepted, the recorded state is never a fallback live pass.
