# Windows Sandbox 文件总线：已确证的事实与未解之处

记录时间：2026-10-30。本文件只写**有实测证据**的内容，区分“已确证”“未确证”“被推翻”。

## 0. 结论先行：根因是挂载竞态，不是平台不可控

`LogonCommand` 在 winlogon 登录完成的瞬间派发，而 `MappedFolders` 由独立驱动**异步挂载**。
两者之间可能相差**约 158 秒**。命令如果一开始就访问共享目录，会因路径不存在**立即静默失败**，
连第一行输出都不会产生。

**修复方向**：`LogonCommand` 必须先把“共享目录可用”当作一个待等待的条件，而不是一个既定事实。

## 1. 已确证

### 1.1 沙箱可以由程序启动
`Start-Process WindowsSandbox.exe <wsb>` 能拉起实例；`WindowsSandboxServer`、
`WindowsSandboxRemoteSession`、`vmwp`、`vmmemWindowsSandbox` 出现，guest 内存涨到 ~4GB。
**不需要人工拖 `.wsb`。**

### 1.2 映射目录 + LogonCommand 通路本身正确
`C:\gamebuddy-cbus2\last.wsb` 于 07:27:29 写入，`guest-marker.txt` 于 07:27:52 出现
（23 秒后，内容 `guest-ran`）。这是一次真实的 guest → host 回写。

### 1.3 挂载竞态：命令比挂载早约 158 秒
`probe-mount-race.ps1` round 3：LogonCommand 轮询 `if exist C:\share` 共 158 次（≈1s/次）
后才成功写入，产出 `mount-ready-at-tick-158`。

这就是此前所有“静默失败”的解释：`cmd /c "echo x > C:\share\f.txt"` 在 `C:\share` 不存在时
立即以“系统找不到指定的路径”退出，**不产生任何宿主可见的痕迹**——包括连 breadcrumb 都没有。

### 1.4 轮询等待可以救回部分轮次，但不是每次都行
同一探针 3 轮（`probe-mount-race.ps1`）：`False / False / True(22s, tick-158)`。等待窗口够长时能成功，
但失败轮说明**有时候挂载在 150s 内根本不发生**。

### 1.4b 完整的“等待挂载再启动 worker”版本仍然失败
`run-bus-session.ps1`（logon command 先用 `for /L` + `if exist C:\bus\guest-worker.ps1` 轮询最长
900 次≈900s，再启动 worker；worker 自己再等一次挂载）实测：**902 秒后仍无 ready 文件**。
同时确认该轮沙箱窗口可见、`WindowsSandboxRemoteSession` 在运行（`C:\gb-bus-v2\bus.wsb`）。
即：等待挂载是必要的，但**不充分**。

### 1.5 `vmwp` 数量与成败无稳定关系
| round | vmwpBefore | mounted |
|---|---|---|
| 1 | 1 | 否 |
| 2 | 2 | 否 |
| 3 | 2 | 是 |
此前 `vmwpBefore=0` 的预等待实验也失败过，所以“`vmwp=0` 是充分条件”**已被推翻**。

### 1.6 盘符不是原因
总线放 `C:\gamebuddy-cbus` 与放 `E:\...` 结果相同。

## 2. 被推翻的假设

| 假设 | 推翻证据 |
|---|---|
| worker 没被复制进共享目录 | 复制后仍无 ready；连 cmd 的 `breadcrumb.txt` 也没出现 |
| 盘符（E: 不被映射） | C: 盘同样失败 |
| `LogonCommand` 引号形式 | 成功那次用的就是该形式，之后同样形式失败 |
| `&amp;` / powershell 调用不被允许 | 对照实验显示与命令形状无关，只与“第几轮”相关 |
| 会话池耗尽 | 等到 `vmwp=0` 仍失败 |
| 等待时间不足 | 最长 301s + 392s 预等待，仍失败 |
| `vmwp=0` 是启动的充分条件 | 预等待到 `vmwp=0`（392s）后启动，guest 仍无产出 |

## 3. 对产品的直接影响

1. `guest-worker.ps1` 必须先轮询等待 `C:\gamebuddy-bus` 出现，再写 ready 文件；
2. 宿主侧不能把“没有 ready 文件”当成“worker 崩了”，那是**挂载还没到**的信号之一；
3. 需要给挂载一个足够长的等待预算（实测出现过 ~158s），并在超时后报**明确原因**而非静默。

## 4. 与沙箱可靠性无关、已落地的成果

- `tools/sandbox/sandbox-verify.cmd`：18 项产品断言；判定规则由
  `tools/sandbox/prove-verdict-rule.ps1` 证明（绿→pass、注入违规→fail 并指名、空转录→不空过）。
- `tools/sandbox/install-round-trip.ps1`：宿主机安装→卸载全链路，实测 6/6 通过。
- `tools/sandbox/run-sandbox-acceptance.mjs`：宿主机驱动，实测 PASS（18 项）。
- `tools/sandbox/guest-worker.ps1`：guest 侧执行器（认领用改名防重复执行，结果原子写）。
- `tools/sandbox/sandbox-bus.mjs`：宿主侧总线（启动/发送/收集/关闭）。
- `tools/sandbox/probe-mount-race.ps1`：本文件 1.3 的证据来源。
