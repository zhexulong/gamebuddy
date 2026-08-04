# GameBuddy Companion Host

This workspace contains the restricted Companion runtime foundation and the
Phase 2 Windows-local Stardew bridge adapter. `pnpm --filter
@gamebuddy/companion-host start <local-config.json>` is an explicit,
identity-bound local bootstrap; it refuses a missing/invalid bridge snapshot.
It is a restricted Companion Host foundation, not a claim of complete playable
Demo acceptance. The Stardew Mod reports the player's local action allowlist as
live capabilities; with its default empty allowlist the surface is
observation-only. The Host mounts only those Mod-declared capabilities and
cannot grant, enable, or infer authorization from model text. A Host operator
may optionally provide `knowledgeBundlePath` together with `gameVersion`; the
bundle is version- and integration-validated before the read-only
`stardew_game_knowledge` tool is mounted. Knowledge is advisory and never
creates a capability or replaces a Mod snapshot/receipt. Remaining real model,
voice-asset and full multiplayer BDD gates are not represented as passed.

## Dialogue Web (experimental vertical slice)

`pnpm --filter @gamebuddy/dialogue-web build` builds the GameBuddy-owned local
chat surface. It does **not** call the `pi` CLI or access a user's Pi directory.
Create an operator-owned config outside this repository from
`dialogue.config.example.json`, then run:

```powershell
pnpm --filter @gamebuddy/companion-host start:dialogue <dialogue-config.json>
```

The command prints a one-time `127.0.0.1` capability URL. Open it in the same
local browser. `continuityId` selects the Host-owned shared continuity; omitting
`surfaceSessionId` resumes that continuity's latest non-ended Chat surface, and
supplying an existing opaque `surfaceSessionId` resumes that exact Chat surface.
The browser never selects either identifier. The Chat surface starts an embedded,
restricted SDK runtime with only `companion_status`, Magic Context `todowrite`,
explicit `companion_text`, and—only if the operator supplied an audited
`worldBookPath`—the bounded `companion_worldbook_catalog/query` tools. It does
not connect Stardew, mount game tools, voice, or a Gameplay Task Subagent. Only
`companion_text` reaches the browser; ordinary
assistant output, thinking, tool results, receipts, session JSONL, and provider
payloads remain private. The browser cannot select identity, model, tools, or
runtime paths. This is an implementation slice for real conversation testing;
The current vertical slice now persists explicit user-visible surface sessions
under a Host-owned continuity ledger and supports an operator-bound WorldBook.
GameBuddy loads its narrow MIT-licensed Magic Context fork
`0.33.0-gamebuddy.2`, based on upstream commit
`113f3e4824e0ea03a73f2c1e8a57a5ab0bbf7a09`. The Host selects its
`ongoing-interaction` domain and enables only its first read-only Semantic
Memory injection gate. `auto_search` remains limited to the current Pi session,
while its cross-session project-memory path is outside the approved product
scope. Browser-side thread
selection, ST PNG/V3 file import UX, profile editing/migration, and desktop
packaging remain later work. GameBuddy does not implement recall/sync: surface
changes do not copy JSONL, create a handoff summary, or synchronize a Host-owned
experience ledger.

## Locked runtime chain

| Component | Version | Source | Integrity / license |
|---|---:|---|---|
| Pi coding-agent SDK | `0.82.1` | `https://github.com/earendil-works/pi` (`packages/coding-agent`) | npm lockfile integrity; MIT |
| Magic Context Pi extension | `0.33.0-gamebuddy.2` | GameBuddy-maintained fork of `https://github.com/cortexkit/magic-context` commit `113f3e4824e0ea03a73f2c1e8a57a5ab0bbf7a09` (`vendor/magic-context/packages/pi-plugin`) | local file dependency; upstream MIT |

The exact local fork resolution and all transitive packages are in the committed root `pnpm-lock.yaml`; fork source and its build instructions live at `vendor/magic-context/README-GAMEBUDDY-FORK.md`. Initial installation deliberately denies optional build scripts for `onnxruntime-node`, `sharp`, `protobufjs`, and `@google/genai`; Phase 0B configures embeddings **off**, so those binaries are neither required nor implicitly approved.

## Isolation contract

`src/runtime.ts` creates an SDK session with all of these controls:

