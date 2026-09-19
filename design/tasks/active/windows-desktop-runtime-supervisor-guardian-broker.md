---
id: TASK-WINDOWS-DESKTOP-RUNTIME-SUPERVISOR-GUARDIAN-BROKER
type: task
status: blocked
owner: windows-desktop-distribution
---

# Windows Desktop Runtime Supervisor and Guardian Session Broker

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the native Desktop/runtime-supervisor predecessor that starts the exact bundled Host runtime from the already admitted generation, privately hands Host the canonical root layout and one authenticated platform containment session, and retains Guardian process/stdin EOF ownership. This task makes redacted platform containment acknowledgements consumable by the exact Host runtime without exposing raw pipes, tokens, PIDs, paths, root layout or native facts to browser/public/product surfaces.

**Architecture:** `GameBuddy.exe` is the distribution/runtime supervisor. It reads the sole current-user root registration and Host admission contract through the closed launcher predecessor (`6aaeb75`), starts the exact bundled Host entry only after a native bootstrap handshake, and starts/owns the admitted resident Guardian. Desktop retains raw Guardian stdin writer, stdout reader, private ingress pipe/token, process handles and canonical paths. Host composition owns `ContainedGameRuntime`; the only narrow game-facing contract is `host/src/containment/runtime/contract/game-runtime.ts`. Its implementation-private `host/src/containment/runtime/core/contained-game-runtime.ts` is imported only by `host/src/composition`. The admitted Host receives only a closure-bound platform containment session over one authenticated local bootstrap session and gives game lifecycle only that contract; `games/stardew` never imports runtime/core, auth transport, bootstrap roots, Desktop/Guardian/Windows/native. No raw session/pipe/PID/Job/token/path crosses that seam, and there is no global registry/daemon/browser handoff or fallback. A role means the OS process role `player_host` or `ai_client`, not an in-game NPC or AI companion. Game runtime duration is lifecycle termination/STOP/crash, not a timeout. Non-launch budgets are concrete transport/operation waits: arm budget owner is the generic runtime/Guardian operation (bounded wait yields `arm unavailable` and no launch); contain budget owner is generic runtime/Guardian cleanup (bounded wait yields `containment uncertain`/quarantine, never success); recover budget owner is the Guardian recovery state machine (bounded wait yields `recovery unavailable`/held and the old lease remains authoritative). These are transport/operation waits, not game lifetime or launch deadline. Only transport/handshake wait budgets and one lifecycle-created per-invocation `RoleLaunchOperation` deadline remain; the latter is created after fresh admission/preconditions and the launch decision. Bootstrap timeout, browser admission expiry, and owner/attempt expiry are not role-launch deadlines; other deadlines require a distinct failure model and owner. Desktop validates framing/correlation/session lifetime; it does not interpret game launch authorization, owner records or product lifecycle truth. A game lifecycle remains product owner; Guardian remains OS containment owner. Stardew is a consumer of this platform seam, not its definition; see [ADR-0007](../../adr/0007-contained-game-runtime-and-game-owned-launch-authorization.md).

**Spec:** `design/103_WINDOWS_DISTRIBUTION_AND_DESKTOP_PRESENTATION_DESIGN.md` §§3–5; [ADR-0007](../../adr/0007-contained-game-runtime-and-game-owned-launch-authorization.md); `design/tasks/active/stardew-bootstrap-containment-recovery.md` for Stardew consumer delegation; `design/tasks/active/windows-desktop-guardian-generation-launcher.md`.

## Status and authority

`b098b57 Add Windows desktop root registration` closed the sole registered-root prerequisite. `6aaeb75 Add native Guardian generation launcher` closed selected-generation Guardian admission, native image locking, Guardian environment injection and stdin EOF ownership. It deliberately did **not** start Host or provide Desktop↔Host Guardian command/acknowledgement transport.

