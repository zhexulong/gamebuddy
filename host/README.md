# GameBuddy Companion Host

This workspace contains the restricted Companion runtime foundation and the
Phase 2 Windows-local Stardew bridge adapter. `pnpm --filter
@gamebuddy/companion-host start <local-config.json>` is an explicit,
identity-bound local bootstrap; it refuses a missing/invalid bridge snapshot.
It is **not yet a playable Companion Host**: the default capability surface is
observation-only until a player-policy boundary grants an action, and the
remaining model/voice/multiplayer BDD gates are not represented as passed.

## Locked runtime chain

| Component | Version | Source | Integrity / license |
|---|---:|---|---|
| Pi coding-agent SDK | `0.82.1` | `https://github.com/earendil-works/pi` (`packages/coding-agent`) | npm lockfile integrity; MIT |
| Magic Context Pi extension | `0.33.0` | `https://github.com/cortexkit/magic-context` (`packages/pi-plugin`) | npm lockfile integrity; MIT |

The exact resolved tarball integrity and all transitive packages are in the committed root `pnpm-lock.yaml`. Initial installation deliberately denies optional build scripts for `onnxruntime-node`, `sharp`, `protobufjs`, and `@google/genai`; Phase 0B configures embeddings **off**, so those binaries are neither required nor implicitly approved.

## Isolation contract

`src/runtime.ts` creates an SDK session with all of these controls:

- `noTools: "all"` plus an explicit `tools: ["companion_status", "todowrite"]` allowlist;
- a single deterministic, side-effect-free `companion_status` fixture tool plus Magic Context's local `todowrite`;
- `DefaultResourceLoader` with built-in/project/global extension discovery, skills, prompts, themes, context files, and coding prompts disabled;
- exactly one pinned Magic Context extension loaded by its resolved package entry;
- an opaque SHA-256 key made from `{playerId, saveId, worldId, companionId}`; display names are never identity inputs;
- Host runtime data outside the repository, under `%USERPROFILE%\.gamebuddy\contexts\<identity-hash>` by default;
- separate Pi agent/session data **and Magic Context SQLite data** per identity partition;
- generated local Magic Context config with embeddings, dreamer, sidekick, auto-promotion, auto-search, Git indexing, docs injection, and todo overlay disabled; historian retains the session's tool-safe history and `todowrite` is explicitly allowlisted;
- the `LocalStardewBridgeClient` and named-pipe framing adapter validate every incoming Mod fact before caching it, use opaque scope binding and a per-session token, and clear all authoritative caches on disconnect.

Magic Context is loaded only for persistent session/historian/todo behavior and
SQLite-backed storage startup on Windows. It must **not** be taken as
authorization to enable cross-context product Memory, dreamer, RAG, historian
subagents, project-document injection, Git indexing, or automatic recall.

## Verification

```powershell
pnpm build
pnpm test
node tools/verify-phase0b-host.mjs
```

`runtime.test.ts` verifies the exact active tool list, no coding tools, identity partitioning, pinned extension load, generated restrictive configuration, and session recovery after a persisted assistant entry. `local-stardew-bridge.test.ts` verifies the authenticated named-pipe Host adapter against a framed peer. No provider request is issued until a separately configured, approved model provider is available. Copy `local-host.config.example.json` outside the repository, replace its opaque scope and bridge token values with the exact local Mod configuration, and optionally choose the locked MiMo model; `MIMO_API_KEY` remains an environment value only.
