---
id: TASK-STARDEW-BOOTSTRAP-CONTAINMENT-RECOVERY
type: task
status: active
owner: stardew-integration
---

# Stardew Bootstrap Containment and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace in-process Node process ownership with a GameBuddy-owned Windows guardian that atomically places Player Host and AI Client roots into separate non-breakaway Jobs before user code, cleans up the AI role after Host loss, preserves the Player Host/game world, and permits only AI recovery after acquiring the released guardian lease. Player recovery is unavailable.

**Architecture:** The resident native guardian remains outside two role-specific Jobs. It creates each direct root suspended with `STARTUPINFOEX + PROC_THREAD_ATTRIBUTE_JOB_LIST`, verifies membership, rechecks the exact instance/epoch lease and Host-control state, then resumes. Here `player_host` and `ai_client` are OS process roles, not in-game NPCs or an AI companion. The Player Host Job is non-kill-on-close; the AI Client Job retains kill-on-close. Game runtime duration is lifecycle termination, explicit STOP, or crash—not a timeout. Retain only transport/handshake wait budgets and one lifecycle-owned per-invocation `RoleLaunchOperation` deadline, created after fresh admission/preconditions and the decision to launch. Only `launch_role` carries the launch deadline; arm/contain/recover use transport/operation wait budgets only if their wire requires them, and those budgets are neither launch deadline nor game lifetime. Bootstrap timeout, browser admission expiry, and owner/attempt expiry must not be reused as launch deadline; every non-launch budget has a distinct failure model and owner. The existing bootstrap transaction `owner.json` is destructively upgraded as the sole durable attempt-fence authority; recovery acquires the released exact lease, persists recovery ownership, drains/classifies only the AI Job, and does not clear the fence while the Player Host/game world survives. Player recovery is unavailable. Task 1 proves the native resident contract with disposable fixtures but does not create a Node pathname launcher. Production resident launch is owned by the native Desktop generation launcher and is an explicit Task 3 predecessor.

This task supplies Windows Guardian containment/recovery evidence for the cross-game `ContainedGameRuntime` defined by [ADR-0007](../../adr/0007-contained-game-runtime-and-game-owned-launch-authorization.md); it does not define that runtime. The sole game-facing contract is `host/src/containment/runtime/contract/game-runtime.ts`; implementation-private `host/src/containment/runtime/core/contained-game-runtime.ts` is imported only by `host/src/composition`. Stardew staged Player Host/D belongs to `host/src/games/stardew/{lifecycle,launch,bridge}` and may import only that contract, never runtime/core, auth transport, bootstrap roots, Desktop/Guardian/Windows/native; composition owns assembly. It supplies one private, one-shot authorization after its own admission, recipe, reservation and deadline checks; the runtime returns redacted outcomes. The guardian must not select installations, interpret Mod/action names, or become a Stardew lifecycle owner. When these directories land, their local `README.md` files define `Owns`、`Does not know`、`Dependency direction`、`Placement and move rule` 与 `Required verification`; this task does not create them.

**Tech Stack:** .NET 8 WinExe, Win32 Job Objects and process APIs, TypeScript/Node.js ESM private adapters, `node:test`, fixture-only Windows integration tests.

**Spec:** `design/domains/stardew/integration.md`. The current authority for this task is the live [Design 102](../../102_STARDEW_BOOTSTRAP_CONTAINMENT_RECOVERY_DESIGN.md), while `design/archive/legacy-sources/102_STARDEW_BOOTSTRAP_CONTAINMENT_RECOVERY_DESIGN.md` remains a security risk checklist only. The live Design 102 supersedes incompatible Player kill-on-close/full-close/Player-recovery clauses; this task is not a compatibility or fallback mode.

## Status and authority

**Current architecture clarification (implementation pending):** formal Desktop bootstrap is the single Host product composition root. Its Phase 1 responsibility is runtime admission, Host child/session authentication, root-layout revalidation, and initialization/holding of the Host long-lived product composition; it does not decide semantic `principal`, `authorityGeneration`, `fresh`/`known`, selected integration, GameSession, activation or world binding, and no `ProductInputProducer` is added. `HostDeploymentManifest` remains the Host-owned complete deployment/composition input, not a test input; Desktop `dataRoot` remains only a storage partition and is not product identity or complete authority. Missing deployment-level semantic authority cannot create `local_default`; known startup does not automatically increment `authorityGeneration`, and any fresh initialization remains governed by the existing authority owner/contract. Phase 2 GameSession Create/Resume is UI-driven through the Host GameSession owner. Bootstrap authenticates `DesktopGuardianSession` and passes it only through a private composition-owned typed capability to the selected game lifecycle. `dialogue-web-main` is a browser/product helper and must not construct the Stardew lifecycle root independently. No global session registry, second entry, browser handoff, or raw pipe/token/session leakage is permitted.

The four active contracts are: long-lived bootstrap/composition boundary; semantic authority/session owner; published artifact/picker seam (reuse existing generation admission, Host publisher/published capability and Host-native folder picker, with `programRoot` not unconditionally treated as published artifact root); and presentation startup/close. Presentation continues to use the existing one-loopback-listener and typed narrow projection, without a forced WebSocket, fixed `127.0.0.1`, random-port or second-listener contract. Startup/close must propagate close/drain failure after best-effort drain. Normal GameBuddy close does not default STOP or terminate the Player/world; `End Game` is an independent authenticated operation.

After Phase 1 and Phase 2 are implemented and verified, migration follows solution A: browser/presentation wiring moves into formal composition-owned startup and `host/src/dialogue-web-main.ts` plus its entry/imports are deleted. No wrapper, alias, second entry or fallback is retained. Stardew remains the product lifecycle owner and creates an invocation-specific `RoleLaunchOperation` deadline/budget only after fresh admission, reservation, and launch preconditions pass; no bootstrap/browser/owner/attempt expiry or game lifetime may be reused.

This task activates only Guardian containment/recovery. It does not close containment by being present. Closure requires Task 1–4 implementation, deterministic Windows evidence, and independent review, followed by a factual update to `design/domains/stardew/integration.md`.

**Implemented checkpoints (2026-09-01):** `87eca78 Establish atomic Stardew Guardian containment` closed Task 1's fixture-proven atomic Job containment. `9f52f8a Close Stardew Guardian recovery containment` closed Task 2's v4 sole-record CAS, private recovery orchestration, successor-gate/Job classification, and resident EOF/resume state-gate implementation. Its evidence was source-bound builder 3/3, serial Windows matrix 40/40 with zero skips, native/fixture builds with zero warnings/errors, Host owner/boundary 15/15, and private/public protocol suites 26/26; independent native-security review accepted with no blocker/high. `b098b57 Add Windows desktop root registration` closed the registered-root predecessor, and `6aaeb75 Add native Guardian generation launcher` closed native Guardian admission/EOF supervision. Task 3 remains blocked until the `TASK-WINDOWS-DESKTOP-HOST-RUNTIME-ADMISSION` and `TASK-WINDOWS-DESKTOP-RUNTIME-SUPERVISOR-GUARDIAN-BROKER` predecessors establish an exact authenticated Host child, Host-side root-layout revalidation, and private Guardian command/acknowledgement session. This is not product-path closure: Task 4 still owns the secondary-user, outer-Job, crash/last-handle, and complete lifecycle closure matrix.

