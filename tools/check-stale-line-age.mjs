#!/usr/bin/env node
/**
 * The gate for "a state line that goes stale without saying so" - the value and its age, apart.
 *
 * <p>
 * WHY (measured, `round75`, 208-record session). `<world-state>` printed `种子: 2 花椰菜种子` on all fourteen refusal
 * turns of a stretch in which she had already planted both - her own words said `两粒籽都落土了` - while the receipts in
 * the SAME deliveries carried the Mod's own post-action count: `item=(O)472;…;inventory_before=2;inventory_after=1`,
 * then `inventory_after=0`. `种子: 0` first appears a hundred turns later, after she called `stardew_observe`. Fifty-plus
 * turns were planned on a number the delivery had already corrected, and nothing in the line said the number had a date.
 * </p>
 *
 * <p>
 * THE CLASS, not the instance. A block-level age (`（这是 N 轮之前看到的，世界已经不一样了）`, three clauses away, about
 * "the world") cannot be applied to one number inside a paragraph of twelve. Any line that prints a pack quantity is
 * therefore one of exactly two things:
 * </p>
 * <ol>
 *   <li>RE-EMITTED from this delivery's own proof - the Mod's `item=` + `inventory_after=`, which `provedPackCounts`
 *     (`host/src/fact-brief.ts`) reads out of a receipt or a settled programme's node evidence; or</li>
 *   <li>in neither state, which is the defect: the number reads as the present tense and its age is somewhere else.</li>
 * </ol>
 *
 * <p>
 * THE POPULATION IS DERIVED, twice over, and both derivations are from declarations the product already owns:
 * </p>
 * <ul>
 *   <li>THE LINES come from `<world-state>`'s own composition: every `parts.push(x)` in `composeWorldState` whose `x` is
 *     a local bound to a renderer call is a line of the block. A renderer added to the block joins this gate with no
 *     edit here, and a renderer deleted from it stops counting.</li>
 *   <li>THE PACK comes from the wire: `inventory*` and `seed*` among `SNAPSHOT_KEYS` (`host/src/protocol.ts`), read by
 *     name. A line is a PACK LINE when the renderer it names reads one of those fields. So "which lines print a pack
 *     count" is answered by the field list the Mod publishes, not by a list somebody remembered.</li>
 * </ul>
 *
 * <p>
 * WHY IT IS NOT A SHAPE CHECK. Two things are asserted, and each was red once against the real defect: the renderer must
 * consult `freshness.proved`, AND `composeFactBrief` must hand `provedPackCounts(input.events)` to `composeWorldState`.
 * A renderer that reads `freshness.proved` from a map nobody filled is the same silence with more code, so the wiring is
 * checked as its own member.
 * </p>
 *
 * <p>
 * WHAT THIS GATE DOES NOT COVER, named rather than left to be discovered: `formatGameEnvironmentFacts`
 * (`host/src/game-world-vocabulary.ts`) prints `体力: …` from the same reading and is a line of this block, but it is one
 * function shared with the Chat surface's `<runtime-environment>`, so it is NOT a pack line and is not judged here. That
 * is a boundary of this unit and it is printed in the report as `outside:formatGameEnvironmentFacts` so it cannot become
 * invisible. The next unit that touches a body quantity starts by widening the pack declaration above.
 * </p>
 *
 * Usage:
 *   node tools/check-stale-line-age.mjs                # the gate; exit 1 on a violation, 2 when nothing was examined
 *   node tools/check-stale-line-age.mjs --json         # every line's disposition, machine-readable
 *   node tools/check-stale-line-age.mjs --root <dir>   # the gate's own fixture (a copied tree)
 *
 * red-proof: inject  restoring `formatHeldSeeds`'s pre-fix body (no `freshness`, count straight from `heldCount`) in a
 *            copied tree -> exit 1, `a_line_can_go_stale_without_saying_so:formatHeldSeeds`
 *            (tools/check-stale-line-age.test.mjs)
 * red-proof: inject  dropping the proof from the composition (`composeWorldState(input.snapshot)` in a copied tree) ->
 *            exit 1, `pack_proof_not_wired:composeFactBrief` (the same suite)
 */

export const gateDeclaration = {
  id: "check-stale-line-age",
  domain: "product",
  tier: "l0",
  kind: "totality",
};

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { snapshotFields } from "./check-snapshot-field-rendering.mjs";
import { withoutComments } from "./lib/gate-preamble.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the block she reads is composed. */
export const COMPOSER_SOURCE = "host/src/fact-brief.ts";

/** Where the wire declares what a Mod snapshot may carry. */
export const PROTOCOL_SOURCE = "host/src/protocol.ts";

/** The vocabularies the composer calls, for a line whose renderer lives beside the Chat surface's own. */
export const VOCABULARY_SOURCE = "host/src/game-world-vocabulary.ts";

