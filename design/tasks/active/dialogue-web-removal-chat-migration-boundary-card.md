---
id: CARD-DIALOGUE-WEB-REMOVAL-CHAT-MIGRATION-BOUNDARY
type: boundary-card
status: active
owner: product-runtime
---

# dialogue-web 删除与 Chat 迁移前置边界卡（Lane E 拆分：E1/E2/E3）

> 本卡是 Lane E（`handoff-action-nav.md` §Lane E，:309–349）的 contract/owner 层边界冻结（主 checkout 前置审计）。
> 全部产出为**只读审计 + 边界卡文档**；本卡不写任何 production 源码，不提交（no commit），不运行任何进程管理命令（纪律：绝不按名称 kill node）。
> 关联 authority：`handoff-action-nav.md`（lane 定义与依赖）、`design/40_CHAT_PIPELINE_RELEASE_ENGINEERING_IMPLEMENTATION_PLAN.md`（P9/P10 最终门）、`design/90_SIMPLIFIED_PI_BACKED_CHAT_PRODUCT_IMPLEMENTATION_PLAN.md`（Chat 现行执行 authority）、`design/28_TAVERN_MANAGEMENT_CAPABILITY_MATRIX.md`（P9 target rows）、`design/104_PLAYER_ONBOARDING_AND_SURFACE_JOURNEYS_DESIGN.md`（fresh-root journey）。

## 1. 目的与范围

`host/src/dialogue-web-main.ts` 是临时 Chat/browser entry，仍被 production artifact（`host/production-artifact.config.json` entryRoots）、TypeScript（`host/tsconfig.production.json` / `tsconfig.chat-live.json` / `tsconfig.test.json`）、package/script（`host/package.json` `start:dialogue`）、module-graph 工具（`package.json` `check:host-module-graph`、`tools/check-host-production-import-boundary.mjs` DEFAULT_ROOTS）、artifacts（chat-live 一次性构建机、`production-artifact.test.mjs`）、live gates（`tools/run-tavern-narrative-gate.mjs` 双 spawn 分支；`tools/run-tavern-release-live-gate.mjs` profile env）与 dev 工具（`tools/drive-interactive-player-session.mjs`）引用。它是破坏性删除对象，不是兼容练习（handoff :315 "destructive migration, not a compatibility exercise"）。

本卡冻结：

1. **完整 caller 清单与逐项替代判定**（§2.1）；
2. **三 profile 的产品必要性**：reference（Chat-only）/ management（Tavern 管理）/ reference-game（已迁入 composition，3238f44）（§2.2）；
3. **fresh-root Chat/Tavern final gate 现状与 gap 清单**（§2.3）；
4. **Lane E 切分为 E1/E2/E3 及顺序、owned paths、acceptance、stop rules、validation budget**（§3–§8）。

前置依赖（handoff :328–332）已闭合：Lane C resume owner callback/redacted projection（`918ae1a`）、Lane D 单一 composition-owned Chat+Game startup/close 与 presentation admission（`84b8317` + `3238f44`）。本审计确认 HEAD=`3238f44` 且上述依赖已在主干历史中。

## 2. 现状审计（引用 file:line）

### 2.1 `dialogue-web-main` 生产 caller 全清单与替代判定

**A. Production artifact / TypeScript / package / module-graph（E3 破坏性变更）**

| caller | 位置 | 删除后如何替代 / 是否仍必需 |
|---|---|---|
| `host/production-artifact.config.json` `entryRoots` | :3（`"dialogue-web-main.js"`） | 移除该 entry；`verificationRoots`（:16）**保持**（`reference-pipeline-dialogue-web.js`/`tavern-management-dialogue-web.js`/各 static-shell/`tavern/static-artifact/index.js` 是 E1 迁移后 composition 变体仍消费的 API 层） |
| `host/tsconfig.production.json` `files` | :12（entry）、:13（`src/dialogue-launch-mode.ts`） | 删除两行；`dialogue-launch-mode.ts` 仅被 entry 与其测试引用（见 §2.1.D），随 entry 删除 |
| `host/tsconfig.chat-live.json`（整文件） | :15 entry、:16 `magic-context-authored-context-bridge.d.ts` | **整文件删除**：chat-live 一次性 artifact 机（D:\GameBuddy-chat-live-tmp）只服务于 entry 独立运行；entry 删除后无源可编（见 D4） |
| `host/tsconfig.test.json` `exclude` | :21–22（entry + `dialogue-web-main.test.ts`） | 删除；该 `.test.ts` 在 HEAD 不存在（仅 .git 备份树有旧副本），exclude 为陈旧引用 |
| `host/package.json` `start:dialogue` | :14 | 删除脚本；`host/README.md:68` 与 `tools/dialogue-live-run-charter.md:17` 同步移除/改指向 composition 产物 |
| `knip.json` host `entry` | :26（`src/dialogue-web-main.ts!`） | 移除；`host/knip.json` 不存在（仅根 `knip.json`） |
| `package.json` `check:host-module-graph` depcruise roots | :50（`host/src/main.ts host/src/dialogue-web-main.ts ...`） | 从 root 列表移除该路径；depcruise 配置本身不点名 entry（.dependency-cruiser.host-production.cjs 无 entry 引用） |
| `tools/check-host-production-import-boundary.mjs` `DEFAULT_ROOTS` | :11（含 `host/src/dialogue-web-main.ts`） | 移除；`tools/check-host-production-import-boundary.test.mjs` 同步更新（fixture roots 中大量出现） |

