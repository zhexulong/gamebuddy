# Chat MVP Pipeline Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the current, player-usable Chat MVP as one reviewable PR on the latest `origin/main`, without importing Farmhand, Portfolio, voice-gateway, Stardew tooling, or unrelated verification lanes.

**Architecture:** The target is the active `design/90` Chat MVP, not the retired evidence-first Tavern release plans. The PR restores the complete mounted Chat production path: semantic Chat authority, authenticated Host routes, normal embedded Pi prompt/abort lifecycle, safe SQLite rereads, browser SSE/state recovery, management Memory CRUD, and the Host-owned browser artifact. It must sever accidental static dependencies from Chat construction into Game recovery and audio transport rather than silently bringing those product lanes into the PR.

**Tech Stack:** TypeScript 5.9, Node HTTP and SQLite, TypeBox, React/Vite, Playwright, embedded GameBuddy-owned Magic Context/Pi runtime, pnpm workspaces.

**Spec:** `design/90_SIMPLIFIED_PI_BACKED_CHAT_PRODUCT_IMPLEMENTATION_PLAN.md`; `AGENTS.md`.

## Global Constraints

- The PR claim is **Chat MVP pipeline**, not Tavern final release, Farmhand release, Portfolio release, or a generic runtime-hardening merge.
- Preserve the fresh semantic SQLite authority; no legacy JSON, migration/adoption, fallback, dual-read/write, or read-repair route is introduced.
- Chat and Game stay independent. Browser Chat startup must not import, start, stop, recover, or require Stardew/Farmhand runtime modules.
- Keep one embedded, tool-restricted GameBuddy-owned Pi runtime and GameBuddy-owned data roots. Do not use system Pi configuration, sessions, credentials, prompts, extensions, or storage.
- Keep loopback same-origin sessions, CSRF on writes, strict TypeBox DTO validation, bounded bodies, browser-safe errors, and normal `chat.submit` idempotency.
- Memory CRUD is owned by the vendor facade. Host and browser never access Magic Context SQLite directly.
- Do not add marker, nonce, receipt, evidence, live-fixture, attestation, source-audit, launcher, or probe machinery to the MVP route.
- Never copy all changed paths from `117c77c`/the checkpoint. Every extracted path requires a production-import, build, test, or contract reason.
- Generated output (`dist*`, `.dist`, `NuGet`, `node_modules`, test results, staging directories) is never staged.

## Slice Card

```text
User-visible result:
  A player opens the existing mounted reference Chat, sends a message, sees
  the persisted reply or ordinary failure/stopped state, reloads safely, and
  can manage Memory through create/edit/delete with immediate safe reread.

In scope:
  Chat semantic mount; reference submit/stop/failure/reload/SSE; management
  list/title/draft/World Info regressions; management Memory CRUD; embedded
  Magic Context CRUD facade; Host-owned browser artifact; focused Host/vendor/
  browser tests and CI commands that exercise those paths.

Explicit non-goals:
  Farmhand, Stardew action/bridge/control, Portfolio, voice gateway and audio
  capture/TTS, Tavern final-release claims, Chat creation/switching, Character
  import/export, provider credentials/settings UI, live fixture preparation,
  probes, launchers, or release-attestation systems.

Authority boundary:
  ChatThreadStore/semantic SQLite remain durable owners; Magic Context owns
  Memory persistence; browser consumes safe projections only; Host owns HTTP,
  mounted runtime composition, Pi prompt/abort calls, and reread projection.

Acceptance scenario:
  Given an existing mounted Chat in a GameBuddy-owned root, when the browser
  submits a message, stops it or observes a provider failure, reloads and
  reconnects, then it sees only the exact durable reread for that Chat.
  Given management Memory, when the player creates, edits, or deletes one row,
  then the route returns the bounded reread and reload preserves it.

Producer -> consumer -> verifier:
  ChatThreadStore/vendor CRUD -> Host state and event projection -> real
  mounted Chromium API/EventSource journey and direct Host/vendor tests.

Stop/escalation:
  Stop extraction if a retained Chat production import still requires a
  Farmhand, Portfolio, Stardew, or voice-gateway implementation after the
  boundary task, or if main changes require an unapproved runtime/authority
  policy change.
```

