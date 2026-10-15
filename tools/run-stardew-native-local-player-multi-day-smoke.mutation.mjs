#!/usr/bin/env node
/**
 * Mutation checks for the multi-day crossing runner.
 *
 * Each mutation targets a rule the runner claims to enforce. A mutation that stays
 * GREEN means the rule is not actually load-bearing. The mutated source is written
 * back to the runner file itself and restored in a `finally`, the same shape the
 * loop-closure mutation harness uses, because a copy would break the runner's own
 * relative imports (`./lib/...`).
 *
 * The three rules under test, one mutation each:
 *   M1  a LevelUpMenu must NEVER be dismissed (its close writes saved state);
 *   M2  the engine-owned menus must be waited for, not treated as a decision;
 *   M3  the receipt's day claim must be cross-checked against the world.
 */
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const RUNNER = path.join(ROOT, "tools", "run-stardew-native-local-player-multi-day-smoke.mjs");
const TEST = path.join(ROOT, "tools", "run-stardew-native-local-player-multi-day-smoke.test.mjs");

const MUTATIONS = [
  {
    name: "M1 treat the LevelUpMenu as dismissible",
    apply: (src) => src.replace('Object.freeze(["ShippingMenu"])', 'Object.freeze(["ShippingMenu", "LevelUpMenu"])'),
  },
  {
    name: "M2 stop waiting for the engine-owned menus",
    apply: (src) =>
      src.replace('Object.freeze(["SaveGameMenu", "DialogueBox", "ReadyCheckDialog"])', "Object.freeze([])"),
  },
  {
    name: "M3 trust the receipt's day claim without the world",
    apply: (src) =>
      src.replace(
        "if (snapshot?.dayOfMonth !== expectedDayOfMonth)",
        "if (false && snapshot?.dayOfMonth !== expectedDayOfMonth)",
      ),
  },
];

async function runTest() {
  try {
    const { stdout } = await execFileAsync(process.execPath, ["--test", TEST], {
      encoding: "utf8",
      cwd: ROOT,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { green: true, out: stdout };
  } catch (error) {
    return { green: false, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

const original = await readFile(RUNNER, "utf8");
let allCaught = true;
try {
  for (const mutation of MUTATIONS) {
    const mutated = mutation.apply(original);
    if (mutated === original) {
      console.log(`MUTATION-NOT-APPLIED  ${mutation.name}`);
      allCaught = false;
      continue;
    }
    await writeFile(RUNNER, mutated);
    const result = await runTest();
    if (result.green) {
      console.log(`STILL GREEN           ${mutation.name}`);
      allCaught = false;
    } else {
      const failed = (result.out.match(/^✖ (?!failing)/gm) ?? []).length;
      console.log(`CAUGHT (${failed} failing)   ${mutation.name}`);
    }
    await writeFile(RUNNER, original);
  }
  const restored = await runTest();
  console.log(restored.green ? "restored -> GREEN (ok)" : "restored -> STILL RED (bad)");
  if (!restored.green) allCaught = false;
  console.log(allCaught ? "all mutations caught" : "SOME MUTATIONS SURVIVED");
  process.exitCode = allCaught ? 0 : 1;
} finally {
  await writeFile(RUNNER, original);
}
