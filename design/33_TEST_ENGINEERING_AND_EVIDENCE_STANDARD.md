# 33 测试工程、证据与测试组合标准

> **状态：** GameBuddy-owned automated testing 的跨 workspace 工程标准。它补充而不取代 [`09_BDD_VALIDATION_PLAN.md`](09_BDD_VALIDATION_PLAN.md) 的产品/真实运行门、[`27_TAVERN_TEST_ENGINEERING_STANDARD.md`](27_TAVERN_TEST_ENGINEERING_STANDARD.md) 的 Tavern 专项规则，以及 [`35_REALTIME_COMPANION_COORDINATION_IMPLEMENTATION_PLAN.md`](35_REALTIME_COMPANION_COORDINATION_IMPLEMENTATION_PLAN.md) 第 17 节的候选工程执行顺序。旧 release-baseline 仅保留于 [`legacy/31_RELEASE_BASELINE_SECURITY_SUPPLY_CHAIN_IMPLEMENTATION_PLAN.md`](legacy/31_RELEASE_BASELINE_SECURITY_SUPPLY_CHAIN_IMPLEMENTATION_PLAN.md)，不再拥有现行任务。
>
> **适用范围：** `host/`、`voice-gateway/`、`dialogue-web/`、`integrations/stardew/` 和项目自有 `tools/`。不将 vendored、反编译、研究材料、build output 或用户数据纳入默认质量门。

## 1. 决策

本项目按**风险、证据强度和可删除性**管理测试，不按测试文件数、断言数、覆盖率或 AI 生成代码量考核。

每个测试必须回答：它保护什么明确失败模式？它消费什么输入并观察什么外部可见行为？删除它后会重新暴露什么风险？若不能回答，应删除、合并或降级为开发辅助，而不是加入 CI。

当前审查的结论不是“测试绝对太多”或“测试绝对太少”，而是：

- 静态 Stardew source/audit 与 native-smoke wrapper 的数量已经很高，存在重复 transport、timeout、receipt-polling 和 source-token 自证风险；Host typecheck/build:test/production build 当前通过，但这只属于 active-tree evidence。
- 发布关键的真实硬件/provider/target-user、clean-room input closure、完整依赖/SBOM、真实 Mod/live evidence 仍然不足；Socket peer reset、普通 symlink/junction containment、WindowsPttCapture starting-window registration、cleanup retry/backoff/redacted structured failure、capture coordinator native-cancel fence 和 delayed-start/native-settle 已有 deterministic regression，Host voice focused **27 / 27**、Voice Gateway **48 / 48** 个测试通过，但这些都不能升格为 release closure；同权限 hostile path-based TOCTOU 是明确记录的 P3 defense-in-depth residual risk，不纳入首发 release blocker。本轮 snapshot/dependency/SBOM 工具仅有 `pnpm test:ci-snapshot` **20 / 20**、`pnpm test:dependency-risk` **13 / 13** 与 SBOM verify 的 active-tree evidence，8-entry snapshot-tooling allowlist 外仍有 **525** 个 unclassified candidates。
- CI manifest runner 现已消费 `.ci/test-portfolio-manifest.v1.json`，按 changed path/event 执行 selected entries，具备 recursive initial-push selection，并以 `taskkill`/process-group cleanup 回收其拥有的进程；这改善了 suite 选择与资源回收，但不等于所有 suite 均已成为 release evidence，静态/diagnostic entries 仍保持各自证据等级；
- static、fixture、process 和 target-live 证据必须不可混投影；本轮 Host voice focused **27 / 27**、Voice Gateway typecheck/build/test **48 / 48** 均通过，但这只是 deterministic active-tree evidence。真实 hardware/provider/target-user evidence、当前 2 项 `proposed_acceptance` high runtime advisory 与未解决的 review issues 仍须保持 blocked；同权限 hostile path-based TOCTOU 只按 P3 residual risk 记录。本标准不改变当前 **Release No-Go**。

## 2. 证据层级与禁止替代

证据由低到高排列：