## PR Boundary

### Include

- Chat semantic authority and its direct runtime construction/deployment closure.
- `host/src/tavern/**` production and focused tests required for reference Chat and management Memory.
- `host/src/dialogue-web-main.ts`, `dialogue-web.ts`, `reference-pipeline-dialogue-web.ts`, `tavern-management-dialogue-web.ts`, launch mode, browser contract, static-shell composition, and their direct tests.
- Browser source, Vite/Playwright configuration, manifest generator, mounted reference and management tests.
- The vendor Magic Context pi-plugin/plugin sources, tests, and package metadata needed by the ordinary Memory CRUD facade and stable context runtime.
- Host production/test artifact scripts, native reparse/stale-lock source required by the retained artifact path, and their direct tests.
- Semantic package/workspace/CI/lockfile changes strictly needed for the above graph.

### Exclude

- `integrations/stardew/**`.
- Portfolio, Farmhand, bridge, companion-control, gameplay-action, game recovery, and Stardew test/tool/fixture paths.
- `voice-gateway/**`, audio capture/TTS/ASR, and voice probe tooling. A retained type-only Host boundary is acceptable only if no gateway runtime module is imported.
- Root or `tools/**` Stardew source audits, action descriptors, live runners, launchers, smoke/probe commands, fixture preparation, and evidence scoring.
- Tavern final-release live gates and fixture preparation. Retain only ordinary Chat MVP tests and commands.
- Preview entrypoints, development-only static shells, old evidence/marker/attestation code that `design/90` replaces, and generated output.

## File Structure

| Area | Responsibility in this extraction |
|---|---|
| `host/src/dialogue-web-main.ts` | Production profile dispatcher; must use a reference/management Chat composition without importing Game runtime. |
| `host/src/continuity-semantic-*` | Fresh semantic Chat authority, mount lifecycle, and direct Chat runtime construction. |
| `host/src/tavern/**` | Browser contract, durable Chat service/state/SSE, presentation route, management Memory service, and static shell. |
| `host/src/runtime.ts` and `host/src/presentation.ts` | Must expose Chat-specific dependencies without static Stardew recovery or voice-gateway implementation coupling. |
| `host/src/reference-pipeline-dialogue-web.ts` / `host/src/tavern-management-dialogue-web.ts` | Authenticated HTTP handlers and safe DTO dispatch. |
| `dialogue-web/src/**` | Browser-only API clients, reducers, reference/management components, localization, and styles. |
| `dialogue-web/tests/**` | Real mounted listener browser journeys, session/API checks, and artifact boundary tests. |
| `vendor/magic-context/packages/{pi-plugin,plugin}` | Embedded runtime, stable context, and ordinary Memory CRUD facade only. |
| `host/scripts/*artifact*`, `dialogue-web/vite.config.ts`, browser manifest script | Host-owned browser artifact build/validation. |

## Task 1: Prove and cut Chat-to-Game/voice static coupling

**Files:**
- Modify: exact production modules identified by the compiler/import trace under `host/src/runtime.ts`, `host/src/presentation.ts`, and Chat runtime construction.
- Test: their existing direct Host tests plus a new focused import-boundary assertion under `tools/` only if no existing boundary checker can express the rule.

**Consumes:** The current semantic Chat runtime constructor and current Host runtime/presentation interfaces.

**Produces:** A Chat construction dependency graph with no static runtime import of Stardew recovery, Farmhand/Portfolio control, voice gateway, audio capture, or TTS implementation.

- [ ] **Step 1: Write an import-boundary characterization test.**

The test reads the emitted production closure from the Chat entry and asserts no retained module path matches:

```ts
const forbidden = [
  /(?:^|\/)stardew(?:-|\/)/u,
  /(?:^|\/)farmhand(?:-|\/)/u,
  /(?:^|\/)portfolio(?:-|\/)/u,
  /(?:^|\/)voice-gateway(?:\/|$)/u,
  /(?:^|\/)windows-(?:audio|capture)(?:\.|\/)/u,
];
for (const modulePath of chatProductionClosure) assert.equal(forbidden.some((rule) => rule.test(modulePath)), false);
```

