import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { MODEL_FIELD_CEILINGS } from "./model-field-budget.js";

/**
 * THE CEILINGS THIS MODULE DECLARES ARE ALSO PUBLISHED AS DATA, AND THIS GATE HOLDS THE TWO TOGETHER.
 *
 * <p>
 * WHY DATA. A reader OUTSIDE this process needs one of these numbers: the Mod's census
 * (`SweepTargetRefusalNamingTests`) judges whether a receipt detail survives being printed, and the ceiling that
 * decides is `evidence`. The reader used to take it out of `model-field-budget.ts` with a regular expression, and the
 * day `evidence` stopped being a literal and became `EVIDENCE_CEILING_CHARS` the expression matched nothing - the
 * reading did not go stale, it went SILENT, and the three tests built on it threw instead of measuring. A test that
 * parses the other language's code agrees with that code until the code changes shape, and then it says nothing.
 * </p>
 *
 * <p>
 * WHAT REPLACES IT. `model-field-budget.published.json` sits beside the module and states the same table in the one
 * form both sides read without an opinion about the other's syntax. The module stays the authority - its numbers are
 * derived, and `fact-brief.private.test.ts` holds the published `evidence` to `derivedEvidenceCeiling()` - so this file
 * answers a different question: does the artifact a foreign reader trusts still say what the Host enforces?
 * </p>
 *
 * <p>
 * THE POPULATION IS THE DECLARATION, not a list written here: every key of `MODEL_FIELD_CEILINGS` must be published,
 * and the artifact may publish nothing the declaration does not carry. A ceiling added tomorrow fails here by name,
 * which is the only way a mirror stays a mirror. `examined N` is printed so a run that checked nothing cannot read as
 * agreement.
 * </p>
 */

function repositoryRoot(start: string): string {
  let directory = start;
  for (;;) {
    if (existsSync(join(directory, "AGENTS.md"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`repository root not found from ${start}`);
    directory = parent;
  }
}

const ROOT = repositoryRoot(dirname(fileURLToPath(import.meta.url)));
const PUBLISHED_PATH = join(ROOT, "host", "src", "model-field-budget.published.json");

/** Every way the published artifact disagrees with the declaration, each naming the field that drifted. */
function publishedCeilingFindings(): string[] {
  if (!existsSync(PUBLISHED_PATH)) return [`published_ceilings_missing: no artifact a foreign reader could read`];
  const parsed: unknown = JSON.parse(readFileSync(PUBLISHED_PATH, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return [`published_ceilings_not_a_table: the artifact is not a JSON object of ceilings`];
  const published = parsed as Record<string, unknown>;
  const findings: string[] = [];
  for (const [field, chars] of Object.entries(MODEL_FIELD_CEILINGS)) {
    if (!Object.hasOwn(published, field)) {
      findings.push(`published_ceiling_missing:${field}: declared ${String(chars)} and published nowhere`);
      continue;
    }
    if (published[field] !== chars)
      findings.push(
        `published_ceiling_drift:${field}: declared ${String(chars)}, published ${String(published[field])}`,
      );
  }
  for (const field of Object.keys(published)) {
    if (!Object.hasOwn(MODEL_FIELD_CEILINGS, field))
      findings.push(`published_ceiling_unknown:${field}: published and declared by no field this module bounds`);
  }
  return findings;
}

test("the published model-field ceilings are the numbers the Host enforces", () => {
  const declared = Object.keys(MODEL_FIELD_CEILINGS).sort();
  const findings = publishedCeilingFindings();
  assert.ok(declared.length > 0, "a ceiling table with no members would agree with an empty artifact");
  assert.deepEqual(
    findings,
    [],
    `examined ${String(declared.length)} ceilings (${declared.join(", ")}) against ` +
      `host/src/model-field-budget.published.json: ${findings.join("; ")}`,
  );
});