```text
syntax / formatting / static structural canary
< deterministic unit, contract, race, security regression
< process-level black-box test
< isolated browser regression
< no-commit clean-room snapshot CI
< committed-tree clean-clone CI
< target-version build, hardware, real provider and live-game evidence
```

低层通过只证明其声明层级。特别是：

- source token、AST 或 source audit 只能证明被声明的源码结构或输入审计，不能证明 runtime 行为、receipt、postcondition 或 live closure；
- fixture 不得被标为真实 Host、真实 Mod、真实麦克风/扬声器、真实 provider 或真实游戏证据；
- 一次 smoke 通过不覆盖同类 action 的所有 policy、replay、cancel、save/reload 或 topology 组合；
- 重试后通过的 browser test 只可报告 `flaky`，不得被总计为首次通过的 release evidence；release profile 必须另有无 retry 的连续 smoke；
- 真正 committed-tree clean clone、target-version build 与 live evidence 在未实际运行时必须为 `blocked`，不因 active-tree、snapshot 或 deterministic fixture green 而提升。

每份结构化证据至少携带：`evidenceKind`、producer/version、source or artifact identity、topology、执行环境、输入 fixture identity、terminal outcome 和 redacted diagnostics reference。静态、fixture、process、target-live 的 schema 或 `evidenceKind` 必须不同。

## 3. 风险到首要测试层的映射

每个风险有一个**首要**测试层；高层只测试与其他边界组合的结果，不能机械复制下层断言。

| 风险类别 | 首要层 | 典型证据 | 不可替代的高层门 |
|---|---|---|---|
| parser、schema、pure policy、bounds、receipt correlation | unit/contract | 正反输入与精确 fail-closed reason | 有真实外部边界时的 process test |
| cancel/replay/timeout/并发顺序 | deterministic barrier/permutation test | controlled promise/barrier、mock timer、事件顺序 | Windows/真实设备生命周期时的硬件 smoke |
| child process、socket、port、lock、artifact root | process black-box | unique temp root/port、exit/error/close、PID-tree teardown | 安装后的 target environment run |
| junction/symlink/reparse、TOCTOU、文件残留 | security regression | outside sentinel、lstat/realpath、替换 barrier | Windows-specific junction/reparse test |
| DOM、focus、locale、viewport、request causality | Playwright browser regression | deterministic route fixture、web-first assertion、trace | Tavern final live gate |
| Source/content version accounting | static audit/canary | attested input identity、typed parser output | typed bridge contract + target-version native run |
| Game action result | native runner | authoritative receipt + action-specific fresh postcondition | declared topology 的 target-version live closure |
| dependency/SBOM | lock coverage + semantic fixture | lock/artifact/BOM identity、scanner disposition；当前 `security/dependency-advisories.json` bound snapshot 为 2 项 high runtime advisory，全部 `proposed_acceptance` 且仍 blocking | dependency-family compatibility and live gates |

## 4. Test portfolio manifest 与 CI 选择

测试发现必须显式、可审计，不能由散落的 `package.json` scripts、glob、临时 shell 命令或“仓库里有一个 `.test` 文件”隐式决定。

建立 repository-owned `test-portfolio` manifest；每个 suite 记录至少：

```json
{
  "id": "voice.socket-error-containment",
  "owner": "voice-gateway",
  "riskIds": ["VG-RT-001"],
  "evidenceKind": "process_regression_v1",
  "command": "...",
  "triggerPaths": ["voice-gateway/src/server.ts"],
  "timeoutMs": 60000,
  "retryPolicy": "none",
  "requiredOn": ["pull_request", "release_candidate"],
  "requires": ["windows"],
  "liveGate": false
}
```

规则：

