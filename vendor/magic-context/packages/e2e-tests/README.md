# @cortexkit/opencode-magic-context-e2e

End-to-end test harness for the Magic Context plugins (OpenCode and Pi). Spawns
a real `opencode serve` subprocess (or a Pi child process) pointed at a local
mock Anthropic server and drives sessions through the appropriate harness.

> Note: the package name retains its original `-e2e` suffix from when this only
> covered OpenCode; Pi e2e coverage was added alongside under `tests/pi-*.test.ts`.

## Running

```bash
# From repo root
bun run test:e2e

# Or directly in this package
cd packages/e2e-tests && bun test
```

## Architecture

- **`src/mock-provider/server.ts`** — Anthropic-compatible mock HTTP server. Accepts
  POST `/messages`, supports both SSE streaming (default for OpenCode) and single-shot
  JSON, lets tests script responses with precise control over
  `input_tokens` / `output_tokens` / `cache_read_input_tokens` / `cache_creation_input_tokens`.
  Captures every request body for assertions.

- **`src/opencode-runner/spawn.ts`** — Subprocess runner that launches `opencode serve`
  with an isolated config/data/cache directory, a custom `mock-anthropic` provider
  pointed at the mock, and the magic-context plugin loaded from local source via
  `file://` spec. No npm install required; the plugin is loaded directly from
  `packages/plugin/src/index.ts`.

- **`src/pi-runner/`** + **`src/pi-harness.ts`** — Pi-flavored counterpart to the
  OpenCode runner. Spawns a real Pi child process pointed at the same mock
  Anthropic server and loads the Pi plugin from local source.

### Pi RPC harness

Pi e2e tests run through `pi --mode rpc`, not `pi --print --mode json`. Each
`PiTestHarness` owns one persistent Pi subprocess for its lifetime and talks to
it over strict JSONL on stdio: commands are newline-delimited JSON objects on
stdin, while stdout interleaves `type: "response"` command replies with async
agent events such as `agent_start`, `message_end`, and `agent_end`.

`harness.sendPrompt()` sends a `prompt` RPC command, collects the event slice
from `agent_start` through `agent_end`, and returns the historical
`PiRunResult` shape. Because the Pi process remains alive after each turn,
`exitCode` and `signalCode` are `null` until `harness.dispose()` shuts the
worker down. Multi-turn tests do not need `--continue`; the existing
`continueSession` option is accepted as a compatibility no-op.

The harness also exposes thin RPC helpers for tests that need persistent-process
state directly: `getState()`, `getMessages()`, `getSessionStats()`,
`compactNow()`, and `newSession()`.

RPC mode is available in the installed Pi peer range. The current peer is
`@earendil-works/pi-coding-agent@^0.71.0`; the lockfile resolves `0.71.1`, whose
packaged docs specify the JSONL RPC protocol, and the changelog shows the
current JSON protocol was introduced in `0.16.0`.

- **`tests/*.test.ts`** — Test suites. OpenCode-flavored suites use `harness.ts` /
  `opencode-runner`; Pi-flavored suites (`tests/pi-*.test.ts`) use `pi-harness.ts` /
  `pi-runner`. Each test creates a session, sends prompts, and asserts against
  SQLite state, log output, and captured mock requests.

- **`tests/rust-*.test.ts`** — Rust-mode (ck-mc over subc) lane. Drives the FULL
  production path opencode → plugin → subc daemon → ck-mc module through a
  hermetic stack (`src/rust-harness.ts` + `src/rust-runner/hermetic-subc.ts`),
  reusing the mock provider and session-driving machinery unchanged. Run it
  separately (it is NOT part of the default `test` run or the CI host suite):

  ```bash
  # From this package (or `bun run test:rust-e2e` from the repo root)
  bun run test:rust-e2e
  ```

   Runtime: ~1-2 minutes locally once the binaries are warm. Every invocation asks
   Cargo to build both release binaries so `ck-mc` and `ck-subc` reflect the same
   sibling source revision. The builds share the durable e2e-only cache at
   `packages/e2e-tests/.cache/rust-e2e-cargo-target`, rather than either source
   workspace's `target` directory; unchanged builds reuse Cargo's incremental
   artifacts without contending with a developer build in either workspace.
   Each scenario keeps its session small (tens of turns, tiny context limits) so
   the suite stays fast.

### Rust-mode lane: how it works

The lane spawns a real `ck-subc` daemon (from the sibling `subconscious`
workspace, the same binary `crates/mc-module/tests/real_daemon.rs` uses) and the
`ck-mc` module (this workspace) connected to it, then boots `opencode serve` in
Rust transform mode against them. The wiring uses no product change: the plugin's
Rust module client reads the default connection file at
`${XDG_DATA_HOME}/cortexkit/run/subc-connection.json`, and the harness points the
daemon's `XDG_RUNTIME_DIR` there so its connection file lands exactly where the
plugin looks. The module opens its own store under the same data dir (the
production shared-cortexkit layout).

