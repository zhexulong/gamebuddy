# 28 Tavern Management Capability Matrix

> **Status:** implementation authority for the next Tavern profile revision. It supersedes the v1 UI-only restriction in `26_TAVERN_FRONTEND_DESIGN_SPEC.md` that kept Connection and player-facing chat settings out of the product. It does **not** authorize arbitrary code execution, raw prompt injection, or browser-visible secrets. Fresh semantic continuity S0–S5 is mounted as an engineering foundation, but S6 and all Tavern/UI/live release gates remain pending; current production legacy Tavern fallbacks are deletion work, not supported compatibility.

## 1. Product decision

GameBuddy Tavern is a character-chat product, not merely a loopback chat viewer. A player must be able to manage the connection that powers their own Tavern, choose an approved player-facing model, configure released chat behavior, and manage their roleplay library from the UI.

The UI must use real Host routes with durable, observable outcomes. A button must never write only React state, pretend an external credential has changed, or expose an internal identifier as a player result.

The first management profile is **curated-provider**, not arbitrary-provider:

- the Host owns the supported provider catalog and model catalog;
- the browser can select only a catalog entry permitted for the player-facing dialogue role;
- credentials are submitted only to the authenticated loopback Host and are stored by a Host-owned credential vault;
- credentials, raw provider errors, API base URLs, prompt text, Pi config, tools, Magic Context internals and Game permissions never appear in bootstrap payloads, exports, browser storage, evidence records, or normal UI notices;

This deliberately does not reproduce SillyTavern's arbitrary endpoint, extension, script, regex, macro, prompt-manager, or tool-configuration surfaces.

## 2. Complete Tavern chat baseline

The following is the minimum player-complete baseline for GameBuddy Tavern. It is deliberately broader than a read-only roleplay viewer, but narrower than a scriptable automation console. A feature counts only when its durable Host contract, player projection, error/recovery path, and UI operation all exist.

| Domain | First released player lifecycle | Required integrity and recovery behavior |
|---|---|---|
| Connection and model | View active connection, set up an approved connection, test, save, select an approved model/response setting, activate, remove inactive saved connection | Keys remain write-only; failed test never activates; activating while a reply is running is rejected; successful activation preserves exact chat, draft, transcript and chat background. |
| Character | Browse, create, view safe profile, reviewed card import, export, and only the versioned retention/lifecycle operations explicitly owned by its Character contract | No invisible activation/hot swap; create/import returns a durable player-readable result; unsupported card content is shown as not included and never run. No generic delete claim is inferred from Chat lifecycle. |
| Persona / scenario / opening | Browse, create/edit, save/read-back, select for a new chat | Authored content stays verbatim across UI-locale changes; changing it never rewrites an existing chat. |
| World Info | Browse, create/edit safe public background, bind/unbind an exact chat, export | Binding status derives from the exact active chat; conflict/locked states retain displayed chat content and offer the real next action. |
| Chat lifecycle | List/search, create, open, rename, export, archive, move to trash, restore; retain unsent draft safely | Opening is atomic; failure retains old transcript; lifecycle action is confirmed and cannot target another chat; browser Back closes panels before discarding any form/draft. V1 has no permanent delete. |
| Message lifecycle | Compose/send, queued/generating state, stop, reconnect, retry only where a published operation is eligible | Duplicate submits are idempotent; failure before durable acceptance preserves draft text and transcript; after durable acceptance a provider/presentation failure does not resurrect accepted text as a draft; stale SSE events cannot replace a newer thread; no fabricated companion message. |
| Import/export | Stage card or supported document, review player-readable disposition, select eligible details, confirm, export loss report | No script, regex, HTML, macro, extension, prompt, tool or raw runtime data is executed/exported. |
| Preferences | UI language plus only explicit player-facing chat preferences | UI language changes chrome only; preferences persist without storing conversation content or credentials in browser storage. |
| Game companion | View live game connection/surface state, selected game-facing model profile, published capabilities, current execution and recent authoritative outcome; invoke only separately released independent Game lifecycle operations when their Host workflow is available | Every game fact carries its current scope/revision; unavailable, stale, denied and recovery-required states remain explicit. A visible result is never inferred from companion text, an old receipt or a UI action. Game lifecycle never records a Chat origin or selects/restores Chat. |

