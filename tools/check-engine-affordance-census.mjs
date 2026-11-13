#!/usr/bin/env node
/**
 * Does the companion reach the things the PLAYER can invoke? This census takes the ENGINE as its population.
 *
 * <h2>Why this file exists (measured)</h2>
 * Every coverage tool the repository already had measures our catalog against our own tasks. Measured together on
 * 2026-11-20:
 *
 *   <pre>
 *   tools/check-stardew-task-action-coverage.mjs   actions examined 103 · covered 97 · excluded 6 · tasks 23
 *   tools/derive-stardew-native-action-architecture-map.mjs   derives from OUR handlers
 *   tools/audit-totality.mjs   declared ↔ produced, inside our own tree
 *   </pre>
 *
 * All three share one blind spot: an engine affordance nobody wrote an action for is in no population at all, so
 * its absence has no reporter. That is how "there is no way to open Clint's menu" stayed invisible for months.
 * Clint's counter is a map-`Action` string (`Blacksmith`) dispatched by `GameLocation.performAction`
 * (`GameLocation.cs:9873`), which answers with the Shop / Upgrade / Process question; the Upgrade branch opens the
 * tool-upgrade shop (`GameLocation.cs:12342`, `Utility.TryOpenShopMenu("ClintUpgrade", …)`). No action claims
 * `performAction`, so nothing in the catalog could see the missing importer.
 *
 * <h2>The unit</h2>
 * One player-invocation entry, identified as `<owner type>::<marker>`. The markers are the engine's own input
 * entries, and they are a closed list because each one is a distinct way the player's world reaches game code:
 *
 *   world / object / NPC / tool   checkAction, checkForAction, performToolAction, performObjectDropInAction,
 *                                 performUseAction, performAction
 *   a question the game asked     answerDialogue
 *   a click                      receiveLeftClick, receiveRightClick
 *
 * Overloads of one marker on one type are ONE unit with several declaration sites (the count of sites is
 * evidence, not population). Grouping by type is what makes the row player-facing: `LibraryMuseum::checkAction`
 * is "the museum interior", `ShopMenu::receiveLeftClick` is "a shop's buy list", and
 * `PLAYER_FACING` names the ones whose type name does not say it.
 *
 * <h2>Derivation</h2>
 * The population is read from the decompiled tree with the repository's pinned C# grammar
 * (`web-tree-sitter` + `@vscode/tree-sitter-wasm`), never from a list: a hand-written list can only catch what
 * its author remembered and fails open the moment the game grows a menu. `activeClickableMenu = new X` is read as
 * the evidence that a type is a menu a player opens, which is what lets a `receiveLeftClick` row be read as "the
 * unmistakable click inside that menu" rather than as internal UI plumbing.
 *
 * <h2>The coverage edge, reused rather than re-derived</h2>
 * The action→engine edge is the `native-multiplayer-sensitivity` register
 * (`integrations/stardew/action-development/contracts/generated/native-multiplayer-sensitivity.v1.json`): every
 * action already records the exact `(file, signature)` of the native seam it reaches, and that register is
 * re-validated against the exact source by its own gate. So an affordance is COVERED when some action's native
 * seam is the same file and the same member — and a seam the Mod reaches through a private wrapper counts,
 * because the register records the seam the wrapper reaches (`UseNativeToolOnTile` → `DoFunction`,
 * `RideMinecart` → `MinecartWarp`). A second action↔engine mapping in this file would be a second spelling of a
 * fact the register already owns, and the two would disagree the first time one of them learned about a hop.
 *
 * A seam need not be a marker. `Object.placementAction` and `LibraryMuseum.getRewardsForPlayer` are engine calls
 * an entry reaches — they are not player entries themselves, so they are not population rows, and the fact that
 * an action claims one does not make the type's own entries reachable.
 *
 * <h2>Refusals, named and reasoned</h2>
 * An unreachable affordance is reported bare as `engine_affordance_unreachable:<type>:<marker>`, or it carries a
 * declaration whose reason comes from ONE of three kinds — never free-form prose chosen to fit:
 *
 *   <pre>
 *   not_a_player_interaction                 the marker is declared by the engine but nothing the player does
 *                                            reaches it (no detail)
 *   out_of_demo_scope:&lt;why&gt;                  a product scope decision; &lt;why&gt; must name the concrete
 *                                            impossibility, not "not needed" (40 characters minimum)
 *   reached_through_a_different_action:&lt;id&gt; the player entry is bypassed because an action drives the seam
 *                                            behind it; &lt;id&gt; must be an action in the register whose seam is a
 *                                            member of THIS type, so the reason is checkable rather than
 *                                            asserted (the gate refuses a reason it cannot verify)
 *   </pre>
 *
 * A declaration is validated in both directions, so the table cannot rot into a list nobody looked at: a reason
 * for an affordance that is covered, unknown, or declared twice fails the run. Growth is therefore visible as
 * growth of a KIND, which is the point of a closed vocabulary — a table of 200 free-form sentences hides a
 * decision, three kinds do not.
 *
 * <h2>Ratchet, not a wall</h2>
 * `tools/engine-affordance-baseline.json` records today's unreachable set as keys. A run fails on any affordance
 * that is unreachable and absent from the baseline (`engine_affordance_unreachable:<type>:<marker>`) and on any
 * marker whose unreachable count grew (`affordance_kind_grew:<marker>:<from>->&lt;to&gt;`). The set only shrinks:
 * `--record-shrinks` writes the smaller set and refuses to add a key, so accepting a NEW unreachable is a hand
 * edit a reviewer sees in the diff and never something a flag does quietly. An ABSENT baseline is the first
 * recording, which is how the census is adopted; a present one can only shrink. A baseline key that is no longer
 * unreachable is `stale_affordance_baseline:<key>` until the shrink is recorded, which is what keeps the two
 * readings (today's tree, the pinned set) from drifting apart.
 *
 * <h2>What this census does not see</h2>
 *   - a menu with no mouse entry and no world marker is invisible here: the census derives 53 menu types the game
 *     assigns to `activeClickableMenu`, and 6 of them have no `receiveLeftClick`/`receiveRightClick` row
 *     (`SaveGameMenu`, `ReadyCheckDialog`, `PendingProposalDialog`, `LocalCoopJoinMenu`, `ServerConnectionDialog`,
 *     `InviteCodeDialog`). `--report` lists them.
 *   - the selector labels inside a `performAction` dispatcher (`Blacksmith`, `Mine`, `Buy`, …) are printed as
 *     evidence on the dispatcher's row, not as population: the dispatcher is the unit, so a new selector inside an
 *     already-unreachable dispatcher is not a new affordance.
 *   - reachability is what an action's seam CLAIMS, re-validated by that gate's own Axis 3. This census does not
 *     re-prove that the Mod's handler calls the seam; two readings of one fact is the defect this file avoids.
 *
 * <h2>Usage</h2>
 *   <pre>
 *   node tools/check-engine-affordance-census.mjs [--report]
 *   node tools/check-engine-affordance-census.mjs --record-shrinks
 *   node tools/check-engine-affordance-census.mjs --source-root &lt;tree&gt; --register &lt;json&gt; --baseline &lt;json&gt;
 *   </pre>
 *
 * `--declarations &lt;json&gt;` replaces the authored table, which is what lets the falsifier hand the census a
 * population that has none of the types the real table explains.
 *
 * Exit 0 clean, 1 on a finding, 2 BLOCKED (no decompiled tree, empty population, unreadable register or
 * baseline). An absent tree is the normal state of a checkout — `ref/` is gitignored — so the same reading is
 * `blocked` on a developer machine without the decompile and in CI, never `passed`.
 *
 * red-proof: inject  a marker declaration in a copy of the tree that no action's seam claims ->
 *   `engine_affordance_unreachable:Furnace::performToolAction` + `affordance_kind_grew:performToolAction:0->1`,
 *   exit 1 (tools/check-engine-affordance-census.test.mjs)
 * red-proof: inject  a tree with C# sources and no marker declaration -> `engine_affordance_population_empty`,
 *   exit 2 (tools/check-engine-affordance-census.test.mjs)
 * red-proof: history  `LibraryMuseum::checkAction` (the museum interior the player walks up to) and
 *   `MuseumMenu::receiveLeftClick`/`receiveRightClick` (the donation grid) are unreachable today while
 *   `claim_museum_reward` cites `LibraryMuseum.getRewardsForPlayer`, so the reward desk's deeper method is claimed
 *   and the player's own way in is not (tools/check-engine-affordance-census.test.mjs, against the exact tree)
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Language, Parser } from "web-tree-sitter";

import { assertStardewDecompileRoot, STARDEW_DECOMPILE_ROOT_RELATIVE_PATH } from "./lib/stardew-decompile-root.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const CSHARP_GRAMMAR = require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-c-sharp.wasm");

/** The register that already owns the action→engine edge. Read, never re-derived. */
export const DEFAULT_REGISTER =
  "integrations/stardew/action-development/contracts/generated/native-multiplayer-sensitivity.v1.json";

