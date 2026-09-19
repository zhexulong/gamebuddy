# Chat Production Topology Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the project's `subagent-driven-development` skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 Chat production artifact 从旧 `dialogue-web` 服务器路径到当前 `dialogue-web-main`/Tavern pipeline 组合的收敛，并删除没有剩余消费者的 ongoing-interaction Memory 注入工具；最终必须由 freshly built production artifact 上的真实 loopback listener + real browser live journey 证明玩家可观察功能一致，但不宣称 Chat MVP 已完成。

**Architecture:** 保留 `host/src/dialogue-web-main.ts`、`host/src/reference-pipeline-dialogue-web.ts`、`host/src/tavern-management-dialogue-web.ts` 作为当前 production composition；旧的 `host/src/dialogue-web.ts` 不再进入 artifact、测试或 production import boundary。Production artifact 的 entry/verification roots、静态资源验证和 import-boundary checker 必须保持 fail-closed，并且不能通过 compatibility alias 恢复旧路径。一次性 `tools/run-ongoing-interaction-memory-injection.mjs` 只有在全仓库无调用者且不属于 current task/release gate 时删除。测试分层遵循 pure domain policy → adapter/contract → production composition → live browser journey；本 cleanup 只补足已有分层中的缺口，不在同一 slice 引入新的通用 framework。

**Tech Stack:** Node.js ESM, TypeScript, pnpm, Node test runner, Playwright, existing Host production artifact builder and static import-boundary checker.

**Spec:** `design/90_SIMPLIFIED_PI_BACKED_CHAT_PRODUCT_IMPLEMENTATION_PLAN.md`; current task context `design/tasks/active/chat-mvp.md`; distribution boundary `design/103_WINDOWS_DISTRIBUTION_AND_DESKTOP_PRESENTATION_DESIGN.md`.

## Global Constraints

- `design/90` is the current Chat execution authority; `design/40` is retired and must not be used as a release gate.
- Keep the fresh semantic SQLite Chat authority; do not restore legacy JSON, import/migration, fallback, dual-read/write, or read-repair paths.
- Chat and Game remain independent surfaces; this cleanup does not change Game/action ownership or lifecycle.
- Browser code must not receive provider credentials, prompts, raw Memory references, or Pi session internals.
- The production artifact must be composed from the configured entry and verification roots and must reject unreachable JavaScript and unallowlisted resources.
- Do not commit `.pi/`, `.worktrees/`, `plans/`, `subagent-reports/`, generated build output, temporary browser artifacts, or other ignored/local tooling material.
- Do not add a compatibility facade, forwarding route, alias, fallback, or migration for the retired `dialogue-web` path.
- This cleanup does not close `design/tasks/active/chat-mvp.md`; Chat Stop/failure/retry and Memory CRUD remain separate product work unless already implemented and independently evidenced.
- Unit tests, static checkers, fixture-only composition, Vite-only browser tests, or a successful build cannot close this plan. The final gate must run the freshly built immutable Host generation, open its real authenticated loopback listener in a real browser, and exercise the declared observable Chat regression journey without `page.route()` or mock HTTP interception.
- The live gate may use synthetic non-secret dialogue content and a test-owned fresh data root, but it must consume production artifact modules and production route/composition code. It must not use the user's existing Pi installation, session, credentials, extensions, skills, prompts, or data.

---

## Frozen Slice Card

```text
User-visible result:
The shipped Chat page still opens from the current production artifact, accepts an ordinary player turn through the real Host listener, visibly reflects the resulting state, survives reload, and leaves basic Tavern management reachable after the obsolete server/tool code is removed.

In scope / explicit non-goals:
In scope: production root/config closure, import-boundary roots, deletion of the retired dialogue-web implementation/tests and no-consumer injection tool, focused tests, artifact build, live browser regression.
Non-goals: new Chat semantics, provider onboarding, real-provider product acceptance, Memory CRUD implementation, Game lifecycle, Guardian implementation, compatibility aliases, broad architecture refactor.

Required topology and authority boundary:
Freshly built immutable Host production generation → current dialogue-web-main/Tavern composition → authenticated loopback HTTP/SSE → real Chromium page. Browser receives only public DTOs; semantic SQLite/TurnLedger remain Host-owned.

Acceptance scenario:
Given a fresh production artifact generation and test-owned Chat root,
When the current Chat browser surface is opened through its real loopback listener and a synthetic player turn is submitted,
Then the production route/composition accepts the turn and the browser visibly projects the resulting state,
And reload reconstructs the same durable public state,
And the basic Tavern management surface remains reachable,
And no retired dialogue-web module or ongoing-memory injection tool participates.

Scenario-batch boundary:
Artifact/config cleanup, checker alignment, deletions, build, and live browser regression are delivered together; any failed build, inability to launch the real listener/browser, or behavior mismatch blocks completion and commit.

Cheapest checks and final verification:
Node focused artifact/checker tests after each seam; TypeScript production/test typechecks; production artifact build; Playwright against the freshly published generation; final diff/check/reference audit.

Mutation lanes and owned paths:
One writer lane owns only the files listed in this plan. Existing Guardian/native-helper edits in shared artifact files are preserved but treated as a named external dependency and must not be newly expanded by this cleanup.

Independent read-only lanes:
One scout identifies the narrowest existing live production journey and gaps; one final fresh reviewer audits scope, architecture, and evidence.

Launch budget:
One scout, one writer, one final reviewer; one live browser batch after all non-live preflight passes; no game/native mutation.

Stop/escalation condition:
Stop if current dirty artifact changes cannot be safely separated, if the live journey requires new product semantics/credentials, if the production generation cannot build, or if two failed gates occur without a changed hypothesis.
```