- `noTools: "all"` plus an explicit `tools: ["companion_status", "todowrite"]` allowlist;
- a single deterministic, side-effect-free `companion_status` fixture tool plus Magic Context's local `todowrite`;
- `DefaultResourceLoader` with built-in/project/global extension discovery, skills, prompts, themes, context files, and coding prompts disabled;
- exactly one pinned Magic Context extension loaded by its resolved package entry;
- an opaque SHA-256 key made from `{playerId, saveId, worldId, companionId}`; display names are never identity inputs;
- Host runtime data outside the repository, under `%USERPROFILE%\.gamebuddy\contexts\<identity-hash>` by default;
- separate Pi agent/session data **and Magic Context SQLite data** per identity partition;
- generated local Magic Context config selects the fork's `ongoing-interaction` domain and enables native, same-opaque-context Semantic Memory rendering plus Magic Context's native `auto_promote` gate. The fork has a hidden, no-tool embedded-Pi Historian runner that never spawns a system `pi` CLI or creates a player-visible session, and enables its automatic embedded Historian authoring under Magic Context's native context-pressure policy. It remains no-tool, no-browser-output, and uses the GameBuddy SDK registry only. Generic Magic Context coding guidance, auto-search, embeddings, dreamer, sidekick, Git indexing, docs injection, and todo overlay stay disabled; `todowrite` is explicitly allowlisted;
- the `LocalStardewBridgeClient` and named-pipe framing adapter validate every incoming Mod fact before caching it, use opaque scope binding and a per-session token, and clear all authoritative caches on disconnect.

`ongoing-interaction` gives Magic Context—not the Host—the historian taxonomy
needed to distinguish Working, Episodic, Semantic, and Host-owned Procedural
Memory. The first enabled gate renders only Magic Context-owned, active or
permanent `SEMANTIC_MEMORY` rows scoped to the exact opaque continuity runtime;
its generic coding-agent system guidance is disabled and Chat's Pi allowlist
continues to exclude every `ctx_*` tool. This does not grant Host authority to
read SQLite, perform recall, promote facts, synchronize sessions, create a
handoff summary, or maintain an experience ledger. The selected domain and
first gate must **not** be taken as authorization to enable cross-context
product Memory, dreamer, RAG, historian subagents, project-document injection,
Git indexing, auto-search, or automatic recall. Magic Context's native
`auto_promote` and embedded Historian authoring are intentionally selected only
for the `ongoing-interaction` taxonomy and its own context-pressure scheduler.

## Verification

```powershell
pnpm build
pnpm test
node tools/verify-phase0b-host.mjs
```

`runtime.test.ts` verifies the exact active tool list, no coding tools, identity partitioning, pinned extension load, generated restrictive configuration, and session recovery after a persisted assistant entry. The embedded Historian authoring gate is verified separately with `node tools/run-ongoing-interaction-historian-authoring.mjs`: it uses a temporary GameBuddy runtime and the embedded SDK registry. Its Episodic fixture produces a compartment and no `SEMANTIC_MEMORY` while `auto_promote=false`; its separate explicit durable-preference fixture proves Magic Context's native promotion lifecycle creates exactly one scoped `SEMANTIC_MEMORY` only under the test gate's `auto_promote=true`. It exposes neither browser output nor tools and never invokes a system `pi` CLI. This verifies the same no-tool embedded Historian/promotion pipeline used by normal product configuration; its direct invocation avoids manufacturing production-scale context pressure. `local-stardew-bridge.test.ts` verifies the authenticated named-pipe Host adapter against a framed peer. No provider request is issued until a separately configured, approved model provider is available. The player-facing Dialogue Director is locked to Pi provider `cpa-oai`, model `deepseek-v4-flash`, and fixed `high` thinking. Its model registry uses DeepSeek's documented OpenAI-compatible `thinking: { type: "enabled" }` request format and `high` reasoning effort; it is text-only with a 1M context limit. CPA's DeepSeek thinking route supports ordinary native `tools`, but rejects forced OpenAI `tool_choice`; GameBuddy does not emit forced tool choice. When explicitly enabled, the private gameplay task subagent is independently pinned to `cpa-oai/gpt-5.6-luna` at `medium`; it never inherits DeepSeek or gains player-facing tools. Both use `CPA_OAI_API_KEY` only at request time. MiMo is not an Agent provider; it belongs to the independent Voice Gateway TTS adapter. Copy `local-host.config.example.json` outside the repository, replace its opaque scope and bridge token values with the exact local Mod configuration, and keep the locked Agent model fields. To mount an audited knowledge bundle, add both `knowledgeBundlePath` and its matching `gameVersion`; malformed, duplicate, cross-version, or non-Stardew rules fail startup.
