# Persona revision register

The shipped persona prose is the product's identity, not an implementation detail:

- `assets/tavern/presets/default-companion/card.json` and `worldbook.json` — every field, apart from
  `data.extensions.*` (the Host binding and the farmer's gameplay preferences);
- the `prompts[].name` and `prompts[].content` of every other `assets/tavern/presets/*.json`.

A commit that changes any of those fields must carry `[persona]` in its message **and** add one line below, in the
same commit. `node tools/check-persona-prose.mjs` (rung L0 of `node tools/prelive.mjs`) enforces both: a marker
without a line is red, a line without a marker is red, and neither is red. That check exists because this prose was
rewritten twice in one hour on 2026-11-10 by lanes that had been told, in writing, not to.

One line per deliberate change:

    date · commit · field · why · who asked

`commit` is the short sha of the commit that made the change (`pending` until it lands).

| date | commit | field | why | who asked |
| --- | --- | --- | --- | --- |
| 2026-11-11 | pending | presets, card.json, worldbook.json | split game and chat specialized presets and worldbooks | user |
| 2026-11-11 | pending | card.json, worldbook.json, presets | purge preachy elderly moralizing ('比工位上的报表实在'), enforce 24yo peer trauma resonance and banter | user |
| 2026-11-12 | pending | card.json (system_prompt, mes_example) | restore the four clauses a card replacement dropped (person-first, 对讲机/拒绝报备, 去班味冷幽默) and strip the `*…*` beats + third sentence from the examples, so the shipped samples are spoken turns again | user |
| 2026-11-12 | pending | worldbook.json (entries.6.keys) | drop the single-character 锅 keyword, which fired on the very sentence the always-on premise guard measures | user |
| 2026-11-13 | 4210d14e | amber-game.json (main, jailbreak) | replace broken positive declarations forcing chatter with action-with-spoken-intent and emote awareness | user |
| 2026-11-13 | 0d7b2dc2 | amber-game.json (main, jailbreak) | resolve prompt floor overlap by removing duplicate surface rules and trimming jailbreak | user |
| 2026-11-14 | pending | amber-game.json (main, jailbreak) | replace false-dichotomy note condition with strict same-turn action synchronization | user |