/** The recorded unreachable set. */
export const DEFAULT_BASELINE = "tools/engine-affordance-baseline.json";

/**
 * The nine player-invocation entries, one per way the player's world reaches game code. Closed on purpose: adding
 * a tenth is a decision about what "the player can invoke" means, and it re-derives the whole population.
 */
export const AFFORDANCE_MARKERS = Object.freeze([
  "answerDialogue",
  "checkAction",
  "checkForAction",
  "performAction",
  "performObjectDropInAction",
  "performToolAction",
  "performUseAction",
  "receiveLeftClick",
  "receiveRightClick",
]);

/**
 * What a type is, in the player's words, where the type name does not say it. Labels only: they have no effect on
 * covered / unreachable / declared, and the falsifier asserts every key here is still a type the census derives.
 */
export const PLAYER_FACING = Object.freeze({
  GameLocation: "the map-Action tile dispatcher: every `Action` string a map tile carries",
  LibraryMuseum: "the museum/library interior (the Gunther reward desk and the donation book)",
  MuseumMenu: "the museum donation grid",
  ShopMenu: "a shop's buy/sell list (Pierre, Clint, the desert trader, Krobus, …)",
  PrizeTicketMenu: "the prize-ticket machine's counter",
  DiscreteColorPicker: "the colour palette for a placed object",
  CarpenterMenu: "Robin's build/upgrade/renovate menu",
  ForgeMenu: "the volcano forge (cinder shard combined with a weapon/ring)",
  MineElevatorMenu: "the mine elevator floor list",
  JunimoNoteMenu: "a community-centre bundle room",
  SpecialOrdersBoard: "the special-orders board",
  TailoringMenu: "Emily's sewing machine",
  InventoryMenu: "the player's own inventory grid",
  ItemGrabMenu: "a container's contents (a chest on the ground, a fridge, a shipping bin)",
});

