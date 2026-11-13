#!/usr/bin/env node
/**
 * The gate for "a published snapshot field that no prose renders" - one missing field is the instance, the class is
 * that nothing noticed it.
 *
 * WHY (measured 2026-11-11). The bridge published `wateringCanFacts` - validated, coverage-listed, and delivered in
 * every observation of that morning's run (`water 40, 40, 38, 36, 36` of `40`) - and `<world-state>` never printed it.
 * The companion therefore shook the can and narrated a gauge: `壶里这点底子够浇这两穴`, `壶底见底了`, `壶空了正好`, while
 * the wire said 36/40. Every layer that could have said so was green: `protocol.ts` admits the field,
 * `snapshot-projection-coverage.private.test.ts` lists it as observed-by-demand, `TARGET_FAMILY_LABELS` has a word for it. The
 * absent check is the class: NOTHING asked whether the field reaches the text the player's companion reads.
 *
 * THE POPULATION IS THE WIRE'S OWN KEY LIST - `SNAPSHOT_KEYS` in `host/src/protocol.ts`, read by name from the source
 * so a field added to the Mod joins this gate without an edit here. A hand-written list of fields to render is a test:
 * it can only catch what its author remembered, and it fails open the first time the Mod grows one.
 *
 * THE PROPERTY. Every key is one of:
 *   - RENDERED TO THE COMPANION, by a source that composes the text she reads (`RENDERER_SOURCES`, audience
 *     `companion`), or by a row table that composer iterates (`TARGET_FAMILY_LABELS` / `NON_ROW_FAMILIES` in
 *     `game-world-vocabulary.ts`) - the renderer is named in the report, so "how does this field reach her" has an
 *     answer rather than a feeling;
 *   - EXEMPT, in `RENDERING_EXEMPTIONS`, with one line saying why and the owner who owes the next move.
 * A field in neither is `fact_not_visible_to_the_companion:<field>`. An exemption whose field has left the wire - or
 * which the companion's own renderers print now - is `stale_rendering_exemption:<field>`: an exemption must expire, or
 * it becomes a list of things nobody has to do.
 *
 * WHO READS IT (measured 2026-11-21). A snapshot's text has three destinations, and only one of them is hers:
 *
 *   companion  `batch.text` from `composeFactBrief`, handed to Pi unchanged (`host/src/agent-turn-sink.ts:15`). This is
 *              the text she reads every turn, and the only surface that answers "does she know this fact".
 *   player     the browser's own Game panel (`dialogue-web/src/components/GameStatePanel.tsx`, fed by
 *              `game_browser_api/v1`). A fact printed there is real and useful, and it is still not a fact she has.
 *   unread     text composed and delivered to nobody. `host/src/snapshot-hud.ts` composes the `[State HUD: …]` block
 *              into `WorldFact.contextProjection.hud` (`host/src/host-service.ts:1242`); the only read of that key in
 *              the tree is the `typeof` guard on the line above it (`:1235`), `composeFactBrief` reads the projection's
 *              `text` and never `hud`, and no browser module names it.
 *
 * Until this unit the gate judged one question and answered another. `health` and `harvestWhereabouts` were cleared by
 * `printedBy: "host/src/snapshot-hud.ts"` - a rendering into the third bucket - so "she knows her own hit points" was
 * satisfied by a string nobody receives. `RENDERER_SOURCES` now carries the destination beside each module, every
 * disposition reports it as `renderedTo: model | player | both | neither`, and nothing outside the companion's view
 * clears anything. The one exemption that claims another surface, `player_only`, is CHECKED: a player-audience renderer
 * must print the field (`player_only_without_a_player_renderer`), and the reason must be written
 * (`player_only_without_reason`) - the reason is the half prose cannot be checked for, so it is the half an author has
 * to write down.
 *
 * WHY THE SET IS DECLARED AND NOT DERIVED FROM FUNCTION SHAPE. A rule like "an exported function taking `Snapshot` and
 * returning `string`" is what a derivation would use, and it pulls in `protocol.ts` - whose validator names every wire
 * key and would therefore mark every field rendered, which is the false green this gate exists to prevent. The
 * declaration is the smaller risk, and the claim check above is what keeps a member honest.
 *
 * A rendering into any other audience still clears nothing: the player's panel and the unread HUD block are both
 * reported per field (`printedBy` / `printedTo`), so a reader can tell "she reads it" from "a module writes it".
 *
 * READING IS NOT MENTIONING. Comments are stripped before a field is matched, because this file's own prose names
 * fields it does not render and a gate that counts its documentation as a rendering is the "check that reads the wrong
 * thing" failure this repository keeps paying for.
 *
 * Usage:
 *   node tools/check-snapshot-field-rendering.mjs                  # the gate; exit 1 on a violation, 2 on no population
 *   node tools/check-snapshot-field-rendering.mjs --json           # every field's disposition, machine-readable
 *   node tools/check-snapshot-field-rendering.mjs --root <dir>     # the gate's own fixture (a copied tree)
 *
 * red-proof: inject  deleting the water line from `host/src/fact-brief.ts` in a copied tree -> exit 1,
 *            `fact_not_visible_to_the_companion:wateringCanFacts` (tools/check-snapshot-field-rendering.test.mjs)
 * red-proof: inject  moving `stamina`/`exhausted` out of the companion's renderers and into a player-audience module in
 *            a copied tree -> exit 1, `fact_not_visible_to_the_companion:stamina` and `:exhausted` (the same suite) -
 *            the other audience printing a fact is not her reading it
 * red-proof: inject  a `player_only` exemption with a blank reason, and one with no player-audience renderer printing
 *            the field -> `player_only_without_reason` / `player_only_without_a_player_renderer` (the same suite)
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the wire declares what a Mod snapshot may carry. */
const PROTOCOL_SOURCE = "host/src/protocol.ts";

