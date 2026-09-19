---
id: ARCH-STARDEW-INSTALLATION-RUNTIME-REGISTRATION-PLAN
type: implementation-plan
status: draft
owner: stardew-integration
---

# Stardew 安装运行时注册实施计划

## 目标

为每个 Windows user 建立唯一的 Host 私有、可跨进程重启消费的 Stardew 安装 locator 注册。玩家首次注册或重新选择时只能使用已发布的原生 `IFileDialog` folder picker；Host 在写入前立即准入。注册只选择下次启动可重新定位的安装，不持有或清理生命周期资源。

每次 `game.launch` 在同一个产品私有 lifecycle core 中通过既有 bootstrap owner 创建一个 bootstrap/guardian attempt。registration record 的 opaque `activeAttempt` pointer 必须与该 owner 的 prepared-attempt reservation 在同一 crash-safe 原子提交中绑定；该 pointer 只是 owner attempt 的私有索引，不能单独代表、创建、恢复或释放 attempt。不存在长生命周期 `withFreshRegisteredInstallation(callback)`，也不存在 registration 独立 attempt-fence schema、状态机、recovery owner 或 cleanup authority。

该计划只实现安装注册及其与既有产品生命周期的私有连接。它不改变 `equip_tool`、action catalog、tool visibility、Mod action、bridge protocol、receipt、postcondition、Portfolio、Preview、action-development live gate 或 operational/release flow 的 action 语义。

当前 [Stardew 集成](../domains/stardew/integration.md) 仍将 installation registration 和 bootstrap containment 标为未闭合。本文件是可执行计划，不改变该事实。任何消费接线开始前，当前 domain owner 必须记录 containment 已闭合，并在最终 registration closure 前记录本计划的实现、确定性验证和独立 review 已完成。

## 边界与权威图

```text
browser setup intent（无路径）
→ authenticated Host callback
→ published native folder picker
→ strict `admitStardewInstallation(inspector, locator)`
→ Host-private durable registration: ready locator

game.launch
→ bootstrap owner private atomic prepared-reservation + activeAttempt binding
→ consume prepared bootstrap attempt reserve (Phase A)
→ Stage B
→ Stage C: independent fresh admission
→ cabin confirm Stage D: second independent fresh admission
→ existing attach, enter, STOP, reverse teardown
→ guardian exact containment settlement proof
→ bootstrap owner private atomic settlement + matching active pointer release
```

- locator 是不可信的 Windows installation-root 字符串，只用于下一进程重新定位安装；它不是 capability、安装 identity、launch readiness 或 process authority。
- `AdmittedStardewInstallation` 是现有 WeakSet/WeakMap-brand 的进程内 capability。不得持久化、克隆、结构化替代、传给 browser、写入 run manifest，或在重启时重新水化。
- `StardewProductionLifecycleCoordinator` 和其私有 lifecycle core 是 bootstrap/guardian attempt、Stage B/C/D、Player Host/AI Client、attachment、Game enter、STOP、disconnect、quarantine 和 teardown 的唯一产品 owner。registration store 不启动进程、不连 bridge、不 materialize facade、不发布 task ingress，且不清理 attempt。
- `stardew-private-bootstrap/owner.json` v4 是 bootstrap/guardian attempt 的唯一 durable attempt authority。它必须提供由其模块私有 brand 保护的 atomic prepared-attempt reservation + registration `activeAttempt` binding，以及 matching settlement + pointer release transaction；其 guardian correlation、状态、exact containment settlement proof 和 recovery 接口必须先以 [active Design 102 task](../tasks/active/stardew-bootstrap-containment-recovery.md) 为 source verify。本计划不得复述、扩展、读取或平行持久化其 schema。
- 只有 bootstrap owner 已能在一个 crash-safe transaction 中保证“prepared reservation 与同 correlation 的 registration pointer 同时可见，或两者均不可见”，并能在 matching settlement 后原子释放 pointer 时，才可实施 registration。若现有 owner 没有该能力，registration 保持 `blocked`；先由 guardian/bootstrap owner 提供不导出的 nominal transaction seam，registration、browser 与 lifecycle facade 不得模拟它、窥视其 token 或以路径锁拼接两个写入。
- Preview、Portfolio、operator config、`main.ts` 过渡 attach、run manifest、browser DTO、generic launcher、operational runner 和 action-development package 没有 registration read/write/consume import path。所有未来 control 也只能经同一个 private lifecycle core，不能建立平行 launch、recovery 或 cleanup 路径。

