/**
 * Does a live run's bundle account for every piece it presented?
 *
 * The runner asks this of its own bundle before publishing a verdict (`deliveryAccountClause`), so a run whose pieces
 * and account disagree is blocked at the source. This entry point is the same question asked of a bundle already on
 * disk - after the fact, by an audit, or by another tree.
 *
 *   node tools/check-presentation-delivery-account.mjs                 # the newest run bundle under .live-runs
 *   node tools/check-presentation-delivery-account.mjs --run-dir DIR   # one named run
 *
 * A bundle that predates `presentation.deliveryAccount` is BLOCKED, not passed: the question cannot be answered from
 * it, and a check whose population is empty must not agree with itself. A tree with no bundle under `.live-runs` at all
 * exits 2 and prints the same report with `examined 0` and a stated `allowEmpty` reason, so the third verdict is a
 * measurement that did not happen rather than a gate that printed nothing.
 *
 * red-proof: history  round41's own bundle carried `pieceCount: 59` against thirteen named pieces -> this entry point
 *                    exits 1 on it, and the reconciling cases beside it (a piece no record names, parts that do not add
 *                    up, an absent account) live in tools/lib/presentation-delivery-account.test.mjs
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assessBundleDeliveryAccount } from "./lib/presentation-delivery-account.mjs";

const RUNS_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)), ".live-runs");

/** Every `result.json` under `.live-runs`, newest first: the bundle a reader means when they name none. */
function bundlesNewestFirst(root = RUNS_ROOT) {
  const found = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === "result.json") found.push({ path, mtimeMs: statSync(path).mtimeMs });
    }
  };
  walk(root);
  return found.sort((left, right) => right.mtimeMs - left.mtimeMs);
}

function readBundle(runDir) {
  const path = runDir.endsWith("result.json") ? runDir : join(runDir, "result.json");
  return { path, bundle: JSON.parse(readFileSync(path, "utf8")) };
}

function main() {
  const args = process.argv.slice(2);
  const index = args.indexOf("--run-dir");
  const targets =
    index >= 0
      ? [args[index + 1]]
      : bundlesNewestFirst()
          .slice(0, 1)
          .map((entry) => entry.path);
  if (targets.length === 0 || targets[0] === undefined) {
    console.error("delivery_account_not_measured: no run bundle exists under .live-runs");
    // The report, printed on this path too: `tools/lib/harness-conformance.mjs` reads a gate's own report and has none
    // to read when the blocked branch says only that it blocked. `examined 0` beside the stated `allowEmpty` reason is
    // `not_measured` - counted apart from the passes, never green - and the exit code stays 2, because a prerequisite
    // that is absent is not a verdict about any bundle.
    console.log("examined 0 bundle(s)");
    console.log(
      JSON.stringify({
        gate: "presentation-delivery-account",
        status: "not_measured",
        examined: 0,
        allowEmpty:
          "a run bundle under .live-runs is what this account reconciles, and no live run has left one in this tree",
        checks: [{ id: "delivery_account", status: "not_measured", reasonCode: "delivery_account_not_measured" }],
      }),
    );
    process.exit(2);
  }
  let failed = 0;
  let examined = 0;
  const checks = [];
  for (const target of targets) {
    let read;
    try {
      read = readBundle(target);
    } catch (error) {
      console.error(`delivery_account_unreadable: ${target} (${error?.message ?? error})`);
      failed += 1;
      examined += 1;
      checks.push({
        id: "delivery_account",
        status: "failed",
        bundle: target,
        reasonCode: "delivery_account_unreadable",
      });
      continue;
    }
    examined += 1;
    const verdict = assessBundleDeliveryAccount(read.bundle);
    if (verdict.ok) {
      console.log(`delivery account reconciled: ${read.path}`);
      console.log(`  ${verdict.detail}`);
      checks.push({ id: "delivery_account", status: "passed", bundle: read.path });
      continue;
    }
    failed += 1;
    console.error(`delivery account BLOCKED (${verdict.code}): ${read.path}`);
    if (verdict.detail !== undefined) console.error(`  ${verdict.detail}`);
    checks.push({ id: "delivery_account", status: "failed", bundle: read.path, reasonCode: verdict.code });
  }
  console.log(`examined ${examined} bundle(s)`);
  // The one-line report `tools/lib/harness-conformance.mjs` reads: a gate whose default run prints this is classified
  // as having a falsifier, and `tools/lib/presentation-delivery-account.test.mjs` is where that falsifier lives (a
  // bundle whose pieces and account disagree, a bundle that predates the account, a hand-written sum that does not
  // hold, and pieces with no records at all - each one red).
  console.log(
    JSON.stringify({
      gate: "presentation-delivery-account",
      status: failed === 0 ? "passed" : "failed",
      examined,
      checks,
    }),
  );
  process.exit(failed === 0 ? 0 : 1);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