/** The closed reason vocabulary. A growth of the table is visible as a growth of one of these. */
export const REASON_KINDS = Object.freeze([
  "not_a_player_interaction",
  "out_of_demo_scope",
  "reached_through_a_different_action",
]);

/** A `<why>` has to name something: this is the floor below which it names nothing. */
const MINIMUM_WHY_LENGTH = 40;

/**
 * Unreachable affordances whose disposition is a decision, so the census prints the decision instead of a bare
 * key. Three shapes only:
 *
 *   - `reached_through_a_different_action:<action>` — the player entry is bypassed because the action drives the
 *     seam behind it. Validated: `<action>` must be in the register AND must own a seam that is a member of this
 *     type, so a reason cannot be asserted about an action that does not reach the type at all.
 *   - `out_of_demo_scope:<why>` — a product boundary, with a why that names the concrete impossibility.
 *   - `not_a_player_interaction` — nothing the player does reaches this declaration.
 */
export const AFFORDANCE_DECLARATIONS = Object.freeze([
  Object.freeze({
    affordance: "InventoryMenu::receiveLeftClick",
    reason: "reached_through_a_different_action:shop_purchase",
  }),
  Object.freeze({
    affordance: "DialogueBox::receiveLeftClick",
    reason: "reached_through_a_different_action:dismiss_modal",
  }),
  Object.freeze({
    affordance: "LevelUpMenu::receiveLeftClick",
    reason: "reached_through_a_different_action:respond_level_up",
  }),
  Object.freeze({
    affordance: "TailoringMenu::receiveLeftClick",
    reason: "reached_through_a_different_action:tailor_clothing",
  }),
  Object.freeze({
    affordance: "TailoringMenu::receiveRightClick",
    reason: "reached_through_a_different_action:dye_clothing_with_item",
  }),
  Object.freeze({
    affordance: "CarpenterMenu::receiveLeftClick",
    reason:
      "out_of_demo_scope:a build/upgrade decision is a menu transaction with a price preview and a confirm step, and build_farm_building reaches the placed structure through GameLocation.buildStructure instead of negotiating that menu",
  }),
  Object.freeze({
    affordance: "BobberBar::receiveLeftClick",
    reason:
      "out_of_demo_scope:the fishing bar is a frame-level minigame that must be clicked within a window of game updates, and fish_here owns the native FishingRod path without an input arbiter for that window",
  }),
]);

