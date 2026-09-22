---
id: TASK-WINDOWS-RELEASE-STARDEW-WEB-UI-INSTALLATION
type: implementation-plan
status: active
owner: release-engineering
specs:
  - ../architecture/codebase-release-audit-2026-09.md
  - ../architecture/release-model.md
  - ../architecture/architecture-governance-and-anti-erosion.md
  - ../domains/stardew/integration.md
  - ../architecture/product-surfaces.md
---

# Windows Release 与 Stardew Web UI 安装发现实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. 本计划不创建新 worktree；在当前 checkout 中按 Loop 0–8 串行执行。RC 采用当前 checkout 的 baseline-relative 流程，不覆盖 Loop 0 之前已有 WIP。每个 Loop 必须先完成前置 Loop 的验收，再进入下一环。

**Goal:** 交付可信的 Windows Release Candidate：Host 自动探测 Stardew 安装并通过 Web UI 卡片让玩家确认或手动浏览，Chat/Game 前端完全解耦，同时闭合 Desktop、GameSession、Player survival、Chat/Tavern、质量工具和最终发布声明。

**Architecture:** Host 负责从 Steam 注册表/VDF（AppID `413150`）及 owner-approved known locations 产生不可信安装候选；Web UI 负责展示、确认、重试和手动浏览；所有来源统一进入 `admitStardewInstallation`、registration、launch 前 fresh admission 和 coordinator。Chat 与 Game 拆为独立 pane、独立状态和独立故障边界，只在显式绑定 continuity identity 时共享受治理长期 Memory。整个发布按 Loop 0–8 串行闭环，任何未验证项保持 blocked/unverified。

**Tech Stack:** TypeScript/Node.js、React/TSX、C#/.NET、Windows Registry/VDF、WebView2、pnpm、Knip、dependency-cruiser、publint、jscpd、GitHub Actions、现有 Stardew admission/registration/coordinator 和 Desktop composition seams。

## Global Constraints

- `design/architecture/codebase-release-audit-2026-09.md` 是 draft checkout audit，不是架构权威，也不授予删除或重构权限；Loop 0 必须重新核验其事实。
- 不创建新 worktree；不执行无界 `git clean`、`reset`、`stash`、覆盖或删除当前 WIP。
- 自动发现只产生不可信 candidate proposal；不得扫描任意 PID、窗口、外部游戏或绕过 strict admission。
- Web UI 可以展示候选并接收玩家确认/手动浏览，但不能获得 path、PID、pipe、token、Job、native frame 或 installation capability；路径留在 composition-private ingress。
- 候选、手动路径和已登记 locator 都必须经过同一个 `admitStardewInstallation`、registration 和 launch 前 fresh admission。
- Chat/Game 必须生命周期、错误、状态和恢复隔离；Game 不接管 Chat，Chat 不暂停或恢复 Game。
- 不删除或削弱 exact cancellation、receipt-backed recovery、`stardew-logical-action-recovery-journal.ts`、Native AI Farmhand topology、Portfolio isolation 或 test-only fixture isolation。
- 不用 Knip ignore/baseline、`--no-exit-code`、宽泛 `.gitignore`、报告改写或行数指标制造绿色。
- 单项 action、fixture、Browser Preview、Chat Core 或静态测试不能替代对应的 Desktop/Game/Open Game/Companion release gate。

---

# 串行闭环总览

```text
Loop 0  基线冻结与保护
  ↓
Loop 1  Stardew Web UI 安装发现与选择
  ↓
Loop 2  ChatPane / GamePane 前端解耦
  ↓
Loop 3  Desktop 宿主启动与 Presentation 握手
  ↓
Loop 4  GameSession Create / Resume 世界绑定
  ↓
Loop 5  Player 存活、显式 End Game、Guardian 恢复
  ↓
Loop 6  Chat / Tavern 独立发布门禁
  ↓
Loop 7  质量工具、审计收敛、CI 发布门禁
  ↓
Loop 8  干净 RC 构建与发布声明矩阵
```

任何 Loop 失败都停止推进；失败只进入 evidence/blocker，不通过降级、旁路或新 authority 解决。

---

## Loop 0：工作区基线冻结与保护

