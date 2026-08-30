import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  WORK_BRIEF_SCHEMA,
  beginEvidenceRun,
  checkWorkBriefOwnership,
  finalizeEvidenceRun,
  finalizeIncompleteEvidenceRun,
  readEvidenceStatus,
  readPassedEvidence,
  runBoundedChild,
  validateFrozenWorkBrief,
} from "../src/index.mjs";
import { parseGameActionArgs, runGameActionCli } from "../src/cli.mjs";
import { readActionProjectManifest, runActionProject } from "../src/project-runner.mjs";

const execFile = promisify(execFileCallback);
const fixtureRoot = fileURLToPath(new URL("./fixtures/project/", import.meta.url));
const projectFile = path.join(fixtureRoot, "project.json");
const profileFile = path.join(fixtureRoot, "profile.json");
const profileSchemaFile = new URL("../schemas/game-action-profile-envelope.v1.schema.json", import.meta.url);
const childFile = path.join(fixtureRoot, "child.mjs");
const briefFile = "briefs/toggle_lamp.json";
const binFile = fileURLToPath(new URL("../bin/game-action.mjs", import.meta.url));
const fixtureBaseCommit = "a".repeat(40);

async function fixtureFiles() {
  const entries = await readdir(fixtureRoot, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath ?? fixtureRoot, entry.name));
}

