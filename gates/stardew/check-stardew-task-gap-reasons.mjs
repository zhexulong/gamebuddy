#!/usr/bin/env node
/**
 * Does a task's declared GAP still hold?
 *
 * A rotation task whose purpose cannot be decided from published facts is declared as a `gap(...)` in
 * `tools/lib/task-purpose.mjs`, and its `missingFact` sentence is the reason the tree gives for answering `unproven`
 * for that task for ever. That sentence is a claim about TODAY's catalog, and nothing re-read it.
 *
 * Measured 2026-11-16. `mine_ladder_to_depth` said the exit half was `use_mine_ladder`, "which the Mod catalog
 * registers `FarmhandActionLifecycle.Experimental` (`FarmhandActionDefinitions.cs:270`)". The action had been promoted
 * to `LiveVerified` with a live gate runner, a gate row and a fixture, and the line the reason cited now held a
 * different declaration entirely - so the entry named a blocker that no longer existed, cited a line that had moved,
 * and the tree answered "this task cannot be decided" for a criterion that was writable. Three more entries made the
 * same class of mistake in words rather than in lifecycle: `town_market` and `home_and_hearth` said "no fact says ..."
 * where the truth was "the RECEIPT does not carry it, and the observation publishes it", and `town_visit` named the
 * opposite half as missing. A stale gap is worse than a stale criterion: it is invisible, because `unproven` is what a
 * gap is FOR, so nothing downstream can tell a purpose that cannot be decided from a purpose nobody re-checked.
 *
 * WHAT THIS GATE ASSERTS. Every `gap(...)` entry declares, in structured form, the facts its reason rests on, and each
 * of those facts is still true today. A claim is one of:
 *
 *   `actionLifecycle(actionId, lifecycle)`      the catalog's lifecycle for that action is `lifecycle`
 *   `actionPostcondition(actionId, name)`       the postcondition the catalog declares for it is `name`
 *   `absentAction(actionId)`                    the catalog declares no such action id
 *   `absentEvidenceField(actionId, field)`      that action's receipt cannot carry `field`
 *   `presentEvidenceField(actionId, field)`     that action's receipt does carry `field`
 *   `proseReason(refutableBy)`                  nothing above can state it; the artifact that would refute it is named
 *
 * The first five are read from the two authorities the tree already has: the Mod's generated action surface
 * (`.../contracts/generated/action-surface.v1.json`, re-derived by `tools/check-action-surface-parity.mjs` and
 * `tools/check-generated-artifact-reproducibility.mjs`) for lifecycles and postconditions, and the Host's completion
 * contract (`host/src/stardew-completion-contracts.ts`) for the evidence keys a receipt may carry. The Host's rule is
 * `required ⊆ emitted ⊆ required ∪ optional` (`declaredCompletionEvidence`), so a key absent from that contract is a
 * key the receipt CANNOT carry - which is what makes "the receipt carries no location" a fact rather than a memory.
 *
 * THAT CONTRACT IS READ THROUGH `readHostCompletionContracts`, the parser `tools/check-stardew-postcondition-delta.mjs`
 * already owns, rather than a second one here: two parsers of one contract is the drift this repository keeps paying
 * for. Its own findings (a predicate it cannot locate, a contract nothing dispatches) are this gate's `blocked` state,
 * because a key set derived from a source the parser refused is not a measurement.
 *
 * PROSE IS A DECLARED DEBT, NOT A SILENCE. An entry whose reason rests on an absence no artifact enumerates - "no
 * subdivision of the Farm is named", "no module declares which maps count as Town", "no action's postcondition is the
 * room tidied" - declares `reason: "prose"` and carries a `proseReason` naming what would refute it. The gate makes the
 * two agree in both directions: an entry declaring `mechanical` may carry no prose claim, and one declaring `prose`
 * must carry one. So `mechanical 0` is a real reading here, not a parser failure: today every gap's blocker is an
 * absence of a declaration or of an action, while the receipt shape each sentence quotes IS checked.
 *
 * A LINE NUMBER IN A REASON IS REFUSED. The citation is what let `mine_ladder_to_depth` outlive its blocker: the file
 * and the line were both real, and the line had moved on. A reason may name a file and an identifier; a `file.cs:270`
 * is a claim about a layout this gate cannot re-check, so it is a finding rather than a citation.
 *
 * POPULATION. Every entry of `TASK_PURPOSE_CRITERIA` carrying `missingFact`, read by importing
 * `tools/lib/task-purpose.mjs` - the one place a task's purpose is declared - never a list here. The sweep tasks join
 * through the same import, because their gap entries are built from `SWEEP_DAILY_TASKS` and their reasons are the same
 * kind of claim. A task added tomorrow is covered by existing, and the failure names it.
 *
 * REPORT. `gaps examined N · mechanical M · prose P · expired K`, then the claim line, then one line per expired claim
 * or finding. Zero population is BLOCKED (exit 2) rather than green, and a contract this gate could not read is
 * BLOCKED too - never folded into `expired 0`.
 *
 * USAGE:
 *   node tools/check-stardew-task-gap-reasons.mjs
 *
 * Exit 1 on any expired claim or finding; exit 2 when nothing was measured.
 */