The assertion is against the emitted Chat artifact closure, not a filename allowlist and not browser source alone.

- [ ] **Step 2: Run the characterization before modifying imports.**

Run the existing production artifact/import-boundary command with the new Chat closure selector.

Expected: it fails, citing the current `runtime.ts -> stardew-execution-recovery-supervisor.ts` edge and any real voice implementation edge.

- [ ] **Step 3: Create a narrow Chat runtime dependency contract.**

Move only the Chat-required runtime capabilities into a Chat-specific constructor/module. Its contract must make non-Chat collaborators optional only when they are genuinely not used by the Chat code path:

```ts
type ChatRuntimeDependencies = Readonly<{
  identityProfile: IdentityProfile;
  presentation: PresentationRuntime;
  worldBook: WorldBookBinding;
}>;

function createChatRuntime(dependencies: ChatRuntimeDependencies): ChatRuntime;
```

Do not add Game fallback implementations, no-op Game recovery, or a generic service locator. Game construction retains its existing owner and imports its recovery supervisor directly from the Game path.

- [ ] **Step 4: Separate audio typing from audio runtime construction.**

If Chat presentation needs a `VoiceSpeechPort` type, preserve it as a type-only boundary in the minimal shared type module. Do not import voice gateway/client/capture implementation from `presentation.ts` or Chat construction. When speech is unavailable, the existing `speechPort` remains absent and text presentation behavior is unchanged.

- [ ] **Step 5: Verify the boundary and direct behavior.**

Run the focused runtime/presentation tests, Chat production import-boundary check, and production typecheck. The Chat artifact closure must exclude forbidden Game/audio modules while the retained Chat text path remains type-safe.

- [ ] **Step 6: Commit the bounded boundary change.**

```bash
git add host/src/runtime.ts host/src/presentation.ts host/src/<new-chat-runtime-module>.ts \
  host/src/<direct-tests>.ts tools/<boundary-test>.mjs
git commit -m "refactor: isolate chat runtime dependencies"
```

## Task 2: Extract the semantic Chat and Chat MVP Host closure onto current main

**Files:**
- Create an extraction branch from current `origin/main`; do not modify the checkpoint branch.
- Restore/merge only the production and direct-test paths listed in the PR boundary, after Task 1's dependency split.
- Modify as needed: root `package.json`, `pnpm-workspace.yaml`, `host/package.json`, `host/tsconfig.production.json`, `host/production-artifact.config.json`, and `pnpm-lock.yaml`.

**Consumes:** Task 1's Chat-only production graph and current `origin/main`'s unrelated project configuration.

**Produces:** A buildable `origin/main + Chat MVP` extraction branch with no copied Farmhand/Portfolio/Stardew/voice-gateway paths.

- [ ] **Step 1: Build an explicit extraction manifest.**

Generate `plans/chat-mvp-extraction-manifest.txt` in the isolated worktree. Every line must be one exact copied path and one reason tag:

```text
host/src/tavern/chat-pipeline-service.ts production:reference-submit-stop
host/src/tavern/memory-management/memory-management.ts production:management-memory-crud
host/src/reference-pipeline-dialogue-web.ts production:authenticated-reference-http
...
```

The manifest must not contain broad `host/src/**`, `tools/**`, `vendor/**`, or `dialogue-web/**` globs.

- [ ] **Step 2: Copy only manifest paths from the checkpoint source.**

For each path, use the source commit content rather than filesystem copies of generated output. Before staging, reject paths matching the exclusion list and reject non-source artifact paths.

- [ ] **Step 3: Semantically merge package/build configuration.**

Preserve current main's unrelated workspace scripts and dependencies. Add only Chat MVP requirements:

- host production artifact build/start scripts;
- browser typecheck/test commands;
- vendor Magic Context isolation/build ordering;
- browser runtime/test dependencies;
- retained security overrides.

Regenerate `pnpm-lock.yaml` with pnpm after manifests are finalized; never hand-merge lockfile sections.

- [ ] **Step 4: Make the artifact root Chat-only.**

Ensure production artifact entry/verification roots include `dialogue-web-main`, reference/management Chat shells, browser manifest verifier, and direct Chat runtime roots. Remove Farmhand preview/Stardew artifact roots rather than retaining them for compatibility.

