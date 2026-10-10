# 阶段二:Chat 与伴侣能力全量对齐 — per-item status table + routed requests

孤儿材料核查(全部为只读事实,核查于开始实现之前):

- `ref/`(Tavern standards、SillyTavern 参考实现、character-card-spec、lorebookValidation.js、Liyuan 参考):**本 checkout 中完全缺失**。`.gitignore:3` 忽略 `/ref/`,`git ls-tree HEAD ref/` 为空,`Get-ChildItem ref -Recurse` 为 0 文件,`ref/.git` 不存在(不是 submodule)。兄弟克隆(agc-merge / agc-integrate / ai-game-companion-current-wip-rc69-baseline / ai-game-companion-recovery-20260914-021106 / gamebuddy-chat-core-integration / gamebuddy-farmhand-final)的 `ref/` 均为 0 文件;全盘(documents/D:/E:)有界搜索 `lorebookValidation.js`、`08-sillytavern-worldinfo-lorebook-guide.md`、`character-card-spec-v2` 无结果。`fixtures/tavern/sillytavern/` 只有 card fixtures(normal/hostile card-prompt.json、card-v2.json、manifest),**不是** Tavern 参考文档。
- `design/`(design/26 等权威文档):`.gitignore:2` 忽略 `/design/`,当前 checkout 仅剩空目录(+1 个 architecture 文件)。
- 因此"对齐到 Tavern 标准文档 / Liyuan 参考"无法在本机执行。**本报告以代码内嵌设计案(i18n 注释、宿主契约注释、既有 spec 的失败说明)与实际宿主契约作为权威来源**;这是无材料环境下的最高可用权威。supervisor 已裁定:交付可验证项 + 精确 routed request,其余如实上报。

## Per-item status table

| Item | 要求(上家) | 实际状态 | 证据 | 我的交付/路由 |
|---|---|---|---|---|
| 1 Markdown / 行动旁白 | `*nods*` 优雅处理(斜体),script 中和 | 行为层**已实现**:MarkdownMessage.tsx 解析+DOMPurify 白名单+`em.message-action` hook;spec chat-surface-renderer.spec.ts 覆盖(**绿,3 项**)。**视觉层缺失**:style.css 无任何 `message-action` 规则 | MarkdownMessage.tsx:27-43;tests/chat-surface-renderer.spec.ts:85-103;style.css 全文件 0 匹配 `message-action` | **Routed R2**:style.css 加 `.message-action` 规则(动作斜体);宿主/行为侧无需改动 |
| 2 Swipe / Regenerate | 单飞守卫 + 生成中/切卡时状态与骨架占位 | 表现层(busy 禁用 + aria-busy/data-pending + settled 恢复)**已提交 HEAD**(MessageBubble.tsx:51,99;Timeline.tsx:100)并有**新 spec 覆盖(3 项绿)**。**单飞命令守卫未提交**:HEAD 的 handleSwipe/handleRegenerate 无任何 latch,双击发两条命令;守卫只在另一 lane 的工作区 WIP 中(`chatMutationRef`)。**骨架占位缺失** | `git show HEAD:dialogue-web/src/components/ComposedReferenceGameApp.tsx`(无 `chatMutationRef`);工作区 diff 含 guard;chat-surface-mutations.spec.ts | **Finding F1**(守卫未提交)+ **Routed R1**(ComposedReferenceGameApp 合入守卫,精确形状见下)+ **Routed R3**(骨架占位,i18n 文案 + style.css 样式)。表现层 spec 已可运行 |
| 3 Voice | 麦克风绑定并反映后端连接/录音状态;unavailable 隐藏 | **wire 上没有录音/录制状态**:宿主契约 `TavernVoiceSurfaceStateV1Schema` 只有 `unavailable\|ready\|speaking`(`speaking`=播放);`unavailable` 的语义是"surface 存在但不可用",客户端**不隐藏**(渲染 MicOff 图标),`null`(无 surface)才不渲染。voice-gateway/ 已拆为 pi-koe submodule(desktop 的 VoiceGatewaySupervisor/VoiceLaunchCoordinator 管启动)。Composer.tsx 是只读窄投影(labels,非点击绑定) | host/src/tavern/browser-contract/index.ts:766-774;Composer.tsx:74-100;i18n.ts:11-13,423-425;chat-surface-voice.spec.ts(**绿**) | **Routed R4**(Host 侧:如需录音状态需新增契约字段 + gateway 上报)+ **Routed R5**(若 `unavailable` 应隐藏,需在 Composer 供应商侧干;但 wire 语义未定 → 上报裁定,不私自改) |
| 4 Memory 标签/过滤 | 玩家提交 vs 伴侣生成的标签区分与**状态切换(过滤器)** | `management-panels.tsx:920`/`:975` 已有**标签**(originPlayer/originCompanion + `data-memory-origin`),**无过滤器/切换** | management-panels.tsx:920,975;i18n.ts:126-127,536-537 | **Routed R6**:在 management-panels.tsx 的 MemoryPanel 加 origin 过滤器(精确锚点 L915 map 处)+ i18n.ts 文案(全部 not mine) |

## Routed requests(供 owner/visual lane)