Environment honesty: `RustTestHarness.detectPrereqs()` preflights the stack
(cargo present, sibling `subconscious` workspace present, supported platform) and
the suite SKIPs with a printed reason when any is missing — never green-washing,
never hanging.

### Rust build-lock contention drill

To verify that a live sibling build cannot block the harness, start a deliberately
slow `cargo build --release -p subc-core --bins` in `../subconscious` in one
terminal, then run `bun run --cwd packages/e2e-tests test:rust-e2e` in another.
The e2e lane must build and run successfully while the sibling build is active:
its Cargo invocations use `packages/e2e-tests/.cache/rust-e2e-cargo-target`, not
`../subconscious/target`. Stop or wait for the background sibling build after the
drill; it is only a contention probe.

**Pressure technique (load-bearing apparatus rule):** scenarios reach high fill
by SHRINKING the context limit against REAL message bytes, never by inflating
reported usage. The two techniques are not interchangeable: inflated usage moves
only fill-keyed conditions (execute thresholds, force bands) while every
real-byte-keyed condition (reclaimable-tail pressure, tail-size trigger floors,
chunk substance) stays silently unreachable — a harness built that way passes
every fill-keyed test honestly while structurally unable to exercise the other
axis, with nothing announcing the gap. (Observed live 2026-08-14 in a peer
gateway's drive container: 44 passes, fill 80→86%, `eligible_chunk_tokens`
pinned at exactly 0.0 the whole time.) If a scenario needs a shortcut, shrink
the window; if you must inflate, document which asserted conditions become
unreachable.

Gated scenarios (skip with a printed reason until their dependency lands):

- **Fold-dependent** (`fold-under-pressure`, `ctx-reduce-roundtrip`) — the Rust
  module runs its own historian, which drives an LLM through a separate `broca`
  runner module the current hermetic stack does not spawn. Without it no
  compartment is published, so no fold (or drop-on-fold) can land. Set
  `MC_RUST_E2E_FOLD=1` once a hermetic broca runner is wired.
- **Removal reconcile** (`removal-self-heal`) — a mid-session `session.revert`
  still wedges the Rust ordinal resolver (a distinct gap from the merged
  tail-readopt / park-self-heal fix). Set `MC_RUST_E2E_REMOVAL=1` once the removal
  ordinal-reconcile self-heal lands.
- **Duplicate tool-use IDs** (`duplicate-tool-use-id`) — consuming a queued drop on
  a selection bust needs the hermetic `broca` runner. Set
  `MC_RUST_E2E_DUPLICATE_IDS=1` once that runner is provisioned; the test body
  always walks every served message array, even while gated.

### CI

The Rust-mode lane is intentionally NOT wired into `.github/workflows/ci.yml`.
Beyond the Rust toolchain (which GitHub-hosted runners can install), it needs the
sibling **`subconscious`** workspace checked out beside this repo to build the
`ck-subc` daemon — the CI checkout does not provision that separate repo, so the
lane cannot build there without extra wiring. When a runner (or a container image)
provisions the subconscious sibling, add a job that runs
`bun run --cwd packages/e2e-tests test:rust-e2e`. Until then the lane runs
locally / on a suitably provisioned host only, and the CI host suite explicitly
excludes `rust-*.test.ts`.

## Requirements

- `opencode` CLI available on PATH for OpenCode suites (`which opencode`).
- Pi CLI installed for Pi suites (see `packages/pi-plugin/README.md`).
- Bun.
- For the Rust-mode lane (`tests/rust-*.test.ts`): `cargo` on PATH and the sibling
  `subconscious` workspace checked out beside this repo (to build `ck-subc`). The
  lane skips with a printed reason when these are absent.
- No `OPENCODE_SERVER_PASSWORD` required — the spawner explicitly strips it so the
  test server runs unsecured on a random localhost port.

## Writing a test

```ts
import { MockProvider } from "../src/mock-provider/server";
import { spawnOpencode } from "../src/opencode-runner/spawn";

const mock = new MockProvider();
const { baseURL } = await mock.start();
const opencode = await spawnOpencode({ mockProviderURL: baseURL });

// Script exactly what the main agent should return on each turn.
mock.script([
    { text: "response 1", usage: { input_tokens: 10_000, output_tokens: 50 } },
    { text: "response 2", usage: { input_tokens: 50_000, output_tokens: 50, cache_read_input_tokens: 10_000 } },
]);

// Drive the session via the SDK.
const { createOpencodeClient } = await import("@opencode-ai/sdk");
const client = createOpencodeClient({ baseUrl: opencode.url });
const { data: session } = await client.session.create({ query: { directory: opencode.env.workdir } });
await client.session.prompt({
    path: { id: session!.id },
    body: {
        model: { providerID: "mock-anthropic", modelID: "mock-sonnet" },
        parts: [{ type: "text", text: "turn 1" }],
    },
});

// Assert against captured requests and plugin state.
expect(mock.requests().length).toBe(1);

await opencode.kill();
await mock.stop();
```
