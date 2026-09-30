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
// disagree with the live fixture. That is why this audit compares the runners
// against the fixture's CURRENT output contract instead of against themselves.
//
// The migration is in flight in another lane, so this audit is deliberately
// asymmetric: improving a runner can never fail it, and neither can adding a
// conforming one. Two baseline sets express that:
//
//   * BASELINE_CONFORMING — runners that already conform. Regressing one is a
//     finding, which is what catches "migrated, then reverted".
//   * BASELINE_RUNNERS    — the whole set at baseline. Any runner outside it is
//     new, so it must conform; that is what stops the retired shape from being
//     copied into the next runner someone writes.
//
// Debt runners that are still debt are simply not findings, so this gate never
// asks the migrating lane to update it. The baselines only ever grow.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOOLS = path.join(ROOT, "tools");

/** Runners that conformed at baseline. A regression is a finding. */
const BASELINE_CONFORMING = new Set([
  "advance-day",
  "bait-crab-pot",
  "break-rock-source",
  "chest-retrieve",
  "chest-store",
  "chop-stump",
  "chop-tree-source",
  "clear-debris",
  "clear-hoedirt",
  "collect-animal-product",
  "cook-recipe",
  "crab-pot-collect",
  "craft-item",
  "craft-partial-recovery-chain",
  "cut-weeds",
  "dig-artifact-spot",
  "enter-exit",
  "equip-tool",
  "expression",
  "feed-animal",
  "fertilize-tile",
  "harvest-crop",
  "harvest-inventory-full-recovery-chain",
  "interact-npc-with-item",
  "machine-ab",
  "machine-collect-output",
  "machine-inspect",
  "machine-load",
  "move",
  "navigation-mutation",
  "navigation-read-only",
  "npc-relationship",
  "pet-animal",
  "pickup-forage",
  "pickup-item",
  "place-crab-pot",
  "place-crab-pot-fixture",
  "place-wood-fence",
  "plant-sapling",
  "plant-seed",
  "refill-watering-can",
  "ride-minecart",
  "scythe-crop",
  "ship-item",
  "stamina-recovery-chain",
  "till-soil",
  "tool-recovery-chain",
  "travel",
  "use-item",
  "water-crop",
  "water-crop-resource-recovery-chain",
  "water-pet-bowl",
  "water-slime-hutch-trough",
]);

/** Every runner that existed at baseline. Anything newer must conform. */
const BASELINE_RUNNERS = new Set([
  ...BASELINE_CONFORMING,
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

const classify = (code) => {
  const readsRetiredPolicy = /ActionPolicyVersion|EnabledActions/.test(code);
  const assertsExactCapabilities = /assertExactCapabilities/.test(code);
  return {
    readsRetiredPolicy,
    assertsExactCapabilities,
    conforming: !readsRetiredPolicy && !assertsExactCapabilities,
    reasons: [
      readsRetiredPolicy ? "retired-policy-shape" : "",
      assertsExactCapabilities ? "exact-capability-set" : "",
    ].filter(Boolean),
  };
};

export function auditRunnerContracts({ toolsRoot = TOOLS, fixturePath } = {}) {
  const fixture = readFileSync(fixturePath ?? path.join(ROOT, "tools/lib/stardew-native-local-player-fixture.mjs"), "utf8");

  // The fixture's own output shape is the authority for what a runner may expect.
  const fixtureWritesRetiredShape = /^result\.(ActionPolicyVersion|EnabledActions)\s*=/m.test(fixture);
  const fixtureWritesDenyByException =
    /result\.DeniedActions\s*=/.test(fixture) && /result\.ExperimentalActions\s*=/.test(fixture);

  const findings = [];
  if (!fixtureWritesDenyByException)
    findings.push({ kind: "contract", detail: "fixture no longer writes the deny-by-exception policy this audit assumes" });
  if (fixtureWritesRetiredShape)
    findings.push({ kind: "contract", detail: "fixture writes the retired ActionPolicyVersion/EnabledActions shape again" });

  const names = readdirSync(toolsRoot)
    .filter((name) => /^run-stardew-native-local-player-.*-smoke\.mjs$/.test(name))
    .sort();

  const runners = [];
  for (const name of names) {
    const id = name.replace("run-stardew-native-local-player-", "").replace("-smoke.mjs", "");
    const verdict = classify(stripComments(readFileSync(path.join(toolsRoot, name), "utf8")));
    runners.push({ id, ...verdict, inBaseline: BASELINE_RUNNERS.has(id) });

    if (!verdict.conforming && !BASELINE_RUNNERS.has(id)) {
      findings.push({
        kind: "new_runner_on_retired_contract",
        runner: id,
        detail: `${verdict.reasons.join("; ")} — a new runner must use the current contract`,
      });
    }
    if (!verdict.conforming && BASELINE_CONFORMING.has(id)) {
      findings.push({
        kind: "conforming_regression",
        runner: id,
        detail: `${verdict.reasons.join("; ")} — this runner conformed at baseline`,
      });
    }
  }

  return {
    runnerCount: runners.length,
    conformingCount: runners.filter((r) => r.conforming).length,
    debt: runners.filter((r) => !r.conforming).map((r) => ({ id: r.id, reasons: r.reasons })),
    newRunnerCount: runners.filter((r) => !r.inBaseline).length,
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

  console.log(`native-local runners: ${report.runnerCount} (new since baseline: ${report.newRunnerCount})`);
  console.log(`  conforming to the current fixture contract: ${report.conformingCount}`);
  console.log(`  still on the retired contract:              ${report.debt.length}`);
  if (process.argv.includes("--list-debt")) {
    for (const row of report.debt) console.log(`    ${row.id.padEnd(46)} ${row.reasons.join("+")}`);
  }
  if (report.findings.length === 0) {
    console.log("contract: ok (no regression, no new runner on the retired shape)");
    return 0;
  }
  console.log(`contract: ${report.findings.length} finding(s)`);
  for (const finding of report.findings) console.log(`  [${finding.kind}] ${finding.runner ?? "-"}: ${finding.detail}`);
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
