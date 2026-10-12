# Memory authoring toggle — reconciliation log

Goal: reconcile the red mounted journey `dialogue-web/tests/conversation-rendering-defects.spec.ts` (defect 5,
`[data-memory-authoring-toggle]`), and sweep the mounted specs' Memory/Chats/Characters/Settings hooks.

## Findings (measured, not assumed)

- The hook is NOT missing. `data-memory-authoring-toggle` lives at `management-panels.tsx:1143` inside
  `MemoryPanel`. The Memory surface renders `MemorySurface → MemorySurfacePanel → MemoryPanel`
  (`MemorySurface.tsx:5,37`; `management-surface-panels.tsx:60` import, `:573` render). One implementation,
  not two. It has never been renamed or moved by the shell split (`git log -S data-memory-authoring-toggle`).
- The real defect is chapters-contract drift. Commit `94908942` added `chapters` to the required
  `MemoryReadV1` (`MEMORY_READ_KEYS = [apiVersion, projectionRevision, memories, chapters]`, exact-key
  validator) and to `MemoryView`, but:
  - `management-surface-panels.tsx` `memoryViewOf` dropped `chapters` and its `mutate` union lacked
    `update_chapter`/`delete_chapter`; HEAD therefore did NOT typecheck (`tsc --noEmit` exit 2, 3 errors).
  - the specs' `GET /api/tavern/v1/memory` mocks still served the pre-chapters shape, so the mounted read was
    rejected (`validateMemoryRead` -> `TavernProtocolError`), the panel fell to its error view
    (`手札没能打开。`), and the collapsed authoring toggle never mounted.

## Commands run

- `git status --short` / `git log --oneline -6` / `git rev-parse HEAD`
- `grep` the hook across repo; `git log -S data-memory-authoring-toggle -- dialogue-web/src/components`
- `git show 94908942 --stat`; `git show a618b02b:.../management-pipeline-api.ts` (MEMORY_READ_KEYS pre/post)
- `node --import tsx -e "validateMemoryRead(...)"` on the pre/post chapters mock shapes (old REJECTED,
  new ACCEPTED)
- `pnpm exec tsc --noEmit -p tsconfig.json` — HEAD exit 2, after fix exit 0
- Playwright `conversation-rendering-defects.spec.ts` (before fix: defect 5 red, timeout waiting for
  `[data-memory-authoring-toggle]`; 5 passed)
- hook sweep: `node .tmp-hook-sweep.mjs` + `node .tmp-hook-verify.mjs` over every `data-*`/test id the
  mounted specs query on Memory/Chats/Characters/Settings

## Fix (staged as one unit)

- `management-surface-panels.tsx`: `memoryViewOf` passes `chapters`; `mutate` accepts the chapter operations.
- `conversation-rendering-defects.spec.ts`, `runtime-frontend-gates.spec.ts`, `player-visible-defects.spec.ts`,
  `composed-reference-game-browser.spec.ts`: memory mocks serve `chapters: []`.

## Hook sweep result

Every Memory hook the mounted specs drive exists in `MemoryPanel` (management-panels.tsx):
`data-memory-panel/notebook/state/count/chapters/chapter/chapter-badge/filter/filter-group/authoring/authoring-toggle/handle/category/origin`.
Chats/Characters/Settings surface test ids and their `data-*` hooks all resolve (see report).
Two genuine gaps found OUTSIDE this change: `management-pipeline-browser.spec.ts` queries
`[data-import-fields]` / `[data-import-dispositions]`, which `CharacterCardImport.tsx` deliberately dropped in
`cff42f76` (component header: "no multi-step classification review") — the spec still drives the removed
two-phase flow. Not mine; reported.


## Verification (after commit afb00dc9)

- `pnpm exec tsc --noEmit -p tsconfig.json` — 0 errors.
- `node tools/check-head-typecheck.mjs` — `head_typecheck_ok rev=afb00dc9b115`.
- boundary gate `pnpm run test:artifact` — 13 pass / 0 fail.
- `playwright test tests/conversation-rendering-defects.spec.ts` — **6 passed** (was 5 passed / 1 failed:
  defect 5 timed out waiting for `[data-memory-authoring-toggle]`);
  `[defect-5] memory: lines=1 {"text":"创建","whiteSpace":"nowrap","flexShrink":"0","height":44,"width":52}`.
- `playwright test tests/composed-reference-game-browser.spec.ts` — 60 passed.
- `playwright test tests/runtime-frontend-gates.spec.ts` — 22 passed (incl. gates 6b/6c memory surfaces).
- `playwright test tests/stardew-installation-discovery.spec.ts tests/ui-hygiene-runtime.spec.ts` — 5 passed, 1 skipped.
- `playwright test tests/management-surface-panels.spec.ts` — 2 passed / 2 failed, both BEFORE any memory
  assertion: `[data-language-settings]` not rendered on `#profile=management` and no "World Info" nav button on
  the composed shell (page snapshot: Chat/Game/Chats/Characters/Settings/Memory only). Independent of this change.
- `playwright test tests/management-pipeline-browser.spec.ts` — 16 failed, all ENOENT
  `host/dist/current.json` at `startMountedManagementComposition` (no built Host generation in this checkout).
- `playwright test tests/companion-turn-browser.spec.ts tests/reference-pipeline-browser.spec.ts` — 12 failed,
  all at `startMountedReferenceComposition` (missing built generation). Neither reaches a test body.

## Panel verdict (correcting the two-implementation premise)

There is ONE Memory presentation. `MemorySurfacePanel` (management-surface-panels.tsx:474) is the wire adapter
(read + `memory.mutate` CAS + notice) and renders `MemoryPanel` (management-panels.tsx:908) at line 573; the
notebook, live count (`data-memory-count`), category/origin badges, honest empty state and the collapsed
authoring entry with `data-memory-authoring-toggle` (:1143) all live in `MemoryPanel`. The hook grep returned 0
in the wrapper file because the wrapper renders the panel that owns it — nothing to delete, and deleting either
layer would break the mount.

## Second finding (outside ownership)

`management-pipeline-browser.spec.ts` still drives the removed two-phase card-import review flow
(`[data-import-fields]`, `[data-import-dispositions]`, "Review card"): the review stage was deliberately dropped
in `cff42f76` (component header: "no multi-step classification review"), while its browser test predates that
(`019f030e`, ancestor of `cff42f76`). Every other Memory/Chats/Characters/Settings hook the mounted specs query
resolves in the component the surface renders.
