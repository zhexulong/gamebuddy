---
id: ARCH-SECURITY-TRUST-BOUNDARIES
type: architecture
status: current
owner: security
---

# 安全与信任边界

## 不可信边界

本机 bridge、Host 请求、模型文本、浏览器输入、fixture 和测试 runner 都不能单独证明 action 获得授权或成功。游戏线程在 mutation 前重新检查 scope、player policy、catalog revision、deadline、idempotency、取消标识和实时游戏前置条件。

## 禁止路径

AI 游戏路径禁止：

- UI reading、视觉识别或屏幕状态作为权威；
- keyboard、mouse、XInput 或 raw input injection；
- raw dispatcher 和任意 native-call fallback；
- 直接集合写入绕过游戏原生安全检查；
- Host、fixture 或测试扩大 Mod 发布的 capability。

## 幂等与不确定结果

产生副作用前必须持久记录执行 identity 和状态。发生“可能已产生副作用但未确认”的异常时，返回 uncertain 并禁止自动 replay。表达发送同样遵循 durable terminal/uncertain receipt，避免重复发送。

## Provisioning 与 publication

只有 manifest、advertisement、response、fixture 和必要持久化都成功时才能投影 ready。任何写入、删除、清理或持久化失败都进入 terminal quarantine，不继续接受请求，也不伪造撤销成功。

## 验收边界

真实 mutation 前先完成静态 preflight、协议/schema 检查和一次聚合式独立 review，再执行唯一 target-version live mutation gate。Harness 缺陷先离线修复并保留失败记录，不通过重复 mutation 补证据。

## 本机角色生存与恢复边界

按 [Game session survival simplification](../tasks/active/game-session-survival-and-reconnect-simplification.md)，同一 Windows user 下的恶意软件不属于本任务 threat model；仍保留 accidental stale controller、execution conflict、secret 泄露和跨 session 混淆防护。安装/update integrity、selected-version startup、session-instance connection 与 action-precondition checks 不变。Player Host 的 role containment policy 不得使用 `KILL_ON_JOB_CLOSE` 使普通 GameBuddy close 或 Guardian last-handle close 间接结束玩家世界；AI role 可继续使用 kill-on-close。explicit endgame 独立完成 Player cleanup。

Resume 的安全前置不是“找到一个可连接的游戏进程”，而是验证所选 Game session 的登记 world binding。Resume 只可使用该 binding 指向的 GameBuddy-owned 入口，并由选定 Game integration 完成足以确认实例归属的最小 attachment handshake 与 world observation；如果 integration 已有 hello/authentication，可在同一边界复用，但不得为了 Resume 另造证明层。不得扫描窗口、PID、路径或启动时间，也不得把用户外部启动的同类游戏当作 Resume 候选。Start new game 只能在前端明确选择后创建新的 session/world binding；continuity identity 只决定是否共享受治理的长期 Memory，不扩大 world 或 action authority。

## 最小验证预算

验证不是独立的“安全证明层”，而是为一个具体错误决定提供事实。新增或保留一项检查时，owner 必须能够回答它防止的事故、它读取的权威来源以及它在哪个边界运行；不能回答时不添加该检查。

| 检查 | 必须防止的事故 | 运行边界 | 不应做的事 |
|---|---|---|---|
| integration/session/world binding | Resume 误连用户外部游戏或另一个 Game session | 创建和 Resume 的 Game integration 边界 | 不扫描进程，不用 PID、路径、标题或启动时间猜测 |
| hello/attachment | 把未登记实例当成当前 Game world | 建立 bridge/attachment 时一次 | 不在每个普通消息上重复发行物证明 |
| install/update/selected generation | 执行错误或被破坏的 GameBuddy 发行物 | 安装、更新、选定版本启动 | 不把发行物 hash/signature 传播到 session、action 或 browser |
| action admission | 错 scope、旧 policy/revision、过期或重复的 native mutation | 每次可能产生副作用的 action，且由游戏线程作最终检查 | 不用通用 generation/proof 替代 action 前置条件 |
| receipt/postcondition | 把 transport success 当作游戏成功，或重放未知副作用 | action terminal 与 fresh world readback | 不为恢复旧内存对象增加失效探查 |
| durable transaction/CAS | 并发写入或未知副作用造成重复 durable mutation | 确有并发/重试/不确定结果的持久化 owner | 不把 CAS 当成所有内存状态的通用生命周期仪式 |
| OS containment | Guardian/controller 退出时错误杀死 Player，或 role 失去必要的进程归属 | 进程创建、Job 归属和明确 teardown | 不用额外 hash、signature 或跨层 proof 重复证明 OS 已执行的结果 |

正常 close、断线或 activation 结束后，callback、连接和内存 capability 随其 owner 一起不可用；产品不需要逐项探查或记录它们“已经失效”。只有仍可能被新的进程/请求读取的持久化事实、跨进程边界或会改变业务决定的 live world facts 才需要重新读取。generation、fingerprint、proof、CAS 或多层 attestation 只有在对应 owner 能指出独立事故时才可存在；同一事实已由更低成本的 session binding、OS ownership、事务或 action admission 覆盖时，应删除重复层。