## Canonical durable schema and state

在由 launcher 私下交给 Host 并由 Host 首写重新验证的 `gamebuddy-windows-root-layout/v1` 的 `data` owner partition 内，使用固定、无用户文本的 registration directory 和 leaf 名。路径必须由 registration module 自己从 canonical root 推导，逐段做 containment/non-reparse 验证；不接受 CLI、environment、CWD、browser、profile 或 locator 派生的 storage path。

### Registration record

唯一 registration record 使用严格 JSON `gamebuddy-stardew-installation-registration/v1`：

```ts
type StardewInstallationRegistrationRecordV1 = Readonly<{
  schema: "gamebuddy-stardew-installation-registration/v1";
  binding: Readonly<{
    rootLayoutVersion: 1;
    productInstallationId: string;
  }>;
  revision: number;
  state: "ready" | "invalid";
  locator: string | null;
  activeAttempt: Readonly<{
    bootstrapCorrelation: string;
  }> | null;
}>;
```

Rules:

- `ready` requires one bounded, canonical absolute Windows directory locator; `invalid` requires `locator: null`. The locator is an untrusted, Host-private durable candidate needed only to re-locate and freshly admit the installation after restart; it is not part of `binding` and never crosses any public, browser, Devkit or control protocol/result boundary.
- `activeAttempt` is `null` while no lifecycle attempt is active. While non-null, it contains only the bounded opaque exact bootstrap/guardian correlation produced by the prepared bootstrap attempt. It contains no locator, process, path, token, Job, lease, guardian object identity, configuration, bridge, capability or cleanup state.
- The record's active pointer is not a second attempt fence. Its only lifecycle meaning is that the exact `owner.json` attempt remains the exclusive durable authority until Design 102's matching exact containment settlement proof permits the lifecycle core to clear it. Registration cannot clear, replace, recover, terminalize or infer the pointer's outcome.
- `revision` is a positive safe integer, advances on every successfully published ready/invalid replacement, and is not a lifecycle, attachment, action-catalog, or process generation. An active pointer prevents replacement, revoke and reselection.
- Binding is exactly `{ rootLayoutVersion: 1, productInstallationId: string }`. `productInstallationId` is the launcher-owned product installation identity, not a path, runtime root, continuity/player/companion identity or authority generation. `bootstrapOperationId` is intentionally excluded because it changes per process; a consumer must still revalidate its current Host private root layout and deployment manifest before reading or using a record.
- Parser rejects duplicate keys, unknown/missing keys, prototypes, arrays where objects are required, unsafe numbers, oversize bytes, invalid enum pairings, invalid binding, invalid locator grammar and malformed active pointer.
- The record contains no admitted capability, identity chain, runtime-root text, executable path, bridge/token, launch/attachment generation, PID, job/lease name, profile, session, receipt, action/policy/catalog fact, prompt, credential, error detail or browser-facing field.
- Parse, root validation, lock, atomic write or reread failure is fail closed. A failed write never reports ready. Where an invalid replacement cannot be durably published, return `unavailable`; do not infer or repair readiness.

### Browser boundary

registration record、locator、`activeAttempt`、其 revision 和任何 derived registration status 都保持 Host-private。本计划不定义 `StardewInstallationRegistrationView`、`readView()`、browser state lane、IPC endpoint 或 `GameBrowserStateV1` 字段。

浏览器仅可发起既有 authenticated、no-path 的 setup intent，并接收该既有命令的固定 redacted completion category；它不能读取、轮询、订阅或推断 registration。新的 browser projection 必须在另一项工作中先冻结 `GameBrowserStateV1` 的字段、endpoint、状态语义、权限和泄漏测试，之后才能独立设计；本计划既不预留字段也不发明 projection。日志、telemetry、errors、IPC、test snapshots 和 release evidence 不得包含 locator、可执行文件派生路径、active pointer、guardian facts 或 registration-derived state。

