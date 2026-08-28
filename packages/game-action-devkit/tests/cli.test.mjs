import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { MAX_CLI_REPORT_BYTES, MAX_CLI_STDOUT_BYTES, parseGameActionArgs, runGameActionCli, serializeCliReport } from "../src/cli.mjs";

const execFile = promisify(execFileCallback);
const binFile = fileURLToPath(new URL("../bin/game-action.mjs", import.meta.url));

test("parses one thin explicit project dispatch without a registry", () => {
  const parsed = parseGameActionArgs(["check", "--project", "game-action-project.json", "--action", "equip_tool", "--brief", "briefs/equip.json"]);
  assert.deepEqual(parsed, { projectFile: "game-action-project.json", invocation: { command: "check", actionId: "equip_tool", briefFile: "briefs/equip.json" } });
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.invocation));
});

test("rejects absent, repeated, unknown, positional, and incomplete options", () => {
  assert.throws(() => parseGameActionArgs(["check"]), /missing_required_argument/);
  assert.throws(() => parseGameActionArgs(["check", "--project", "a", "--project", "b"]), /invalid_projectFile/);
  assert.throws(() => parseGameActionArgs(["check", "--project", "a", "--game", "stardew"]), /unknown_option/);
  assert.throws(() => parseGameActionArgs(["check", "--project", "a", "equip_tool"]), /invalid_command/);
  assert.throws(() => parseGameActionArgs(["check", "--project"]), /invalid_projectFile/);
});

test("delegates exactly one parsed project invocation", async () => {
  const calls = [];
  const report = await runGameActionCli(["status", "--project", "project.json", "--action", "equip_tool"], {
    run: async (input) => { calls.push(input); return { gameId: "stardew", status: "blocked" }; },
  });
  assert.deepEqual(report, { gameId: "stardew", status: "blocked" });
  assert.deepEqual(calls, [{ projectFile: "project.json", invocation: { command: "status", actionId: "equip_tool" } }]);
});

test("serializes only bounded JSON CLI reports", () => {
  assert.equal(serializeCliReport({ gameId: "stardew", status: "inventory" }), '{"gameId":"stardew","status":"inventory"}');
  const exactPayload = { output: "x".repeat(MAX_CLI_REPORT_BYTES - Buffer.byteLength('{"output":""}', "utf8")) };
  assert.equal(Buffer.byteLength(`${serializeCliReport(exactPayload)}\n`, "utf8"), MAX_CLI_STDOUT_BYTES);
  assert.throws(() => serializeCliReport({ output: "x".repeat(MAX_CLI_REPORT_BYTES) }), /report_too_large/);
  const circular = {}; circular.circular = circular;
  assert.throws(() => serializeCliReport(circular), /report_unserializable/);
  assert.throws(() => serializeCliReport(undefined), /report_unserializable/);
});

test("binary stdout including its newline stays within the 64 KiB bound", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "game-action-cli-"));
  const output = "x".repeat(MAX_CLI_REPORT_BYTES - Buffer.byteLength('{"gameId":"stardew","status":"ok","output":""}', "utf8"));
  try {
    await writeFile(path.join(root, "inventory.json"), "{}", "utf8");
    await writeFile(path.join(root, "portfolio.json"), "{}", "utf8");
    await writeFile(path.join(root, "profile.json"), "{}", "utf8");
    await writeFile(path.join(root, "adapter.mjs"), `export async function runActionProject() { return { gameId: "stardew", status: "ok", output: ${JSON.stringify(output)} }; }`, "utf8");
    await writeFile(path.join(root, "project.json"), JSON.stringify({ schema: "gamebuddy-action-project/v1", gameId: "stardew", projectVersion: 1, adapter: "adapter.mjs", portfolio: "portfolio.json", toolInventory: "inventory.json", evidenceRoot: "artifacts/action-runs", defaultProfileExample: "profile.json" }), "utf8");
    const { stdout } = await execFile(process.execPath, [binFile, "status", "--project", path.join(root, "project.json")], { encoding: "buffer", maxBuffer: MAX_CLI_STDOUT_BYTES + 1 });
    assert.equal(stdout.byteLength, MAX_CLI_STDOUT_BYTES);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
