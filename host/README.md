# GameBuddy Companion Host — Phase 0B

This workspace is a **runtime provenance and isolation spike**, not yet a playable Companion Host.

## Locked runtime chain

| Component | Version | Source | Integrity / license |
|---|---:|---|---|
| Pi coding-agent SDK | `0.82.1` | `https://github.com/earendil-works/pi` (`packages/coding-agent`) | npm lockfile integrity; MIT |
| Magic Context Pi extension | `0.33.0` | `https://github.com/cortexkit/magic-context` (`packages/pi-plugin`) | npm lockfile integrity; MIT |

The exact resolved tarball integrity and all transitive packages are in the committed root `pnpm-lock.yaml`. Initial installation deliberately denies optional build scripts for `onnxruntime-node`, `sharp`, `protobufjs`, and `@google/genai`; Phase 0B configures embeddings **off**, so those binaries are neither required nor implicitly approved.

## Isolation contract

`src/runtime.ts` creates an SDK session with all of these controls:

- `noTools: "all"` plus an explicit `tools: ["companion_status"]` allowlist;
- a single deterministic, side-effect-free `companion_status` fixture tool;
- `DefaultResourceLoader` with built-in/project/global extension discovery, skills, prompts, themes, context files, and coding prompts disabled;
- exactly one pinned Magic Context extension loaded by its resolved package entry;
- an opaque SHA-256 key made from `{playerId, saveId, worldId, companionId}`; display names are never identity inputs;
- Host runtime data outside the repository, under `%USERPROFILE%\.gamebuddy\contexts\<identity-hash>` by default;
- separate Pi agent/session data **and Magic Context SQLite data** per identity partition;
- generated local Magic Context config with embeddings, historian, dreamer, sidekick, auto-promotion, auto-search, Git indexing, docs injection, and todo overlay disabled.

Magic Context is loaded only to prove its extension lifecycle and SQLite-backed storage startup on Windows. It must **not** be taken as authorization to enable cross-context product Memory, dreamer, RAG, historian subagents, project-document injection, Git indexing, or automatic recall.

## Verification

```powershell
pnpm build
pnpm test
node tools/verify-phase0b-host.mjs
```

`runtime.test.ts` verifies the exact active tool list, no coding tools, identity partitioning, pinned extension load, generated restrictive configuration, and session recovery after a persisted assistant entry. No provider request is issued in Phase 0B.