/** The audience whose text is the per-turn message the model receives: `batch.text`, from `composeFactBrief`. */
const COMPANION = "companion";

/** The audience whose text is the player's own Game surface. Nothing here prints a wire key today. */
const PLAYER = "player";

/** The audience that receives nothing: a text composed on every turn with no consumer in the tree. */
const UNREAD = "unread";

/**
 * Every source that composes text from the snapshot model, and the audience its text is delivered to.
 *
 * <p>
 * `fact-brief.ts` is the `<world-state>` block itself. `game-world-vocabulary.ts` is part of the same surface rather
 * than a second one: `composeWorldState` calls `formatGameEnvironmentFacts` and `nearbyTargetFamilies` from it for the
 * clock, the map, the held tool, the nearby families and the pack, so a field read there is printed in `<world-state>` -
 * the same functions the Chat surface's `<runtime-environment>` uses, which is why the words agree. The Chat surface on
 * its own is NOT a renderer here: the companion's player reads the Game turn, and that is what this gate protects.
 * </p>
 * <p>
 * `snapshot-hud.ts` composes text from the same `Snapshot` and delivers it to NOBODY - the measurement is in the header -
 * so it is a member of this population with audience `unread`. Keeping it is what lets the report say which fields are
 * printed into text with no reader (22 of 120, four of them printed nowhere else) instead of leaving that fact in a
 * comment. What makes a module a member of this set is that it COMPOSES TEXT FROM THE SNAPSHOT - it is read here field
 * by field. A module that merely reads a snapshot field to decide something is not a renderer; adding one would credit
 * its reads as renderings.
 * </p>
 * <p>
 * THE AUDIENCE IS THE CLAIM. `companion` is the only one that clears an obligation; `player` is the audience a
 * `player_only` exemption may name; `unread` clears nothing and is reported as what it is. A renderer that is wired to
 * a new surface changes this declaration on the day it changes, which is the point: the array is small, hand-written and
 * audited by the report it produces.
 * </p>
 */