1. 同一风险的重复 tests 必须声明 primary/secondary 角色；没有独立组合风险时保留一个并删除或合并其余重复项。
2. 一个测试只能因明确 `riskId`、缺陷回归或上层组合边界进入 required suite；“提高覆盖率”“AI 新写了一份 wrapper”“担心以后有用”不是理由。
3. static audit/derivation tools 记录在 manifest，但不得与 runtime test 同一 success bucket；未接入 CI 的工具必须标记 `manual_diagnostic`，不能从统计中推断质量覆盖。
4. 每个发布风险必须有 manifest entry 或机器可读 `blocked`/`not_applicable` 说明；未分类新 action、runner、generated root 或 dependency family必须 fail closed。
5. 当 wrapper 共享 connection、deadline、receipt correlation、terminal classification 或 freshness logic 时，这些语义只能有一个版本化 harness owner；runner 只保留 action/topology/target/postcondition。
6. Stardew root commands必须由versioned verification portfolio归类为leaf/aggregate、owner、riskId与`evidenceKind`；新script未分类时fail closed。static aggregate只消费static/deterministic entries，live/manual/blocked项不进入pass denominator；aggregate必须保留每个leaf的command、exit code、duration、artifact/input identity与blocked reason，不能用一个绿色总exit code抹去细目。
7. 同一产品场景的deterministic fixture、production admission preflight与actual target-live runner必须使用不同入口、schema discriminator与artifact root。Preflight只证明non-mutating readiness；它不能以“real scenario run”命名或生成live verdict。Actual live无法连接正式artifact/bridge/target时返回machine-readable `blocked`，不得调用fixture/preflight后升格。Companion-live的具体owner和cutover见`design/35` P6/P7与`design/39` P7/P9。

## 5. 编写规则

### 5.1 Determinism、隔离与资源所有权

- 测试必须使用唯一 temporary root、端口、pipe/session/lock name，且不读写真实 GameBuddy、Pi、用户 profile、credential、系统 Stardew save 或 provider 数据。
- 禁止 arbitrary `sleep`。使用 controlled deferred、barrier、mock timer 或协议/文件/route completion 信号。
- 每个会启动 child、PowerShell、server、browser 或 helper 的 suite 必须有 repository-owned total deadline 和 parent-owned teardown；`exit`、`error`、stdio close 与 cleanup 都要被 await。超时必须输出 redacted active child/handle diagnostics，并杀死精确拥有的 process tree。
- 测试能并行才并行；拥有共有 build root、device、port 或 durable store 的 suite 必须显式序列化并证明 lock/release 语义。
- `node:test` 的默认无界超时不是项目 deadline。每个 Node suite 由 portfolio/supervisor 给出 bounded total timeout；不得依赖外部 agent timeout 回收孤儿。当前 `host/scripts/test-supervisor.mjs` 已提供 bounded child/process-tree cleanup targeted contract；artifact lock/supervisor/repair protocol focused suite **20 / 20** 通过，但不能据此声称所有 suite 已迁移或 release eligibility 已满足。`host/.test-artifact.lock` 的 owner record 必须严格校验；malformed legacy/zero-byte lock 由普通 acquisition 保留并 fail closed，只有显式 operator quarantine/repair 后才能继续。

### 5.2 行为边界与 mutation

- 每个已修复 P0/P1 defect 先有最窄的 red regression，再修改生产实现；测试应失败于旧缺陷，而不是只断言新源码中包含某个 token。
- source/AST canary 必须配套 typed/behavioral consumer 或明确标为 `static_canary`；优先 mutation fixture 验证 checker 会拒绝缺字段、重复 ID、非法 topology、错误 artifact identity、错误 schema 和失效 path。
- mutation testing适用于小而高风险的 pure policy、parser、authorization、receipt/evidence validator、path containment 与 lifecycle reducer。以存活 mutant 发现具体缺口，不设脱离风险的全仓百分比 KPI；不可达或等价 mutant 必须有审查记录。
- mocks/fakes 只能模拟 project-owned boundary，且在接口/字段/版本 drift 时 fail closed；禁止 mock 掉本测试要证明的 authorization、receipt、file security 或 child lifecycle。

### 5.3 Browser 与诊断

Tavern 继续遵守 `27`。此外：