- [ ] **Step 5: Run a no-contamination audit before testing.**

```bash
git diff --name-only origin/main...HEAD | grep -Ei \
  '(^integrations/stardew/|(^|/)(farmhand|portfolio|stardew|voice-gateway)([-/]|$)|run-stardew|launch-stardew|probe|fixture-prep|\.dist/|(^|/)dist[^/]*(/|$))'
```

Expected: no output. Any exception needs a path-specific written decision in the PR description; there is no blanket exception.

## Task 3: Complete the active Chat MVP behavior through connected Host/vendor/browser seams

**Files:**
- Modify: exact Task 1 and Task 2 Chat paths listed by `design/90` Tasks 1–2.
- Test: direct Host/vendor tests and `dialogue-web` mounted reference/management browser suites.

**Consumes:** The extracted semantic Chat/artifact closure.

**Produces:** One connected Chat MVP: ordinary stop/failure/retry and management Memory CRUD with durable safe rereads.

- [ ] **Step 1: Freeze the exact MVP browser profile matrix.**

Reference profile routes are exactly `bootstrap`, `state.read`, `draft.read`, `chat.submit`, `chat.cancel`, `chat.submission_status`, and `events`. Management profile includes its existing list/title/draft/World Info routes plus `memory.read` and `memory.mutate`. Unsupported chat creation/switching, Character, Persona, Scenario, Greeting, import/export, settings, Game and voice controls remain absent from both browser projections.

- [ ] **Step 2: Add failing Host tests for normal Chat cancellation/failure.**

Tests must prove:

```ts
await service.submitAfterResponseCommit(command, respond202);
await service.cancel(currentTurnHandle, {});
assert.equal((await state.read()).turn?.state, "cancelled");
assert.equal(promptAbortCalls, 1);
assert.equal((await state.read()).operations.some((op) => op.operationId === "chat.submit"), true);
```

Add the companion failure test: a rejected `session.prompt()` projects `failed` with a browser-safe problem code, and a later submit starts exactly one new attempt. Rejections, stale handles, unauthenticated calls, bad CSRF and invalid TypeBox bodies produce no mutation.

- [ ] **Step 3: Implement ordinary cancel/failure projection without a second protocol.**

Use the existing mounted service boundary to call the active embedded session's abort once. Persist `cancelled` or `failed`, reread through the normal state facade, and project that state. Delete retired proof-only mutation/marker code when its last caller is removed; do not retain a compatibility facade.

- [ ] **Step 4: Add failing vendor and Host tests for ordinary Memory CRUD.**

The vendor facade contract is:

```ts
type PlayerMemoryCrudFacade = Readonly<{
  read(scope: { continuityId: string; runtimeCwd: string }): Promise<MemoryProjection>;
  create(scope: MemoryScope, command: { content: string }): Promise<MemoryProjection>;
  update(scope: MemoryScope, command: { handle: string; content: string; projectionRevision: number }): Promise<MemoryProjection>;
  remove(scope: MemoryScope, command: { handle: string; projectionRevision: number }): Promise<MemoryProjection>;
}>;
```

Tests prove create/edit/delete reread, stale revision conflict, unavailable facade, 4096-byte content bound, and no raw source reference/provider/session facts in the browser DTO.

- [ ] **Step 5: Implement one vendor-owned CRUD facade and mount it only in management.**

Replace the evidence-only mutation export rather than retaining it. Host maps opaque projection handles inside `memory-management.ts`, invokes vendor CRUD, and returns the fresh bounded projection. The management handler requires the existing session/CSRF/auth checks and route/profile double check. Browser reducer updates only from the response reread or subsequent state read; no optimistic durable rows.

- [ ] **Step 6: Complete mounted Chromium journeys.**

Reference journey:

```text
bootstrap -> submit -> durable reply/failure or Stop -> reload -> exact reread
-> disconnect SSE -> reconnect -> cursor replay/resync -> unchanged durable state
```

Management journey:

```text
bootstrap -> Memory create -> reload -> edit -> reload -> delete -> reload
-> stale revision -> reread/conflict message without an invented row
```

