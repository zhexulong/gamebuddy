/**
 * Compare two constraint fingerprints and report a strict diff table.
 *
 * Usage: node tools/compare-fingerprint.mjs <baseline.json> <after.json>
 *
 * Exit code 0 = identical; 1 = differences found (prints the diff).
 */
import { existsSync, readFileSync } from "node:fs";

const [baselinePath, afterPath] = process.argv.slice(2);
if (!baselinePath || !afterPath || !existsSync(baselinePath) || !existsSync(afterPath)) {
  console.error("usage: node tools/compare-fingerprint.mjs <baseline.json> <after.json>");
  process.exit(2);
}

const base = JSON.parse(readFileSync(baselinePath, "utf8"));
const after = JSON.parse(readFileSync(afterPath, "utf8"));
const diffs = [];

const baseTests = new Map(base.tests.map((t) => [t.testName, t]));
const afterTests = new Map(after.tests.map((t) => [t.testName, t]));

// 1. test names present in exactly one side (order-sensitive: report position too)
base.tests.forEach((t, i) => { if (!afterTests.has(t.testName)) diffs.push(`test removed: [${i}] ${t.testName}`); });
after.tests.forEach((t, i) => { if (!baseTests.has(t.testName)) diffs.push(`test added:   [${i}] ${t.testName}`); });

// 2. per-test detail comparison (only for tests present on both sides)
for (const [name, b] of baseTests) {
  const a = afterTests.get(name);
  if (!a) continue;
  const ab = JSON.stringify(b.asserts ?? {});
  const aa = JSON.stringify(a.asserts ?? {});
  if (ab !== aa) diffs.push(`asserts changed: ${name}\n    base: ${ab}\n    after: ${aa}`);
  const eb = JSON.stringify(b.errorCodes ?? []);
  const ea = JSON.stringify(a.errorCodes ?? []);
  if (eb !== ea) diffs.push(`errorCodes changed: ${name}\n    base: ${eb}\n    after: ${ea}`);
  const rb = b.rootPrefix ?? null;
  const ra = a.rootPrefix ?? null;
  if (rb !== ra) diffs.push(`rootPrefix changed: ${name}\n    base: ${rb}\n    after: ${ra}`);
  const hb = JSON.stringify(b.helperCalls ?? {});
  const ha = JSON.stringify(a.helperCalls ?? {});
  if (hb !== ha) diffs.push(`helperCalls changed: ${name}\n    base: ${hb}\n    after: ${ha}`);
}

// 3. aggregates
if (base.aggregate.totalTests !== after.aggregate.totalTests)
  diffs.push(`totalTests: base=${base.aggregate.totalTests} after=${after.aggregate.totalTests}`);
for (const key of ["assertKinds", "rootPrefixes", "fileRootPrefixes", "errorCodes", "topLevelHelpers"]) {
  const b = JSON.stringify(base.aggregate[key] ?? []);
  const a = JSON.stringify(after.aggregate[key] ?? []);
  if (b !== a) diffs.push(`aggregate.${key}:\n    base:  ${b}\n    after: ${a}`);
}

if (diffs.length === 0) {
  console.log("FINGERPRINT IDENTICAL");
  process.exit(0);
}
console.log(`FINGERPRINT DIFFS (${diffs.length}):`);
for (const d of diffs) console.log(" - " + d);
process.exit(1);