const OWNER_KINDS = new Set(["class_declaration", "struct_declaration", "record_declaration", "interface_declaration"]);
const MENU_ASSIGNMENT = /activeClickableMenu\s*=\s*new\s+(?:StardewValley(?:\.Menus)?\.)?([A-Za-z_][\w.]*)/g;
const SELECTOR_LABEL = /case\s+"([^"\n]+)"\s*:/g;

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

/** The marker a census key names: the half after `::`. */
function markerOf(key) {
  return key.slice(key.lastIndexOf("::") + 2);
}

/** How many keys name each marker. */
function histogram(keys) {
  const counts = new Map();
  for (const key of keys) {
    const marker = markerOf(key);
    counts.set(marker, (counts.get(marker) ?? 0) + 1);
  }
  return counts;
}

let parserPromise = null;

/** The repository's pinned C# grammar, loaded once per process. */
async function csharpParser() {
  if (parserPromise === null)
    parserPromise = (async () => {
      await Parser.init();
      const parser = new Parser();
      parser.setLanguage(await Language.load(CSHARP_GRAMMAR));
      return parser;
    })();
  return parserPromise;
}

/** Every `.cs` file under `directory`, as paths relative to it with `/` separators, sorted. */
async function listSources(directory, prefix = "", out = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) await listSources(path.join(directory, entry.name), relative, out);
    else if (entry.isFile() && entry.name.endsWith(".cs")) out.push(relative);
  }
  return out.sort();
}

/** The nearest enclosing type declaration of a member — what the row is grouped by. */
function ownerOf(node) {
  let owner = node.parent;
  while (owner && !OWNER_KINDS.has(owner.type)) owner = owner.parent;
  return owner;
}

/** Record every marker declaration of one parsed source into `units`, or a collision it found. */
function collectMarkerUnits({ tree, source, relativePath, units, collisions }) {
  const stack = [tree.rootNode];
  while (stack.length > 0) {
    const node = stack.pop();
    for (const child of node.children) if (child.isNamed) stack.push(child);
    if (node.type !== "method_declaration") continue;
    const marker = node.childForFieldName("name")?.text;
    if (!AFFORDANCE_MARKERS.includes(marker)) continue;
    const owner = ownerOf(node);
    const type = owner?.childForFieldName("name")?.text ?? "<no-owner>";
    const key = `${type}::${marker}`;
    const existing = units.get(key);
    if (existing && existing.file !== relativePath) {
      collisions.push({ key, files: Object.freeze([existing.file, relativePath]) });
      continue;
    }
    const unit = existing ?? { key, type, marker, file: relativePath, sites: [], selectors: [] };
    unit.sites.push(node.startPosition.row + 1);
    const body = node.childForFieldName("body");
    if (body) {
      for (const label of source.slice(body.startIndex, body.endIndex).matchAll(SELECTOR_LABEL))
        if (!unit.selectors.includes(label[1])) unit.selectors.push(label[1]);
    }
    units.set(key, unit);
  }
}

/** One row per unit, with the label and menu evidence the report needs, sorted by key. */
function freezeUnits(units, menuTypes) {
  return [...units.values()]
    .map((unit) =>
      Object.freeze({
        ...unit,
        sites: Object.freeze([...unit.sites].sort((left, right) => left - right)),
        selectors: Object.freeze([...unit.selectors].sort()),
        playerFacing: PLAYER_FACING[unit.type] ?? null,
        opensAsMenu: menuTypes.has(unit.type),
      }),
    )
    .sort((left, right) => left.key.localeCompare(right.key));
}

/**
 * The population: one row per (owner type, marker), with every declaration site that produced it.
 *
 * Read-only against the tree. `collisions` is returned rather than merged, because two types of the same simple
 * name declaring the same marker would silently become one row and halve a count — that has to fail loudly instead.
 */
export async function deriveEngineAffordances({ sourceRoot }) {
  const parser = await csharpParser();
  const units = new Map();
  const collisions = [];
  const menuTypes = new Set();
  const files = await listSources(sourceRoot);

  for (const relativePath of files) {
    const source = await readFile(path.join(sourceRoot, relativePath), "utf8");
    for (const match of source.matchAll(MENU_ASSIGNMENT)) menuTypes.add(match[1]);
    collectMarkerUnits({ tree: parser.parse(source), source, relativePath, units, collisions });
  }

  const affordances = freezeUnits(units, menuTypes);
  // A menu the game opens that has no mouse entry and no world marker: the one shape this census cannot see.
  const typed = new Set(affordances.map((affordance) => affordance.type));
  return Object.freeze({
    filesExamined: files.length,
    affordances: Object.freeze(affordances),
    collisions: Object.freeze(collisions),
    menusWithoutAnEntry: Object.freeze([...menuTypes].filter((type) => !typed.has(type)).sort()),
  });
}

