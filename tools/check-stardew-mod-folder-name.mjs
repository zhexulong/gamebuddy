#!/usr/bin/env node
/**
 * One mod, one directory name, in every place that names it.
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
 * Measured 2026-11-04, the same split one layer up: four PowerShell fixtures read
 * `Mods/GameBuddy.Stardew/config.json` while every fixture deploys `Mods/GameBuddy`,
 * so a correct lane died at preflight with `Missing harness path` naming a directory
 * nothing had written. The scan below is what makes that a gate rather than four
 * repairs: its population is a directory walk of `tools/`, not a list of files whose
 * authors remembered the rule.
 *
 * Three things are asserted against one exported constant:
 *
 *   1. `integrations/stardew/GameBuddy.Stardew.csproj` sets `ModFolderName`;
 *   2. the fixture profile and the ladder launcher build their Mod paths from
 *      `STARDEW_MOD_FOLDER` rather than spelling the name;
 *   3. no PowerShell harness under `tools/` spells a folder name that disagrees with
 *      it - a harness asks `Get-GameBuddyStardewModConfigPath`
 *      (tools/lib/stardew-mod-config.ps1), which asks this repo's own resolver.
 *
 * The JavaScript scan is literal-string based on purpose: it is checking that no file
 * spells the name a second time, which is exactly the thing a shared constant prevents.
 * The PowerShell scan names only the DISAGREEING aliases, so a harness that spells the
 * deployed name is not forced to change: repeating a true fact is not the split, and a
 * rule that flagged it would need an exception list instead of a property.
 *
 * red-proof: `node tools/check-stardew-mod-folder-name.mjs --root <tree>` over a copy
 *            whose csproj declares the MSBuild default, or whose PowerShell harness
 *            spells `GameBuddy.Stardew`, reports a mismatch rather than a pass
 *            (tools/check-stardew-mod-folder-name.test.mjs)
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { STARDEW_MOD_FOLDER, STARDEW_MOD_FOLDER_ALIASES } from "./lib/stardew-mod-folder.mjs";

const DEFAULT_ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, "$1");

function parseRoot(argv) {
  const index = argv.indexOf("--root");
  if (index === -1) return DEFAULT_ROOT;
  const value = argv[index + 1];
  if (value === undefined) {
    process.stderr.write("usage: check-stardew-mod-folder-name.mjs [--root <tree>]\n");
    process.exit(2);
  }
  return value;
}

const ROOT = parseRoot(process.argv.slice(2));
const PROJECT = join(ROOT, "integrations", "stardew", "GameBuddy.Stardew.csproj");
const PROFILE = join(ROOT, "tools", "lib", "stardew-fixture-profile.mjs");
const LAUNCHER = join(ROOT, "tools", "live-run", "game", "launch-ladder-live.mjs");
const POWERSHELL_HELPER = join(ROOT, "tools", "lib", "stardew-mod-config.ps1");

const findings = [];
const report = (path, message) => findings.push({ path, message });

/** The four named authorities, with the labels a finding quotes. */
const NAMED_SOURCES = Object.freeze([
  ["integrations/stardew/GameBuddy.Stardew.csproj", PROJECT],
  ["tools/lib/stardew-fixture-profile.mjs", PROFILE],
  ["tools/live-run/game/launch-ladder-live.mjs", LAUNCHER],
  ["tools/lib/stardew-mod-config.ps1", POWERSHELL_HELPER],
]);

let named;
try {
  named = NAMED_SOURCES.map(([, path]) => readFileSync(path, "utf8"));
} catch (error) {
  // The prerequisite is the four named files. One of them missing is not a tree that agrees with itself.
  process.stderr.write(
    `stardew_mod_folder_blocked:authority_unreadable: examined 0 files: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(2);
}
const [csproj, profile, launcher, powershellHelper] = named;

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

for (const [label, source] of [
  ["tools/lib/stardew-fixture-profile.mjs", profile],
  ["tools/live-run/game/launch-ladder-live.mjs", launcher],
]) {
  if (!source.includes("STARDEW_MOD_FOLDER")) {
    report(label, "must build the Mod path from STARDEW_MOD_FOLDER rather than spelling the name");
  }
  // A second spelling of the directory name under Mods is the split itself.
  for (const alias of STARDEW_MOD_FOLDER_ALIASES) {
    const spelled = new RegExp(`"Mods"\\s*,\\s*"${alias.replace(/\./gu, "\\.")}"`, "u");
    if (spelled.test(source)) report(label, `spells "${alias}" literally under Mods instead of using the constant`);
  }
}

/** Every PowerShell harness in the tree: the population is the directory, not a list. */
function powershellFiles(directory) {
  const found = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    // Dot-prefixed files are local scratch (`/tools/.tmp-*` in .gitignore), not the harness surface.
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...powershellFiles(path));
    else if (entry.name.toLowerCase().endsWith(".ps1")) found.push(path);
  }
  return found;
}

const configPathHelper = "Get-GameBuddyStardewModConfigPath (tools/lib/stardew-mod-config.ps1)";
if (!powershellHelper.includes("function Get-GameBuddyStardewModConfigPath")) {
  report("tools/lib/stardew-mod-config.ps1", "must define Get-GameBuddyStardewModConfigPath, the PowerShell seam");
}

const DISAGREEING_ALIASES = STARDEW_MOD_FOLDER_ALIASES.filter((alias) => alias !== STARDEW_MOD_FOLDER);
const harnessFiles = powershellFiles(join(ROOT, "tools"));
// The walk is a population of its own, and it is a directory: zero harnesses means the root is wrong, not that every
// harness agrees. Saying so is the difference between a measured pass and a scan that read its own empty list.
if (harnessFiles.length === 0) {
  report(
    "tools",
    `examined 0 PowerShell harness(es) under tools/, so no harness's Mod path was read - the walk found nothing ` +
      "to compare, which is not agreement",
  );
}
for (const path of harnessFiles) {
  const label = relative(ROOT, path).replaceAll("\\", "/");
  const source = readFileSync(path, "utf8");
  for (const alias of DISAGREEING_ALIASES) {
    // A path segment: the alias followed by a separator, so `GameBuddy.Stardew.dll` is not a folder spelling.
    const spelled = new RegExp(`(?:^|[\\s"'\\\\/])${alias.replace(/\./gu, "\\.")}[/\\\\]`, "mu");
    if (spelled.test(source)) {
      report(label, `spells "${alias}", which every fixture contradicts; ask ${configPathHelper} for the path`);
    }
  }
}

const examined = NAMED_SOURCES.length + harnessFiles.length;
if (findings.length === 0) {
  console.log(`stardew_mod_folder: files examined ${String(examined)}`);
  console.log(
    `stardew_mod_folder: ${STARDEW_MOD_FOLDER} (csproj, fixture profile, launcher and every tools/ PowerShell harness agree)`,
  );
  process.exit(0);
}
for (const finding of findings) console.error(`stardew_mod_folder_mismatch:${finding.path}:${finding.message}`);
console.error(
  `stardew_mod_folder_mismatch: ${findings.length} place(s) disagree with ${STARDEW_MOD_FOLDER} · files examined ${String(examined)}`,
);
process.exit(1);
