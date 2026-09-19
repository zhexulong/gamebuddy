# Stardew Bootstrap Containment and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Node-owned Stardew role spawning with a provenance-verified, resident native guardian that creates and contains Player Host and AI Client process trees in separate exact Windows Jobs, enabling fail-closed crash recovery before any successor attempt.

**Architecture:** A private coordinator-owned guardian protocol maps one durable bootstrap attempt to two role-scoped, non-breakaway `KILL_ON_JOB_CLOSE` Jobs. The native guardian owns an exact opaque instance/epoch lease and launches each direct role root atomically into its exact Job using `STARTUPINFOEX` and `PROC_THREAD_ATTRIBUTE_JOB_LIST`, retaining both Job handles and that lease. A private recovery operation must first atomically acquire the released exact guardian lease and persist recovery ownership; only then may it reopen record-bound role Jobs, contain both, and durably clear the parent attempt fence. All ambiguity quarantines the attempt.

**Tech Stack:** TypeScript/Node ESM, .NET 8 win-x64 single-file native helper, Win32 Job Objects, existing Host production-artifact inventory/manifest provenance, Node `node:test` compiled test artifacts, disposable Windows-native helper fixtures.

**Spec:** `design/102_STARDEW_BOOTSTRAP_CONTAINMENT_RECOVERY_DESIGN.md`

## Global Constraints

- This plan implements only the Design 102 containment predecessor. It does not implement installation registration, Design 104 discovery/onboarding, desktop distribution, headless activation, operational-gate migration, or Task 11 live gameplay.
- `StardewProductionLifecycleCoordinator` remains the only owner of reservation, Stage C/D semantics, attestation, attachment, materialization, Game enter, STOP, disconnect, and reverse lifecycle order.
- The guardian never accepts installation locators, executable paths from public callers, bridge pipe/token facts, browser facts, action payloads, prompts, or raw Game evidence.
- Player Host and AI Client use separate non-breakaway Jobs. AI containment must not terminate a still-legitimate Player Host.
- Role roots are created only by the guardian using `PROC_THREAD_ATTRIBUTE_JOB_LIST`; Node `spawn`, shell/wrapper execution, post-create `AssignProcessToJobObject`, `CREATE_BREAKAWAY_FROM_JOB`, and breakaway Job limits are forbidden production fallbacks.
- Every native helper capability is derived only from a fixed, hash/manifest/inventory-attested pair in the selected immutable artifact generation. Unsupported Windows/native/ACL/Job outcomes fail closed.
- All browser/state/log/telemetry/IPC/report projections are fixed and redacted: no job name, PID, executable, cwd, args, profile, locator, bridge, token, generation, or raw Win32 diagnostic may escape.
- Generic stale-lock reclaim can select an owner-dead recovery attempt; it never clears an active attempt fence, revokes guardian launch authority, or proves process containment.
- The resident guardian owns an exact opaque instance/epoch recovery lease. Host control EOF atomically transitions it to closing, discards queued-but-unexecuted role commands, panic-contains both Jobs, and releases the lease only while exiting. It revalidates the lease, record, closing state, and Host-control liveness immediately before `CreateProcessW`, after membership verification, and immediately before `ResumeThread`; loss or mismatch forces panic containment and forbids resume.
- Recovery cannot open/terminate Jobs, write `contained`, or permit a successor while a prior guardian retains the lease. It returns redacted unavailable without record mutation until it atomically acquires the released exact lease and persists recovery ownership first.
- No commits may include unrelated dirty lanes. Run `git diff --check` and use exact path staging / `git commit --only` where needed.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `host/native/windows-stardew-bootstrap-guardian/Program.cs` | Fixed native guardian protocol, exact Job creation/launch/contain/recovery operations, Win32 error redaction. |
| `host/native/windows-stardew-bootstrap-guardian/GameBuddy.WindowsStardewBootstrapGuardian.csproj` | Deterministic win-x64 guardian build definition. |
| `host/scripts/build-windows-stardew-bootstrap-guardian.mjs` | Fixed SDK/publish pair builder and canonical helper manifest. |
| `host/src/windows-stardew-bootstrap-guardian/internal.ts` | Opaque guardian capability and test-only state. |
| `host/src/windows-stardew-bootstrap-guardian/index.ts` | Production/build capability mint and fixed request/response adapter with artifact provenance verification. |
| `host/src/windows-stardew-bootstrap-guardian/index.test.ts` | Capability/provenance/protocol/redaction tests. |
| `host/src/stardew-bootstrap-guardian.private.ts` | Private strict guardian record/fence protocol, coordinator-only launch/contain/recovery adapter. |
| `host/src/stardew-bootstrap-guardian.private.test.ts` | Strict-record, state-machine, role-isolation, recovery/quarantine tests. |
| `host/src/stardew-private-bootstrap-composer.core.ts` | Replace production direct role spawn/stop dependencies with guardian-private adapters while retaining typed Stage C/D ownership. |
| `host/src/stardew-private-bootstrap-composer.test.ts` | Regression coverage for Stage C/D launch/attestation and role-specific containment delegation. |
| `host/scripts/production-artifact.mjs` | Include guardian’s verified fixed pair and inventory origin. |
| `host/production-artifact.config.json` | Declare guardian pair in selected artifact configuration. |
| `host/scripts/production-artifact.test.mjs` | Verify guardian pair completeness/provenance in immutable artifact output. |
| `host/scripts/build-windows-stardew-bootstrap-guardian.test.mjs` | Verify fixed builder/no-follow/canonical manifest contract. |
| `host/native/windows-stardew-bootstrap-guardian/fixtures/*` | Disposable fixture roots only for native Job/ACL/crash verification; never Stardew/SMAPI. |

