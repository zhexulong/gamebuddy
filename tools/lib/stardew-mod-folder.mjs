/**
 * The one directory name a Stardew mod lives under inside `Mods/`.
 *
 * Three places spelled this name independently and disagreed:
 *
 *  - MSBuild's `ModFolderName` defaults to the project name, `GameBuddy.Stardew`;
 *  - every fixture path in this repo deploys to and reads from `Mods/GameBuddy`
 *    (`tools/lib/stardew-fixture-profile.mjs`);
 *  - the ladder launcher read its Mod config from `Mods/GameBuddy.Stardew`.
 *
 * The consequence was not cosmetic. The fixture wrote `GameBuddy/`, an older
 * `GameBuddy.Stardew/` sat beside it, SMAPI saw the same UniqueID twice, refused
 * the duplicate, started WITHOUT the mod - and the run reported
 * `stardew_pipe_not_listening` after a 150 second wait. Deleting one folder by
 * hand did not help, because the next fixture transaction restored what it had
 * deployed. Two runs were spent on that wait before the real cause was named.
 *
 * `tools/check-stardew-mod-folder-name.mjs` asserts the three places agree, so
 * the name can be changed in one place without a silent split.
 */
export const STARDEW_MOD_FOLDER = "GameBuddy";

/**
 * The bridge pipe a fixture Mod listens on, and the token it requires.
 *
 * Both are the fixture's to mint, and neither can be read from a config on a first run - there is no
 * config yet. The name lives here beside the folder name because both are "the names the launcher and
 * the Mod must agree on", and the failure mode of disagreement is the same: a 150 second wait that
 * reports `stardew_pipe_not_listening` instead of the one-line mismatch.
 *
 * This is a DEFAULT the fixture seeds into a config it creates. `bridgePipeNameFor` still reads the
 * config as the authority once it exists, so a config that names a different pipe is honoured and any
 * disagreement stays visible.
 */
export const STARDEW_BRIDGE_PIPE_NAME = "gamebuddy-stardew";

/**
 * Every directory that would make SMAPI load this mod twice: the agreed name and
 * the MSBuild default it used to have. Presence of more than one is the failure
 * the check reports.
 */
export const STARDEW_MOD_FOLDER_ALIASES = Object.freeze([STARDEW_MOD_FOLDER, "GameBuddy.Stardew"]);
