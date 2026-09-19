# 27 Tavern 测试工程标准

> **状态：** Tavern UI、Host contract、BDD 与发布 live gate 的工程测试基线。本文以风险与证据边界组织测试；它不取代 [`09_BDD_VALIDATION_PLAN.md`](09_BDD_VALIDATION_PLAN.md) 的跨产品 Given/When/Then，也不放宽 [`24_TAVERN_COMPATIBILITY_IMPLEMENTATION_PLAN.md`](24_TAVERN_COMPATIBILITY_IMPLEMENTATION_PLAN.md) 的 release predicate。跨 workspace 的 test portfolio、evidence-kind、process cleanup 与 flaky governance 由 [`33_TEST_ENGINEERING_AND_EVIDENCE_STANDARD.md`](33_TEST_ENGINEERING_AND_EVIDENCE_STANDARD.md) 统一拥有。

## 1. 决策

Tavern 的日常前端回归由**可重复、无真人参与的浏览器测试**承担，而不是每次修改后手动操作 loopback UI。真人 `@tavern @live-run` 只在自动前置、contract 与浏览器回归均通过后，作为最终 release-level 端到端证据运行。

本标准采用风险驱动的分层策略，而非按测试数量或测试金字塔比例考核：每一项风险只有一个首要测试层；更高层只证明该风险与其他边界组合后的结果。重复同一断言不会增加发布信心，反而增加维护成本与 flaky surface。

## 2. 测试层与唯一职责

| 层 | 首要负责的失败模式 | Tavern 工程入口 | 不负责什么 |
|---|---|---|---|
| Pure/domain + Host contract | schema、权限、CSRF、持久化、原子 read-back、exact thread、fail-closed | `host/src/**/*.test.ts`，编译后 Node `node:test` | CSS、浏览器布局、pointer/focus 渲染 |
| Browser regression | 真浏览器 DOM/CSS/viewport、语言 chrome、抽屉几何、异步 UI 状态、键盘/focus、真实 EventSource 生命周期 | `dialogue-web/tests/**/*.spec.ts`，Playwright Chromium + controlled HTTP fixtures | Host 真实持久化、provider、Magic Context、真人可用性 |
| Visual regression | 已冻结、稳定且玩家关键的表面发生未预期视觉变化 | 小型 Playwright screenshot matrix | 语义、权限、请求顺序、所有布局问题 |
| BDD | 跨模块且玩家/产品可读的 release-critical example | `design/09_BDD_VALIDATION_PLAN.md`、对应 contract/runner | 把每个 branch 或 CSS declaration 翻译成 Gherkin |
| Final live gate | 真实 build、认证、Host、runtime、provider 与人工参与者的组合闭环 | `tools/tavern-live-run-charter.md`、`run-tavern-release-live-gate.mjs` | 日常 UI 反馈、像素/CSS 回归、自动化替身 |

### 2.1 Frontend stack decision

Tavern 目前没有前端测试 runner。首个增量使用 **`@playwright/test` + Chromium**，直接运行 Vite 应用并用 page routes 提供确定性的 browser fixture。这是当前最低复杂度、又能检查真实 layout/focus/overflow/timing 的选择。

暂不引入 Vitest/RTL、Pact、Cucumber runtime 或多浏览器 snapshot matrix，除非新增的风险无法由现有 Host contract 或 Playwright browser suite 经济地覆盖：

- 当纯 reducer、格式化、locale resolver 等逻辑增加到不适合通过浏览器覆盖时，再引入 Vitest；
- 当独立部署的 consumer/provider 开始独立演进且 wire drift 不能由同仓 Host contract 捕获时，再评估 Pact 或 OpenAPI consumer contract；
- 不为已有 BDD 文档再创建一层 Cucumber wrapper；
- 不因“全浏览器覆盖率”引入 Firefox/WebKit。Chromium 是 CI 的确定性 browser baseline；跨浏览器只在真实兼容性需求出现时增加。

## 3. Risk → primary test mapping

