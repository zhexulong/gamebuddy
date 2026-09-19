---
id: AUDIT-CODEBASE-RELEASE-2026-09
type: architecture-audit
status: draft
owner: architecture
reviewed: 2026-09-18
---

# 2026-09 Release 代码库审查记录

> 本文记录一次 checkout 的事实，不是研究、架构意图权威，也不授予清理、重构或发布权限。数量和命令结果需要在新的 checkout 重新核验。

## 结论

审查时 checkout 不具备可信的 release candidate 条件：工作树包含大量 WIP 和临时产物，`check:knip` 与 `check:text-hygiene` 失败，质量入口、测试入口和 release workflow 的证据边界存在漂移。

这不是“删除所有看起来多余的代码”的授权。任何清理必须先确认消费者、provenance、运行状态和回退锚点，并遵守[架构治理与反腐化政策](architecture-governance-and-anti-erosion.md)以及[代码库整洁度处置文档](codebase-hygiene-and-simplification.md)。

## 证据

### 工作树

审查时 `git status --short --branch` 显示约 145 个 tracked 文件修改及大量未跟踪文件，包括 `.dist-backup-before-rebuild/`、`.runtime-fixture-node/`、根目录诊断脚本、`host/src/live-run/`、测试输出和 WIP diff。该状态不能直接代表可发布源代码。

禁止以本报告为理由执行无边界 `git clean`、`reset`、`stash` 或覆盖主 checkout 的 WIP。

### 已执行命令

| 命令 | 结果 | 含义 |
| --- | --- | --- |
| `pnpm check:host-module-graph` | 通过 | 当前 error 级循环依赖未发现；两类方向规则仍为 `warn` |
| `pnpm check:knip` | 失败 | 7 unused files、1 unlisted binary、1 unresolved import、26 unused exports、26 unused exported types |
| `pnpm check:publint` | 退出 0 | 当前 vendor gap 被放行；脚本对未知非 JSON 输出和 `status === null` 存在待修复的失败语义风险 |
| `pnpm check:text-hygiene` | 失败 | 临时产物、缺少 final newline、trailing whitespace、BOM、mixed EOL 等 |
| `git diff --check` | 通过 | 仅说明当前 diff 空白检查通过，不证明工作树或发布内容干净 |

### 入口漂移

`package.json` 的 `quality:check` 没有聚合 Knip、module graph、publint、clone、dependency audit 以及全部 workspace 测试；CI 在 `.github/workflows/ci.yml` 中直接执行另一组命令。root `test`/`test:all` 也没有覆盖所有 workspace。

`jscpd.json` 设置 `exitCode: 0`，所以 `check:clones` 当前是报告型检查而非阻断型检查。命令名、文档和实际失败语义需要 owner 决定后统一。

`.github/workflows/release-windows.yml` 没有在 YAML 内验证同一 commit 的普通 CI required checks；是否由仓库外 tag protection 或环境审批保证，尚未在本次 checkout 中得到证据。

## 处置顺序

1. 从当前 WIP 建立单独、可回退的 release candidate；不覆盖主 checkout。
2. 对未跟踪文件逐项确认 source、生成物、scratch、运行状态或未知项。
3. 在真实 consumer 审计后收敛 Knip findings；禁止 broad ignore、baseline、`--no-exit-code` 和自动删除。
4. 先修复 text hygiene 的输入边界，再处理应提交源码的格式问题。
5. 修复 publint 的 fail-closed 语义，并明确 CI、workspace test、release 的唯一入口。
6. 对每个架构重构另建 owner task；不以本审查记录授权目录重排、ModEntry 拆分或历史 topology 删除。

## 未决 owner 决策

- 是否把 Host 方向规则提升为 error，或改名为 audit；
- 是否让 clone 检查阻断发布；
- release workflow 如何证明同一 commit 的 required CI；
- `integrations/stardew/action-development` 和各类 fixture/script 的实际消费者与退役边界；
- root quality/test 命令的正式职责。