## Setup registration and reselection

The sole initial producer is the already published `WindowsStardewFolderPickerCapability` and `selectStardewFolder()` flow reached through the authenticated no-path setup request. The browser sends intent only; no browser contract accepts, stores, reflects or serializes a path.

1. In the coordinator-owned authenticated setup callback, run the native picker.
2. Cancellation returns the existing redacted cancellation result and changes no existing ready registration.
3. For a selected candidate, create the current Windows reparse inspector and call `admitStardewInstallation(inspector, locator)` before any registration write.
4. Call the private registration publisher while holding its fixed path lock. It rechecks the current Host private root layout and deployment manifest, derives the exact minimal desktop binding, verifies `activeAttempt: null`, rereads the current record, atomically writes the new `ready` record with `revision + 1`, and strict-rereads it before returning a redacted result.
5. An admission, validation or persistence failure publishes no ready result and keeps any previously durable ready record unchanged. A failure that makes a known current record unsafe may atomically publish `invalid` at the next revision only if there is no active pointer; otherwise it is `unavailable`.

Reselection follows the same sequence and is never a fallback discovery mechanism. It is rejected as `busy`/`unavailable` while `activeAttempt` is non-null. There is no Steam/GOG/VDF/registry/conventional-path/process-scan fallback, saved-path fallback, raw operator override, read repair, adoption or automatic registration refresh.

## Launch choreography and coordinator connection

registration composition 只向 coordinator-owned picker callback 提供 Host-private `registerSelectedLocator(locator)`，且该调用只能发生在前置 admission 成功之后。它没有 `readView()`，不向 browser 或普通 Host consumer 暴露 record，也不 mint installation capability、保留 path lock、持有 session 或成为 cleanup authority。

`game.launch` 只能由 private lifecycle core 按以下顺序协调：

1. Revalidate the Host private root layout and load the current deployment manifest; derive the current exact minimal desktop binding `{ rootLayoutVersion: 1, productInstallationId }`.
2. lifecycle core 调用 bootstrap owner 的私有 nominal transaction seam。seam 在其受控 transaction 内 strict-read matching registration record，要求 `state: "ready"` 和 `activeAttempt: null`，创建 exact prepared bootstrap/guardian reservation，并将同一 opaque correlation 绑定为 record 的 `activeAttempt`。transaction 只会提交“owner 已 prepared 且 record pointer 完全匹配”的对，或完全不提交；返回值是仅 lifecycle core 可消费的一次性 prepared reservation capability，不能由 registration selector、browser 或其他 facade 构造或重放。
3. transaction commit 后释放 registration path lock 和 owner transaction scope，再由 lifecycle core 在 Phase A 消费该 exact prepared reservation。reservation 消费失败、未知结果或 caller crash 仍只由 bootstrap/guardian owner 的 recovery/quarantine 处理；registration 不重试、不清 pointer、也不以 lock、PID 或时间判断 outcome。
4. Run Stage B through the lifecycle core.
5. Immediately before Stage C's effect, independently create a new inspector and fresh-admit the record's private locator. This capability belongs only to this Stage C request and cannot be saved, reused by Stage D, exposed, or carried through any later request.
6. At cabin confirmation, Stage D independently creates another new inspector and fresh-admits the same current private locator again. It must revalidate materialized bridge config and deadline inside its awaitable admission callback before synchronously consuming the AI launch reservation. Stage C admission is never a Stage D input.
7. Continue existing attach, enter, STOP, disconnect, quarantine and reverse teardown in the same lifecycle core. No registration path lock or owner transaction scope is held through these phases or through a running session.
8. After the Design 102 guardian interface returns a source-verified matching exact containment settlement proof, lifecycle core invokes the same bootstrap owner's private settlement transaction. That transaction verifies the proof and correlation against its own attempt authority, durably accepts the terminal contained/quarantined outcome, and atomically clears only the matching registration pointer. Mismatch, missing proof, persistence failure, cancellation uncertainty or incomplete settlement leaves the pointer in place and keeps registration unavailable; no selector operation may make a successor eligible.