The already committed `bc0c776` tracer is the Task 0 baseline: fixed artifact provenance, strict redacted grammar, no runtime helper invocation, and a native no-child fixture. Do not reopen its TypeScript production spawn surface. Task 1 implements and fixture-proves the resident native composition that owns all role process creation. The independently reviewed native Desktop generation launcher now starts only the fixed Host-admission-contract Guardian from the registered installed generation without a pathname check-to-spawn race. Before Task 3 may connect production role ownership, the Desktop must additionally admit/authenticate the exact bundled Host child and establish the private Guardian command/acknowledgement broker; Task 3 may not add a Node, public-adapter, or alternate launch path.

`design/tasks/active/stardew-product-launch-topology-consolidation.md` remains blocked. This task does not authorize installation registration, route removal, onboarding, operational-gate activation, or live Stardew.

## Ceremonial verification audit

This documentation-only audit records the existing incident→authority→boundary→keep/merge/remove decisions; it adds no API, protocol field, or proof layer.

| Incident | Authority | Boundary | Keep / merge / remove |
|---|---|---|---|
| Wrong role ownership or a Player world terminated by Guardian/Host loss | Creation-time Job containment and GameBuddy-owned process ownership | Native process creation, Job membership, and explicit teardown | Keep creation-time containment/process ownership; merge duplicate post-hoc artifact proofs at that boundary; remove any Resume proof that repeats OS ownership |
| Concurrent durable settlement or an uncertain native side effect | Sole bootstrap owner record, durable transaction/CAS, and receipt/postcondition owner | Terminal settlement or uncertain-effect recovery | Keep CAS only for real settlement/uncertain side effects; merge duplicate transitions in the same owner; remove CAS used as a general lifecycle or Resume ceremony |
| Resume attaches the wrong session/world or infers stale activation validity | Game session owner, registered world binding, existing attachment handshake, and fresh observation | New-activation Resume binding/observation boundary | Keep binding, existing handshake, and observation; merge repeated identity checks; remove or do not add Resume hash/signature/generation/lease/attestation proof |
| Stardew provisioning publication/readiness is misclassified | Existing Stardew provisioning manifest, advertisement, response, fixture, and required persistence authority | Stardew provisioning publication/readiness, separate from Resume | Audit existing Stardew provisioning HMAC/signatures separately for owner, purpose, and failure meaning; merge duplicate provisioning checks; do not promote them to Resume proof |

## Global constraints

- The guardian is the sole OS process-tree containment owner for any admitted game role; the game coordinator remains the sole product lifecycle owner. `player_host` and `ai_client` are OS process roles, not an in-game NPC/AI companion and not a generic gameplay contract.
- Create each role root with `CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT` and `PROC_THREAD_ATTRIBUTE_JOB_LIST` containing the role's Job. Post-create `AssignProcessToJobObject` is not an acceptable fallback.
- Each attempt owns two independent `Local\` named Jobs with no breakaway flags and non-inheritable handles. Only the AI Client Job uses `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; the Player Host Job is explicitly non-kill-on-close so GameBuddy close or Guardian last-handle close cannot terminate the Player Host/game world. The AI Job receives exactly current-SID `QUERY | TERMINATE | SYNCHRONIZE | READ_CONTROL` (`0x0012000C`) for AI cleanup/recovery; the Player Job is not a Player-recovery target. `ASSIGN_PROCESS`, `SET_ATTRIBUTES`, `DELETE`, `WRITE_DAC` and `WRITE_OWNER` remain absent. The exact instance/epoch lease receives only its required minimum current-user rights. All descriptors are passed in `SECURITY_ATTRIBUTES` at object creation; a pre-existing same-name object is rejected and its ACL is never rewritten.
- Guardian role launch uses `bInheritHandles=false`. Launch uses direct `lpApplicationName`, not shell, wrapper, `cmd.exe`, Node `spawn`, or caller-provided command lines. The separate Desktop-to-Guardian stdin EOF pipe is the only reviewed launcher-side exception: its reader is the sole allowlisted inherited handle.
- The public protocol never accepts or returns executable paths, arguments, cwd, PID, process handle, Job/lease name, bridge/token/profile, registration locator, or raw Win32 error.
- Role executable facts and the one-shot arm binding cross only a separate Guardian-private current-user named pipe whose server is created by the Guardian. In Task 1 the disposable Windows harness injects fresh `GAMEBUDDY_GUARDIAN_CONTROL_PIPE` and `GAMEBUDDY_GUARDIAN_CONTROL_TOKEN` values. Before Task 3, the native Desktop generation launcher must own this injection for production without a Node pathname spawn or a second provenance verifier. These values are absent from product config, durable records, manifests, browser state, logs, and role-child environments. Pipe creation uses a protected current-user DACL, non-inheritable handle, first-instance semantics, and remote-client rejection; any same-name collision is terminal. Before reading launch facts, the Guardian revalidates the connected client SID as its exact current SID and consumes one constant-time-compared token on one connection. Malformed/partial/oversize frames, EOF, remote clients, wrong SID/token, and replay create or resume no root.
- After first-frame SID/token/correlation authentication, a one-shot private arm binding transfers only the already-persisted immutable owner-record revision plus exact random `leaseName`, `playerJobName`, and `aiJobName`. The Guardian freezes it before any native object creation; replay, revision mismatch or cross-attempt substitution creates no object. This binding transmits but cannot mint or rewrite durable authority and is never logged, persisted again, returned, or exposed publicly. Private role launch plans are separate one-shot messages, never persisted, and bind `guardianInstanceId`, positive bounded `guardianEpoch`, `attemptId`, role, deadline, an exact admitted absolute executable/cwd, an argument vector, and an explicit allowlisted environment map. They never contain a caller-built command line or ambient environment block. The Guardian constructs Windows CRT-compatible quoting and a sorted, case-insensitively unique Unicode environment block, rejects invalid/NUL/duplicate entries, and strips both Guardian control credentials. Browser, runner, Preview, Portfolio, manifests, public protocol, and logs cannot obtain launch plans.
- Host-control EOF atomically enters native `closing`, rejects queued commands, contains and drains the AI Job, closes AI handles, leaves the Player Host/game world alive, releases the lease last and exits. EOF does not write `owner.json`: the lost Host is unavailable and the native Guardian receives no record locator or CAS authority. The sole durable record therefore remains nonterminal/unavailable until the dedicated AI recovery path obtains the new recovery gate; it cannot terminalize the Player or clear the parent fence. A normal controlled close is distinct: the live Host first CASes v4 to `closing`, requests AI drain, records only the AI outcome after the drain acknowledgement, and then requests lease release/exit. Ordinary close is not `End Game`; only a separate authenticated `End Game` operation may terminate the Player.
- Crash recovery uses a new kernel mutex generation under the immutable recorded lease name as a successor exclusion gate. `CreateMutexW(initialOwner: true)` must create a new object; `ERROR_ALREADY_EXISTS` is `unavailable` with zero Job access, and recovery must never wait for, adopt, or treat an abandoned old mutex as authority. While holding the new gate, recovery must durably CAS `recovering + recoveryInstanceId` before any Job access.
- For the durable-armed AI role, recovery opens and verifies the exact AI Job that still exists, then terminates, drains, and queries active-process zero. `ERROR_FILE_NOT_FOUND` is AI-containment evidence only when the immutable attempt binding and recovery CAS still match and Task 1's sole-handle, no-inheritance, `KILL_ON_JOB_CLOSE` invariants prove the old AI Job was destroyed after terminating its members. The Player Job is never opened, terminated, drained, or classified by recovery; Player recovery is unavailable. Same-name Job recreation is never the old Job and cannot itself prove containment.
- `TerminateJobObject` success and direct-root exit are not containment proof. AI containment requires either verified AI Job drain plus active-process zero, or the narrowly bounded durable-armed last-handle-destruction proof above, followed by a durable AI role transition. No equivalent Player containment or Player recovery result exists in this task.
- Missing without the durable-armed precondition, access-denied, unexpected object type, configuration/ACL mismatch, drain ambiguity, stale revision, or unpersistable state remains unavailable or quarantined and permits no successor.
- The existing bootstrap transaction `owner.json` is the sole durable authority. Task 1 destructively introduced its strict v3 Guardian arm fence. Task 2 destructively replaces v3 with strict `gamebuddy-stardew-private-bootstrap-owner/v4`, separating immutable `bindingRevision` from monotonically changing `ownerRecordRevision` and adding instance/epoch, guardian/role lifecycle states and `recoveryInstanceId`. v4 rejects v3; no parallel record, migration, import, fallback, dual read/write or read-repair is allowed. The record contains opaque correlation and states only; no executable/process/private-pipe/bridge facts.
- The named-object recovery contract assumes same-SID code is not adversarial and cannot learn or manipulate private random names/handles. Current-user DACLs isolate other SIDs but do not defeat hostile same-SID code. If that threat enters scope, this design must be replaced by a protected service or separate-SID boundary; additional random names, CAS or retries are not a substitute.
- Tests launch only disposable fixture executables. No Stardew, SMAPI, bridge, installation discovery, target lease, or gameplay mutation is authorized.
- Preserve unrelated dirty-worktree and staged changes. Each task commits only its owned files after fresh review.

