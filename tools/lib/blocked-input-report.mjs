/**
 * The report a gate prints when the authority it reads is not in this repository at all.
 *
 * WHY A SHAPE AND NOT JUST A LINE. Three gates in this tree read an input no commit carries and nothing produces
 * (`actor-admissibility.v1.json` twice, the Tavern semantic-reference registry once). Each used to die inside
 * `JSON.parse(readFileSync(...))`, which exits non-zero for a reason no reader can tell apart from a defect in the gate.
 * A line naming the path fixes the reader; it does not fix the two machines that also read a gate's run:
 *
 *   - `tools/lib/harness-conformance.mjs` runs a gate's default invocation and reads the JSON report it prints. A gate
 *     that exits before printing one is `falsifier_signature_missing` - the ladder red for a cause unrelated to the
 *     missing file. So the blocked run prints its report.
 *   - the same suite's population judge (`tools/lib/assert-non-vacuous.mjs`) reads `examined`. Zero with nothing else
 *     explaining it is `gate_measured_nothing`: a defect. Zero with a stated `allowEmpty` is `not_measured` - counted,
 *     named, never folded into the passes. That is the honest answer for a prerequisite this repository does not carry,
 *     and it is the reason `allowEmpty` holds the path rather than a phrase like "nothing to do".
 *
 * `status: "blocked"` is the gate's own verdict, every `checks[]` entry carries the same, and the caller still exits
 * non-zero: a report that a consumer reads wrongly must not become a pass, so the exit code says so as well.
 */

/**
 * Print `blocked`, the report, and exit 2.
 *
 * `examined` is a parameter rather than a constant on purpose: the static census in `tools/audit-gate-red-proofs.mjs`
 * reads a gate's SOURCE for a population field, so a gate whose only report is built in this module would read as a
 * gate that cannot show whether it measured anything. Each caller states the population it examined, in its own file.
 */
export function reportBlockedInput({ gate, input, examined, checks }) {
  console.log(`blocked: ${input} absent, so this was not measured`);
  console.log(
    JSON.stringify({
      gate,
      status: "blocked",
      input,
      examined,
      allowEmpty: `${input} is absent from this repository and nothing in it produces one, so there is nothing to measure`,
      checks: checks.map((id) => ({ id, status: "blocked" })),
    }),
  );
  process.exit(2);
}