Out of scope means absent rather than disabled. The baseline excludes arbitrary code or remote endpoint execution, hidden-prompt editing, tool/Game-permission configuration, HTML/regex/macros/extensions, group orchestration, visual-novel layout, branching/swiping/editing/regeneration until each has its own typed contract, and operational diagnostics.

### 2.1 审计后的实现状态

本表记录当前工作树事实，不是路线图，也不把已存在的 Host seam 当成已发布的玩家工作流。状态含义如下：

- **当前可用、非最终发布的产品流（partial）**：玩家可从当前 Tavern UI 走完所列的窄路径，并获得 Host 的真实持久读回；这仍不等于本节完整 lifecycle 或最终 release 已发布。
- **Host-only seam（partial）**：存在版本化 Host contract、路由或持久实现，但尚未构成完整、可发布的玩家管理工作流；不得以该 seam 宣称功能完整。
- **missing / unavailable**：没有该玩家工作流，或当前 UI/Host 只可显示不可执行的事实投影。

| Domain | 审计状态 | 当前实际可用内容 | 精确限制与完整性阻塞项 |
|---|---|---|---|
| Connection and model | **missing** | Host 以 operator-established dialogue configuration 启动；DeepSeek V4 Flash 是已测试默认值。 | 没有玩家安全的 connection/model catalog、write-only credential vault、test/save/activate/remove、持久选择或对应管理 UI。不得把下方未来 connection contract 说成已实现。 |
| Character | **partial（当前可用、非最终发布的产品流）** | UI 可列出角色、直接创建、打开安全详情；已审核 ST Card 可作 inert review/confirm 导入，并有安全导出。 | 没有角色更新、版本化 retention lifecycle/confirmation、玩家可见的 activation/switch lifecycle；safe detail 只显示已批准的安全资料，不能推断 card/runtime 全量详情。 |
| Persona | **partial（当前可用、非最终发布的产品流）** | 单一玩家 Persona 支持首次 create、持久 read-back，并可在 New Chat 中作为精确选择使用。 | 没有 list、多 Persona、edit/update、delete 或完整 revision-management lifecycle。 |
| Scenario / Greeting | **partial（当前可用、非最终发布的产品流）** | Scenario 与 Greeting Set 各支持首次 create、持久 read-back；New Chat 可选择 Scenario，并以 First/alternate Greeting 创建真实 message 0。 | 没有 list、多记录、edit/update、delete 或既有 chat 中重放/替换 opening 的工作流。 |
| World Info | **partial（当前可用、非最终发布的产品流）** | UI 可列出 managed World Info，create、edit、读取绑定，并对精确 pristine chat attach/remove；既有安全 catalog/bind/unbind 与 export 仍存在。 | 绑定在 chat 活动后按设计锁定；UI 只给出当前可用/锁定结果，尚没有完整 conflict/recovery lifecycle、通用 World Info import 或完整 library/version management。 |
| Chat lifecycle | **partial（当前可用、非最终发布的产品流 + Host-only archive seam）** | UI 可 durable create/list/open/reopen/export；玩家可读、可改 title；草稿由 Host 持久 read/save/discard，切换 chat 前会保存。接受前发送失败保留草稿；durable acceptance 后的 provider 失败不复活已接受文本。 | title 与 draft 仅是已选版本化 profile 的窄 contract。当前 archive 是 Host-only seam；candidate-only 或 UI archive/trash/restore promotion 必须等待 fresh semantic SQLite single-authority foundation 的生产 mount 与证据。没有 search、archive/trash/restore 的完整 UI lifecycle 或 confirmation；v1 无 permanent delete，且不得将该 seam、test-only store 或设计合同宣称为完整 chat management 或 release-level semantic proof。 |
| Message lifecycle | **partial** | Send、stop、SSE presentation、basic reconnect 与受控 draft clear 均存在；重复提交受客户端和 Host request handling 保护。 | 尚未发布完整 per-thread SSE replay/recovery、pending-send recovery 与 retry projection；不能将 basic reconnect 表述为完整消息恢复。 |
| Import / export | **partial（当前可用、非最终发布的产品流）** | ST Card 走 staged inert review、字段选择、确认新角色；受支持的 interchange/chat/World Info 可安全导出。 | 没有 import history 或玩家可读 loss-report export；非 card/document 格式仍刻意狭窄，任何 script、regex、HTML、macro、extension、preset 均不会执行。 |
| Preferences | **partial** | 英语/简体中文 UI preference 会持久化，且不改写 authored content。 | 没有 Host-owned 完整 player preference record，也没有已发布的 chat-behavior preference management。 |
| Model profiles | **Host-only seam / read-only** | `/settings/profiles` 向 UI 投影分离的 Chat 与 Game profile 的安全事实。 | 这是只读投影，不提供 catalog、credential、model selection、activate 或任何 profile mutation；它不是 Connection 或 Game profile management workflow。 |
| Game status and workflow | **unavailable（仅 Host-only read-only projection）** | `/game/status` 和 Game panel 只显示 Host 当前 lifecycle state 的安全投影（标签、freshness、published capability count、active execution category、latest authoritative receipt category）。 | 没有已发布的 Tavern Game enter/close/recover/reconnect/stop workflow，也没有从 Tavern 配置 Game model 或执行 Game action 的管理流；不存在 return-to-Chat workflow。投影不授予 capability、scope、revision、permission 或成功结论；Game unavailable/stale/denied/recovery-required 仍只能如实显示。 |