---

## File and responsibility map

| File | Responsibility |
|---|---|
| `host/native/windows-bootstrap-guardian/Program.cs` | Strict command loop, lease/EOF state machine, two Job owners, atomic direct-root launch, membership verification, AI-role drain and recovery. Raw EOF performs AI containment only and never writes the durable record or claims Player containment. |
| `host/native/windows-bootstrap-guardian/GuardianProtocol.cs` | Exact redacted command/response parsing, including Task 2 recovery commands and correlation; no executable or native-object fields. |
| `host/native/windows-bootstrap-guardian/WindowsJobOwner.cs` | Win32 Job/DACL/handle lifetime, membership query, drain proof. |
| `host/native/windows-bootstrap-guardian/WindowsRoleLauncher.cs` | `STARTUPINFOEX` attribute-list process creation and pre-resume checks. |
| `host/native/windows-bootstrap-guardian/GuardianLease.cs` | Creation-time secured exact instance/epoch lease; Task 1 holds it across arm/launch, while Task 2 adds closing/release/recovery ordering. |
| `host/native/windows-bootstrap-guardian/GuardianPrivateLaunchIngress.cs` | Authenticated current-user named-pipe ingress for one-shot private role launch plans; separate from the redacted public protocol. |
| `host/native/windows-bootstrap-guardian/fixtures/RoleRootFixture.csproj` and `RoleRootFixture.cs` | Harmless direct-root/descendant fixture that reports first-user-code Job membership. |
| `host/native/windows-bootstrap-guardian/guardian-live.test.mjs` | Windows-only containment, EOF, crash, lease, role-isolation, ACL and no-fallback matrix. |
| `host/src/stardew-private-bootstrap-composer.ts` and `.core.ts` | Sole bootstrap `owner.json` schema/authority; Task 1 adds the strict v3 arm fence, Task 2 destructively replaces it with strict v4 lifecycle state and revision CAS, and Task 3 begins consuming the closed owner for role delegation. |
| `host/src/stardew-private-bootstrap-composer.test.ts` | Existing owner-schema fixtures plus malformed/stale/unsafe/persistence-failure Guardian-fence tests. |
| `host/src/containment/runtime/contract/game-runtime.ts` | Sole narrow game-facing contract; no platform facts; it cannot expand game authority. |
| `host/src/containment/runtime/core/contained-game-runtime.ts` | Host-private generic runtime implementation; only `host/src/composition` may import it. |
| `host/src/games/stardew/{lifecycle,launch,bridge}` | Future Stardew lifecycle, launch-authorization and bridge seam; imports only `runtime/contract/game-runtime.ts`, never runtime/core or raw Desktop/Guardian IPC. |
| `host/src/composition` | Sole private assembly of runtime/core, Stardew adapter, bootstrap and platform modules. |
| `host/src/stardew-bootstrap-guardian.private.ts` | Legacy Stardew-specific facade being replaced by the generic containment seam; it may not become the cross-game platform contract or own a second durable file/process launcher. |
| `host/src/stardew-bootstrap-guardian.private.test.ts` | Facade/arm-binding/control/redaction/no-successor tests against the sole owner record. |
| `host/src/windows-bootstrap-guardian/native-integration.test.ts` | Migrated Task 1 resident/helper contract tests; old always-no-child/always-unavailable/one-shot-helper assumptions are removed. |
| `host/src/games/stardew/lifecycle/stardew-player-host-process-owner.ts` | Future Stardew launch seam delegates production Player Host launch/containment to Guardian acknowledgement; this task does not claim that delegation is complete. |
| `host/src/games/stardew/lifecycle/stardew-ai-client-process-owner.ts` | Future Stardew launch seam delegates production AI Client launch/containment to Guardian acknowledgement; this task does not claim that delegation is complete. |
| `host/src/games/stardew/lifecycle/stardew-process-implementations.ts` | Current Stardew process-owner implementation assembly; any old `host/src/stardew-*` process-owner path is migration-before state only and not a current task target. |
| Existing focused tests for the three Host files | Preserve staged Player Host/D, attestation, STOP/disconnect, quarantine and reverse teardown behavior. |

Task 1 may split `Program.cs` only into the named responsibility files. Do not create a generic launcher, Job framework, recovery registry, or compatibility layer.

---

## Task 1: Durable arm, exact lease, and atomic two-role direct-root launch

**Files:**
- Modify: `host/native/windows-bootstrap-guardian/Program.cs`
- Create: `host/native/windows-bootstrap-guardian/GuardianProtocol.cs`
- Create: `host/native/windows-bootstrap-guardian/WindowsJobOwner.cs`
- Create: `host/native/windows-bootstrap-guardian/WindowsRoleLauncher.cs`
- Create: `host/native/windows-bootstrap-guardian/GuardianLease.cs`
- Create: `host/native/windows-bootstrap-guardian/GuardianPrivateLaunchIngress.cs`
- Modify: `host/src/stardew-private-bootstrap-composer.ts` only for the destructive owner schema upgrade
- Modify: `host/src/stardew-private-bootstrap-composer.core.ts` only for owner persistence/strict validation/CAS; do not change role process delegation
- Modify: `host/src/stardew-private-bootstrap-composer.test.ts` only for owner-schema and fence persistence regressions
- Create: `host/src/stardew-bootstrap-guardian.private.ts`
- Create: `host/src/stardew-bootstrap-guardian.private.test.ts`
- Modify: `host/src/windows-bootstrap-guardian/native-integration.test.ts` to remove Task 0 one-shot/no-child semantics and cover the Task 1 resident contract
- Create: `host/native/windows-bootstrap-guardian/fixtures/RoleRootFixture.csproj`
- Create: `host/native/windows-bootstrap-guardian/fixtures/RoleRootFixture.cs`
- Create: `host/native/windows-bootstrap-guardian/guardian-live.test.mjs`
- Modify: `host/scripts/build-windows-bootstrap-guardian.mjs` only to produce a fresh source-bound Task 1 test publication and the disposable `RoleRootFixture.exe`; it must not overwrite or silently reuse an older source-unbound Guardian pair
- Modify: `host/scripts/build-windows-bootstrap-guardian.test.mjs` only for fresh-publication and fixture-output regressions
- Modify: `host/src/windows-bootstrap-guardian/index.test.ts` only for static/public-boundary assertions