## Task 1: Freeze native guardian protocol and artifact provenance

**Files:**
- Create: `host/native/windows-stardew-bootstrap-guardian/GameBuddy.WindowsStardewBootstrapGuardian.csproj`
- Create: `host/native/windows-stardew-bootstrap-guardian/Program.cs`
- Create: `host/scripts/build-windows-stardew-bootstrap-guardian.mjs`
- Create: `host/scripts/build-windows-stardew-bootstrap-guardian.test.mjs`
- Create: `host/src/windows-stardew-bootstrap-guardian/internal.ts`
- Create: `host/src/windows-stardew-bootstrap-guardian/index.ts`
- Create: `host/src/windows-stardew-bootstrap-guardian/index.test.ts`
- Modify: `host/scripts/production-artifact.mjs`
- Modify: `host/production-artifact.config.json`
- Modify: `host/scripts/production-artifact.test.mjs`

**Interfaces:**

- Produces opaque `WindowsStardewBootstrapGuardianCapability`; only this adapter can spawn the fixed helper.
- Produces exact fixed protocol requests with `schemaVersion: 1`, opaque guardian instance/epoch correlation, and operations `arm_attempt`, `launch_role`, `contain_role`, `begin_recovery`, and `recover_attempt`.
- `arm_attempt` creates/acquires the guardian-exclusive lease; `begin_recovery` atomically acquires only a released exact lease and persists recovery ownership before `recover_attempt` can touch Jobs.
- Guardian responses are only fixed redacted categories: `armed`, `role_active`, `role_contained`, `attempt_contained`, `kept_unavailable`, or `indeterminate`.

- [ ] **Step 1: Write failing provenance and protocol tests**

```ts
test("published guardian capability accepts only its inventory-attested fixed pair", async () => {
  const capability = await createPublishedWindowsStardewBootstrapGuardian(fixture.artifactRoot);
  await tamper(fixture.manifestPath);
  await assert.rejects(() => armAttempt(capability, exactArmRequest), /unavailable/);
});

test("guardian adapter rejects path, pid, token, bridge, lease substitution, and unknown protocol fields", async () => {
  await assert.rejects(() => invoke(capability, {
    schemaVersion: 1, operation: "arm_attempt", jobName: "opaque", executable: "C:\\leak.exe",
  } as never), /invalid/);
  await assert.rejects(() => invoke(capability, {
    schemaVersion: 1, operation: "launch_role", guardianEpoch: 99,
  } as never), /invalid/);
});
```

- [ ] **Step 2: Run the new tests and confirm they fail because the module is absent**

