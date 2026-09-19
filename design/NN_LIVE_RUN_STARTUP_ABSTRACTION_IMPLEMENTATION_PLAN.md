# NN_LIVE_RUN_STARTUP_ABSTRACTION_IMPLEMENTATION_PLAN

> **Status:** active · owner: stardew-integration
> **Reviewed:** 2026-09-16 architecture review accepted with 5 corrections (file relocation, tools/lib boundary, cross-language contract, no speculative interfaces, upgrade existing catalog).

## Goal

Fix two core architecture defects without breaking Design 100 authority:

1. Generic layers (`composition/`) must stop importing concrete `games/stardew/*`; games become plugins injected via an upgraded `IntegrationCatalog` (nos new registry namespace).
2. Live-run start / window shape (`WindowMode` 5-state) is fragmented in PS1 scripts; promote it to one core contract consumed by both production runtime and live-run harness.

## Frozen invariants (Design 100 / 101 / AGENTS.md)

- `StardewProductionLifecycleCoordinator` stays the only process/launch owner; Guardian keeps OS-level containment (`JobObject`/`CreateProcess`) and **never** carries window shape.
- **No** second materializer / attach operation / generic dispatcher / universal launcher in `host/src/` (Design 100 §7). Harness launcher lives in `tools/lib/` only.
- Design 101 (installation registration) stays a separate prerequisite; this plan does NOT sneak a headless activation past it.
- No speculative interfaces: only interfaces with a real consumer are added. Remove existing dead code (`stardewBootstrapGuardianOwnerFactory` void-retention) when compositions are cleaned.
- `host/src/live-run/` is a generic contract area; it must not import `games/*`.

## Dependency-cruiser rules that govern relocation

- `generic-layers-must-not-import-games`: `bootstrap|containment|composition` must not import `games/`.
- `games-must-not-import-unapproved-generic-layers`: `games/` may import only `containment/auth/desktop-guardian-session.internal` and `bootstrap/roots/stardew-private-mod-profile-staging` from generic layers.

## Roadmap (each T independently reviewable)

### T1 — Window-mode contract + catalog typing (contract-first, no speculative consumer wiring)
**Owned paths:**
- `host/src/live-run/window-mode.ts` (NEW)
- `host/src/live-run/window-mode.test.ts` (NEW)
- `host/src/integration-catalog.ts` (type-level upgrade only: allow provider registration if and only if T2 needs it — otherwise leave for T2 to avoid speculative interfaces)

**Deliverable:**
```ts
export type LiveRunWindowMode = "visible" | "foreground" | "minimized" | "hidden" | "background";
export type StardewWindowMode = LiveRunWindowMode;
export function isLiveRunWindowMode(value: unknown): value is LiveRunWindowMode;
export function normalizeLiveRunWindowMode(value: string | undefined): LiveRunWindowMode;
export function windowModeToStyle(mode: LiveRunWindowMode): "Normal" | "Minimized" | "Hidden";      // hidden|background → Hidden
export function shouldCaptureWindowEvidence(mode: LiveRunWindowMode): boolean;                       // visible|foreground|minimized → true
export function windowModeEnvironment(mode: LiveRunWindowMode): Readonly<{ GAMEBUDDY_WINDOW_MODE: LiveRunWindowMode }>;
```
**Acceptance:** pure TS contract + unit tests (5-mode mapping, env shape, evidence switch, string validation); no imports of `games/*`; no production wiring touched; `tsc` green.