当前 v1 compatibility profile 因而只能描述为 **Tavern compatibility baseline**，不是完整 Tavern 产品，也不是 Game workflow release。任何 management profile 只有在满足前表的全部 lifecycle 与 integrity 要求，并通过最终 Tavern release prerequisite 后，才可把相应行标为 `complete`。当前 release-prerequisite checker 具有 `magic_context_stable_source` 的 version-locked stable-source test path；该路径及任何 checker pass/fail 断言都不是最终证明。gate acceptance 取决于最新一次受控运行及其证据。尤其该路径不证明 historian promotion、`auto_promote`、production Memory authoring，亦不证明 test-only SQLite 与 production 的等价性。最终 Tavern release prerequisite 的当前可接受性仍须由最新受控 run/evidence 判定；在该 gate 被该证据接受前，不得开始或宣称 Tavern final release。

此外，跨进程连续性仍只是 staged foundation，而不是release proof。产品尚未发布，已按 destructive pre-release replacement 将 fresh semantic SQLite single authority 的S0–S5挂载到production entrypoints；不保留legacy compatibility/import/adoption/ACL seal/`LEGACY` route/dual read-write/fallback/read-repair。所需real independent-process/Windows owner-death/recovery的S6 record、browser和live evidence仍见 [`30_CROSS_PROCESS_CONTINUITY_SURFACE_FOUNDATION.md`](30_CROSS_PROCESS_CONTINUITY_SURFACE_FOUNDATION.md)。在这些证据完成前，archive仍是Host-only seam，candidate-only/UI lifecycle promotion延后，Chat lifecycle UI不得标为release-level complete。Persona/Scenario/Greeting/ChatThread的canonical revision tree也是production runtime唯一输入；legacy singleton/historical schema只有显式reviewed candidate/import flow可读取，不作为runtime fallback，删除卡见`design/24`与[`39_NON_ACTION_ENGINEERING_REMEDIATION_IMPLEMENTATION_PLAN.md`](39_NON_ACTION_ENGINEERING_REMEDIATION_IMPLEMENTATION_PLAN.md) P3/P8。

## 3. Information architecture

The chat-first shell has one modal management panel. Its top-level destinations are grouped by player intent:

| Group | Destinations | Primary user question |
|---|---|---|
| Chats | Current chat, Chat history, New chat, Export | Which conversation am I in? |
| Characters | Characters, New character, Persona, Scenario, Greetings, Import/Export | What character material am I using? |
| World | World Info list and per-chat attachment | Which chat background applies here? |
| Connection | Current connection, provider setup, model selection, connection test | What powers this conversation? |
| Settings | Language；Chat 与 Game model profile 的只读安全投影 | 当前 Chat/Game profile 是什么？（不是在此管理或切换） |
| Game | Live game status、published capability count、current execution 与最近 authoritative outcome 的只读投影 | 当前连接游戏的已发布事实是什么？（不是 Tavern Game workflow） |

Connection follows Liyuan's useful three-layer model without copying its unrestricted provider editor:

1. **Current:** provider display name, selected player model, reasoning setting, readiness, and last checked time. Never shows a key, raw endpoint, or internal runtime ID.
2. **Saved connections:** named Host-owned connection records with a readiness summary. Enabling a record is an explicit action and is not conflated with saving a draft.
3. **Set up connection:** a provider-specific form from an approved schema. The key field is write-only. Saving is followed by an explicit Host-side check; a failed test does not silently activate the record.

On desktop this is a panel destination; on mobile it is a full-height sheet. It is not an always-visible dashboard.

## 4. Unified Chat + Game control center

The chat-first shell is the player’s single GameBuddy front end, but it does not collapse Chat and Game into one runtime or one factual domain. The Settings destination therefore has two explicit model sections:

- **Chat** — the connection/model profile used for player conversation.
- **Game companion** — the separately configured profile used only by a released Game surface workflow.

The UI never uses one setting as an implicit override for the other. It does not reveal runtime workers, tool sets, prompt internals or implementation-specific model roles. **当前实现中两个 section 都只是 independently projected active-profile facts，不列出玩家可选项，也不提供 profile mutation。**

A separate **Game** destination currently只是信息投影，不是已发布的 recovery 或 game-control workflow，更不是 raw game-control fallback。When a supported integration is connected, it shows only a player-readable projection of:

- connection readiness and target game label/version;
- independent Chat and Game surface facts (`active`, `inactive`, `recovery required`, or unavailable for each surface), without a cross-surface transition or `returning` state;
- the latest scoped snapshot summary and its freshness state;
- published capabilities after the live Mod capability and Host policy intersection;
- current execution state and the latest authoritative receipt outcome.

Game status is supplied by Host projections of current typed bridge facts. The browser cannot provide scope, capability, snapshot revision, action permissions, receipt state or success status. It cannot control the game through UI/window input, coordinates, console/debug routes, generic dispatch or save editing. **当前 Tavern UI 没有 enter、close、reconnect/recover 或 stop 的 Game lifecycle route/control；不存在 return-to-Chat route/control。这些是未来仅当 owning Host workflow 已实现时才可声明的 contract slices，不是本次 read-only projection 的能力。**

若未来发布独立 Game enter/close/recovery，它只能按 Game 自身 exact scope 创建、resume、关闭或恢复 Game surface；不得记录 Chat origin，不得暂停/关闭/选择/恢复 Chat，不得 copy transcript、summarize/handoff content、inject old receipt into Chat，或把既往 Game fact 表示为当前事实。在该 workflow 未发布前，Tavern 只显示事实状态，不得暗示具备任何 Game lifecycle 控制。回到 Chat 视图只是 UI navigation。

### 4.1 Required integration contract slices

Before this destination is released, the Host needs explicit versioned routes/projections for:

1. **`GET /settings`** — safe Chat and Game model/connection projections plus preferences, with no key, raw endpoint, prompt, tool, internal ID or provider payload.
2. **Chat profile mutations** — the connection/model lifecycle in §5, scoped only to Chat.
3. **Game profile mutations** — separately validated catalog/credential/model lifecycle, scoped only to a released Game companion profile; changing it must never alter Chat configuration.
4. **`GET /game/status`** — typed player projection of connection, current surface, snapshot freshness, published capability labels, active execution and latest receipt category.
5. **Game lifecycle operations** — only where the owning independent Host workflow exists: explicit enter, close, recover/reconnect and local stop. Every route validates identity, target version, save/world scope, generation, lease and Game-surface invariants；不存在 return-to-Chat operation。

The initial Game UI does not publish a new gameplay capability. Capability selection remains solely the intersection of the published registry, live Mod capability and explicit Host action policy. An unavailable or not-yet-live-verified capability is absent from normal action affordances, not a button that asks the model to try anyway.

## 5. Host contract and durable state

### 5.1 Connection catalog and projection

`GET /settings/connection` returns only a player-readable projection:

```ts
{
  active: { connectionId, label, providerLabel, modelId, modelLabel, thinkingLevel, readiness, lastCheckedAtMs } | null,
  connections: [{ connectionId, label, providerLabel, configured, readiness, active }],
  providers: [{ providerId, label, setupFields, allowedPlayerModels }]
}
```