Coordinator setup must no longer retain `admittedInstallation` from the picker as a long-lived launch input. Setup admits only to validate selection and publish the locator. Launch performs the two request-scoped independent admissions described above. Existing setup/launch idempotency remains lifecycle-core-owned and must not expose a registration claim to the browser.

### Crash windows, orphan handling, rollback and quarantine

The private bootstrap owner transaction is the only linearization authority for the record/attempt pair. A registration path lock can serialize record I/O, but cannot establish this protocol by sequencing two independent writes.

| Crash or failure window | Required durable result and handling |
|---|---|
| Before the private prepare-and-bind transaction begins, or before it commits | Neither a prepared owner reservation nor `activeAttempt` is visible. The launch was not accepted; a later launch may begin normally. |
| During prepare-and-bind persistence, including process loss between internal writes | The transaction recovery contract exposes either neither side or the same-correlation prepared pair. A one-sided prepared owner or pointer is never a recoverable public state. If the existing owner cannot prove this property, implementation remains blocked and must first add its private nominal transaction seam. |
| After the pair commits but before the reservation capability is returned or Phase A consumes it | This is an orphaned prepared attempt, not a new launch opportunity. Bootstrap-owner recovery owns it, drives its existing cancellation/containment and terminal quarantine path, obtains the matching settlement proof, then retries only its matching settlement-and-release transaction. Registration remains unavailable until that commit succeeds. |
| During or after Phase A, Stage B/C/D, attach, enter, STOP, disconnect or reverse teardown | The matching pointer remains. Normal lifecycle close or bootstrap-owner recovery alone classifies the exact owner attempt. PID lookup, elapsed time, stale lock handling, browser intent and record reread cannot release or replace it. Any ambiguous recovery is terminal quarantine, never a successor launch. |
| After guardian settlement proof but before settlement-and-release commits | The owner attempt remains terminal but the pointer remains active, so the state is conservatively unavailable. Only the owner may retry the idempotent matching settlement-and-release transaction; a new attempt, reselection or record repair is prohibited. |
| During settlement-and-release persistence | Transaction recovery exposes either the pre-settlement active pair or the terminal owner outcome with the matching pointer released. It never exposes a released pointer while that correlation remains executable. A persistence/identity mismatch quarantines the attempt and retains unavailability until the owner can produce and commit the matching settlement path. |
| After settlement-and-release commits but before the caller observes it | The attempt is non-executable and the pointer is absent. A subsequent launch may start a distinct owner attempt; the old correlation cannot be reused. |

An orphan is discovered only through the matching `owner.json` correlation and registration pointer inside the bootstrap owner's private recovery/transaction seam. Registration does not scan directories, inspect processes, reclaim stale locks, adopt partial records, infer completion, or create a second fence. A cross-correlation pair, missing side, malformed record, unavailable owner transaction or unpersistable recovery result is fail-closed `unavailable`; where Design 102 allows it, the owner records terminal quarantine, but registration never repairs or clears the pointer itself.

## Production, control, and release flows

### Production

Production reads only the private registration selector from the Host composition built from the launcher-supplied canonical root layout. Missing/malformed registration is a redacted setup-required/unavailable state. Production has no direct profile, raw path, config or attach fallback. A registration record is not launch readiness and cannot activate Stardew until the lifecycle core has started the exact attempt and completed its existing prerequisites.

### Control and operational flows

Action-development control and the operational harness remain consumers of their own bounded, redacted control contracts. They do not receive a locator, registration record, picker capability, admitted installation, active pointer, guardian state, profile-derived installation fact or raw bridge input. A control run must remain blocked until the current domain owner closes registration and containment; it cannot use a test profile to create a product registration or bypass the lifecycle core's independent Stage C/D admissions.

