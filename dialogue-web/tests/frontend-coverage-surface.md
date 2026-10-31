# The frontend's uncovered surface, ranked

The ranked reading is printed by the coverage run
(`pnpm --filter @gamebuddy/dialogue-web test:coverage`);
`node dialogue-web/scripts/frontend-coverage-surface.mjs` re-renders it from
`coverage/summary.json` to stdout. This file is the *reading* of that output and is
**hand-curated**, not generated - the script writes no file. The gate in
`tests/frontend-coverage-report.mjs` protects the group floors, and this list says
which untested behaviour a defect would hurt.

Ranked by **"if this breaks, does the player get a state they cannot leave"** - not by
percentage, and not by uncovered line count. A module at 0% that is imported by nothing
is cheap; a 40-line branch that strands the player in a modal with no way forward is not.

The families are `AGENTS.md`'s:

- **zero-forward-path** - a reachable non-terminal state with no valid forward action.
- **lost draft** - typing discarded on an API, validation or network failure.
- **lossy round-trip** - an accepted field or metadata silently lost on read-back.
- **first-viewport** - the primary control not fully visible without container scroll.
- **stored-not-sent** - a value accepted and stored that never reaches the execution path.
- **surface isolation** - a surface-specific instruction or tool binding leaking to another.

## The two modules no mounted journey reached

"No journey reached it" is a statement about the **mounted** population: the collector in
`tests/frontend-coverage.ts` only measures pages a Playwright journey opened, so a module
imported solely by a `node --test` spec reads 0% here while being well tested. That
distinction is what the earlier version of this file got wrong, and it is why the two rows
below now differ.

| Module | Lines | Group | What it is | Why it matters |
| --- | --- | --- | --- | --- |
| `management-pipeline-session.ts` | 434 | state | The session object that owns the Management pipeline's `get`/`mutate` loop: reads a snapshot, applies a mutation, re-reads on revision conflict. | **Deleted** in `f2159b13`. It was a second draft/revision authority over facts `SurfaceDrafts` now owns, and no module in `src` imported it - so mounting it would have created a second authority rather than fixing anything. Being unreachable, it could not have caused a runtime defect either: the draft-deadlock family and this coverage gap were separate findings. |
| `pi-settings-model.ts` | 154 | wire | The Pi settings projection: `en` defaulting, per-field localisation of model settings. | **Kept: unmounted, but tested.** It has no mounted journey and no in-`src` importer, so it reads 0% above - but `tests/pi-settings-model.test.mjs` exercises it directly in 8 `node --test` cases, including the lossless-round-trip and partial-accept invariants for Pi's own `models.json`. A module that is unmounted but gated is library code, not residue. |

**Finding, now resolved for one row:** neither module was reachable from `src` by static
import. `management-pipeline-session.ts` was residue of a pipeline the product no longer
mounts (the Management surface renders from `management-pipeline-api.ts` validators plus
`management-panels.tsx`) and was deleted. `pi-settings-model.ts` looks the same by import
graph but is not the same by risk: deleting it would delete a live gate on a named defect
family, so it stays. What would still change the second answer is a mount, not a deletion.

## Ranked, highest risk first

### 1. `GameStatePanel.tsx` - 54.0%, 421 untested lines

The Game surface's whole lifecycle panel. Untested blocks and the family a defect there
belongs to:

| Lines | Behaviour | Family |
| --- | --- | --- |
| 475-535 | The **session group**: Stop, Disconnect, and the whole Endgame control (`game-endgame-open` → confirm → `game-endgame-confirm`), plus their failure sentences. | **zero-forward-path** - this is the group that ends or leaves a run. An arm/confirm pair that can arm and never confirm, or a Stop that fails and leaves no retry, strands a live game with no exit. |
| 549-561 | `gameEndgameConfirmNo` - backing out of the Endgame confirmation. | **zero-forward-path** - the cancel half of the pair above. |
| 611-649 | Resume / Cancel / create-new-game: the three ways out of a failed Resume. | **zero-forward-path** - the explicit recovery surface. |
| 654-729 | The create-game form (`gameCreateFormTitle`, integration, continuity binding, create). | **lost draft** - a form whose failure path is untested is where typed setup text disappears. |
| 251-293 | The panel's own named state, including `gameStateUnavailable` and its re-read control. | **zero-forward-path** - the unavailable read is a terminal-looking state; the control that leaves it must exist. |
| 361-391 | Setup / activation: in-progress, failed, not-configured sentences. | *stored-not-sent* adjacent: the activation a player pressed but the panel reports as failed. |
| 441-458 | Syncing / reopen-in-progress / reopen-failed. | zero-forward-path |

Why it ranks first: it is the one panel whose untested half is *entirely* the
end-or-recover half. The covered half is the farm facts a player reads.

### 2. `MessageBubble.tsx` - 76.5%, 273 untested lines

The transcript row. Ranked second because a defect here is silent rather than blocking.