**目标：** 将当前 140+ tracked 修改、未跟踪诊断脚本和生成物变成可审计的 baseline，不覆盖主 checkout WIP。

**Loop 0 状态（2026-09-19）：BLOCKED / moving-checkout snapshot。** 基线采集期间 checkout 的 `HEAD`、tracked diff 和 untracked inventory 发生变化；证据 manifest 保留初始与后续快照，当前状态不能宣称为稳定 release baseline。未创建 worktree、未清理/覆盖/删除 WIP；Loop 1 保持 blocked。

**Files / evidence:**
- `design/architecture/codebase-release-audit-2026-09.md`
- `design/architecture/codebase-hygiene-and-simplification.md`
- `design/tasks/active/113_WINDOWS_RELEASE_AND_STARDEW_WEB_UI_INSTALLATION_IMPLEMENTATION_PLAN.md`
- 新建 owner-approved exact-path inventory / evidence manifest

**Steps:**

- [x] 记录 `git status --porcelain=v1 --untracked-files=all`、`git diff --stat`、`git diff --name-only`、`git ls-files --others --exclude-standard`、branch/ref 和恢复锚点。
- [x] 逐个分类 source WIP、生成物、scratch/probe、runtime state、evidence、unknown、disposable candidate，记录 provenance、consumer、owner、运行中使用情况和 rollback anchor。
- [x] 保护 `.pi/`、`.pi-subagents/`、`.pi-subagent-sessions/`、`context.md`、active handoffs、plans、subagent reports 及主 checkout WIP；本 Loop 不清理。
- [x] 重新运行并记录 `pnpm check:host-module-graph`、`pnpm check:knip`、`pnpm check:publint`、`pnpm check:text-hygiene`、`git diff --check` 的 exit code 和摘要。
- [x] 建立 finding matrix：`finding / authority / consumer / owner / affected claim / evidence / status`。
- [ ] 对 Portfolio 处置、clone 是否阻断、required-CI 证明、root quality/test 责任和未知消费者获取 owner decision；未决项保持 blocked。

**Gate：BLOCKED。** baseline、exact-path inventory、audit finding matrix 和 rollback anchor 已记录，但 checkout 稳定性、未知 consumer/owner、Portfolio 处置、clone blocking、required-CI 证明和 root quality/test 责任仍未闭合；本 Loop 未主动修改 production source，既有/并发 production-source WIP 未被归因或覆盖，不能进入 Loop 1。

---

## Loop 1：Stardew Web UI 安装发现与选择

> **Owner correction:** Web UI 卡片改变交互，不改变 Host authority。公开 command 传递 opaque、短生命周期、session-bound `candidateId` 或 picker intent，不把 raw path 作为 browser state 或通用 command。Steam registry/VDF 是首批 provider，不是永远唯一 provider。

**目标：** Steam 注册表/VDF 探测候选，Web UI 用安装向导卡片展示，一键确认或手动浏览；所有选择统一严格准入和持久化。

**Files:**
- Create: `host/src/windows-stardew-installation-discovery/internal.ts`
- Create: `host/src/windows-stardew-installation-discovery/index.ts`
- Test: `host/src/windows-stardew-installation-discovery/index.test.ts`
- Modify: `host/src/stardew-production-lifecycle-coordinator.internal.ts`
- Modify: `host/src/games/stardew/provider.ts`
- Modify: `host/src/game-browser-contract/index.ts`及其 composed contract tests
- Modify: `dialogue-web/src/components/ComposedReferenceGameApp.tsx`或定位后的现有 Game route；不新增 parallel browser API
- Test: 对应 Host、browser、React tests

**Contract:**

```ts
type StardewInstallationCandidate = Readonly<{
  candidateId: string;
  source: "steam-registry" | "steam-vdf" | "known-location";
  label: string;
  displayPath: string;
  status: "candidate" | "invalid" | "admission_required";
}>;

type InstallationCommand =
  | { operation: "confirm_candidate"; candidateId: string }
  | { operation: "open_manual_picker" }
  | { operation: "retry_discovery" }
  | { operation: "cancel" };

type StardewInstallationDiscoveryResult = Readonly<{
  candidates: readonly StardewInstallationCandidate[];
  diagnostics: readonly ("registry-unavailable" | "vdf-unreadable" | "no-candidates" | "candidate-invalid")[];
}>;
```