**B. Artifact 构建/验证脚本与测试（E3）**

| caller | 位置 | 删除后如何替代 / 是否仍必需 |
|---|---|---|
| `host/scripts/build-chat-live-artifact.mjs` | :25 `CHAT_LIVE_SOURCE`、:28 `CHAT_LIVE_ENTRY`、:74 tsconfig shape 断言 | **整文件删除**（chat-live 机，D4），无替代 |
| `host/scripts/start-chat-live-artifact.mjs` | :14 `CHAT_LIVE_ENTRY` | **整文件删除**（chat-live 机，D4） |
| `host/scripts/chat-live-artifact-support.mjs` | :10–15 packages、:554–559 identity、:666 `entry = "dialogue-web-main.js"` | **整文件删除**（chat-live 机，D4） |
| `tools/chat-live-artifact-support.test.mjs` | :8–16 imports、:80 fixture entryPath `dialogue-web-main.js` | 随 chat-live 机删除 |
| `tools/chat-live-artifact-launcher.test.mjs` | 全文件（import `start-chat-live-artifact.mjs`） | 随 chat-live 机删除 |
| `host/scripts/production-artifact.test.mjs` | :515 emitted roots 断言、:1361 `createProductionChildEnvironment("dialogue-web-main.js")`、:1667 starter roots 循环 | 改为 absence 断言（entry 不得出现在 emitted roots / dist-test / starter 受理列表）；`createProductionChildEnvironment` 对非 main/farmhand entry 的"无 control 凭据"语义保留在 main.js 用例即可 |
| `host/scripts/build-test-artifact-locked.mjs` | :41 断言 dist-test 不含 `main.js`/`dialogue-web-main.js` | 保留 absence 断言（语义不变，E3 后 trivially 成立，作为回归网） |
| `host/scripts/test-artifact-protocol.test.mjs` | :61 断言 dist-test 无 `dialogue-web-main.js`（ENOENT） | 保留（absence 断言即验收项） |
| `host/scripts/check-production-artifact.mjs` | 无 entry 点名 | 不变（通用 config 驱动） |
| `host/scripts/build-production-artifact.mjs` | 无 entry 点名（:18–19 是 dialogue-web **browser** artifact root，保留） | 不变；browser artifact（`browser/tavern/v1`）不是删除对象 |

**C. Live gates 与 dev 工具（E2 重定向 + E3 清理）**

| caller | 位置 | 删除后如何替代 / 是否仍必需 |
|---|---|---|
| `tools/run-tavern-narrative-gate.mjs` | :31–32 `CHAT_LIVE_ARTIFACT_ROOT`/`CHAT_LIVE_ENTRY`、:351/:408–421 `GAMEBUDDY_TAVERN_PROFILE=chat-tavern-live` 双分支 spawn | **E2 重定向**：spawn 目标改为 composition-owned production artifact（保留 fresh mkdtemp root + schema-v2 manifest + 真实 provider 纪律）；chat-live 分支删除 |
| `tools/run-tavern-narrative-gate.test.mjs` | :53–55 启动失败词表 `production_artifact_entry_missing:dialogue-web-main.js` | 随 E2 新 spawn 协议更新失败词表；E3 后 entry 名零出现 |
| `tools/run-tavern-release-live-gate.mjs` | :7–15 profile imports、:539 `GAMEBUDDY_TAVERN_PROFILE: profile` env | E2 随 narrative gate 重定向；profile 编排语义保留（prereq checker 不点名 entry） |
| `tools/drive-interactive-player-session.mjs` | :8 `CHAT_LIVE_ENTRY`、:58–66 spawn chat-live artifact | dev 工具：E3 删除（其唯一目标就是 chat-live entry） |
| `tools/run-player-managed-memory-http-live.mjs` + `.test.mjs` | **HEAD 不存在**（`7464749` 已删除，且为 HEAD 祖先；仅 .git 备份树有副本） | **handoff :325 清单已过时**：main checkout 无此 caller；其 Memory live 覆盖在 E2 以 management profile journey 重新落户（见 §2.3 G4） |

**D. 与 entry 绑定的 Host 源码（E3）**

