# World-survival readings

These three files are the **stdout capture** of `tools/live-run/game/stardew-world-survival-live.mjs`, kept
because the run they describe cannot be repeated without the machine: a real Stardew install, a real SMAPI, a
real world and a real Player Host.

They were produced by the committed code at `35d02564` on the machine that owns the install below, and they are
captured rather than regenerated - so treat them as evidence of one run, not as a golden file any test asserts
against.

| file | what it covers | reading |
|---|---|---|
| `…-full.json` | all three sessions in one process: ordinary close, AI crash, controller EOF | `examined=31 agreed=31 disagreements=0` |
| `…-standalone-guardian-close.json` | reading 5, the Guardian's last handle | `7/7` |
| `…-standalone-endgame.json` | reading 6, the explicit endgame's Player containment | `8/8` |

  schema  gamebuddy-stardew-world-survival/v1
  install D:\steam\steamapps\common\Stardew Valley   (SMAPI 4.5.2 / Stardew 1.6.15 build 24356)

## What these readings do NOT cover, in their own words

The JSON carries a `notProven` list so a green run cannot be read as covering more than it measured. As
captured:

- the `gameended` projection: explicit endgame's authenticated `game_endgame` operation needs a full
  desktop-composition activation (browser admission, a Pi runtime and an AI provider credential), which a
  harness cannot mint;
- deployment of the Mod into a store-managed install: this gate loads the Mod from a copy of the shared
  fixture tree.

## How to reproduce one of them

    node tools/live-run/game/stardew-world-survival-live.mjs --only C

The `[C] the world was terminated by that containment, and only then` line is reading 6's verdict. The world's
disappearance is observed by polling `tools/lib/windows-process-tree.mjs` (`Get-Process -Name
'StardewModdingAPI','Stardew Valley'`, read-only, matched by PID) every 100 ms for up to 15 s after
`contain_role player_host`, so `gone_after_ms` is a measurement rather than an assumption.