Run from `host/` after `pnpm build:test`:

```bash
node --test dist-test/windows-stardew-bootstrap-guardian/index.test.js
```

Expected: module-not-found / missing export failure.

- [ ] **Step 3: Implement the fixed-pair TypeScript adapter and build-only helper skeleton**

```ts
export type WindowsStardewBootstrapGuardianCapability = Readonly<{ readonly __opaque: unique symbol }>;

export async function createPublishedWindowsStardewBootstrapGuardian(
  artifactRoot: string,
): Promise<WindowsStardewBootstrapGuardianCapability> {
  return await createFixedGuardian(artifactRoot, "native/windows-stardew-bootstrap-guardian/win-x64");
}
```

Implement strict JSON framing with bounded stdin/stdout, exact duplicate-key-rejecting request parsing, bounded response parsing, non-reparse fixed pair verification, canonical manifest hash validation, and inventory origin validation by adapting the established stale-lock-reclaimer pattern. Strictly bind every command to the guardian's private instance/epoch lease; the TypeScript adapter neither receives nor exposes the lease locator. Do not add a generic `run()` API or expose the helper executable path.

- [ ] **Step 4: Add guardian resource to immutable artifact configuration**

Add one exact `windowsStardewBootstrapGuardian` descriptor with destination `native/windows-stardew-bootstrap-guardian/win-x64`, fixed helper name `GameBuddy.WindowsStardewBootstrapGuardian.exe`, and canonical manifest. Extend artifact tests so the exact two files must be present with the declared verified origin; handwritten reports are not authority.

- [ ] **Step 5: Run scoped tests and artifact checks**

```bash
cd host
pnpm build:test
node --test dist-test/windows-stardew-bootstrap-guardian/index.test.js
node --test dist-test/scripts/production-artifact.test.js
node --test dist-test/scripts/build-windows-stardew-bootstrap-guardian.test.js
```

Expected: all pass; no real process role is launched.

- [ ] **Step 6: Fresh review and atomic commit**

Review for fixed-pair provenance, no raw protocol authority, and redaction. Commit only Task 1 files after `git diff --check`.

## Task 2: Implement native two-role Job arm and atomic direct-root launch

**Files:**
- Modify: `host/native/windows-stardew-bootstrap-guardian/Program.cs`
- Create: `host/native/windows-stardew-bootstrap-guardian/fixtures/RoleRootFixture.cs`
- Create: `host/native/windows-stardew-bootstrap-guardian/fixtures/RoleRootFixture.csproj`
- Create: `host/native/windows-stardew-bootstrap-guardian/guardian-live.test.mjs`
- Modify: `host/src/windows-stardew-bootstrap-guardian/index.test.ts`

**Interfaces:**

- Consumes `arm_attempt` with two opaque role job locators, an opaque guardian instance/epoch, and exact private attempt correlation.
- Consumes `launch_role` only after arm and while the exact guardian lease remains held; guardian-owned command facts come from its private adapter, never public protocol.
- Produces `role_active` only after the fixture proves exact role Job membership before its first user-code event.

- [ ] **Step 1: Write a disposable native fixture test for atomic membership-before-execution**

```js
test("a role root observes membership in its exact Job before first user code", async () => {
  const result = await guardianLaunchFixture({ role: "player_host" });
  assert.equal(result.category, "role_active");
  assert.equal(await fixtureObservedMembership(), true);
});

test("an injected verification failure before ResumeThread leaves no running fixture root", async () => {
  const result = await guardianLaunchFixture({ inject: "before_resume" });
  assert.equal(result.category, "kept_unavailable");
  assert.equal(await fixtureRootIsRunning(), false);
});
```

- [ ] **Step 2: Run and confirm the tests fail against the Task 1 skeleton**

```bash
cd host
node --test native/windows-stardew-bootstrap-guardian/guardian-live.test.mjs
```

Expected: unsupported/absent `launch_role`.

- [ ] **Step 3: Implement exact Job configuration and attribute-list launch**

In `Program.cs`:

```csharp
CreateJobObjectW(ref securityAttributes, roleJobName);
SetInformationJobObject(job, JobObjectExtendedLimitInformation, killOnCloseWithoutBreakaway);
InitializeProcThreadAttributeList(...);
UpdateProcThreadAttribute(attributeList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, jobHandle, ...);
CreateProcessW(applicationName, commandLine, ..., false,
  CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT, ..., ref startupInfoEx, ...);
VerifyExactJobMembership(processHandle, jobHandle);
ResumeThread(threadHandle);
```

The implementation must set an explicit current-user security descriptor; no broad ACEs; non-inheritable handles; `bInheritHandles = false`; no shell/wrapper; direct `lpApplicationName`; and no Job breakaway flags. Refuse `ERROR_ALREADY_EXISTS` for initial arm. Immediately before `CreateProcessW`, after membership verification, and immediately before `ResumeThread`, verify the exact instance/epoch lease and matching durable guardian record; any loss, Host-control EOF, or mismatch panic-contains both Jobs and forbids resume. Clean all native handles on every failure and contain any role already armed before returning redacted failure.

- [ ] **Step 4: Add crash and forbidden-fallback tests**

```js
test("guardian panic kills fixture descendants and does not leave a runnable direct root", async () => {
  const result = await guardianLaunchFixture({ inject: "guardian_panic_after_resume" });
  assert.equal(await waitForFixtureTreeExit(), true);
  assert.equal(result.category, "indeterminate");
});

test("Host EOF discards a delayed authenticated launch and prevents old guardian process creation or resume", async () => {
  const result = await guardianLaunchFixture({ inject: "host_eof_before_resume" });
  assert.equal(result.category, "kept_unavailable");
  assert.equal(await fixtureRootIsRunning(), false);
});

test("production guardian source has no Node spawn, shell, cmd.exe, post-create AssignProcessToJobObject, or breakaway flag", async () => {
  const source = await readFile(nativeGuardianSource, "utf8");
  assert.doesNotMatch(source, /AssignProcessToJobObject\s*\(/);
  assert.doesNotMatch(source, /BREAKAWAY_OK|SILENT_BREAKAWAY_OK|CREATE_BREAKAWAY_FROM_JOB/);
});
```

- [ ] **Step 5: Run Windows-only helper verification and the direct suite**

```bash
cd host
node native/windows-stardew-bootstrap-guardian/guardian-live.test.mjs
pnpm build:test
node --test dist-test/windows-stardew-bootstrap-guardian/index.test.js
```

Expected: fixture-only processes are contained; non-Windows environments report the fixed skip category rather than passing by simulation.

- [ ] **Step 6: Fresh authority and native-security review; commit Task 2 only**

Review `PROC_THREAD_ATTRIBUTE_JOB_LIST` usage, no pre-job creation gap, handle inheritance, Job ACLs, error redaction, and fixture cleanup. Commit only Task 2 files after native tests pass.

## Task 3: Add private guardian records, role adapters, and fail-closed recovery

**Files:**
- Create: `host/src/stardew-bootstrap-guardian.private.ts`
- Create: `host/src/stardew-bootstrap-guardian.private.test.ts`
- Modify: `host/src/stardew-private-bootstrap-composer.core.ts`
- Modify: `host/src/stardew-private-bootstrap-composer.test.ts`
- Modify: `host/src/stardew-player-host-process-owner.ts`
- Modify: `host/src/stardew-ai-client-process-owner.ts`

**Interfaces:**

- Produces private `StardewBootstrapGuardianOwner` with only `arm`, `launchPlayerHost`, `launchAiClient`, `containPlayerHost`, `containAiClient`, `recoverOrQuarantine`, and `close`. Its durable record additionally carries opaque guardian instance/epoch/lease facts; none reaches a public role-owner interface.
- The private record uses exact Design 102 states. Public role-owner interfaces remain redacted and do not expose guardian/Job facts.
- Consumes the existing private bootstrap owner correlation and stable deployment binding; does not accept process paths/args from browser, runner, or operator config.

- [ ] **Step 1: Write failing record/recovery and role-isolation tests**

