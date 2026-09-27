---
id: REVIEW-STARDEW-TOPOLOGY-ROUTE-REMOVAL
type: review
status: current
owner: stardew-integration
reviewed_revision: 37dd64a
verdict: NO BLOCKER
---

# Independent Review — TASK-STARDEW-PRODUCT-LAUNCH-TOPOLOGY-CONSOLIDATION (Tasks 1–5, Task 6 Step 5)

**Reviewed revision:** commit `37dd64a` ("refactor(stardew): remove the direct operator-config Stardew product attach route"). Content-identical to the originally assigned `c647bfe`, which a concurrent lane rewrote; the review was re-anchored after that rewrite. `tools/run-chat-live-audit.mjs` was excluded as unrelated-lane work.

**Method caveat (reviewer):** the reviewer session had read-only tools — no shell, no `git show`, no test runner, no file writer. Every claim below was verified by direct source reads of the current working tree plus `.git` artifacts used to inspect the deleted module's prior content. **The reviewer did not execute any test.** Test results in this document are marked separately as supervisor-executed.

---

## Claim 1 — The deleted module had ZERO production importers, and nothing needs it

**VERIFIED.**

- `host/src/continuity-semantic-game-operator-selection/` is absent from the working tree.
- Repo-wide search for `continuity-semantic-game-operator-selection` finds only git history artifacts, stale `.dist-*` build leftovers, and the tests that pin its absence.
- Repo-wide search for `createKnownSemanticGameFacadeFromOperatorConfig`, `createKnownSemanticGameDeadOwnerRecoveryFacadeFromOperatorConfig`, and `gameOperatorConfigPath` finds only tests asserting those symbols do **not** appear in production (`host/src/semantic-main-config.test.ts:20-21`, `host/src/stardew-owned-farmhand-game-session-materializer.internal.test.ts:145-146`) plus stale build output. **Zero production importers.**
- Shipped entry `host/src/main.ts` imports only `createKnownSemanticGameProductionAuthorityFromDeploymentManifest` and the coordinator, and consumes `parseSemanticMainCommand`; it never touches operator selection.
- Dead-owner recovery (`main.ts:43-52`) loads the deployment manifest and calls `game.recoverDeadOwner({...})` on the production authority — no operator-config facade, no pipe/token.
- The old module was **not** harmless: it constructed its own `createKnownSemanticGameProductionAuthorityFromDeploymentManifest`, i.e. a second Game authority. This confirms the plan's substantive reason for deleting rather than migrating it.
- Even if the module still existed, `PRODUCT_INTEGRATION_CATALOG.get(integrationId)` now always returns `undefined` (zero launchers registered), so its selection step would throw `semantic_game_operator_integration_not_registered` — fail-closed.

**No finding.** The historical `tools/run-stardew-native-local-agent-ab-live.mjs` consumes the adapter's private seam from `host/dist-test/`; it is a dev live-AB harness, not a shipped entry and not a catalog consumer, and it does not import the deleted module.

---

## Claim 2 — `PRODUCT_INTEGRATION_CATALOG` registers NO selectable launcher; no equivalent route was reintroduced

**VERIFIED.**

- `host/src/integration-catalog-product.ts:16` — `createIntegrationCatalog([], [createStardewGameIntegrationProvider()])`: zero launchers, one provider. `select()` on an empty launcher map throws; `get("stardew")` returns `undefined` (pinned at `integration-catalog-product.test.ts:56`).
- The only production consumer of the catalog is the composition root, `host/src/composition/desktop-host-composition.ts:215` — `PRODUCT_INTEGRATION_CATALOG.getProvider("stardew")`. It never calls `get`/`select` and cannot see `pipeName`/`bridgeToken`.
- **No second entry exists:** `host/production-artifact.config.json` entryRoots are `main.js`, `stardew-attachment.js`, `farmhand-companion-preview.js`. `stardew-attachment.ts` is the Companion App attachment flow over signed advertisement/request/response files — no operator-config attach. Preview is Preview-owned. The desktop entry imports only the runtime bootstrap.
- Operational harness `tools/run-game-operational-gate.mjs` spawns exactly `main.js --deployment-manifest-ref <ref> --operational-nonce <nonce>`; its config schema has no operator field, and the test pins the absence of `gameOperatorConfigPath` and of `pipeName`/`bridgeToken`/`launchGeneration`/`locator`/`profilePath`/`sessionId`/`pid`/`job`/`guardianInstanceId`.
- Real pipes/tokens now come from only two lawful places: (a) Preview's own config; (b) the coordinator-private launch, which **mints** them inside the coordinator (`stardew-private-bootstrap-composer.core.ts`) and whose only consumer is `stardew-owned-farmhand-game-session-materializer.internal.ts` via the injected `StardewPrivateFarmhandBridgeConnection`. Never from operator config.

**No finding.**

---

## Claim 3 — The `createIntegrationCatalog` guard relaxation did not weaken any real safety property

**VERIFIED.**

- Old guard: `launchers.length === 0 || launchers.length > 32`. New guard (`host/src/integration-catalog.ts:122-124`): `launchers.length + providers.length === 0 || launchers.length > 32 || providers.length > 32`.
- The only shipped caller is `integration-catalog-product.ts`. The old `select()` had exactly one production consumer — the deleted operator-selection module, which was itself the removed route. No shipped caller can reach `select()` today.
- Safety property preserved: a fully empty catalog still throws `invalid_integration_catalog` (pinned at `integration-catalog.test.ts:101`); per-kind upper bounds preserved; duplicate/broken registrations still rejected. The change grants no launcher route and adds no fallback or alias.
- The productive safety assertion is on the **registration set**, not the guard arithmetic: a future launcher registration would fail `integration-catalog-product.test.ts:8` (`ids === []`) and `:56`. That is strictly stronger than the old guard.

