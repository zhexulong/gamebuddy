import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runDeterministicPortfolio, validateDeterministicPortfolio } from "../src/portfolio.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.dirname(directory);

const EXPECTED_ENTRIES = [
  "equip-tool-contract-check",
  "scaffold-contract",
  "action-surface-check",
  "action-source-projection-check",
  "static-production-admission",
  "package-deterministic-tests",
];

test("accepts only the exact package-owned deterministic portfolio", async () => {
  const value = JSON.parse(await readFile(path.join(projectDirectory, "portfolio.json"), "utf8"));
  assert.deepEqual(validateDeterministicPortfolio(value).map((entry) => entry.id), EXPECTED_ENTRIES);
  assert.throws(() => validateDeterministicPortfolio({ ...value, entries: [...value.entries].reverse() }), /entry_order/);
  assert.throws(() => validateDeterministicPortfolio({ ...value, entries: [...value.entries, { id: "live", kind: "run-live" }] }), /stardew_action_portfolio_/);
  for (let index = 0; index < value.entries.length; index += 1) {
    const entries = value.entries.map((entry, current) => current === index ? { ...entry, extra: "root-tool" } : entry);
    assert.throws(() => validateDeterministicPortfolio({ ...value, entries }), /stardew_action_portfolio_/);
  }
});

test("runs all package-owned deterministic entries serially without shell commands", async () => {
  const commands = [];
  const projects = [];
  const report = await runDeterministicPortfolio({
    runProject: async (input) => projects.push(input),
    runCommand: async (command, args) => commands.push([command, args]),
  });
  assert.deepEqual(projects, [{
    projectFile: path.join(projectDirectory, "game-action-project.json"),
    invocation: { command: "check", actionId: "equip_tool" },
  }]);
  assert.deepEqual(commands, [
    [process.execPath, ["src/scaffold-contract.mjs", path.join(projectDirectory, "inputs", "stardew-scaffold")]],
    [process.execPath, ["src/action-surface-check.mjs"]],
    [process.execPath, ["src/action-source-projection-check.mjs"]],
    [process.execPath, ["static-verifier/verify-production-admission.mjs"]],
    [process.execPath, ["src/run-tests.mjs"]],
  ]);
  assert.ok(commands.every(([command]) => command === process.execPath));
  assert.ok(commands.every(([, args]) => args.every((argument) => !/powershell|(?:^|[\\/])tools[\\/]|(?:^|[\\/])root[\\/]|run-live|publication-check/i.test(argument))));
  assert.deepEqual(report, { gameId: "stardew", status: "deterministic-ci", entries: EXPECTED_ENTRIES });
});