This task is blocked on `TASK-WINDOWS-DESKTOP-HOST-RUNTIME-ADMISSION`: Desktop must first admit and authenticate the exact bundled Host runtime/entry and Host must fresh-revalidate the private root-layout capability before mutable owner opens. Consequently, Task 3 role delegation remains blocked: the current Host private Guardian owner has only injected test ports, while production Node process owners still own direct spawn/kill. After the runtime-admission predecessor closes, this task activates only the missing Desktop runtime-supervisor and Guardian-session-broker predecessor. It does not activate Task 3 delegation, app instance, browser presentation, installer, installation registration, recovery policy changes, or live Stardew/SMAPI.

## Global constraints

- Desktop starts only the bundle-declared Host runtime/entry from the already selected and verified installed generation. No system Node, pnpm, repository checkout, arbitrary PATH, app-adjacent executable, CLI/CWD/environment Host root or development runtime fallback is permitted.
- Desktop production root source remains only `gamebuddy-windows-root-registration/v1`; it privately derives `gamebuddy-windows-root-layout/v1`. No arbitrary root is accepted by `GameBuddy.exe`, Host bootstrap CLI, the broker, browser, or any environment input.
- Desktop creates one fresh Host bootstrap endpoint/token and starts exactly one admitted Host child. The Host must authenticate as the expected child/session before Desktop releases root layout or Guardian-session authority. An unauthenticated, duplicate, wrong-user, wrong-generation, stale, timeout or malformed client receives no bootstrap/session capability and causes a fixed redacted failure.
- The Host bootstrap transport is private local IPC with creation-time current-user DACL, first-instance/remote rejection where supported, bounded UTF-8 LF framing, fixed exact schemas, one-time credentials, no raw errors, and no browser/public DTO/log/config/durable-record projection. Its child reader is supplied only via reviewed `STARTF_USESTDHANDLES + PROC_THREAD_ATTRIBUTE_HANDLE_LIST`; all other launcher handles are non-inheritable/not listed.
- Desktop retains raw Guardian stdin writer, stdout reader, private ingress pipe/token and process handle. It never gives these values or handles to Host. It gives the authenticated Host only a closure/opaque `desktop_guardian_session/v1` capability, bound to one Desktop instance, admitted generation, root-layout version and Guardian correlation.
- Guardian command relay accepts only exact redacted commands: `arm_attempt`, `launch_role(role)`, `contain_role(role)`, and `recover_attempt(recoveryInstanceId)`. Desktop writes exact public frames to Guardian stdin and parses strict stdout acknowledgements only. Correlation, expected result, and the per-invocation `RoleLaunchOperation` deadline for `launch_role` must match before Host receives a redacted acknowledgement. `arm_attempt`, `contain_role`, and `recover_attempt` use only their own transport/operation wait budgets when their wire requires them; those budgets are neither launch deadlines nor game lifetime, and each has a distinct owner/failure model; role is only `player_host` or `ai_client` as an OS process role.
- The Guardian-private ingress credentials may be used only through the authenticated broker session. Desktop does not parse, persist or log private arm binding, role launch plan, recovery pre/post binding or role classification payloads; it relays bounded opaque private frames only after the corresponding public command/session transition authorizes them. Replayed/malformed/oversized/private-before-public frames fail closed.
- Recovery is a distinct Guardian session. Desktop starts an admitted Guardian only in exact `recovery` mode for a recovery bootstrap request, maintains separate stdin/stdout/private ingress lifecycle, and exposes only pre-gate, post-CAS classification, recover command and release operations through the same opaque session contract. Resident and recovery sessions cannot be substituted or reused.
- Desktop owns Guardian stdin EOF. Host loss, bootstrap timeout, malformed broker input, Desktop shutdown or session revocation closes only the retained Guardian control writer and waits for its redacted terminal outcome. Desktop never writes owner records, role states, receipts, action results, recovery conclusions or product lifecycle success.
- Host owns all durable CAS and product lifecycle semantics. Guardian owns only OS process containment. Desktop owns only admitted native child supervision and private transport. Browser/public TypeScript adapters gain no pipes, tokens, PIDs, paths, root layout, native handles, Guardian facts, generic command bridge or spawn capability.
- Tests use only disposable Host/Guardian fixture binaries and registered fixture roots. They launch no Stardew, SMAPI, bridge, provider, Chat/Game product runtime, installation selection or game mutation.

