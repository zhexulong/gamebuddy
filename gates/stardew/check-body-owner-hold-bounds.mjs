#!/usr/bin/env node
/**
 * Gate: `a_body_can_be_held_with_no_way_out/<owner>` - every owner that can take the actor's body must name the thing
 * that ends its hold, and a claim the gate can read must be true of the source that makes it.
 *
 * WHY (measured, `round67` 2026-11-18). The last fact the Mod published before ten silent minutes was
 * `body_owned_by_navigation` with `phase=approaching;interruptible=false;cancel_safe=true`. The body was held by a
 * navigation and NOTHING said when that hold would end: the navigation's only remaining bound was the deadline the
 * caller had declared (`navigate_to_destination: 600_000` in `EXECUTION_REQUEST_DEADLINE_WINDOWS`), which is a fact about
 * the request, not about the owner. A held body with no bound publishes nothing, so no turn opens, so nothing wakes the
 * companion - and the run spends its window asleep.
 *
 * THE POPULATION IS THE MOD'S OWN VOCABULARY, never a list here: the hold kinds it declares
 * (`internal const string BodyOwnedBy* = "body_owned_by_*";` - the same extraction
 * `tools/check-refusal-action-names.mjs` uses for the names) x the source, so a new hold kind joins by existing and an
 * owner nobody bounded is named rather than discovered live.
 *
 * WHAT EACH OWNER MUST DECLARE. One of:
 *   `<owner>: { bound: [...tokens], why }` - the tokens that ARE the bound. Every token must appear in the shipped Mod
 *       with its comments blanked, so a renamed or deleted bound turns this gate red instead of quietly widening.
 *   `<owner>: { stop: true, why }`          - a stop ends the hold sooner than any window. Only admissible for an owner
 *       whose own row publishes `CancelSafe: true`; a row that publishes `false` while this table claims a stop is the
 *       exact pair of answers the refusal must never give at once.
 * The `why` is printed beside the owner in the reading, because "bounded" without a sentence is a label.
 *
 * VERDICT. `owners examined N · bounded B · stop-ended S · silent X`, exit 1 when an owner declares neither or a claim
 * is unsupported (each named with its file), exit 2 when the Mod declares no hold kind at all - an empty population
 * agrees with itself, so it is BLOCKED, never green.
 *
 * Falsifier ledger: `tools/check-body-owner-hold-bounds.test.mjs`.
 *
 * Usage:
 *   node tools/check-body-owner-hold-bounds.mjs            # this tree
 *   node tools/check-body-owner-hold-bounds.mjs <dir>      # another scope, e.g. a pre-fix checkout
 *   node tools/check-body-owner-hold-bounds.mjs --json
 */

export const gateDeclaration = {
  id: "check-body-owner-hold-bounds",
  domain: "stardew",
  tier: "l0",
  kind: "totality",
};

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const SOURCES = Object.freeze({
  modRoot: "integrations/stardew",
  holdKinds: "integrations/stardew/farmhandexecutioncontroller.cs",
  ownerRows: "integrations/stardew/ActiveBodySlots.cs",
});

/** Directories under the Mod root that are not shipped surfaces. */
const NOT_SHIPPED = new Set(["obj", "bin", "tests", "action-development"]);

/** The Mod's declaration of its body-hold kinds, one named constant each. */
const HOLD_KIND_CONSTANT = /internal const string BodyOwnedBy[A-Za-z]* = "(body_owned_by_[a-z_]+)";/gu;

/**
 * The owner table's rows, as a refusal reports them: the slot's own `Code:` and the method that describes it. A row
 * with no `Owner:` does not report an owner at all (the night that has not begun), so it is not in this population.
 */
const OWNER_ROW =
  /nameof\(this\.(\w+)\)[\s\S]{0,900}?Code: ExecutionManager\.(BodyOwnedBy\w+),[\s\S]{0,200}?Owner: (?:(?:code|_)?\s*=>|this\.)(\w*)/gu;