```ts
test("dead lock owner alone cannot release an active guardian fence", async () => {
  const recovery = await fixture.recoverAfterDeadHost({ playerHost: "openable", aiClient: "access_denied" });
  assert.equal(recovery.kind, "quarantined");
  assert.equal(fixture.successorLaunchCalls, 0);
});

test("recovery cannot contain or clear a fence while the old guardian owns a delayed launch lease", async () => {
  await fixture.queueAuthenticatedDelayedLaunch();
  const recovery = await fixture.recoverAfterDeadHost({ guardianLease: "held" });
  assert.equal(recovery.kind, "unavailable");
  assert.equal(fixture.openJobCalls, 0);
  assert.equal(fixture.oldGuardianLaunchCalls, 0);
  assert.equal(fixture.successorLaunchCalls, 0);
});

test("AI containment delegates only to the AI Job and Player Host remains owned", async () => {
  await fixture.launchBothRoles();
  await fixture.containAiClient();
  assert.equal(fixture.playerHostStatus().kind, "awaiting_player_host_attestation");
  assert.equal(fixture.aiClientStatus().kind, "ai_client_stopped");
});
```

- [ ] **Step 2: Run and confirm the new private tests fail**

```bash
cd host
pnpm build:test
node --test dist-test/stardew-bootstrap-guardian.private.test.js
```

Expected: missing guardian record/adapter implementation.

- [ ] **Step 3: Implement strict private record and recovery adapter**

```ts
type GuardianRecoveryResult =
  | Readonly<{ kind: "contained" }>
  | Readonly<{ kind: "unavailable" }>
  | Readonly<{ kind: "quarantined" }>;

async function recoverOrQuarantine(record: GuardianRecord): Promise<GuardianRecoveryResult> {
  const recoveryLease = await acquireReleasedExactGuardianLease(record);
  if (!recoveryLease) return { kind: "unavailable" } as const;
  await persistRecoveryEpoch(record, recoveryLease);
  const bothContained = await recoverExactJobs(record, recoveryLease);
  if (!bothContained) return await persistQuarantine(record);
  await persistContained(record, recoveryLease);
  return { kind: "contained" };
}
```

Read records strictly, bind them to the current deployment/bootstrap facts, atomically acquire the released exact guardian instance/epoch lease, persist recovery ownership, invoke only the opaque guardian capability, and persist role/parent states atomically. Any held/mismatched/unavailable guardian lease, unavailable Job, ACL mismatch, active guardian channel, missing/ambiguous role, persistence failure, or untrusted response is quarantine. Never use PID/name search or a generic lock result as containment authority.

- [ ] **Step 4: Delegate production process ownership to guardian acknowledgements**

Replace only production `productionSpawn` / `productionPlayerHostSpawn` and direct `ChildProcess.kill()` ownership with the private guardian adapter. Preserve current test-support raw spawn seams; they remain test-only and must not appear in production composition. Preserve Stage C/D fresh rechecks, one-shot reservations, attestation, and existing redacted public status unions.

- [ ] **Step 5: Add coordinator regression cases and run direct suites**

```bash
cd host
pnpm build:test
node --test dist-test/stardew-bootstrap-guardian.private.test.js \
  dist-test/stardew-private-bootstrap-composer.test.js
```

Expected: guardian role containment preserves Stage C/D authority, semantic-enter/attach failures still quarantine, AI disconnect does not terminate Player Host, full close contains both role Jobs, and stale recovery cannot permit a successor until it has acquired the released guardian lease and both jobs are durably contained.

- [ ] **Step 6: Review and commit Task 3 only**

Independent review must trace private bootstrap owner → guardian record → exact role Jobs → process-owner adapters → coordinator reverse teardown, including all crash points and redaction. Commit only the named Task 3 files after scoped typecheck and `git diff --check`.

## Task 4: Verify recovery security boundaries and release-ready helper closure

**Files:**
- Modify: `host/native/windows-stardew-bootstrap-guardian/guardian-live.test.mjs`
- Modify: `host/src/windows-stardew-bootstrap-guardian/index.test.ts`
- Modify: `host/src/stardew-bootstrap-guardian.private.test.ts`
- Modify: `host/scripts/production-artifact.test.mjs`

**Interfaces:**