**Interfaces:**
- Consumes: the existing exact redacted correlation grammar for lifecycle commands. Executable facts arrive only through an authenticated Guardian-private named-pipe launch plan bound to the same correlation and role.
- Persists before native arm: strict owner/v3 with an immutable binding revision plus opaque random lease/Player-Job/AI-Job names. Task 1 does not claim mutable lifecycle CAS, exact guardian instance/epoch persistence or recovery state; Task 2 adds those only through the destructive owner/v4 replacement.
- Produces: a creation-time secured exact lease held by the resident Guardian, two record-bound armed role Jobs, `role_active` only after exact membership-before-resume, and `role_contained` only after full Job drain.

- [ ] **Step 1: Write the failing fixture matrix**

Add Windows-only tests for:

```text
atomic membership before first user code
forced failure before ResumeThread leaves no running root
Player and AI roots occupy different Jobs
AI containment drains AI descendants while Player remains active
AI containment drains the AI Job while the Player Host remains active
guardian itself is outside both Jobs
durable attempt fence exists before native arm and binds exact opaque lease/Job names
lease and both Job names are cryptographically random, record-bound, and not derivable from public correlation
initial arm rejects pre-existing lease, Job, or pipe objects without adopting them or rewriting their ACL
private ingress rejects remote/unauthenticated clients, wrong SID/token/instance/epoch/attempt/role, expired plans and replay
private ingress accepts only argv[] plus an explicit allowlisted environment map; invalid quoting/environment input creates no root
EOF or rejected private plans create and resume no role root
unsupported outer-Job nesting fails without breakaway
strict record rejects unknown/missing fields, unsafe names, stale revision, reparse/identity mismatch and invalid transitions
arm persistence failure, lease collision or either Job collision leaves the parent fenced and creates/resumes no role
```

The fixture's first user-code event must query its own Job membership and report only a boolean/category through fixture-owned output. Tests may inspect raw PID/Job facts locally but may not place them in product responses or checked-in evidence.

- [ ] **Step 2: Run the matrix red**

```bash
cd host
node --test native/windows-bootstrap-guardian/guardian-live.test.mjs
```

Expected: Task 0 skeleton cannot arm or launch roles.

- [ ] **Step 3: Implement Job ownership and atomic launch**

Use explicit P/Invoke for:

```text
CreateMutexW or the reviewed exact-lease primitive with creation-time SECURITY_ATTRIBUTES
CreateJobObjectW
SetInformationJobObject(JobObjectExtendedLimitInformation)
InitializeProcThreadAttributeList
UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_JOB_LIST)
CreateProcessW(CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT)
IsProcessInJob and QueryInformationJobObject
GetSecurityInfo for fixture-only descriptor verification
ResumeThread
TerminateJobObject
WaitForSingleObject
```

Before native arm, use the existing bootstrap transaction `owner.json`, containment-aware path lock and atomic write primitives to persist and strict-reread the exact current owner with a bounded v3 Guardian fence containing a fresh immutable binding revision, opaque random lease and two Job names. Replace the old owner schema destructively; do not read or write a parallel Guardian file and do not accept the retired schema after cutover. The authenticated private arm binding transfers this frozen revision and the three exact names to the Guardian once; it cannot create or alter them. Reject pre-existing, malformed, unreadable, unsafe, stale-revision or mismatched state; never derive object names from public correlation. The Guardian creates and holds the exact record-bound lease with a protected minimum current-user security descriptor before creating either Job. Retain the process handle through membership verification and resume. Revalidate the durable record binding, held exact lease, authenticated launch-plan correlation, deadline, one-shot state and non-closing control state immediately before `CreateProcessW`, after membership verification, and immediately before `ResumeThread`. Every failure path leaves the root suspended or terminated, contains any armed role, and disposes thread/process/attribute-list/security-descriptor handles. No rejected or replayed plan may reach process creation.

- [ ] **Step 4: Add forbidden-fallback and handle-lifetime regressions**

Assert production Guardian sources contain no `AssignProcessToJobObject`, breakaway flags, shell/wrapper, `cmd.exe`, or Node role process creation. Prove role children inherit neither Job/lease handles nor Guardian control credentials, and guardian last-handle loss drains descendants.

- [ ] **Step 5: Run focused acceptance**

```powershell
cd host
node scripts/build-windows-bootstrap-guardian.mjs
if (-not (Test-Path native/windows-bootstrap-guardian/.dist/win-x64/GameBuddy.WindowsBootstrapGuardian.exe)) { throw "Guardian publication missing" }
if (-not (Test-Path native/windows-bootstrap-guardian/.dist/fixtures/RoleRootFixture.exe)) { throw "RoleRootFixture publication missing" }
pnpm run build:test
node --test --test-concurrency=1 native/windows-bootstrap-guardian/guardian-live.test.mjs
node --test --test-concurrency=1 dist-test/stardew-private-bootstrap-composer.test.js dist-test/stardew-bootstrap-guardian.private.test.js dist-test/windows-bootstrap-guardian/index.test.js dist-test/windows-bootstrap-guardian/native-integration.test.js
```

The builder must prove that the executable used by `guardian-live.test.mjs` was freshly produced from the current Guardian sources in this Task 1 run. Reusing a previously valid Task 0 pair is not acceptance evidence. The same build invocation must publish the disposable fixture at the exact path consumed by the live test; a missing fixture is a failed gate, not an expected red result or skip.

Expected: required Windows cases pass non-skip. Non-Windows reports an explicit unsupported gate and cannot close the task.

- [ ] **Step 6: Fresh native-security review and atomic commit**

Reviewer must inspect struct layout, attribute-list sizing, creation-time Job/lease/pipe DACLs, first-instance/remote-client/SID/token pipe authentication, strict durable fence and opaque-name allocation, argv/environment construction, direct `lpApplicationName`, exact lease rechecks, handle ownership, membership-before-resume, no-breakaway proof, and fixture cleanup. Commit only Task 1 files.

---

## Task 2: Exact guardian lease, EOF closing, and crash recovery

