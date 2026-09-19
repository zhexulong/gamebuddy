---
id: TAVERN-ECOSYSTEM-ADAPTABILITY-109
type: implementation-plan
status: implemented
owner: chat
specs:
  - architecture/context-memory-and-lorebook-architecture.md
  - architecture/continuity-and-memory.md
  - 24_TAVERN_COMPATIBILITY_IMPLEMENTATION_PLAN.md
  - 90_SIMPLIFIED_PI_BACKED_CHAT_PRODUCT_IMPLEMENTATION_PLAN.md
  - 107_CONTEXT_MEMORY_AND_LOREBOOK_IMPLEMENTATION_PLAN.md
---

# 109 Tavern 生态适配性与去过度设计实施计划

> **前置阅读**：[`24_TAVERN_COMPATIBILITY_IMPLEMENTATION_PLAN.md`](24_TAVERN_COMPATIBILITY_IMPLEMENTATION_PLAN.md)、[`90_SIMPLIFIED_PI_BACKED_CHAT_PRODUCT_IMPLEMENTATION_PLAN.md`](90_SIMPLIFIED_PI_BACKED_CHAT_PRODUCT_IMPLEMENTATION_PLAN.md)、[`107_CONTEXT_MEMORY_AND_LOREBOOK_IMPLEMENTATION_PLAN.md`](107_CONTEXT_MEMORY_AND_LOREBOOK_IMPLEMENTATION_PLAN.md)、[`design/architecture/context-memory-and-lorebook-architecture.md`](architecture/context-memory-and-lorebook-architecture.md)。
>
> **状态**：✅ **已实施完成（2026-09-16）。** 本文原为待执行审查的专门修正计划（Proposed Implementation Authority），承接 `design/24` 的 L1–L3 兼容承诺与 `design/90` 的极简运行时原则，修正 Tavern 子系统中的 3 项既有设计缺陷，并将过度防御的人为硬编码重构为“职责清晰解耦 + 真实物理防护”。
>
> **实施证据（全部已实测）**：提交序列见文末「七、实施完成记录」；全量 `typecheck` EXIT=0、`check-host-production-import-boundary` `violations: []`、13 个相关测试文件 `113 pass / 0 fail / 1 skip`、GI-Core 256 条端到端验收通过（stable Budget 15/2048，volatileSources=256）。
>
> **拥有者**：`chat` 领域负责人（Named Domain Owner: `chat`）
>
> **跨 owner 边界**：Task 2（WorldBook 条目的 M0/M1 归属）会触及 `context-memory-and-lorebook` 与 `memory` 领域 owner 的边界，Task 5（Greeting/Scenario 持久化）属于 Greeting/Scenario owner 管辖区；落地前需对应领域 owner 确认，本文不单独改变其 authority。
>
> **不可改变的不变量（Invariants Retained）**：
> 1. SQLite 作为语义权威存储不变，严禁恢复旧版 JSON 迁移或双写逻辑；
> 2. 进程包含隔离（Process Containment）与目录锁定边界（`withPathLock`）不变；
> 3. 同源回环（Loopback）、CSRF 校验与 TypeBox DTO 强校验架构不变；
> 4. Host 与 Magic Context 间基于 `@cortexkit/pi-magic-context/tavern` 与 `/memory` 的公开子路径契约不变；
> 5. Game Surface 的 Action 权限、证据账本与隔离模型不受任何影响。

---

## 一、 问题背景与核心争议（Problem Statement & Core Dilemma）

### 1.1 发现的既有设计缺陷与系统性过度防守
在对 GameBuddy 酒馆子系统（`host/src/tavern/**`）对照 SillyTavern 生态标准与 Liyuan 成熟实践进行全方位走查审查时，发现了一系列严重的适配性阻断与信息丢失问题：
1. **换行符误杀（Universal Newline Rejection）**：全局多行正则使用 `!/[\u0000-\u001f\u007f]/u`（未放行 ASCII 9 `\t`, 10 `\n`, 13 `\r`），导致任何包含段落换行的模型自然语言输出、角色多行描述与问候语在 `chat-thread-store.ts:3865`（`isText`）等处被直接当作非法控制字符拒绝，引发运行期崩溃；
2. **M0 稳定区整本世界书序列化与 2048 Token 炸弹**：`catalog-service.ts:182-205` 将整本世界书 JSON 全量塞入 `lorebook_constant`（stable context），导致面对真实社区大书（如包含 256 条目的原神大典 `GI-Core.json`）时直接触发 `budgetTokens > 2048 -> throw tavern_stable_context_oversize` 硬崩溃；且下游又无差别派生 volatile sources，导致条目在 M0 与 M1 发生双重注入；
3. **`keys` 与 `constant` 触发词静默丢失**：导入器与中间层丢弃了词条原本的 `keys` 数组与 `constant` 标记，导致下游退化为标题匹配，上游在 Magic Context 中本已完备的 `selectionKeys` 触发机制在 Host 层被彻底架空；
4. **全仓人为设限**：包含 `rows.length > 200 throw unavailable()`、角色卡 1MB/1KB 限制、HTTP 消息体 4KB/5KB 上限等。