---

## Scope and File Map

### Files already in the change set and owned by this plan

- Modify: `host/production-artifact.config.json` — remove obsolete production root/verification declarations while retaining current Tavern roots.
- Validate only: `host/scripts/build-production-artifact.mjs` — current dirty implementation already composes the current browser/Host closure; this cleanup stages no builder hunk.
- Validate only: `host/scripts/production-artifact.mjs` — current dirty implementation already enforces the required closure; this cleanup stages no runtime artifact hunk.
- Modify: `host/scripts/production-artifact.test.mjs` — test the updated configuration and closure behavior.
- Modify: `tools/check-host-production-import-boundary.mjs` — scan the current production roots and preserve the restrictive boundary rules.
- Modify: `tools/check-host-production-import-boundary.test.mjs` — cover the new root set and fail-closed cases.
- Validate only: `third_party/README.md` — no stale retired-path wording remained in the Chat slice; its unrelated dirty version update stayed unstaged.
- Delete: `host/src/dialogue-web.ts` — obsolete production server implementation.
- Delete: `host/src/dialogue-web.test.ts` — tests for the deleted implementation.
- Delete: `tools/run-ongoing-interaction-memory-injection.mjs` — one-shot tool with no remaining repository consumer.

### Files explicitly not owned by this cleanup

- `host/src/dialogue-web-main.ts`, `host/src/reference-pipeline-dialogue-web.ts`, `host/src/tavern-management-dialogue-web.ts` and their current tests: retain and validate; do not rewrite their product behavior here.
- `host/src/tavern/**` Chat/Memory runtime owners: do not add Stop, retry, CRUD, or new evidence machinery in this cleanup.
- `packages/voice-protocol` and `packages/game-action-devkit`: no current dirty deletion; do not touch them.
- Ignored/local artifacts and tool directories: do not stage or commit them.

---

### Task 1: Establish the retirement inventory

**Files:**
- Inspect: all tracked files under `host/`, `tools/`, `dialogue-web/`, `third_party/`.
- Test: repository search results and `git diff`/`git status` output.

**Interfaces:**
- Consumes: current `design/90`, `design/tasks/active/chat-mvp.md`, and the existing dirty diff.
- Produces: a verified list of production consumers, test consumers, release/checker consumers, and no-consumer retirement candidates.

- [x] **Step 1: Confirm the dirty set and ignored-path boundary.**

Run:

```powershell
git status --short --untracked-files=all
git diff --name-status
git check-ignore -v .pi .worktrees plans subagent-reports
```

Expected: only tracked product files in the declared scope are candidates; ignored/local artifacts are not staged.

- [x] **Step 2: Confirm production consumers of the retired server and tool.**

Run:

```powershell
git grep -n -I -e "host/src/dialogue-web" -e "from .*dialogue-web" -e "run-ongoing-interaction-memory-injection" -- ':!vendor/**' ':!.pi/**' ':!.worktrees/**' || exit 0
```

Expected: current production composition does not import the retired `host/src/dialogue-web.ts`, and no tracked command/package/CI file invokes the one-shot Memory injection tool.

- [x] **Step 3: Record the result in the plan execution notes.**

Document the exact search result and any intentional references that remain only in historical or explanatory text. Do not alter current owners merely to make the search empty.

---

### Task 2: Validate the production artifact migration

**Files:**
- Modify: `host/production-artifact.config.json`
- Validate only: `host/scripts/build-production-artifact.mjs`
- Validate only: `host/scripts/production-artifact.mjs`
- Test: `host/scripts/production-artifact.test.mjs`

**Interfaces:**
- Consumes: `dialogue-web-main` and the current Tavern verification roots.
- Produces: a production artifact configuration whose closure is rooted only in live production composition and required verification modules.

- [x] **Step 1: Run focused artifact tests before changing behavior.**