/**
 * The action→engine edge, read from the register: `<file>::<member>` → the actions that claim it.
 *
 * The register writes a seam as an exact signature (`public virtual bool checkAction`, `public void eatObject(`,
 * `public TItem Equip<TItem>(…) where TItem : Item`), so the member is the last parenthesised identifier, and the
 * generic parameter list is stripped first — otherwise `Equip<TItem>` yields the first parameter's TYPE.
 */
export function readRegisterSeams(register) {
  if (!(register && Array.isArray(register.actions)))
    fail("engine_affordance_register_invalid", "The register has no actions array.");
  const seams = new Map();
  for (const action of register.actions) {
    for (const seam of action.seams ?? []) {
      if ((seam.kind ?? "native") !== "native") continue;
      const member = nativeMemberOf(String(seam.signature ?? ""));
      if (member === "") continue;
      const key = `${seam.file}::${member}`;
      const actions = seams.get(key) ?? [];
      if (!actions.includes(action.actionId)) actions.push(action.actionId);
      seams.set(key, actions);
    }
  }
  return seams;
}

/** The member name of a register signature. Two spellings occur in the register and both must parse. */
function nativeMemberOf(signature) {
  const withoutGenerics = signature.replace(/<[^<>]*>/g, "");
  const withParens = [...withoutGenerics.matchAll(/([A-Za-z_]\w*)\s*\(/g)];
  if (withParens.length > 0) return withParens[withParens.length - 1][1];
  const tokens = withoutGenerics.trim().split(/\s+/);
  return tokens[tokens.length - 1].replace(/\(.*$/, "");
}

/** The register's actions, so a declaration's `<action>` can be proved to exist. */
export function readRegisterActionIds(register) {
  return new Set((register?.actions ?? []).map((action) => action.actionId));
}

/**
 * Split a declaration reason into its kind and detail, refusing anything the vocabulary does not carry.
 * Returns `{ kind, detail }` or throws `engine_affordance_declaration_reason_invalid`.
 */
export function parseDeclarationReason(reason) {
  const text = String(reason ?? "");
  const separator = text.indexOf(":");
  const kind = separator < 0 ? text : text.slice(0, separator);
  const detail = separator < 0 ? "" : text.slice(separator + 1);
  if (!REASON_KINDS.includes(kind))
    fail("engine_affordance_declaration_reason_invalid", `\`${text}\` is not one of ${REASON_KINDS.join(", ")}.`, {
      reason: text,
    });
  if (kind === "out_of_demo_scope" && detail.trim().length < MINIMUM_WHY_LENGTH)
    fail(
      "engine_affordance_declaration_reason_invalid",
      `\`out_of_demo_scope\` needs a why that names the impossibility (${MINIMUM_WHY_LENGTH} characters minimum), got \`${detail}\`.`,
      { reason: text },
    );
  if (kind === "reached_through_a_different_action" && detail.trim() === "")
    fail(
      "engine_affordance_declaration_reason_invalid",
      "`reached_through_a_different_action` must name the action id that reaches the seam.",
      { reason: text },
    );
  return Object.freeze({ kind, detail });
}

/** Split the population by whether an action's native seam is the same file and member. */
function splitByCoverage(affordances, seams) {
  const covered = [];
  const unreachable = [];
  for (const affordance of affordances) {
    const actions = seams.get(`${affordance.file}::${affordance.marker}`);
    if (actions) covered.push(Object.freeze({ ...affordance, actions: Object.freeze([...actions]) }));
    else unreachable.push(affordance);
  }
  return { covered, unreachable };
}

/** Does `actionId` own a native seam in the file this affordance lives in? */
function reachesTheType({ seams, actionId, file }) {
  return [...seams.entries()].some(
    ([seamKey, actions]) => seamKey.slice(0, seamKey.lastIndexOf("::")) === file && actions.includes(actionId),
  );
}

/** Why one declaration explains nothing, or null when it stands. */
function declarationRejection({ byKey, unreachableKeys, seams, actionIds, key, parsed }) {
  if (!byKey.has(key))
    return {
      code: `affordance_declaration_names_an_unknown_affordance:${key}`,
      detail: "No player entry with this key exists in the tree, so the declaration explains nothing.",
    };
  if (!unreachableKeys.has(key))
    return {
      code: `affordance_declared_but_covered:${key}`,
      detail: "An action's seam already reaches this entry. Delete the declaration.",
    };
  if (parsed.kind !== "reached_through_a_different_action") return null;
  const actionId = parsed.detail.trim();
  if (!actionIds.has(actionId))
    return {
      code: `affordance_declaration_names_an_unknown_action:${key}:${actionId}`,
      detail: `\`${actionId}\` is not an action in the register.`,
    };
  if (reachesTheType({ seams, actionId, file: byKey.get(key).file })) return null;
  return {
    code: `affordance_declaration_reason_unverified:${key}:${actionId}`,
    detail: `\`${actionId}\` owns no seam in ${byKey.get(key).file}, so it does not reach this type.`,
  };
}

/** Resolve the authored declarations against the population, recording a finding for each that explains nothing. */
function resolveDeclarations({ byKey, unreachableKeys, seams, actionIds, declarations, findings }) {
  const declaredByKey = new Map();
  for (const declaration of declarations) {
    const key = declaration.affordance;
    if (typeof key !== "string" || key.trim() === "") {
      findings.push({ code: "engine_affordance_declaration_invalid", detail: "A declaration has no affordance key." });
      continue;
    }
    if (declaredByKey.has(key)) findings.push({ code: `affordance_declared_twice:${key}`, detail: null });
    const parsed = parseDeclarationReason(declaration.reason);
    const rejection = declarationRejection({ byKey, unreachableKeys, seams, actionIds, key, parsed });
    if (rejection !== null) {
      findings.push(rejection);
      continue;
    }
    declaredByKey.set(key, parsed);
  }
  return declaredByKey;
}

/** The ratchet: a key that is not recorded, a marker whose count grew, and a recorded key that stopped being true. */
function ratchetFindings({ unreachableKeys, byKey, baseline, findings }) {
  const baselineKeys = new Set(baseline?.unreachable ?? []);
  const baselineKinds = histogram(baselineKeys);
  const currentKinds = histogram(unreachableKeys);
  for (const key of unreachableKeys) {
    if (baselineKeys.has(key)) continue;
    const affordance = byKey.get(key);
    findings.push({
      code: `engine_affordance_unreachable:${key}`,
      detail: affordance === undefined ? null : `${affordance.file}:${String(affordance.sites[0])}`,
    });
  }
  for (const [marker, count] of currentKinds) {
    const recorded = baselineKinds.get(marker) ?? 0;
    if (count > recorded) findings.push({ code: `affordance_kind_grew:${marker}:${recorded}->${count}`, detail: null });
  }
  for (const key of baselineKeys) {
    if (unreachableKeys.has(key)) continue;
    findings.push({
      code: `stale_affordance_baseline:${key}`,
      detail: "This affordance is no longer unreachable. Record the shrink with --record-shrinks.",
    });
  }
  return currentKinds;
}

/** The per-marker breakdown, in the declared marker order, with any marker the derivation met beyond that list. */
function kindRows({ affordances, currentKinds, rows }) {
  const extra = [...currentKinds.keys()].filter((marker) => !AFFORDANCE_MARKERS.includes(marker));
  return Object.freeze(
    AFFORDANCE_MARKERS.concat(extra).map((marker) => {
      const examined = affordances.filter((affordance) => affordance.marker === marker).length;
      const unreachable = currentKinds.get(marker) ?? 0;
      const declared = rows.filter((row) => row.marker === marker && row.declaration !== null).length;
      return Object.freeze({ marker, examined, covered: examined - unreachable, unreachable, declared });
    }),
  );
}

/**
 * The census, as data: today's tree, the register's edge, the authored declarations and the recorded baseline.
 *
 * Pure, so the falsifier can hand it a population the repository does not have. `affordances` is the derivation's
 * output; `seams` is `readRegisterSeams`'s map; `baseline` is `{ unreachable: [keys] }` or null.
 */
export function evaluateEngineAffordanceCensus({
  affordances,
  collisions = [],
  seams,
  actionIds = new Set(),
  declarations = AFFORDANCE_DECLARATIONS,
  baseline,
}) {
  const findings = collisions.map((collision) => ({
    code: `affordance_identity_collision:${collision.key}`,
    detail: `Two types named ${collision.key.split("::")[0]} both declare this marker: ${collision.files.join(", ")}.`,
  }));
  const byKey = new Map(affordances.map((affordance) => [affordance.key, affordance]));
  const { covered, unreachable } = splitByCoverage(affordances, seams);
  const unreachableKeys = new Set(unreachable.map((affordance) => affordance.key));
  const declaredByKey = resolveDeclarations({
    byKey,
    unreachableKeys,
    seams,
    actionIds,
    declarations,
    findings,
  });
  const currentKinds = ratchetFindings({ unreachableKeys, byKey, baseline, findings });

  const rows = unreachable.map((affordance) =>
    Object.freeze({ ...affordance, declaration: declaredByKey.get(affordance.key) ?? null }),
  );

  return Object.freeze({
    examined: affordances.length,
    covered: covered.length,
    unreachable: Object.freeze(rows),
    declared: rows.filter((row) => row.declaration !== null).length,
    coveredRows: Object.freeze(covered),
    kinds: kindRows({ affordances, currentKinds, rows }),
    findings: Object.freeze(findings),
    hasNewUnreachable: findings.some((finding) => finding.code.startsWith("engine_affordance_unreachable:")),
  });
}

/** The baseline document `--record-shrinks` writes. One fact: the current unreachable set. */
export function baselineDocument(reading) {
  return Object.freeze({
    schemaVersion: 1,
    artifactKind: "stardew_engine_affordance_baseline",
    note:
      "The engine affordances no action reaches today, as `<owner type>::<marker>` keys. The census fails on a key " +
      "that is not here and on a marker whose count grew; --record-shrinks lowers this set and never raises it, so " +
      "accepting a new unreachable is a diff a reviewer reads.",
    unreachable: Object.freeze(
      reading.unreachable.map((row) => row.key).sort((left, right) => left.localeCompare(right)),
    ),
  });
}

function parseArgs(argv) {
  const parsed = { report: false, "record-shrinks": false };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--report") {
      parsed.report = true;
      continue;
    }
    if (option === "--record-shrinks") {
      parsed["record-shrinks"] = true;
      continue;
    }
    if (!option.startsWith("--")) fail("engine_affordance_arguments_invalid", `Unexpected argument ${option}.`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) fail("engine_affordance_arguments_invalid", `Missing value for ${option}.`);
    parsed[option.slice(2)] = value;
  }
  return parsed;
}