`connectionId` is an opaque write handle, never rendered as ordinary UI text. `setupFields` is a Host-defined allowlist; it may include a write-only API key field, but never a free-form script, headers, arbitrary URL or provider payload field.

### 5.2 Credential vault

A browser credential is accepted only by a CSRF-protected loopback route. The Host writes it through `SecureCredentialStore` and persists only a vault reference in the connection record. It must never persist in:

- a Tavern artifact;
- `localStorage`, URL, bootstrap/SSE payloads, browser report, or export;
- source code, test fixture, terminal output, thrown error text, or run record.

The first implementation targets the project-supported Windows local Host using DPAPI CurrentUser encryption via a narrowly scoped Host adapter. Other platforms fail closed with `credential_vault_unavailable` until an equivalent adapter is implemented. Environment-provided `CPA_OAI_API_KEY` remains a valid operator-managed connection source but is represented in UI as a configured, non-editable `Environment connection`; it is never read or shown.

### 5.3 Write and activation lifecycle

Routes are all session + CSRF protected:

- `POST /settings/connections` creates a draft connection and writes a vault credential;
- `POST /settings/connections/:id/test` validates the configured connection against the Host-owned provider probe;
- `POST /settings/connections/:id/activate` activates only a ready record and a permitted player model;
- `POST /settings/connections/:id/model` selects an allowed model/thinking level for that record;
- `DELETE /settings/connections/:id` removes an inactive record and its vault credential.

Every mutation uses exact schema validation, opaque handles, audit-safe error categories, durable atomic write/read-back, and a player-readable projection. No route accepts arbitrary provider code, arbitrary model ID, custom system prompt, tool configuration, or Game capability configuration.

An activation cannot switch a running turn. While a turn is active the Host returns `dialogue_busy`; after idle activation it creates/restarts the exact chat runtime with the selected model, retains the same `ChatThread`, `surfaceSession`, transcript, stable context bindings, and World Info selection, then rotates the browser session/SSE connection. The UI reports success only after refresh confirms the active configuration.

### 5.4 Chat behavior preferences

A separate `TavernPlayerPreferences` record stores only released player choices: UI locale, selected connection/model, reasoning level, and future explicitly-approved presentation preferences. It does not store prompt blocks, hidden context, agent tools, game policy, provider raw configuration, or unaudited sampler values.

## 6. Library management profile

The next profile must give every listed content surface a complete, minimal real lifecycle:

| Surface | Required first lifecycle | Not authorized |
|---|---|---|
| Character | list, view safe metadata, create, reviewed ST-card import, export, and only its separately versioned retention lifecycle | arbitrary runtime hot-swap, unversioned delete, scripts/extensions |
| Persona | list, create/edit player-readable fields, revision/read-back, select for new chat | hidden prompt editing |
| Scenario | list, create/edit safe authored fields, revision/read-back, select for new chat | live-world assertion |
| Greeting | list, create/edit safe text variants, select for new chat | automatic replay in existing chats |
| World Info | list, create/edit safe public background, bind/unbind exact chat, export | keyword scripts, recursive scanning, HTML/regex execution |
| Chat | list/open/create/rename/export/archive/move-to-trash/restore, draft protection | permanent delete, edit/swipe/branch/retry unless independently declared |
| Import | staged preview, disposition, selection, confirm a new character, export loss report | executing ST extensions/regex/HTML/macros/presets |

Each lifecycle requires a versioned artifact schema, Host route, player-readable projection, CSRF/fail-closed test, browser regression, and an observable durable postcondition before its control enters the UI.

## 7. Release and test gates

A management feature is released only when all are true:

1. route and exact schema are declared in the selected Tavern profile;
2. Host contract tests prove auth, CSRF, scope, persistence/read-back, secret non-disclosure, and rejected state behavior;
3. Playwright covers the player journey, error/retry state, English/Chinese expansion and narrow viewport behavior;
4. no player-facing artifact/export/bootstrap/SSE payload contains a key, endpoint secret, raw provider error, Pi/runtime ID, hash, prompt, tool trace or Game capability data;
5. a controlled final live run uses the selected connection and records only charter-permitted opaque evidence.

BDD remains limited to cross-layer release-critical journeys. Screenshot tests remain sparse and stable; unit/contract tests own persistence and failure cases, and browser fixtures own layout/interaction behavior.