| Lines | Behaviour | Family |
| --- | --- | --- |
| 998-1002 (in the 929-1002 block) | The Delete control (`message-delete`) and its `deletePair` confirm pairing. | **zero-forward-path** - delete with an unconfirmable confirmation. |
| 748-779 | The rewind confirmation (`message-rewind-confirm`): prompt, arm, cancel. | **zero-forward-path** - rewind is destructive and irreversible; an arm with no cancel is a trap. |
| 705-745 | The swipe-variant remove pair (`message-swipe-remove`). | zero-forward-path / lossy round-trip |
| 568-619 | The row's two keyboard paths (Escape cancels, Enter confirms) for both destructive pairs. | **zero-forward-path** - the keyboard route out of an armed pair. |
| 89-95, 122 | The opening-switcher vocabulary and swipe arrow accessible names. | surface isolation (the two vocabularies must not be interchangeable) |

### 3. `management-surface-panels.tsx` - 89.6%, 190 untested lines

| Lines | Behaviour | Family |
| --- | --- | --- |
| 1013-1082 | Chat retention: archive/trash confirmation pair (`chat-retention-confirm`, `-yes`, `-no`). | **zero-forward-path** - the destructive pair on a whole conversation. |
| 1109-1179, 1450-1696 | Failure/success sentences after a Connection write. | *stored-not-sent*: a write reported as stored that never reached the Host. |
| 1235-1400 | The Game prompt-addition editor (save, unavailable, failure). | **lost draft** - a refused save must keep the text; `prompt-addition-refusal-keeps-the-text.spec.ts` covers the sibling surface but not this mount. |
| 800-990 | Opening-option expand/commit, chat rename, chat export. | first-viewport (the expand/commit affordance) |

### 4. `CharactersSurfacePanel.tsx` - 91.4%, 149 untested lines

The world-book editor. Ranked here because its gaps are all *one data structure's* edges.

| Lines | Behaviour | Family |
| --- | --- | --- |
| 1380-1582 | Attach / detach / delete a world-book entry, with its confirmation pair. | **lossy round-trip** - a detach that silently drops the entry's keys. |
| 635-794 | The world-book entry editor (title, keys, hint) and its submit/cancel. | **lost draft** - the editor's own cancel must not lose a half-typed entry. |
| 1065-1127 | `worldBookDetailFailed` and the key separator. | lossy round-trip (the separator is what the Host parses keys by) |

### 5. `management-panels.tsx` - 87.1%, 222 untested lines

Untested blocks are the Connection settings form (credential operator-provided vs
bring-your-own), the five effort levels, voice settings with accept/revoke, and the
**Memory chapter refresh/remove/search** controls (1277-1653).

| Family | Where |
| --- | --- |
| **lost draft** | 1450-1653: the Memory search field and its filter, plus chapter remove. |
| *stored-not-sent* | 460-705: a connection saved with a credential shape the form did not send. |
| first-viewport | 1076-1271: the voice consent disclosure's accept/revoke. |

### 6. `CompanionInspectorDrawer.tsx` - 77.0%, 141 untested lines

| Lines | Behaviour | Family |
| --- | --- | --- |
| 438-496 | The five delete-refusal sentences (`companionDeleteConflict`, `-InPlay`, `-NotFound`, `-Unreadable`, `-Failed`). | **zero-forward-path** - a companion that cannot be deleted and says nothing actionable. |
| 554-612 | The openings and world-book sections of the inspector. | lossy round-trip |
| 405-418 | The delete confirm/cancel pair. | zero-forward-path |

### 7. `Composer.tsx` - 80.1%, 62 untested lines

| Lines | Behaviour | Family |
| --- | --- | --- |
| 189-234 | The model trigger and the **draft discard** action (`draftActions.onDiscard`). | **lost draft** - discarding is fine, discarding without the confirm is not. |
| 98-147 | Placeholder and voice-state vocabulary across the four voice states. | surface isolation (voice states must not leak into the chat composer's own copy) |
| 301-311 | The send control's disabled/busy states. | zero-forward-path |

### 8. `GamePlayerSettings.tsx` - 67.2%, 97 untested lines

The whole settings form (93-296) - window mode across visible/minimized/hidden/background.
**stored-not-sent** and **lossy round-trip**: a window mode the player picked that the
Host silently keeps at a default is exactly the "accepted and stored but never reaches the
execution path" family.

### Not ranked, because their gaps are small and their behaviour is structural

`ComposedReferenceGameApp.tsx` (97.2%, 40 lines), `Timeline.tsx` (94.8%),
`SurfaceModelSettings.tsx` (88.2%), `composed-problem-view.ts` (93.9%),
`game-presentation.ts` (92.0%), `reference-pipeline-session.ts` (93.8%). These carry the
shell's routing and presentation mapping; their untested lines are branches of one
already-covered mapping, not behaviours of their own.

## What the measurement cannot see

- A page opened from a raw `browser.newContext()` is not the `page` fixture, so its
  statements are unmeasured. One journey (`persona-conflict-reread.spec.ts` locale pass)
  does this. The gap is small but it is not zero, and the report cannot name it as a line.
- Only `src/**/*.ts(x)` is in the population. `style.css` (held by another lane) is not
  measured at all; the CSS gates in the static zone are its coverage.