| Risk ID | 风险 | Primary test | 断言边界 |
|---|---|---|---|
| `TW-UI-001` | 英文 locale 出现 Chinese UI chrome / `<html lang>` 不一致 | browser regression | 固定 English preference；只检查 product chrome，不检查用户、角色或 transcript authored text |
| `TW-UI-002` | More drawer 在窄宽或英文长标签下出现非预期横向滚动条/页面横溢 | browser geometry | document 与 drawer shell 不横溢；`.timeline`/`.panel-body` 的纵向滚动是明确允许的 |
| `TW-UI-003` | 375/768/1024/1440 与 English/简体中文 shell 出现横溢或 locale/layout 漂移 | browser viewport matrix | 每个版本化 viewport/locale 下 app shell 与 drawer 均无横溢，`html[lang]` 随 UI locale 改变；不截取动态聊天正文 |
| `TW-UI-004` | 打开其他 chat 时请求延迟导致重复触发、错误的旧/新聊天表象或无反馈 | browser controlled-delay journey | pending action 单次、请求顺序 `open-chat → refresh`、稳定 pending feedback、完成前保留旧会话，完成后原子替换 |
| `TW-UI-005` | drawer 的 Escape/backdrop/focus/restoration/back 行为回归 | browser regression | 仅在实现这些行为后加入；不得先写会失败的“愿景测试” |
| `TW-UI-006` | World Info/import review 将 opaque artifact internals、原字段名或安全 reason 暴露给玩家 | Host projection + browser journey | Host 仅投影 label/selection；UI 仅显示本地化玩家状态，不能显示 ID/hash/revision/provenance/原字段或 parser reason |
| `TW-UI-007` | message pending/failure 会重复发送、丢草稿或伪造玩家消息 | browser controlled-message journey | 单一 pending request，失败不追加 bubble 且保留草稿、可再次发送；Host 仍拥有 idempotency/accepted schema |
| `TW-UI-008` | chat switch 的 open/refresh 失败会伪造 active thread、丢失旧 transcript 或使 retry 不可用 | browser controlled-failure journey | 失败保留旧 transcript 和 drawer，显示可访问的 retry；只在 `open-chat → refresh` 成功后原子切换 |
| `TW-UI-009` | stable UI 表面被意外视觉重排 | reviewed screenshot | 只拍固定 fixture、冻结时间/animation 的少量 state；截图不替代语义断言 |
| `TW-BDD-001` | 玩家可读 release flow 在真实 runtime 中断裂 | 现有 Tavern BDD + final live gate | 仅自动 prerequisites 已通过后运行；结果必须是 pass/fail/blocked/inconclusive，不由 mock browser suite 升格 |

每一个新风险在 PR 中必须先登记到这个表或相关模块的等价表，并说明：**为何现有 primary layer 不能覆盖、为何选择的新层最便宜、何时删除/合并该测试。**

## 4. Browser test engineering rules

1. **Fixture ownership：** browser tests 对 `/bootstrap`、`/refresh`、`/events`、library/chat routes 使用版本化、SFW、无 dialogue/provider/Pi 数据的 route fixture。它们不读取系统 Pi、用户 runtime、真实 provider 或已有聊天。
2. **用户级 locator：** 优先 `getByRole`、可访问名称、`data-testid`（仅没有稳定用户语义时）。禁止 CSS implementation selector、任意 sleep、共享 browser context、测试顺序依赖和 `force` click。
3. **异步：** 使用 Playwright auto-wait/web-first assertions。受控延迟由 deferred route promise 产生，测试必须先断言 pending state，再放行 response；不以毫秒阈值证明“跟手”。
4. **几何：** 用 `scrollWidth/clientWidth`、bounding rect 和 computed overflow 检查 shell。不要错误地要求 `.timeline`、`.panel-body` 或 textarea 没有滚动；它们是有意的滚动容器。
5. **locale：** 语言测试只覆盖 chrome。角色卡、Scenario、Greeting、World Info、聊天正文和导入材料属于 authored content，可能包含另一种语言，绝不能被正则“英文界面不含汉字”误判。
6. **a11y：** 每个交互 journey 同时断言 role/name、可见 focus/keyboard 行为或必要 aria state。axe/screenshot 可在稳定 shell 引入，但不取代人工 keyboard/reduced-motion release review。
7. **visual：** screenshot 仅覆盖 empty chat、open drawer、long content/error 等稳定且高价值状态；固定 Chromium、OS image、字体、timezone、locale、fixture、animations。baseline 更新必须人工审查。动态 streaming、时间、caret 与临时状态要 mask/freeze 或不截图。
8. **diagnostics：** CI 在 first retry 保存 trace；失败输出必须包括 route request log、viewport、locale、截图/trace artifact 的非内容性引用。禁止记录 prompt、对话、provider payload、credential 或 Pi session data。trace/report/log 只能上传至受访问控制的可信 artifact store，并按最小保留规则处理。

## 5. BDD boundary

BDD 是共享产品语言和少量高价值 example，不是“测试写法”。`09` 的 Tavern scenarios 继续拥有：安全导入、Persona/Scenario/Opening、thread resume、message-operation causality、surface isolation 和真实 release live run。