- [ ] 先写失败测试：读取 Steam registry 和 libraryfolders VDF，解析 AppID `413150`，去重并稳定排序；解析失败、权限拒绝、损坏 VDF、重复路径和无候选必须可诊断。
- [ ] 只读取 owner-approved Steam metadata 和有限 known locations；不任意递归磁盘，不扫描 process/window/PID，不自动 attach。
- [ ] 在 Web UI 增加安装向导卡片：自动候选、明确的 Confirm、Choose another folder、Retry、Cancel、invalid installation 和 discovery unavailable 状态。
- [ ] 手动浏览继续使用已验证的 native folder picker；Web UI 的“手动浏览”只触发 narrow authenticated command，不把 raw path 交给浏览器状态或公共 DTO。
- [ ] 将 discovered candidate 和 manual path 统一提交到现有 `selectStardewFolder`/registration owner seam；统一调用 `admitStardewInstallation`，失败不写 ready registration。
- [ ] 在 registration 前和 launch 前分别进行现有 fresh admission；不让 discovery candidate 绕过版本、文件、reparse、path identity 或 target-version 检查。
- [ ] 证明 durable registration 只保存允许的 locator/schema/revision/state，不保存 admitted capability、executable chain、PID、pipe、token、Job、generation 或 debug fields。
- [ ] 运行 discovery unit、Host coordinator、browser contract、React mounted-flow tests 和 `pnpm --dir host typecheck`。

**Gate:** Web UI 可呈现候选并确认/手动选择；候选和手动选择进入同一 admission/registration authority；没有自动启动或外部 attach。

---

## Loop 2：ChatPane / GamePane 前端解耦

**目标：** 让 `ComposedReferenceGameApp.tsx` 的 Chat/Game 状态拥有者、命令路由和 presentation view 分离；`<ChatPane />` 与 `<GamePane />` 是实现手段，不是行数指标。

**Files:**
- Modify/split: `dialogue-web/src/components/ComposedReferenceGameApp.tsx`
- Create: `dialogue-web/src/components/ChatPane.tsx`
- Create: `dialogue-web/src/components/GamePane.tsx`
- Create/modify: pane-specific state/view-model files at the existing route boundary
- Test: dialogue-web component/browser tests and Host composed contract tests

- [ ] 先写失败测试：Game 未配置/断线时 Chat 仍可发送；Chat provider failure 时 Game state/attachment 不被暂停；两者可同时启动、停止、恢复。
- [ ] 把 Chat thread/provider/presentation state 只保留在 `ChatPane`；把 Game session/installation/capability/receipt/lifecycle state 只保留在 `GamePane`。
- [ ] 两个 pane 只能消费各自 typed narrow projections；不能通过共享 React state、raw history 或 hidden fallback 互相接管。
- [ ] continuity identity 只通过明确的长期 Memory binding seam 共享，不共享 Chat raw history、Game world、credential、capability 或 receipt。
- [ ] 继续使用唯一现有 browser listener/composition，不新增 parallel reconnect API、第二 listener 或 browser registry。
- [ ] 测试 refresh、close、provider failure、game disconnect、Game resume 和 unmounted route；验证错误信息不互相污染。

**Gate:** Chat/Game 独立渲染、故障和生命周期测试通过；没有破坏现有 authenticated browser contract。

---

## Loop 3：Desktop 宿主启动与 Presentation 握手

**目标：** 通过 bundled runtime 和 Desktop-owned private bootstrap handoff 启动 exact Host，完成 root-layout 校验、bootstrap ack 和 WebView2 presentation。具体 transport 必须由 Desktop owner 在实现前冻结，不得新增第二套 bootstrap/control authority。

**Files:**
- Modify: `desktop/GameBuddy.Desktop/RuntimeSupervisor.cs`
- Modify: `desktop/GameBuddy.Desktop/Program.cs`
- Modify: `desktop/GameBuddy.Desktop/DesktopHostBootstrapBroker.cs`
- Modify: focused `desktop/GameBuddy.Desktop.Tests/*`
- Modify: `host/src/bootstrap/wire/desktop-runtime-bootstrap.internal.ts`
- Modify: `host/src/composition/desktop-host-composition.ts`
- Modify: corresponding artifact/presentation tests

