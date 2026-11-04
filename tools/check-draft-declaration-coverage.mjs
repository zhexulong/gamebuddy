#!/usr/bin/env node
/**
 * The gate for "a text field whose contents die when its component unmounts" - as a COVERAGE question.
 *
 * The product's answer to that family is a declared draft surface: the words live in the shell's
 * `SurfaceDrafts` store, the control that opens the editor carries `data-draft-revealer`, and
 * `dialogue-web/tests/draft-survives-interruption.spec.ts` walks every declared revealer, types into
 * every control it can reach, switches surface and back, and requires the words to still be there.
 *
 * What that journey cannot do is notice an editor nobody declared. It enumerates the DOM it reaches
 * and presses the revealers the product declares; an editor behind an undeclared opener is outside
 * both, so the journey reports a clean surface while the player's own field sat one press away. That
 * is how three editors were each fixed one at a time with nothing watching the class.
 *
 * So the judgement is `dialogue-web/tests/draft-declaration-coverage.spec.ts`, and this file is its
 * operator-facing entry: it refuses by name when the mounted zone's prerequisite is missing (no
 * Chromium, no dev-server port), runs the journey, and prints the reading - every text field found
 * per surface with its status, every surface it could not assess with the reason, and every violation.
 *
 * Why this is not a static scan of the sources: the population has to be the RENDERED one. A field is
 * a field when the player can type into it, and a source grep cannot tell a textarea in a closed
 * `<details>` from one on screen, an editor behind a press from one always drawn, or a component that
 * renders in this shell at all. The journey mounts the real product against a stubbed Host and presses
 * what it renders, so the population is discovered rather than remembered.
 *
 * Usage:
 *   node tools/check-draft-declaration-coverage.mjs            # the gate; exit 1 on a violation
 *   node tools/check-draft-declaration-coverage.mjs --json     # the reading, machine-readable
 *
 * red-proof: inject  deleting `data-draft-revealer` from the transcript row's edit control ->
 *                    `chat: pressing button[data-testid="message-edit"] reveals textarea[data-testid],
 *                    which no declared editor reaches`, with `fields=1 revealers=0` where the green
 *                    run reads `fields=2 revealers=1`
 *                    (dialogue-web/tests/draft-declaration-coverage.spec.ts)
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolsRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(toolsRoot, "..");
const webRoot = join(repositoryRoot, "dialogue-web");
const JOURNEY = "tests/draft-declaration-coverage.spec.ts";

/** A child process with its output captured, so the report can quote what the journey said. */
function run(command, args, options) {
  return spawnSync(command, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

/** The lines the journey prints as its reading, kept verbatim so nothing here restates them. */
function readingLines(stdout) {
  return String(stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("MEASURE ") || line.startsWith("unassessed: "));
}

/** The fields found per surface, as the journey reported them. */
function inventory(stdout) {
  const rows = [];
  for (const line of readingLines(stdout)) {
    if (!line.startsWith("MEASURE inventory ")) continue;
    for (const row of JSON.parse(line.slice("MEASURE inventory ".length))) rows.push(row);
  }
  return rows;
}

/** The surfaces the journey could not assess, each with the reason it gave. */
function unassessed(stdout) {
  return readingLines(stdout)
    .filter((line) => line.startsWith("unassessed: "))
    .map((line) => line.slice("unassessed: ".length));
}

/** A failing assertion's first line, which is where Playwright puts the named violation. */
function failures(stdout) {
  return String(stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\+\s+"/u.test(line))
    .map((line) => line.replace(/^\+\s+"/u, "").replace(/",?$/u, ""));
}

function report({ status, rows, missed, violations, detail }) {
  return {
    gate: "draft-declaration-coverage",
    status,
    mode: "mounted",
    fields: rows.length,
    declared: rows.filter((row) => row.status === "declared").length,
    exempt: rows.filter((row) => row.status === "exempt").length,
    unassessed: missed,
    violations,
    detail,
  };
}

const journey = join(webRoot, JOURNEY);
if (!existsSync(journey)) {
  process.stdout.write(
    `${JSON.stringify(report({ status: "blocked", rows: [], missed: [], violations: [], detail: `${JOURNEY} is not in the tree` }))}\n`,
  );
  process.stderr.write(`draft_declaration_coverage: no journey at dialogue-web/${JOURNEY}\n`);
  process.exit(1);
}

// The zone's own prerequisite probe goes first, so a missing browser or a taken dev-server port is
// refused by name instead of surfacing as a runner error about something else.
const prerequisite = run("node", [join("tests", "gate-zone-prerequisite.mjs"), "mounted"], { cwd: webRoot });
if (prerequisite.status !== 0) {
  const detail = `${prerequisite.stdout ?? ""}${prerequisite.stderr ?? ""}`.trim();
  process.stdout.write(
    `${JSON.stringify(report({ status: "blocked", rows: [], missed: [], violations: [], detail }))}\n`,
  );
  process.stderr.write(`draft_declaration_coverage: the mounted zone refused to run\n${detail}\n`);
  process.exit(1);
}

const executed = run(
  "pnpm",
  ["exec", "playwright", "test", JOURNEY, "--project=chromium", "--workers=1", "--reporter=line"],
  { cwd: webRoot },
);
const output = `${executed.stdout ?? ""}${executed.stderr ?? ""}`;
const rows = inventory(output);
const missed = unassessed(output);
const violated = failures(output);
const status = executed.status === 0 ? "passed" : "failed";
const reading = report({
  status,
  rows,
  missed,
  violations: violated,
  detail: executed.status === 0 ? null : "the journey failed; see its output above",
});

for (const row of rows)
  process.stdout.write(
    `  ${row.surface} :: ${row.key} -> ${row.status}${row.note === undefined ? "" : ` (${row.note})`}\n`,
  );
for (const line of missed) process.stdout.write(`  unassessed: ${line}\n`);
process.stdout.write(`${JSON.stringify(reading)}\n`);
for (const violation of violated) process.stderr.write(`draft_declaration_coverage: ${violation}\n`);
process.exit(executed.status === 0 ? 0 : 1);