export const gateDeclaration = {
  id: "check-stardew-task-gap-reasons",
  domain: "stardew",
  tier: "l2",
  kind: "totality",
};

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { readHostCompletionContracts } from "./check-stardew-postcondition-delta.mjs";
import { TASK_PURPOSE_CRITERIA } from "../../tools/lib/task-purpose.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));

const SURFACE = join(
  REPO,
  "integrations",
  "stardew",
  "action-development",
  "contracts",
  "generated",
  "action-surface.v1.json",
);

const HOST_CONTRACT = join(REPO, "host", "src", "stardew-completion-contracts.ts");

/** The claim kinds this gate can check, and the one it cannot. */
export const MECHANICAL_CLAIM_KINDS = Object.freeze([
  "action_lifecycle",
  "action_postcondition",
  "absent_action",
  "absent_evidence_field",
  "present_evidence_field",
]);
export const PROSE_CLAIM_KIND = "prose";

/** The declared reason classes, and the `reason` value each gap entry must carry. */
export const GAP_REASON_CLASSES = Object.freeze(["mechanical", "prose"]);

/** A `proseReason` has to name something: this is the floor below which it names no artifact. */
const MINIMUM_REFUTATION_LENGTH = 40;

/**
 * A source citation into a file's LAYOUT, which is the one claim a reason may not make: the line a reason cited is how
 * `mine_ladder_to_depth` outlived its blocker.
 */
const LINE_CITATION = /\b[A-Za-z0-9_-]+\.(?:cs|ts|mjs|json):\d+/u;

/** The reason an entry declares for itself, and the reading the claim kinds support. */
function claimClass(claims) {
  return claims.some((claim) => claim?.kind === PROSE_CLAIM_KIND) ? "prose" : "mechanical";
}

/** One claim as the failure message names it - the `<cited blocker>` half of `gap_reason_no_longer_holds`. */
function describeClaim(claim) {
  switch (claim?.kind) {
    case "action_lifecycle":
      return `action_${claim.actionId}_lifecycle`;
    case "action_postcondition":
      return `action_${claim.actionId}_postcondition`;
    case "absent_action":
      return `action_${claim.actionId}_absent_from_the_catalog`;
    case "absent_evidence_field":
      return `receipt_for_${claim.actionId}_carries_no_${claim.field}`;
    case "present_evidence_field":
      return `receipt_for_${claim.actionId}_carries_${claim.field}`;
    default:
      return `unreadable_claim_${String(claim?.kind)}`;
  }
}

/**
 * One mechanical claim against the two authorities.
 *
 * Three outcomes, and the third is why this cannot be a boolean: `blocked` means the authority this claim rests on was
 * not readable for that action, which is neither "the claim holds" nor "the claim expired".
 */