- Produces no new product API. It completes deterministic evidence for Task 1–3.

- [ ] **Step 1: Add two-user ACL, handle-lifetime, and guardian-lease recovery-race verifiers**

```js
test("a different current-machine user cannot open, query, assign, or terminate a role Job", async (t) => {
  t.skip(process.env.GAMEBUDDY_WINDOWS_SECONDARY_TEST_USER === undefined,
    "requires configured disposable secondary Windows user");
  const result = await exerciseSecondUserAgainstRoleJob();
  assert.deepEqual(result, { open: "denied", query: "denied", assign: "denied", terminate: "denied" });
});

test("role descendants do not inherit a Job handle that prevents last-handle containment", async () => {
  await fixture.launchDescendant();
  await fixture.crashGuardian();
  assert.equal(await fixture.waitForRoleJobDrain(), true);
});

test("recovery cannot clear an attempt until it owns the released exact guardian lease", async () => {
  await fixture.queueAuthenticatedDelayedLaunch();
  await assert.equal(await fixture.recoverWhileGuardianLeaseHeld(), "quarantined");
  await fixture.releaseGuardianLeaseThroughPanicContainment();
  await assert.equal(await fixture.recoverExactAttempt(), "contained");
  assert.equal(await fixture.oldGuardianCanLaunchOrResume(), false);
});
```

- [ ] **Step 2: Run the verifier and classify unsupported environment conservatively**

```bash
cd host
node native/windows-stardew-bootstrap-guardian/guardian-live.test.mjs
```

Expected: required Windows fixture evidence passes; missing secondary-user setup yields an explicit blocked gate, not a silent pass. The guardian-lease race must never be skipped on supported Windows.

- [ ] **Step 3: Run complete deterministic closure**

```bash
cd host
pnpm build:test
node --test --test-concurrency=1 \
  dist-test/windows-stardew-bootstrap-guardian/index.test.js \
  dist-test/stardew-bootstrap-guardian.private.test.js \
  dist-test/stardew-private-bootstrap-composer.test.js \
  dist-test/scripts/production-artifact.test.js
pnpm exec tsc -p tsconfig.production.json --noEmit
pnpm exec tsc -p tsconfig.test.json --noEmit
git diff --check -- host/native/windows-stardew-bootstrap-guardian host/scripts/build-windows-stardew-bootstrap-guardian.mjs host/src/windows-stardew-bootstrap-guardian host/src/stardew-bootstrap-guardian.private.ts host/src/stardew-private-bootstrap-composer.core.ts host/src/stardew-player-host-process-owner.ts host/src/stardew-ai-client-process-owner.ts host/scripts/production-artifact.mjs host/production-artifact.config.json
```

Expected: all deterministic tests and scoped checks pass. Any native fixture, cross-user ACL, provenance, guardian-lease recovery race, recovery, or redaction gap blocks later Design 101 work.

- [ ] **Step 4: Fresh two-stage review and exact commit**

First review the native protocol/security/provenance; second review coordinator lifecycle/recovery/redaction/topology. Stage only exact Design 102 implementation files. Do not perform Task 11 mutation.

## Spec Coverage Self-Review

- Atomic before-execution containment: Task 2 uses `PROC_THREAD_ATTRIBUTE_JOB_LIST`, membership verification, then `ResumeThread`.
- Separate role ownership: Tasks 2–3 create and contain independent role Jobs; Task 3 asserts AI containment preserves Player Host.
- Crash recovery: Task 3 requires atomic guardian-lease revocation/recovery ownership before exact two-Job all-or-nothing recovery; Task 4 forces crash/handle-lifetime and delayed-command race verification.
- ACL and no-leak boundary: Tasks 1, 2, and 4 cover attested helper, explicit DACL, current-user cross-user denial, handle inheritance, and redaction.
- Existing coordinator authority: Task 3 retains its semantic lifecycle and only delegates OS containment; Task 4 runs Stage C/D regression suites.
- No registration/gate/live work: every task excludes locator registration, headless activation, runner migration, and gameplay mutation.
- Placeholder scan: no task relies on a generic “add validation” instruction; each names concrete protocol operations, symbols, test behavior, and commands.