## Non-launch operation budgets

These are transport/operation waits, not game lifetime and not the lifecycle-created `RoleLaunchOperation` launch deadline. The arm budget is owned by the generic runtime/Guardian operation; a bounded wait returns `arm unavailable` and performs no launch. The contain budget is owned by generic runtime/Guardian cleanup; a bounded wait returns `containment uncertain` and enters quarantine, never success. The recover budget is owned by the Guardian recovery state machine; a bounded wait returns `recovery unavailable`/held and the old lease remains authoritative. No budget here authorizes a retry or alternate path.

## Implemented private session wire for this predecessor

The Desktop↔Host Guardian session uses the bootstrap frame's one-time random `bootstrapId` to derive a private current-user named-pipe endpoint; the endpoint name is never placed in argv, environment, stdout, browser state, files, logs, or a public DTO. The exact pipe name is `GameBuddy.HostGuardian.<bootstrapId>`, where `<bootstrapId>` is the lowercase 64-character hex value from `desktop_host_bootstrap/v1`; the Windows native server uses the corresponding `\\.\\pipe\\` prefix and accepts exactly one client. The endpoint is a locator rather than a separate secret. The creation-time current-user pipe boundary rejects remote/other-user clients. After connection, Desktop must verify `GetNamedPipeClientProcessId` equals the exact `RuntimeSupervisor`-created, image/PID/SID-admitted Host child and must recheck the connected child's current-user SID/session binding. The Host must send the exact hello before any command.

All session messages are one UTF-8 JSON line with a final LF, at most 16,384 encoded bytes, no BOM/CR/NUL/extra LF, duplicate keys, or unknown keys. The exact hello request is:

```ts
type DesktopGuardianHelloV1 = Readonly<{
  schema: "gamebuddy-desktop-guardian-session/v1";
  protocolVersion: 1;
  operation: "hello";
  bootstrapId: string;
  generation: string;
  inventoryDigest: string;
  runtimeAdmissionSha256: string;
}>;
```

The exact hello acknowledgement is the same binding fields plus `status: "accepted"`. `desktop_host_bootstrap/v1` does not carry a Guardian session token and neither its frame nor acknowledgement is extended for this broker. Desktop authorizes the one-shot session through the private endpoint's creation-time current-user boundary plus exact admitted child PID/SID/session binding; no credential enters command line, ambient environment, stdout, browser, files, logs, or public DTOs. Resident command frames are:

```ts
type DesktopGuardianCommandV1 = Readonly<
  | { schema: "gamebuddy-desktop-guardian-session/v1"; protocolVersion: 1; operation: "arm_attempt"; bootstrapId: string; generation: string; inventoryDigest: string; runtimeAdmissionSha256: string; operationWaitBudgetMs: number; guardianInstanceId: string; guardianEpoch: number; attemptId: string; privateFrame: string }
  | { schema: "gamebuddy-desktop-guardian-session/v1"; protocolVersion: 1; operation: "launch_role"; bootstrapId: string; generation: string; inventoryDigest: string; runtimeAdmissionSha256: string; deadlineUnixMs: number; guardianInstanceId: string; guardianEpoch: number; attemptId: string; role: "player_host" | "ai_client"; privateFrame: string }
  | { schema: "gamebuddy-desktop-guardian-session/v1"; protocolVersion: 1; operation: "contain_role"; bootstrapId: string; generation: string; inventoryDigest: string; runtimeAdmissionSha256: string; operationWaitBudgetMs: number; guardianInstanceId: string; guardianEpoch: number; attemptId: string; role: "player_host" | "ai_client" }
  | { schema: "gamebuddy-desktop-guardian-session/v1"; protocolVersion: 1; operation: "recover_attempt"; bootstrapId: string; generation: string; inventoryDigest: string; runtimeAdmissionSha256: string; operationWaitBudgetMs: number; guardianInstanceId: string; guardianEpoch: number; attemptId: string; recoveryInstanceId: string; privateFrame: string }
>;
```

