# Body Program Admission Outcome Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Mod-owned `BodyProgramJournal/v1` 无损持久化 `admission_rejected/<stable code>`、`skipped_dependency` 与 `admission_unavailable` 的区别，并为下游 authenticated admission forwarding 提供可验证的三态 C#/TypeScript projection。

**Architecture:** `OpenBodyProgramJournalAuthority` 继续是 Mod graph/node authority；Host 只产生 Controller 命名的 exact-node restrictive grant/veto，不能推进 graph。确定性 rejection 在 Mod journal 中成为不可逆 terminal fact，带独立的 allowlisted `RejectionCode`；同一 authority transition 将直接或间接依赖该节点、且仍为 `Pending` 的 descendants 变为 `SkippedDependency`。Transport unavailable 只保留 `AwaitingHostAdmission`，不产生 node rejection。Bridge status/event 是 journal 的受限只读 projection，不成为第二套 authority。

**Tech Stack:** C#/.NET 6、现有 `BodyProgramJournalPersistence` strict JSON codec、xUnit/FluentAssertions、TypeScript `node:test`、现有 `BridgeProtocol` 与 `host/src/protocol.ts`。

**Spec:** [`design/adr/006-verified-body-programs.md`](adr/006-verified-body-programs.md)、[`design/tasks/active/open-gameplay-release.md`](tasks/active/open-gameplay-release.md)、[`design/NN_WIRE_ADMISSION_AUTHORITY_IMPLEMENTATION_PLAN.md`](NN_WIRE_ADMISSION_AUTHORITY_IMPLEMENTATION_PLAN.md)。

## Global Constraints

- Mod `BodyProgramJournal/v1` remains the sole authority for accepted graph, node state, facts, STOP epoch, and rejection code; Host journal remains transport evidence only.
- `BodyNodeAdmissionChallenge` identifies the exact `(programId, nodeId, nodeAttempt, admissionAttempt)`; `TryRejectAdmission` must revalidate the complete challenge against the awaiting node before mutation.
- `admission_unavailable` is retryable transport unavailability and leaves the node `AwaitingHostAdmission`; it must never become `Rejected`, `Failed`, `RecoveryRequired`, `null`, or a fabricated grant.
- A deterministic rejection code is ASCII lowercase snake case, `1..64` characters, with no free text, timestamp, stack, control character, colon, or hyphen. The v1 allowlist is exactly `policy_denied`, `deadline_expired`, `resource_conflict`, `catalog_stale`, `schema_rejected`, `scope_mismatch`, `stop_epoch_closed`, and `policy_identity_mismatch`.
- `Rejected` carries an independent `RejectionCode` and no recovery diagnostic, proof, grant, or execution binding. It retains the exact challenged attempt metadata so status/replay can identify the vetoed attempt.
- `SkippedDependency` is terminal and carries zero `NodeAttempt`/`AdmissionAttempt` plus no canonical attempt material, grant, binding, proof, diagnostic, or rejection code.
- A rejected node and all of its direct/transitive descendants that are still `Pending` are committed atomically in one complete journal replacement. Independent nodes remain eligible.
- A program remains `Active` while executable work remains. When every node is terminal, any `Rejected` or `Failed` node makes the program `Failed`; all-success remains `Succeeded`. `RecoveryRequired` and `Cancelled` keep their existing precedence and meaning.
- Reopen preserves `Rejected` and `SkippedDependency`; restart fencing applies only to non-terminal execution states. A rejected/skipped terminal fact is never converted to `RecoveryRequired`.
- Repeated delivery of the exact same rejected challenge and the same code is idempotent. An old, mismatched, malformed, or differently coded challenge fails closed and never mutates the journal.
- Existing journal v1 exact-key decoding remains fail-closed. No legacy aliases, migration, fallback, adoption, compatibility wrapper, or second validator is added. The durable enum representation remains numeric; external bridge projections use snake_case tokens and must not silently redefine the durable codec.
- The addressed event shape remains `{ cursor, programId, kind, catalogRevision, nodeId, nodeAttempt }`. A `node_skipped` event uses `nodeAttempt: 0` for a never-attempted node; validation permits zero only for that event kind and only when its addressed node is `SkippedDependency`.
- No changes to `GameConnection`, `GameplayTaskSubagent`, ordinary execution, Navigation, `equip_tool`, native action handlers, live mutation, Host Anchor composition, `LocalStardewBridgeClient`, `BridgeSession` forwarding, or `ModEntry` dispatch occur before the durable contract task closes.
- The checkout is dirty no-commit WIP. Writers may edit only the owned paths listed in their task and must not reset, restore, clean, stash, format, or overwrite unrelated changes.