export const RENDERER_SOURCES = Object.freeze([
  { path: "host/src/fact-brief.ts", audience: COMPANION },
  { path: "host/src/game-world-vocabulary.ts", audience: COMPANION },
  { path: "host/src/snapshot-hud.ts", audience: UNREAD },
]);

/** The row tables a renderer iterates: a key in one of these is printed by the world-state composer that reads it. */
export const RENDERER_TABLES = Object.freeze([
  { source: "host/src/game-world-vocabulary.ts", table: "TARGET_FAMILY_LABELS" },
  { source: "host/src/game-world-vocabulary.ts", table: "NON_ROW_FAMILIES" },
]);

/**
 * The facts `<world-state>` does not print, each with the reason and the owner who owes the next move.
 *
 * AN ENTRY HERE IS A DEBT OR A DECISION, and the two are told apart by `owedBy` saying which file owes it. An entry
 * that has to be explained twice is a family: the three body-disposition keys carry one reason, and the truncation
 * counts carry theirs. Every entry EXPIRES: the moment `fact-brief.ts` prints the field, or the wire stops publishing
 * it, `stale_rendering_exemption:<field>` goes red and the entry is deleted rather than kept as a comfortable note.
 *
 * `player_only` IS THE ONE AUDIENCE CLAIM AN EXEMPTION MAY MAKE, and it is checked rather than believed: the field must
 * be printed by a renderer whose audience is `player`, or the declaration is `player_only_without_a_player_renderer`.
 * A fact printed into text NOBODY receives is not the player's either - which is how `health` sat exempted for a while,
 * crediting a HUD block no reader in this tree consumes.
 */
const BODY_HELD_REASON =
  "what is holding her body (a modal, an event, a pass-out) and whether a new command can take it over. The observation's projection states it for `stardew_observe` and the refusal receipt states it after the attempt; `<world-state>` does not, so a companion who is blocked learns it only by trying.";
const TRUNCATION_COUNT_REASON =
  "the number of rows a Mod cap left out, paired with the family it counts. `<world-state>` prints that family, so the count beside it is the next unit: a family truncated at its cap reads as complete without it.";