- [ ] 先写失败 source-bound test：production child 收到 `GAMEBUDDY_HOST_DEPLOYMENT_MANIFEST`、合法 `GAMEBUDDY_HOST_GAME_SESSION_MODE`、允许 surface 和必要 narrative nonce，并返回 bootstrap ack。
- [ ] 使用 Desktop-owned typed assembly input；来源只能是 immutable selected generation 和 approved product intent，不接受 browser path/PID/pipe/token/game facts。
- [ ] 实现已批准的 Desktop-owned typed handoff 和 root-layout revalidation；transport 可复用现有 broker frame、stdin 或其他已批准 seam，但不得新增第二套 bootstrap/control authority，不依赖 system Node/PATH、repository fallback 或未治理 env input。
- [ ] 接通 Desktop presentation readiness consumer、WebView2/tray，并传播 close/drain failure；不可伪造 ready。
- [ ] 单独验证 recovery factory 是否接入；resident Guardian 启动不等同 recovery closure。
- [ ] 运行 Desktop tests、Host bootstrap tests、artifact composition checks 和 Windows source-bound smoke。

**Gate:** exact bundled Host 可获得 assembly input、返回 ack、进入 composition 并展示 formal UI；否则 Desktop claim blocked。

---

## Loop 4：GameSession Phase 2 Create / Resume 世界绑定

**目标：** 先冻结 Stardew world-creation authority，再实现真实 world binding 创建与持久化；Resume 只重连已登记 binding，不盲扫外部进程。

**Files:**
- Modify: `host/src/games/stardew/provider.ts`
- Modify: `host/src/stardew-production-lifecycle-coordinator.internal.ts`
- Modify: `host/src/games/stardew/lifecycle/stardew-owned-farmhand-game-world-binding-resolver.internal.ts`
- Modify: `host/src/continuity-semantic-production-coordinator.internal.ts`
- Modify: existing GameSession/browser/React tests

- [ ] 先完成 world-creation boundary card：明确 producer、world/save ownership、cleanup、failure/quarantine、initial observation、production/fixture topology 和 durable binding transition；未冻结前不得补一个 callback 仅让 provider 不再返回 unavailable。
- [ ] 在 boundary card 通过后添加 production Stardew `createWorldBinding` producer；它返回 opaque bindingRef 和窄 observation，不泄露 save path、PID、Job、pipe/token 或 native launch fact。
- [ ] Create 必须按 `pending → registered/failed → resumable` durable 状态转移；world creation、binding persistence、initial observation 任一失败都不得 ready/resumable。
- [ ] Resume 只消费已有登记 binding，创建新 activation，重新 authentication/observation sync，不恢复旧 task/action authority。
- [ ] UI 显示 Retry、Cancel、Start new game 和六类稳定状态：`disconnected`、`reconnecting`、`syncing`、`ready-actions-paused`、`unavailable`、`gameended`。
- [ ] 运行 fresh-root persistence、coordinator、adapter、composed-browser 和 React flow tests。

**Gate:** Create/Resume 的 producer→consumer→verifier 闭环成立；失败不留下误导性可 Resume 状态。

---

## Loop 5：Player 存活、显式 End Game 与 Guardian 恢复

**目标：** 区分 Player world 与 AI authority；AI 崩溃/普通 close 不误杀游戏，只有显式 End Game 终止 Player。

**Files:**
- Modify: `host/native/windows-bootstrap-guardian/WindowsJobOwner.cs`
- Modify: `host/native/windows-bootstrap-guardian/WindowsRoleLauncher.cs`
- Modify: `host/native/windows-bootstrap-guardian/Program.cs`
- Modify: `host/src/stardew-player-host-process-owner.ts`
- Modify: `host/src/stardew-ai-client-process-owner.ts`
- Modify: `host/src/stardew-production-lifecycle-coordinator.internal.ts`
- Modify: Desktop broker/supervisor and focused Windows fixture tests