**Files:**
- Modify: `host/native/windows-bootstrap-guardian/GuardianLease.cs`
- Modify: `host/native/windows-bootstrap-guardian/GuardianPrivateLaunchIngress.cs`
- Modify: `host/native/windows-bootstrap-guardian/GuardianProtocol.cs`
- Modify: `host/native/windows-bootstrap-guardian/Program.cs`
- Modify: `host/native/windows-bootstrap-guardian/WindowsJobOwner.cs`
- Modify: `host/native/windows-bootstrap-guardian/guardian-live.test.mjs`
- Modify: `host/src/stardew-bootstrap-guardian.private.ts`
- Modify: `host/src/stardew-bootstrap-guardian.private.test.ts`
- Modify: `host/src/stardew-private-bootstrap-composer.ts` only for the Task 2 additions to the already-destructively-upgraded sole owner schema
- Modify: `host/src/stardew-private-bootstrap-composer.core.ts` only for strict Task 2 owner validation, transition CAS, and durable recovery ownership
- Modify: `host/src/stardew-private-bootstrap-composer.test.ts` only for closing/recovering/contained/quarantined, stale-revision, and persistence-failure owner-record regressions
- Modify: `host/src/windows-bootstrap-guardian/protocol.ts` only for the exact redacted Task 2 recovery request grammar and TypeScript/native parity; it may carry attempt correlation plus fresh `recoveryInstanceId`, never record revision, lease/Job names, durable states or native facts
- Modify: `host/src/windows-bootstrap-guardian/index.ts` only for matching type exports, narrow wrapper signatures and comments; it remains a pair-revalidating `kept_unavailable` public adapter with no resident launch, private pipe, native recovery or durable mutation authority
- Modify: `host/src/windows-bootstrap-guardian/index.test.ts` only for TypeScript/native recovery grammar parity and redaction assertions
- Modify: `host/src/windows-bootstrap-guardian/native-integration.test.ts` only for fixed compiled recovery-protocol fail-closed assertions

**Interfaces:**
- Produces private `StardewBootstrapGuardianOwner` with `arm`, `launchPlayerHost`, `launchAiClient`, `containPlayerHost`, `containAiClient`, `recoverOrQuarantine`, and `close`; the containment methods preserve the approved Player survival policy, and `recoverOrQuarantine` has no Player-recovery authority. Any Player termination remains outside this task in the separately authenticated `End Game` lifecycle.
- Destructively replaces owner/v3 with strict owner/v4. The sole record contains immutable attempt correlation and `{bindingRevision, guardianInstanceId, guardianEpoch, leaseName, playerJobName, aiJobName}`, mutable positive `ownerRecordRevision`, parent/guardian/role states, and nullable `recoveryInstanceId`. No v3 reader or migration remains.
- A newly created same-name mutex is only a successor recovery gate; it is not the old lease object. An existing same-name mutex returns `unavailable` and permits zero Job access.
- The sole redacted native recovery command is `recover_attempt` with exact attempt correlation plus fresh `recoveryInstanceId`; `begin_recovery` is deleted with no compatibility grammar. The fixed launcher injects required private `GAMEBUDDY_GUARDIAN_MODE=resident|recovery` plus fresh control pipe/token; missing or unknown mode fails closed with no absence fallback, and role environments strip all three variables. Recovery mode branches before the resident loop and uses one authenticated private session with two distinct one-shot phases. The pre-CAS gate binding carries only correlation, immutable binding revision, and exact lease name, permitting only successor-mutex acquisition and zero Job access. After gate acquisition and durable Host CAS to `recovering`, the post-CAS classification binding carries the same correlation/recovery actor, immutable binding revision, latest owner-record revision, exact lease/Job names, and current durable role states. These facts never enter public protocol, logs or responses.
- Produces only `contained | unavailable | quarantined` to private recovery callers.

- [ ] **Step 1: Write failing lease/EOF/recovery tests**

Cover:

```text
EOF before CreateProcess, after suspended create, after membership query, and before resume
one shared native state gate covers the final closing/launch deadline check through ResumeThread; EOF linearizes through the same gate (contain/recover use their separately owned operation wait budgets, not the launch deadline)
queued authenticated launch is discarded when closing linearizes
raw EOF drains/releases/exits without durable writes; later successor recovery owns terminalization
controlled close durably writes closing before AI drain and records no Player containment
recovery while old lease is held performs zero Job opens and zero contained writes
native and TypeScript accept only exact `recover_attempt + recoveryInstanceId`; they reject deleted `begin_recovery`, unknown fields, stale epoch/revision, recovery takeover and mismatched private bindings
old guardian releases lease only after AI Job drain; Player remains alive under non-kill-on-close policy
the authenticated pre-CAS binding provides only the exact lease locator; recovery creates and owns a new same-name successor mutex generation, while an existing mutex performs zero Job access and consumes no post-CAS binding
recovery durably CASes recovering + fresh recoveryInstanceId before the one-shot post-CAS classification binding and before any Job access
existing exact AI Job is configuration/ACL verified, terminated, drained and queried active-zero
missing exact AI Job is accepted only for a durable-armed AI role under unchanged sole-handle binding; missing unarmed AI role quarantines; Player recovery remains unavailable
AI contained with Player surviving keeps the parent unavailable/quarantined
successor arm remains unavailable because Player recovery is unavailable
stale revision, recovery takeover or persistence failure never produces contained
```

- [ ] **Step 2: Run native and TypeScript tests red**

```powershell
cd host
pnpm run build:test
node --test --test-concurrency=1 native/windows-bootstrap-guardian/guardian-live.test.mjs
node --test --test-concurrency=1 dist-test/stardew-private-bootstrap-composer.test.js dist-test/stardew-bootstrap-guardian.private.test.js dist-test/windows-bootstrap-guardian/index.test.js dist-test/windows-bootstrap-guardian/native-integration.test.js
```

Task 2 must begin only from a passing Task 1 build and fixture matrix. The named `dist-test` files are rebuilt after the Task 2 owner-schema changes; previously emitted Task 1 JavaScript is not Task 2 evidence.

- [ ] **Step 3: Extend the strict private record for recovery ownership**

Task 1's sole bootstrap `owner.json` v3 contains the immutable binding revision and opaque lease/Job names but does not contain Task 2 lifecycle CAS. Destructively replace it with strict owner/v4; reject v3 with no migration, import, fallback or read-repair. V4 adds immutable `guardianInstanceId` and positive `guardianEpoch`, separates immutable `bindingRevision` from monotonic positive `ownerRecordRevision`, and adds parent/guardian/role lifecycle state plus nullable `recoveryInstanceId`. Every transition fresh-reads under the existing path lock, compares record revision and the complete immutable fence tuple, atomically writes revision + 1, strict-rereads the successor, and never overwrites from a stale cached record. A generic stale-lock result can select a dead Node owner but cannot clear or infer containment.

The strict state matrix is:

```text
initial: parent reserved; guardian reserved; both roles reserved; recoveryInstanceId null
armed: parent reserved; guardian armed; each created role armed; no role may be active before its armed acknowledgement CAS
running: parent reserved; guardian armed; each role independently armed | active | contained
controlled close: parent closing; guardian closing; the AI role closing or contained; Player remains active/nonterminal; recoveryInstanceId null
raw EOF/crash record: any previously durable reserved | armed | active | closing combination remains nonterminal; native EOF writes no state; Player remains outside containment
recovering initial: parent recovering; guardian recovering; fresh non-null recoveryInstanceId; the AI role retains its last durable nonterminal state; Player remains active/nonterminal and is not classified
recovering partial: parent recovering; guardian recovering; the same non-null recoveryInstanceId; AI may become contained while Player remains active/nonterminal
terminal AI-contained: AI role contained, Player still active/nonterminal, parent and guardian remain unavailable/quarantined; this task never projects full containment
terminal quarantined: parent quarantined; guardian quarantined; every non-contained AI role quarantined; Player remains outside recovery; never projected as success
```