/**
 * A wire field that carries a PACK QUANTITY: how many of a thing she holds.
 *
 * The pattern is over the wire's own key names, so a family the Mod adds (`inventoryUnitFacts`, a second seed family)
 * is in the population the day it is published. It is deliberately narrow: `stamina` and `health` are quantities too,
 * and they are NOT pack quantities - the next unit that widens this must also answer for
 * `formatGameEnvironmentFacts`, which is another module's line.
 */
export const PACK_FIELD = /inventory|seed/iu;

/** The freshness member a pack renderer must consult: `freshness.proved` (`PackFreshness` in the composer). */
const PROOF_READ = /freshness\s*\.\s*proved/u;

/** The derivation the composition must hand the block. */
const PROOF_DERIVATION = /\bprovedPackCounts\s*\(\s*input\s*\.\s*events\s*\)/u;

/** The body of one declared function, brace-matched, comments stripped. */
function functionBody(source, declaration) {
  const code = withoutComments(source);
  const at = code.indexOf(declaration);
  if (at < 0) return null;
  const open = code.indexOf("{", at);
  if (open < 0) return null;
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === "{") depth += 1;
    else if (code[index] === "}") {
      depth -= 1;
      if (depth === 0) return code.slice(open, index + 1);
    }
  }
  return null;
}

/**
 * Every line `<world-state>` emits, as the renderer that composes it.
 *
 * A `parts.push(x)` whose `x` is a local bound to `someCall(...)` names the renderer. A `parts.push` of a template or a
 * call expression directly is not a line of the block's own - the stale token and its sentence are the age itself, so
 * they are not candidates for going stale.
 */
