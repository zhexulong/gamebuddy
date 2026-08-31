# OpenCode TS E2E group flake characterization — 2026-08-17

## Scope and result

This is a report-only investigation of the release container's `ts/opencode` group after two different group-only failures:

- `thinking-block-safety`: Bug C observed no image after a text-tag drop.
- `long-running-session`: the persisted compartment range started at `3` while the test's most recently captured historian range started at `7`.

I ran the complete manifest-derived TS/OpenCode group twice in the release-equivalent container topology. It did **not** reproduce:

| Run | Container topology | Result |
| --- | --- | --- |
| 1 | Read-only checkout bind-mounted at `/repo`; staged to `/workspace` tmpfs; `/tmp`, `/run`, HOME, and XDG directories all tmpfs-backed; fresh dependency install | Docker process exited `0`. The AFT transport daemon restarted while this invocation was still running, so its test summary was not retained; `docker wait` subsequently returned `0`. |
| 2 | Same fresh `--rm` container and tmpfs topology | `44 pass`, `0 fail`, `271 expect()` calls across `19` files. |

Exact group command inside each container (after the release runner's staging/install steps):

```sh
files=$(bun packages/e2e-tests/scripts/validate-mode-manifest.ts --mode ts --harness opencode | tr '\n' ' ')
cd packages/e2e-tests
MC_E2E_MODE=ts NODE_ENV="" bun test --timeout 600000 $files
```

Environment used by the local preflight was Bun `1.3.14` and OpenCode `1.18.18`; the container image is `oven/bun:1.3.14-debian` and installs OpenCode during image build. The second run's positive summary demonstrates that both named tests ran: the manifest's 19 OpenCode files include them, and the long-running test is not skipped because the container does not set `CI`.

This is therefore a null reproduction result with recorded evidence, not evidence that the release failures were invalid.

## Release-group topology

`scripts/release-e2e-docker.sh` runs the OpenCode list in **one Bun invocation** without `--max-concurrency`. It does not launch one group-wide `opencode serve` process. Every `TestHarness.create()` instead:

1. starts a new mock provider on port `0`;
2. creates `opencode-e2e-${Date.now()}-${random}/` under the OS temp directory, with separate config, data, cache, and work directories;
3. allocates an OpenCode port with `Bun.serve({ port: 0 })`; and
4. starts one `opencode serve` child with its `OPENCODE_CONFIG_DIR`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `XDG_CACHE_HOME` set to those new directories.

`prepareContextDatabase(dataDir)` initializes the explicit per-harness path before the child starts. The child has `XDG_DATA_HOME` set, and `getMagicContextStorageDir()` gives XDG precedence over the inherited `MAGIC_CONTEXT_TEST_DATA_DIR`; the Bun test-preload guard therefore cannot redirect a child to the parent test process's database.

Consequences:

- `context.db` and `opencode.db` are per harness, not shared between ordinary OpenCode test files.
- session IDs are created by each isolated OpenCode server; the server data directory and work directory are also unique.
- the `storage-db.ts` in-process `databases` cache is keyed by the explicit absolute database path, so its retained parent-process handles are distinct as well.
- `sharedDataDir` is an explicit Pi cross-harness feature and is not used by the TS/OpenCode manifest.

One important qualification: several files, including `thinking-block-safety`, create one harness in `beforeAll` and reuse it for all tests in that **file**. Thus test cases in a file share one mock, one OpenCode child, and one data directory even though separate files do not intentionally do so.

## Was Magic Context actually active?

No failing state was captured because neither full run failed. The successful Bug C path is nevertheless not a passive model-response assertion:

- `mainRequests()` retains only provider requests whose system prompt contains `## Magic Context`.
- `tagForText()` must find the generated `§N§` handle in one of those transformed requests.
- the mock emits `ctx_reduce` only when that Magic Context request exposes the tool, and the test asserts that the tool was emitted.
- the final assertion inspects the transformed request and finds the image block after the text tag has been dropped.

The successful long-running path similarly requires a Magic Context historian request, waits for a compartment row in the harness database, and checks that its persisted range equals the captured historian range.

That is strong evidence that Magic Context ran in the passing executions. It is not sufficient failure forensics: `TestHarness.sendPrompt()` does not require a `session_meta` row for the intended OpenCode session, and `thinking-block-safety` does not associate a captured provider request with that session. A future reproduction should record the intended session ID, its `session_meta`/tag rows, its unique prompt marker, the complete matching provider request, and the relevant `context.db` rows before cleanup.

## Shared-state candidates

| Candidate | Finding | Fit for the two symptoms |
| --- | --- | --- |
| Group-wide OpenCode server, data dir, `opencode.db`, or `context.db` | Not present for ordinary OpenCode harnesses; each harness creates and configures unique paths. | Rejected as the direct cross-file mechanism. |
| Parent test-preload database | The preload's `MAGIC_CONTEXT_TEST_DATA_DIR` is inherited, but child `XDG_DATA_HOME` overrides it. Database preparation also passes an explicit child path. | Rejected. |
| Port collision | `pickFreePort()` has the standard bind-after-probe race. A collision causes the child to fail readiness, not a successful request with another session's transform state. | Possible startup flake, but does not explain image/range substitution. |
| SQLite lock | `openTestDb()` uses `busy_timeout=5000`, and only competes with the current harness's child because the database path is unique. | Possible per-harness timing issue, not a prior-file database leak. |
| Logger file | Child OpenCode processes append to the shared default `/tmp/opencode/magic-context/magic-context.log`. It is write-only diagnostic output and no transform code reads it. | Real shared artifact, but not a state input. |
| Background work plus a per-file shared mock/harness | A file resets one shared mock without waiting for all work from earlier sessions to quiesce, and captures requests without a session correlation key. Under load, a delayed internal request can arrive after `mock.reset()` and become the request selected by `.at(-1)`. | Strong candidate for Bug C's wrong served request. |
| Long-running historian assertion race | `historianRange` is one mutable variable set for every historian request. The test waits only for “a compartment exists”, then compares that row with whichever historian request last updated the variable. Background historian requests can complete/order differently under load. | Strong candidate for `expected 7, received 3`; this is an intra-test correlation race, not proof of prior-file row leakage. |

## Proposed fix (not applied)

Treat this as a test-observability and asynchronous-quiescence defect unless a captured reproduction contradicts it.

1. Create and dispose an OpenCode harness per test case for suites that reset a shared mock, or add a harness-level quiescence barrier before `mock.reset()` and before selecting a final request. This prevents delayed work from an earlier session from being mistaken for the current test's request.
2. Extend the OpenCode harness with the same durable “Magic Context processed this session” check already used by `PiTestHarness`: after a prompt, verify the intended session's `session_meta` row in that harness's `context.db`.
3. Add correlation to mock captures. At minimum, use a unique prompt marker and require it in the selected request; for historian work, retain every captured range and wait for/query the compartment that matches the intended range rather than comparing a latest compartment to a mutable last-seen range.
4. On any failure, emit a compact forensic bundle: harness paths, session ID, `session_meta`, tags, compartments, all matching request bodies, and child stdout/stderr. Set a unique `MAGIC_CONTEXT_LOG_PATH` per harness to keep diagnostics separate.

These changes would distinguish “Magic Context did not run” from “a different session's/background request was inspected,” and would make the reported image and historian-boundary failures actionable. No production or test code was changed by this investigation.