function describe(affordance) {
  const site = `${affordance.file}:${String(affordance.sites[0])}`;
  const label = affordance.playerFacing === null ? "" : ` — ${affordance.playerFacing}`;
  // `activeClickableMenu = new X` is the derivation's evidence that this type is a menu a player opens.
  const menu = affordance.opensAsMenu ? " [a menu the player opens]" : "";
  return `${affordance.key} (${site})${label}${menu}`;
}

function censusLine(reading) {
  return (
    `engine_affordance_census: affordances examined ${String(reading.examined)} · covered ${String(reading.covered)} · ` +
    `unreachable ${String(reading.unreachable.length)} · declared-out-of-scope ${String(reading.declared)}`
  );
}

function kindLines(reading) {
  return reading.kinds
    .filter((kind) => kind.examined > 0)
    .map(
      (kind) =>
        `  marker ${kind.marker}: examined ${String(kind.examined)} · covered ${String(kind.covered)} · ` +
        `unreachable ${String(kind.unreachable)} · declared ${String(kind.declared)}`,
    );
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT")
      throw Object.assign(new Error(`Cannot read ${file}.`), {
        code: "engine_affordance_input_missing",
        details: { file },
      });
    throw Object.assign(new Error(`Cannot parse ${file}: ${error.message}`), {
      code: "engine_affordance_input_invalid",
      details: { file },
    });
  }
}

