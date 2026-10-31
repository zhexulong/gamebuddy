/**
 * A journey that bypasses the coverage seam is a journey whose pages nothing measures.
 *
 * The collector is an automatic fixture in `tests/frontend-coverage.ts`, and every
 * journey opts in through one line: `import { test, expect } from "./frontend-coverage"`.
 * That is deliberate - a journey carries no instrumentation of its own - but it is also
 * a trap: a new spec written the obvious way (`from "@playwright/test"`) is collected
 * by Playwright, passes, and contributes nothing to the report. The failure is invisible
 * in every reading available at the time: the suite is green, the report is green, and
 * only the number is quietly smaller.
 *
 * So the population is the journey directory, not a list, and the assertion is about
 * the import line: every `tests/*.spec.ts` must reach `test` through the seam. A file
 * with no Playwright import at all is a finding too - it is a spec Playwright would
 * collect and run with no seam fixture, which is the same silent gap.
 *
 * The second half checks the other direction, which is where a gate like this usually
 * rots: the floors file must name exactly the groups the classifier can produce. A
 * floor for a group that no longer exists measures nothing; a group with no floor has
 * its drift unnoticed. Both are failures here rather than a comment in a document.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { GROUP_ORDER, classify } from "./frontend-coverage-groups.mjs";
import { readFloors } from "./frontend-coverage-report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEAM = "./frontend-coverage";

/** Every journey Playwright collects, and the module each one imports `test` from. */
export function journeyImports(directory = HERE) {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".spec.ts"))
    .sort()
    .map((name) => {
      const source = readFileSync(join(directory, name), "utf8");
      const playwright = [...source.matchAll(/from\s+["']([^"']*@playwright\/test)["']/gu)].map((m) => m[1]);
      const seam = [...source.matchAll(/from\s+["'](\.[^"']*frontend-coverage)["']/gu)].map((m) => m[1]);
      return { journey: name, playwright, seam };
    });
}

test("frontend-coverage.1: every journey collects its pages through the seam", (t) => {
  const imports = journeyImports();
  assert.ok(imports.length > 0, "no journey found, so this gate would pass by measuring nothing");
  const findings = imports
    .filter((entry) => entry.seam.length === 0)
    .map(
      (entry) =>
        `tests/${entry.journey}: imports ${entry.playwright.join(", ") || "no Playwright test object"} and not ` +
        `"${SEAM}", so its pages are never measured`,
    );
  t.diagnostic(`frontend-coverage.1: ${imports.length} journey(s), ${findings.length} bypassing the seam`);
  assert.deepEqual(findings, [], "a journey must import test/expect from ./frontend-coverage to be measured");
});

test("frontend-coverage.2: the floors name exactly the groups the classifier produces", (t) => {
  const groups = new Set(classify(join(HERE, "..", "src")).values());
  const floors = readFloors();
  const declared = Object.keys(floors).sort();
  t.diagnostic(
    `frontend-coverage.2: classifier groups ${[...groups].sort().join(",")}; floors ${declared.join(",")}`,
  );
  assert.deepEqual(declared, [...groups].sort(), "a floor and a classifier group must be the same set");
  assert.deepEqual([...groups].sort(), [...GROUP_ORDER].sort(), "GROUP_ORDER is the authority for the group set");
});

test("frontend-coverage.3 (mutation): a bypassing journey is named, and a seam import is not", (t) => {
  // A synthetic pair, so the rule is proved on text rather than only on today's tree.
  const bypass = 'import { expect, test } from "@playwright/test";';
  const seam = 'import { expect, test } from "./frontend-coverage";';
  assert.ok(/from\s+["']([^"']*@playwright\/test)["']/u.test(bypass), "the bypass shape must be recognised");
  assert.ok(!/from\s+["']([^"']*@playwright\/test)["']/u.test(seam), "the seam import must not be a finding");
  assert.ok(/from\s+["'](\.[^"']*frontend-coverage)["']/u.test(seam), "the seam import must match the seam rule");
  t.diagnostic("frontend-coverage.3: bypass text is reported; seam text is not");
});