/**
 * Each declared hold kind, with what ends it. A `bound` is a token the Mod's own source must carry; `stop` may only be
 * claimed for an owner whose row publishes `CancelSafe: true` (or computes it, which this gate reports as unmeasured).
 */
export const OWNER_HOLD_ENDS = Object.freeze({
  body_owned_by_navigation: {
    bound: ["NavigationWarpReplanGraceTicks", "grace_expired=true"],
    why: "the post-warp window is armed once per warp, expires on its own tick count and settles `destination_locked`; the approach leg before it is bounded by the body controller's stall timeout",
  },
  body_owned_by_movement: {
    bound: ["StallTimeoutTicks"],
    why: "the body controller's L2 watchdog ends a walk that stops making progress with a named refusal carrying stalled_ticks",
  },
  body_owned_by_travel: {
    bound: ["travel_deadline_expired"],
    why: "the travel slot expires against the request's own declared deadline",
  },
  body_owned_by_approach: {
    bound: ["tool_approach_deadline_expired"],
    why: "the tool-approach slot expires against the request's own declared deadline",
  },
  body_owned_by_ride: {
    bound: ["horse_mount_postcondition_unavailable", "UpdateBusRide"],
    why: "the mount expires against its deadline and the bus ride is settled by its own per-tick lifecycle",
  },
  body_owned_by_night: {
    bound: ["UpdateActiveDayAdvance", "pass_out"],
    why: "a night is an owner only once it can begin, and from then on its lifecycle settles it; the engine's own pass-out is the last word",
  },
  body_owned_by_activity: {
    bound: [
      "item_use_postcondition_unavailable",
      "animal_product_postcondition_unavailable",
      "pet_postcondition_unavailable",
      "pedestal_take_postcondition_unavailable",
      "ItemPickupMagnetWindowTicks",
      "UpdateFishingCast",
    ],
    why: "each activity slot has its own window in the frame loop and settles uncertain when the window closes",
  },
});

/** The comment-blanked source. A quoted defect is the defect; a defect in a comment is history. */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, " "))
    .replace(/(^|[^:"'])\/\/[^\n]*/gu, (match, lead) => lead + " ".repeat(match.length - lead.length));
}

/** Every shipped `.cs` file under the Mod, path -> text. Exported so a falsifier reads the same tree the gate reads. */
export function modSources(root) {
  const found = new Map();
  const walk = (relative) => {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const child = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) {
        if (!NOT_SHIPPED.has(entry.name)) walk(child);
      } else if (entry.name.endsWith(".cs")) {
        found.set(child, readFileSync(path.join(root, child), "utf8"));
      }
    }
  };
  walk("integrations/stardew");
  return found;
}

/**
 * One reading. `sources` is the shipped Mod (path -> text) and `table` the declarations, so a falsifier can hand it a
 * tree and a table of its own.
 */