/** A baseline that is absent is the first recording; one that is present but unreadable is an error. */
async function readOptionalJson(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error.code === "engine_affordance_input_missing") return null;
    throw error;
  }
}

/** How an unreachable row is reported: the bare finding, or the decision someone recorded for it. */
function dispositionOf(row) {
  if (row.declaration === null) return `engine_affordance_unreachable:${row.key}`;
  const { kind, detail } = row.declaration;
  return detail === "" ? kind : `${kind}:${detail}`;
}

/** The `--report` body: every row with its site, its label, its disposition and the selectors it dispatches. */
function reportBody({ reading, derivation }) {
  const lines = [];
  for (const affordance of reading.coveredRows)
    lines.push(`  covered ${describe(affordance)} via ${affordance.actions.join(", ")}`);
  for (const row of reading.unreachable) {
    const selectors = row.selectors.length > 0 ? ` selectors: ${row.selectors.join(",")}` : "";
    lines.push(`  unreachable ${describe(row)} — ${dispositionOf(row)}${selectors}`);
  }
  if (derivation.menusWithoutAnEntry.length > 0)
    lines.push(
      `  menus the game opens with no mouse entry and no world marker (invisible to this census): ` +
        derivation.menusWithoutAnEntry.join(", "),
    );
  return lines;
}