`deadlineUnixMs` is present only for `launch_role` as the positive safe-integer deadline of the lifecycle-created per-invocation `RoleLaunchOperation`; non-launch commands carry `operationWaitBudgetMs` only where their wire requires it, no more than Desktop's fixed bounded future horizon; it is validated before any native public relay or private ingress activity and is never echoed in the acknowledgement. It is not the game runtime lifetime, bootstrap timeout, browser admission expiry, or owner/attempt expiry. `privateFrame` is base64url text for one bounded opaque Guardian-private frame. This is an internal Desktop/Guardian transport representation only; it is not the game-facing seam and Stardew never supplies native private frame bytes. Stardew supplies typed/private game-owned authorization facts to runtime, which privately derives, encodes, and consumes this frame; opaque authorization remains an internal runtime capability. (decoded bytes are at most 65,536 bytes). For resident arm only, the Host body is tokenless UTF-8 JSON object bytes without LF/BOM/CR/NUL and with exact native body keys/order `guardianInstanceId, guardianEpoch, attemptId, revision, leaseName, playerJobName, aiJobName`; after the public arm command authorizes ingress, Desktop byte-injects its Desktop-held native token as the first `token` member and appends LF. Desktop does not parse or persist the remaining body. For launch, Desktop relays the exact opaque native plan bytes plus LF byte-for-byte; native Guardian validates it. Desktop never logs or projects these frames or native facts. Recovery's multiple private phases are not represented by this tracer-bullet frame and return `unavailable`. The redacted command acknowledgement has exact keys `schema`, `protocolVersion`, `operation`, `status`, `bootstrapId`, `generation`, `inventoryDigest`, `runtimeAdmissionSha256`, `guardianInstanceId`, `guardianEpoch`, `attemptId`, plus `role` exactly for role commands. It never contains the private frame, pipe/token, path, PID, Job, lease, owner record, or receipt. Allowed statuses are `armed`, `role_active`, `role_contained`, `recovery_accepted`, `contained`, and `unavailable`. `attemptId` is not a second durable field: for a Stardew owner it is exactly the owner `bootstrapId`, and therefore exactly the registration `activeAttempt.bootstrapCorrelation`; the owner/core derives this equality inside its private composition and rejects any other mapping.

The resident session state is `hello → resident_ready → armed → role_active/role_contained`; each role may launch and contain at most once, and every command must match the hello-bound generation and the exact Guardian correlation. Arm ordering is: validated Host command → Desktop native public `arm_attempt` → Guardian opens private ingress → Desktop token-injected opaque arm body → private `accepted` → native public `armed` → redacted broker acknowledgement. Launch follows the same public-authorize/private-accepted/native-`role_active` ordering; contain has no private frame and waits for native `role_contained`. The recovery session is a distinct Desktop/Guardian instance and pipe with the same hello binding but cannot consume or continue a resident session; recovery is explicitly unavailable in this resident tracer bullet. Host loss, malformed/cross-session/replayed command, Guardian malformed output, timeout, or Desktop shutdown closes the retained Guardian control writer (EOF) and returns no success acknowledgement. The Host receives only a closure-bound session capability; raw pipe names, Guardian control credentials, process handles, and native facts remain Desktop-private.

## File and responsibility map