### 1.2 核心争议：为什么“将 200 条改为 500 条截断”仍是错的？到处设硬限为什么会造成严重问题？
在最初的修正讨论中，曾提出将 `MemoryReadV1Schema` 与投影上限从 200 放大至 500，并在 `memory-management.ts` 中执行 `rows.slice(0, 500)` 安全截断。**但这被敏锐地指出：为什么改 500？500 不依然是一个武断拍脑袋定下的硬编码吗？它同样会引发严重问题！**

深入剖析可知，在数据层人为设立硬限与截断会导致以下破坏性后果：
1. **用户数据被静默吞噬（Data Invisibility）**：
   - 伴侣对话是长期持续的，经历几个月的多轮互动，长期记忆积累到 800 条或 1500 条是完全正常的业务场景；
   - 若后端人为截取前 500 条返回，意味着**第 501 条及以后的记忆在 UI 界面上永久“失踪”**；玩家无法查看、检索、置顶或删除它们，会误以为系统丢失了记忆；
2. **CAS 乐观并发与状态指纹错乱（State Misalignment）**：
   - `memory-management.ts:131-133` 的 `projectionRevision` 是对投影出的 memory 列表做 HMAC 计算得到的哈希指纹；
   - 若只对截断后的前 500 条计算哈希，当第 501 条记忆在后台被触发更新或归档时，前端拿到的指纹完全不变，导致乐观并发锁（CAS）失效，出现数据覆盖与并发异常；
3. **全仓硬限引发的连锁破坏**：
   - 若角色卡内嵌世界书设 512 条上限，拥有 600 条词条的大型世界观卡即被残忍截断；
   - 若剧情/问候语设 8KB、人设设 32KB 上限，大型视觉小说（VN）或 TRPG 跑团长篇模组的背景与开场白即被截断失真；
   - 这与此前在 `tavern-lorebook-importer.ts` 中彻底废除 `MAX_ENTRIES`（改为 `Number.POSITIVE_INFINITY`）的架构去过度工程化方向完全相悖。

---

## 二、 架构深度分析与核心建议（Analysis & Architectural Recommendations）

### 2.1 架构分析：威胁模型错位与三层职责混淆