### T2 — Relocate Stardew role-launch logic into games/stardew + provider encapsulation
**Owned paths (move & update):**
- `host/src/composition/contained-game-runtime-platform.private.ts` → `host/src/games/stardew/lifecycle/contained-game-runtime-platform.private.ts` (Stardew role-launch plan + runtime collaborator factory)
- `host/src/composition/contained-game-runtime-platform.private.test.ts` → `host/src/games/stardew/lifecycle/`
- `host/src/composition/stardew-native-role-launch-plan.private.ts` → `host/src/games/stardew/lifecycle/`
- `host/src/composition/stardew-native-role-launch-plan.private.test.ts` → `host/src/games/stardew/lifecycle/`
- `host/src/bootstrap/wire/desktop-runtime-bootstrap.internal.test.ts` (update test fixture cp/import paths; L199-200 + platformUrl L252)
- `host/src/stardew-production-lifecycle-coordinator.internal.test.ts` (update imports to lifecycle/)
- `host/src/games/stardew/provider.ts` (NEW): `GameIntegrationProvider` implementing only interfaces with real consumers (coordinator construction, folder picker, guardian ports as actually consumed)
- `host/src/integration-catalog.ts`: upgrade `IntegrationCatalog` to register providers (only what T2 consumes)
- `host/src/composition/desktop-host-composition.ts` + `host/src/composition/desktop-host-composition.test.ts` — temporary import-path updates for the move (full decoupling deferred to T3); composition still imports the relocated files until T3 replaces with Catalog lookup

**Critical prerequisite — depcruise approved-boundary amendment:**
Direct whole-file move into `games/` triggers `games-must-not-import-unapproved-generic-layers` because `contained-game-runtime-platform.private.ts` imports `containment/runtime/contract/game-runtime.js` (type `TypedPrivateGameFacts`) and `containment/runtime/core/contained-game-runtime.js` (`createContainedGameRuntime`), which are NOT in the current approved list. The contained-game-runtime is the generic containment **launch-runtime contract** a game legitimately consumes to start a role; per the rule comment ("only consume approved boundary contracts") it belongs in the approved boundary:
- `.dependency-cruiser.host-production.cjs` `games-must-not-import-unapproved-generic-layers` pathNot gains `containment/runtime/contract` and `containment/runtime/core` as approved launch-runtime contract roots (keep existing auth-session + mod-profile-staging approvals).

**Acceptance:** the two private files (production + tests) live under `games/stardew/lifecycle/`; depcruise `generic-layers-must-not-import-games` 0 warnings AND `games-must-not-import-unapproved-generic-layers` 0 warnings after the boundary amendment; provider references only approved generic boundaries; no speculative methods; host typecheck + the two moved tests + desktop-runtime-bootstrap test green.

### T3 — Generic composition decoupled — DONE (code; full-suite validation blocked on env)
**Owned paths:**
- `host/src/composition/desktop-host-composition.ts` (decoupled: zero `games/stardew` imports; consumes `PRODUCT_INTEGRATION_CATALOG.getProvider("stardew")`; removed dead `stardewBootstrapGuardianOwnerFactory` + `createStardewBootstrapGuardianOwnerFromDesktopSession`)
- `host/src/integration-catalog.ts` (upgraded: `GameIntegrationProvider` + narrow `GameLifecycleProviderCapability` + `getProvider`/`providerIds` + `isProvider` validation)
- `host/src/integration-catalog-product.ts` (registers `createStardewGameIntegrationProvider()` next to the launcher)
- `host/src/games/stardew/provider.ts` (NEW: Stardew provider — coordinator + folder picker + guardian runtime collaborator assembly, returns only narrow lifecycle handle)
- composition tests: `desktop-host-composition.test.ts` (assertions updated to Catalog-lookup shape + no-`createStardew*`/no-`games/stardew` source guards; the L121-123 Stardew regex matches were replaced) + `integration-catalog-product.test.ts` (added provider-registration assertions)

**Verified:** `desktop-host-composition.ts` has zero `games/stardew` imports (grep clean); T3 files compile standalone with zero T3-attributable errors (remaining errors are pre-existing WIP + missing vendor `@cortexkit/pi-magic-context` junction — env-owned, other agent); provider `artifactRoot` derivation from `games/stardew/` up 3 levels equals the old composition root (semantics preserved).

**Acceptance (pending env fix):** grep shows no `games/stardew` in `composition/` ✓; depcruise both rules 0 warnings (edge audit: provider imports only approved generic boundaries — containment/auth + host-root modules not in bootstrap|containment|composition scope ✓); Core/Host tests green once vendor/store restored.