export function ownerHoldGate(sources, table) {
  const shipped = new Map([...sources].map(([file, text]) => [file, stripComments(text)]));
  const kindsFile = shipped.get(SOURCES.holdKinds) ?? "";
  const kinds = [...kindsFile.matchAll(HOLD_KIND_CONSTANT)].map((match) => match[1]);
  if (kinds.length === 0)
    return { blocked: "no_hold_kind_declared", owners: [], silent: [], unsupported: [], expired: [] };

  // `<constant name> -> <hold kind>`, from the declaration itself, so a row's `Code:` resolves through the one table.
  const codeOf = new Map(
    [...kindsFile.matchAll(/internal const string (BodyOwnedBy\w*) = "(body_owned_by_[a-z_]+)";/gu)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  const rowsFile = shipped.get(SOURCES.ownerRows) ?? "";
  const rows = [...rowsFile.matchAll(OWNER_ROW)].map((match) => ({
    slot: match[1],
    code: codeOf.get(match[2]) ?? "unknown",
    ownerMethod: match[3],
  }));
  /**
   * What one owner row publishes in its `CancelSafe:` position. The literal lives in the `Peek<X>Owner` method that
   * builds the row, never in the slot table, so the question is asked of the method the table names. A computed
   * expression (navigation's `CancelSafe: navigating`) answers `unmeasured` rather than a guess.
   */
  const cancelSafeOf = (ownerMethod) => {
    if (ownerMethod === "") return "unmeasured";
    const start = rowsFile.indexOf(`OwnerRow? ${ownerMethod}(`);
    if (start < 0) return "unmeasured";
    const rest = rowsFile.slice(start + 1);
    const next = rest.indexOf("OwnerRow? ");
    const body = next < 0 ? rest : rest.slice(0, next);
    const declared = /CancelSafe:\s*([a-z]+)/u.exec(body);
    if (declared === null) return "unmeasured";
    return declared[1] === "true" ? "true" : declared[1] === "false" ? "false" : "unmeasured";
  };

  const owners = [];
  const silent = [];
  const unsupported = [];
  for (const kind of kinds) {
    const entry = table[kind];
    if (entry === undefined || (entry.bound === undefined && entry.stop !== true)) {
      silent.push({ owner: kind, why: entry === undefined ? "no declaration" : "neither a bound nor a stop" });
      continue;
    }
    if (typeof entry.why !== "string" || entry.why.trim().length <= 20) {
      silent.push({ owner: kind, why: "declared without a sentence saying what ends it" });
      continue;
    }
    const missing = (entry.bound ?? []).filter((token) => ![...shipped.values()].some((text) => text.includes(token)));
    if (missing.length > 0) unsupported.push({ owner: kind, missing });
    if (entry.stop === true) {
      // A stop may only be claimed for an owner whose own row does not refuse cancellation. A row publishing
      // `CancelSafe: false` and a table claiming a stop are the one pair of answers a refusal must never give at once.
      const refusing = rows.filter((row) => row.code === kind && cancelSafeOf(row.ownerMethod) === "false");
      if (refusing.length > 0)
        unsupported.push({
          owner: kind,
          missing: [`CancelSafe: false on ${refusing.map((row) => row.slot).join(",")}`],
        });
    }
    owners.push({
      owner: kind,
      mode: entry.stop === true ? "stop" : "bound",
      rows: rows.filter((row) => row.code === kind).length,
    });
  }
  const expired = Object.keys(table).filter((kind) => !kinds.includes(kind));
  return { blocked: null, owners, silent, unsupported, expired };
}

export function findingLine(finding) {
  const bounded = finding.owners.filter((owner) => owner.mode === "bound").length;
  const stop = finding.owners.filter((owner) => owner.mode === "stop").length;
  return (
    `a_body_can_be_held_with_no_way_out: owners examined ${String(finding.silent.length + finding.owners.length)} · ` +
    `bounded ${String(bounded)} · stop-ended ${String(stop)} · silent ${String(finding.silent.length)}`
  );
}

function main() {
  const override = process.argv[2];
  const root = override === undefined ? REPOSITORY_ROOT : path.resolve(override);
  const finding = ownerHoldGate(modSources(root), OWNER_HOLD_ENDS);
  const line = findingLine(finding);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ ...finding, line }, null, 2));
    process.exit(finding.blocked === null && finding.silent.length === 0 && finding.unsupported.length === 0 ? 0 : 1);
  }
  console.log(line);
  for (const entry of finding.owners) console.log(`  ${entry.mode}: ${entry.owner}`);
  if (finding.blocked !== null) {
    console.error(`blocked: ${finding.blocked} - the Mod declares no body-hold kind, so nothing was examined`);
    process.exit(2);
  }
  for (const entry of finding.silent) console.error(`silent: ${entry.owner} - ${entry.why}`);
  for (const entry of finding.unsupported) console.error(`unsupported: ${entry.owner} - ${entry.missing.join(", ")}`);
  for (const kind of finding.expired)
    console.error(`expired: ${kind} - declared a hold end for an owner the Mod no longer declares`);
  process.exit(finding.silent.length === 0 && finding.unsupported.length === 0 && finding.expired.length === 0 ? 0 : 1);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