| 文件 | 事实 |
|---|---|
| `host/src/dialogue-web-main.ts` | 删除对象本体；三 profile 分支 :41–47；reference :49–101（自组装 listener/服务，MIGRATION-ERA 注释 :50–53）；reference-game :103–192（已改用 `startDesktopPresentationAdmission` :143）；management :194–262（自组装 management/memory/world-info 服务，MIGRATION-ERA 注释 :195–198） |
| `host/src/dialogue-launch-mode.ts` + `dialogue-launch-mode.test.ts` | entry 专属 launch 解析（:13–54）；仅被 entry 引用 ⇒ 随 entry 删除；composition 侧使用 `GAMEBUDDY_HOST_DEPLOYMENT_MANIFEST`/`GAMEBUDDY_HOST_GAME_SESSION_MODE`（wire :257–268），无等价物需求 |
| `host/src/windows-stale-lock-reclaimer/index.ts` | :121 `GAMEBUDDY_CHAT_LIVE_ARTIFACT` env 分支（chat-live 专属）⇒ 随 chat-live 机删除该分支，保留 published 路径 |
| `dialogue-web/`（browser） | **不删除**。browser artifact 与 `#profile=` fragment 路由（`dialogue-web/src/main.tsx:8–16`）保持；reference/management/composed-reference-game 三个 browser surface 都是产品表面 |

**E. 既有 absence 断言（保持并扩展为 E3 验收网）**

| 文件 | 位置 | 语义 |
|---|---|---|
| `host/src/continuity-semantic-game-operator-selection/...test.ts` | :252–254 | 生产模块源禁止 `integration-bootstrap`/`main.js`/`dialogue-web-main`/`createIntegrationCatalog(` |
| `host/src/continuity-semantic-deployment-composition/...test.ts` | :234 | facade internal 禁止 `dialogue-web-main` 等 ingress |
| `host/src/continuity-semantic-game-runtime-materializer/...test.ts` | :715 | S4c 禁止 `dialogue-web-main` 等 ingress |
| `host/src/continuity-semantic-game-runtime-binding/...test.ts` | :620 | 同上 |

**F. 非 caller（不计入 E3）**：`.git/*` 备份树（expanded-pr.patch、index-validation-d39、farmhand-pr-verify、lost-found、staged-* 等，git 内部）；`.dist-backup-before-rebuild/**/production-inventory.json:415`（生成物备份，下次 publication 自然重建）；`handoff-action-nav.md`（lane 权威文档，由 lane 协调更新，非生产代码）。

### 2.2 三 profile 产品必要性（判定）

| profile | 身份 / tier | 现状 | 产品判定 |
|---|---|---|---|
| **reference**（Chat-only） | `gamebuddy.chat-core.reference-pipeline` / `chat_core`（dialogue-web-main :58–64） | entry 内自组装 reference pipeline listener + Chat-lane 服务（:49–101） | **产品表面，非 preview**：即 Chat Core 的"one exact Chat"发布表面（design/40 :215 `chat_core_v1 released` = 单一已存在 exact Chat 的 release-grade send/context/presentation/stop/reconnect/restart；MEMORY #968/#1022 Chat 是与 Game 独立的产品表面）。**必须迁入 composition-owned owner 的 Chat-only 变体（E1），不能删除** |
| **management**（Tavern 管理） | `gamebuddy.tavern-management.chat-list-title` / `tavern_management`（dialogue-web-main :199–207） | entry 内自组装 management listener + management/memory/world-info 服务（:194–262）；尚未迁入 composition（注释 :195–198 明示） | **P9 Tavern management 产品表面**：design/40 §4.2（:191–207）"Mandatory plan completion" + P9（:1057–1101）+ MEMORY #1142（P9 必须完成，含 connection/model/credential/preferences、玩家可见 Memory、fresh-root production UI final gate）。**必须迁移进 composition-owned owner 的管理变体（E1），不能删除** |
| **reference-game** | composed reference-game browser | 已迁入 composition（`desktop-host-composition.ts:128–135` 经 `startDesktopPresentationAdmission`；`3238f44`） | 已达成；entry 内的 reference-game 分支（dialogue-web-main :103–192）是 composition 的浏览器预览副本，随 entry 删除 |

### 2.3 fresh-root Chat/Tavern final gate 现状与 gap