export const RENDERING_EXEMPTIONS = Object.freeze({
  actionable: { reason: BODY_HELD_REASON, owedBy: "host/src/fact-brief.ts" },
  actorDispositionKind: { reason: BODY_HELD_REASON, owedBy: "host/src/fact-brief.ts" },
  actorDispositionDetail: { reason: BODY_HELD_REASON, owedBy: "host/src/fact-brief.ts" },
  actorDispositionActionOwned: { reason: BODY_HELD_REASON, owedBy: "host/src/fact-brief.ts" },
  health: {
    reason:
      "her own health, which no text she reads prints: `<world-state>` states the stamina a day's work spends and not the " +
      "hit points a mine level takes, so the only notice she gets of her own condition is `night_ended_pass_out`, after " +
      "it has already happened.",
    owedBy: "host/src/fact-brief.ts",
  },
  harvestWhereabouts: {
    reason:
      "the WHOLE-MAP ripe-crop count. `<world-state>` names only the radius-bounded `可收的作物` family, so ripe crops " +
      "beyond that radius are in neither the prose nor a count beside it - the gap the dry-crop line closed for " +
      "`wateringWhereabouts`, still open for this family.",
    owedBy: "host/src/fact-brief.ts",
  },
  warps: {
    reason:
      "the map's own warp table, addresses rather than places to walk to. `doorTargets` is the family `<world-state>` prints; a warp with a button tile is addressed by `move_to_tile` and read from the observation.",
    owedBy: "host/src/snapshot-projection.ts",
  },
  discoveryExclusions: {
    reason:
      "what discovery withheld and why, one row per (family, reason). A row means something only beside the list it emptied, and the prose prints no family rows: it prints six tiles per family and a count.",
    owedBy: "host/src/snapshot-projection.ts",
  },
  capabilities: {
    reason:
      "the Mod's advertised action ids. The companion meets this fact as the tool list she is given, not as a sentence: printing it would be a second spelling of what the tools already are.",
    owedBy: "host/src/identity-profile.ts",
  },
  enabledActionIds: {
    reason:
      "the same set the Mod's live capability surface governs, seen from the Host side: it decides what the tools may do, and the tools are its rendering.",
    owedBy: "host/src/identity-profile.ts",
  },
  catalogRevision: {
    reason:
      "a revision counter for `capabilities`; a number whose only reader compares two builds, and the prose states what a day did not what build it ran.",
    owedBy: "host/src/identity-profile.ts",
  },
  presentationLocale: {
    reason:
      "the Mod's BCP-47 locale. The prose IS in the player's language and the vocabulary tables are what spell it, so printing the tag would be the format of the answer rather than the answer.",
    owedBy: "host/src/game-world-vocabulary.ts",
  },
  currentToolSlotItem: {
    reason:
      "the qualified id in the held slot when it is not a tool. `手持` names the tool in words and the id is the handle an action argument copies, so it belongs in a tool call and not in a sentence.",
    owedBy: "host/src/game-world-vocabulary.ts",
  },
  activeExecution: {
    reason:
      "the Mod's in-flight execution state, which the Host already owns from action receipts and the journal: `<in-flight>` is that fact, composed from the ledger a status read fills.",
    owedBy: "host/src/fact-brief.ts",
  },
  pendingLevelUps: {
    reason:
      "the engine's pending level-ups. The night boundary asks her to decide through `respond_level_up`, whose own answer carries the pair; a per-turn line would repeat a menu that only exists at the boundary.",
    owedBy: "host/src/body-program-script.ts",
  },
  pendingLevelUpChoices: {
    reason:
      "the two cards a milestone offers, addressed by `branch_a`/`branch_b` in `respond_level_up` - a choice is made against the question, not in a world report.",
    owedBy: "host/src/body-program-script.ts",
  },
  professions: {
    reason:
      "the profession ids a milestone branch wrote; read back to confirm the write landed, which is the action's own postcondition rather than a per-turn fact.",
    owedBy: "host/src/body-program-script.ts",
  },
  activeSpecialOrderKeys: {
    reason:
      "the keys of the special orders she has taken, addressed by the order actions; `特别订单` is the family the prose prints and the keys are handles into it.",
    owedBy: "host/src/game-world-vocabulary.ts",
  },
  acceptedDailyQuest: {
    reason:
      "a planning flag the daily-quest actions read from the latest observation; a boolean that changes once a day is not a per-turn fact.",
    owedBy: "host/src/game-world-vocabulary.ts",
  },
  artifactSpotFarmSourceCount: {
    reason:
      "a count used only while planning artifact-spot digs, paired with `可疑的土堆` and read from the observation that carries the family.",
    owedBy: "host/src/game-world-vocabulary.ts",
  },
  fixedInteractionPointsOmitted: { reason: TRUNCATION_COUNT_REASON, owedBy: "host/src/fact-brief.ts" },
  soilTilesOmitted: { reason: TRUNCATION_COUNT_REASON, owedBy: "host/src/fact-brief.ts" },
  farmBuildingTargetsOmitted: { reason: TRUNCATION_COUNT_REASON, owedBy: "host/src/fact-brief.ts" },
  seedSupplyTargetsOmitted: { reason: TRUNCATION_COUNT_REASON, owedBy: "host/src/fact-brief.ts" },
  discoveryExclusionsOmitted: {
    reason:
      "the number of distinct (family, reason) rows the excluded register's cap left out, paired with `discoveryExclusions`. Without it a bounded register reads as complete - the same defect the truncation counts exist for, one layer out.",
    owedBy: "host/src/snapshot-projection.ts",
  },
});

/** A line comment, a block comment: text a reader wrote for a person, never a read of a field. */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/u, ""))
    .join("\n");
}

