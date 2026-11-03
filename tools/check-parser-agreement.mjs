#!/usr/bin/env node
/**
 * CI gate for the PARSER AGREEMENT class: one vocabulary with two readers that disagree about which
 * tokens are in it (see `lib/parser-agreement.mjs` for the four measured instances and for why the
 * probe corpus is not derived from the grammar under test).
 *
 * Default output is one line per finding in `parser_agreement_<code>:<vocabulary>[:<reader>]: ...`
 * form and exit 1; a clean tree prints the reading and exits 0. The reading is printed on a pass as
 * well, because a comparison that measured nothing is not a comparison that agreed - the counts say
 * how many readers and how many members actually met.
 *
 * One drift names many members (a grammar that loses its `\s*` disagrees about every spaced spelling),
 * so the report prints the first `MAX_PRINTED_FINDINGS` and the total; `--all` prints every finding.
 *
 * The macro entry's own grammar is shared, so removing `\s*` from `BRACED_MACRO` moves BOTH readers and
 * reaches no finding (that is what `e6b09cc7` bought). The red case therefore replays the split the fix
 * removed: recognition with its own flush-brace spelling, classification still tolerating a space.
 *
 * red-proof: history  the pre-`e6b09cc7` split grammar -> `parser_agreement_member_disagreement`
 *                    names `macroKey` accepting `{{ char }}` and `MACRO_PATTERN` not
 *                    (tools/lib/parser-agreement.test.mjs)
 * red-proof: inject  a declared reader whose file is not on disk -> `parser_agreement_reader_missing`
 *                    names that vocabulary, that reader and the path instead of comparing one reader
 *                    fewer (tools/lib/parser-agreement.test.mjs)
 */
import { auditParserAgreement, formatFinding } from "./lib/parser-agreement.mjs";

/** How many findings one run prints. A drift that renames a grammar names hundreds of members. */
const MAX_PRINTED_FINDINGS = 20;

const { readings, findings } = auditParserAgreement();
const printAll = process.argv.includes("--all");
const printed = printAll ? findings : findings.slice(0, MAX_PRINTED_FINDINGS);
const summary = readings
  .map((reading) => `${reading.vocabulary}(readers=${reading.readers.length},members=${reading.members})`)
  .join(" ");

for (const finding of printed) process.stdout.write(`${formatFinding(finding)}\n`);
if (findings.length === 0) {
  process.stdout.write(`parser_agreement vocabularies=${readings.length} ${summary}: readers agree\n`);
} else {
  const shown = printed.length === findings.length ? "all" : `first=${printed.length} (--all prints every finding)`;
  process.stdout.write(`parser_agreement_findings total=${findings.length} shown=${shown} ${summary}\n`);
}
process.exitCode = findings.length === 0 ? 0 : 1;