- CI retry 是诊断工具；必须输出 `passed`、`flaky`、`failed` 分类，并在 release profile 使用 `--fail-on-flaky-tests` 或等价 fail-closed policy；
- `trace: on-first-retry` 可保留，但 trace/report/screenshot/log 可能含内容或凭据，必须保存到可信、受访问控制的 artifact store，并遵守最小 retention；
- 固定端口和 `reuseExistingServer` 只允许本地开发便利；CI 使用 owned unique server/process，或证明不存在残留 server 复用。

### 5.4 生成物、依赖与真实环境

- runner 在 import executable output 前必须验证 artifact manifest；未声明的 `dist`、`dist-test`、`.memory-live-check` 或其他 generated root 都是失败，不是可选 fallback。
- 真实当前结果必须引用命令及 exit code：2026-08-12 `pnpm quality:check` 失败（**73** 个 formatter diagnostics），而 text hygiene 通过；Host typecheck/build:test/production build、Host voice focused **27 / 27**、`pnpm --filter @gamebuddy/voice-gateway` typecheck/build/test **48 / 48** 当前通过；不得将该 deterministic active-tree evidence 升格为真实 Windows/provider/target-user/live evidence。真实 hardware/provider/target-user evidence、snapshot input closure 和 review issues 仍未闭合；同权限 hostile path-based TOCTOU 是 P3 residual risk，且不得被误报为 hostile-race-safe。
- 生成器必须在同一 frozen input 下可重放；在 snapshot index 冻结后产生源码/库存 drift 必须失败。
- security scanner、SAST 和 coverage 是线索，不是安全证明。当前 `security/dependency-advisories.json` 的 HTTPS-registry `pnpm audit --prod` bound snapshot 记录 2 项 high runtime advisory，均为 `proposed_acceptance` 且无外部批准，因此 acceptance 仍 blocking。每个 high/moderate advisory、path hardening 或 authorization finding 仍需人工可达性/语义审查与对应行为回归。
- target-version game、Windows audio hardware、real provider 与多人 topology 只由专用 versioned runbook 执行；不得以 fake assembly、raw UI/input injection、录像或人工口头确认替代。

## 6. 防止过度测试与测试债

以下是拒绝或删除/合并测试的条件：

- 只重复更低层已覆盖的同一断言，且没有新的边界组合；
- 只验证 implementation private method、文件文本、框架默认行为或测试自身 helper；
- 没有可描述的 failure mode，仅为增加数量/coverage；
- 依赖共享状态、顺序、固定延迟、真实个人数据或未声明生成物；
- 相同 smoke wrapper 仅复制公共 transport/polling/timeouts，而没有 action-specific native target/postcondition；
- 静态 source audit 被用作 Game Action 完成、真实 live 或安全关闭的唯一证据。

删除测试前必须确认：其 Risk ID 仍由另一个 primary test 覆盖，或对应产品/发布 scope 已显式移除。对同一来源审计家族，优先保留少量能证明 parser、input-accounting、negative mutation 与一个真实 consumer 的代表性测试，并将其余重复路径移到手动 diagnostic/派生资料，而不是无限扩大 CI。

## 7. 当前强制整改映射