**现状**
- `tools/run-tavern-narrative-gate.mjs`：自建 `mkdtemp` root + schema-v2 deployment manifest（:145–154，含合成 principal/`bootstrapOperationId`/`authorityGeneration=1`）→ spawn production artifact entry（:413）或 chat-live 一次性 artifact（:412，`GAMEBUDDY_TAVERN_PROFILE=chat-tavern-live`）→ 经 authenticated reference Chat HTTP API 提交一个 content-free 真实 turn，要求真实 provider（:468 `runtimeSession && prompt && realTurn`）。它**不依赖 Tavern fixture/operator state**（manifest 全为 gate 自合成）。
- `tools/prepare-tavern-live-fixture.mjs`：Chat-Core-only 的 canonical 外部 fixture provisioner（design/40 :171 所述 `TavernLiveFixtureProvisioner`，写 SFW persona/scenario/examples/greetings 进 fresh root）。**最终门不得使用它**（design/40 :207, :1150）。
- browser 侧 `dialogue-web/tests/*.spec.ts`：运行于 `:4173` vite dev server（`playwright.config.ts:33–38`）或 in-process 组合 artifact 模块 + 窄 stub（reference-pipeline-browser.spec.ts :8–19）；**不是** immutable artifact 上 fresh-root 的 shipped-browser 黑盒 journey（design/40 P10 #4 :1121–1122 要求 real artifact + no `page.route()`）。
- 根因：只有 `dialogue-web-main.js` 提供"轻量 production artifact 内 Chat/Tavern 表面启动"入口；composition 表面只能经 Desktop Guardian bootstrap（`desktop-runtime-bootstrap.internal.ts:52–73`）到达。E3 删 entry 后必须由 E2 定义 final gate 的 spawn 协议。

**Gap 清单**

| # | gap | 归属 |
|---|---|---|
| G1 | **门 spawn 协议**：entry 删除后，narrative gate / release-live-gate 没有可 spawn 的 Chat/Tavern 生产入口；composition 只经 Guardian/root-layout bootstrap 可达，不能新增第二个产品 entry（handoff :340–341）。**E2 必须冻结**：最终门走 Desktop composition bootstrap（真实 Guardian + launcher-owned root layout，design/104 :278–294 §10 的 verifier journey 风格）还是经评审的 verifier seam；不得造第二 entry/alias/fallback | E2（决策点，stop-rule R1） |
| G2 | **browser 驱动**：无任何 spec 从 fresh GameBuddy-owned root 驱动 shipped browser artifact 打完整 journey（configure connection/model → create first Companion/Chat → select/bind approved artifacts → converse → stop/reconnect/restart/reopen → switch Chats → retention/export/Memory → durable read-back；design/40 :1150）。现有 spec 全在 dev server 或 in-process stub 上 | E2 |
| G3 | **management 能力缺口**：今日 management profile 仅挂 chat.list/rename/draft/World Info bind/Memory read+mutate（dialogue-web-main :200–206）；connection/provider/model 配置、显式 New Companion/New Chat、chat create/open/switch/archive、import/export、retention 未挂载（design/28 rows；design/90 :19, :69 明示缺失）。**final gate 的 journey scope 只能是已挂载能力**；P9 未挂载 rows 是 Lane E 之外的产品工作，但它们是完整 final gate 声明的前置 | E2 scope 限制（不阻塞 entry 删除本身） |
| G4 | **Memory live 覆盖缺失**：`run-player-managed-memory-http-live.mjs` 已在主干删除（`7464749`，HEAD 祖先）；management Memory 表面当前无 live 覆盖。E2 在 management journey 中重新落户（design/40 P9 #8 :1083；design/90 Task 2 :138–147 已定义 service/HTTP/browser 线） | E2 |
| G5 | **chat-live 一次性质阶段**：`GAMEBUDDY_CHAT_LIVE_ARTIFACT` env 分支（dialogue-web-main :79/:135/:239；stale-lock-reclaimer :121）+ chat-live 构建/启动/支持脚本 + `GAMEBUDDY_TAVERN_PROFILE=chat-tavern-live` 分支——全部只在"临时 entry 脱离完整 artifact 运行"时存在；E3 清空 | E3（D4） |
| G6 | **gate 失败词表**：`production_artifact_entry_missing:dialogue-web-main.js` 分类断言（narrative gate test :53–55）随新 spawn 协议改变 | E2/E3 |
| G7 | **root 归属**：当前 gate 用 `mkdtemp` root（任何 user 可写）；生产 UI final gate 应使用 launcher-owned root layout（MEMORY #2283：`%LOCALAPPDATA%\GameBuddy\data` 等）。E2 决策：gate 用 fresh launcher-root 还是保持 gate-owned 临时 root，需按 G1 一并冻结 | E2 |
| G8 | **provider 凭据通道**：narrative gate 依赖 env 中的真实 provider（operator 提供）；final gate 允许同 write-only player setup contract 的 ephemeral credential（design/40 :207）。E2 需决定 gate 走 player-visible setup route 还是保持 env 通道 | E2 |

### 2.4 主 checkout 工作树约束（Lane E 实施时必读）

主 checkout（HEAD `3238f44`）在以下 **Lane-E-owned 路径**已有**未提交 WIP**（`git status` 实测）：`host/production-artifact.config.json`、`host/tsconfig.production.json`、`host/package.json`、`knip.json`、`.dependency-cruiser.host-production.cjs`、`tools/run-tavern-narrative-gate.mjs`（+69/−27 chat-live 分支与 stderr 分类）、`tools/run-tavern-narrative-gate.test.mjs`（+18）。纪律：**不得 reset/clean/stash/覆盖**（MEMORY #2535）；E1/E2/E3 只能以 scoped hunk 方式携带本 lane 自己的改动，pre-existing WIP 必须保留且与 lane 产生的 absence 断言相容（例如 WIP 引入的 chat-live 分支正是 E3 要清空的，冲突按 lane 属主协调，不静默吞并）。