/** Why a recording run refused, so the reader knows which of the two refusals fired. */
function recordRefusal({ reading, existingBaseline, blocking }) {
  if (reading.hasNewUnreachable && existingBaseline !== null)
    return (
      "engine_affordance_baseline_can_only_shrink: --record-shrinks refuses to record a new unreachable " +
      "affordance. Declare it, or make an action reach it."
    );
  return (
    `engine_affordance_baseline_record_refused: ${String(blocking.length)} finding(s) other than a stale ` +
    "baseline entry. Fix them, then record the shrink."
  );
}

/**
 * Record the shrink a stale entry names. The flag has one meaning, so a recording run cannot exit 0 over a red
 * reading: anything other than a stale baseline entry is refused before anything is written.
 */
async function recordShrinks({ reading, existingBaseline, baselinePath, lines }) {
  const blocking = reading.findings.filter((finding) => !finding.code.startsWith("stale_affordance_baseline:"));
  if (blocking.length > 0) {
    console.log(lines.join("\n"));
    console.error(recordRefusal({ reading, existingBaseline, blocking }));
    process.exitCode = 1;
    return;
  }
  const document = baselineDocument(reading);
  await writeFile(baselinePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  console.log(
    `engine_affordance_baseline_recorded: ${String(document.unreachable.length)} unreachable affordances → ` +
      path.relative(REPOSITORY_ROOT, baselinePath),
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const registerPath = path.resolve(REPOSITORY_ROOT, args.register ?? DEFAULT_REGISTER);
  const baselinePath = path.resolve(REPOSITORY_ROOT, args.baseline ?? DEFAULT_BASELINE);

  let sourceRoot;
  try {
    sourceRoot = assertStardewDecompileRoot(
      path.resolve(REPOSITORY_ROOT, args["source-root"] ?? STARDEW_DECOMPILE_ROOT_RELATIVE_PATH),
    );
  } catch (error) {
    console.error(`blocked: engine_affordance_tree_unavailable — ${error.message}`);
    process.exitCode = 2;
    return;
  }

  const [register, derivation, existingBaseline, declarations] = await Promise.all([
    readJson(registerPath),
    deriveEngineAffordances({ sourceRoot }),
    readOptionalJson(baselinePath),
    args.declarations ? readJson(path.resolve(REPOSITORY_ROOT, args.declarations)) : AFFORDANCE_DECLARATIONS,
  ]);
  if (!Array.isArray(declarations))
    fail("engine_affordance_input_invalid", "The --declarations file must hold an array of {affordance, reason}.");

  if (derivation.affordances.length === 0) {
    console.error(
      `blocked: engine_affordance_population_empty — ${String(derivation.filesExamined)} C# sources under ${sourceRoot} ` +
        `declared none of the ${String(AFFORDANCE_MARKERS.length)} player entries. A population of zero agrees with ` +
        "itself, so this is blocked rather than passed.",
    );
    process.exitCode = 2;
    return;
  }

  const reading = evaluateEngineAffordanceCensus({
    affordances: derivation.affordances,
    collisions: derivation.collisions,
    seams: readRegisterSeams(register),
    actionIds: readRegisterActionIds(register),
    baseline: existingBaseline,
    declarations,
  });

  const lines = [censusLine(reading), ...kindLines(reading)];
  if (args.report) lines.push(...reportBody({ reading, derivation }));
  for (const finding of reading.findings)
    lines.push(`  finding ${finding.code}${finding.detail === null ? "" : ` — ${finding.detail}`}`);

  if (args["record-shrinks"]) {
    await recordShrinks({ reading, existingBaseline, baselinePath, lines });
    return;
  }

  console.log(lines.join("\n"));
  if (reading.findings.length > 0) process.exitCode = 1;
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const code = error.code ?? "engine_affordance_census_failed";
    if (code === "engine_affordance_input_missing" || code === "engine_affordance_input_invalid")
      console.error(`blocked: ${code} — ${error.message}`);
    else console.error(`${code}: ${error.message}`);
    if (error.details && Object.keys(error.details).length > 0) console.error(JSON.stringify(error.details));
    process.exitCode = 2;
  }
}
