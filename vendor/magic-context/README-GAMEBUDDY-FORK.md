# GameBuddy Magic Context Fork

This directory is a project-maintained fork of upstream Magic Context commit
`113f3e4824e0ea03a73f2c1e8a57a5ab0bbf7a09` (MIT). It is intentionally ignored
by the parent repository's normal Git index; the GameBuddy dependency must be
packed/installed from this exact working tree before any production enablement.

## GameBuddy delta: `memory.domain`

The fork adds an explicit configuration selector:

```json
{
  "memory": {
    "domain": "coding-project" | "ongoing-interaction"
  }
}
```

`coding-project` preserves upstream taxonomy and historian behavior.

`ongoing-interaction` changes only Magic Context's own historian parsing and
promotion taxonomy. It uses `SEMANTIC_MEMORY` facts and a dedicated historian
prompt that separates:

- Working Memory — the currently materialized context;
- Episodic Memory — chronological compartments/events;
- Semantic Memory — confirmed durable interaction facts eligible for the
  existing promotion lifecycle;
- Procedural Memory — Host/policy/profile/runtime-owned behavior that Magic
  Context must not create or override.

The domain does **not** give GameBuddy Host a memory adapter, SQLite reader,
recall engine, handoff summary, JSONL copier, experience ledger, or custom
promotion logic. Host only writes the selected domain and feature gates into
its opaque runtime directory.

## Deliberate rollout state

GameBuddy currently selects `ongoing-interaction`, enables same-scope read-only
Semantic Memory injection, and enables Magic Context's native embedded
Historian/`auto_promote` lifecycle:

```json
{
  "system_prompt_injection": { "enabled": false },
  "memory": {
    "domain": "ongoing-interaction",
    "enabled": true,
    "auto_promote": true,
    "auto_search": { "enabled": false }
  },
  "embedding": { "provider": "off" },
  "dreamer": { "disable": true },
  "sidekick": { "disable": true }
}
```

The fork's native m[0]/m[1] renderer injects only active/permanent
`SEMANTIC_MEMORY` for the exact opaque project identity. Under Magic Context's
own context-pressure scheduler, the embedded no-tool Historian may publish
Episodic compartments and, when its domain-validated output contains
`SEMANTIC_MEMORY`, transactionally promote it through Magic Context's existing
lifecycle. The generic coding-agent system guidance is explicitly disabled, and
GameBuddy's Pi allowlist still excludes all Magic Context `ctx_*` tools. Thus
Host has no Memory writer, reader, recall adapter, SQLite API, handoff, ledger,
or promotion logic.

Magic Context's native ongoing-interaction promotion path has controlled
provider-backed verification: a one-off Episodic fixture publishes no Semantic
Memory, while an explicit confirmed durable preference publishes one scoped
`SEMANTIC_MEMORY` when `auto_promote=true`. This verifies the same embedded
pipeline selected by production without manufacturing production-scale context
pressure.

This fork is not evidence that cross-session Chat/Game recall, embeddings,
Dreamer, or Sidekick are enabled or accepted. They each need independent
controlled live verification before changing a gate.

## Build checks

```sh
bun install --frozen-lockfile
bun run --filter @cortexkit/opencode-magic-context typecheck
bun run --filter @cortexkit/pi-magic-context typecheck
bun test packages/plugin/src/features/magic-context/memory/domain.test.ts
bun run --filter @cortexkit/pi-magic-context build
```

Do not patch installed `dist` artifacts. Regenerate the ongoing-interaction
prompt after editing its Markdown source:

```sh
bun run packages/plugin/scripts/build-ongoing-interaction-historian-prompt.ts
```