## 3. 冻结决策

### D1 — Lane E 切分与顺序

| slice | 内容 | 前置 | 产出 |
|---|---|---|---|
| **E1** | management + reference（Chat-only）启动迁移进 composition-owned owner 变体（D2/D3）；reference-game 已是 composition 唯一 owner（3238f44），不新建 | Lane D 已闭合 | `startDesktopPresentationAdmission` 三变体或等价参数化（chat-only / management / composed-reference-game），composition 单一 root，无第二 entry |
| **E2** | fresh-root Chat/Tavern final gate：按 G1/G7 冻结 spawn 协议；移除 chat-live 分支；Management/Memory live 覆盖落户；browser journey 覆盖已挂载 profile；更新 narrative/release-live gates 及其测试 | E1 | 不依赖 fixture/operator setup 的 fresh-root production UI final gate（scope = 已挂载能力，G3 外延） |
| **E3** | 删除 `dialogue-web-main.ts` + `dialogue-launch-mode.ts`(+test) + §2.1 全部 A/B/C/D 项 + chat-live 机 + docs 引用；absence 断言（§2.1.E 扩展 + git grep 零引用）；`git diff --check` | E1 + E2 | 一次性破坏性 commit，production 树中 `dialogue-web-main` 零引用、零 alias/fallback（handoff :340–345, :384） |

顺序不可交换：E3 之前必须存在不依赖 entry 的 final gate（handoff :330–332）。

### D2 — 三 profile 归宿（§2.2 结论冻结）

- **management** → E1 迁入 composition-owned 管理变体；不得删除（P9 产品面）。
- **reference** → E1 迁入 composition-owned Chat-only 变体（Chat Core 产品表面）；不得删为 preview。
- **reference-game** → 已迁入（3238f44）；entry 副本随 E3 删除。
- profile identity（`gamebuddy.chat-core.reference-pipeline` / `gamebuddy.tavern-management.chat-list-title`）、releaseTier、browser contract 均不变；只有启动/组装位置从 entry 移入 composition。

### D3 — composition-owned owner 变体（E1 设计点）

- `desktop-host-composition.ts:88–175` 目前**无条件**构造 Stardew coordinator（:116–122 `PRODUCT_INTEGRATION_CATALOG.getProvider("stardew")`）。E1 必须让 composition 组装按 surface/profile 选择：Chat-only / Tavern-management 表面**不得**构造 Stardew coordinator/guardian/folder-picker；composed-reference-game 保持现状（或等价隔离）。
- `DesktopHostAssemblyInput`（:74–77）扩展 surface/profile 选择或新增等价 owner 输入（owner 层决策，E1 冻结草案）；`desktop-host-entry` 仍是唯一 production 产品入口，不新增 entry。
- 变体复用既有 API 层模块：`reference-pipeline-dialogue-web.ts`、`tavern-management-dialogue-web.ts`、`tavern/reference-pipeline-static-shell-composition.ts`、`tavern/tavern-management-static-shell-composition.ts`、`tavern/static-artifact/index.ts`（它们同时是 production-artifact verificationRoots，verificationRoots 不删）。
- 禁止：第二 store、第二 authority、bootstrap/native 事实进通用 wire、`ProductInputProducer`、raw 凭据/路径/pipe/token/PID/Job 跨边界（AGENTS.md；MEMORY #2254/#2283）。

### D4 — chat-live 一次性 artifact 机整体退役（E3）

`build-chat-live-artifact.mjs` / `start-chat-live-artifact.mjs` / `chat-live-artifact-support.mjs` / `tsconfig.chat-live.json` / `tools/chat-live-artifact-{support,launcher}.test.mjs` / `GAMEBUDDY_CHAT_LIVE_ARTIFACT` env 分支（src 3 处 + reclaimer :121）全部删除；`D:\GameBuddy-chat-live-tmp` 届时无源可编。**不保留 fallback 别名**（handoff :340）。narrative gate 只保留 production artifact（或 E2 冻结的 composition bootstrap）路径。

### D5 — 门重定向纪律（E2）

- 最终门：fresh GameBuddy-owned root、player-visible production routes、no fixture/operator Tavern state、no mocked route/hidden setup API、允许 write-only player setup contract 的 ephemeral real-provider credential（design/40 :207, :1150）。
- 不依赖 `TavernLiveFixtureProvisioner`（prepare-tavern-live-fixture.mjs 仅 Chat-Core 中间门可用，design/40 :171）。
- 报告纪律沿用：create-only、content-free、opaque IDs、category counts（MEMORY #1011）；不保留 prompt/credential/raw response。