export function worldStateLines(source) {
  const body = functionBody(source, "export function composeWorldState");
  if (body === null) return null;
  const lines = [];
  for (const match of body.matchAll(/parts\s*\.\s*push\(\s*([A-Za-z_$][\w$]*)\s*\)/gu)) {
    const local = match[1];
    const binding = new RegExp(`const\\s+${local}\\s*=\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, "u").exec(body);
    if (binding === null) continue;
    lines.push(Object.freeze({ local, renderer: binding[1] }));
  }
  return lines;
}

/** The body of one renderer, from the composer's own module or the vocabulary it calls. */
function rendererBody(name, sources) {
  for (const source of sources) {
    const body = functionBody(source, `function ${name}(`);
    if (body !== null) return { body, found: true };
  }
  return { body: "", found: false };
}

const read = (root, path) => {
  try {
    return readFileSync(resolve(root, path), "utf8");
  } catch {
    return null;
  }
};

/**
 * The whole reading: every line of `<world-state>`, which of them print a pack quantity, and which of those say how
 * fresh the quantity is.
 *
 * `dispositions` is one row per line - the report a lane reads to find its own debt - and `violations` is what makes the
 * exit code 1. `unreadable` is a source this gate needed and could not read, which is reported as blocked: a line that
 * cannot be examined is not a line that passed.
 */
export function auditStaleLines({ root = REPOSITORY_ROOT } = {}) {
  const composer = read(root, COMPOSER_SOURCE);
  const protocol = read(root, PROTOCOL_SOURCE);
  const vocabulary = read(root, VOCABULARY_SOURCE);
  const unreadable = [];
  if (composer === null) unreadable.push(COMPOSER_SOURCE);
  if (protocol === null) unreadable.push(PROTOCOL_SOURCE);
  if (vocabulary === null) unreadable.push(VOCABULARY_SOURCE);
  if (unreadable.length > 0)
    return {
      status: "blocked",
      examined: 0,
      reemitted: 0,
      canGoStale: 0,
      dispositions: [],
      violations: [],
      unreadable,
    };

  const lines = worldStateLines(composer);
  if (lines === null)
    return {
      status: "blocked",
      examined: 0,
      reemitted: 0,
      canGoStale: 0,
      dispositions: [],
      violations: [],
      unreadable: [`${COMPOSER_SOURCE}: composeWorldState is not declared in the shape this gate reads`],
    };
  if (lines.length === 0)
    return {
      status: "blocked",
      examined: 0,
      reemitted: 0,
      canGoStale: 0,
      dispositions: [],
      violations: [],
      unreadable: [`${COMPOSER_SOURCE}: composeWorldState pushes no renderer, so there are no lines to judge`],
    };

  let packFields;
  try {
    packFields = snapshotFields(protocol).filter((field) => PACK_FIELD.test(field));
  } catch (error) {
    return {
      status: "blocked",
      examined: lines.length,
      reemitted: 0,
      canGoStale: 0,
      dispositions: [],
      violations: [],
      unreadable: [`${PROTOCOL_SOURCE}: ${error.message}`],
    };
  }
  if (packFields.length === 0)
    return {
      status: "blocked",
      examined: lines.length,
      reemitted: 0,
      canGoStale: 0,
      dispositions: [],
      violations: [],
      unreadable: [`${PROTOCOL_SOURCE}: no field matches ${String(PACK_FIELD)} - the pack declaration has drifted`],
    };

  const sources = [composer, vocabulary];
  const dispositions = [];
  const violations = [];
  for (const line of lines) {
    const { body, found } = rendererBody(line.renderer, sources);
    if (!found) {
      dispositions.push({ line: line.local, renderer: line.renderer, found: false });
      violations.push({
        code: `world_state_line_unread:${line.renderer}`,
        line: line.local,
        detail: `composeWorldState pushes a line composed by ${line.renderer}, which neither ${COMPOSER_SOURCE} nor ${VOCABULARY_SOURCE} declares: a line this gate cannot read is not a line that passed`,
      });
      continue;
    }
    const printed = packFields.filter((field) =>
      new RegExp(`\\.${field}\\b|["']${field}["']|\\{[^}]*\\b${field}\\b[^}]*\\}\\s*=`, "u").test(body),
    );
    if (printed.length === 0) {
      dispositions.push({ line: line.local, renderer: line.renderer, found: true, pack: false });
      continue;
    }
    const reemitted = PROOF_READ.test(body);
    dispositions.push({
      line: line.local,
      renderer: line.renderer,
      found: true,
      pack: true,
      fields: printed,
      reemitted,
    });
    if (reemitted) continue;
    violations.push({
      code: `a_line_can_go_stale_without_saying_so:${line.renderer}`,
      line: line.local,
      detail: `${line.renderer} prints ${printed.join(", ")} and never consults this delivery's own count (${PROOF_READ.source}): the number she plans against is the reading's, with neither a proof nor an age on it`,
    });
  }

  // THE WIRING, as its own member: a renderer that reads a map nobody filled is the same silence with more code.
  const brief = functionBody(composer, "export function composeFactBrief");
  if (brief === null) {
    violations.push({
      code: "pack_proof_not_wired:composeFactBrief",
      line: "composeFactBrief",
      detail:
        "composeFactBrief is not declared in the shape this gate reads, so the proof cannot be shown to reach the block",
    });
  } else if (!PROOF_DERIVATION.test(brief)) {
    violations.push({
      code: "pack_proof_not_wired:composeFactBrief",
      line: "composeFactBrief",
      detail: `composeFactBrief composes <world-state> without ${PROOF_DERIVATION.source}: every pack line then prints the reading's count however fresh the delivery is`,
    });
  }

  const packLines = dispositions.filter((entry) => entry.pack === true);
  if (packLines.length === 0 && violations.length === 0) {
    violations.push({
      code: "no_pack_line_in_the_block",
      line: "composeWorldState",
      detail: `no line of <world-state> reads ${packFields.join(", ")}: with no population this gate would agree with itself`,
    });
  }

  return {
    status: violations.length === 0 ? "passed" : "failed",
    examined: dispositions.length,
    reemitted: packLines.filter((entry) => entry.reemitted === true).length,
    canGoStale: packLines.filter((entry) => entry.reemitted !== true).length,
    packFields,
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
  const reading = auditStaleLines({ root });
  const blocked = reading.status === "blocked";
  const checks = [
    {
      id: "line_population",
      status: reading.examined === 0 ? "blocked" : "passed",
      detail: `${String(reading.examined)} line(s) of <world-state>`,
    },
    {
      id: "every_pack_line_says_how_fresh_it_is",
      status: blocked ? "blocked" : reading.canGoStale === 0 ? "passed" : "failed",
      detail: `${String(reading.reemitted)} re-emitted · ${String(reading.canGoStale)} can go stale`,
    },
  ];
  const report = {
    gate: "stale-line-age",
    status: reading.status,
    examined: reading.examined,
    reemitted: reading.reemitted ?? 0,
    canGoStale: reading.canGoStale ?? 0,
    packFields: reading.packFields ?? [],
    checks,
  };
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ...report, violations: reading.violations, dispositions: reading.dispositions })}\n`,
    );
  } else {
    for (const line of reading.unreadable) process.stderr.write(`stale_line_age_unreadable: ${line}\n`);
    for (const violation of reading.violations) process.stderr.write(`${violation.code}: ${violation.detail}\n`);
    process.stdout.write(
      `world-state lines examined ${String(report.examined)} · re-emitted ${String(report.reemitted)} · ` +
        `can-go-stale ${String(report.canGoStale)} · status ${report.status}\n`,
    );
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
  if (reading.examined === 0 || blocked) {
    process.stderr.write(
      "stale_line_age: no line could be examined, so nothing can be judged; a green run reads examined>=1\n",
    );
    process.exitCode = 2;
    return;
  }
  process.exitCode = reading.status === "passed" ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
