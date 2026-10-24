#!/usr/bin/env node
/**
 * One mod, one directory name, in three places that must agree.
 *
 * A split between them is not cosmetic and it is not self-announcing. Measured
 * 2026-10-24: MSBuild's `ModFolderName` defaulted to `GameBuddy.Stardew` while the
 * fixture deployed to `Mods/GameBuddy`, so SMAPI found the same UniqueID twice,
 * refused the duplicate and started WITHOUT the mod. The bridge pipe then never
 * appeared and the run reported `stardew_pipe_not_listening` after a 150 second
 * wait - twice, while the real cause was a directory name. Removing a folder by
 * hand did not help, because the next fixture transaction restored what it had
 * deployed.
 *
 * So the three places are asserted together, against one exported constant:
 *
 *   1. `integrations/stardew/GameBuddy.Stardew.csproj` sets `ModFolderName`;
 *   2. the fixture profile builds its Mod paths from `STARDEW_MOD_FOLDER`;
 *   3. the ladder launcher reads the Mod config from the same constant.
 *
 * The scan is literal-string based on purpose: it is checking that no file spells
 * the name a second time, which is exactly the thing a shared constant prevents.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { STARDEW_MOD_FOLDER, STARDEW_MOD_FOLDER_ALIASES } from "./lib/stardew-mod-folder.mjs";

const REPO = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1");
const PROJECT = join(REPO, "integrations", "stardew", "GameBuddy.Stardew.csproj");
const PROFILE = join(REPO, "tools", "lib", "stardew-fixture-profile.mjs");
const LAUNCHER = join(REPO, "tools", "live-run", "game", "launch-ladder-live.mjs");

const findings = [];
const report = (path, message) => findings.push({ path, message });

const csproj = readFileSync(PROJECT, "utf8");
const declared = /<ModFolderName>\s*([^<]+?)\s*<\/ModFolderName>/u.exec(csproj);
if (declared === null) {
  report(
    "integrations/stardew/GameBuddy.Stardew.csproj",
    `must declare <ModFolderName>${STARDEW_MOD_FOLDER}</ModFolderName>`,
  );
} else if (declared[1] !== STARDEW_MOD_FOLDER) {
  report(
    "integrations/stardew/GameBuddy.Stardew.csproj",
    `declares ModFolderName=${declared[1]} but the fixture and launcher deploy to ${STARDEW_MOD_FOLDER}`,
  );
}

for (const [label, path] of [
  ["tools/lib/stardew-fixture-profile.mjs", PROFILE],
  ["tools/live-run/game/launch-ladder-live.mjs", LAUNCHER],
]) {
  const source = readFileSync(path, "utf8");
  if (!source.includes("STARDEW_MOD_FOLDER")) {
    report(label, "must build the Mod path from STARDEW_MOD_FOLDER rather than spelling the name");
  }
  // A second spelling of the directory name under Mods is the split itself.
  for (const alias of STARDEW_MOD_FOLDER_ALIASES) {
    const spelled = new RegExp(`"Mods"\\s*,\\s*"${alias.replace(/\./gu, "\\.")}"`, "u");
    if (spelled.test(source)) report(label, `spells "${alias}" literally under Mods instead of using the constant`);
  }
}

if (findings.length === 0) {
  console.log(`stardew_mod_folder: ${STARDEW_MOD_FOLDER} (csproj, fixture profile, launcher agree)`);
  process.exit(0);
}
for (const finding of findings) console.error(`stardew_mod_folder_mismatch:${finding.path}:${finding.message}`);
console.error(`stardew_mod_folder_mismatch: ${findings.length} of 3 places disagree`);
process.exit(1);
