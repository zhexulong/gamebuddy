/**
 * Gate for the DUPLICATED AUTHORITY defect class: a value that must have exactly
 * one owner is re-declared as a literal somewhere else, the two copies drift, and
 * the failure surfaces late and indirectly.
 *
 * Every incident in the 2026-10-19/20 ladder session had this one root cause:
 *   - the bridge pipe name was hardcoded in the ladder orchestrator while a
 *     fixture seeded a different name into the Mod's config, so the Mod opened
 *     one pipe and the launcher listened on another;
 *   - a fixture scenario name was mapped in two layers;
 *   - a marker's meaning was owned by two components that disagreed.
 *
 * `DECLARED` names, per authority, the owner file, a pattern that finds the
 * literal value, and any other path where the literal is legitimately allowed,
 * each carrying the one-line reason that occurrence is not a second owner.
 * `findDuplicatedAuthorities` reports every other hand-authored occurrence.
 *
 * The declaration itself is a hand-written, verified fact (see each `description`
 * for the owner it was read from, and `duplicated-authority.test.mjs` for the
 * falsifier that fails once an exemption stops being earned). It is intentionally
 * exempt from its own rules: a gate has to spell the values it looks for.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Source extensions that are hand-authored. Data/generated `.json` is not scanned. */
const SCAN_EXTENSIONS = new Set([".cs", ".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ps1", ".py", ".ts", ".tsx"]);

/** Vendored, generated, or scratch trees that never own product literals. */
const EXCLUDED_DIRECTORIES = new Set([
  ".agents",
  ".audit-runs",
  ".claude",
  ".commit-snapshots",
  ".cortexkit",
  ".git",
  ".live-runs",
  ".pi",
  ".pi-subagent-sessions",
  ".pi-subagents",
  ".ruff_cache",
  ".tmp",
  ".worktree",
  ".worktrees",
  "__pycache__",
  "_devdist-mod-autodeploy",
  "_devdist7",
  "artifacts",
  "bin",
  "build",
  "coverage",
  "design",
  "dist",
  "node_modules",
  "NuGet",
  "obj",
  "scratch",
  "subagent-artifacts",
  "subagent-reports",
  "test-results",
  "third_party",
  "tmp",
  "vendor",
]);

const MAX_SCANNED_BYTES = 2 * 1024 * 1024;

/**
 * Characters that extend a match into a larger literal token. A value is only a
 * standalone literal when neither neighbour is one of these, so
 * `gamebuddy-stardew` is not read out of `gamebuddy-stardew-portfolio`, `2000`
 * is not read out of `12000`, and an action id is not read out of the fixture
 * scenario `native_pickup_forage_v1`.
 */
const TOKEN_CHARACTER = /[A-Za-z0-9_$-]/u;

/** The gate's own declaration and its fixtures spell the values on purpose, so both are exempt. */
const SELF = "tools/lib/duplicated-authority.mjs";
const SELF_TESTS = "tools/lib/duplicated-authority.test.mjs";

/** Both spell the declared values on purpose, so the exemption falsifiers do not apply to them. */
export const GATE_PATHS = Object.freeze([SELF, SELF_TESTS]);

const SELF_EXEMPTION = Object.freeze({ path: SELF, reason: "the gate has to spell the value it looks for" });
const SELF_TESTS_EXEMPTION = Object.freeze({
  path: SELF_TESTS,
  reason: "the gate's falsifiers spell the value to prove the rule can fail",
});

/**
 * Every action id the Mod's `FarmhandActionCatalog.Registrations` declares
 * (`integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs`), in file
 * order. The Mod producer owns this list; the copy here exists only so the gate
 * can recognise a hand-written re-declaration of it.
 */
const PUBLISHED_ACTION_IDS = [
  "move_to_tile",
  "equip_tool",
  "travel",
  "ride_minecart",
  "ride_bus",
  "select_mine_elevator_floor",
  "use_raft",
  "mount_transport",
  "enter_mine",
  "enter_exit",
  "till_soil",
  "pickup_forage",
  "pickup_item",
  "water_crop",
  "plant_seed",
  "fertilize_tile",
  "machine_inspect",
  "machine_load",
  "machine_collect_output",
  "collect_animal_product",
  "feed_animal",
  "use_item",
  "harvest_crop",
  "place_wood_fence",
  "place_crab_pot",
  "bait_crab_pot",
  "place_owned_object",
  "remove_placed_item",
  "break_container_source",
  "chop_tree_source",
  "break_rock_source",
  "clear_hoedirt",
  "dig_artifact_spot",
  "refill_watering_can",
  "inspect_world_map",
  "find_destination",
  "observe_scene",
  "navigate_to_destination",
  "clear_debris",
  "npc_relationship",
  "pet_animal",
  "water_pet_bowl",
  "water_slime_hutch_trough",
  "interact_npc_with_item",
  "talk_to_npc",
  "express_emote",
  "face_direction",
  "chest_store",
  "chest_retrieve",
  "chop_stump",
  "plant_sapling",
  "cut_weeds",
  "cut_grass",
  "clear_cask",
  "dress_mannequin",
  "set_sign_display",
  "deposit_silo_hay",
  "toggle_tool_light",
  "withdraw_silo_hay",
  "use_obelisk",
  "toggle_animal_door",
  "use_warp_item",
  "pan_ore",
  "claim_mail_attachment",
  "load_building_chest",
  "collect_building_chest_output",
  "scythe_crop",
  "harvest_bush",
  "harvest_fruit_tree",
  "shake_tree",
  "take_pedestal_item",
  "toggle_fence_gate",
  "craft_item",
  "cook_recipe",
  "collect_crab_pot_output",
  "shop_purchase",
  "ship_item",
  "equip_wearable",
  "unequip_wearable",
  "dismount_transport",
  "dismiss_modal",
  "answer_dialogue",
  "respond_level_up",
  "advance_day",
  "send_multiplayer_chat",
  "color_placed_object",
  "clear_fish_pond",
  "build_farm_building",
  "accept_daily_quest",
  "accept_special_order",
  "claim_museum_reward",
  "name_entity",
  "redeem_prize_ticket",
  "tailor_clothing",
  "dye_clothing_with_item",
];

