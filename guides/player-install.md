# 玩家安装与首次运行

本文面向只想安装并游玩的玩家。开发环境、测试与 live-run 见 [开发指南](development.md)。

## 前置条件

- Windows 10 / 11（x64）
- 一份自己的《星露谷物语》1.6.x（Steam、GOG 或其他合法安装均可）
- 一个你想使用的模型 provider 账号与 API key（GameBuddy 不提供模型端点）
- 音频设备可选；语音目前是输出通道（角色说话），产品尚未接入麦克风输入。

安装包是 **per-user、自包含** 的：不需要预装 Node.js、.NET 运行时，也不需要克隆仓库。

## 安装

1. 运行 `GameBuddy.Setup.exe`。
2. 安装位置是当前用户目录（`%LOCALAPPDATA%\Programs\GameBuddy`），不需要管理员权限。
3. 安装器会创建桌面快捷方式，并写入当前用户的卸载注册项（显示在 Windows「设置 → 应用 → 已安装的应用」）。
4. 如果 GameBuddy 正在运行，安装器会拒绝覆盖；先完全退出再安装。

从源码构建预览安装包：

```bash
pnpm install
pnpm build
pnpm build:player-distribution
# desktop/dist/setup/GameBuddy.Setup.exe
```

干净机验收（Windows Sandbox，可选）：

```bash
pnpm run:sandbox-level3 -- --setup desktop/dist/setup/GameBuddy.Setup.exe
```

## 首次运行

### 1. 选择游戏安装

启动 GameBuddy，打开「游戏安装」：

- GameBuddy 会先尝试发现常见位置的 Stardew 安装；
- 找到多个时由你选择；
- 也可以直接指定包含 `Stardew Valley.exe` 的文件夹。

### 2. 安装模组加载器与伴侣 Mod

- 如果游戏目录还没有 SMAPI，界面会提供「帮我安装 SMAPI」：GameBuddy 复制它自带的加载器，不改动目录中的其他文件。
- 如果目录里已有别人安装的 SMAPI 文件，GameBuddy 不会强行覆盖；按提示清理冲突文件或换一个目录。
- 随后 GameBuddy 会把伴侣 Mod 部署到 `Mods/GameBuddy`。
- 如果 Steam 启动方式需要额外参数，界面会给出对应提示。

> GameBuddy 不会接管你的存档目录，也不会替你改写存档文件。

### 3. 接入模型

打开「设置 → 连接与模型」：

1. 选择 provider（渠道）与它提供的模型；
2. 填入你自己的 API key；
3. 保存并测试连接；
4. 测试通过后把它设为当前连接。

失败提示会区分几类原因：key 缺失/错误、模型不被该端点提供、Base URL 不可达、上下文超长等。按提示修改后重发即可。

### 4. 开始陪伴游玩

1. 按「与伙伴一起玩」。
2. GameBuddy 会启动游戏与会话运行时。
3. 如果存档里还没有可用位置，界面会让你选择一间小屋完成 AI Farmhand 的交接。
4. 载入你想玩的农场；面板会在游戏交接窗口后更新。

Chat 与 Game 是两个可以同时存在的表面：你可以在 Chat 里设定角色与共同目标，在 Game 里让它执行，二者互不接管对方的生命周期。绑定同一 continuity 时，它们共享同一份长期 Memory。

## 数据位置

| 内容 | 位置 |
| :--- | :--- |
| 程序文件 | `%LOCALAPPDATA%\Programs\GameBuddy` |
| 持久数据（continuity、Chat、Memory、会话记录） | `%LOCALAPPDATA%\GameBuddy\data` |
| 运行缓存 / 日志 | `%LOCALAPPDATA%\GameBuddy\operational` |
| 界面缓存 | `%LOCALAPPDATA%\GameBuddy\presentation` |
| 游戏本体与存档 | 你自己的 Stardew 安装与存档目录（GameBuddy 不接管） |
| API key | 由 Host 管理；不要写进角色卡、世界书或聊天内容 |

备份或迁移前，请先完全退出 GameBuddy，避免复制到写入中的状态。

## 卸载

任选其一：

- Windows「设置 → 应用 → 已安装的应用」中找到 GameBuddy 卸载；
- 运行 `%LOCALAPPDATA%\Programs\GameBuddy\uninstall\GameBuddy.Setup.exe`。

卸载会移除程序文件、桌面快捷方式、当前用户注册项，以及可再生的 `operational` / `presentation` 缓存。**持久数据目录 `data` 默认保留**；如果确定不再使用，可以用 `--uninstall --purge` 运行卸载器，或手动删除该目录。注意这会一并移除角色、Memory 与会话记录。

## 排障

| 现象 | 先做什么 |
| :--- | :--- |
| 找不到游戏 | 在「游戏安装」中手动选择包含 `Stardew Valley.exe` 的文件夹 |
| 提示缺少 SMAPI | 用「帮我安装 SMAPI」；或先自行安装 SMAPI 后重新查找 |
| `Mods` 目录不可写 | 关闭 Stardew 与所有模组管理器，检查目录权限后重试 |
| `Mods/GameBuddy` 属于其他 Mod | GameBuddy 不会覆盖别人的文件夹；先确认并移除冲突目录 |
| 连接测试失败 | 检查 provider、Base URL、模型 ID 与 key；提示会区分具体原因 |
| 游戏启动失败且提示需要重启 | 这次失败会让 GameBuddy 拒绝再次启动；完全退出 GameBuddy 后重开 |
| 停止结果“不确定” | 不要立刻重复停止；按界面提示重新读取权威游戏状态 |
| 长时间没有回复 | 会话可能仍在运行；先看状态与停止入口，不要重复发送同一请求 |

如果问题可以复现，请附上：GameBuddy 版本、Windows 版本、Stardew/SMAPI 版本、界面显示的错误文案与时间点。**不要附 API key、完整存档或私密角色卡内容。**

## 已知边界

- 正式支持的游戏只有 Stardew Valley 1.6.x + SMAPI 4.x，平台只有 Windows x64。
- 语音目前是输出通道：配置 TTS provider 后可以听角色说话并打断；麦克风输入（PTT / ASR）尚未接入产品界面。
- 签名公开发行通道仍在收敛；从源码构建的安装包属于预览产物，不用于分发。
