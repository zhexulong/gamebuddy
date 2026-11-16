/**
 * A test file this package's static zone does not name is a test nothing runs.
 *
 * WHY (measured 2026-11-16)
 *
 * `test:static` is a hand-written `node --test <files...>` list, so the list is the only thing that makes a
 * suite run - and `src/**` grows test files on its own, beside the producer each one judges. Measured at
 * `29b2e21c`: ten colocated `src/**\/*.test.ts` files, seven of them named. The three no command named were
 * `src/composed-problem-view.test.ts`, `src/game-presentation.test.ts` and
 * `src/components/turn-failure-text.test.ts`, and one of them had rotted in place - it pinned
 * `problemStepPresentation`'s own-read step to `stepLine: null`, while the producer drew a sentence beside the
 * control instead. That decision had moved in `449f0fb0`, a commit that says in its own message "No behaviour
 * changed", and the test it added to pin the move was never listed: the commit was green everywhere.
 *
 * THE POPULATION is a scan of `dialogue-web/src` for test files (`*.test.ts` is what lives there today), so a test
 * file joins the population by being committed beside its producer rather than by being remembered here.
 *
 * THE ENUMERATED SET is the `test:static` command line in `dialogue-web/package.json`, parsed - the script is
 * the authority for what the zone runs, and a second copy of its list in this file would be the same defect one
 * level up. `tests/**\/*.test.mjs` shares the hand-list shape and is deliberately NOT this gate's population:
 * `tools/check-spec-reachability.mjs` already derives that directory by scanning and judges it against the
 * commands a workflow reaches (measured at `29b2e21c`: `static_suites: 0 of 42 unreached`). Two gates over one
 * population would be two authorities for one fact; `src/**` is the half no scan in the tree covered.
 *
 * FAIL LOUDLY ON ZERO. A scan that finds no colocated test, or a `test:static` that names none, is a finding:
 * a gate that passes because it examined nothing is the defect this file is about.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIALOGUE_WEB = join(HERE, "..");
const MANIFEST = join(DIALOGUE_WEB, "package.json");

const toPosix = (path) => path.split(sep).join("/");

/** A path `node --test` takes as a test file, and therefore one this package's list can carry. */
const TEST_FILE = /\.test\.(?:ts|tsx|mts|cts|mjs|cjs|js)$/u;

/** Every test file under `src`, relative to `dialogue-web`. */
export function colocatedTests(directory = join(DIALOGUE_WEB, "src"), out = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) colocatedTests(path, out);
    else if (TEST_FILE.test(entry.name)) out.push(toPosix(relative(DIALOGUE_WEB, path)));
  }
  return out.sort();
}

/** The test files one script's own command line names, relative to `dialogue-web`. */
export function enumeratedBy(command) {
  const tokens = command.split(/\s+/u);
  const flag = tokens.indexOf("--test");
  return flag < 0 ? [] : tokens.slice(flag + 1).filter((token) => TEST_FILE.test(token)).map(toPosix);
}

/** The static zone's list, read from the script itself; `[]` when the script names no test at all. */
export function staticZone(manifest = readFileSync(MANIFEST, "utf8")) {
  const command = JSON.parse(manifest).scripts?.["test:static"];
  return typeof command === "string" ? enumeratedBy(command) : [];
}

/** Each colocated test the zone does not name, as the finding it is. */
export function unlisted(population, enumerated) {
  const named = new Set(enumerated);
  return population.filter((file) => !named.has(file)).map((file) => `unlisted_colocated_test: ${file}`);
}

test("test-enumeration.1: every colocated test is named by test:static", (t) => {
  const population = colocatedTests();
  const enumerated = staticZone();
  assert.ok(
    population.length > 0,
    "examined 0 test file(s) under src: either the package has none (then delete this gate) or the scan broke, " +
      "and a gate that passes on an empty population is the defect it exists to catch",
  );
  assert.ok(
    enumerated.length > 0,
    "test:static names no test file: the script moved, and every colocated test now runs nowhere",
  );
  const findings = unlisted(population, enumerated);
  t.diagnostic(
    `test-enumeration.1: examined ${population.length} test file(s) under src, ${population.length - findings.length} ` +
      `named by test:static (${enumerated.length} path(s) that script names in all), ${findings.length} unnamed`,
  );
  assert.deepEqual(
    findings,
    [],
    "a colocated test the static zone does not name never runs: add it to `test:static` in dialogue-web/package.json",
  );
});

test("test-enumeration.2 (mutation): an unnamed colocated test is reported, a named one is not", (t) => {
  // The list is parsed from a script's own shape rather than from a copy kept here.
  const command =
    "node tests/gate-zone-prerequisite.mjs static && node --test --import tsx tests/i18n.test.mjs " +
    "src/named.test.ts src/unnamed.test.ts";
  assert.deepEqual(enumeratedBy(command), ["tests/i18n.test.mjs", "src/named.test.ts", "src/unnamed.test.ts"]);
  assert.deepEqual(enumeratedBy("node tests/only-a-script.mjs static"), [], "a command with no `--test` names no test");
  // And the finding names the file that runs nowhere, with the one code the gate reports.
  assert.deepEqual(unlisted(["src/named.test.ts", "src/unnamed.test.ts"], ["src/named.test.ts"]), [
    "unlisted_colocated_test: src/unnamed.test.ts",
  ]);
  t.diagnostic("test-enumeration.2: the script's own list is parsed; the unnamed file is named and the named one is not");
});