**No finding.**

---

## Claim 4 — The importer-inventory test is non-vacuous and its file collection reaches what it claims

**VERIFIED, with one MEDIUM robustness gap (Finding B).**

- `host/src/stardew-owned-farmhand-game-session-materializer.internal.test.ts` walks `host/src` recursively, excluding `node_modules` and dot-directories, tests, test-support, and fixtures; it asserts the materializer importer set is exactly `["host/src/stardew-production-lifecycle-coordinator.internal.ts"]`.
- **Non-vacuous:** a Preview/portfolio/tool import of the materializer would appear in the scan and fail; removing the coordinator's import would also fail. Both directions break on a plausible regression. Mutation-verified by the supervisor (see below).
- The path computation maps `host/dist-test` → `host/src` correctly and normalizes Windows separators.
- **Gap:** the plan's wording says the scan excludes `*.test.ts` and approved `*.test-support-internal.ts`, but the implemented exclusion `/\.test-support\.ts$/` does not match `*.test-support-internal.ts`. Currently harmless (the file does not import the materializer), but a legitimate approved test-support importer would false-fail. See Finding B.

---

## Also-checked items

1. **Plan's "diagnosis was partly stale" claim (main.ts / semantic-main-config.ts already manifest-only): TRUE.** `main.ts` loads the manifest and constructs the production authority and coordinator; `semantic-main-config.ts` accepts only the `--deployment-manifest-ref`/`--operational-nonce` or `recover-dead-owner` forms; the test pins the forbidden-symbol list including `PRODUCT_INTEGRATION_CATALOG` and `createKnownSemanticGameFacadeFromOperatorConfig`.
2. **`host/src/dialogue-web-main.ts` does not exist: TRUE.** Only a historical snapshot copy exists; the live tree has none, and a dedicated absence test asserts ENOENT.
3. **AGENTS.md compliance:** no backward-compat layer, no second registry or abstraction, no compatibility alias in the runtime gate. The one AGENTS.md-adjacent issue is Finding A (retained dead parser).

---

## Findings

| # | Severity | Location | Finding | Fix |
|---|---|---|---|---|
| A | MEDIUM | `host/src/local-host-config.ts` (+ `.test.ts`) | The strict parser of the **old** direct-attach entry (validates `integrationId` + `integration {pipeName, bridgeToken}`) has **zero production consumers** — only its own test, plus the test asserting its absence from `main.ts`. It is the last retained artifact of the removed topology and contradicts the plan's acceptance criterion that no alternate direct product topology remains. | Delete both files; keep the `semantic-main-config.test.ts` assertion that `main.ts` lacks it. |
| B | MEDIUM | `host/src/stardew-owned-farmhand-game-session-materializer.internal.test.ts` | The inventory exclusion `/\.test-support\.ts$/` does not match `*.test-support-internal.ts`, so an approved test-support module is scanned as production. Currently harmless, but a legal test-support importer would false-fail the inventory. | Broaden to `/\.test-support(?:-internal)?\.ts$/`. |
| C | NOTE | `host/.dist-*/` | Stale compiled outputs of the deleted module remain as dot-directories. The inventory scan skips dot-dirs, so there is no test impact; they can confuse future source scans. | Remove stale `.dist-*` build leftovers. |
| D | NOTE | `tools/run-stardew-native-local-agent-ab-live.mjs` | Dev live-AB harness consumes the private adapter seam. Classified correctly as an operational harness, not a shipped product entry; unchanged and out of scope. | None. |

No BLOCKER and no HIGH finding: claims 1–4 all hold. Findings A and B are completion/robustness gaps, not correctness or authority defects in the removed-route objective.

---

## Answers to the plan's Task 6 Step 5 question set

1. Direct operator attach removed, not hidden: **yes**.
2. Preview still separate: **yes**.
3. Portfolio untouched/isolated: **yes**.
4. Coordinator sole shipped owner: **yes**.
5. No new registry/compat layer/abstraction: **yes**.
6. Owner blockers still represented: **yes**.
7. Tests prove rejection and preservation: **yes**.
8. Remaining direct callers or ambiguous imports: **none** beyond Finding A (now removed) and Finding C (untracked build leftovers).

---

## Supervisor-executed verification

The reviewer could not execute tests. The supervisor ran them on the reviewed revision:

| Command | Result |
|---|---|
| `node --test tools/run-game-operational-gate.test.mjs` | 11 / 11 pass |
| `node --test host/dist-test/integration-catalog-product.test.js host/dist-test/integration-catalog.test.js host/dist-test/stardew-owned-farmhand-game-session-materializer.internal.test.js host/dist-test/stardew-production-lifecycle-coordinator.internal.test.js` | 102 / 102 pass |
| changed-file `tsc --noEmit` (strict, exactOptionalPropertyTypes, noUnusedLocals) | clean |
| `git diff --check` | clean |
| inventory-assertion mutation (adding a materializer import to `main.ts`) | test fails, as intended; reverted |

Build note: `pnpm exec tsc --project tsconfig.test.json --outDir dist-test --noEmitOnError false` emits despite roughly 87 **pre-existing** type errors originating in other lanes' in-progress files. Those errors are unrelated to this change and were verified absent from the changed files by a scoped strict typecheck.

---

# VERDICT: NO BLOCKER

The route removal is real, complete, and test-protected. Findings A and B were addressed by the supervisor after this review; C and D are informational.
