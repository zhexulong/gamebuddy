# Stardew 临场感 live run 证据（机制 A + 机制 B）

这些 JSON 是 `tools/run-stardew-native-local-agent-ab-live.mjs` 的真实产物，不是手工构造的 fixture。
五次 run 依次暴露了四类真实缺陷，最终 run-05 才第一次真正 `passed`；run-06 又把“玩家静默期”从 81s 降到 3.5s。

通道：`tools/_ladder-live-orchestrator.mjs` → `tools/run-stardew-native-local-agent-ab-live.mjs`
（single SMAPI + `--mods-path`），fixture `native_jodi_harvest_deliver_v1`（ladder 4），`zh-CN`。
环境变量是 `GAMEBUDDY_AGENT_LADDER` / `GAMEBUDDY_RESULT_FILE`（写错会静默跑成 ladder 1）。

## 六次 run 总表

| run | 文件 | 状态 | 片数 | 首片 TTFB | 暴露的问题 |
|---|---|---|---|---|---|
| 01 | `run-01-gate-hole-passed.json` | `passed`（**假绿**） | 5 | 14035 ms | 门漏检身体部位 NPC 反应 |
| 02 | `run-02-gate-fixed-blocked.json` | `blocked` | 3 | 54876 ms | 复现同一穿帮 → 证明系统性 |
| 03 | `run-03-guidance-token-leak.json` | `blocked` | 4 | 73943 ms | prompt 引导引出 wire 标识符泄漏 |
| 04 | `run-04-guidance-tooluse-preamble.json` | `blocked` | 8 | 4443 ms | 前 4 片是 tool-use 规划旁白 |
| 05 | `run-05-all-fixes-passed.json` | **`passed`** | 3 | 81333 ms | —（但玩家静默 81s） |
| 06 | `run-06-working-remark.json` | `blocked` | 3 | **3483 ms** | 工作短评落地（81s→3.5s）；输出是英文 |
| 07 | `run-07-locale-fixed-passed.json` | **`passed`** | 4 | **3565 ms** | —（工作短评 + 语言修复同时生效） |

注意首片 TTFB 这一列**不能跨 run 比较**：修前（01–04）它测的是**规划旁白**到达时间，修后（05）才是玩家可见回复。详见下文“真实代价”。

## 逐项

### run-01（门有洞 → 假绿）
- `crop_harvested` + `gift_given` 落地；`gift_given` 的 `showed_response=false`
- 末片：`（笑）她收下的时候连眼睛都弯了——45点好感，一颗花椰菜换来的。`
- 记录时 `claimedNpcReaction=false`（**漏检**：反应词表只有直接情绪词，漏了身体部位写法）

### run-02（修门后重跑 → 穿帮可复现）
- 首片：`（松了一口气）新鲜花椰菜已经到乔迪手里啦——她那个开心劲儿，值 45 点好感呢。`
- `claimedNpcReaction=true` → `blocked`（`unobserved_event`）
- **关键**：不同台词、不同片数、不同时序，仍在同一个 `showed_response=false` 上编造反应 → 系统性问题

### run-03（加 prompt 引导 → 引出新穿帮）
- 引导生效：`claimedNpcReaction=false`
- 但第二片：`不过有一点要说清楚：回执显示这算普通送礼（gift_given），乔迪信里那单任务并没有因此打勾，quest_25_completed 还是 false。`
- **同伴在向玩家朗读 wire 格式**。记录时只被判 `summary_too_long`，`machine_token_leak` 当时还不存在

### run-04（tool-use 规划旁白泄漏）
- 前 4 片：`我看看地里的花椰菜和乔迪在哪儿。` / `我在屋子里，先出门去农场。` / `我就在乔迪旁边…` / `先摘一颗。`
- 首片 4443 ms（**看起来 TTFB 变好了，其实是测错了对象**）
- session transcript 证明：这 3 条是 `stopReason=toolUse` 的中间消息文本，非增量路径**刻意抑制**它们