function readClaim(claim, catalogue, contracts) {
  const entry = catalogue.get(claim.actionId);
  switch (claim.kind) {
    case "absent_action":
      return entry === undefined ? { state: "holds" } : { state: "expired", measured: `the catalog declares it` };
    case "action_lifecycle":
      if (entry === undefined) return { state: "expired", measured: "the catalog declares no such action" };
      return entry.lifecycle === claim.lifecycle
        ? { state: "holds" }
        : { state: "expired", measured: `lifecycle=${String(entry.lifecycle)}` };
    case "action_postcondition":
      if (entry === undefined) return { state: "expired", measured: "the catalog declares no such action" };
      return entry.postcondition === claim.name
        ? { state: "holds" }
        : { state: "expired", measured: `postcondition=${String(entry.postcondition)}` };
    default: {
      const contract = contracts.get(claim.actionId);
      if (contract === undefined) return { state: "blocked", measured: "the Host declares no completion contract" };
      // A key list read as empty is a contract whose keys this reader could not resolve (its shape is `"key" in
      // evidence` rather than an array literal). Reading that as "carries no field" would pass every absent-field
      // claim about such an action, so it is refused by name instead.
      if (contract.keys.length === 0) return { state: "blocked", measured: "its evidence keys could not be read" };
      const carries = contract.keys.includes(claim.field);
      const expected = claim.kind === "present_evidence_field";
      return carries === expected
        ? { state: "holds" }
        : { state: "expired", measured: `keys=${contract.keys.join(",")}` };
    }
  }
}

/**
 * The whole reading, as data.
 *
 * Pure over its three inputs, so the falsifier can hand it a population and a catalog this repository does not have.
 * `criteria` is `TASK_PURPOSE_CRITERIA`; `catalogue` maps an action id to the lifecycle and postcondition name the
 * surface declares; `contracts` maps an action id to the evidence keys the Host admits.
 */
export function gapReasonReading({ criteria, catalogue, contracts, contractFindings = [] }) {
  const gaps = Object.entries(criteria ?? {}).filter(([, entry]) => typeof entry?.missingFact === "string");
  const expired = [];
  const violations = [];
  const blocked = contractFindings.map((finding) => Object.freeze({ code: `gap_reason_contract_${finding}` }));
  let mechanical = 0;
  let prose = 0;
  let claimsChecked = 0;
  let claimsProse = 0;

  for (const [task, entry] of gaps) {
    const claims = Array.isArray(entry.claims) ? entry.claims : [];
    if (claims.length === 0) {
      violations.push(Object.freeze({ code: `gap_reason_declares_no_claim:${task}` }));
      continue;
    }
    if (!GAP_REASON_CLASSES.includes(entry.reason)) {
      violations.push(Object.freeze({ code: `gap_reason_declares_no_reason_class:${task}` }));
      continue;
    }
    const measured = claimClass(claims);
    if (entry.reason !== measured) {
      violations.push(
        Object.freeze({ code: `gap_reason_class_disagrees_with_its_claims:${task}:${entry.reason}:${measured}` }),
      );
    }
    if (measured === "prose") prose += 1;
    else mechanical += 1;
    if (LINE_CITATION.test(entry.missingFact)) {
      violations.push(Object.freeze({ code: `gap_reason_cites_a_line:${task}` }));
    }
    for (const claim of claims) {
      if (claim?.kind === PROSE_CLAIM_KIND) {
        claimsProse += 1;
        if (typeof claim.refutableBy !== "string" || claim.refutableBy.trim().length < MINIMUM_REFUTATION_LENGTH) {
          violations.push(Object.freeze({ code: `gap_reason_prose_names_no_artifact:${task}` }));
        }
        continue;
      }
      if (!MECHANICAL_CLAIM_KINDS.includes(claim?.kind)) {
        violations.push(Object.freeze({ code: `gap_reason_claim_kind_unknown:${task}:${String(claim?.kind)}` }));
        continue;
      }
      claimsChecked += 1;
      // The sentence and the claim are ONE fact with two spellings: a claim the reason does not name can neither be
      // checked by a reader nor be trusted to describe what the gate is guarding.
      if (!entry.missingFact.includes(claim.actionId)) {
        violations.push(Object.freeze({ code: `gap_reason_does_not_name_its_claim:${task}:${claim.actionId}` }));
      }
      const reading = readClaim(claim, catalogue, contracts);
      if (reading.state === "expired") {
        expired.push(
          Object.freeze({
            code: `gap_reason_no_longer_holds:${task}:${describeClaim(claim)}`,
            measured: reading.measured,
          }),
        );
      } else if (reading.state === "blocked") {
        blocked.push(
          Object.freeze({
            code: `gap_reason_not_measured:${task}:${describeClaim(claim)}`,
            measured: reading.measured,
          }),
        );
      }
    }
  }

  return Object.freeze({
    examined: gaps.length,
    mechanical,
    prose,
    claimsChecked,
    claimsProse,
    expired: Object.freeze(expired),
    violations: Object.freeze(violations),
    blocked: Object.freeze(blocked),
  });
}

