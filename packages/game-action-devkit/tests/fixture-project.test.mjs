import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseGameActionArgs, runGameActionCli } from "../src/cli.mjs";
import { readActionProjectManifest, runActionProject } from "../src/project-runner.mjs";

const execFile = promisify(execFileCallback);
const fixtureRoot = fileURLToPath(new URL("./fixtures/project/", import.meta.url));
const projectFile = path.join(fixtureRoot, "project.json");
const profileFile = path.join(fixtureRoot, "profile.json");
const briefFile = "briefs/toggle_lamp.json";
const binFile = fileURLToPath(new URL("../bin/game-action.mjs", import.meta.url));

async function fixtureFiles() {
  const entries = await readdir(fixtureRoot, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath ?? fixtureRoot, entry.name));
}

test("runs a non-production generic fixture through manifest, invocation, and CLI surfaces", async () => {
  const manifest = await readActionProjectManifest(projectFile);
  assert.equal(manifest.gameId, "clockwork_fixture");
  assert.equal(manifest.projectVersion, 1);
  assert.equal(manifest.baseDirectory, path.resolve(fixtureRoot));

  const status = await runActionProject({
    projectFile,
    invocation: { command: "status", actionId: "toggle_lamp", briefFile },
  });
  assert.deepEqual(status, {
    gameId: "clockwork_fixture",
    status: "status_ready",
    claimScope: "fixture_only",
    actionId: "toggle_lamp",
    briefFile: path.join(fixtureRoot, briefFile),
  });

  const preflight = await runActionProject({
    projectFile,
    invocation: { command: "preflight", actionId: "toggle_lamp", profileFile },
  });
  assert.deepEqual(preflight, {
    gameId: "clockwork_fixture",
    status: "preflight_ready",
    claimScope: "fixture_only",
    actionId: "toggle_lamp",
    briefFile: null,
  });

  const live = await runActionProject({
    projectFile,
    invocation: { command: "run-live", actionId: "toggle_lamp", profileFile },
  });
  assert.deepEqual(live, {
    gameId: "clockwork_fixture",
    status: "blocked",
    reasonCode: "non_production_fixture",
    claimScope: "fixture_only",
    actionId: "toggle_lamp",
    runId: live.runId,
  });
  assert.match(live.runId, /^ar1_[a-z0-9]+_[a-f0-9]{32}$/);

  const parsed = parseGameActionArgs([
    "check",
    "--project",
    projectFile,
    "--action",
    "toggle_lamp",
    "--brief",
    briefFile,
  ]);
  const checked = await runGameActionCli([
    "check",
    "--project",
    projectFile,
    "--action",
    "toggle_lamp",
    "--brief",
    briefFile,
  ]);
  assert.deepEqual(parsed.invocation, {
    command: "check",
    actionId: "toggle_lamp",
    briefFile,
  });
  assert.deepEqual(checked, {
    gameId: "clockwork_fixture",
    status: "check_passed",
    claimScope: "fixture_only",
    actionId: "toggle_lamp",
    briefFile: path.join(fixtureRoot, briefFile),
  });

  await assert.rejects(
    execFile(process.execPath, [binFile, "inventory", "--project", projectFile, "--action", "toggle_lamp"], { encoding: "utf8" }),
    /invalid_command/,
  );
});

test("keeps the fixture generic and import-free", async () => {
  const files = await fixtureFiles();
  const source = await Promise.all(files.map(async (file) => [file, await readFile(file, "utf8")]));
  for (const [file, text] of source) {
    assert.doesNotMatch(text, /stardew/i, file);
    assert.doesNotMatch(text, /(?:^|["'])\.\.\//u, file);
  }
});