Exact-key validation rejects every other combination. The AI recovery classification CAS must compare the same persisted `recoveryInstanceId`, the complete immutable fence and the latest `ownerRecordRevision`; it may change only the AI role to `contained` while parent and guardian remain `recovering` or unavailable. The Player role cannot regress, change identity, be opened, or be marked contained by this task. Any AI classification or persistence failure transitions the attempt to terminal quarantine rather than preserving a partial success claim. Normal controlled close and recovery never use Player containment as a completion condition: an AI-contained result leaves Player/world alive and the parent unavailable/quarantined. Final persistence failure leaves the record in closing/recovering or transitions it to quarantined; it never writes parent contained.

- [ ] **Step 4: Extend the lease-ordered native state machine**

```text
resident guardian holds the exact recorded lease generation
raw Host EOF → one native state-gate linearization to closing → discard queue → contain/drain AI Job → close AI Job handle → leave Player alive → release lease last → exit, with zero durable-record writes
controlled close while Host is alive → Host CAS closing → native AI drain acknowledgement → record AI outcome without Player containment → release/exit; ordinary close is not End Game
crash/EOF recovery strict-reads nonterminal v4 → establishes a separate authenticated private recovery session → consumes the pre-CAS gate binding → atomically creates a new same-name mutex with initial ownership; ERROR_ALREADY_EXISTS is unavailable with zero Job access
while holding the new recovery gate → Host CAS recovering + fresh recoveryInstanceId → strict-reread → consume the post-CAS classification binding → classify only the exact recorded AI Job
existing AI Job → verify expected KILL_ON_JOB_CLOSE/no-breakaway and readable security facts → terminate/drain/query-zero → durable AI-contained CAS
FILE_NOT_FOUND → AI-contained only for unchanged durable-armed AI role under sole-handle/no-inheritance invariant; otherwise quarantine
AI role durable contained → keep Player and parent unavailable/quarantined → release recovery gate; no successor arm or registration consume
```

Any mismatch or ambiguity returns a fixed redacted unavailable/quarantined category. The native recovery coordinator is selected only by exact private launcher mode `recovery`, branches before the resident Guardian public-command/EOF loop, and never treats a public frame as a mode selector during Batch C. In recovery mode the private pre-CAS frame precedes gate acquisition, the post-CAS frame follows durable recovering CAS, and only then may stdin authorize the exact `recover_attempt` with the same recovery actor. Recovery never waits for or adopts an abandoned/existing old mutex, never recreates a same-name Job as evidence, and never treats root exit or a missing unarmed AI Job as containment. The old guardian cannot accept or execute commands after `closing` or lease release. The shared native state gate covers the final closing/deadline check and `ResumeThread` as one critical section: if EOF wins, the AI root is never resumed; if resume wins, EOF must contain/drain that active AI role, while the Player root remains governed by its non-kill-on-close survival policy. Same-SID hostile manipulation is outside this contract and must trigger a future protected service/separate-SID redesign rather than an in-process fallback.

- [ ] **Step 5: Run crash/lease matrix**

Run native matrix serially and private record tests. Include guardian crash before arm, after two Jobs arm, during each role launch, during close, and after AI drain. Prove: held old lease gives zero Job access; newly created recovery gate ownership precedes the durable recovering CAS; that CAS precedes every AI Job operation; the AI Job is verified and fully drained; Player survives ordinary close, controller EOF, AI failure and Guardian last-handle close; FILE_NOT_FOUND passes only for a durable-armed AI role; missing unarmed, access denied, unexpected object type, stale revision, recovery takeover and persistence failure quarantine; Player recovery is unavailable and AI containment never clears the parent or permits a successor.

- [ ] **Step 6: Fresh lifecycle-recovery review and atomic commit**

Reviewer traces every irreversible boundary against durable state and verifies no successor can launch on partial evidence.

---

## Task 3: Delegate production role ownership without changing product topology

**Current topology decision (implementation pending):** Task 3 must consume the formal Desktop bootstrap as the only Host product composition root. The authenticated `DesktopGuardianSession` reaches the selected Stardew lifecycle only through the private composition-owned typed capability; `dialogue-web-main` remains a browser/product helper and cannot construct another Stardew lifecycle root. Do not add a global session registry, second entry, browser handoff, or raw pipe/token/session fields. Create the lifecycle-owned, invocation-specific `RoleLaunchOperation` deadline/budget only after fresh admission/reservation and launch preconditions, with no inherited or invented deadline. Preserve the same contract for future games and third-party integrations.

**Exact next slice / owned files:**
- Desktop bootstrap owner: `desktop/GameBuddy.Desktop/Program.cs`, `desktop/GameBuddy.Desktop/RuntimeSupervisor.cs`, `desktop/GameBuddy.Desktop/DesktopHostBootstrapBroker.cs`, `desktop/GameBuddy.Desktop/GuardianSupervisor.cs` and their focused tests.
- Host composition and lifecycle owner: `host/src/bootstrap/entry/desktop-host-entry.internal.ts`, `host/src/bootstrap/wire/desktop-runtime-bootstrap.internal.ts`, `host/src/composition/desktop-host-composition.ts`, `host/src/stardew-production-lifecycle-coordinator.internal.ts`, `host/src/games/stardew/lifecycle/stardew-private-bootstrap-composer.internal.ts`, `host/src/dialogue-web-main.ts` and focused tests.

**Files:**
- Modify: `host/src/stardew-private-bootstrap-composer.core.ts`
- Modify: `host/src/stardew-private-bootstrap-composer.test.ts`
- Modify: `host/src/games/stardew/lifecycle/stardew-player-host-process-owner.ts`
- Modify: `host/src/games/stardew/lifecycle/stardew-player-host-process-owner.test.ts`
- Modify: `host/src/games/stardew/lifecycle/stardew-ai-client-process-owner.ts`
- Modify: `host/src/games/stardew/lifecycle/stardew-ai-client-process-owner.test.ts`
- Modify: `host/src/stardew-production-lifecycle-coordinator.internal.test.ts` only for delegation/teardown regressions

**Interfaces:**
- Predecessor: the native Desktop generation launcher must start the exact inventory-attested resident Guardian and own its process/control EOF without Node pathname spawn, a second provenance verifier, or a generic launcher seam. If that launcher is not implemented and independently reviewed, Task 3 remains blocked.
- Consumes: Task 2 `StardewBootstrapGuardianOwner` and existing admitted private role configuration.
- Produces: existing redacted process-owner/lifecycle interfaces backed by Guardian acknowledgements rather than production Node `ChildProcess` ownership.

- [x] **Step 1: Write failing delegation tests**

Prove staged Player Host/D create one-shot private launch plans only after existing fresh rereads/reservations; Player and AI delegates consume the correct role; AI disconnect contains only AI; ordinary close contains AI while preserving Player/world survival and is not `End Game`; semantic-enter/attestation failures quarantine; no public DTO gains Guardian facts.

**Closed 2026-09-26.** `stardew-production-lifecycle-coordinator.internal.test.ts` covers every requirement:
`contained Player Host success constructs the real contained runtime and session launch with exact typed-facts plan and 60s deadline`,
`contained Player Host decision failing before the claim restores staged with zero session calls and a retry succeeds`,
`contained AI and Player roles share one per-owner runtime, a no-pid stop is a success no-op, and close contains both roles then closes once`,
`ordinary close preserves the Player Host and never invokes its explicit stop`,
`manifest-admitted semantic Game enter failure is one-shot uncertain and closes its facade`,
`activation stages the durable Player Host profile without spawning and returns a frozen redacted revision-3 snapshot`, plus eight quarantine cases.
`ordinary close` is not `End Game`: the coordinator contains no `endGame`/`end_game`/explicit-stop call at all. The other three owner/composer suites in Step 2 are green: 110 + 104 tests.