The registration plan does not authorize target-version Stardew launch, fixture setup, action mutation, action publish, release bundle publication or a release claim. External harness timeouts remain harness failures and cannot clear an active pointer.

### Old action-development profile removal

The old action-development target profile's product/control live authority is deleted at cutover. It is a development/harness configuration, not a product installation authority, and the destructive migration contains no compatibility import, adoption, translation or fallback:

1. Inventory every product/runtime import or script edge from `host/`, `desktop/`, browser composition, lifecycle core, operational control path and release composition to `integrations/stardew/action-development/profiles/`, `gamebuddy-action-target-profile/v1`, `--profile`, `gameInstallPath`, `releaseDir`, fixture roots and native client configuration. Classify each match as action-development-only, test-only, or prohibited product/control dependency.
2. Add failing source-bound tests proving production setup/launch and control inputs cannot accept the profile path, profile object or any profile-derived installation/path field. Action-development-local tests may use their own disposable fixture configuration for non-product action work; this plan makes no promise to retain any live action-development profile.
3. Replace the prohibited production dependency with the private registration selector and lifecycle-core choreography above. Do not parse, import, transform, copy, adopt or migrate profile data into the registration record.
4. Delete each former product/control adapter, config field, environment input and dead test fixture once its last non-action-development consumer is removed. Delete no `equip_tool` implementation, descriptor, contract, catalog, visibility projection, portfolio entry, action runbook, release bundle or release evidence.
5. Prove with static import/config inventories that only action-development-local code can still reference its profile schema and fields. The product registration schema contains none of those fields.

After cutover, no product/control live profile remains and no historical action-development profile is importable. Any action-development-local fixture configuration is isolated test/development input, not retained live authority. The deletion gate fails if any product/control path accepts a profile under a renamed field or indirect generic configuration object.

## Implementation lanes

### Lane 0: Preconditions and source inventory

- Read the current Stardew domain owner and active Design 102 task. Stop before implementation unless Task 3/4 containment closure, exact Guardian broker, Host root-layout revalidation, guardian correlation/settlement-proof interface, and required independent review are recorded as closed.
- Source-verify the Design 102 interface before naming or implementing the registration pointer clear operation. Do not infer a proof from lock ownership, guardian acknowledgement, elapsed time, PID liveness or a generic stale-lock reclaim.
- Source-verify that the existing bootstrap owner provides a module-private, nominally branded transaction that atomically prepares the attempt reservation and binds the matching registration pointer, then atomically accepts matching settlement and releases that pointer. Stop registration implementation as `blocked` if either transaction is absent or cannot make its crash-recovery invariant observable to focused tests; guardian/bootstrap owner must add the private seam first.
- Inventory `stardew-installation-admission`, folder picker, lifecycle-core launch choreography, bootstrap owner, runtime root ownership and action-development profile consumers. Browser state is out of scope until a separate owner freezes `GameBrowserStateV1`.
- Freeze module boundaries: private registration selector/test; bootstrap-owner private transaction/test; lifecycle core/composition/test; source-bound dependency tests. Do not edit action/Mod/catalog/release files.

### Lane 1: Private record and picker publication

- Add the strict registration parser/storage selector using existing `atomicWriteFile`, `withPathLock`, safe boundary checks and strict JSON conventions.
- Add the canonical single record schema, active pointer grammar, minimal desktop binding, fixed internal error mapping, atomic write+reread and no-leak logging discipline. Do not add a fence leaf, recovery state machine, view reader or public DTO.
- Wire the native picker callback to admission-first registration. Do not add a browser path DTO, discovery implementation, browser status or browser state integration.

### Lane 2: Lifecycle-core launch choreography

- Consume the bootstrap owner's private nominal prepare-and-bind transaction; do not implement a standalone `ready → activeAttempt` CAS after an independently persisted preparation. Prove crash recovery exposes neither side or the matching pair, and that only the owner can return a one-shot prepared reservation capability.
- Consume that reservation in Phase A, then Stage B; perform a request-local independent admission immediately before Stage C.
- At cabin confirm, perform a second request-local independent admission for Stage D, retaining its materialized bridge-config/deadline revalidation-before-launch-reservation order.
- Consume only the owner's matching settlement-and-release transaction after Design 102 exact containment proof. Cover every crash window, orphan prepared attempt, rollback and quarantine case. Preserve coordinator idempotency, STOP, disconnect, quarantine and reverse teardown. No second launcher, generic registry, callback handoff or cross-topology abstraction is allowed.