/** Whether a source reads a snapshot field: `.field`, `"field"`, `source.field`, or a destructure binding. */
export function rendersField(source, field) {
  const code = withoutComments(source);
  return [
    new RegExp(`\\.${field}\\b`, "u"),
    new RegExp(`["']${field}["']`, "u"),
    new RegExp(`\\{[^}]*\\b${field}\\b[^}]*\\}\\s*=`, "u"),
  ].some((pattern) => pattern.test(code));
}

/** The keys of one `export const <table> = Object.freeze({...})` literal, in declaration order. */
export function tableKeys(source, table) {
  const declaration = source.indexOf(`export const ${table}`);
  if (declaration < 0) return [];
  const open = source.indexOf("{", declaration);
  if (open < 0) return [];
  const body = withoutComments(source.slice(open));
  const keys = [];
  for (const match of body.matchAll(/^\s+(\w+):/gmu)) keys.push(match[1]);
  return keys;
}

/**
 * Every key `SNAPSHOT_KEYS` declares, in declaration order.
 *
 * Throws rather than returns an empty list when the declaration is not the shape this reads: a gate that silently
 * examined nothing agrees with itself, and the caller turns the throw into `blocked`.
 */
export function snapshotFields(protocolSource) {
  const declaration = protocolSource.indexOf("const SNAPSHOT_KEYS");
  if (declaration < 0) throw new Error("SNAPSHOT_KEYS is not declared in protocol.ts: this gate reads it by name");
  const open = protocolSource.indexOf("[", declaration);
  if (open < 0) throw new Error("SNAPSHOT_KEYS has no array: the declaration is not the shape this reads");
  let depth = 0;
  let close = -1;
  for (let index = open; index < protocolSource.length; index += 1) {
    if (protocolSource[index] === "[") depth += 1;
    else if (protocolSource[index] === "]") {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close < 0) throw new Error("SNAPSHOT_KEYS is not closed: the declaration is not the shape this reads");
  const body = withoutComments(protocolSource.slice(open, close + 1));
  const keys = [...body.matchAll(/"(\w+)"/gu)].map((match) => match[1]);
  if (keys.length === 0) throw new Error("SNAPSHOT_KEYS declares no key: the admission boundary is unreadable");
  return keys;
}

const read = (root, path) => {
  try {
    return readFileSync(resolve(root, path), "utf8");
  } catch {
    return null;
  }
};

/**
 * What is wrong with one exemption: no owner, no reason, or a `player_only` claim that does not hold.
 *
 * The audience is the entry that needs verifying, because it is the only thing that lets a field out of the companion's
 * text while asserting somebody else has it.
 */
function exemptionViolations({ field, exemption, playerRenderers }) {
  const violations = [];
  if (typeof exemption.owedBy !== "string" || exemption.owedBy.trim() === "")
    violations.push({
      code: `exemption_without_owner:${field}`,
      field,
      detail: "an exemption with nobody's name on it is a fact quietly left out",
    });
  if (typeof exemption.reason !== "string" || exemption.reason.trim() === "")
    violations.push({
      code: `exemption_without_reason:${field}`,
      field,
      detail: "an exemption with no reason is indistinguishable from a field nobody looked at",
    });
  if (exemption.player_only === undefined) return violations;
  if (typeof exemption.player_only !== "string" || exemption.player_only.trim() === "")
    violations.push({
      code: `player_only_without_reason:${field}`,
      field,
      detail:
        "a field declared the player's own must say why the companion does not need it; without that sentence the " +
        "declaration is the defect it was meant to document",
    });
  if (playerRenderers.some((renderer) => rendersField(renderer.source, field))) return violations;
  const declared = playerRenderers.map((renderer) => renderer.path).join(", ");
  violations.push({
    code: `player_only_without_a_player_renderer:${field}`,
    field,
    detail:
      "it is declared player-only, and no surface that reaches the player prints it; the player-audience " +
      `renderers are ${declared === "" ? "none: no player-audience renderer is declared at all" : declared}. ` +
      "Text printed into a block no reader receives is not the player's either",
  });
  return violations;
}

/**
 * The whole reading: every wire field, the audience its text reaches, and the exemption that owns its absence.
 *
 * `dispositions` is one row per field - the report a lane reads to find its own debt - and `violations` is what makes
 * the exit code 1. `unreadable` is a source this gate needed and could not read, which is reported as blocked: an
 * exemption that cannot be checked is not an exemption.
 */
export function auditSnapshotRendering({
  root = REPOSITORY_ROOT,
  exemptions = RENDERING_EXEMPTIONS,
  renderers: declared = RENDERER_SOURCES,
} = {}) {
  const protocol = read(root, PROTOCOL_SOURCE);
  if (protocol === null)
    return { status: "blocked", examined: 0, dispositions: [], violations: [], unreadable: [PROTOCOL_SOURCE] };
  let fields;
  try {
    fields = snapshotFields(protocol);
  } catch (error) {
    return {
      status: "blocked",
      examined: 0,
      dispositions: [],
      violations: [],
      unreadable: [`${PROTOCOL_SOURCE}: ${error.message}`],
    };
  }

  const renderers = declared.map((renderer) => ({ ...renderer, source: read(root, renderer.path) }));
  const unreadable = renderers.filter((renderer) => renderer.source === null).map((renderer) => renderer.path);
  if (unreadable.length > 0)
    return { status: "blocked", examined: fields.length, dispositions: [], violations: [], unreadable };

  const companionRenderers = renderers.filter((renderer) => renderer.audience === COMPANION);
  const playerRenderers = renderers.filter((renderer) => renderer.audience === PLAYER);
  const otherRenderers = renderers.filter((renderer) => renderer.audience !== COMPANION);

  const tables = RENDERER_TABLES.map((entry) => {
    const source = renderers.find((renderer) => renderer.path === entry.source)?.source ?? "";
    return { ...entry, keys: tableKeys(source, entry.table) };
  });

  /** Who prints the field in the text she reads: a companion-audience renderer, or the table a composer iterates. */
  const companionRendererOf = (field) => {
    const direct = companionRenderers.find((renderer) => rendersField(renderer.source, field));
    if (direct !== undefined) return direct.path;
    const table = tables.find((entry) => entry.keys.includes(field));
    return table === undefined ? undefined : `${table.source}#${table.table}`;
  };

  /** Who prints the field on a surface that is NOT hers. Reported beside `renderedBy`, never in its place. */
  const otherRendererOf = (field) =>
    playerRenderers.find((renderer) => rendersField(renderer.source, field)) ??
    otherRenderers.find((renderer) => rendersField(renderer.source, field));

  const dispositions = [];
  const violations = [];
  for (const field of fields) {
    const renderedBy = companionRendererOf(field) ?? null;
    const elsewhere = otherRendererOf(field);
    const printedBy = elsewhere?.path ?? null;
    const printedTo = elsewhere?.audience ?? null;
    const renderedTo =
      renderedBy !== null ? (printedTo === PLAYER ? "both" : "model") : printedTo === PLAYER ? "player" : "neither";
    const exemption = exemptions[field];
    if (renderedBy !== null) {
      dispositions.push({ field, renderedTo, renderedBy, printedBy, printedTo });
      if (exemption !== undefined)
        violations.push({
          code: `stale_rendering_exemption:${field}`,
          field,
          detail: `${renderedBy} composes the text she reads and prints it, so the exemption (owed by ${exemption.owedBy}) has expired and must be deleted`,
        });
      continue;
    }
    if (exemption === undefined) {
      dispositions.push({ field, renderedTo, renderedBy: null, printedBy, printedTo });
      violations.push({
        code: `fact_not_visible_to_the_companion:${field}`,
        field,
        detail:
          printedBy === null
            ? "the wire publishes it and nothing prints it at all: render it in host/src/fact-brief.ts, or declare " +
              "it in RENDERING_EXEMPTIONS with the reason and the owner who owes it"
            : `${printedBy} prints it and its text reaches ${printedTo === PLAYER ? "the player" : "no reader"}, ` +
              "which is not the companion's view: render it in host/src/fact-brief.ts, or declare it in " +
              "RENDERING_EXEMPTIONS with the reason and the owner who owes it",
      });
      continue;
    }
    dispositions.push({ field, renderedTo, renderedBy: null, printedBy, printedTo, exempt: exemption });
    violations.push(...exemptionViolations({ field, exemption, playerRenderers }));
  }

  const onWire = new Set(fields);
  for (const field of Object.keys(exemptions)) {
    if (onWire.has(field)) continue;
    violations.push({
      code: `stale_rendering_exemption:${field}`,
      field,
      detail: `${PROTOCOL_SOURCE} no longer publishes it, so the exemption exempts nothing and must be deleted`,
    });
  }

  const rendered = dispositions.filter((entry) => entry.renderedBy != null).length;
  const exempt = dispositions.filter((entry) => entry.exempt !== undefined).length;
  // The two audiences this gate is NOT judging, named in the report so a reader can tell "she reads it" from "a module
  // writes it": fields a surface that reaches the player prints, and fields printed into text with no reader at all.
  const printedToThePlayer = dispositions.filter((entry) => entry.printedTo === PLAYER).length;
  const printedToNoReader = dispositions.filter((entry) => entry.printedTo === UNREAD).length;
  return {
    status: violations.length === 0 ? "passed" : "failed",
    examined: fields.length,
    rendered,
    exempt,
    printedOutsideHerView: printedToThePlayer + printedToNoReader,
    printedToThePlayer,
    printedToNoReader,
    dispositions,
    violations,
    unreadable: [],
  };
}

function main(argv) {
  const rootIndex = argv.indexOf("--root");
  const root =
    rootIndex >= 0 && typeof argv[rootIndex + 1] === "string" ? resolve(argv[rootIndex + 1]) : REPOSITORY_ROOT;
  const json = argv.includes("--json");
  const reading = auditSnapshotRendering({ root });
  const checks = [
    {
      id: "field_population",
      status: reading.examined === 0 ? "blocked" : "passed",
      detail: `${String(reading.examined)} key(s) in SNAPSHOT_KEYS`,
    },
    {
      id: "every_field_rendered_or_exempt",
      status: reading.examined === 0 ? "blocked" : reading.violations.length === 0 ? "passed" : "failed",
      detail: `${String(reading.violations.length)} violation(s)`,
    },
  ];
  const report = {
    gate: "snapshot-field-rendering",
    status: reading.status,
    examined: reading.examined,
    rendered: reading.rendered ?? 0,
    exempt: reading.exempt ?? 0,
    printedOutsideHerView: reading.printedOutsideHerView ?? 0,
    printedToThePlayer: reading.printedToThePlayer ?? 0,
    printedToNoReader: reading.printedToNoReader ?? 0,
    checks,
  };
  if (json) {
    process.stdout.write(`${JSON.stringify({ ...report, dispositions: reading.dispositions })}\n`);
  } else {
    process.stdout.write(
      `snapshot fields examined ${String(report.examined)} · in her view ${String(report.rendered)} · ` +
        `exempt ${String(report.exempt)} · printed outside her view ${String(report.printedOutsideHerView)} ` +
        `(for the player ${String(report.printedToThePlayer)} · for no reader ${String(report.printedToNoReader)}) · ` +
        `status ${report.status}\n`,
    );
    for (const line of reading.unreadable) process.stderr.write(`snapshot_rendering_unreadable: ${line}\n`);
    for (const violation of reading.violations) process.stderr.write(`${violation.code}: ${violation.detail}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
  if (reading.examined === 0) {
    process.stderr.write(
      "snapshot_field_rendering: no snapshot field was examined, so nothing can be judged; a green run reads examined>=1\n",
    );
    process.exitCode = 2;
    return;
  }
  process.exitCode = reading.status === "passed" ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