| File | Responsibility |
|---|---|
| `desktop/GameBuddy.Desktop/RuntimeSupervisor.cs` | Starts/adopts only exact bundled Host child, authenticates private bootstrap, owns child supervision/redacted termination. |
| `desktop/GameBuddy.Desktop/DesktopHostBootstrapBroker.cs` | Private bootstrap/session IPC; delivers root layout and opaque Guardian session only after exact Host authentication. |
| `desktop/GameBuddy.Desktop/GuardianSupervisor.cs` | Extends admitted Guardian supervision to retain stdin/stdout/private ingress and provide broker-only redacted relay; never gains product lifecycle authority. |
| `desktop/GameBuddy.Desktop/Program.cs` | Production runtime-supervisor entry; no CLI/CWD/environment root or session injection. |
| `desktop/GameBuddy.Desktop/WindowsNative.cs` | Narrow native child/handle/IPC ownership and inheritance primitives. |
| `desktop/GameBuddy.Desktop.Tests/*` | Disposable Host/Guardian broker fixture, bootstrap/auth/root-layout/session/ack/EOF/recovery isolation tests. |
| `host/src/bootstrap/{entry,wire,roots}` | Host-private entry, authenticated Desktop wire and root capability boundary; no game lifecycle or raw Guardian facts. |
| `host/src/containment/runtime/contract/game-runtime.ts` | Sole narrow game-facing contract; no platform or raw process facts. |
| `host/src/containment/runtime/core/contained-game-runtime.ts` | Host-private implementation; imported only by `host/src/composition`. |
| `host/src/games/stardew/{lifecycle,launch,bridge}` | Stardew-private lifecycle, launch-authorization producer and bridge adapter; may import only the game-runtime contract, never runtime/core or raw Desktop/Guardian IPC. |
| `host/src/composition` | Sole private assembly point for runtime/core, game adapter, bootstrap and platform modules; not a cross-domain import surface. |
| directory-local `README.md` | When the named directories land, each declares `Owns` / `Does not know` / `Dependency direction` / `Placement and move rule` / `Required verification`; this task does not create them. |
| `host/src/*test*` exact direct tests | Host bootstrap/session and private port boundary tests only. |

## Resident broker tracer-bullet checkpoint (implementation pending full closure)

The first resident-only broker tracer bullet now has the corrected private wire above: no impossible bootstrap-frame session token; a bootstrap-derived current-user pipe with exact admitted-child PID/SID/session authentication; bounded deadline-bearing resident envelopes; and Desktop byte-level native arm-token injection while retaining the raw token. It starts the Host first, then binds the admitted resident Guardian only after Host acknowledgement/authentication and Guardian admission. The tracer bullet still has no recovery private-phase relay, no Task 3 process-owner delegation, and no source-bound cross-process Host/Guardian E2E fixture. The task remains `blocked` until Tasks 1–3 evidence and independent reviews complete.

## Task 1: Freeze private Desktop→Host bootstrap and root-layout handoff

**Files:**
- Create `desktop/GameBuddy.Desktop/RuntimeSupervisor.cs`, `DesktopHostBootstrapBroker.cs`
- Create disposable Host fixture and direct Desktop tests
- Create `host/src/desktop-runtime-bootstrap.internal.ts` and direct tests
- Modify `desktop/GameBuddy.Desktop/Program.cs` only for exact production supervisor mode

- [ ] Write failing tests: only the launched admitted Host child can authenticate one bootstrap session; duplicate/wrong-user/wrong-generation/timeout/root injection fail before root layout release; bootstrap credentials never appear in stdout, environment outside allowlisted child inputs, files, logs or public DTOs.
- [ ] Implement native bootstrap IPC with exact `desktop_host_bootstrap/v1` first frame, current-user authentication, one-time token, bounded framing, first-instance/remote rejection, and explicit Host child stdin/handle inheritance. Desktop passes the canonical root layout as a private, non-browser bootstrap object only after authentication.
- [ ] Implement the Host internal bootstrap consumer. It is unavailable from ordinary Node/Host/browser entrypoints and returns only closure-bound root-layout/session capabilities; raw transport/token/root facts are not exported.
- [ ] Test Host loss, malformed bootstrap, duplicate client and timeout: Desktop terminates/contains only its admitted child/session and starts no Guardian session.