const ACTION_ID_ALTERNATION = PUBLISHED_ACTION_IDS.join("|");

/**
 * A hand-written action-id list: five or more canonical ids written as a single
 * array literal that holds nothing else. One id in a `case`, a comparison or a
 * mixed capability list is a reference; a pure run of five or more ids is a
 * re-declaration of the Mod's surface.
 */
const ACTION_ID_LIST_PATTERN = `\\[\\s*"(?:${ACTION_ID_ALTERNATION})"(?:\\s*,\\s*"(?:${ACTION_ID_ALTERNATION})"){4,}\\s*\\]`;

const TRANSIENT_RETRY_WINDOW_PATTERN =
  "(?:retry_window_ms|transient_retry_window(?:_ms)?|Transient[A-Za-z]*Window[A-Za-z]*)[^\\n]{0,12}?(?:\\?\\?|=|:|\\.Be\\()[ \\t]*[\"']?\\d+";

export const DECLARED = Object.freeze([
  Object.freeze({
    id: "stardew-bridge-pipe-name",
    description:
      "The Mod's local bridge pipe name (`PipeName` in the Mod's GameBuddy.Stardew/config.json) has one owner. " +
      "Tools and Host code read it through tools/lib/stardew-bridge-pipe.mjs, never from a literal: a hardcoded copy in the " +
      "ladder orchestrator while a fixture seed wrote a different name into the config made the Mod open one pipe and the " +
      "launcher listen on another (2026-10-19, surfaced 150 s later as stardew_pipe_not_listening).",
    ownerPath: "integrations/stardew/config.example.json",
    valuePattern: "gamebuddy-stardew",
    allowedOtherPaths: Object.freeze([
      {
        path: "integrations/stardew/ModConfig.cs",
        reason:
          "the Mod's config schema default; a config that omits PipeName makes the launcher refuse " +
          "(bridge_pipe_name_invalid) instead of listening on this guess",
      },
      SELF_EXEMPTION,
      SELF_TESTS_EXEMPTION,
    ]),
  }),
  Object.freeze({
    id: "world-transient-retry-window-ms",
    description:
      "The transient body-hold retry window is one number, owned by WorldModel.TransientRetryWindowMs " +
      "(integrations/stardew/WorldModel.cs). A second numeric literal meaning the same window lets the wait the Agent is " +
      "told (`retry_window_ms`) drift from the wait the body loop actually performs.",
    ownerPath: "integrations/stardew/WorldModel.cs",
    valuePattern: TRANSIENT_RETRY_WINDOW_PATTERN,
    allowedOtherPaths: Object.freeze([
      {
        path: "host/src/stardew-action-remedy.test.ts",
        reason: "a Host test asserting the published retry_window_ms has to name the number it expects",
      },
      {
        path: "integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/BodyHoldAttributionTests.cs",
        reason: "an integration test asserting the window the Mod publishes, and the owner constant itself",
      },
      {
        path: "integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/WorldInterruptionTests.cs",
        reason: "an integration test asserting the published config value has to name it",
      },
      SELF_EXEMPTION,
      SELF_TESTS_EXEMPTION,
    ]),
  }),
  Object.freeze({
    id: "published-action-id-list",
    description:
      "The published action-surface id list is owned by the Mod producer " +
      "(integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs, FarmhandActionCatalog.Registrations). A hand-written " +
      "copy of that list in the Host or in tools is a second authority that drifts the moment the Mod adds or promotes an action. " +
      "Detected as an array literal that holds only five or more canonical ids; a case, a comparison or a mixed capability list " +
      "names actions, it does not re-declare the list.",
    ownerPath: "integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs",
    valuePattern: ACTION_ID_LIST_PATTERN,
    allowedOtherPaths: Object.freeze([
      {
        path: "host/src/protocol.ts",
        reason:
          "validateExecutionRequest groups five actions that share one {x,y,expectedTargetId} shape, the same " +
          "membership its neighbouring value.action comparisons already state: a Host argument check, not a copy " +
          "of the published surface",
      },
      {
        path: "integrations/stardew/action-development/tests/stardew-action-seam-terminals-audit.test.mjs",
        reason: "the audit test asserts the suspect seam ids it derives, so it has to name the set it expects",
      },
      {
        path: "tools/lib/stardew-native-local-player-fixture.mjs",
        reason:
          "each lane's Given set names the production actions that lane drives: authored intent, not a copy of " +
          "the published surface",
      },
      {
        path: "tools/run-stardew-native-local-player-stamina-recovery-chain-smoke.mjs",
        reason: "a harness asserting the actions its chain drove has to name them",
      },
      {
        path: "tools/run-stardew-native-local-player-water-crop-resource-recovery-chain-smoke.mjs",
        reason: "a harness asserting the actions its chain drove has to name them",
      },
      {
        path: "tools/stardew-action-gate-descriptors.test.mjs",
        reason: "a test asserting which gate descriptors expect no fixture scenario has to name the ids it derives",
      },
      {
        path: "host/src/body-program-synthesizer.test.ts",
        reason:
          "a test asserting which actions the program catalog keeps publishable, and which live_verified ones it " +
          "must refuse, has to name both sets: the list is the subject of the assertion, not a copy of the surface",
      },
      SELF_EXEMPTION,
      SELF_TESTS_EXEMPTION,
    ]),
  }),
]);