一条 BDD scenario 应映射到：

- 一个或多个命名 contract tests（必要时）；
- 至多一个独立的 browser journey（仅当浏览器交互本身是风险）；
- 仅在 release predicate 要求时映射一个 final live observation。

禁止把 dictionary key parity、DOM class、CSS overflow declaration、每个 HTTP status 或所有负向 schema case重述成 Gherkin。这些分别属于 unit/contract/browser 层。

## 6. CI and release matrix

| Trigger | Required suites | 不运行 |
|---|---|---|
| `dialogue-web/src/**` 或 CSS/i18n 改动 | dialogue-web Playwright browser regression、build/typecheck、受影响 Host contract | 真人 live run、全 screenshot matrix |
| Host Tavern route/schema/persistence 改动 | Host contract tests、browser journeys whose request/state boundary changes | 真人 live run，除非 release candidate |
| release candidate / selected profile、fixture、Magic Context 变更 | prerequisite checker、全部 manifest-selected contracts、browser regression、审查过的 screenshot matrix | 无 |
| release approval | 上述均绿后一次 final `@tavern @live-run` | 任意“手工复测代替自动门” |

CI 必须在 Node/pnpm lockfile、Chromium revision、Windows runner、timezone、locale 和已声明字体环境下运行。browser installation/cache 是 CI 基础设施成本，不得通过改用人工 run 或把 browser test 静音来规避。固定端口及 `reuseExistingServer` 只可作为本地开发便利；CI 必须拥有其 server/process 或使用唯一端口，并在 suite 结束时验证 teardown。retry 结果必须区分 `passed`、`flaky`、`failed`；release selector 运行无 retry 连续 smoke，且对 flaky 使用 `--fail-on-flaky-tests` 或等价 fail-closed policy。

## 7. Anti-over-testing exit criteria

新增测试必须满足至少一项：

- 覆盖此前未被任何 primary layer 捕获的 release/product风险；
- 针对一个已发生、可复现的 defect 建立最窄的防回归；
- 在保留相同或更高信心时，替代多个重复、慢或脆弱的 tests。

拒绝新增测试的情形：

- 只重复下层的同一 assertion；
- 只测试实现细节或框架行为；
- 需要 arbitrary timeout 才能稳定；
- 除了 coverage 数字之外没有失败模式；
- 需要真实 live runtime，但风险本可用 deterministic fixture 在更低层捕获。

每个 test suite 应在代码审查中回答：它保护哪一项 Risk ID？为何不是较低/较高层？fixture 是否最小且 privacy-safe？删除该测试会重新暴露什么具体风险？

## 8. Acceptance

本标准落地后，以下才算完成，而不是仅安装测试依赖：

- `TW-UI-001` 至 `TW-UI-008` 在 CI 的 Chromium browser regression 中可重复运行；
- 当前 release profile 的 `TVL-06` 没有声明 `must` 的 reply operation，因此它在 BDD/live record 中唯一允许的结果是 `not_applicable / operation_not_declared`；不得为提高覆盖率发布 retry、swipe 或 edit 控件。
- root CI 显式执行 dialogue-web browser suite；
- Browser fixture 不依赖真实 Host、Pi、Magic Context、用户数据或 provider；
- 每项 browser assertion 都有对应 Risk ID，且不与 Host contract 重复；
- `09`、`24` 与 Tavern live charter 仍明确将真人 live run 限定为最终 gate；
- test review 记录未覆盖的 `TW-UI-004` 至 `TW-UI-006`，不假装它们已通过。

## 9. Primary references

- Vitest Browser Mode / browser component guidance: <https://vitest.dev/guide/browser/>
- Playwright best practices, isolation, auto-wait and visual comparisons: <https://playwright.dev/docs/best-practices>, <https://playwright.dev/docs/browser-contexts>, <https://playwright.dev/docs/test-snapshots>
- Testing Library guiding principle: <https://testing-library.com/docs/guiding-principles/>
- Cucumber BDD / Gherkin reference: <https://cucumber.io/docs/bdd/>, <https://cucumber.io/docs/gherkin/reference/>
- Project BDD and Tavern release authority: [`09_BDD_VALIDATION_PLAN.md`](09_BDD_VALIDATION_PLAN.md), [`24_TAVERN_COMPATIBILITY_IMPLEMENTATION_PLAN.md`](24_TAVERN_COMPATIBILITY_IMPLEMENTATION_PLAN.md), [`../tools/tavern-live-run-charter.md`](../tools/tavern-live-run-charter.md)