- [x] **Step 2: Run focused Host tests red**

Run from `host/`:

```powershell
pnpm run build:test
node --test --test-concurrency=1 `
  dist-test/stardew-private-bootstrap-composer.test.js `
  dist-test/stardew-player-host-process-owner.test.js `
  dist-test/stardew-ai-client-process-owner.test.js `
  dist-test/stardew-production-lifecycle-coordinator.internal.test.js
```

The build step must produce the named `dist-test` files before the red assertions are evaluated.

**Closed 2026-09-26 (green, not red).** The tests already existed and pass: `stardew-private-bootstrap-composer.test.js` 104/104 (it is emitted under `dist-test/games/stardew/lifecycle/`, not `dist-test/`), and the owner plus coordinator trio 110/110. They were never red in this session because the delegation implementation landed with them; the checker-detected layering defect below is what was actually outstanding.

- [x] **Step 3: Replace only production process authority**

Remove production direct spawn/kill ownership in the two process owners and delegate to Guardian through the Host composition-owned `ContainedGameRuntime` and its sole narrow `runtime/contract/game-runtime.ts` seam. Composition alone imports runtime/core. Create one per-invocation `RoleLaunchOperation` deadline only for `launch_role`, after the existing fresh admission/preconditions and launch decision; arm/contain/recover use separately owned operation wait budgets only when wired, and runtime lifetime is never a timeout. Preserve explicit test-only raw process fixtures. Do not pass raw session/pipe/PID/Job/token/path, use a global registry/daemon/browser handoff or fallback, or change installation admission, browser contracts, attachment protocol, action behavior, Preview, Portfolio, or direct-route topology in this task.

**Closed 2026-09-26.** `stardew-player-host-process-owner.ts` and `stardew-ai-client-process-owner.ts` are now type-only modules: no `spawn`, no `node:child_process`, no raw process authority. Production delegation goes through `createStardewPlayerHostRuntimeLaunchCollaboratorFactory` → `ContainedGameRuntime.launchRole/containRole/close`, and `createStardewProductionLifecycleCoordinator` fails both roles closed (`stardew_player_host_launch_runtime_unavailable` / `stardew_ai_client_launch_runtime_unavailable`) when no collaborator is injected, so no direct-spawn fallback remains in production. The `RoleLaunchOperation` deadline is created per invocation after the launch decision; arm/contain use the separately owned `DESKTOP_RUNTIME_OPERATION_WAIT_BUDGET_MS`.

**Closure note 2026-09-26:** the platform binding had been placed inside `games/stardew/lifecycle/contained-game-runtime-platform.private.ts`, which imported `containment/runtime/core`, the auth transport and the Windows folder picker, and produced `Uint8Array` native frames — a frozen Shape B violation. ADR-0007 puts that binding in composition, and the seam checker had flattened the asymmetry so it could not be written there. Commit `48ec29e` restored the checker's direction (`composition -> runtime/core + one selected game adapter`; `bootstrap`/`containment` stay game-free) and moved the binding to `host/src/composition/stardew/stardew-guardian-platform.ts`. `games/stardew/provider.ts` now receives the admitted folder picker and launch collaborator as opaque injected capabilities, and the game layer no longer imports `runtime/core`, the auth transport or any raw Windows module, nor exposes platform-frame bytes.

- [x] **Step 4: Run focused lifecycle matrix**

Expected: existing staged Player Host/D, attestation, Game enter, STOP/disconnect, recovery, quarantine, and reverse teardown tests remain green; production import inventory shows Guardian private core only in approved owner/composer modules.

