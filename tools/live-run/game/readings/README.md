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
| `gamebuddy-endgame-entry-chain.json` | **not a capture**: the `game_endgame` chain read from source, with the prerequisite matrix and the named blocker | `measured: false` |

  schema  gamebuddy-stardew-world-survival/v1
  install D:\steam\steamapps\common\Stardew Valley   (SMAPI 4.5.2 / Stardew 1.6.15 build 24356)

## What these readings do NOT cover, in their own words

The three capture files carry a `notProven` list so a green run cannot be read as covering more than it
measured, and the harness now says the same thing in the corrected words. As captured (`35d02564`) the first
entry blamed "a Pi runtime and an AI provider credential", which reading the chain does not support: endgame
never attaches, so `teardownAttachment` returns before doing anything (coordinator `:2056-2061`). The corrected
statement, in the harness and in `gamebuddy-endgame-entry-chain.json`:

- the `gameended` projection: the authenticated `game_endgame` route is reachable over real HTTP ingress with
  no AI provider credential, but its result is minted only after `containedRuntimeTeardown.settle(owner)`, and
  that teardown is built over a `DesktopGuardianSession` whose Guardian endpoint exists only in the native
  Desktop supervisor (`\\.\pipe\GameBuddy.HostGuardian.<bootstrapId>` answers `arm_attempt` / `launch_role` /
  `contain_role`; the repository's own desktop gate launcher serves `hello` and then destroys the socket on
  any of those frames - `tools/desktop-composition-launch.mjs:542-545`). Reading 6 proves the containment half
  over the public guardian control channel, not the projection;
- the desktop/browser read of that outcome: `gameended` lives in exactly one schema, `GameEndgameResultV1`
  (`host/src/game-browser-contract/index.ts:504-513`) - the state projection has no such member, so a browser
  reads instance status plus `actionAuthority` after an endgame, and no live run has held a session that could
  reach the operation;
- deployment of the Mod into a store-managed install: this gate loads the Mod from a copy of the shared
  fixture tree.

## How to reproduce one of them

    node tools/live-run/game/stardew-world-survival-live.mjs --only C

The `[C] the world was terminated by that containment, and only then` line is reading 6's verdict. The world's
disappearance is observed by polling `tools/lib/windows-process-tree.mjs` (`Get-Process -Name
'StardewModdingAPI','Stardew Valley'`, read-only, matched by PID) every 100 ms for up to 15 s after
`contain_role player_host`, so `gone_after_ms` is a measurement rather than an assumption.
