# GitHub #388 — test config and embedding-provider isolation

Date: 2026-08-29

## Outcome

The Bun test preloads now isolate both XDG data and XDG config in the same process-scoped throwaway tree. A fixture-scoped config load therefore cannot inherit a developer's user-tier `magic-context.jsonc`, including its embedding endpoint, model, or API key.

`createProvider` in the project embedding registry now fails closed when the test-isolation marker is present and a test has not installed `_setTestProviderFactoryForProject`. `embedding.provider: "off"` remains a deliberate no-provider configuration and returns `null` before the factory requirement is checked.

No schema or storage fence moved. No branch was pushed.

## Contributor register

Thank you to **@iceteaSA** for the precise two-part analysis in #388. The report correctly connected this configuration leak to the 2026-06-01 storage-isolation incident: both were cases where per-test convention allowed an unisolated path to reach a user's real state. The fleet-sweep framing was especially useful, as was the observation that the Rust workspace is structurally immune because its dependency graph has no HTTP or TLS client path.

## Preload coverage

`packages/plugin/test-preload.ts` now sets `XDG_CONFIG_HOME` alongside `XDG_DATA_HOME` and `MAGIC_CONTEXT_TEST_DATA_DIR`. Its incident-history comment records #388's user-tier embedding endpoint/model resolution class.

`packages/pi-plugin/test-preload.ts` applies the same assignment. The root, CLI, and e2e Bun configurations already preload `packages/plugin/test-preload.ts`; the standalone Pi configuration preloads its local equivalent. Thus each current storage-isolating preload path also isolates the user config tier.

Tests which set `XDG_CONFIG_HOME` retain precedence over the preload default. `config/index.test.ts` now proves both directions:

- a fresh fixture with no config resolves the schema-default local embedding configuration under the preload; and
- a test-scoped `XDG_CONFIG_HOME` with an OpenAI-compatible fixture still overrides the preload and is restored afterward.

`packages/pi-plugin/src/storage-preload.test.ts` also asserts that Pi's config home equals its preload-created test data root.

## Provider construction audit

The test marker is `MAGIC_CONTEXT_TEST_DATA_DIR`, not `NODE_ENV=test`. The preload creates this project-specific marker for every configured Bun test process, and production code documents it as test-only. It is therefore a narrower production-safe signal than the generic runtime mode.

The factory audit found eight direct installer test files in this branch:

- `project-embedding-registry.test.ts`
- `shadow-backfill.test.ts`
- `search-measurement.test.ts`
- `memory/embedding-backfill.test.ts`
- `memory/promotion.test.ts`
- `compartment-chunk-embedding.test.ts`
- `tools/ctx-memory/tools.test.ts`
- `hooks/magic-context/hook.test.ts`

Their embedding paths retain explicit fake providers. Indirect paths were also reviewed: registry primary, shadow, `/ctx-embed` session backfill, memory backfill, commit drain, chunk embedding, the OpenCode bootstrap registration test, and search's injected query embedder. The bootstrap test registers only a lazy primary provider and does not construct it; search injects its own query embedding function. No test relied on real user-tier embedding configuration, so the audit required no fixture-config repairs.

The issue report counted eleven installer files; the current worktree contains the eight direct installers listed above. The broader registry and indirect-path audit found no unguarded test construction beyond the newly covered no-factory path.

## Regression and mutation evidence

The no-factory regression exercises immediate Synapse shadow-provider construction. With the guard removed, the constructor returned normally, proving the prior silent fall-through without issuing a network request. The regressions were deliberately broken and restored immediately:

| Deliberate mutation | Command | Observed red evidence |
| --- | --- | --- |
| Disabled plugin `XDG_CONFIG_HOME` preload assignment | `bun test src/config/index.test.ts -t "resolves schema-default embedding config for a fixture with no config" --timeout 30000` | `config/index.test.ts:120` received an unset config-home value instead of the preload path. |
| Pointed the per-test config helper at an empty config path | `bun test src/config/index.test.ts -t "allows a test-scoped XDG_CONFIG_HOME to override the preload default" --timeout 30000` | `config/index.test.ts:142` received the local schema default instead of the OpenAI-compatible fixture destination. |
| Disabled the registry factory requirement | `bun test src/features/magic-context/project-embedding-registry.test.ts -t "fails closed before a test constructs a provider without a factory" --timeout 30000` | `project-embedding-registry.test.ts:308` received `undefined` instead of `TestProviderFactoryRequiredError`; the Synapse provider constructed silently. |

No `NON-VACUITY BREAK` marker remains in the working tree.

## Verification

- `bun install --frozen-lockfile` — passed.
- Focused #388 config and registry regressions — 100 passed, 0 failed.
- Plugin typecheck — passed.
- Pi typecheck — passed.
- Pi preload isolation regression — 1 passed, 0 failed.
- Full plugin suite — 4,211 passed; one unrelated wall-clock performance assertion failed at 35.979ms versus its 30ms ceiling. Its focused retry passed.
- Full Pi suite — 878 passed; one existing context-handler assertion failed (`freshGrowthDropped` remained 17 rather than exceeding 17). The same test failed again with Pi's new config assignment deliberately disabled, confirming it is unrelated to this change.

## Suggested reply for #388

> Thank you, @iceteaSA — this was an excellent sweep and a precise report. We implemented both layers: every storage-isolating Bun preload now also redirects `XDG_CONFIG_HOME`, and project embedding-provider construction now fails closed under the test marker unless a test installs `_setTestProviderFactoryForProject`. `embedding.provider: "off"` remains a clean null path.
>
> The regressions cover a fixture-scoped load resolving schema defaults instead of user-tier embedding configuration, explicit test-level `XDG_CONFIG_HOME` overrides, and the formerly silent no-factory provider construction path. We also audited direct factory installers and indirect registry, `/ctx-embed`, bootstrap, and backfill paths; no test required a real-config fixture repair.
>
> The 2026-06-01 storage-incident parallel was exactly the right framing: this moves config isolation from convention to structure. The Rust-workspace immunity observation was appreciated as well.