**Closed 2026-09-26.** Owner + coordinator + composer suites are green (110 + 104). Production import inventory: `containment/runtime/core/contained-game-runtime` has exactly one production importer, `composition/stardew/stardew-guardian-platform.ts`, which is the ADR-0007-sanctioned site; `containment/auth/desktop-guardian-session.internal` is reached in production only from `composition/desktop-host-composition.ts`, `bootstrap/wire/desktop-runtime-bootstrap.internal.ts`, `composition/stardew/stardew-guardian-platform.ts` and the game-side `games/stardew/lifecycle/stardew-bootstrap-guardian.private.ts` (the last is on the checker's approved game-side allowlist). `node tools/check-host-game-physical-seam.mjs` reports `passed` over 17 production files with zero violations, and its suite is 17/17.

- [x] **Step 5: Fresh authority/topology review and atomic commit**

Reviewer confirms the coordinator remains product owner, Guardian owns only OS containment, and no alternate launch path or compatibility fallback remains.

**Closed 2026-09-26.** The coordinator remains the sole product lifecycle owner (activation, admission, reservation, attestation, STOP, recovery, teardown); `ContainedGameRuntime` owns platform containment and projects only redacted `{role, status}` outcomes. No alternate launch path remains: the game-side platform adapter was deleted (not aliased), production factories fail closed without the injected collaborator, and `desktop-host-composition.test.ts` keeps a reachability lock asserting the retired tokenless Guardian seam is retained but never invoked. Commits: the delegation itself plus `48ec29e` (layering correction).

---

## Task 4: Deterministic closure and current-owner status update

**Files:**
- Modify only tests required to complete the matrix.
- Modify: `design/domains/stardew/integration.md` after all evidence/review passes.
- Move this task to completed only after owner closure.

- [x] **Step 1: Complete Windows security matrix**

Required evidence:

```text
real membership-before-user-code
both-role isolation and drain
EOF at every irreversible launch boundary
guardian crash and last-handle descendant drain
released-lease recovery ordering
name collision and stale epoch rejection
outer-Job unsupported outcome fails closed
creation-time Job/lease security descriptors allow only the current SID and minimum required access masks
cross-user Job/lease open/query/modify/terminate/assign/release denial using a configured disposable secondary user
same-user recovery can open only exact record-bound objects
pre-existing same-name objects are rejected without ACL rewrite
no inherited Job/lease handles
```

**Closed 2026-09-26.** All twelve items have evidence. Eleven are covered by the existing matrix plus five tests added to `host/native/windows-bootstrap-guardian/guardian-live.test.mjs` (60/60 green):

| Item | Evidence |
|---|---|
| membership-before-user-code | `atomic membership before first user code`; fixture asserts `IsProcessInJob` as its first executable action |
| both-role isolation and drain | `role Jobs isolate Player from AI and drain AI descendants` |
| EOF at every irreversible launch boundary | `resident EOF gates suspended launch boundaries` |
| guardian crash / last-handle drain | `Player survives production Guardian crash/last-handle close while AI exits` |
| released-lease recovery ordering | `C2 recovery ingress rejects wrong token, preserves authorization ordering, ...` |
| name collision and stale epoch rejection | `pre-existing lease, Job, and control-pipe names reject arm without adoption` (collision) + **new** `Task 4 item 6: arm fixes the active correlation so a stale epoch cannot drive launch or recovery` |
| outer-Job unsupported outcome fails closed | **new** `Task 4 item 7: a role launched under an outer Job stays a Job member, or fails closed by name` |
| creation-time SD allows only current SID and minimum access masks | **new** `Task 4 item 8: the creation-time Job DACL is exactly the current SID with the minimum mask` — reads the live DACL through a new `--probe-job-dacl` fixture probe and asserts `dacl_protected=true` (the `D:P` protection flag) and exactly one ACE with mask `0x0012000c` |
| same-user recovery opens only exact record-bound objects | **new** `Task 4 item 10: recovery classification keys on the exact object, never the name alone` |
| pre-existing same-name objects rejected without ACL rewrite | `pre-existing lease, Job, and control-pipe names reject arm without adoption` |
| no inherited Job/lease handles | **new** `Task 4 item 12: role creation and both security attributes pass bInheritHandle = false` |

**Item 9 (cross-user denial) — owner waiver, 2026-09-26.** No secondary Windows account is created and no `GAMEBUDDY_WINDOWS_SECONDARY_TEST_USER` harness is built. The protection is carried by item 8 instead, which is strictly stronger for the property that matters: item 8 reads the live DACL and asserts **exactly one ACE, the current SID, with mask `0x0012000c`, under a protected (`D:P`) descriptor**. A cross-user probe can only test whether Windows honours the DACL — which the OS has done since NT and which no change to this repository can affect. It cannot detect the failure this repository can actually cause: someone relaxing the hand-written SDDL literal (`0x0012000C` widened, `{sid}` dropped, `D:P` downgraded to `D:`) or adding a second ACE. Item 8 fails on every one of those, and additionally catches a same-user over-grant that a cross-user probe would pass.

This waiver is written down rather than silently skipped because the plan's original text stated the opposite ("Missing secondary-user setup is a blocked gate, not a pass"). The replacement is recorded here so a later reader sees the deliberate decision and its reasoning, and the retirement follows the plan's own Ceremonial verification audit row for wrong role ownership ("merge duplicate post-hoc artifact proofs at that boundary").

- [ ] **Step 2: Run deterministic closure**

```powershell
cd host
node scripts/build-windows-bootstrap-guardian.mjs
node --test --test-concurrency=1 native/windows-bootstrap-guardian/guardian-live.test.mjs
pnpm run build:test
node --test --test-concurrency=1 `
  dist-test/windows-bootstrap-guardian/index.test.js `
  dist-test/windows-bootstrap-guardian/native-integration.test.js `
  dist-test/stardew-bootstrap-guardian.private.test.js `
  dist-test/stardew-private-bootstrap-composer.test.js `
  dist-test/stardew-player-host-process-owner.test.js `
  dist-test/stardew-ai-client-process-owner.test.js `
  dist-test/stardew-production-lifecycle-coordinator.internal.test.js
pnpm run typecheck
cd ..
git diff --check -- host/native/windows-bootstrap-guardian host/src/windows-bootstrap-guardian host/src/stardew-bootstrap-guardian.private.ts host/src/stardew-private-bootstrap-composer.core.ts host/src/games/stardew/lifecycle/stardew-player-host-process-owner.ts host/src/games/stardew/lifecycle/stardew-ai-client-process-owner.ts
npm --prefix design run check
```

Full-repository failures outside changed ownership remain residuals only when scoped compilation and all named suites pass and the failure is demonstrably pre-existing.

- [ ] **Step 3: Two independent reviews**

Native-security reviewer answers:

1. Is role membership established at creation before user code?
2. Are Job/lease ACLs, handle inheritance and last-handle semantics proven?
3. Can EOF, crash, stale epoch, or outer Job ever trigger breakaway/fallback/resume?
4. Is containment based on full Job drain rather than root exit?

Lifecycle-recovery reviewer answers:

1. Does recovery acquire the released exact lease and persist ownership before opening Jobs?
2. Can partial/ambiguous evidence clear the parent fence or admit a successor?
3. Does AI-only containment preserve Player ownership?
4. Are Guardian facts absent from public/product surfaces?
5. Does the coordinator remain the sole product lifecycle owner?

- [ ] **Step 4: Update current owner only after acceptance**

Change `design/domains/stardew/integration.md` from containment incomplete to a factual closed statement naming the production implementation, deterministic Windows matrix, and independent reviews. Do not activate installation registration or topology consolidation unless their separate gates are satisfied.

- [ ] **Step 5: Commit closure**

Commit only closure tests and current-owner factual status. Do not run Stardew or claim player-release completion.

## Acceptance criteria

- [ ] Player Host and AI Client direct roots are in independent non-breakaway Jobs at process creation, before user code; only AI Client uses kill-on-close, while Player Host uses non-kill-on-close.
- [ ] Guardian verifies membership and exact lease/control state before resume.
- [ ] Host EOF and guardian failure contain/drain the AI role and discard delayed commands while preserving the Player Host/game world.
- [ ] Role containment requires Job drain/query proof; direct-root exit is insufficient.
- [ ] Recovery cannot open the AI Job or mutate AI containment while the old guardian lease is held; it never opens or mutates the Player Job.
- [ ] Recovery persists exact ownership before checking the AI Job; Player recovery is unavailable, so AI containment never clears the parent fence or permits a successor.
- [ ] Missing/ambiguous/access-denied/mismatched/persistence-failed AI-recovery states remain quarantined and permit no successor; Player recovery remains unavailable.
- [ ] Production role owners delegate OS containment to Guardian while coordinator/product semantics remain unchanged.
- [ ] No public protocol/surface exposes executable, path, PID, Job, lease, bridge, token, profile, or raw Win32 facts.
- [ ] Required Windows fixture, ACL, crash, handle-lifetime and lifecycle suites pass.
- [ ] Fresh native-security and lifecycle-recovery reviews report no blocker/high issue.
- [ ] The current Stardew domain owner records the AI containment boundary only after the preceding facts exist; it does not claim Player recovery or full containment.

## Stop conditions

Stop the current task rather than adding a fallback if:

- atomic `PROC_THREAD_ATTRIBUTE_JOB_LIST` launch cannot be proven on the supported Windows environment;
- the guardian requires breakaway, shell/wrapper, post-create assignment, broad DACL, inherited handles, or caller-selected executable facts;
- EOF cannot linearize ahead of delayed create/resume;
- recovery cannot acquire a released exact lease and persist ownership before Job access;
- either Job cannot be fully drained/classified or the parent fence cannot remain quarantined;
- implementation requires installation registration, direct-route removal, Browser/Preview/Portfolio changes, or live Stardew;
- deterministic tests cannot distinguish full descendant containment from direct-root exit.


## Superseded Player-role lifetime assumption

The [Game session survival simplification](game-session-survival-and-reconnect-simplification.md) explicitly supersedes this task's incompatible assumption that both role Jobs use `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, that ordinary close/EOF performs full two-role termination, or that recovery can classify and terminate the Player role. This is a supersession, not a compatibility mode or fallback. Guardian creation-time containment, AI cleanup/recovery, exact lease/state ordering, and fail-closed quarantine remain owned here. Player Host uses the approved non-kill-on-close Job; AI Client retains kill-on-close. Ordinary GameBuddy close, AI crash, controller EOF, and Guardian last-handle close must preserve the Player Host/game world and do not equal `End Game`. Player recovery is unavailable: recovery must not open, terminate, drain, classify, or claim containment for the Player Job, and AI cleanup alone cannot clear the parent fence or permit a successor. Only a separate authenticated `End Game` operation may terminate the Player. This clarification does not authorize deleting the existing CAS: each field must be reviewed for stale-controller exclusion, process ownership and settlement, while no field may authorize old-task resumption or replay.