#### T4-1 — [DONE] `tools/lib/stardew-live-run.mjs` (unified harness launcher)
**Created:** Node library `launchStardewLiveRun({ gamePath, modsPath, windowMode, pipeName, timeoutMs, detached })` → `{ pid, pipeName, windowMode, close() }` + CLI `node tools/lib/stardew-live-run.mjs --game-path … --mods-path … --window-mode … [--pipe-name …] [--timeout-ms N] [--detached]` printing one JSON handshake `{ pid, pipeName, windowMode, evidenceCaptured }`.
- Window-mode mapping is a read-only mirror of the frozen T1 contract (`host/src/live-run/window-mode.ts`); the mirror carries an explicit authority note and is test-guarded; hidden/background → `windowsHide: true` spawn; env `GAMEBUDDY_WINDOW_MODE` injected per T1 contract (Mod applies the real window shape in-thread via WindowModeManagement).
- Pipe readiness mirrors `lib/stardew-named-pipe-readiness.ps1` (observational `\\.\pipe\` namespace scan, non-consuming).
- Spawn error rejects the launch promise (fail-closed, no silent 120s hang).

#### T4-2 — [DONE] `tools/run-stardew-native-local-player-move-fixture.ps1` consumes the unified tool
- Removed local `[ValidateSet(...)]$WindowMode` and the 5-state `switch`; the fixture now resolves the single-authority map at runtime via `node tools/lib/stardew-live-run.mjs --print-map` (JSON), validates the requested mode against it, and fails closed on unknown modes.
- `Start-InteractiveSmapiProcess`/`Start-Process` launch, env injection, pipe readiness, `Assert-LaunchedSmapiIdentity`, and window-evidence capture remain in the PS1 (Windows-native desktop handling is not Node-transferable); only window-mode vocabulary/validation is centralized in the tool.
- Verified: PS1 parse clean; GAMEBUDDY_WINDOW_MODE env + -print-map integration in place.

#### T4-3 — [DONE] `tools/lib/stardew-live-run.test.mjs` (8 tests)
Covers 5-mode style mapping, evidence switch, frozen env envelope, mode predicate/validation fail-closed, CLI `--print-map` JSON shape, CLI fail-closed on invalid/missing mode, and pre-spawn input rejection (relative path, bad pipe name, fake mode). **8/8 pass.**


### T5 — Task 6 gate unified window mode — DONE (code; full run blocked on env)
**Owned paths:**
- `tools/run-game-operational-gate.mjs` (config schema gains `windowMode`; exported `validateGateWindowMode()` mirror of the live-run contract; fail-closed on any non-frozen value)
- `tools/run-game-operational-gate.test.mjs` (+validation test: 5 modes accepted, 3 invalid shapes rejected)
- `design/tasks/active/open-gameplay-release.md` (gate config note: windowMode documented)
- Local `t6-gate-config/gate.json` updated to `windowMode: "hidden"` (default background orchestration)

**Deliverable:** gate config accepts the frozen 5-state window mode; `hidden` default for automated background runs; `visible` for manual visual verification; validation is a single-authority mirror of the T1 contract.

**Verified:** gate focused tests 3/3 (window-mode validation + config separation + parser); CLI config accepted with windowMode.

**Acceptance status:** code complete; the full Task 6 live run remains blocked on the environment (vendor/store junction fixes owned by another agent) and on the launch-side wiring (guardian/launcher window-mode propagation is a follow-on decision per Design 100 headless prerequisites).

## Explicit non-goals

- No second authority, dispatcher, universal launcher, or materializer in `host/src`.
- No Design 101/headless activation work here.
- No speculative Provider methods without a real consumer.
- No functional change to Guardian containment semantics.

## Execution

- subagent-driven; one writer per T; owner paths disjoint; keep dirty mixed WIP untouched; no destructive git ops; report exact changed paths + depcruise/tsc/test output per T.