## Task 2: Implement broker-owned Guardian resident/recovery sessions

**Files:**
- Modify `desktop/GameBuddy.Desktop/GuardianSupervisor.cs`, `RuntimeSupervisor.cs`, `DesktopHostBootstrapBroker.cs`
- Modify/add direct Desktop tests and disposable Guardian fixtures
- Modify the relevant `host/src/bootstrap/{entry,wire,roots}` and `host/src/containment/{auth,receipt,windows}` private seams, and exact direct tests
- Do not add or extend Stardew-specific Desktop/Guardian composition in this platform task; Stardew integration belongs to its own consumer delegation task.

- [ ] Write failing tests for exact resident `arm → armed`, private arm binding, `launch(role) → role_active`, private plan, `contain(role) → role_contained`, control EOF and acknowledgement mismatch. Assert Host durable callback is unavailable before native acknowledgement and no raw Guardian facts reach Host/public surfaces.
- [ ] Relay redacted public command frames through Desktop-held Guardian stdin/stdout. Desktop validates exact response grammar/correlation/session state and exposes only fixed acknowledgements via closure-bound session capability.
- [ ] Relay one-shot private ingress data as opaque bounded frames only after authorized public/session transitions. Desktop neither parses nor persists private plans/bindings. Reject replay/private-before-public/cross-role/cross-session/ack mismatch/timeout and close Guardian stdin EOF.
- [ ] Implement separate recovery Guardian session: pre-CAS successor gate handoff → Host durable recovering CAS → post-CAS classification binding → recover command/classifications → release. Resident/recovery session substitution fails closed.
- [ ] Test Host loss, malformed broker request, Guardian malformed stdout, wrong correlation/ack, private replay and EOF: no durable success acknowledgement and Desktop closes Guardian control writer.

## Task 3: Run source-bound broker matrix and independent review

- [ ] Build disposable source-bound Host + Guardian session fixtures from the selected generation authority.
- [ ] Run deterministic Windows tests for bootstrap authentication, root-layout handoff, resident command/ack relay, private ingress ordering, recovery separation, child/Guardian EOF, acknowledgement mismatch, no secret/root leakage and no Node/public-adapter spawn.
- [ ] Run focused Host internal bootstrap/private Guardian tests, Desktop tests/build and Host artifact checks.
- [ ] Fresh Windows native/security review: handle inheritance, IPC ACL/SID/token, EOF/process supervision, no raw credential/root/native-fact exposure.
- [ ] Fresh Host lifecycle/topology review: coordinator remains product owner, Guardian only containment owner, no alternate Node role spawn/kill authority is added before Task 3 delegation.

## Stop conditions

Stop and revise rather than add a fallback if:
- the exact bundled Host child cannot be authenticated before root layout or Guardian session release;
- implementation requires passing raw root, Guardian pipe/token, stdin/stdout, PID, handle, generation path or role/owner facts through browser/public/ordinary Host entrypoints;
- the broker needs a generic command channel, Node spawn, public Guardian adapter spawn, system runtime fallback, arbitrary root selection or a second provenance verifier;
- Desktop must parse/persist owner records or private launch/recovery payloads to operate;
- a resident session can become a recovery session, a recovery session becomes resident, or any session can be replayed/substituted;
- Task 3 process-owner code is changed before command/acknowledgement broker evidence and independent review close this predecessor.

## Acceptance

This predecessor closes only when source-bound native Desktop/Host/Guardian session tests prove exact authenticated Host bootstrap, private root-layout handoff, redacted resident/recovery command acknowledgements, private ingress ordering, Host/Guardian EOF ownership, no root/token/pipe/native fact leakage, no Node/public-adapter spawn, and two independent reviews. It then unblocks Task 3 authority delegation; it does not close Task 3, Task 4, installation registration, topology consolidation, desktop player release or live Stardew.