- [ ] 先写失败 fixture：AI crash、normal close、controller EOF、last Guardian handle close 时 Player marker 仍存活；explicit authenticated End Game 才终止 Player。
- [ ] 接入 distinct recovery Guardian session 和 exact lease/recovery CAS；old lease 未释放时 recovery unavailable，不自动复用旧 authority。
- [ ] 验证 disconnect 停止新 action、accepted short step 到安全点、unknown 保持 unknown、Resume 不 replay 旧 task/action。
- [ ] 运行 Windows source-bound failure matrix、Guardian tests、coordinator tests 和 redacted lifecycle evidence。

**Gate:** Player survival、End Game、recovery、unknown semantics 均有目标 Windows topology evidence。

---

## Loop 6：Chat / Tavern 独立发布门禁

**目标：** 在 fresh root 通过 Chat/Tavern 正式 live gate，不将 Chat 结果扩大为 Game/Desktop claim。

**Files:**
- Modify only failing Chat/Tavern owner files identified by the live gate
- Modify gate scripts only to repair fail-closed semantics

- [ ] 运行：`node tools/run-tavern-release-live-gate.mjs --orchestrate --profile chat-tavern-live`。
- [ ] 证明真实 embedded provider invocation/settlement、durable Chat read-back、main/failure/recovery attempts 和 mounted Tavern management operation/read-back。
- [ ] 覆盖 Companion、Persona、Scenario、Greeting、World Info、Memory、provider/model/credential/preferences、retention 的实际管理路径。
- [ ] 保持 selective Lorebook 独立 claim；`blocked`、`inconclusive`、`flaky` 和手写 report 都不是通过。

**Gate:** 只有 `passed` 才能声明 Chat/Tavern release；不影响 Game/Chat 生命周期隔离。

---

## Loop 7：质量工具、审计收敛与 CI 流水线门禁