| 当前缺口 | 必需 tests / 门 | 不可声称关闭的条件 |
|---|---|---|
| Voice socket error | peer RST/write error 后 Gateway 存活且第二 client 可认证 | 仅 malformed peer test 通过 |
| PTT start/cancel | startup barrier 的所有关键 interleaving；cancel linearizes，迟到 start 不可 accepted；当前 Host voice focused 27 / 27 与 Voice Gateway 48 / 48 个 tests 已覆盖 starting-window 与 native-cancel fence，但真实硬件/provider/target-user interleavings 仍缺失 | 仅 normal start/stop/cancel 或只看 Gateway coordinator
| PCM cleanup | native completion settle、cleanup retry/backoff、目录最终 absence、redacted structured failure diagnostic | 吞掉 `rm` 错误 |
| Tavern path | symlink/junction/reparse、parent replacement、outside sentinel、path-lock-before-mkdir；P3 path-based TOCTOU residual-risk review | 单纯 lexical `resolve`，或把 pathname preflight 当 hostile-race proof |
| Test process tree | total deadline、child error/close、timeout cleanup、unique root/port | 外部 runner 超时或用例打印后卡住 |
| CI input closure | required-input allowlist、unclassified rejection、repeatable materialize、snapshot-index no drift；当前 `pnpm test:ci-snapshot` **20 / 20** 通过，但 8-entry snapshot-tooling allowlist 外仍有 **525** 个 unclassified candidates；transactional finalization 明确为 Windows-only，非 Windows 以 `ci_snapshot_transactional_output_unsupported_platform` fail closed | active-tree green 或 focused tools green
| Stardew descriptor / static audit | AST registry coverage、typed runner contract、negative evidence mutation | hard-coded count 或 terminal token |
| Native smoke fleet | shared harness contract、per-action postcondition、manifest artifact identity | 复制 runner 通过 |
| Browser reliability | request-completion causality、first-attempt pass、flaky classification、trusted diagnostics | retry 后绿 |
| Supply chain | pnpm/Bun/NuGet lock coverage、BOM semantic fixtures、advisory disposition | SBOM schema 或单一 npm license list |
| `.NET` solution/test discovery | solution project inventory、TFM compatibility、ProjectReference source ownership、actual `dotnet test`或显式contract-test entry canary | 只运行`dotnet build`、手工`Compile Link`或仓库中存在一个Tests project |
| Stardew command portfolio | versioned leaf/aggregate manifest、unclassified-script rejection、per-leaf verdict、live exclusion canary | 99个script数量、手写长chain或单一aggregate green |

## 8. 审查与度量

每次测试相关变更的审查记录至少写入：新增/删除 suite、Risk ID、primary layer、evidence kind、input/artifact identity、timeout/retry、parallel/resource policy、fixture privacy、CI/release selection和未覆盖的真实环境门。

允许追踪的健康指标包括：

- 已分类 tests 与 CI-required/manual-diagnostic 的数量；
- risk-to-primary-test 覆盖率，而非裸 test count；
- flaky first-attempt failures；
- timeout、orphan-child、undeclared generated-root 和 snapshot-drift 次数；
- 关键 mutation survivor 的清单和处置；
- static/fixture/process/live evidence 的比例与未完成 live gate。

禁止将行覆盖率、测试总数、AI 生成的 wrapper 数、snapshot 数量或重试后通过率单独作为 release KPI。

## 9. 外部依据

- Node.js Test Runner（mock timers、test runner behavior）：<https://nodejs.org/api/test.html>
- Playwright retries / flaky 分类：<https://playwright.dev/docs/test-retries>
- Playwright CI、trace 与 artifact secrecy：<https://playwright.dev/docs/ci-intro>
- Playwright Trace Viewer：<https://playwright.dev/docs/trace-viewer>
- Stryker mutation testing（surviving mutant 表示测试可能未覆盖该变化）：<https://stryker-mutator.io/docs>
- OWASP Software Supply Chain Security Cheat Sheet（自动化扫描的价值及 false-positive/false-negative 边界）：<https://cheatsheetseries.owasp.org/cheatsheets/Software_Supply_Chain_Security_Cheat_Sheet.html>
- 项目专项规则：[`27_TAVERN_TEST_ENGINEERING_STANDARD.md`](27_TAVERN_TEST_ENGINEERING_STANDARD.md)、[`09_BDD_VALIDATION_PLAN.md`](09_BDD_VALIDATION_PLAN.md)、[`34_REALTIME_COMPANION_COORDINATION_AND_LIVE_RUN_DESIGN.md`](34_REALTIME_COMPANION_COORDINATION_AND_LIVE_RUN_DESIGN.md) 第 12 节和 [`35_REALTIME_COMPANION_COORDINATION_IMPLEMENTATION_PLAN.md`](35_REALTIME_COMPANION_COORDINATION_IMPLEMENTATION_PLAN.md) 第 17 节。