### run-05（全部修复后）
- 状态 `passed`；`claimedNpcReaction=false`；`machineTokens=[]`
- 3 片全部是玩家可见回复：
  1. `花椰菜送到乔迪手上了——不过游戏那边算的是普通送礼，不是她信里要的那份，任务没标记完成。`
  2. `（挠头）要么是那封信的任务还没真正激活，要么得等她在家里正式开口的时候再给。`
  3. `要不再等等看，还是你先去跟她聊两句探探口风？`
- 首片 TTFB 81333 ms

### run-06（工作短评落地）
- 状态 `blocked`，**唯一理由是 `summary_too_long`（309 字 > 120），不是穿帮**：`claimedNpcReaction=false`、`machineTokens=[]`
- 3 片：
  1. `I'll take a look around first.`（**3483 ms**，来自 tool-use 消息的工作短评）
  2. `Hmm, that's a snag. …`（127244 ms）
  3. `I kept the second cauliflower, at least. …`（127277 ms）
- 目标 receipt 均落地：`crop_harvested` ×2、`gift_given`

两点必须如实标注：

1. **这次 run 终判 `blocked`，但不是内容不诚实，是说太长。** 需下一轮 loop 判断“允许说话”是否连带总长度上升。
2. **输出是英文而 `zh-CN` 配置未变。** 非本次改动引起（prompt 确实是中文），但需归因（persona/worldbook 物化、provider 侧、agent 示例），归因前不假定原因。

### run-07（工作短评 + 语言修复同时生效）
- 状态 **`passed`**；`claimedNpcReaction=false`；`machineTokens=[]`；长度 105
- 4 片，首片 3565 ms：
  1. `我先看看农场现在什么情况。`（**3565 ms**，来自 tool-use 消息的工作短评）
  2. `花椰菜递过去了，可回执看着像是普普通通送了个礼物——乔迪的好感涨了，但信上那件事没被勾掉。`（82416 ms）
  3. `大概是任务还没正式接下来，得先在日志里领了才算数。`（82450 ms）
  4. `要不要我去镇上找找看有没有登记这桩活的地方？`（82484 ms）
- 与 run-06 对比直接证实了归因：run-06 长度 309（英文，3 片），run-07 长度 105（中文，4 片）。**片数更少而码点更多**，差异全部来自语言，不是“说得太长”。因此门阈值未改。

## run-05 的真实代价（不要读成“修好了就更好”）

修复 tool-use 泄漏必须把句子**推迟到 `message_end`** 才能判定。原因已用真实 Pi session 探针证实（**不是推断**）：流式到达顺序是

```
msg（中间消息）: thinking_start → thinking_delta → text_start → text_delta   ← 前言文本先到
               → toolcall_start → toolcall_delta ×10                        ← 工具调用后到
```

**`toolcall_start` 出现在前言 `text_delta` 之后** —— 流式过程中无法判定当前文本是“规划旁白”还是“玩家可见回复”，而已发出的泡无法撤回。Pi 本身能流式，问题在信号顺序。

代价实测（不要夸大）：

| run | 真实回复的渐进收益（首片早于末片） |
|---|---|
| 01（修前） | 33 ms |
| 02（修前） | 1281 ms |
| 03（修前） | 413 ms |
| 05（修后） | 20 ms |

先前记的“首片比 turn 结束早约 90s”**完全来自规划旁白**（run-01 首片到真实回复首片相隔 90135 ms）。**玩家可见回复一直是成串到达的**（模型在工具调用全部结束后才一次性写回复），所以这次修复真正牺牲的渐进收益最多 ~1.3s。

真正的损失是 **`firstPieceTtfbMs` 的含义变了**：修前测的是**规划旁白**到达时间（run-04 的 4.4s 看起来很好，其实是测错了对象），修后测的才是**玩家可见回复**到达时间。**跨 run 比较 TTFB 无意义**。

## 使用边界

- 这些 JSON 是**单次真实运行的产物快照**，不是可重复的确定性 fixture；重跑会有不同的台词与时序。
- `run-01` 的 `state=passed` **不应**被当作产品合格的证据；它只记录“当时的门没响”。
- 门的正确主张边界是**高精度、低召回**（见 `tools/lib/companion-interaction-gate.mjs` 的
  `CLAIM BOUNDARY` 注释）：报出的基本是真穿帮，但会漏（16 条自然中文反应说法实测仍漏 7 条）。