---

### Task 0: Ratify the current-owner amendment and dependency edge

**Files:**
- Modify: `design/adr/006-verified-body-programs.md` in the durable authority, node-start admission, and program-message sections.
- Modify: `design/tasks/active/open-gameplay-release.md` in the BodyProgram journal/controller prerequisites and Task 1 admission contract.
- Modify: `design/NN_WIRE_ADMISSION_AUTHORITY_IMPLEMENTATION_PLAN.md` only to link this plan as a prerequisite for forwarding; do not duplicate the outcome model.

**Produces:**
- A current-owner amendment naming `RejectionCode`, `SkippedDependency`, terminal program convergence, restart/replay behavior, and the three-state transport outcome.
- A dependency edge stating that durable outcome closure and its focused evidence must pass before bridge forwarding resumes.

- [x] Add the following rules to ADR-006 without changing the existing Host/Mod authority boundary:

```text
Rejected requires an allowlisted RejectionCode and forbids RecoveryDiagnostic,
receipt/evidence/postcondition proof, GrantId, and ExecutionBinding.
SkippedDependency is a terminal node state with NodeAttempt = 0 and
AdmissionAttempt = 0 and no execution/admission material.
A rejection cascades only to direct/transitive descendants currently Pending;
independent ready nodes remain eligible.
A program remains Active while executable work remains. Once every node is
terminal, Rejected or Failed yields program Failed and all-success yields
Succeeded. RecoveryRequired and Cancelled retain their existing precedence.
Reopen preserves Rejected and SkippedDependency; restart fencing applies only
to non-terminal execution states.
An exact repeated rejection with the same code is idempotent. An old,
mismatched, malformed, or differently coded challenge is fail-closed and
cannot mutate the journal.
Unavailable leaves AwaitingHostAdmission and is not a gameplay failure.
```

- [x] Document `BodyProgramNodeState.SkippedDependency` as numeric durable enum value `10` and external token `"skipped_dependency"`; document `node_skipped` with `nodeAttempt: 0` as the addressed event projection.
- [x] Link `NN_BODY_PROGRAM_ADMISSION_OUTCOME_IMPLEMENTATION_PLAN.md` from the wire plan's forwarding task and state that `body_node_admission_result` forwarding is blocked until Task 3 evidence is complete.
- [x] Run `npm run check` and inspect the three changed documents for current-owner links, no duplicate wire authority, and no stale “TryTakeGrant-only” wording.

### Task 1: Extend the Core durable model and strict journal codec

**Files:**
- Modify: `integrations/stardew/src/Core/BodyPrograms/BodyProgramModels.cs`
- Modify: `integrations/stardew/src/Core/BodyPrograms/BodyProgramJournalPersistence.cs`
- Modify: `integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/BodyProgramAuthorityTests.cs`

**Consumes:** The exact shapes frozen by Task 0.

**Produces:** A strict `BodyProgramJournal/v1` codec that can encode/decode and validate rejection/skipped terminal facts without using recovery diagnostics.

- [x] Write failing tests before implementation. Add these assertions to the existing Core authority test fixture using its `MemoryStore` and catalog helpers:

```csharp
[Fact]
public void RejectedNodeRoundTripsAnAllowlistedCodeWithoutRecoveryDiagnostic()
{
    // Submit, create the exact challenge, reject it, reopen from MemoryStore.
    // Assert state == Rejected, RejectionCode == "policy_denied",
    // RecoveryDiagnostic == null, GrantId == null, ExecutionBinding == null,
    // and the reopened node is unchanged.
}

[Fact]
public void RejectedNodeWithRecoveryDiagnosticOrInvalidCodeIsRejectedByTheCodec()
{
    // Mutate a valid encoded rejected node to add recoveryDiagnostic or to use
    // "free text"/"Policy_Denied"/"policy-denied" and assert TryDecode == false.
}

[Fact]
public void SkippedDependencyRoundTripsWithZeroAttemptsAndNoAttemptMaterial()
{
    // Build a valid graph containing a skipped descendant, encode/decode it,
    // and assert both attempts are zero and all admission/execution/proof/
    // diagnostic/rejection fields are null.
}

[Fact]
public void NodeSkippedEventUsesZeroAttemptOnlyForSkippedDependency()
{
    // Assert a node_skipped event with nodeAttempt 0 validates, while a
    // native_dispatch event with nodeAttempt 0 and a node_skipped event with
    // nodeAttempt 1 both fail closed.
}
```

- [x] Run only the Core test project and record the expected failures caused by the missing field, enum value, validation branch, and event rule:

```bash
dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/GameBuddy.Stardew.Core.Tests.csproj --no-restore
```

- [x] Add `SkippedDependency = 10` to `BodyProgramNodeState` and append `string? RejectionCode = null` to `BodyProgramJournalNode` so existing positional construction sites remain explicit and nullable fields remain exact-key serialized.
- [x] Add an internal `BodyProgramValidation.IsValidRejectionCode(string?)` that accepts only the eight allowlisted literals. Do not broaden or reuse `IsIdentifier`; rejection codes are a narrower contract.
- [x] Update `FreezeProgram`, `ReadNode`, and `Exact` node keys to preserve `RejectionCode` through complete replacement and strict decode. A missing field, extra field, wrong JSON type, invalid code, or invalid state/field combination must fail closed.
- [x] Update `ValidateNode` with these mutually exclusive branches:

```csharp
if (node.State == BodyProgramNodeState.Rejected)
    return hasAttempt
        && node.RejectionCode is not null
        && BodyProgramValidation.IsValidRejectionCode(node.RejectionCode)
        && node.RecoveryDiagnostic is null
        && !hasProof
        && node.GrantId is null
        && node.ExecutionBinding is null;

if (node.State == BodyProgramNodeState.SkippedDependency)
    return node.NodeAttempt == 0
        && node.AdmissionAttempt == 0
        && node.GrantId is null
        && node.ExecutionBinding is null
        && node.CanonicalBoundArguments is null
        && node.AttemptPolicyIdentity is null
        && node.ClaimOwnership is null
        && !hasProof
        && node.RecoveryDiagnostic is null
        && node.RejectionCode is null;
```

  Every non-rejected node must have `RejectionCode == null`; `Rejected` must never carry recovery diagnostic/proof; the zero-attempt common branch must also reject `RejectionCode` on all other states.
- [x] Permit `nodeAttempt == 0` only for `node_skipped` events addressed to a `SkippedDependency` node; retain `nodeAttempt >= 1` for all other node events. Validate the event kind and addressed node together, not by a free-standing numeric exception.
- [x] Update program validation so `Active` permits rejected/skipped terminal nodes while executable independent work exists, `Failed` represents a fully terminal graph containing `Rejected` or `Failed`, `RecoveryRequired`/`Quarantined` allow skipped terminal nodes, and `Succeeded` still requires every node to be `Succeeded`.
- [x] Run the focused Core tests and the production Core build; expected failures at this point may only identify authority/controller code that still constructs rejected/skipped states incorrectly, not unrelated repository WIP.

### Task 2: Implement exact rejection authority and dependency cascade

**Files:**
- Modify: `integrations/stardew/src/Core/BodyPrograms/OpenBodyProgramJournalAuthority.cs`
- Modify: `integrations/stardew/src/Core/BodyPrograms/FarmhandBodyProgramController.cs`
- Modify: `integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/BodyProgramAuthorityTests.cs`
- Modify: `integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/BodyProgramControllerPumpTests.cs`

