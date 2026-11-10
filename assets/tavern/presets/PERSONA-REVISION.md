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
