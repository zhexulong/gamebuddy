#!/usr/bin/env node
/**
 * CI gate for the UNIMPLEMENTED CLASS NAME class (see lib/class-name-declarations.mjs).
 *
 * Default output is the first undeclared class in `undeclared_class:<path>:<line>:<name>` form
 * plus a one-line total, and exit 1. `--json` prints the whole reading. A clean tree prints
 * `class_name_declarations: none (<n> names in <m> files, <k> classes declared)` and exits 0.
 *
 * A name the gate could not read is printed as `unreadable_class:<path>:<line>`: a gap the gate
 * names instead of skipping. Every gap and every exemption is declared in the module, and a
 * declaration that no longer describes the code it waives fails the same run.
 *
 * red-proof: inject  a `className` used in a `.tsx` file with no rule and no exemption ->
 *                    `undeclared_class:<that file>:<line>:visually-hidden-input-label`
 *                    (tools/check-class-name-declarations.test.mjs, "a name with no rule is a finding")
 * red-proof: history the tree at 4d0a2cc9^, where `visually-hidden-input-label` was written on two
 *                    labels and declared nowhere -> `undeclared_class:...:929` and `:947`
 *                    (tools/check-class-name-declarations.test.mjs, "the pre-fix tree is reported")
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkClassNameDeclarations, formatFinding, verdict } from "./lib/class-name-declarations.mjs";

const toolsDir = dirname(fileURLToPath(import.meta.url));
const rootIndex = process.argv.indexOf("--root");
const repoRoot =
  rootIndex >= 0 && typeof process.argv[rootIndex + 1] === "string"
    ? resolve(process.argv[rootIndex + 1])
    : resolve(toolsDir, "..");

const readout = checkClassNameDeclarations({ repoRoot });
const failed = verdict(readout);

if (process.argv.includes("--json")) {
  process.stdout.write(
    `${JSON.stringify(
      {
        gate: "class_name_declarations/v1",
        status: failed ? "failed" : "passed",
        root: repoRoot,
        counts: readout.counts,
        population: readout.counts.names,
        undeclared: readout.undeclared.map((entry) => ({
          className: entry.className,
          sites: entry.sites.map((site) => `${site.path}:${site.line}`),
        })),
        unreadable: readout.unreadable.map((site) => ({
          path: site.path,
          line: site.line,
          text: site.text,
          staticNames: site.names,
          declared: !readout.unreported.includes(site),
        })),
        staleExemptions: readout.staleExemptions,
        problems: readout.problems,
      },
      null,
      2,
    )}\n`,
  );
} else {
  const { counts } = readout;
  for (const site of readout.unreadable)
    process.stdout.write(`unreadable_class:${site.path}:${site.line}: ${site.text}\n`);
  for (const entry of readout.staleExemptions)
    process.stdout.write(`class_name_declaration_${entry.code}: ${entry.className}\n`);
  for (const problem of readout.problems)
    process.stdout.write(
      `${problem.code}: ${problem.path ?? problem.className}${problem.detail === undefined ? "" : ` (${problem.detail})`}\n`,
    );
  for (const entry of readout.undeclared) {
    const [first] = entry.sites;
    process.stdout.write(`${formatFinding({ ...first, className: entry.className })}\n`);
    process.stdout.write(
      `  used ${entry.sites.length} time(s): ${entry.sites.map((site) => `${site.path}:${site.line}`).join(", ")}\n`,
    );
  }
  if (!failed) {
    process.stdout.write(
      `class_name_declarations: none (${counts.names} names in ${counts.files} tsx files, ` +
        `${counts.declared} classes declared, ${counts.exempt} names exempt, ` +
        `${readout.unreadable.length} unreadable site(s) declared)\n`,
    );
  } else {
    const total = readout.undeclared.length + readout.staleExemptions.length + readout.problems.length;
    process.stdout.write(
      `class_name_declarations: ${total} finding(s); ${readout.unreported.length} unreadable site(s) undeclared\n`,
    );
  }
}

process.exitCode = failed ? 1 : 0;