**Consumes:** The strict model/codec from Task 1.

**Produces:** A single Mod-owned `TryRejectAdmission` transition and a lossless controller pump: grant → execution, rejected → durable rejection/cascade, unavailable → awaiting.

- [x] Add failing authority tests for the producer→consumer→verifier chain:

```csharp
[Fact]
public void ExactRejectionPersistsCodeCascadesPendingDescendantsAndLeavesIndependentNodeEligible()
{
    // Submit a graph with source -> rejected descendant -> grandchild and an
    // independent source. Reject the exact awaiting challenge. Assert one
    // committed replacement contains Rejected + RejectionCode, both dependent
    // nodes are SkippedDependency, independent source is still Pending, events
    // contain admission_rejected and node_skipped entries, and no descendant
    // challenge was sent.
}

[Fact]
public void OldOrMismatchedRejectionDoesNotMutateTheJournal()
{
    // Alter programId/nodeId/attempt/admissionAttempt/stopEpoch/policy/args,
    // or use a different stable code. Assert a failure result, unchanged
    // encoded state, and unchanged event high-water.
}

[Fact]
public void RepeatingTheExactRejectedChallengeAndCodeIsIdempotent()
{
    // Reject once, call TryRejectAdmission with the same challenge/code again,
    // and assert success with no second write or event.
}

[Fact]
public void UnavailableKeepsTheNodeAwaitingAndDoesNotFailTheProgram()
{
    // Pump a BodyNodeAdmissionUnavailableResult and assert the node remains
    // AwaitingHostAdmission, the program remains Active, and no rejection or
    // failure event is written.
}

[Fact]
public void ReopenPreservesRejectedAndSkippedDependencyWithoutRestartFence()
{
    // Reject a graph, reopen from the durable store, and assert both terminal
    // states/code survive and no recovery_required rewrite is written.
}
```

- [x] Run the focused Core tests to see the expected failures from the absent authority method and missing cascade/convergence behavior.
- [x] Implement the public/internal signature used by the controller:

```csharp
public BodyProgramControllerResult<NodeAdmissionChallenge> TryRejectAdmission(
    NodeAdmissionChallenge challenge,
    string code)
```

  Validate the allowlist, locate the same program/node, and compare the complete challenge tuple plus policy, action, canonical arguments, claims, and deadline. Only `AwaitingHostAdmission` can mutate. If the node is already `Rejected`, return success only for the same exact challenge and the same persisted code; otherwise fail closed without writing.
- [x] On a first rejection, replace the challenged node with `State = Rejected`, `RejectionCode = code`, `GrantId = null`, `ExecutionBinding = null`, `RecoveryDiagnostic = null`, and no proof. Traverse the verified graph's dependency edges and replace only `Pending` direct/transitive descendants with zero-attempt `SkippedDependency` nodes. Do not touch independent nodes, already-terminal nodes, or nodes in another program.
- [x] Add one atomic `AppendEvents`/complete-state replacement path that records the rejection event and one `node_skipped` event per cascaded node using deterministic node-id order. The in-memory state changes only after `TryWrite` succeeds.
- [x] Recompute program state with a helper used by rejection and completion paths: preserve `RecoveryRequired`/`Cancelled` when those transitions already own the program; keep `Active` while any executable node remains; when all nodes are terminal, choose `Failed` if any node is `Rejected` or `Failed`, otherwise `Succeeded` only if all are `Succeeded`.
- [x] Add `SkippedDependency` to `IsTerminal` and `RestartFence`; preserve rejected/skipped nodes unchanged while fencing only non-terminal execution states. Include skipped nodes in `RecoveryRequired` and `Quarantined` validation sets.
- [x] Keep `BodyNodeAdmissionUnavailableResult` as a no-op at the node authority: the pump must not call rejection, failure, recovery, or grant consumption for it. Keep the four Agent-facing Body Program methods unchanged.
- [x] Run focused Core tests after each seam, then the combined Core project:

```bash
dotnet test integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/GameBuddy.Stardew.Core.Tests.csproj --no-restore
```