function toPosix(path) {
  return path.split(sep).join("/");
}

function isExcludedDirectory(name) {
  return (
    EXCLUDED_DIRECTORIES.has(name) ||
    name === "dist" ||
    name.startsWith("dist-") ||
    name.startsWith(".tmp") ||
    name.startsWith(".scoped") ||
    name.startsWith("_devdist") ||
    name.startsWith(".worktrees")
  );
}

function hasScannedExtension(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 && SCAN_EXTENSIONS.has(name.slice(dot));
}

function listSourceFiles(repoRoot) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (isExcludedDirectory(entry.name)) continue;
        walk(join(directory, entry.name));
        continue;
      }
      if (!(entry.isFile() && hasScannedExtension(entry.name))) continue;
      const path = join(directory, entry.name);
      if (statSync(path).size > MAX_SCANNED_BYTES) continue;
      files.push(path);
    }
  };
  walk(repoRoot);
  return files;
}

/** Character ranges that are a comment, so a literal quoted inside one is documentation, not a declaration. */
function commentRanges(text) {
  const ranges = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end === -1 ? text.length : end + 2;
      ranges.push([index, stop]);
      index = stop;
      continue;
    }
    if (character === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index);
      const stop = end === -1 ? text.length : end;
      ranges.push([index, stop]);
      index = stop;
      continue;
    }
    if (character === "#" && (index === 0 || /[\s;]/.test(text[index - 1]))) {
      const end = text.indexOf("\n", index);
      const stop = end === -1 ? text.length : end;
      ranges.push([index, stop]);
      index = stop;
      continue;
    }
    index += 1;
  }
  return ranges;
}

function isInside(ranges, position) {
  return ranges.some(([start, end]) => position >= start && position < end);
}

function hasStandaloneBoundary(text, index, length) {
  const before = index > 0 ? text[index - 1] : "";
  const after = index + length < text.length ? text[index + length] : "";
  return !(TOKEN_CHARACTER.test(before) || TOKEN_CHARACTER.test(after));
}

function lineAt(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) if (text[cursor] === "\n") line += 1;
  return line;
}

function lineTextAt(text, index) {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const end = text.indexOf("\n", index);
  return (end === -1 ? text.slice(start) : text.slice(start, end)).trim();
}

/**
 * Every literal occurrence of a declared value outside its owner (and the paths
 * allowed to repeat it), as `{ id, path, line, text }`. `path` is repo-relative
 * and POSIX-separated so findings are stable across platforms.
 */
export function findDuplicatedAuthorities(repoRoot, declared = DECLARED) {
  const findings = [];
  const files = listSourceFiles(repoRoot);
  for (const entry of declared) {
    const owner = toPosix(entry.ownerPath);
    const allowed = new Set([owner, ...(entry.allowedOtherPaths ?? []).map((exemption) => toPosix(exemption.path))]);
    const pattern = new RegExp(entry.valuePattern, "gu");
    for (const file of files) {
      const path = toPosix(relative(repoRoot, file));
      if (allowed.has(path)) continue;
      const text = readFileSync(file, "utf8");
      const comments = commentRanges(text);
      for (const match of text.matchAll(pattern)) {
        if (!hasStandaloneBoundary(text, match.index, match[0].length)) continue;
        if (isInside(comments, match.index)) continue;
        findings.push({
          id: entry.id,
          path,
          line: lineAt(text, match.index),
          text: lineTextAt(text, match.index),
        });
      }
    }
  }
  return findings;
}

/** The one-line, greppable form the CLI prints and CI matches on. */
export function formatFinding(finding) {
  return `duplicated_authority:${finding.id}:${finding.path}:${finding.line}`;
}
