/**
 * A gate that measured nothing is not a gate that passed, and an exit status cannot tell the two apart.
 *
 * Three instances in one night, for three different reasons:
 *
 *   - `tools/live-run/frontend/phases/capture.mjs` skipped all twenty drivers on a populated stage and
 *     printed `DONE-CAPTURE failed=0 of 20 (skipped=0)`, exit 0 (fixed in `70d4dad8`);
 *   - `tools/check-draft-declaration-coverage.mjs` failed to parse the reporter's line, so its population
 *     was empty, and it printed `{"status":"passed","fields":0}` (fixed in `e22e2d3f`, `3005803c`);
 *   - `check:perf-budget` on a machine that did not record the baseline prints `perf_budget_skipped:` and
 *     exits 0 by design, which the aggregate counts `not_measured` rather than `passed`.
 *
 * The common shape is a gate that prints its own report: it names itself (`gate`) and how many objects it
 * looked at (`population`, `fields` or `cases`). Zero of those objects, with nothing else explaining it, is a
 * measurement that did not happen - the report says "passed" and describes no evidence.
 *
 * The population field is a short declared set, not every number a report might carry. `files`, `checked`,
 * `count` and their neighbours appear on gates that legitimately examine nothing (a ratchet with an empty
 * ignore list, a diff over no changes), and pulling them in would fail those gates for being correct. A gate
 * whose zero really is healthy says so in its own report - `allowEmpty: "<why zero is the healthy reading>"`
 * - and is then counted `not_measured`, never `passed`: an empty population is not a comparison, whatever
 * the reason for it.
 */

/**
 * The fields a report may carry its population under. Every member is "objects this gate examined"; a new
 * member has to mean the same thing, or the rule it feeds says nothing.
 *
 * `examined` is the fourth because the repository already states the rule in those words - "`0 findings` means nothing
 * without `examined N`" - and five gates printed exactly that number while the judge could not read it, which made
 * them count as gates whose zero is invisible. The list is exported because the static census in
 * `tools/audit-gate-red-proofs.mjs` has to look for the SAME names in a gate's source: two spellings of this list
 * disagree the first time a member is added here and not there.
 */
export const POPULATION_FIELDS = Object.freeze(["population", "fields", "cases", "examined"]);

/**
 * The field list as a pattern for a gate's SOURCE, for a reader that cannot run the gate.
 *
 * A report writes one of the names as a key (`population: 3`, `"cases": 3`); the pattern therefore matches the key
 * position only, so a gate that mentions `examined` in prose or in a message is not read as declaring a population.
 */
export function populationFieldPattern() {
  return new RegExp(`(?:^|[\\s{,"'\u0060])(?:${POPULATION_FIELDS.join("|")})["']?\\s*[:,}]`, "u");
}

/**
 * Judge one gate report's population.
 *
 * Returns `null` when the value is not a report about a population at all (no `gate` id, or no population
 * field), so a caller can leave such a gate to its exit status alone. Otherwise:
 *
 *   { status: "passed",       detail: "examined <n> <field>" }              the measurement happened
 *   { status: "not_measured", detail: "gate_zero_population_allowed:..." }  zero, with a stated reason
 *   { status: "blocked",      detail: "gate_measured_nothing:<gate>:<field>" } zero, unexplained
 *
 * `minPopulation` is what counts as a measurement; a negative population is a broken report and is blocked
 * with the same named reason, because a number the gate cannot have counted is not evidence either.
 */
export function assertNonVacuous(report, { minPopulation = 1, allowEmpty } = {}) {
  if (typeof report?.gate !== "string" || report.gate === "") return null;
  const field = POPULATION_FIELDS.find((name) => typeof report[name] === "number");
  if (field === undefined) return null;
  const measured = report[field];
  if (measured >= minPopulation && measured >= 0) return { status: "passed", detail: `examined ${measured} ${field}` };
  // A caller that builds the report can state the reason itself; a caller reading another process's stdout
  // can only read it out of the report, which is why both are accepted and neither is guessed.
  const reason = allowEmpty ?? report.allowEmpty;
  if (typeof reason === "string" && reason.trim() !== "")
    return {
      status: "not_measured",
      detail: `gate_zero_population_allowed:${report.gate}:${field} ${reason.trim()}`,
    };
  return { status: "blocked", detail: `gate_measured_nothing:${report.gate}:${field}` };
}
