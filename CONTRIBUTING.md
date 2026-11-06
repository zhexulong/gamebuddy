# 参与贡献

感谢你愿意参与 GameBuddy。

## 先读什么

1. [开发指南](guides/development.md) — 环境、构建、测试、live-run 与沙盒。
2. [AGENTS.md](AGENTS.md) — 项目规则：最小变更、删除优先、缺陷家族与门禁、证据纪律。
3. [玩家安装与首次运行](guides/player-install.md) — 了解玩家真实路径，改动前先知道它在产品里长什么样。

产品架构、ADR、领域规范与实施计划在独立的私有设计仓库（本地挂载为 `design/`）。公共仓库提交不要包含 `design/`。

## 提 PR 之前

- `pnpm quality:check` 通过；相关 live / sandbox 门禁有证据，或明确记录为 blocked。
- 新增断言先在真实注入的违规上看到失败（红），再修到通过（绿）。
- 变更只包含本次工作涉及的路径，不夹带其他 lane 的未提交内容。
- 不提交 API key、完整存档、私密角色卡内容或包含个人路径的运行日志。

## 缺陷与安全

- 可复现的问题请附：GameBuddy 版本、Windows 版本、Stardew/SMAPI 版本、界面错误文案与时间点。
- 安全相关的问题不要开公开 Issue 贴出利用细节或凭据；请通过 GitHub 的私密安全报告（Security → Report a vulnerability）联系维护者。

## 许可证

提交即表示你同意以本仓库的 AGPL-3.0 许可证发布你的贡献（角色预设内容按其目录下的授权说明）。
