#!/usr/bin/env node
// Stardew native-local runner contract audit.
//
// The fixture writes a deny-by-exception policy (`DeniedActions` /
// `ExperimentalActions`), so the live capability surface is the whole derived
// published base rather than the one action under test. Two runner habits are
// therefore structurally wrong, and both fail silently in the worst way: the
// runner can only ever fail at live time, in a place nobody runs automatically.
//
//   1. a runner that still reads `ActionPolicyVersion` / `EnabledActions` rejects
//      every real fixture config before it sends anything;
//   2. a runner that asserts an EQUAL capability set can never pass, because the
//      derived surface is legitimately larger than one action plus its
//      preconditions.
//
// Neither is caught by the runner's own unit test, because that test builds its
// own config in the same retired shape — the two agree with each other and
// disagree with the live fixture. That is exactly why this audit compares the
// runners against the fixture's CURRENT output contract instead of against
// themselves.
//
// The repo has 50+ runners and the migration is in flight, so the audit does not
// simply fail on every non-conforming runner: it fails on any runner that is not
// either conforming or explicitly listed below. A listed runner makes the debt
// visible and countable, and a runner that is fixed while still listed fails
// stale-pin detection, so the list can only shrink.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS = path.join(ROOT, "tools");

/**
 * Runners not yet migrated off the retired policy shape or the equality
 * capability assertion. Each entry is debt, not an allowance: it names a runner
 * whose live gate currently cannot pass, so the count below is the honest size of
 * that debt.
 *
 * Remove an entry in the same change that migrates its runner.
 */
const RETIRED_CONTRACT_RUNNERS = Object.freeze([
  "advance-day",
  "chest-retrieve",
  "chest-store",
  "chop-stump",
  "clear-hoedirt",
  "collect-animal-product",
  "cook-recipe",
  "crab-pot-collect",
  "craft-item",
  "craft-partial-recovery-chain",
  "cut-weeds",
  "enter-exit",
  "feed-animal",
  "fertilize-tile",
  "harvest-crop",
  "harvest-inventory-full-recovery-chain",
  "interact-npc-with-item",
  "machine-ab",
  "machine-collect-output",
  "machine-load",
  "move",
  "navigation-mutation",
  "navigation-read-only",
  "npc-relationship",
  "pet-animal",
  "pickup-forage",
  "pickup-item",
  "place-crab-pot-fixture",
  "plant-sapling",
  "plant-seed",
  "refill-watering-can",
  "scythe-crop",
  "ship-item",
  "stamina-recovery-chain",
  "till-soil",
  "tool-recovery-chain",
  "travel",
  "use-item",
  "water-crop",
  "water-crop-resource-recovery-chain",
]);

/** Strip line comments so a comment that mentions an old shape is not a finding. */
const stripComments = (source) =>
  source
    .split("\n")
    .map((line) => {
      const index = line.indexOf("//");
      return index < 0 ? line : line.slice(0, index);
    })
    .join("\n");

export function auditRunnerContracts() {
  const fixture = readFileSync(path.join(ROOT, "tools/lib/stardew-native-local-player-fixture.mjs"), "utf8");

  // The fixture's own output shape is the authority for what a runner may expect.
  const fixtureWritesRetiredShape = /^result\.(ActionPolicyVersion|EnabledActions)\s*=/m.test(fixture);
  const fixtureWritesDenyByException = /result\.DeniedActions\s*=/.test(fixture) && /result\.ExperimentalActions\s*=/.test(fixture);

  const findings = [];
  if (!fixtureWritesDenyByException)
    findings.push({ kind: "contract", detail: "fixture no longer writes the deny-by-exception policy this audit assumes" });
  if (fixtureWritesRetiredShape)
    findings.push({ kind: "contract", detail: "fixture writes the retired ActionPolicyVersion/EnabledActions shape again" });

  const names = readdirSync(TOOLS)
    .filter((name) => /^run-stardew-native-local-player-.*-smoke\.mjs$/.test(name))
    .sort();

  const pinned = new Set(RETIRED_CONTRACT_RUNNERS);
  const runners = [];
  for (const name of names) {
    const id = name.replace("run-stardew-native-local-player-", "").replace("-smoke.mjs", "");
    const code = stripComments(readFileSync(path.join(TOOLS, name), "utf8"));
    runners.push({
      id,
      readsRetiredPolicy: /ActionPolicyVersion|EnabledActions/.test(code),
      validatesFixturePolicy: /validateNativeLocalFixturePolicy/.test(code),
      assertsExactCapabilities: /assertExactCapabilities/.test(code),
      assertsRequiredCapabilities: /assertRequiredCapabilities/.test(code),
      pinned: pinned.has(id),
    });
  }

  const conforming = (r) => !r.readsRetiredPolicy && !r.assertsExactCapabilities;
  const knownDebt = (r) => r.pinned && !conforming(r);

  for (const runner of runners) {
    if (conforming(runner)) {
      if (runner.pinned)
        findings.push({ kind: "stale_pin", runner: runner.id, detail: "runner already conforms; remove its entry from RETIRED_CONTRACT_RUNNERS" });
      continue;
    }
    if (knownDebt(runner)) continue;
    const reasons = [
      runner.readsRetiredPolicy ? "reads the retired ActionPolicyVersion/EnabledActions shape, which rejects every real fixture config" : "",
      runner.assertsExactCapabilities ? "asserts an equal capability set, which the derived surface can never satisfy" : "",
    ].filter(Boolean);
    findings.push({ kind: "unregistered_debt", runner: runner.id, detail: reasons.join("; ") });
  }

  for (const id of pinned) {
    if (!runners.some((r) => r.id === id))
      findings.push({ kind: "stale_pin", runner: id, detail: "no such runner exists" });
  }

  return {
    runnerCount: runners.length,
    conformingCount: runners.filter(conforming).length,
    debtCount: runners.filter((r) => !conforming(r)).length,
    runners,
    findings,
  };
}

function main() {
  const report = auditRunnerContracts();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.findings.length === 0 ? 0 : 1;
  }

  console.log(`native-local runners: ${report.runnerCount}`);
  console.log(`  conforming to the current fixture contract: ${report.conformingCount}`);
  console.log(`  known debt (pinned):                        ${report.debtCount - report.findings.filter((f) => f.kind === "unregistered_debt").length}`);
  if (report.findings.length === 0) {
    console.log("contract: ok (every runner conforms or is explicitly pinned as debt)");
    return 0;
  }
  console.log(`contract: ${report.findings.length} finding(s)`);
  for (const finding of report.findings) console.log(`  [${finding.kind}] ${finding.runner ?? "-"}: ${finding.detail}`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
