#!/usr/bin/env node
/**
 * CI gate for the DUPLICATED AUTHORITY class (see lib/duplicated-authority.mjs).
 *
 * Default output is the first finding in `duplicated_authority:<id>:<path>:<line>`
 * form and exit 1; `--json` prints the authority count beside every finding (still
 * exit 1 when any exist). A clean repo prints `duplicated_authority: none (authorities
 * examined N)`, and an empty declaration table is exit 2 rather than a clean tree.
 *
 * red-proof: inject  the same literal spelled in a second module -> `duplicated_authority:<id>:<path>:<line>`
 *                    (tools/lib/duplicated-authority.test.mjs, "a literal in two modules is caught")
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DECLARED, findDuplicatedAuthorities, formatFinding } from "./lib/duplicated-authority.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const findings = findDuplicatedAuthorities(repoRoot);
// The population is the DECLARED table: each entry is one fact this gate asserts has exactly one owner. An empty table
// would make "no second spelling" true of nothing while printing the same `none` a scan of the tree prints.
if (DECLARED.length === 0) {
  process.stderr.write(
    "duplicated_authority_blocked:no_declared_authority: examined 0 authorities, so nothing's single owner was " +
      "asserted anywhere in the tree\n",
  );
  process.exitCode = 2;
} else if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify({ examined: DECLARED.length, findings }, null, 2)}\n`);
  process.exitCode = findings.length === 0 ? 0 : 1;
} else if (findings.length === 0) {
  console.log(`duplicated_authority: none (authorities examined ${String(DECLARED.length)})`);
  process.exitCode = 0;
} else {
  console.log(formatFinding(findings[0]));
  console.log(
    `duplicated_authority: ${String(findings.length)} second spelling(s) · authorities examined ${String(DECLARED.length)}`,
  );
  process.exitCode = 1;
}
