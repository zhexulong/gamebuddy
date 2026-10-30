# Vendored SMAPI payload (`assets/smapi/`)

Every published Host generation carries the mod loader a player's game folder is
brought to by the Game surface's one-click install. This note records what that
payload is, where its bytes came from, and what the two gates hold about it.

## What it is

`assets/smapi/win-x64/` is the unmodified Stardew Modding API **4.5.2** release
payload for Stardew Valley 1.6: `StardewModdingAPI.exe` and its managed
assemblies, the `smapi-internal/` runtime the loader needs, and the two base mods
SMAPI's own installer always provides (`Mods/ConsoleCommands`,
`Mods/SaveBackup`).

`assets/smapi/SMAPI-LICENSE.txt` is SMAPI's own LGPL-3.0 licence text preceded by
a notice naming the version, the release archive it was extracted from, and the
upstream source repository the licence's source-availability term requires.

## Where the bytes came from

```
release   https://github.com/Pathoschild/SMAPI/releases/download/4.5.2/SMAPI-4.5.2-installer.zip
archive    dd01ddca7b566bfe0d3b3d2d03833496abc56c53da976241f2ab443f5484acc4
entry      internal/windows/install.dat   (that release's plain zip payload)
```

`assets/smapi/payload-manifest.json` is the payload's byte authority. It names the
release, the archive digest, the licence digest, and the **complete** file set
with each file's size and SHA-256. Nothing restates that list: the publisher, the
generation's reader, and the gates all derive their population from this one
document.

## Refreshing it

Accepting a new SMAPI version is one deliberate act:

```powershell
# 1. Extract the new release archive, and its internal/windows/install.dat payload,
#    into assets/smapi/win-x64/.
# 2. Regenerate the manifest from those bytes.
node tools/refresh-smapi-payload-manifest.mjs `
  --version 4.5.2 `
  --source-url https://github.com/Pathoschild/SMAPI/releases/download/4.5.2/SMAPI-4.5.2-installer.zip `
  --source-archive-sha256 dd01ddca7b566bfe0d3b3d2d03833496abc56c53da976241f2ab443f5484acc4
```

The script refuses a payload whose licence text is not the LGPL, and one without
`StardewModdingAPI.exe`.

## What holds it

| gate | what it asserts |
| --- | --- |
| `pnpm test:smapi-payload` (`host/scripts/check-smapi-payload.test.mjs`) | the vendored bytes match the manifest exactly; the licence is the LGPL text naming upstream; the artifact config mounts exactly this descriptor; the packager stages the payload into a generation and re-verifies the staged copy; a tampered payload fails the publish by name |
| `host/src/stardew-game-install/smapi-deployment.test.ts` | a vanilla folder becomes ready through one click; an existing loader is never rewritten; a folder with no game, no dependency file, or a conflicting file is refused before anything is written; player-owned config is preserved; the payload reader refuses a tampered or incomplete payload |
| `host/scripts/verify-self-contained-generation.test.mjs` | `reportPackagingCompleteness` names a generation missing the loader, the manifest, or the licence |
| `host/src/stardew-production-lifecycle-coordinator.internal.test.ts` | the real first-run flow: a folder refused as `mod_loader_missing` becomes `installed` and registered in one click |

## Install-time behaviour

`host/src/stardew-game-install/smapi-deployment.ts` writes the payload into the
folder the player named. The rules are part of the contract, not of the
implementation detail:

- a folder holding no `Stardew Valley.exe` is `game_installation_not_found`, and
  nothing is written;
- a folder already carrying `StardewModdingAPI.exe` is `current`, and nothing is
  written — the loader in the player's folder is the one their game will run;
- a file the payload would have to overwrite that is not the payload's own bytes
  refuses the **whole** install (`installation_conflict`): an install that mixed
  two mod loaders would run neither;
- `smapi-internal/config.json` is player-owned (`playerOwnedFiles` in the
  manifest) and is written only when absent, so a one-click install never resets
  a configuration the player already tuned;
- `Stardew Valley.deps.json` is copied to `StardewModdingAPI.deps.json`, which is
  what SMAPI's own install instructions require for the loader to start;
- a first install that does not land in full is removed, so a failed attempt
  never leaves a folder the loader can only half start from.