- **R1(ComposedReferenceGameApp——shell lane)** `handleSwipe`/`handleRegenerate` 需要同步单飞 latch:加 `const chatMutationRef = useRef(false)`、`const [chatMutation, setChatMutation] = useState<{kind:"swipe"|"regenerate";handle:string}|null>(null)`;两 handler 开头 `if (chatMutationRef.current) return;` 后 `chatMutationRef.current = true; setChatMutation(Object.freeze({kind, handle}))`;`finally { chatMutationRef.current = false; setChatMutation(null); }`;渲染 `pending={chatMutation}` 传入 Timeline。行为已存在于工作区 WIP;关键是**提交它**。我的表现 spec(`chat-surface-mutations.spec.ts`)pin 住合入后的 frozen selectors。
- **R2(style.css——visual lane)** `.message-bubble em.message-action {}` — `*nods*` 斜体叙事样式(斜体或优雅差示)。当前无此规则,行为已就绪(`em.message-action` 由 DOMPurify hook 加)。参考:chat-surface-renderer.spec.ts:90 断言 `em.message-action` 存在;Liyuan 参考缺失(见证据),模式为"动作旁白区别于台词"的通用陪伴叙事惯例。
- **R3(骨架占位——visual lane + i18n)** 生成中/切卡中"骨架占位":需 i18n 新增文案键(如 `generatingPlaceholder`/`swipingPlaceholder`)+ style.css 的 placeholder 类。`i18n.ts` 与 `style.css` 都是 not mine。现有 `generating: "Thinking..."`(L10)可用作文案基础。
- **R4(Host 侧——voice)** 若要求录音/连接状态反映到 Composer 控件:`TavernVoiceSurfaceStateV1Schema`(host/src/tavern/browser-contract/index.ts:772-774)需新增状态(如 `recording`),且 voice-gateway/pi-koe 需上报录音生命周期。**不支持凭空造客户端形状**(项目规则)。目前 `ready` 只能做 PTT 语义,无按住录音。上报:此需求是"绑定录音状态"但 wire 无此状态。
- **R5(Composer——裁定)** `unavailable` 是否应隐藏 mic:`null`(无 voice surface)已隐藏;`unavailable` 语义为"surface 存在但不可用",渲染 MicOff 是有意的可读失败状态。如需"backend unavailable 隐藏",需改变 wire 语义或客户端策略 —— 待 owner 定,我不擅改。
- **R6(management-panels.tsx + i18n.ts——visual lane)** Memory 过滤器:在 `management-panels.tsx` 的 `MemoryPanel`(L915 `memoryView.rows.map` 上方)加一个筛选器(全部/玩家提交/伴侣生成),基于 `item.origin`(`"player"|"companion"`);文案键加进 `i18n.ts`(如 `memoryFilterAll`/`memoryFilterPlayer`/`memoryFilterCompanion`)。

## Finding F1(单飞守卫未提交)

`git show HEAD:dialogue-web/src/components/ComposedReferenceGameApp.tsx` 中 `handleSwipe`(约 L658)与 `handleRegenerate`(约 L676)的正文**没有 latch**:

```
const handleSwipe = async (messageHandle, direction) => {
  const current = viewRef.current;
  if (current.kind !== "ready") return;
  const selection = ...;
  if (selection === null) return;
  try { await selectSwipe(...); await reread(); } // ← 无 single-flight
```

双击会 mint 两个 idempotency key 并 admit 两个命令。守卫(`chatMutationRef`+`setChatMutation`)只存在于工作区未提交 diff(`M dialogue-web/src/components/ComposedReferenceGameApp.tsx`)。**这是 supervisor 要求的上报 finding**:守卫未提交,形状见 R1。

## 运行证据(counts)

| 门 | 结果 | 备注 |
|---|---|---|
| `tsc --project dialogue-web/tsconfig.json` | **0 errors** | |
| `npx playwright test tests/chat-surface-mutations.spec.ts`(新增) | **3 passed** | 我新增 |
| `npx playwright test tests/chat-surface-renderer/streaming/voice.spec.ts`(既有,probe 改动后回归) | **7 passed** | 上家要求的 probe 兼容 |
| `pnpm run test:unit`(dialogue-web) | **72 passed** | |
| `pnpm run test:artifact` | **1 failed**(manifest-boundary symlink,Windows reparse 环境差,与我的改动无关——见下) | |
| `pnpm run test:composed` | 未单独跑(见 mounted-composed) | |
| `pnpm run test:mounted-composed` | **43 passed, 1 skipped** | 上家引用的总数 |
| `pnpm check:dialogue-web-boundaries`(repo root) | **✔ no dependency violations(30 modules, 37 deps)** | |
| `node tools/check-head-typecheck.mjs` | **head_typecheck_ok rev=dd7f7da7a7ac** | |

**test:artifact 失败说明**:`tests/manifest-boundary.test.mjs:263` 期望 `verifyProductionArtifactManifest` 拒绝符号链接文件(匹配 `/symlink or reparse point/`),但该测试在 Windows 上创建 symlink 时 `EPERM/ENOTSUP` 被 catch 后 return(视为跳过),因此断言从未被求值的地方还是跑了并失败 —— 这是**环境性失败**,与我的任何改动无关(我只动 probe/spec)。git status 确认 `manifest-boundary.test.mjs` 未被我触碰。

## 我的改动文件
- `dialogue-web/tests/chat-surface-mutations.spec.ts`(新增,3 个表现层断言)
- `dialogue-web/tests/chat-surface-probe.tsx`(扩展:setPending/withSwipes/pendingAttrs,向后兼容既有 spec)

未改动任何 `src/components/*` 产品代码(四 item 的实质改动全部落在 not-mine 文件或 wire 缺失)。