### Task 3: Fresh artifact validation and independent review of durable outcome closure

**Files:**
- No new production files.
- Review the exact Task 1–2 diff in the listed Core files and tests only.

**Consumes:** The complete Task 1–2 evidence.

**Produces:** A fresh compiled artifact and a reviewer verdict that can either close the durable prerequisite or name a new blocker.

- [x] Run production Core strict build/typecheck from the current checkout and capture the exact command and exit code:

```bash
dotnet build integrations/stardew/src/Core/GameBuddy.Stardew.Core.csproj --no-restore --configuration Release
```

- [x] Run the complete focused Core suite, including tests that exercise the pre-existing dynamic Body Program baseline; no stale binary or previous test output counts.
- [x] Run `git diff --check`, an admission-owned `git diff --stat`, and a no-staged-files check without touching unrelated WIP.
- [x] Ask one fresh read-only reviewer to inspect the actual post-write diff and evidence for: exact challenge CAS, allowlisted code, rejected/skipped durable shape, event zero-attempt rule, atomic write ordering, independent-node eligibility, reopen/replay idempotence, unavailable semantics, and no bridge/native/public-surface drift.
- [x] If any review or build check fails, record the observed fact and create one narrower successor; do not map the failure to `RecoveryRequired`, discard the worktree, or start bridge mutation.

### Task 4: Resume authenticated admission forwarding only after Task 3 closes

**Depends on:** Task 3 has fresh build/test evidence and a no-blocker review.

**Files:** The existing files listed by `design/NN_WIRE_ADMISSION_AUTHORITY_IMPLEMENTATION_PLAN.md` Task 2 only, after a new connection-private slice card is written.

**Produces:** Host/C#/Mod three-state forwarding that preserves `granted`, `rejected`, and `unavailable` without becoming a second program authority.

- [x] Re-read the current owner seam and write a new slice card naming the exact `LocalStardewBridgeClient` callback, `BridgeSession`/`ModEntry` queue, generation/close fence, and Controller consumer. Do not reuse the timed-out partial as an authority decision.
- [x] Extend the existing `body_node_admission_result` wire union with independent `granted`, `rejected`, and `unavailable` discriminators. Rejection carries the exact challenge identity plus allowlisted code; unavailable carries the exact challenge identity plus its stable transport code. Do not map unavailable to rejection or nullable grant.
- [x] Add C#/TypeScript round-trip tests and exact correlation/generation tests before production forwarding edits. No `GameConnection`, `GameplayTaskSubagent`, ordinary execution route, Host graph/fact authority, or native executor changes are permitted.
- [x] Run the focused Host/C# bridge tests, production typechecks/builds, and `git diff --check`, then obtain one fresh review before considering the next native adapter task.

## Self-Review Checklist

- [x] Every amendment rule has an implementation/test task: code allowlist (Task 1), isolated rejected field (Task 1), skipped state/event (Task 1), cascade/convergence (Task 2), reopen/replay (Tasks 2–3), and three-state wire dependency (Task 4).
- [x] No task asks a writer to modify a file outside its owned list, and no task permits reset/restore/clean/stash or compatibility layers.
- [x] All cross-task names are consistent: `BodyProgramNodeState.SkippedDependency`, `BodyProgramJournalNode.RejectionCode`, `BodyProgramValidation.IsValidRejectionCode`, `OpenBodyProgramJournalAuthority.TryRejectAdmission(NodeAdmissionChallenge, string)`, `BodyNodeAdmissionUnavailableResult`, and `node_skipped`.
- [x] The plan never treats a passing offline Core suite as a live/native gate; Task 4 remains forwarding-only and native/live work remains downstream of the current Body Program action boundary.

## Execution Handoff

Plan complete and saved to `design/NN_BODY_PROGRAM_ADMISSION_OUTCOME_IMPLEMENTATION_PLAN.md`. Execute it now through the project's `subagent-driven-development` workflow: Task 0 documentation is parent-owned, then dispatch one fresh bounded writer for Tasks 1–2 only after the document dependency edge is present; run Task 3 validation/review before any forwarding work.