### Lane 3: Destructive profile dependency removal

- Execute the inventory and rejection tests from “Old action-development profile removal”.
- Remove only product/control profile consumers and their dead configurations/tests after Lane 2 passes.
- Keep action-development-local profile use and every named `equip_tool`/catalog/visibility/release artifact intact.

### Lane 4: Final integration and closure evidence

- Run deterministic Host and Windows tests on Windows. Review every residual raw-path/profile/config match.
- Obtain two independent reviews: authority/recovery/redaction, and topology/profile-removal/isolation.
- Update the current Stardew domain owner only after the implementation, all named gates and reviews have actually passed. This plan itself never changes the current status.

## Required tests and gates

All tests use disposable filesystem/native fixtures only. No live Stardew process, SMAPI launch, action mutation, save/fixture mutation or release action is part of this plan.

1. **Schema and opacity:** strict records accept only the minimal binding and an opaque active pointer; reject duplicate/unknown/secret/capability-shaped fields, including `runtimeRoot`, `continuityId`, `companionId`, `playerId`, `authorityGeneration`, guardian/Job/lease fields, malformed pointers, unsafe revisions, invalid state pairs, oversized input and prototype pollution. JSON clone/forged `AdmittedStardewInstallation` cannot reach either Stage C or Stage D request.
2. **Picker publication:** selected candidate is admitted before write; cancellation preserves ready; admission/write/reread failures publish no ready state; replacement is atomic; captures contain neither sentinel locator nor derived SMAPI path.
3. **Prepare-and-bind linearization:** fixture crashes before, during and after every internal persistence point of the bootstrap-owner transaction. Recovery exposes only neither side or an owner-prepared reservation plus record pointer with the same correlation; no standalone record CAS, one-sided orphan, prepared capability replay or cross-correlation bind can consume Phase A, reach Stage C/D or spawn. A missing nominal owner seam blocks implementation.
4. **Settlement, orphan and quarantine:** fixtures cover caller loss after prepare-and-bind, Phase A uncertainty, every running lifecycle crash point, proof-before-commit, commit interruption and post-commit observation loss. Only the matching Design 102 settlement proof through the owner transaction releases the pointer. Owner-recognized orphan attempts enter its cancellation/containment and terminal quarantine path; ambiguous/missing/mismatched/unpersistable outcomes remain unavailable, do not release the pointer and cannot start a successor.
5. **Independent admissions:** Stage C and cabin-confirmed Stage D each invoke admission anew with different request-scoped capabilities. Post-registration root/leaf/reparse/volume/object changes prevent the affected phase. Stage C capability cannot reach Stage D; Stage D cannot consume launch reservation before its callback revalidates materialized bridge config and deadline.
6. **Lock and session lifetime:** two-process Windows fixture proves an active pointer blocks register, replace, revoke and competing `game.launch`; the registration lock and owner transaction scope are released before Phase A and remain unheld through Stage B/C/D, attach, enter, STOP and teardown. Generic stale-lock recovery alone leaves the successor unavailable.
7. **Lifecycle topology:** lifecycle core owns Phase A/B/C/D, STOP/disconnect/quarantine and future control. Bootstrap owner exclusively owns attempt recovery and transaction linearization. Registration itself has zero spawn/bridge/materializer/enter/cleanup/recovery calls; no parallel control or recovery seam exists.
8. **Host privacy:** static and runtime boundary tests prove no browser/public IPC/state/log/error/telemetry/test snapshot receives or derives sentinel locator, executable-derived path, profile values, active pointer, guardian facts, registration revision or registration status. There is no `readView()`, registration browser DTO, browser state provider import, endpoint or `GameBrowserStateV1` field. The existing no-path setup completion remains category-only.
9. **Profile deletion:** static/runtime tests reject `--profile`, profile paths/objects and profile-derived fields in product/control contracts. Source inventory permits remaining profile references only inside action-development-local code/tests; action/catalog/visibility/release snapshots remain byte/semantic unchanged according to their existing checks.
10. **Boundary inventory and TOCTOU:** production import tests reject registration-core/storage imports from Preview, Portfolio, operator selection, generic launcher, browser DTO, run manifest, operational runner and action-development. Document and test the residual final-admission-to-spawn boundary honestly; this plan does not claim immunity beyond Stage C/D fresh rechecks.

