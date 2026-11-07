/*
 * Ask the product's own installation discovery where Stardew Valley is.
 *
 * This exists because a tool that guesses `D:\SteamLibrary\steamapps\common\Stardew Valley` is a second,
 * worse copy of an authority this repository already owns: `discoverStardewGameInstallation()` reads the
 * Steam registry/library provider and the GOG proposal source, names the diagnostics of a source that
 * failed, and lets a one-time player choice win over both. It is what the OOBE runs. Any runner that needs
 * the installation should ask it rather than spelling a default path: on 2026-11-07 I hand-wrote three
 * guesses and all three were wrong, while the real install sat where our own discovery finds it.
 *
 *   node tools/live-run/game/stardew-install.mjs                     auto-discover
 *   node tools/live-run/game/stardew-install.mjs --chosen <root>     the player's one-time choice wins
 *   node tools/live-run/game/stardew-install.mjs --env               honour GAMEBUDDY_STARDEW_GAME_PATH as a choice
 *
 * Exit codes: 0 resolved, 2 choice_required (printed candidates), 1 not_found or blocked.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

const DISCOVERY = join(process.cwd(), "host", "dist-test", "stardew-game-install", "index.js");

if (!existsSync(DISCOVERY)) {
  console.error(`stardew_install_blocked: ${DISCOVERY} is not built; run: pnpm --dir host build:test`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const chosenAt = argv.indexOf("--chosen");
const chosen = chosenAt >= 0 ? argv[chosenAt + 1] : undefined;
const fromEnv = argv.includes("--env") ? process.env.GAMEBUDDY_STARDEW_GAME_PATH : undefined;
const chosenInstallRoot = chosen ?? fromEnv;

const { discoverStardewGameInstallation } = await import(`file://${DISCOVERY.replace(/\\/gu, "/")}`);
const resolution = await discoverStardewGameInstallation(chosenInstallRoot === undefined ? {} : { chosenInstallRoot });

const describe = (installation) => ({
  source: installation.source ?? null,
  installRoot: installation.installRoot ?? null,
  gameExecutable: installation.gameExecutable ?? null,
  smapiExecutable: installation.smapiExecutable ?? null,
});

if (resolution.kind === "resolved") {
  console.log(
    JSON.stringify(
      { kind: "resolved", installation: describe(resolution.installation), diagnostics: resolution.diagnostics },
      null,
      2,
    ),
  );
  process.exit(0);
}
if (resolution.kind === "choice_required") {
  console.log(
    JSON.stringify(
      {
        kind: "choice_required",
        installations: resolution.installations.map(describe),
        diagnostics: resolution.diagnostics,
      },
      null,
      2,
    ),
  );
  process.exit(2);
}
console.log(JSON.stringify({ kind: "not_found", diagnostics: resolution.diagnostics }, null, 2));
process.exit(1);