Use a real composed Host listener and deterministic embedded Pi stub. Do not use `page.route()` to mock Host APIs.

- [ ] **Step 7: Run the focused batch gates.**

```bash
pnpm --filter @gamebuddy/voice-protocol build
pnpm --filter @gamebuddy/companion-host exec tsc --project tsconfig.production.json --noEmit
pnpm --filter @gamebuddy/companion-host exec tsc --project tsconfig.test.json --noEmit
pnpm --filter @gamebuddy/dialogue-web run typecheck
pnpm --filter @gamebuddy/companion-host run build
pnpm --filter @gamebuddy/dialogue-web run test:unit
pnpm --filter @gamebuddy/dialogue-web run test:composed
pnpm --filter @gamebuddy/dialogue-web run test:mounted-reference
pnpm --filter @gamebuddy/dialogue-web run test:mounted-management
```

Run the focused Host/vendor tests that changed in the task before the batch commands. Record a blocked external provider as a normal unavailable condition; do not create a proof artifact to compensate.

## Task 4: Review, package, and publish the Chat MVP PR

**Files:**
- Modify only the extraction branch's Chat MVP paths.
- Create: PR description using the claim below.

**Consumes:** Passing Task 3 gates and the no-contamination audit.

**Produces:** One reviewable PR based on current main.

- [ ] **Step 1: Run final scope review.**

Review changed paths by category: production Host, semantic continuity, browser, vendor, artifact/config, direct test, CI. Reject unrelated Game/Portfolio/Farmhand/voice-gateway/tooling paths before commit.

- [ ] **Step 2: Run final quality checks.**

```bash
git diff --check origin/main...HEAD
pnpm check:host-production-import-boundary
pnpm build
pnpm test:dialogue-web
```

If `pnpm test:dialogue-web` is too broad because it includes excluded final-release gates, run its named component commands and state the exact omitted command/reason in the PR; do not mark it green implicitly.

- [ ] **Step 3: Commit in reviewable slices.**

Use commits in this order:

```text
refactor: isolate chat runtime dependencies
feat: restore chat mvp host and browser pipeline
feat: add ordinary chat stop and memory crud
build: restore chat-owned artifact verification
```

Do not squash unrelated source/history into one checkpoint commit.

- [ ] **Step 4: Create PR with this claim.**

```markdown
## Chat MVP pipeline

Implements the active `design/90` Chat MVP on current main:
- mounted reference Chat submit, stop/failure/retry and safe reload/SSE recovery;
- management Memory create/edit/delete with vendor-owned persistence and immediate safe reread;
- Host-owned browser artifact and real mounted Chromium coverage.

Not claimed:
- Tavern full-management/final release;
- Farmhand, Portfolio, Stardew, voice-gateway, Chat creation/switching, import/export, settings, or live-provider proof gates.

Validation:
- [exact commands and outcomes]

Scope audit:
- [path category totals]
- no `integrations/stardew`, Farmhand, Portfolio, voice-gateway, live runner, probe, launcher, fixture-preparation, or generated artifact path.
```

## Plan Self-Review

- **Spec coverage:** Task 3 covers both active `design/90` deliverables: reference Chat stop/failure/reload and management Memory CRUD. Existing list/title/draft/World Info behaviors are carried as regressions, not reimplemented. Task 1 prevents the extracted Chat route from silently importing excluded Game/audio lanes. Task 2 reconstructs the artifact/build/package closure required for a real browser product path. Task 4 prevents the previous broad-checkpoint PR failure.
- **Explicit exclusions:** Farmhand, Portfolio, Stardew, voice-gateway and final Tavern release tooling are denied at manifest, production-closure, and final-scope gates.
- **No placeholder scan:** Every task names exact ownership, behavior, commands, and stop conditions. New filenames are intentionally generated from the existing runtime module name only when the implementation reveals the narrow split point; no generic new subsystem is planned.
- **Type consistency:** Browser accepts only safe DTOs from the existing `tavern_browser_api/v1`; `PlayerMemoryCrudFacade` is vendor-owned, Host projection is opaque/revision-bound, and the Chat runtime dependency interface has no Game or audio implementation field.