Commands at the final gate use existing scripts only:

```bash
npm --prefix design run check
pnpm --dir host build:test
pnpm --dir host test
pnpm --dir host typecheck
git diff --check -- design/architecture/stardew-installation-runtime-registration-plan.md
git status --short
git diff --cached --name-only
```

The implementation lane adds focused compiled `node:test` commands for the registration selector, bootstrap-owner transaction/crash matrix, lifecycle-core choreography, bootstrap guardian settlement interface and profile-boundary tests. The Windows two-process/guardian matrix must run on supported Windows with no skip; non-Windows output is an explicit unsupported gate and cannot close registration.

## Completion evidence

Registration is complete only when an independent reviewer can verify all of the following from source-bound evidence:
- exactly one Host-private registration record schema exists for each Windows user's single registration under the canonical durable root; it contains the ready locator and, only while active, the exact bootstrap/guardian attempt pointer, with no legacy import/adoption/read-repair/fallback or parallel registration fence;
- native picker selection has no browser path round trip and admission precedes durable publication;
- the bootstrap owner, not registration, provides a private nominal crash-safe prepare-and-bind transaction whose committed state is exactly an owner prepared reservation paired with the same `activeAttempt` correlation, or neither; the owner-only matching settlement-and-release transaction cannot free an executable or ambiguous attempt;
- fixture evidence covers every listed crash window, orphan recognition, rollback and terminal quarantine: no partial pair, stale lock, PID probe, time passage, browser request, selector retry or record repair can create a successor;
- `game.launch` consumes the owner-returned prepared reservation in Phase A then Stage B, fresh-admits independently at Stage C and cabin-confirmed Stage D, and retains neither capability, registration lock nor owner transaction scope into the session;
- no browser projection, `readView()`, registration DTO, registration endpoint or `GameBrowserStateV1` field exists; a future projection remains separately blocked pending its own frozen contract;
- all current and future control enters the same private lifecycle core, with no registration cleanup authority or parallel recovery/control path;
- no production/control code accepts an action-development profile or profile-derived installation authority, while action-development-local profile usage remains isolated;
- `equip_tool` implementation/catalog/visibility/release and all other action facts are unchanged;
- focused tests, Host test/typecheck, documentation check, Windows matrix, diff hygiene and two independent reviews pass;
- `git diff --cached --name-only` is empty unless a separately approved staging operation has occurred.

## Stop conditions

Stop and request a design decision instead of adding a workaround if:

- Design 102 source verification cannot establish an exact correlation-bound containment settlement proof interface;
- bootstrap owner cannot provide the private nominal crash-safe prepare-and-bind and matching settlement-and-release transactions, or tests cannot prove their neither-or-matching-pair crash invariant;
- lifecycle-core integration would require serializing an admitted capability, exposing a locator, retaining the registration lock into a session, or adding a second lifecycle owner;
- a profile consumer cannot be classified as action-development-local versus prohibited product/control use;
- deleting a product profile edge would require changing `equip_tool`, catalog, visibility, release or action semantics;
- current root-layout/deployment validity and the minimal desktop binding cannot be revalidated before the registration store's first write;
- tests cannot distinguish independent Stage C and Stage D admissions from reuse of picker-time or prior-request capability;
- a required requester needs a raw locator/profile/active pointer/guardian field across a browser, operational, release or public IPC boundary;
- any requester asks for registration browser state before a separate owner freezes the complete `GameBrowserStateV1` field/endpoint contract.
