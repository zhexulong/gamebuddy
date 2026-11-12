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
 *   - RENDERED, by a source that composes the prose she reads (`RENDERER_SOURCES`), or by a row table that composer
 *     iterates (`TARGET_FAMILY_LABELS` / `NON_ROW_FAMILIES` in `game-world-vocabulary.ts`) - the renderer is named in
 *     the report, so "how does this field reach her" has an answer rather than a feeling;
 *   - EXEMPT, in `RENDERING_EXEMPTIONS`, with one line saying why and the owner who owes the next move.
 * A field in neither is `snapshot_field_never_rendered:<field>`. An exemption whose field has left the wire - or which
 * the prose renders now - is `stale_rendering_exemption:<field>`: an exemption must expire, or it becomes a list of
 * things nobody has to do.
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
 *            `snapshot_field_never_rendered:wateringCanFacts` (tools/check-snapshot-field-rendering.test.mjs)
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the wire declares what a Mod snapshot may carry. */
const PROTOCOL_SOURCE = "host/src/protocol.ts";

/**
 * The sources that compose the prose she reads, as the `<world-state>` block of one delivery.
 *
 * <p>
 * `fact-brief.ts` is the block itself. `game-world-vocabulary.ts` is not a second surface: `composeWorldState` calls
 * `formatGameEnvironmentFacts` and `nearbyTargetFamilies` from it for the clock, the map, the held tool, the nearby
 * families and the pack, so a field read there is printed in `<world-state>` - the same functions the Chat surface's
 * `<runtime-environment>` uses, which is why the words agree. The Chat surface on its own is NOT a renderer here: the
 * companion's player reads the Game turn, and that is what this gate protects.
 * </p>
 */
export const RENDERER_SOURCES = Object.freeze(["host/src/fact-brief.ts", "host/src/game-world-vocabulary.ts"]);

/** The row tables a renderer iterates: a key in one of these is printed by the composer that reads the table. */
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
      "her own health, which `snapshot-hud.ts` prints and `<world-state>` does not: the prose states the stamina a day's work spends and says nothing about collapsing at zero, which the engine announces as a lifecycle fact when it happens.",
    owedBy: "host/src/fact-brief.ts",
  },
  harvestWhereabouts: {
    reason:
      "the WHOLE-MAP ripe-crop count, which `snapshot-hud.ts` prints. `<world-state>` names only the radius-bounded `可收的作物` family, so ripe crops beyond six tiles are in neither the prose nor the count beside it.",
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
 * The whole reading: every wire field, the renderer that prints it or the exemption that owns it.
 *
 * `dispositions` is one row per field - the report a lane reads to find its own debt - and `violations` is what makes
 * the exit code 1. `unreadable` is a source this gate needed and could not read, which is reported as blocked: an
 * exemption that cannot be checked is not an exemption.
 */
export function auditSnapshotRendering({ root = REPOSITORY_ROOT, exemptions = RENDERING_EXEMPTIONS } = {}) {
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

  const renderers = RENDERER_SOURCES.map((path) => ({ path, source: read(root, path) }));
  const unreadable = renderers.filter((renderer) => renderer.source === null).map((renderer) => renderer.path);
  if (unreadable.length > 0)
    return { status: "blocked", examined: fields.length, dispositions: [], violations: [], unreadable };

  const tables = RENDERER_TABLES.map((entry) => {
    const source = renderers.find((renderer) => renderer.path === entry.source)?.source ?? "";
    return { ...entry, keys: tableKeys(source, entry.table) };
  });

  const rendererOf = (field) => {
    const direct = renderers.find((renderer) => rendersField(renderer.source, field));
    if (direct !== undefined) return direct.path;
    const table = tables.find((entry) => entry.keys.includes(field));
    return table === undefined ? undefined : `${table.source}#${table.table}`;
  };

  const dispositions = [];
  const violations = [];
  for (const field of fields) {
    const renderer = rendererOf(field);
    const exemption = exemptions[field];
    if (renderer !== undefined) {
      dispositions.push({ field, renderedBy: renderer });
      if (exemption !== undefined)
        violations.push({
          code: `stale_rendering_exemption:${field}`,
          field,
          detail: `${renderer} prints it now, so the exemption (owed by ${exemption.owedBy}) has expired and must be deleted`,
        });
      continue;
    }
    if (exemption === undefined) {
      dispositions.push({ field, renderedBy: null });
      violations.push({
        code: `snapshot_field_never_rendered:${field}`,
        field,
        detail:
          "the wire publishes it and no prose renders it: render it in host/src/fact-brief.ts, or declare it in " +
          "RENDERING_EXEMPTIONS with the reason and the owner who owes it",
      });
      continue;
    }
    dispositions.push({ field, exempt: exemption });
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
  return {
    status: violations.length === 0 ? "passed" : "failed",
    examined: fields.length,
    rendered,
    exempt,
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
    checks,
  };
  if (json) {
    process.stdout.write(`${JSON.stringify({ ...report, dispositions: reading.dispositions })}\n`);
  } else {
    process.stdout.write(
      `snapshot fields examined ${String(report.examined)} · rendered ${String(report.rendered)} · ` +
        `exempt ${String(report.exempt)} · status ${report.status}\n`,
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