function assertFixtureProfileEnvelope(profile, schema, expectedGameId) {
  const required = new Set(schema.required);
  const keys = Object.keys(profile);
  if (schema.additionalProperties !== false || keys.length !== required.size || keys.some((key) => !required.has(key))) {
    throw new Error("fixture_profile_unexpected_root_property");
  }
  if (profile.schema !== schema.properties.schema.const) throw new Error("fixture_profile_schema_mismatch");
  if (profile.gameId !== expectedGameId) throw new Error("fixture_profile_game_mismatch");
  if (typeof profile.profileId !== "string" || !new RegExp(schema.$defs.identifier.pattern, "u").test(profile.profileId)) {
    throw new Error("fixture_profile_invalid_profile_id");
  }
  if (!Number.isSafeInteger(profile.revision) || profile.revision < schema.properties.revision.minimum) {
    throw new Error("fixture_profile_invalid_revision");
  }
  if (profile.payload === null || typeof profile.payload !== "object" || Array.isArray(profile.payload)
    || Object.keys(profile.payload).length > schema.properties.payload.maxProperties) {
    throw new Error("fixture_profile_invalid_payload");
  }
  return profile;
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
    schema: "gamebuddy-action-scenario-result/v1",
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
    schema: "gamebuddy-action-scenario-result/v1",
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
    schema: "gamebuddy-action-scenario-result/v1",
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
    schema: "gamebuddy-action-scenario-result/v1",
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

<<<<<<< HEAD
=======
test("runs a second independent game-neutral fixture with multiple actions and profile data", async () => {
  const [manifest, firstManifest, portfolio, inventory, profile, alternateProfile, firstProfile, schema] = await Promise.all([
    readActionProjectManifest(secondProjectFile),
    readActionProjectManifest(projectFile),
    readFile(secondPortfolioFile, "utf8").then(JSON.parse),
    readFile(secondInventoryFile, "utf8").then(JSON.parse),
    readFile(secondProfileFile, "utf8").then(JSON.parse),
    readFile(secondAlternateProfileFile, "utf8").then(JSON.parse),
    readFile(profileFile, "utf8").then(JSON.parse),
    readFile(profileSchemaFile, "utf8").then(JSON.parse),
  ]);
  assert.equal(manifest.gameId, "papertrail_fixture");
  assert.equal(manifest.projectVersion, 1);
  assert.equal(manifest.baseDirectory, path.resolve(secondFixtureRoot));
  assert.equal(manifest.adapterFile, path.join(secondFixtureRoot, "runtime/adapter.mjs"));
  assert.equal(manifest.portfolioFile, secondPortfolioFile);
  assert.equal(manifest.inventoryFile, secondInventoryFile);
  assert.equal(manifest.defaultProfileExampleFile, secondProfileFile);
  assert.equal(manifest.evidenceRoot, path.join(secondFixtureRoot, "evidence/runs"));
  assert.notEqual(manifest.adapterFile, firstManifest.adapterFile);
  assert.notEqual(manifest.portfolioFile, firstManifest.portfolioFile);
  assert.notEqual(manifest.inventoryFile, firstManifest.inventoryFile);
  assert.notEqual(manifest.evidenceRoot, firstManifest.evidenceRoot);

  assert.equal(portfolio.projectId, "papertrail_fixture");
  assert.equal(portfolio.production, false);
  assert.deepEqual(portfolio.actions.map(({ actionId }) => actionId), ["rotate_dial", "archive_note"]);
  assert.equal(new Set(portfolio.actions.map(({ actionId }) => actionId)).size, 2);
  assert.equal(inventory.production, false);
  assert.deepEqual(inventory.tools.map(({ id }) => id), ["observe_dial", "read_archive"]);
  assertFixtureProfileEnvelope(profile, schema, "papertrail_fixture");
  assertFixtureProfileEnvelope(alternateProfile, schema, "papertrail_fixture");
  assert.ok(Object.keys(profile.payload).length > 0);
  assert.ok(Object.keys(alternateProfile.payload).length > 0);
  assert.notDeepEqual(profile.payload, alternateProfile.payload);
  assert.notDeepEqual(profile.payload, firstProfile.payload);

  for (const actionId of ["rotate_dial", "archive_note"]) {
    assert.deepEqual(await runActionProject({
      projectFile: secondProjectFile,
      invocation: { command: "status", actionId },
    }), {
      schema: "gamebuddy-action-scenario-result/v1",
      gameId: "papertrail_fixture",
      status: "status_ready",
      claimScope: "fixture_only",
      actionId,
      briefFile: null,
    });
    const live = await runActionProject({
      projectFile: secondProjectFile,
      invocation: { command: "run-live", actionId, profileFile: secondProfileFile },
    });
    assert.equal(live.status, "blocked");
    assert.equal(live.reasonCode, "non_production_fixture");
    assert.equal(live.gameId, "papertrail_fixture");
    assert.equal(live.actionId, actionId);
    assert.match(live.runId, /^ar1_[a-z0-9]+_[a-f0-9]{32}$/);
  }

  assert.deepEqual(await runActionProject({
    projectFile: secondProjectFile,
    invocation: { command: "preflight", actionId: "archive_note", profileFile: secondProfileFile },
  }), {
    schema: "gamebuddy-action-scenario-result/v1",
    gameId: "papertrail_fixture",
    status: "preflight_ready",
    claimScope: "fixture_only",
    actionId: "archive_note",
    briefFile: null,
  });
  await assert.rejects(
    runActionProject({
      projectFile: secondProjectFile,
      invocation: { command: "check", actionId: "unknown_action" },
    }),
    /action_not_available/,
  );

  assert.deepEqual(await runActionProject({
    projectFile: secondProjectFile,
    invocation: { command: "check", actionId: "rotate_dial", briefFile: "briefs/rotate_dial.json" },
  }), {
    schema: "gamebuddy-action-scenario-result/v1",
    gameId: "papertrail_fixture",
    status: "check_passed",
    claimScope: "fixture_only",
    actionId: "rotate_dial",
    briefFile: path.join(secondFixtureRoot, "briefs/rotate_dial.json"),
  });
});

>>>>>>> b35a39e (Harden action owner verification boundaries)
test("runs fixture child supervision, records non-production evidence, and enforces brief ownership", async () => {
  const child = await runBoundedChild({ command: process.execPath, args: [childFile], cwd: fixtureRoot, timeoutMs: 5000 });
  assert.equal(child.code, 0);
  assert.equal(child.signal, null);
  assert.equal(child.output, "fixture-child-ok\n");
  assert.ok(Buffer.byteLength(child.output, "utf8") < 64 * 1024);

  const evidenceRoot = await mkdtemp(path.join(os.tmpdir(), "game-action-fixture-evidence-"));
  try {
    const relativeToFixture = path.relative(fixtureRoot, evidenceRoot);
    assert.ok(relativeToFixture.startsWith("..") || path.isAbsolute(relativeToFixture));
    const completeIdentity = { gameId: "clockwork_fixture", actionId: "toggle_lamp", runId: "fixture_complete" };
    const incompleteIdentity = { gameId: "clockwork_fixture", actionId: "toggle_lamp", runId: "fixture_incomplete" };
    await finalizeEvidenceRun(await beginEvidenceRun({ root: evidenceRoot, identity: completeIdentity }), {
      status: "complete",
      verdict: "passed",
    });
    await finalizeIncompleteEvidenceRun(await beginEvidenceRun({ root: evidenceRoot, identity: incompleteIdentity }), { verdict: "blocked" });
    assert.equal((await readEvidenceStatus({ root: evidenceRoot, identity: completeIdentity })).verdict, "passed");
    assert.equal((await readEvidenceStatus({ root: evidenceRoot, identity: incompleteIdentity })).verdict, "blocked");
    assert.deepEqual((await readPassedEvidence({ root: evidenceRoot, identity: completeIdentity })).identity, completeIdentity);
    await assert.rejects(readPassedEvidence({ root: evidenceRoot, identity: incompleteIdentity }), /bundle_not_passing/);
  } finally {
    await rm(evidenceRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
  }

  const brief = {
    schema: WORK_BRIEF_SCHEMA,
    gameId: "clockwork_fixture",
    actionId: "toggle_lamp",
    baseCommit: fixtureBaseCommit,
    contractVersion: 1,
    status: "frozen",
    effect: "mutation",
    claimScope: "fixture_only",
    ownedPaths: ["packages/game-action-devkit/tests/fixtures/project/**"],
    sharedHubs: [],
    requiredPortfolioEntries: [],
    checks: ["fixture_child"],
    liveAuthorized: false,
  };
  assert.equal(validateFrozenWorkBrief(brief, {
    expectedGameId: "clockwork_fixture",
    expectedActionId: "toggle_lamp",
    expectedBaseCommit: fixtureBaseCommit,
  }).gameId, "clockwork_fixture");
  assert.deepEqual(checkWorkBriefOwnership(brief, ["packages/game-action-devkit/tests/fixtures/project/child.mjs"], {
    expectedGameId: "clockwork_fixture",
    expectedActionId: "toggle_lamp",
    expectedBaseCommit: fixtureBaseCommit,
  }), {
    ownedPaths: ["packages/game-action-devkit/tests/fixtures/project/child.mjs"],
    sharedHubPaths: [],
  });
  assert.throws(() => validateFrozenWorkBrief(brief, { expectedGameId: "wrong_fixture" }), /game_mismatch/);
  assert.throws(() => checkWorkBriefOwnership(brief, ["packages/game-action-devkit/tests/fixture-project.test.mjs"]), /changed_path_unowned/);
});

test("accepts the fixture profile against the published envelope shape without a runtime validator", async () => {
  const [profile, schema] = await Promise.all([
    readFile(profileFile, "utf8").then(JSON.parse),
    readFile(profileSchemaFile, "utf8").then(JSON.parse),
  ]);
  assert.equal(assertFixtureProfileEnvelope(profile, schema, "clockwork_fixture").gameId, "clockwork_fixture");
  assert.throws(() => assertFixtureProfileEnvelope({ ...profile, unexpectedRootKey: true }, schema, "clockwork_fixture"), /unexpected_root_property/);
  assert.throws(() => assertFixtureProfileEnvelope({ ...profile, gameId: "other_fixture" }, schema, "clockwork_fixture"), /game_mismatch/);
});

test("keeps the fixture generic and import-free", async () => {
  const files = await fixtureFiles();
  const source = await Promise.all(files.map(async (file) => [file, await readFile(file, "utf8")]));
  for (const [file, text] of source) {
    assert.doesNotMatch(text, /stardew/i, file);
    assert.doesNotMatch(text, /(?:^|[\s/"'`.:_-])(?:host|voice-gateway|dialogue-web)(?:$|[\s/"'`.:_-])/iu, file);
    assert.doesNotMatch(text, /GameBuddy\.Windows/iu, file);
    assert.doesNotMatch(text, /\.\.\//u, file);
    assert.doesNotMatch(text, /(?:production|live|publication)\s*["']?\s*[:=]\s*true\b/iu, file);
  }
});