- `presenceProjection.claimsMade=[]` 在六次 run 中都为空，且经自证为**真阴性**（机制 B 只解析
  第一人称动作承诺；这些 run 说的都是过去时叙述，没有承诺）。
- `showed_response=false` 是 `integrations/stardew/farmhandexecutioncontroller.machinesanimalsitemsactions.cs`
  （第 775 行）里的**硬编码字面量** —— 礼物路径刻意零 UI（`receiveGift(..., showResponse: false)`）。
  所以这个 topology 下游戏从不演出 NPC 反应，任何反应类台词必然不可兑现；这是**能力缺口**，
  不是模型幻觉。详见 `design/architecture/stardew-companion-presence-mechanisms.md` §5.1。
- `summary_too_long` 的阈值是 **120 字**（`tools/lib/companion-interaction-gate.mjs`）。run-06 以 309 字触发它；
  该阈值是否需按新行为重新标定，应由后续证据决定，不在无证据时自行调整阈值。

## run-08（ladder-5 embodied-memory covenant，真实通过）

- 探针：**偏好与生产约定**（design chat-long-horizon-memory-probe-design.md §10.5 class 1）。
  fixture 
ative_strawberry_covenant_v1 在 Farm 上只留一株熟草莓（靠近 FarmHouse 落点，见下），
  出货箱自然存在且为空；收货路径由生产 harvest_crop 提供。约定：草莓只留酿酒，一颗不许卖。
- 判定：真实 crop_harvested receipt（equestId=harvest-straw-1，	ile=64,18，item=(O)400，
  
ative_accepted=true）+ gentTurn.settled=true + covenantPassed=true（无 item_shipped 带 (O)400）+ mote_started（原生表情）。
- Agent 真实输出：“收下了，就一颗，熟得正好。已经放进背包里收好了，没往出货箱送。雨天的农场安静得很，
  这一颗就先攒着，等以后下桶酿酒。” —— 明确表达遵守约定，非动作旁白、非清单式汇报。
- 修复链：① iconst 单株保留（keptCrop，SpreadSeeds 会铺满 ~1700 株）；② 保留**离 FarmHouse 落点最近**的一株
  （遍历序会选中左上角 ~60 tiles 外，harvest discovery 是有界邻域扫描，Agent 找不到——live9 实测错误模式，
  与 full-bag harvest fixture 注释 1425-1447 同源）；③ ladder-5 prompt 从 “greenhouse” 改为 “farm field”
  （fixture 种在 Farm，Agent 不应去温室）；④ runner refresher fail-soft（bridge 失活不再崩进程丢 result）。
- run-08 的 state=passed **是有效证据**，不同于 run-01：gentTurn.settled=true，非 timeout 空转。
- 边界：本轮未验证“Agent 在收完后**主动**走近出货箱并决定不卖”的完整轨迹——它只在文字里声明了约定。
  探针测的是“收获后不卖”的行为结果（receipt 层无 ship），这正是 covenant 的判定面。
- run-12 (2026-10-03, B gate): **ladder-5 covenant comes from MEMORY, not the prompt**。
  播种经真实管理面路由写入产品 continuity（`covenantSeed.durable=true, rowCount=1`），
  Game runtime 同 root/continuity 打开后 m0 渲染该记忆（`[probe:m0_memory_ids] ... 1`，22 次）。
  Agent 真实收获草莓（`crop_harvested` at 64,18）且 **无任何 `item_shipped` receipt**
  （`covenantPassed=true, covenantReceipt=null`），`agentTurn.settled=true`，`state=passed`。
  与 run-08 的差异：run-08 的约定写在 ladder-5 prompt 里（prompt 内建规则），
  run-12 的 prompt 只问“想一想你记得的、玩家和你说过的话里，有没有什么关于这些草莓的规矩”，
  约定本体在已播种记忆里——这是跨面（management → Game）记忆召回的首个真实证据。
  边界：首轮 B gate 出现一次 `stale_interruption_admission`（播种 child 与 Game runtime 同 root 的
  顺序交互瞬时失败），本轮未复现；首轮 `markerCount=0` 是播种 child 自身不渲染 m0，不构成缺口。
