# GameBuddy Magic Context Fork

This directory is a parent-repository-tracked, project-maintained fork of upstream
Magic Context `v0.41.0` commit `bcd2f705af70bfd055e974a47c958640e2484b7f`
(MIT). GameBuddy applies its product-specific delta directly in this vendored tree;
the dependency, lockfiles, generated `dist`, SBOM, and third-party license inventory
must be regenerated and verified from this exact tracked source before release.

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
Semantic Memory injection, and enables the native embedded Historian while
keeping automatic promotion disabled pending its separate release gate:

```json
{
  "system_prompt_injection": { "enabled": false },
  "memory": {
    "domain": "ongoing-interaction",
    "enabled": true,
    "auto_promote": false,
    "auto_search": { "enabled": false }
  },
  "embedding": { "provider": "off" },
  "dreamer": { "disable": true },
  "sidekick": { "disable": true }
}
```

The fork's native m[0]/m[1] renderer injects only active/permanent
`SEMANTIC_MEMORY` for the exact opaque project identity. Under Magic Context's own context-pressure scheduler, the embedded no-tool
Historian may publish Episodic compartments. Domain-valid `SEMANTIC_MEMORY`
promotion remains gated off in production until `auto_promote` receives its
separate controlled live acceptance. The generic coding-agent system guidance is explicitly disabled, and
GameBuddy's Pi allowlist still excludes all Magic Context `ctx_*` tools. Thus
Host has no Memory writer, reader, recall adapter, SQLite API, handoff, ledger,
or promotion logic.

Magic Context's native ongoing-interaction promotion path has controlled
provider-backed gate coverage (not production enablement): a one-off Episodic fixture publishes no Semantic
Memory, while an explicit confirmed durable preference publishes one scoped
`SEMANTIC_MEMORY` when `auto_promote=true`. This exercises the same embedded pipeline selected by production without
manufacturing production-scale context pressure or enabling the production gate.

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