**目标：** 修复 audit 记录的质量入口漂移和检查器失败语义，保证 release workflow 验证同一 commit 的 required checks。

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release-windows.yml`
- Modify/test: `tools/check-publint.mjs`
- Review only until owner decision: `jscpd.json`, `knip.json`, dependency-cruiser config
- Add/test: `tools/check-production-pack-load.mjs` / `tools/check-production-pack-load.test.mjs`（借鉴 magic-context-airp `smoke-tui-pack-install.ts` 的 packed-install load 模式，见下）

- [ ] 先写 command-map tests，明确 root `quality:check`、root `test`/`test:all`、CI、protected release、report-only 和 live gate 的责任与失败语义。
- [ ] 使 publint 对非 JSON 输出、unknown error code、缺少/非法 status 和 unexpected vendor gap fail closed；只保留 exact owner-approved gaps。
- [ ] 按真实 package script、CI/release workflow、package exports/bin、外部进程、operator/runbook consumer 逐项收敛 Knip；禁止 broad entry、ignore、baseline、`--fix`、`--no-exit-code`。
- [ ] 在 owner 决定前不改变 clone blocking 语义、不把 dependency-cruiser cycles 偷塞进 quality gate；每个 finding 保留 owner/evidence/claim impact。
- [ ] 让 release workflow 通过 GitHub checks/status 或 approved protected-environment contract 验证同一 commit 的 required CI；不能假设 YAML 自身提供仓库保护。
- [ ] 运行 `check:publint`、`check:knip`、`check:text-hygiene`、`check:host-module-graph`、相关 workspace tests 和 workflow validation。

**已落地（2026-09）：packed-install load gate。** `check:production-pack-load` 验证 `host/dist/current.json` 指向的 immutable generation 可真实加载（用 generation 自带 bundled Node runtime 加载具备 `import.meta.main` 守卫的 bootstrap entry 全闭包），而不是只检查文件存在。启发来自 magic-context-airp fork 的一个真实缺陷：artifact 磁盘完整但打包白名单漏掉传递依赖，导致发布后 `Cannot find module`。这是 release 级 protection：任何打包闭包漂移（入口缺失、bundled runtime 缺失、传递模块缺失）都会 fail blocked。本地验证：check passed on current generation；测试 6/6（pointer missing/unreadable、entry missing、runtime missing、broken transitive closure、complete pass）。

**Gate:** 检查入口、失败语义、CI/release 同 commit 约束和剩余 findings 都可解释；未知 finding 仍 blocked，不被遮蔽。

---

## Loop 8：干净 RC 构建与发布声明矩阵

**目标：** 从一个确定 revision 生成 Windows RC，运行完整玩家黑盒流程，并输出按 claim 分层的不可伪造 release matrix。

**Files / evidence:**
- 当前 checkout 的 Loop 0 baseline-relative release candidate；不覆盖 Loop 0 之前的 WIP，不创建新 worktree
- immutable Host/Desktop/native helper artifact manifests
- redacted release evidence report

- [ ] 在 owner-approved RC checkout 构建 bundled Node runtime、Host、native helper、dialogue artifact 和 Desktop installer；验证 runtime 不依赖 system Node/PATH/repository fallback。
- [ ] 黑盒执行：Steam/VDF discovery → Web card confirmation → strict admission → registration → launch；再执行 discovery unavailable → native picker → manual confirmation fallback。
- [ ] 执行 Create/Resume、failure/retry/cancel/new-game、Player survival/recovery、Chat/Tavern gate，以及纳入本次 claim 的 action/Open Game gate。
- [ ] 在同一 revision 运行 `git diff --check`、text hygiene、format/lint/typecheck、Knip、publint、module/import boundaries、workspace tests、artifact checks 和 release workflow checks。
- [ ] 输出字段：`releaseClaim`、`passedGates`、`blockedGates`、`evidencePaths`、`knownNonClaims`、`unverifiedAssertions`、`revision`。
- [ ] 只按 Loop 0 的 exact disposable-path manifest 清理；不得触碰 Pi/Agent runtime state、durable data、credentials、Chat/Memory、Game lifecycle state 或 update staging。

**Gate:** 每一个发布声明都有对应 producer→consumer→verifier evidence；任意缺失项保持 blocked/unverified，不投影 ready。

---

## Acceptance matrix

| Claim | 必须闭合 | 不能替代 |
|---|---|---|
| Stardew installation onboarding | Steam registry/VDF proposal、Web card confirm、manual picker fallback、strict admission、registration | 固定路径、单元测试、自动 attach |
| Chat/Game UI | 独立 ChatPane/GamePane、独立 stop/recover/error、Memory-only explicit binding | 共享单体状态、raw history 共享 |
| Desktop Player Release | bundled artifact、bootstrap ack、presentation、onboarding、update、recovery、full journey | Browser Preview、resident Guardian、Host unit tests |
| GameSession | real Create/binding/observation、Resume、retry/cancel/new game、durable failure | 空 session ID、provider declaration |
| Open Game | natural-language prompt、Agent observe/act/observe、native receipt/postcondition、STOP/unknown | 单项 action live、Body Program offline |
| Chat/Tavern | `chat-tavern-live` passed、provider settlement、durable read-back、UI operation evidence | Chat Core、fixture、手写 report |
| Voice/Companion | separate real asset/device hard gate | wire rehearsal、deterministic fixture |
| Codebase release readiness | frozen baseline、honest checks、same-commit CI、known findings、clean RC | dirty checkout、audit snapshot、`[x]` checkbox |

## Stop conditions

立即停止当前 Loop 并提交 owner decision：

- Web UI 提案需要扫描任意进程/窗口或产生第二 installation authority；
- Create 需要绕过 coordinator/registration；
- 修复要求删除/弱化 RecoveryJournal、精确取消或 native topology；
- audit finding 存在未知 consumer、无 rollback anchor 或与 current owner 冲突；
- 只能通过 broad ignore、baseline、`--no-exit-code` 或 report rewriting 变绿；
- fixture topology 与正式 Native AI Farmhand topology 无法区分；
- release candidate 无法由一个确定 revision 重现。

## Final release rule

只有当报告能逐项回答以下问题，才能发布对应 claim：

1. 玩家在 Web/Desktop 中看到了什么、执行了什么？
2. 哪个 owner 产生事实？
3. 哪个 consumer 使用或展示事实？
4. 哪个 verifier 证明结果？
5. 哪个 evidence path 和 revision 支持结论？
6. 哪些能力明确未包含？