Run:

```powershell
node --test host/scripts/production-artifact.test.mjs
```

Expected: baseline results are captured; any failure is classified as pre-existing or caused by the dirty migration.

- [x] **Step 2: Verify the configured root graph.**

Check that `entryRoots` contains only actual Host production entries and `verificationRoots` contains the exact current verification modules. The configuration must not name deleted `dialogue-web` code, and the builder must retain browser artifact verification and Magic Context package verification.

- [x] **Step 3: Keep closure checks restrictive.**

The implementation must continue to reject:

```text
production_entry_missing
production_module_unreachable_from_entry_roots
production_test_artifact_forbidden
production_file_not_allowlisted_resource
production_legacy_continuity_module_forbidden
```

Do not replace the closure with a broad directory copy or a compatibility entry point.

- [x] **Step 4: Run the focused artifact tests after migration edits.**

Run:

```powershell
node --test host/scripts/production-artifact.test.mjs
```

Expected: PASS, or a concrete failure showing the exact remaining migration defect.

---

### Task 3: Validate and preserve the import boundary checker

**Files:**
- Modify: `tools/check-host-production-import-boundary.mjs`
- Test: `tools/check-host-production-import-boundary.test.mjs`

**Interfaces:**
- Consumes: current TypeScript production roots and configured mounted-turn composition roots.
- Produces: a checker that rejects forbidden legacy/loader/authority imports without requiring the retired `dialogue-web` implementation.

- [x] **Step 1: Run the checker tests.**

Run:

```powershell
node --test tools/check-host-production-import-boundary.test.mjs
```

Expected: all tests pass and the test fixture does not depend on deleted production files.

- [x] **Step 2: Confirm fail-closed cases remain covered.**

The tests must still cover at minimum:

- missing or invalid production root;
- legacy continuity module/function ingress;
- dynamic `require`/`import` and runtime loader/reflection ingress;
- sensitive mounted-turn facade misuse;
- a clean current production root report.

- [x] **Step 3: Run the checker against the repository.**

Run the repository's existing checker command from `package.json` or the direct module invocation documented by the test file. Expected: `verdict: passed` for the current source tree, with no exemption for deleted legacy code.

---

### Task 4: Remove the obsolete implementation and one-shot tool

**Files:**
- Delete: `host/src/dialogue-web.ts`
- Delete: `host/src/dialogue-web.test.ts`
- Delete: `tools/run-ongoing-interaction-memory-injection.mjs`
- Validate only: `third_party/README.md`

**Interfaces:**
- Consumes: Task 1's no-consumer inventory and Tasks 2–3's current production closure.
- Produces: no tracked runtime/test/tool consumer of the retired paths and no compatibility alias.

- [x] **Step 1: Confirm deletions are safe immediately before applying them.**

Run:

```powershell
git grep -n -I -e "dialogue-web.ts" -e "run-ongoing-interaction-memory-injection" -- ':!vendor/**' ':!.pi/**' ':!.worktrees/**' || exit 0
```

Expected: only the files themselves, historical references, or intentionally non-runtime documentation are found.

- [x] **Step 2: Apply only the declared deletions.**

Delete the three files listed above. Do not use broad directory deletion and do not touch packages that are clean relative to `HEAD`.

- [x] **Step 3: Re-run reference search and inspect documentation diff.**

Run:

```powershell
git grep -n -I -e "host/src/dialogue-web" -e "run-ongoing-interaction-memory-injection" -- ':!vendor/**' ':!.pi/**' ':!.worktrees/**' || exit 0
git diff -- third_party/README.md
```

Expected: no executable consumer remains; the README describes only current dependency/topology facts.

---

### Task 5: Full regression, real production live gate, and submission decision

**Files:**
- Test: all files in this plan's change set.

**Interfaces:**
- Consumes: the cleaned current artifact and import boundary.
- Produces: reproducible validation evidence and a narrowly scoped commit only if all checks pass.

- [x] **Step 1: Run source diagnostics.**

Run the repository's AFT inspection if available, then the authoritative TypeScript checks:

```powershell
pnpm --dir host exec tsc --project tsconfig.production.json --noEmit
pnpm --dir host exec tsc --project tsconfig.test.json --noEmit
```

- [x] **Step 2: Run focused and relevant tests.**

Run:

```powershell
pnpm --dir host exec vitest run scripts/production-artifact.test.mjs
pnpm exec vitest run tools/check-host-production-import-boundary.test.mjs
```

Add the repository's existing Host test command if required by the touched modules. Do not substitute a speculative or unrelated long-running gate when a focused gate is authoritative.

- [x] **Step 3: Build the production artifact when the environment supports it.**

Run:

```powershell
pnpm --dir host run build
```