/** The two authorities plus the criteria module: one read, so the falsifier can hand the pure reader another tree. */
export function readGapReasonInputs({ surfacePath = SURFACE, hostContractPath = HOST_CONTRACT } = {}) {
  const artifact = JSON.parse(readFileSync(surfacePath, "utf8"));
  const catalogue = new Map(
    (artifact.actions ?? []).map((action) => [
      action.actionId,
      Object.freeze({
        actionId: action.actionId,
        lifecycle: action.lifecycle,
        postcondition: action.postcondition?.name ?? null,
      }),
    ]),
  );
  if (catalogue.size === 0) throw new Error("stardew_gap_reason_surface_declares_no_action");
  const { contracts, findings } = readHostCompletionContracts(readFileSync(hostContractPath, "utf8"));
  return Object.freeze({
    criteria: TASK_PURPOSE_CRITERIA,
    catalogue,
    contracts,
    contractFindings: Object.freeze(findings),
  });
}

/**
 * The verdict, as one decision rather than four branches inside the entry point: an empty population and an unreadable
 * contract are BLOCKED (2), a finding is red (1), and only a measured, expired-free reading is green.
 */
export function gapReasonVerdict(report) {
  if (report.examined === 0)
    return Object.freeze({
      exitCode: 2,
      code: "gap_reason_population_empty",
      detail: "no entry carries a missingFact",
    });
  if (report.blocked.length > 0)
    return Object.freeze({
      exitCode: 2,
      code: "gap_reason_not_measured",
      detail: `${String(report.blocked.length)} claim(s) rest on an authority this run could not read`,
    });
  if (report.expired.length > 0)
    return Object.freeze({
      exitCode: 1,
      code: "gap_reason_expired",
      detail: `${String(report.expired.length)} claim(s) are no longer true`,
    });
  if (report.violations.length > 0)
    return Object.freeze({
      exitCode: 1,
      code: "gap_reason_findings",
      detail: `${String(report.violations.length)} finding(s)`,
    });
  return Object.freeze({ exitCode: 0, code: null, detail: null });
}

if (import.meta.main) {
  const report = gapReasonReading(readGapReasonInputs());
  const lines = [
    `gaps examined ${String(report.examined)} · mechanical ${String(report.mechanical)} · prose ${String(report.prose)} · ` +
      `expired ${String(report.expired.length)}`,
    `claims checked ${String(report.claimsChecked)} · prose ${String(report.claimsProse)} · ` +
      `blocked ${String(report.blocked.length)} · findings ${String(report.violations.length)}`,
  ];
  for (const entry of report.expired) lines.push(`  EXPIRED ${entry.code} (${entry.measured})`);
  for (const entry of report.blocked) lines.push(`  BLOCKED ${entry.code} (${entry.measured})`);
  for (const entry of report.violations) lines.push(`  VIOLATION ${entry.code}`);
  const verdict = gapReasonVerdict(report);
  if (verdict.code !== null) lines.push(`${verdict.code}: ${verdict.detail}`);
  process.stdout.write(`${lines.join("\n")}\n`);
  process.exitCode = verdict.exitCode;
}