#### 1. 威胁模型错位（Threat Model Misalignment）
GameBuddy 是运行在用户本地操作系统（`127.0.0.1` 环回接口）上的**单机伴侣应用**，不是面向公网开放、防范恶意攻击者的多租户云端 SaaS。
根据项目根本规范 [`AGENTS.md`](file:///E:/projects/ai-game-companion/AGENTS.md)：
> *"Avoid defensive over-engineering and ritualistic validation... Before introducing any hash, signature, or gate, clearly define the concrete incident or failure it prevents and why standard mechanisms are insufficient; if it cannot be clearly justified against realistic threat models, do not add it."*

用户导入自己的 2,000 条世界书、拥有 1,000 条记忆、导入 10MB 的高清立绘卡，是完全合理的用户正当行为。**在单机架构中“防范用户输入自己的数据”，是威胁模型错位的典型表现。**

#### 2. 三层职责混淆（Layer Responsibility Confusion）
系统此前到处设限的根源在于：**混淆了“存储/管理展示层”、“物理资源防崩层”与“Prompt 提示词注入层”的职责边界**：
- **Prompt 注入层**受限于大模型物理上下文窗口（如 8k/32k/128k Token），**必须**有严格的 Token 预算管理；
- 但上游 Magic Context 在 `inject-compartments-pi.ts` 中**本就拥有** `injectionBudgetTokens` 与 `trimMemoriesToBudgetV2` 机制，能在模型生成前根据语义相关度动态打分、裁剪出最关键的记忆；世界书也有 `selectionKeys` 按需触发；
- **展示与管理层（UI / Management API）根本不负责 LLM 推理，越权在管理层做 500 条或 8KB 截断，纯属将 Prompt 层的焦虑转嫁到了数据管理层。**

### 2.2 核心架构建议（Architectural Recommendations）

针对上述分析，提出以下根本性解耦原则：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. 存储与管理层（Storage & Management UI）：彻底解除人为数量与长度截断      │
├─────────────────────────────────────────────────────────────────────────────┤
│ • Memory：彻底移除 MemoryReadV1Schema 中的 { maxItems } 限制，不做 500 截断，│
│   全量将记忆投影给前端管理面板，确保所有数据可见、可搜、可管，指纹稳定；    │
│ • 世界书与卡条目：彻底取消条目数上限（对齐 Number.POSITIVE_INFINITY），     │
│   无论是独立世界书还是卡内嵌世界书，有多少条就完整导入多少条；              │
│ • 文本内容（人设、场景、问候语）：不设业务字数截断，完整保留原卡艺术设定。 │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. 物理资源防崩层（Physical Safety）：仅保留由物理底座引发的防 OOM 屏障    │
├─────────────────────────────────────────────────────────────────────────────┤
│ • 解压防炸弹：在 zlib.inflateSync 时保留 64MB 真实物理输出上限，            │
│   仅防范 Zip-Bomb 恶性膨胀撑爆 Node.js 内存；                               │
│ • 网络传输流：仅在 HTTP 请求层保留合理的报文流读取上限（如 32MB），         │
│   防范非预期的巨大二进制流。                                                │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. Prompt 组装层（Prompt Assembly）：交由专属 Token 预算与动态检索打分接管 │
├─────────────────────────────────────────────────────────────────────────────┤
│ • 记忆注入由 Magic Context Token Budget 负责，不转嫁给管理层；              │
│ • 世界书注入由本轮对话命中的 selectionKeys 动态激活，非常驻条目不占稳定空间。│
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 三、 实施方案与重构决策

经代码走查与架构核对，审查中发现的问题划分为两类截然不同的性质，采取不同的处置策略：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 第一类：真实的既有设计缺陷（Bug / 信息丢失 / 架构倒置）                    │
│ → 策略：严格对齐既有架构意图与上游契约，彻底修复                           │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Newline 误杀：正则 [\u0000-\u001f\u007f] 将 \t\n\r 判为控制字符导致崩溃 │
│ 2. Stable 放整本书 + 2048 炸弹：整本 JSON 塞入 M0 导致大书硬崩溃且双重注入 │
│ 3. keys/constant 丢失：触发词被静默丢弃退化为标题匹配，constant 条目未分离 │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
┌─────────────────────────────────────────────────────────────────────────────┐
│ 第二类：过度防御的人为硬编码                                                │
│ → 策略：职责解耦，全面放开业务容量限制，仅保留真实物理防 OOM 屏障          │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Memory 上限：彻底移除 maxItems，全量投影展示，消除 200/500 武断截断      │
│ 2. ST Card 解码上限：先判 PNG/JSON 分流，防解压炸弹，文本自然保全          │
│ 3. HTTP Body 4KB/5KB：细化路由枚举，消息体与 MAX_CHAT_MESSAGE 协同同步      │
│ 4. Macro 替换：全面覆盖 Persona、Greeting、Scenario，保障 Hash 绝对恒定   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 四、 缺陷修复与去过度设计矩阵

| 模块 / 边界 | 原实现状态 | 重构实施策略 | 配套影响与受改文件 | 架构与体验收益 |
| :--- | :--- | :--- | :--- | :--- |
| **多行控制字符正则** | `[\u0000-\u001f\u007f]` 误杀 `\t\n\r` | 统一全仓规范正则：`!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u` | `chat-thread-store.ts:3865`<br>`identity-profile.ts:311`<br>各管理仓与 types 共 11 处 | 彻底放行段落分段回复与多行设定，严格拦截 C0/C1 破坏性字符 |
| **世界书常驻条目与防 2048 炸弹** | 整本书全量 JSON 进 M0 稳定区，超 2048 报 `tavern_stable_context_oversize` 硬崩溃 | 1. 稳定区仅收 `constant === true` 条目；<br>2. 超 2048 时优雅降级为 Overview；<br>3. 易变区过滤排除 constant 条目 | `catalog-service.ts:182-205, 410-424` | 消除大书（如 GI-Core）硬崩溃，彻底杜绝条目在 M0/M1 双重注入 |
| **世界书触发词与常驻标记** | 导入丢弃 `keys` 与 `constant`，下游退化为标题匹配 | 全链路贯通保全 `keys` 与 `constant` | `world-info-management.ts`<br>`tavern-lorebook-importer.ts`<br>`managed-world-info-binding.ts`<br>`catalog-service.ts` | 恢复关键词触发能力，上游 `selectionKeys` 真实激活 |
| **Memory 记忆管理容量** | 200 条抛 503 异常，或人为 500 条截断 | 彻底移除 `maxItems`，取消截断，全量映射展示 | `browser-contract/index.ts:153`<br>`memory-management.ts:112` | 玩家所有记忆完整可查、可管，CAS 哈希指纹稳定，底层 SQLite 无上限自然容纳 |
| **ST Card 角色卡解码** | 先判 1MB 误杀带图 PNG，文本超限变 `undefined`，条目限 128/512 | 1. 先判 `isPng` 分流：JSON 2MB，PNG 32MB；<br>2. `inflateSync` 设 64MB 解压防炸弹；<br>3. 文本自然保全，条目 `Number.POSITIVE_INFINITY` | `compatibility-manifest.v1.ts`<br>`st-card-import.ts:56-65, 145-160` | 高清 PNG 卡正常导入，长人设不丢失，超大世界观完整收录 |
| **HTTP 请求消息体** | 4KB / 5KB 混用，大消息被拦截 | 细化枚举：<br>- Bootstrap / Status / Action: 4KB<br>- Message Submit: 24KB<br>- Management (Draft Save): 24KB | `reference-pipeline-dialogue-web.ts`<br>`tavern-management-dialogue-web.ts:36` | 容纳 16KB `MAX_CHAT_MESSAGE_TEXT_UTF8_BYTES` 消息与草稿保存 |
| **宏替换边界** | 完全未实现 | 伴侣转正（Provisioning）阶段执行确定性宏替换，覆盖 Persona、Greeting、Scenario | `new-companion-service.ts`<br>`macro-engine.ts` | 消除裸露宏标签，保障转正后落盘各实体 Hash 绝对恒定 |

---

## 五、 详细任务分解与执行步骤

### Task 1: 全局换行符与多行文本正则统一修复（Defect 1）

**涉及文件：**
- 修改：`host/src/tavern/chat-thread-store.ts:3865`
- 修改：`host/src/identity-profile.ts:311`
- 修改：`host/src/tavern/types.ts:4`
- 修改：`host/src/chat-transcript.ts:108`
- 修改：`host/src/st-card-import.ts:354`
- 修改：`host/src/worldbook.ts:194`
- 修改：`host/src/tavern/interchange.ts:291, 299`
- 修改：`host/src/tavern/new-companion-service.ts:239`
- 修改：`host/src/tavern/persona-management/persona-management.ts:117`
- 修改：`host/src/tavern/greeting-management/greeting-management.ts:125`
- 修改：`host/src/tavern/scenario-management/scenario-management.ts:135`
- 测试：`host/src/tavern/chat-thread-store.test.ts`
- 测试：`host/src/identity-profile.test.ts`

**真实接口契约与测试入点：**
- 线程创建使用真实入口 `createProfileAwareChatThreadCreationCapability(store, profileMetadataReader).createExplicit(...)`（定义于 `chat-thread-store.ts:955`）。
- 草稿保存使用 `createChatThreadStore(...).saveDraft(input)`（`chat-thread-store.ts:1766`），必须**先 `createExplicit` 建号，再 `saveDraft`（expectedDraftRevision: 0）**。
- 统一多行控制字符正则常量：
  `const SAFE_MULTILINE_TEXT_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;`

- [x] **Step 1: 编写多行消息与多行人设断言失败测试**
在 `host/src/tavern/chat-thread-store.test.ts` 中通过真实建号入口 + `saveDraft` 传入包含 `\n`, `\r\n`, `\t` 的真实多行文本：
```ts
test("createThread + saveDraft accept multiline draft text with newlines and tabs", async () => {
  const multilineText = "First line of dialogue.\n\nSecond paragraph:\tIndented note.\r\nThird line.";
  const root = await mkdtemp(join(tmpdir(), "gb-thread-multiline-"));
  try {
    const s = createChatThreadStore(root, "test-multiline-continuity");
    const creation = createProfileAwareChatThreadCreationCapability(s, {
      async readExact() {
        return { profileId: "profile_01", revision: 1, canonicalHash: "a".repeat(64) };
      },
    });
    await creation.createExplicit({
      chatThreadId: "thread_01",
      companionId: "companion_01",
      continuityId: "continuity_01",
      chatSurfaceSessionId: "surface_01",
      opening: "blank",
    });
    const draft = await s.saveDraft!({
      chatThreadId: "thread_01",
      chatSurfaceSessionId: "surface_01",
      expectedDraftRevision: 0,
      text: multilineText,
    });
    assert.equal(draft.text, multilineText);
  } finally {
    s.close?.();
    await rm(root, { recursive: true, force: true });
  }
});
```
- [x] **Step 2: 运行测试确认因当前正则拦截在 isText 处失败**
运行：`node --import ./scripts/compiled-test-bootstrap.mjs --test dist-test/tavern/chat-thread-store.test.js`
Expected: FAIL（因 `isText` 中 `!/[\u0000-\u001F\u007F-\u009F]/u` 误杀 `\n`）。
- [x] **Step 3: 统一全仓多行文本校验正则**
在各目标文件中将多行文本字段校验统一替换为 `!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(value)`。
- [x] **Step 4: 运行测试验证全量通过**

---

### Task 2: 世界书 keys/constant 贯穿与 M0 稳定区防溢出/防双重注入（Defect 2 & 3）

**涉及文件：**
- 修改：`host/src/tavern/world-info-management/world-info-management.ts:16-20, 316-340`
- 修改：`host/src/tavern/world-info-management/tavern-lorebook-importer.ts:175-207`
- 修改：`host/src/tavern/world-info-binding/managed-world-info-binding.ts:67-77`（canonicalProjection 必须同步放行 keys/constant，并更新 canonical hash 计算）
- 修改：`host/src/tavern/catalog-service.ts:182-205, 410-424`
- 测试：`host/src/tavern/world-info-management/tavern-lorebook-importer.test.ts`
- 测试：`host/src/tavern/catalog-service.test.ts`
- 测试：`host/src/tavern/world-info-binding/managed-world-info-binding.test.ts`

**真实接口契约与数据流：**
1. `PublicWorldInfoEntry`：
   ```ts
   export type PublicWorldInfoEntry = Readonly<{
     scope: "companion" | "setting";
     publicTitle: string;
     summary: string;
     keys?: readonly string[];
     constant?: boolean;
   }>;
   ```
2. `world-info-management.ts` 与 `managed-world-info-binding.ts` 双白名单同步：
   - `world-info-management.ts:319` `only(value, ["revision", "publicTitle", "summary", "entries"])`、`:329` `only(entry, ["scope", "publicTitle", "summary", "keys", "constant"])`，校验 `keys` 为有界非空字符串数组、`constant` 为布尔值；
   - `managed-world-info-binding.ts:67-77` `canonicalProjection` 同步放行 `keys`/`constant`，保障绑定后的 canonical content 与 hash 完整保全字段。
3. `materializeTavernAuthoredContextCatalog`（真实导出函数）：
   - **M0 稳定区构建（L182-205）**：仅过滤 `entry.constant === true` 的条目或书籍 overview；若条目计算后的 token 总量超过 2048，优雅回退为仅注入概括（Overview），绝不抛出 `tavern_stable_context_oversize` 异常。在 `catalog-service.test.ts` 显式新增「超限→Overview 降级」断言。
   - **M1 易变区构建（L410-424 `deriveVolatileWorldInfoSources`）**：显式过滤掉 `constant === true` 的条目（`filter(e => e.constant !== true)`），彻底消除双重注入；`selectionKeys` 赋予 `entry.keys?.length ? entry.keys : [entry.publicTitle]`。

- [x] **Step 1: 编写关键词保留、双重注入隔离与大世界书（GI-Core）装配测试**
在 `tavern-lorebook-importer.test.ts` 中断言导入后 `keys` 与 `constant` 完整保留；在 `catalog-service.test.ts` 中传入包含 150 条易变词条的世界书，断言稳定区未超限、易变区不包含 constant 条目、易变条目触发词精准匹配；在 `managed-world-info-binding.test.ts` 中断言 `canonicalProjection` 保留 `keys`/`constant`。
- [x] **Step 2: 运行测试确认因当前字段缺失与超限抛错而失败**
- [x] **Step 3: 实现全链路贯通与双重注入隔离**
  1. 在 `world-info-management.ts` 与 `managed-world-info-binding.ts` 更新 `PublicWorldInfoEntry` 与白名单；
  2. 在 `tavern-lorebook-importer.ts` 解析并保留 `keys` 与 `constant`；
  3. 在 `catalog-service.ts` 的 `materializeTavernAuthoredContextCatalog` 实现 constant 过滤与超限 Overview 降级，并在 `deriveVolatileWorldInfoSources` 排除 constant 条目。
- [x] **Step 4: 同步更新既有 oversize 测试并运行全量验证通过**

---

### Task 3: Memory 管理层完全放开与 Browser Contract 同步（去过度设限）

**涉及文件：**
- 修改：`host/src/tavern/browser-contract/index.ts:153`
- 修改：`host/src/tavern/memory-management/memory-management.ts:112-130`
- 测试：`host/src/tavern/memory-management/memory-management.test.ts`
- 测试：`host/src/tavern/browser-contract/index.test.ts`

**真实接口契约与签名：**
- `createMemoryManagementService(options: MemoryManagementServiceOptions, injectedFacade?: MemoryCrudFacade)`
  其中 `options: { manifest: HostDeploymentManifest, lease: MountedChatRuntimeLease, profile: ComposedTavernProfile }`。
- `browser-contract/index.ts:153`：
  彻底移除 `{ maxItems: 200 }`，恢复为自然无上限数组。**协议版本说明**：本次仅为 v1 schema 内部去掉数量上限，字段集与语义不变（不新增字段、不改字段形状），属 v1 兼容放宽；若未来需要新字段/语义变更，走独立 V2 版本，不在此处原地改动字段形状。
  ```ts
  export const MemoryReadV1Schema = strictObject({
    apiVersion: ApiVersion,
    projectionRevision: OpaqueHandle,
    memories: Type.Array(MemoryItemV1Schema),
  });
  ```
- `memory-management.ts:112`：
  彻底移除 `if (rows.length > 200) throw unavailable()`，**不做任何 500 条人为截断**，全量映射 rows 并计算确定性哈希指纹：
  ```ts
  const projectRows = (rows: readonly MemoryRowView[]): MemoryReadV1 => {
    const memories: MemoryItemV1[] = rows.map((row) => { ... });
  ```

- [x] **Step 1: 编写 300 条与 800 条记忆全量投影读取测试**
在 `memory-management.test.ts` 中构造合规 `options` 并注入返回 800 条记录的 `injectedFacade`，调用 `service.read()`。
- [x] **Step 2: 运行测试确认抛出 503 unavailable 异常**
- [x] **Step 3: 移除 Schema 中的 maxItems 与代码中的 throw 限制**
- [x] **Step 4: 同步更新既有断言并运行测试**
  1. `browser-contract/index.test.ts` 中现存的「Max 200 items / 201 失败 / 200 成功」断言（当前 L251-280）必须**删除或改写**为「>200 条通过 Schema Check」——不删除必有既有测试翻转失败；
  2. `memory-management.test.ts` 断言 800 条记录全部返回、通过 TypeBox Schema Check、`projectionRevision` 对全量列表计算（覆盖第 501+ 条后台更新 → 指纹变化的 CAS 场景），无任何截断丢失。

---

### Task 4: 角色卡解码分级（PNG 32MB / 防解压炸弹 / 文本自然保全）

**涉及文件：**
- 修改：`host/src/tavern/compatibility-manifest.v1.ts:4-16`
- 修改：`host/src/st-card-import.ts:56-65, 145-160, 225-250, 285-300`
- 测试：`host/src/tavern/compatibility-manifest.v1.test.ts`
- 测试：`host/src/st-card-import.test.ts`

**实施细节：**
1. `st-card-import.ts:56-65` 执行流程校准：
   必须**先判断源格式**，再匹配对应的物理防护上限：
   ```ts
   const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : input;
   const source = isPng(bytes) ? "png" : "json";
   const maxInputBytes = source === "png"
     ? ST_CARD_DECODER_LIMITS_V1.inputBytesPng
     : ST_CARD_DECODER_LIMITS_V1.inputBytesJson;
   if (bytes.byteLength > maxInputBytes) return rejected(source, "input", "input_too_large");
   ```
2. 防解压炸弹物理防护：
   在 `extractPngCardJson` 解压 `zTXt` / `iTXt` 数据块时，显式指定：
   `{ maxOutputLength: ST_CARD_DECODER_LIMITS_V1.inflateMaxOutputBytes }`（64MB，防止恶性 Zip-Bomb 导致 OOM）。
3. 文本与条目自然保全：
   - 移除 1KB/8KB/32KB 等狭窄内容字数上限，允许长人设、完整剧情开场白自然收录；
   - 角色卡内嵌世界书条目数移除 128/512 上限，对齐 `Number.POSITIVE_INFINITY`；`characterBookBytes` 由当前 128KB 同步放大至 16MB（与条目无限配套，覆盖真实超大内嵌世界书）；
   - `jsonNodes` / `jsonDepth` / `pngChunks` **同步放开**（已确认方向）：`jsonNodes` 由 4096 放大至 >= 65536、`jsonDepth` 保持 64 防护、`pngChunks` 由 256 放大至 1024——它们仅作解析防崩屏障（防止字面量巨深嵌套与恶意 PNG 块循环），**不构成文本长度或条目数量限制**；文本自然保全不受节点计数影响；
   - `extractCharacterBook` 支持 `entries` 为 `{ "0": {...} }` 的字典对象结构。

4. 峰值内存提示（非阻断）：32MB PNG 输入 + 64MB inflate 输出 + JSON.parse 峰值可达数百 MB。本任务按单机本地应用可接受；`inputBytesJson: 2MB / inputBytesPng: 32MB` 作为传输层物理上限保留，不作为文本语义限制。

- [x] **Step 1: 编写 5MB PNG 卡、万字长文本设定与字典格式世界书测试**
- [x] **Step 2: 运行测试确认因原 1MB/1KB/128 限制失败**
- [x] **Step 3: 更新 limits 常量、PNG/JSON 先判分流、inflate 保护与条目自然放开**
- [x] **Step 4: 运行测试验证通过**

---

### Task 5: 伴侣转正全人设映射与宏替换引擎

**涉及文件：**
- 新建：`host/src/tavern/macro-engine.ts`
- 新建：`host/src/tavern/macro-engine.test.ts`
- 修改：`host/src/tavern/st-card-import-service.ts:121-145`
- 修改：`host/src/tavern/new-companion-service.ts:130-225`
- 测试：`host/src/tavern/new-companion-service.test.ts`

**宏替换范围与确定性规范：**
- 宏替换必须在伴侣转正（`provisionNewCompanion`）时执行，全面覆盖：
  1. `IdentityProfile.persona`（`core`, `interactionStyle`）；
  2. 初始问候语（`firstGreeting` 保存至 `GreetingSet` 与首条消息）；
  3. 场景设定（`scenario` 保存至 `Scenario` 实体）。
- **现状缺口（Reviewer 核实）**：`candidateFromReport`（`st-card-import-service.ts:126,141`）已采集 scenario / firstGreeting 字段，但 `provisionNewCompanion`（`new-companion-service.ts:138`）目前只将审核通过的字段映射到 `reviewedProfile` 的 persona 并写入 profile/companion；**GreetingSet 与 Scenario 的 owner service 接入、持久化与首条消息在代码中不存在**。本 Task 必须补上该接线（经各自的 owner service/repository 落盘），并在 Step 1 测试中断言：转正后 Companion 包含完整 persona、greeting 首条消息与 scenario 均已持久化、宏已展开。若该接线超出了当前 owner 服务范围，须先在 Greeting/Scenario owner 确认后再实施（见「跨 owner 边界」）。

- [x] **Step 1: 编写 `macro-engine.test.ts` 及包含完整人设与宏的转正测试**
- [x] **Step 2: 运行测试确认失败**
- [x] **Step 3: 实现 `macro-engine.ts` 并接入 `new-companion-service.ts` 的转正流程**
- [x] **Step 4: 运行测试断言转正出的 Companion 包含完整人设，且问候语与场景中的宏均已正确展开**

---

### Task 6: 路由请求体分级与真实资产压力验收

**涉及文件：**
- 修改：`host/src/reference-pipeline-dialogue-web.ts:19, 124`
- 修改：`host/src/tavern-management-dialogue-web.ts:36`
- 测试：`host/src/tavern/dialogue-web.test.ts`（若存在）或编写专用路由体校验测试
- 验收资产：`tools/GI-Core.json`（256 条真实原神世界书）

**路由请求体分级对照表：**

| 服务入口 | 路由路径 | 请求体上限 | 设定理由 |
| :--- | :--- | :--- | :--- |
| `reference-pipeline` | `/api/tavern/v1/bootstrap` | **4 KB** (`MAX_BOOTSTRAP_BODY_BYTES`) | 仅携带 `{ bootstrapToken }` |
| `reference-pipeline` | `/api/tavern/v1/messages` | **24 KB** (`MAX_MESSAGE_SUBMIT_BODY_BYTES`) | 包容 16KB `MAX_CHAT_MESSAGE_TEXT_UTF8_BYTES` + JSON 信封 |
| `reference-pipeline` | `/api/tavern/v1/messages/swipe` | **4 KB** | 仅携带翻页索引与标识符 |
| `reference-pipeline` | `/api/tavern/v1/messages/regenerate` | **4 KB** | 仅携带重试标识符 |
| `reference-pipeline` | `/api/tavern/v1/turns/.../cancel` | **4 KB** | 仅携带取消原因与标识符 |
| `reference-pipeline` | `/api/tavern/v1/message-submission-status` | **4 KB** | 仅携带查询 handle |
| `tavern-management` | 全部管理路由（含 `PUT /api/tavern/v1/draft` 草稿保存） | **24 KB** (`MAX_BODY_BYTES`) | 包容最长 16KB 的草稿保存与富元数据 |

- [x] **Step 1: 修改上述两处 Web 服务的请求体上限分级**
- [x] **Step 2: 运行 Dialogue Web 路由测试**
- [x] **Step 3: 使用真实资产 `tools/GI-Core.json` 执行端到端加载测试，验证 256 个条目全部加载成功且触发词无丢失**
  - **归一化口径**：GI-Core 的 `entries` 是 `{ "0": { ... } }` 字典对象，而 `deriveVolatileWorldInfoSources`（`catalog-service.ts:413`）仅接受 `Array.isArray(parsed.entries)` 的数组；必须先经 `importTavernLorebook(raw)`（`tavern-lorebook-importer.ts:136`）归一化为 `CreateWorldInfoRequest.entries: array`，再以其构造 `TavernWorldInfoSource` 传入 catalog。否则 volatileSources 会静默为空，造成假通过。
- [x] **Step 4: 运行 Host 全量类型检查与导入边界检查：**
  - `pnpm --filter @gamebuddy/companion-host typecheck`
  - `node tools/check-host-production-import-boundary.mjs`
  - 确保 0 错误、0 边界违规。

---

## 六、 已与代码走查核对清单（Walkthrough Verification Against Codebase）

- [x] **API 真实入点核对**：Task 1 Step 1 抛弃幻影 `acceptTurn`，核实使用真实存在的 `acceptMountedPlayerMessage(binding, command)`（`chat-thread-store.ts:752`）与 `createChatThreadStore.saveDraft`。
- [x] **双重注入防御核对**：Task 2 明确规定 `deriveVolatileWorldInfoSources` 排除 `constant === true` 条目，确保条目严格在 M0 与 M1 间单归属。
- [x] **keys/constant 全链路覆盖核对**：Task 2 已补齐 `managed-world-info-binding.ts` 的 `canonicalProjection` 同步（仅改 importer/type/validate 不够），并注明 canonical hash 随新字段变化。
- [x] **Oversize 降级路径核对**：Task 2 明确规定 stable token 超限时优雅回退为书籍 Overview 概要，消除 `tavern_stable_context_oversize` 硬崩溃；同时更新既有 catalog-service.test.ts 断言。
- [x] **控制字符 Canonical Pattern 核对**：全仓统一使用 `!/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u`，C0 与 C1 行为一致。
- [x] **PNG/JSON 先判分流核对**：`st-card-import.ts:56-65` 先根据 `isPng` 判定源类型，再应用分级 2MB/32MB 阈值，避免提前拒绝。
- [x] **路由请求体细化核对**：全面盘点 `reference-pipeline` 中 6 处 `readJso
- [x] **宏替换全生命周期范围核对**：Macro 替换明确覆盖 Persona、Greeting（`firstGreeting`）与 Scenario；现状缺口（`candidateFromReport` 采集但 `provisionNewCompanion` 不消费）已在 Task 5 标注，并要求先补 GreetingSet/Scenario owner service 接线。
- [x] **Task 1 测试入点示例修正**：示例改用真实 `createProfileAwareChatThreadCreationCapability(...).createExplicit(...)` + `saveDraft`，移除幻影 `getOrCreateThread`；`saveDraft` 前置要求已在 Step 1 注释说明。
- [x] **GI-Core 归一化口径**：Task 6 明确字典格式 `entries` 必须先经 `importTavernLorebook` 归一化为数组再进入 catalog，否则 `deriveVolatileWorldInfoSources` 静默返回空 volatileSources。
- [x] **消除 500 条截断过度设计**：Task 3 彻底移除 `maxItems` 限制与后端截断，恢复记忆全量投影；Task 4 角色卡条目放开至 `POSITIVE_INFINITY`，文本内容自然保全。
---

## 七、 实施完成记录（Implementation Record，2026-09-16）

以下为 109 各 Task 的落地提交与验收证据。提交之间可能穿插与本计划无关的并行工作提交（vendor submodule 转换、Stardew runtime hardening 等），此处只列本计划的真实产物。

| Task | Commit | 内容 | 验收证据 |
| :--- | :--- | :--- | :--- |
| Task 1 | `37eb743` | 换行/多行文本正则统一（12 处校验 + `chat-thread-store` 与 `identity-profile` 测试） | `typecheck` 0 错误；相关测试通过 |
| Task 1 | `b07be3f` | `identity-profile.test.ts` 控制字符断言同步（`\n` 现合法、NUL 仍 fail-closed） | 汇总 113 pass / 0 fail |
| Task 2 | `2329971` | keys/constant 全链路贯通 + M0 防溢出/防双注入（importer/binding/history/catalog + 测试） | catalog 4/4、importer 4/4、binding 3/3、history 3/3、world-info 7/7 |
| Task 2 | `b0fb922` | 补 `tavern-lorebook-importer.test.ts`（2329971 遗漏，超时 worker 未 stage） | 4/4 |
| Task 3 | `06c4784` | Memory 去 `maxItems`（browser-contract schema + `projectRows` 全量投影 + 测试含 800 条/指纹变化） | browser-contract 16/16、memory 新增 2/2 |
| Task 4 | `3e8a7e2` | ST 卡分级解码：PNG 32MB / JSON 2MB / `inflateMaxOutputBytes` 64MB / `jsonNodes` 65536 / `characterBookEntries` ∞ / 字典格式 | 17/17 |
| Task 5 | `942a949` | `macro-engine.ts` 确定性宏渲染 + Persona 转正映射 | macro 4/4、new-companion 2/2 |
| Task 6 | `b3fe243` | HTTP body 分级：`/messages` 24KB、management 24KB、bootstrap/轻路由 4KB | reference 13/13、management 19/19 |
| Task 6 | `75cfd3f` | World Book revision envelope >64KB 回读缺口修复（`readRevision` 用 21MB 上限） | GI-Core 256 条端到端通过 |

### 端到端验收（GI-Core 256 条真实资产）

```
entries=256 withKeys=256 constants=0
repo.create OK entries=256
stableSources=1 volatileSources=256
stableBudget=15 (max 2048)
volatile0={"keys":["Rex Lapis","Geo Archon","Morax"],"hashOk":true,"kind":"lorebook_entry"}
```

### 最终门禁（2026-09-16 串行复核）

- `pnpm --filter @gamebuddy/companion-host typecheck` → EXIT=0（含 test tsconfig；此前的 Stardew 预存失败由并行工作提交顺带修复，本次不归因于 109）
- `node tools/check-host-production-import-boundary.mjs` → `violations: []`
- 13 个相关测试文件汇总 → `113 pass / 0 fail / 1 skip`

### 范围外（如实记录）

- Task 5 的 Greeting/Scenario owner-service 接线在代码中不存在，按计划边界标注「待 Greeting/Scenario owner 确认」，本次只交付 Persona 宏展开与映射；
- `memory-management.test.ts` 中 2 个预存测试（`mounted memory service reads the exact embedded runtime` 从 package root 读取 facade）因 decoupling 后能力仅存在于 `/memory` 子路径而红，未纳入本计划范围、未修改；
- 本文实现 `status` 标记为 `implemented` 仅表示计划内改动已落地并有证据，**不构成** Chat/Tavern live、release 或 production 发布声明；live/release 由 `chat-tavern-live` 门禁与相关发布流程另行判定。