### D6 — absence 断言纪律（E3）

- production 树（排除 `.git`、node_modules、生成物目录）`git grep -l "dialogue-web-main"` 必须为空（handoff :384 "zero production references"）；`host/`、`tools/`、根 `package.json` 内 entry 名 zero。
- 既有 forbidden-ingress 测试（§2.1.E）保持；`production-artifact.test.mjs` / `test-artifact-protocol.test.mjs` / `build-test-artifact-locked.mjs` 补 entry absence 断言。
- `check-host-production-import-boundary` 与 `check:host-module-graph` 在 entry 移除后必须通过，且其 DEFAULT_ROOTS/roots 无 entry。
- 生成物（`dist/`、`.dist-backup-*`、`artifacts/`）中遗留 entry 名属重建产物，不作为验收阻碍，但 publication 重建后 inventory 不得再含 `dialogue-web-main.js`。

### D7 — stop rules（实现者）

1. **R1（E2 决策 lock）**：final gate 的 spawn 协议若需要第二个产品 entry/CLI/daemon、alias、fallback、guardian-less 轻量 Chat entry 或任何绕过 composition bootstrap 的新入口 ⇒ stop，上报 owner 决策，不得自行发明。
2. connection/provider/model 未挂载导致 final gate 无法 covering 完整 P9 journey 时，E2 只能把 scope 限为已挂载能力并在卡片登记外延（G3），不得用 mock/hidden setup API 凑门。
3. 以 fixture/operator-created Tavern state 补 gate 前置 ⇒ stop（design/40 :1150）。
4. 需要第二 durable authority、返回 legacy 兼容/fallback/read-repair、或把 raw 凭据/路径/PID/token 放进 wire/durable 记录 ⇒ stop。
5. Chat/Game 表面独立性被破坏（一方 owning/pausing/closing 另一方）⇒ stop（MEMORY #968/#1022）。
6. 主 checkout WIP（§2.4）被整体 reset/clean/stash/覆盖以"让 lane 变绿" ⇒ 违反纪律（MEMORY #2535），stop。
7. 删除动作触及 Lane C 冻结 browser contract 或 Lane D coordinator/composition 拓扑的未批准部分 ⇒ stop，按 handoff :338–341 的 forbidden-overlap 上报。
8. 纪律红线：绝不按名称 kill node；本卡阶段不运行任何 live gate / provider call / Stardew launch。

### D8 — validation budget（incident → owner → boundary；不新增 proof/attestation 层）

| 保留项 | 防止的事故 | owner | boundary | failure 含义 |
|---|---|---|---|---|
| entry absence 断言（git grep + artifact/tsconfig/scripts/knip/roots 清单） | 删除后复活/别名回归 | E3 | production 树 | 零引用；出现即 fail |
| composition 单一 entry + 无第二 bootstrap | 第二产品入口/并行 owner | E1/D | composition 组装 | 构建/mismount 拒绝 |
| surface/profile 选择与 Stardew coordinator 隔离 | Chat-only/管理表面被 Stardew 依赖污染 | E1 | composition 输入 | 构造失败或误连 game 即 fail-closed |
| gate 报告 create-only/content-free/opaque（MEMORY #1011） | 凭据/prompt/provider 原始输出外泄 | E2 | 门报告 | 内容 guard 拒绝→blocked |
| final gate 无 fixture/operator state | 假 fresh-root 声明 | E2 | 门断言 | fixture 探测/隐藏 setup 即 blocked |
| verificationRoots 不随 entry 删除 | 误删 E1 仍旧消费的 API/static-shell 层 | E3 | artifact 清单 | 缺 verificationRoot ⇒ artifact blocked |
| module-graph/import-boundary 在 entry 移除后通过 | 死引用/悬空 root | E3 | CI | failed |

**不新增**：hash/signature/attestation/lease/fresh-root proof 层（design/90 :27 简化 authority；MEMORY #734 单一语义 SQLite authority 不重建）。gate 的 nonce/marker 仅按既有 gate 合约保留，不扩散为新产品门。

## 4. Boundary 摘要

### User-visible result

Chat 与 Tavern-management 仍是可独立启动/关闭/恢复的通用的产品表面，且全部由一个 composition（Desktop composition owner）托管：Chat-only（reference）、Tavern 管理（management）、Chat+Game（composed-reference-game）三变体并存，profile 语义与 browser 不变。`dialogue-web-main` 在 production 源码/配置/脚本/artifact/module-graph/live gates 中零引用、零 alias/fallback；测试与 CI 断言其 absence。fresh-root production Chat/Tavern final gate 不依赖 fixture 或 operator setup，可在全新 GameBuddy-owned root 上经 player-visible routes 走通已挂载的 Chat/Tavern journey 并输出 create-only content-free 报告。

