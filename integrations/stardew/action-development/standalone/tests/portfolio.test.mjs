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
  "package-deterministic-tests",
];

test("accepts only the exact package-owned deterministic portfolio", async () => {
  const value = JSON.parse(await readFile(path.join(projectDirectory, "portfolio.json"), "utf8"));
  assert.deepEqual(validateDeterministicPortfolio(value).map((entry) => entry.id), EXPECTED_ENTRIES);
  for (const forbidden of [
    { schema: value.schema, entries: [...value.entries, { id: "live", kind: "run-live", actionId: "equip_tool" }] },
    { schema: value.schema, entries: [{ id: "legacy", kind: "root-tool", actionId: "equip_tool" }, value.entries[1], value.entries[2], value.entries[3]] },
    { schema: value.schema, entries: [{ ...value.entries[0], actionId: "enter_mine" }, value.entries[1], value.entries[2], value.entries[3]] },
    { schema: value.schema, entries: [value.entries[0], { id: "scaffold-contract", kind: "root-tool" }, value.entries[2], value.entries[3]] },
    { schema: value.schema, entries: [value.entries[0], { id: "scaffold-contract", kind: "scaffold-check", extra: "root-tool" }, value.entries[2], value.entries[3]] },
    { schema: value.schema, entries: [value.entries[0], value.entries[1], { id: "action-surface-check", kind: "root-tool" }, value.entries[3]] },
    { schema: value.schema, entries: [value.entries[0], value.entries[1], { id: "action-surface-check", kind: "action-surface-check", extra: "root-tool" }, value.entries[3]] },
    { schema: value.schema, entries: [value.entries[0], value.entries[1], value.entries[2], { id: "package-deterministic-tests", kind: "root-tool" }] },
    { schema: value.schema, entries: [value.entries[0], value.entries[1], value.entries[2], { id: "package-deterministic-tests", kind: "package-tests", extra: "root-tool" }] },
  ]) assert.throws(() => validateDeterministicPortfolio(forbidden), /stardew_action_portfolio_/);

  const reordered = { schema: value.schema, entries: [value.entries[1], value.entries[0], value.entries[2], value.entries[3]] };
  assert.throws(() => validateDeterministicPortfolio(reordered), /stardew_action_portfolio_entry_order/);
});

test("runs package-owned deterministic entries serially without shell commands", async () => {
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
    [process.execPath, ["src/scaffold-contract.mjs", path.resolve(projectDirectory, "../../..")]],
    [process.execPath, ["src/action-surface-check.mjs"]],
    [process.execPath, ["src/run-tests.mjs"]],
  ]);
  assert.ok(commands.every(([command, args]) => command === process.execPath));
  assert.ok(commands.every(([, args]) => args.every((argument) => !/powershell|(?:^|[\\/])tools[\\/]|(?:^|[\\/])root[\\/]|dotnet|export|bridge/i.test(argument))));
  assert.deepEqual(report, { gameId: "stardew", status: "deterministic-ci", entries: EXPECTED_ENTRIES });
});
