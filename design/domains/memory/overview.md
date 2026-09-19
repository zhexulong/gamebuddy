---
id: DOMAIN-MEMORY
type: domain
status: current
owner: memory
---

# Memory

## 目标

Memory 为玩家和 Companion 提供跨对话、按 continuity identity 隔离的长期语义记忆。它不是 Chat transcript，也不保存 Game live world、credential、raw audio 或 Pi 内部状态。

## 唯一权威

生产只使用 fresh semantic SQLite。旧 JSON authority、迁移/adoption、dual read/write、fallback 和 read-repair 不进入生产。

Magic Context extension 拥有数据库访问。Host 通过 manifest identity 绑定的 typed facade 读取或修改 Memory，不直接导入 SQLite schema、路径或 driver。

## 玩家操作

玩家可以读取、创建、编辑和归档/删除自己的 Memory。Mutation 使用当前 opaque projection handle/revision 处理冲突；成功后立即安全 reread。浏览器不接收 CAS token、source reference、provider binding、Pi session、文件路径或内部 correlation。

Memory mutation 是普通应用操作，不等待未来 provider round、source marker、nonce、receipt 或 attestation。

普通玩家 Memory CRUD 的身份/分区绑定由 `continuityId + profileId + profileRevision` 完成；不依赖 profile canonical hash 作为 CRUD 绑定条件（2026-09-16 owner 决议，见 active task `chat-tavern-context-engine-decoupling` D-02）。profile/source/materialization/recovery 的 canonical hash 仍由各自 owner 在需要精确内容一致性（source validation、materialization、recovery）的路径强制，不受此条影响。

## 跨界面共享

Chat 与 Game 只有在 manifest 明确绑定同一 continuity、player 和 companion identity 时共享语义 Memory。它们仍保持独立 raw history、surface lifecycle 和运行状态。