### In scope

- §2.1 A–E 全清单的替代/删除/断言（E1/E2/E3 各 slice 的 owned paths，§6）；
- composition-owned owner 三变体（chat-only / management / composed-reference-game）与 surface/profile 选择（D3）；
- fresh-root final gate 的 spawn 协议冻结（G1/G7）、chat-live 分支移除、browser journey 覆盖已挂载能力、Memory live 覆盖落户（G2/G4）；
- absence 断言与文档（README/charter）同步。

### Non-goals（明确不做）

- **不实现** P9 未挂载能力（connection/model 配置、New Companion/Chat、chat create/open/switch/archive、import/export、retention）——这些是 design/28/40 的产品工作，仅在 E2 的 journey scope 边界登记（G3）；
- 不写任何 production 源码（本卡只读 + 文档冻结）；
- 不改 Mod/native、不建第二 store、不新增第二 entry/CLI/daemon、不做 legacy 兼容/fallback/迁移；
- 不重写 Chat/Tavern runtime 内部（handoff :327）；
- 不保留 `dialogue-web-main` 任何别名/隐藏入口；
- 不做 Chat/Game 表面互相接管或 endgame 语义变更（MEMORY #2678）。

## 5. Acceptance（Given/When/Then）

- [ ] **A1 E1 迁移**：Given Lane D composition 已闭合，when E1 变体落地，then 在单一 Desktop composition owner 内，Chat-only/management/composed-reference-game 三表面都能经同一共享语义 authority 启动/关闭，互不 owning/pausing/closing；Chat-only/management 变体不构造 Stardew coordinator；browser contract、profile identity、verificationRoots 不变。
- [ ] **A2 无第二 entry**：Given E1 变体设计，then production artifact entryRoots 不新增任何 Chat/Tavern entry；`desktop-host-entry` 仍是唯一产品入口；module-graph 无新 root（D3/D7-R1）。
- [ ] **A3 E2 门无 fixture**：Given 全新 fresh GameBuddy-owned root 与 production 产物，when final gate 运行（已挂载 profile scope），then 全程无 fixture provisioner、无 operator-created Tavern state、无 mock route/hidden setup API；playwright/spec 对 shipped artifact 无 `page.route()`；报告 create-only/content-free（MEMORY #1011 纪律），`state=passed` 仅当真实 provider turn 与 durable 状态读回一致。
- [ ] **A4 management/Memory live 落户**：Given E2，then management profile 的 Memory read/mutate 与 World Info bind 有 fresh-root live 覆盖；`run-player-managed-memory-http-live` 的旧覆盖被显式替代而非静默丢失（G4）。
- [ ] **A5 E3 破坏性删除**：Given E1+E2 green，when 删除 commit 落地，then `git grep -l dialogue-web-main`（排除 .git/node_modules/生成物）为空；`tsconfig*.json`/`knip.json`/`package.json`/`production-artifact.config.json`/import-boundary roots/depcruise roots 中 entry 零出现；`production-artifact.test.mjs`/`test-artifact-protocol.test.mjs`/`build-test-artifact-locked.mjs` absence 断言通过；chat-live 机文件全部删除（D4）。
- [ ] **A6 artifact/publication**：Given E3，then fresh-root production artifact build/publication 成功，`dialogue-web-main.js` 不在 emitted roots 与 inventory 中，verificationRoots 全部保留；release-windows/ci 的 `check:host-module-graph`、`check:host-production-import-boundary`、`check:knip` 通过。
- [ ] **A7 既有门回归**：Given E2/E3，then `tools/run-tavern-narrative-gate*.mjs`（或 E2 冻结的新 spike）与 `run-tavern-release-live-gate.mjs` 在 composition 产物上按新协议运行，启动失败词表与测试更新；无 live Stardew action。
- [ ] **A8 WIP 保护**：Given §2.4 WIP，then E1/E2/E3 commit 只含本 lane scoped hunks；WIP 未被 reset/clean/stash/覆盖；pre-existing WIP 与 lane absence 断言相容。
- [ ] **A9 scoped diff 检查**：Given E3 commit，then `git diff --check -- <owned paths>` 干净；只 stage 本 lane owned paths（handoff :387–391）。

## 6. Owned paths 草案

