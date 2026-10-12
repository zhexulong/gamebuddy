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