Expected: artifact build succeeds and publishes a new immutable generation through `host/scripts/build-production-artifact.mjs`, or a concrete environment/native dependency blocker is recorded. Capture `host/dist/current.json` immediately before and after the command; the live test must load the post-build generation. A timed-out or unrun build is not evidence of success.

- [x] **Step 4: Run the real production Chat live regression.**

Preflight must prove all of the following before launching Chromium:

1. the artifact build completed and `host/dist/current.json` points to the generation just built from the current source;
2. the test uses a fresh GameBuddy-owned temporary root and synthetic content;
3. the listener imports modules from that exact published generation;
4. the browser test contains no `page.route()` or alternate mock server for Host API behavior;
5. setup and teardown close browser, listener, lease/facade, and temporary root deterministically.

Run the dedicated production-live Playwright command added or selected by this task. The scenario must prove through the real loopback listener and real Chromium:

- current Chat shell/bootstrap loads from the published browser artifact;
- one synthetic player turn reaches the real production submit route and produces a visible public state transition;
- reload reconstructs the same durable public state rather than relying on in-memory DOM state;
- Stop/failure/retry behavior is checked only to the extent already implemented by the current product and must not be fabricated by route interception;
- basic Tavern management remains reachable/usable;
- no old `dialogue-web` implementation participates in the loaded module graph.

A Vite-only UI suite, fixture-only server, direct module assertion, or static artifact inventory is supporting evidence only and cannot replace this step. If real provider credentials would be required, stop and report that prerequisite rather than reading the user's Pi/credential state or substituting a mock while claiming equivalence.

- [x] **Step 5: Audit the final diff.**

Run:

```powershell
git diff --check
git diff --stat
git status --short --untracked-files=all
```

Confirm no ignored/local tools, generated output, or unrelated packages are staged.

- [x] **Step 6: Decide submission.**

Commit only the cleanup if:

1. artifact and import-boundary tests pass;
2. TypeScript checks and production artifact build pass;
3. the real production listener + Chromium live regression passes on the freshly built generation;
4. the final diff contains only the declared topology cleanup plus explicitly preserved pre-existing shared-file changes;
5. the current Chat task is not falsely marked complete;
6. no unrelated user work or local/ignored material is included.

Suggested commit message:

```text
Remove retired Chat production topology
```

If any required check fails, leave the changes uncommitted and report the exact blocker rather than forcing a partial commit.

---

## Execution Result

Completed and committed as `43896a9 Remove retired Chat production topology`.

Validation evidence:

- staged-only artifact focused suite: 49 passed, 0 failed, 7 platform/fixture skips;
- import-boundary suite: 33 passed, 0 failed, 1 platform skip; repository verdict `passed`;
- production and test TypeScript checks passed;
- isolated staged-only production build published immutable generation `g-mthloogw-39768-69fe8fb6afa6451f8797c86293f88708`;
- mounted production-route Chat journey passed in real Chromium: 8 passed;
- mounted Tavern management journey passed in real Chromium: 6 passed;
- independent final review found no cleanup blocker and confirmed the eight-file staged boundary excluded Guardian/Stardew and local generated material.

Evidence boundary: the Chat live suite exercised the published browser artifact, production route/composition, semantic store, TurnLedger, authenticated loopback listener, reload, Stop/failure projection, and real Chromium. Provider terminalization used the existing controlled mounted start seam, so this proves topology-cleanup behavior preservation but does not prove a real provider answer or close `tasks/active/chat-mvp.md`.

## Completion Criteria

- The current production artifact no longer includes or references `host/src/dialogue-web.ts`.
- The retired `host/src/dialogue-web.test.ts` and no-consumer one-shot Memory injection tool are removed.
- The current `dialogue-web-main`/Tavern composition remains the only production Chat path in the changed artifact configuration.
- Import-boundary and artifact closure checks remain restrictive and pass.
- A freshly built immutable production generation passes the declared real listener + Chromium Chat regression; supporting tests alone are insufficient.
- No compatibility facade, fallback, migration, generated artifact, ignored tool output, or unrelated package change is added.
- `design/tasks/active/chat-mvp.md` remains active unless its independent send/Stop/failure/reload/Memory CRUD criteria are separately verified.
- The cleanup is committed only when the final validation and diff audit pass.

## Non-goals and Follow-ups

This plan does not implement Chat Stop/failure/retry, Memory CRUD, provider onboarding, new Chat creation/switching, or Desktop Player release. Those remain governed by `design/90`, `design/tasks/active/chat-mvp.md`, and the Design 103/104 owners. After this cleanup, review the actual Host/Tavern code for a separate architecture proposal that strengthens business-policy purity, ports/adapters separation, composition-root readability, and test pyramids without inventing a second framework. That proposal requires user discussion and a new implementation plan before mutation.