| slice | 路径 | 变更范围（实现期，不在本卡执行） |
|---|---|---|
| E1 | `host/src/composition/desktop-host-composition.ts`、`host/src/composition/desktop-presentation-admission-owner.ts` 及对应 `*.test.ts` / fixture-workers | composition-owned 三变体（chat-only / management / composed-reference-game）+ surface/profile 选择；Chat-only/management 不构造 Stardew coordinator；mismount guard 与 drain 顺序照既有模式（desktop-presentation-admission-owner :56–109） |
| E2 | `tools/run-tavern-narrative-gate.mjs`(+test)、`tools/run-tavern-release-live-gate.mjs`(+test)、新增 final-gate 工具/报告 schema（按 G1/G7 冻结）、`dialogue-web` 若需要 API client 适配（仅已挂载能力） | spawn 协议冻结与重定向；chat-live 分支删除；management/Memory live 覆盖；browser journey（no mock）；失败词表更新 |
| E3 | §2.1 A/B/C/D 全部文件 + `host/src/dialogue-launch-mode.ts`(+test) + `host/README.md` + `tools/dialogue-live-run-charter.md` + `windows-stale-lock-reclaimer/index.ts:121` env 分支 | 删除 entry 与全部 production caller、chat-live 机、docs；absence 断言；publication 重建走本 commit 内 owning config（handoff :326–327） |
| 测试 | `host/scripts/production-artifact.test.mjs`、`test-artifact-protocol.test.mjs`、`build-test-artifact-locked`、`tools/check-host-production-import-boundary.test.mjs`、§2.1.E 既有 absence 测试 | entry absence 断言更新/扩展；不触碰无关 Chat/Tavern runtime 测试 |

**不动**：`host/src/game-browser-contract/`、`host/src/composed-reference-game-browser.ts`（Lane C 冻结）；action runtime；Mod/native；`dialogue-web/` browser 源码本体（除 E2 scope 内已挂载能力适配）。

## 7. 与设计 authority 的衔接点

- **design/40（retired as execution authority，:3）**：gate 语义以 design/90 为现行执行 authority（:185 同样给 40/78/87/88 退役说明），但 **P9 管理必须完成与 fresh-root production UI final gate 要求被 MEMORY #1142 明确采纳**（40 §4.2 :191–207、P9 :1057–1101、P10 :1143–1155 作为目标定义引用，不作 blocking proof authority；design/90 :27 取消 bespoke proof 门作为产品 authority）。
- **design/90（现行）**：:58 明示 "`host/src/dialogue-web-main.ts` composes the mounted reference Chat and management profiles"——即删除必须伴随 composition 迁移，否则产品表面丢失；:69/:113 反映 management Memory 现状（read-only → CRUD 在 Task 2 落地）；:19/:21/§278 反映 fresh install/provider/Companion/Chat journey 需求。
- **design/28**：P9 target rows（connection/model、Character、Persona/scenario/greeting、World Info、Chat lifecycle、Memory、preferences）是 E2 journey scope 与 G3 外延的对照表。
- **design/104**：§278–294 fresh-root verifier journeys 是 final gate 的产物端参照（launcher-owned root、真实安装代、redacted 失败类别）。
- **handoff-action-nav.md**：Lane E 定义（:309–349）是本卡 origin；其中 `run-player-managed-memory-http-live.mjs` 项（:325）经审计**已过时**（主干 7464749 删除），以 §2.2/G4 为准。
- **MEMORY**：#968/#1022（Chat/Game 独立表面）、#734（fresh semantic SQLite 单一 authority，无 legacy/fallback）、#1142（P9 完整性与 fresh-root UI final gate）、#1011（真实 gate 输出脱敏纪律）、#2254/#2283（guardian/root layout 纪律）、#2535（WIP 保护）、#2678（普通 close 不终止 host/game world）。

## 8. 验证预算与命令（实现期参考，本卡不执行）

- 本卡阶段：只读审计 + 文档；无源码改动、无 live 运行。
- E1：`pnpm --filter @gamebuddy/companion-host typecheck`（tsconfig.production/test 全绿）、composition-focused `node --test --test-concurrency=1`、`pnpm check:host-module-graph`、`pnpm check:host-production-import-boundary`。
- E2：final gate 单测 + controlled fresh-root run（真实 provider 仅在受控门内；无 Stardew/SMAPI 启动；报告 content-free）。
- E3：fresh-root production artifact build/publication（`pnpm --filter @gamebuddy/companion-host build` / `build:release` 路径）、emitted/inventory absence 断言、`git grep -l dialogue-web-main` 空、scoped `git diff --check`、`pnpm check:knip`。
- 每个 slice 完成后：fresh review + diff inspect（沿用 105 :193 纪律；handoff :386–391）。

## 9. 状态声明

本卡是文档层边界冻结（主 checkout 只读前置审计）：未修改任何 source/native/live fixture/test，未提交任何改动（主仓库与 `design/` docs 仓库均无本卡产生的 staged/unstaged 变化，除本文件本身在 docs 仓库为 untracked 新增）。Lane E 实现按 E1 → E2 → E3 顺序，以本卡 D1–D8 为权威草案；实现中若发现与现存货架（如 composition 变体与 Stardew coordinator 的装配耦合、gate spawn 新协议、G3 外延）冲突，按 D7 stop rules 上报，不静默改语义。`run-player-managed-memory-http-live.mjs` 已在主干删除（7464749），handoff :325 条目以本卡 G4 为准，不复活该文件。