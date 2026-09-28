# Stardew 临场感 live run 证据（机制 A + 机制 B）

这些 JSON 是 `tools/run-stardew-native-local-agent-ab-live.mjs` 的真实产物，不是手工构造的 fixture。
五次 run 依次暴露了四类真实缺陷，最终 run-05 才第一次真正 `passed`。

通道：`tools/_ladder-live-orchestrator.mjs` → `tools/run-stardew-native-local-agent-ab-live.mjs`
（single SMAPI + `--mods-path`），fixture `native_jodi_harvest_deliver_v1`（ladder 4），`zh-CN`。
环境变量是 `GAMEBUDDY_AGENT_LADDER` / `GAMEBUDDY_RESULT_FILE`（写错会静默跑成 ladder 1）。

## 五次 run 总表

| run | 文件 | 状态 | 片数 | 首片 TTFB | 暴露的问题 |
|---|---|---|---|---|---|
| 01 | `run-01-gate-hole-passed.json` | `passed`（**假绿**） | 5 | 14035 ms | 门漏检身体部位 NPC 反应 |
| 02 | `run-02-gate-fixed-blocked.json` | `blocked` | 3 | 54876 ms | 复现同一穿帮 → 证明系统性 |
| 03 | `run-03-guidance-token-leak.json` | `blocked` | 4 | 73943 ms | prompt 引导引出 wire 标识符泄漏 |
| 04 | `run-04-guidance-tooluse-preamble.json` | `blocked` | 8 | 4443 ms | 前 4 片是 tool-use 规划旁白 |
| 05 | `run-05-all-fixes-passed.json` | **`passed`** | 3 | 81333 ms | — |

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
- `presenceProjection.claimsMade=[]` 在五次 run 中都为空，且经自证为**真阴性**（机制 B 只解析
  第一人称动作承诺；这些 run 说的都是过去时叙述，没有承诺）。
- `showed_response=false` 是 `integrations/stardew/farmhandexecutioncontroller.machinesanimalsitemsactions.cs`
  （第 775 行）里的**硬编码字面量** —— 礼物路径刻意零 UI（`receiveGift(..., showResponse: false)`）。
  所以这个 topology 下游戏从不演出 NPC 反应，任何反应类台词必然不可兑现；这是**能力缺口**，
  不是模型幻觉。详见 `design/architecture/stardew-companion-presence-mechanisms.md` §5.1。
