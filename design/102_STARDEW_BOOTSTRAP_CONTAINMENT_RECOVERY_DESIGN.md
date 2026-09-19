# Stardew Bootstrap Containment and Recovery Design

**Status:** Proposed. No implementation, installation registration, headless activation, operational-gate migration, or Task 11 live mutation is authorized until this design and its deterministic Windows verifier matrix are independently reviewed.

**Owner:** The shipped two-role Stardew product lifecycle, beneath `StardewProductionLifecycleCoordinator`.

**Predecessors:** `AGENTS.md`; `design/91_OPEN_GAMEPLAY_PIPELINE_RELEASE_IMPLEMENTATION_PLAN.md`; `design/99_STARDEW_PRODUCT_SESSION_MATERIALIZATION_DESIGN.md`; the frozen boundary (not implementation closure) of `design/100_STARDEW_OPERATIONAL_GATE_PRODUCT_COMPOSITION_DESIGN.md`; and the frozen boundary (not implementation closure) of `design/101_STARDEW_PRODUCT_INSTALLATION_REGISTRATION_DESIGN.md`.

**Successors:** Design 101 installation-registration implementation; Design 100 private headless activation; Design 104 public Game setup/launch journey; Task 10 operational-gate migration; Task 11 target-version live gate.

**Primary platform references:** [Job Objects](https://learn.microsoft.com/windows/win32/procthread/job-objects), [`CreateJobObjectW`](https://learn.microsoft.com/windows/win32/api/jobapi2/nf-jobapi2-createjobobjectw), [`PROC_THREAD_ATTRIBUTE_JOB_LIST`](https://learn.microsoft.com/windows/win32/procthread/proc-thread-attribute-list), [`TerminateJobObject`](https://learn.microsoft.com/windows/win32/api/jobapi2/nf-jobapi2-terminatejobobject), and [`QueryInformationJobObject`](https://learn.microsoft.com/windows/win32/api/jobapi2/nf-jobapi2-queryinformationjobobject).

## Superseding policy: Player and game-world survival

The [Game session survival and reconnect simplification](tasks/active/game-session-survival-and-reconnect-simplification.md) supersedes the incompatible Player-role lifetime clauses that previously appeared in this design. This is an explicit supersession, not a compatibility mode or fallback: the old two-role `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, full-close/EOF termination of both roles, and Player recovery clauses no longer govern.

The current boundary is:

- **Creation-time containment remains mandatory.** The Player Host direct root is created suspended in its exact non-breakaway Job and membership is verified before resume, but the Player Job is **non-kill-on-close**. The AI Client Job remains non-breakaway and `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
- **AI cleanup/recovery remains in scope.** Authenticated normal close, controller EOF, Guardian failure, and dedicated recovery may stop and drain the exact AI Job under the lease/state ordering below. They must not use AI cleanup as evidence that the Player was contained.
- **Player/game-world survival is mandatory.** Ordinary GameBuddy close, controller EOF, AI crash, and Guardian failure/last-handle close must leave the GameBuddy-started Player Host and game world alive. Ordinary close is not `End Game`.
- **Player recovery is unavailable.** Recovery must not adopt, reopen, terminate, or classify the Player Job, and may not claim Player containment. When the Player remains alive, the parent attempt stays `unavailable`/quarantined and no successor arm or registration consume is permitted merely because AI cleanup succeeded.
- Only a separate authenticated `End Game` operation may terminate the Player. That operation is outside this design's ordinary close and recovery path.

## 1. Problem

The current production private bootstrap path starts Player Host and AI Client with Node `spawn()`. The corresponding process owners retain only a `ChildProcess`, PID, and creation date in the current Host process. The durable bootstrap owner records reservation and cleanup intent, but not a reopenable cross-process containment authority.

This is sufficient for same-process normal close but not for a Host crash:

```text
Host A starts one or both role processes
→ Host A crashes before its coordinator reverse teardown
→ generic stale-lock reclaimer proves only Host A's Node PID is dead
→ Host B would otherwise obtain a new installation-registration lease
→ Host B could create a second attempt while role processes from A survive
```

A generic stale-lock reclaimer may reclaim a `.lock` leaf after verified dead-owner proof. It must never be interpreted as proof that the Player Host, AI Client, their descendants, bridge effects, or bootstrap owner from the old attempt were contained. PID/name matching and `ChildProcess.kill()` are not a cross-process process-tree authority.

## 2. Decision

Each owned product bootstrap attempt receives one **resident, GameBuddy-owned native containment guardian** and two independent role Jobs:

```text
parent attempt fence / private guardian record
├─ Player Host role Job: non-breakaway, non-kill-on-close (survives GameBuddy close)
└─ AI Client role Job: non-breakaway, kill-on-close
```

The guardian is outside both role Jobs and remains resident for the attempt. The Host communicates with it over a private current-user authenticated control channel whose EOF is observable by the guardian. At arm, the guardian creates and acquires an opaque, ACL-protected **guardian-exclusive lease** for its exact `guardianInstanceId` and monotonically increasing `guardianEpoch`; it holds that lease until AI cleanup/recovery has reached its terminal conclusion or normal close has completed its AI-side drain. Releasing the lease must not close a kill-on-close Player Job handle or terminate the Player Host/game world. The Host never obtains role Job handles or the guardian lease; browser, Preview, Portfolio, operator config, run manifest, child IPC, and operational runner receive neither role Job identity nor guardian authority.

A role root is not created by Node. The guardian creates it directly in the exact role Job with `STARTUPINFOEX` and `PROC_THREAD_ATTRIBUTE_JOB_LIST`; it verifies membership before allowing the root to execute:

```text
persist parent fence + reserved opaque role job identities
→ guardian creates both named role Jobs with explicit ACLs
→ guardian arms non-breakaway limits; applies KILL_ON_JOB_CLOSE only to the AI Client Job
→ guardian durably acknowledges armed state
→ guardian CreateProcessW(CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT,
                          PROC_THREAD_ATTRIBUTE_JOB_LIST = exact role Job)
→ guardian verifies direct-root membership in exact role Job
→ guardian ResumeThread
→ Node receives only a redacted role launch acknowledgement
```

`CreateProcessW(CREATE_SUSPENDED)` followed by a later `AssignProcessToJobObject()` is forbidden. A guardian crash between those calls can strand a suspended child outside a role Job. No fallback to Node `spawn`, direct `AssignProcessToJobObject`, shell, wrapper, `cmd.exe`, `CREATE_BREAKAWAY_FROM_JOB`, `JOB_OBJECT_LIMIT_BREAKAWAY_OK`, or `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK` is permitted.

## 3. Authority graph and boundaries

```text
private bootstrap composition
→ persistent attempt fence + private guardian record
→ artifact-attested resident native guardian
→ per-role Windows Job containment and direct-role launch
→ existing Node process-owner redacted status adapters
→ existing coordinator Stage C/D, Design 99 materialization, enter, STOP, disconnect
→ reverse teardown requests to guardian
```

The guardian is a narrow OS-containment authority only. It does **not**:

- select/admit an installation or read an installation locator;
- create a bridge, receive pipe/token facts, choose a cabin, attach Farmhand, create a semantic facade, enter Game, own STOP semantics, or publish task ingress;
- decide that a Game action succeeded or emit source-owned Game evidence;
- expose generic process execution, arbitrary Job creation, arbitrary termination, arbitrary PID inspection, shell execution, or a raw Job handle API. The exact direct-role launch arguments required by `CreateProcessW` flow only inside an authenticated coordinator-private role-launch plan minted from the already admitted/bootstrap-owned role configuration; they are never a browser/runner/operator protocol input, a reusable public value, or a logged/persisted record.

`StardewProductionLifecycleCoordinator` remains the sole product owner of reservation, Stage C/D semantics, Player Host attestation, Farmhand attach, runtime materialization, Game enter, STOP, disconnect, quarantine, and reverse lifecycle order. The guardian only performs exactly named containment/launch/contain acknowledgements requested by that coordinator-private owner. `launch_role` accepts only an exact internally branded role-launch plan from that owner, bound to the guardian instance/epoch, role, and current bootstrap correlation; malformed, unbranded, cross-role, stale-epoch, or caller-constructed launch data is rejected before `CreateProcessW`.

## 4. Guardian identity and artifact provenance

The guardian is a long-lived win-x64 native executable shipped in the selected immutable Host artifact.

The concrete incident this provenance boundary prevents is launch of the wrong high-privilege containment binary: an app-root replacement/reparse, helper/manifest pair mix from another generation, partial update, or stale build directory could otherwise make Host start a binary that can create/terminate the Game process tree while believing it is the selected release guardian. Authenticode establishes publisher identity for public release but does not by itself select the exact active immutable generation or prevent a validly signed stale helper/manifest mix; ordinary ACLs do not detect partial/mixed publication. Therefore Design 102 reuses the existing production-inventory generation selection, fixed helper+canonical-manifest pair, non-reparse path proof, and pair digest comparison used by the folder picker/stale-lock helpers. It does not add a second inventory, nested attestation chain, per-operation hash, or runtime self-hash. When Design 103's signed generation verifier closes, signature result is an additional publication input, not a replacement for exact generation/pair selection.

The guardian itself is not a member of either role Job. It must be started without inheritable role Job handles and must create direct role roots with `bInheritHandles = FALSE`. A one-shot helper is insufficient: closing the last AI Job handle with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` terminates AI members, while closing the Player Job handle must not terminate the Player Host or game world. The resident guardian must retain the exact handles and its exact guardian-exclusive lease until normal AI containment or panic AI containment reaches a terminal conclusion. Host control EOF is a panic-containment command for AI authority: the guardian atomically transitions its command state to closing, discards queued-but-unexecuted role commands, rejects new commands, drains the AI Job, then releases its lease only while exiting. It must not terminate or classify the surviving Player as contained. A delayed command is never executed merely because it was authenticated before EOF.

A fresh guardian must refuse to adopt a pre-existing named Job. `CreateJobObjectW` reporting `ERROR_ALREADY_EXISTS` during initial arm is terminal unavailable/quarantine. Only the dedicated recovery operation may call `OpenJobObjectW`, and only after it has validated the exact durable guardian record and active attempt fence.

## 5. Private durable records

The existing bootstrap owner remains the lifecycle reservation record. Design 102 adds a private guardian record and strengthens the attempt-fence meaning used by Design 101.

### 5.1 Guardian record

The exact, bounded, versioned record is runtime-root-contained, access-controlled, atomically published, and strict-parsed. It binds the current bootstrap owner and contains only:

```ts
type StardewBootstrapGuardianRecordV1 = Readonly<{
  schemaVersion: 1;
  bootstrapId: string; // opaque private correlation
  registrationRevision: number;
  binding: Readonly<{
    runtimeRoot: string;
    principal: Readonly<{
      continuityId: string;
      companionId: string;
      playerId: string;
    }>;
    authorityGeneration: number;
  }>;
  guardian: Readonly<{
    instanceId: string;
    epoch: number;
    leaseName: string;
    state: "reserved" | "armed" | "closing" | "recovering" | "quarantined";
    recoveryInstanceId: string | null;
  }>;
  playerHost: Readonly<{ jobName: string; state: "reserved" | "armed" | "active" | "closing" | "contained" | "quarantined" }>;
  aiClient: Readonly<{ jobName: string; state: "reserved" | "armed" | "active" | "closing" | "contained" | "quarantined" }>;
}>;
```

`jobName`, `guardian.instanceId`, `guardian.leaseName`, and non-null `guardian.recoveryInstanceId` are opaque random private locators, not public identifiers or capabilities. They must not encode a principal, locator, executable, profile, pipe, token, PID, command line, or user input. The record contains no path to a role executable, current working directory, args, bridge fact, browser fact, process ID, `ChildProcess`, role Job handle, receipt, prompt, raw error, or success evidence. `epoch` is a bounded positive integer and is never a browser or launch generation.

The record is private implementation state, not an installation-registration record. A resident guardian writes only its own matching `instanceId`/`epoch` state while holding the exact lease. Recovery first acquires that released lease, writes `state: "recovering"` with a new `recoveryInstanceId`, and only that recovery instance may persist AI-contained/quarantined transitions; it never persists Player containment. A Player `contained` state, if later required by the separate authenticated `End Game` lifecycle, is not produced by ordinary close or this recovery operation. It may be read only by the guardian protocol adapter and dedicated bootstrap-owner-aware recovery authority. It is never projected to the browser, logs, telemetry, IPC reports, manifests, test snapshots, Preview, Portfolio, or runner.

### 5.2 Attempt-fence law

The parent attempt fence is written before a role effect and remains nonterminal while the Player Host/game world survives. AI containment may settle the AI role, but it cannot make the parent fence `contained`, authorize a successor arm, or authorize registration consume. Only the separate authenticated `End Game` lifecycle may settle the Player role and any corresponding parent terminal state; that operation is outside this design. A stale generic registration lock cannot clear, overwrite, or infer the fence state.

A process-A crash therefore leads only to `unavailable` for a successor until recovery has first acquired the exact guardian-exclusive lease for the recorded instance/epoch and then checked the exact AI Job. Player recovery is unavailable: recovery does not open, terminate, drain, or classify the Player Job. The lease is held by the resident guardian, not the Node Host. If the lease remains held, is access-denied, has mismatched ACL/correlation, or cannot be atomically acquired, recovery must keep the fence quarantined/unavailable and must not open the AI Job, write `contained`, or permit a successor. If the AI Job cannot then be opened, authenticated, queried, terminated, drained, or classified, the fence remains quarantined/unavailable. It is never released based on elapsed time, Node PID liveness, process name, or a missing one-time Node handle.

## 6. Job configuration and isolation

Each role Job is created under an explicit `SECURITY_ATTRIBUTES` descriptor:

- allow only the current user SID the minimum required Job rights for the guardian/recovery protocol; allow SYSTEM only if deployment requires it;
- do not grant `Everyone`, `Users`, `Interactive`, or a broad inherited default DACL;
- mark Job handles non-inheritable and start role children with handle inheritance disabled;
- use an opaque `Local\` namespace by default; `Global\` is forbidden unless a later design specifically proves a required cross-session topology and its additional security contract.

Each Job forbids both breakaway limits. Only the AI Client Job sets `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; the Player Host Job is explicitly non-kill-on-close so closing the Guardian or its last Player Job handle cannot terminate the Player Host/game world. The guardian must reject any environment that prevents the required Job relationship or attribute-list launch before creating a role root; it may not escape an outer Job through breakaway. The supported Windows version and nesting behavior are a required live helper verification item, not an assumption.

Current-user ACLs protect against other Windows users. They do not claim to protect against an adversarial process running under the same SID that can learn a private name. If the same-SID adversary is in scope, this design must be superseded by a protected service/SID boundary; it must not overstate a named Job ACL as sufficient isolation.

## 7. Normal role close

Role containment is separate from Game STOP and from the Player/world lifetime. STOP continues to settle work through the coordinator. Disconnect/attachment teardown may contain the AI Client role while the Player Host remains legitimately owned and active; it must not turn Player survival into a containment requirement.

For each role, the coordinator-private guardian command is accepted only while the guardian owns the exact recorded instance/epoch lease and its Host control channel remains live. AI cleanup commands follow the closing/lease rules below. Any Player termination command is outside ordinary close and recovery and is permitted only as part of the separately authenticated `End Game` lifecycle. The guardian rechecks lease ownership, matching record, closing state, and Host-control liveness immediately before `CreateProcessW`, after membership verification, and immediately before `ResumeThread`; loss, mismatch, closing state, or Host-control EOF triggers AI panic containment and forbids resume.

```text
persist role state = closing
→ reject new launch for that role
→ TerminateJobObject(exact role Job) or establish already-drained state
→ wait for Job signaled
→ QueryInformationJobObject confirms ActiveProcesses == 0
→ close exact role Job handle
→ durably write role state = contained
→ return fixed redacted acknowledgement
```

`TerminateJobObject` return is not containment proof. Direct-root exit is not descendant containment proof. The guardian may return AI contained only after the whole exact AI Job is drained. Player Host is not contained by ordinary close, controller EOF, AI failure, or Guardian last-handle close. Full attempt close therefore drains AI and closes the AI role authority, while leaving the Player Host/game world alive; only a separate authenticated `End Game` operation may terminate the Player.

Guardian protocol EOF, malformed/unauthenticated command, invariant violation, or guardian panic must attempt AI containment, wait/drain where possible, close the AI handle, and exit without claiming a successful lifecycle receipt or Player containment. If the Player remains alive, the attempt remains unavailable/quarantined rather than being promoted to fully contained.

## 8. Crash recovery

Recovery is a dedicated private bootstrap-owner-aware operation, not a feature of `withPathLock` or the generic stale-lock reclaimer:

```text
acquire exact runtime-root attempt/recovery lock
→ generic stale-lock result may select dead Node owner only
→ strict-read active attempt fence, bootstrap owner, guardian record
→ validate stable deployment binding, exact bootstrap correlation, current-user ACL, and both role states/names (without granting Player recovery authority)
→ open and atomically acquire the exact record-bound guardian lease only after the prior guardian has released it
→ because the old guardian cannot retain that lease after exit, prove it can no longer accept or execute queued/new role commands
→ atomically persist `guardian.state: recovering` plus a new recovery instance for that immutable recorded instance/epoch before opening the AI Job
→ do not open, terminate, drain, or classify the Player Host Job; Player recovery is unavailable
→ OpenJobObjectW exact AI Client role Job
→ terminate/drain/query/close the exact AI Job or conservatively classify the AI role
→ durably record only AI containment when proven; keep Player and parent nonterminal unavailable/quarantined
→ do not permit a later registration consume or successor arm on AI containment alone
```

Recovery is all-or-nothing for the AI containment authority, and explicitly unavailable for Player recovery. It never adopts a surviving role root, reuses a launch generation, revives an attachment, or restarts a role. It must not begin AI Job containment or write `contained` while the guardian-exclusive lease is held by a prior guardian. If the old guardian still holds the lease, recovery returns fixed redacted `unavailable` without mutating the record; if lease acquisition after release, recovery-ownership persistence, AI Job access, ACL/state validation, activity query, or AI classification is unavailable or ambiguous, recovery durably writes/keeps quarantine and the registration stays unavailable. A surviving Player Host/game world is not an error to repair and is never a basis for Player containment or successor admission.

A missing AI Job is not automatically containment. It can be accepted only after bounded rechecks and only when the strict record state proves the AI Job was already armed/created; otherwise the result is unavailable/quarantine. Player recovery is unavailable even if a Player Job is missing, because absence cannot authorize termination or a claim about Player/world state. No PID, command-line, process-name, or generic process-tree search is an acceptable substitute.

## 9. Required deterministic and Windows verification matrix

No live Game mutation is authorized by these tests. Native-helper live checks are limited to disposable helper-controlled child fixtures.

1. **Protocol and provenance:** strict protocol schema rejects unknown/duplicate fields, cross-role commands, malformed records, wrong correlation, stale generation/binding, and oversized input. Published capability rejects missing/replaced/reparse/helper-manifest/inventory mismatch.
2. **Atomic role launch:** an instrumented direct-root fixture proves the root starts in the exact role Job before user code executes, and runs only after guardian membership verification/resume. A forced failure before resume leaves no running root.
3. **Forbidden fallback:** static and direct tests prove production role launch does not use Node `spawn`, shell, `cmd.exe`, post-create `AssignProcessToJobObject`, breakaway flags, or an arbitrary process helper.
4. **Role isolation:** AI containment drains AI descendants while the Player Host role fixture remains active. Ordinary close and STOP do not terminate the Player Host or its world; STOP does not terminate the AI Job except through its separately owned AI authority settlement.
5. **Crash points:** inject guardian/process failure before arm, after both Jobs arm, during Player Host launch, during AI launch, during normal close, and after AI containment. The Player Host/game world must survive ordinary close, controller EOF, AI failure, and Guardian last-handle close. A successor must remain unavailable because Player recovery is unavailable; dedicated recovery may acquire the released exact guardian lease and complete only the AI check.
6. **Guardian lease/recovery race:** retain an authenticated delayed `launch_role`, crash the Host, and begin recovery. While the old guardian owns its lease, recovery must return unavailable without opening Jobs or writing `contained`. Guardian EOF handling must discard the delayed command and panic-contain AI. Once recovery has acquired the released exact lease and persisted recovery ownership, the old guardian has exited and must be unable to create or resume either role root; only then may recovery contain the AI role. Player recovery remains unavailable and no successor may arm.
7. **Recovery:** after simulated dead Host, recovery validates exact fence/record and released guardian lease, terminates/drains the exact AI Job, and records the AI outcome without claiming Player containment. A surviving Player Host/game world keeps the attempt `unavailable`/quarantined; AI cleanup alone never permits a successor launch or registration consume. Any absent/ambiguous/access-denied/mismatched lease or AI Job leaves durable quarantine and permits no successor launch.
8. **Windows security:** real two-user Windows test proves a second user cannot open/query/terminate/assign either role Job or acquire the guardian lease; the same current user recovery helper can open only the exact record-bound AI Job, while Player recovery has no Job-open path. Handle inheritance test proves child processes do not keep a hidden Job or lease handle alive.
9. **Guardian lifecycle:** unexpected Host control-channel loss triggers AI panic containment; guardian crash/last-handle behavior kills AI descendants but does not kill the Player Host/game world; a one-shot guardian is rejected. The guardian itself never joins a role Job.
10. **Coordinator continuity:** existing Stage C/D, Player Host attestation, AI attachment, semantic-enter failure, STOP/disconnect, and reverse teardown tests remain green when process owners delegate to guardian acknowledgements.
11. **Topology/redaction:** Preview, Portfolio, operator selection/config, browser DTOs, runners, run manifests, and generic launchers cannot import guardian private core. Browser/state/log/IPC/report captures contain neither job names nor guardian lease/epoch/instance identifiers nor locator/bridge/profile/PID/process details.

## 10. Stop condition and migration order

1. Implement this design's guardian/provenance/protocol/role-owner adapter and all deterministic Windows containment tests.
2. Obtain an independent review of exact authority flow, crash states, ACL behavior, no-fallback proof, redaction, and role-specific teardown.
3. Only then authorize Design 101's registration store and cross-process fence integration.
4. Only after the independently verified **Design 101 registration closure** may Design 100 implementation add coordinator-private headless activation and remove the raw operational operator-config path.
5. Only after the resulting static gates and fresh review pass may one Task 11 target-version live mutation be authorized.

Until step 2 passes, all registration consume and headless operational activation remain blocked. The current operational preflight must report a redacted composition blocker; Task 12 release consolidation remains unavailable.
