import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, opendir, readdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import {
  bootstrapNativeLocalPlayerFixture,
  prepareNativeLocalPlayerFixture,
  restoreNativeLocalPlayerFixture,
  validateNativeLocalPlayerFixturePreparation,
} from "./lib/stardew-native-local-player-fixture.mjs";
import { STARDEW_MOD_FOLDER } from "./lib/stardew-mod-folder.mjs";

const BUNDLE_FILES = [
  "GameBuddy.Stardew.dll",
  "GameBuddy.Stardew.Core.dll",
  "manifest.json",
  "GameBuddy.Stardew.deps.json",
];
const saveName = "GameBuddyFixture_445094166";
const binding = Object.freeze({
  version: 1,
  observedSaveSlot: saveName,
  logicalSaveName: "GameBuddyFixture",
  saveId: "fixture-save",
  worldId: "fixture-world",
  playerId: "fixture-player",
  companionId: "fixture-companion",
});

// Handler bodies are intentionally split by family while retaining one partial
// ExecutionManager ledger. Source-bound fixture assertions must inspect that
// complete production surface rather than treating the ledger file as a second
// handler authority.
const EXECUTION_MANAGER_SOURCE_FILES = Object.freeze([
  "farmhandexecutioncontroller.cs",
  "farmhandexecutioncontroller.movementactions.cs",
  "farmhandexecutioncontroller.farmingconstructionactions.cs",
  "farmhandexecutioncontroller.machinesanimalsitemsactions.cs",
  "farmhandexecutioncontroller.resourcetoolactions.cs",
  "farmhandexecutioncontroller.gatheringactions.cs",
]);

async function readExecutionManagerSources() {
  return (
    await Promise.all(
      EXECUTION_MANAGER_SOURCE_FILES.map((file) =>
        readFile(new URL(`../integrations/stardew/${file}`, import.meta.url), "utf8"),
      ),
    )
  ).join("\n");
}

/**
 * Extract one member body by brace balance, so a source pin is scoped to the
 * member it names and a neighboring member can never satisfy or defeat it.
 */
function memberBody(source, declaration) {
  const start = source.indexOf(declaration);
  if (start < 0) return null;
  let depth = 0;
  let started = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === "{") {
      depth += 1;
      started = true;
    } else if (character === "}") {
      depth -= 1;
      if (started && depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

async function removeFixtureTree(root) {
  const pending = [{ path: root, visited: false }];
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry.visited) {
      await rmdir(entry.path);
      continue;
    }

    pending.push({ path: entry.path, visited: true });
    for await (const child of await opendir(entry.path)) {
      const childPath = join(entry.path, child.name);
      const metadata = await lstat(childPath);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) pending.push({ path: childPath, visited: false });
      else await unlink(childPath);
    }
  }
}

async function snapshotTree(root) {
  const pending = [""];
  const snapshot = [];
  while (pending.length > 0) {
    const relative = pending.pop();
    const directory = join(root, relative);
    for (const name of (await readdir(directory)).sort().reverse()) {
      const childRelative = relative ? join(relative, name) : name;
      const child = join(root, childRelative);
      const metadata = await lstat(child);
      if (metadata.isSymbolicLink()) snapshot.push([childRelative, "link"]);
      else if (metadata.isDirectory()) {
        snapshot.push([childRelative, "directory"]);
        pending.push(childRelative);
      } else snapshot.push([childRelative, "file", (await readFile(child)).toString("base64")]);
    }
  }
  return snapshot.sort(([left], [right]) => left.localeCompare(right));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The Mod-owned journal scope the fixture transaction manages for one fixture. `Constants.DataPath` is the folder
 * CONTAINING `Saves`, so a save root ending in `Saves` has its journal one level up - the same derivation the tool
 * uses, spelled once here so an assertion cannot point at a directory nobody writes.
 */
function journalScopeFor(options, stardewSaveRoot) {
  return join(
    dirname(stardewSaveRoot),
    "BodyProgramJournal-v1",
    "stardew",
    options.binding.saveId,
    options.binding.worldId,
    options.binding.playerId,
    options.binding.companionId,
  );
}

/** Every regular file under `root` as `{ path, sha256 }`, sorted - the comparison form both sides use. */
async function journalDigests(root) {
  const files = [];
  const visit = async (directory, prefix) => {
    for (const name of await readdir(directory)) {
      const relativePath = prefix === "" ? name : `${prefix}/${name}`;
      const absolute = join(directory, name);
      const metadata = await lstat(absolute);
      if (metadata.isDirectory()) await visit(absolute, relativePath);
      else if (metadata.isFile()) files.push({ path: relativePath, sha256: sha256(await readFile(absolute)) });
    }
  };
  await visit(root, "");
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function assertRedactedPublicError(error, expectedCode, rawDetails) {
  assert.equal(error.message, expectedCode);
  assert.equal(String(error), `Error: ${expectedCode}`);
  const observable = [error.message, String(error), error.stack ?? "", JSON.stringify(error)].join("\n");
  for (const detail of rawDetails) assert.equal(observable.includes(detail), false, `must redact ${detail}`);
  assert.equal(Object.hasOwn(error, "cause"), false);
  assert.equal(Object.hasOwn(error, "errors"), false);
  assert.equal(error.cause, undefined);
  assert.equal(error.errors, undefined);
  return true;
}

// The Mod's fixture code lives in partial-class files beside ModEntry.cs. A source-shape assertion
// has to read the aggregate: reading only ModEntry.cs made 23 of these cases fail for text that had
// simply moved into a partial, which is why the suite read as broken instead of as a check.
let fixtureSourceCache = null;
async function readFixtureSource() {
  if (fixtureSourceCache !== null) return fixtureSourceCache;
  const dir = new URL("../integrations/stardew/", import.meta.url);
  const names = (await readdir(dir)).filter((name) => /^ModEntry(\.Fixtures.*)?\.cs$/.test(name)).sort();
  const parts = await Promise.all(names.map((name) => readFile(new URL(name, dir), "utf8")));
  fixtureSourceCache = parts.join("\n");
  return fixtureSourceCache;
}
// The scenario branches spell their comparison either `is` or `==`, and the code has used both.
// Anchors therefore resolve to whichever the file currently contains, and quote the literal the
// assertion is actually about.
function scenarioBranchAt(entry, literal) {
  for (const form of [
    `if (fixture.FixtureScenario is "${literal}"`,
    `if (fixture.FixtureScenario is not "${literal}"`,
    `if (fixture.FixtureScenario == "${literal}"`,
    `fixture.FixtureScenario is "${literal}"`,
    `fixture.FixtureScenario == "${literal}"`,
  ]) {
    const at = entry.indexOf(form);
    if (at >= 0) return at;
  }
  return -1;
}
async function createFixture(t, suffix) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-native-local-"));
  t.after(() => removeFixtureTree(root));
  const modsPath = join(root, "mods");
  const releaseDir = join(root, "release");
  const modRoot = join(modsPath, STARDEW_MOD_FOLDER);
  await mkdir(modRoot, { recursive: true });
  await mkdir(releaseDir, { recursive: true });

  const originalConfig = {
    EnableLocalBridge: true,
    PipeName: "gamebuddy-fixture-pipe",
    BridgeToken: "gamebuddy-fixture-token-1234",
    SaveId: "original-save",
    WorldId: "original-world",
    PlayerId: "original-player",
    CompanionId: "original-companion",
    Portfolio: { Enable: false },
    HostAutomation: { Enable: false },
    HostFarmhandProvisioning: { Enable: false },
    FarmhandProvisioner: { Enable: false },
    EnabledActions: ["move_to_tile"],
  };
  const originalConfigBytes = `${JSON.stringify(originalConfig, null, 2)}\n`;
  await writeFile(join(modRoot, "config.json"), originalConfigBytes);
  for (const name of BUNDLE_FILES) {
    await writeFile(join(releaseDir, name), `release-${name}`);
    await writeFile(join(modRoot, name), `original-${name}`);
  }

  return {
    root,
    modsPath,
    releaseDir,
    modRoot,
    originalConfigBytes,
    saveName,
    binding,
    backupName: `native-local-${suffix}-fixture-backup`,
  };
}

test("a fixture whose mod has no config yet still prepares, and the config it writes is complete", async (t) => {
  // A fresh install has no `Mods/GameBuddy/config.json`: the fixture is what puts one there, along with the
  // bridge identity the rest of the run depends on. Requiring the file to exist first made a first run
  // impossible - `readJson` threw ENOENT, the public whitelist turned that into
  // `native_local_fixture_validation_failed`, and the real cause was invisible for three runs.
  const options = { ...(await createFixture(t, "no-config")), action: "equip_tool", timeoutSeconds: 90 };
  const template = join(options.root, "templates", options.saveName);
  const stardewSaveRoot = join(options.root, "working-saves");
  await mkdir(template, { recursive: true });
  await mkdir(stardewSaveRoot);
  await mkdir(options.releaseDir, { recursive: true });
  await writeFile(join(template, options.saveName), "template-save");
  await writeFile(join(template, "SaveGameInfo"), "template-info");
  const completeOptions = { ...options, stardewSaveRoot };
  await unlink(join(options.modRoot, "config.json"));

  const result = await validateNativeLocalPlayerFixturePreparation(completeOptions);

  assert.equal(result.state, "ready", "a missing config is the first run, not a refusal");
  assert.equal(
    result.configAbsentAtStart,
    true,
    "the answer says the file was absent, so a reader knows it was written",
  );
});

test("native-local preparation validation is read-only", async (t) => {
  const options = { ...(await createFixture(t, "validation")), action: "equip_tool", timeoutSeconds: 90 };
  const template = join(options.root, "templates", options.saveName);
  const stardewSaveRoot = join(options.root, "working-saves");
  await mkdir(template, { recursive: true });
  await mkdir(stardewSaveRoot);
  await writeFile(join(template, options.saveName), "template-save");
  await writeFile(join(template, "SaveGameInfo"), "template-info");
  const completeOptions = { ...options, stardewSaveRoot };
  const before = await snapshotTree(options.root);
  const configBefore = await readFile(join(options.modRoot, "config.json"));

  const result = await validateNativeLocalPlayerFixturePreparation(completeOptions);

  assert.equal(result.state, "ready");
  assert.deepEqual(result.actions, ["equip_tool"]);
  assert.deepEqual(await snapshotTree(options.root), before);
  assert.deepEqual(await readFile(join(options.modRoot, "config.json")), configBefore);
  await assert.rejects(lstat(join(options.root, options.backupName)), /ENOENT/);
  await assert.rejects(lstat(join(options.root, ".stardew-native-local-player-fixture.lock")), /ENOENT/);
  await assert.rejects(lstat(join(stardewSaveRoot, options.saveName)), /ENOENT/);
});

test("the fixture transaction resets the scope-bound Body Program journal", async (t) => {
  // The Mod-owned journal is a durable authority keyed by the binding's four
  // opaque ids, so its scope is byte-identical across runs of the same fixture.
  // A run that leaves a non-terminal program behind makes the next run's
  // OpenStatus RecoveryRequired, and the same submit_action_program call then
  // fails closed with body_program_journal_unavailable for reasons the prompt and
  // the world cannot explain. Observed live before this fix: a 3033-byte journal
  // still held state 5 while the working save had been restored to the template.
  const options = { ...(await createFixture(t, "journal-reset")), action: "equip_tool" };
  const stardewSaveRoot = join(options.root, "Saves");
  // The Mod joins `BodyProgramJournal-v1` onto `Constants.DataPath` - the folder CONTAINING `Saves` - so the scope
  // to assert against is the parent of the declared save root. `journalScopeFor` is the one spelling of that path.
  const journalScope = journalScopeFor(options, stardewSaveRoot);
  const template = join(options.root, "templates", options.saveName);
  await mkdir(template, { recursive: true });
  await mkdir(stardewSaveRoot);
  await writeFile(join(template, options.saveName), "template-save");
  await writeFile(join(template, "SaveGameInfo"), "template-info");
  const scoped = { ...options, stardewSaveRoot };

  // First run: the world starts with no journal, and the run writes a
  // RecoveryRequired one exactly as the live failure did.
  const prepared = await prepareNativeLocalPlayerFixture(scoped);
  await mkdir(journalScope, { recursive: true });
  await writeFile(join(journalScope, "journal.json"), '{"state":5,"recoveryDiagnostic":"recovery_required"}\n');

  // Restore must remove it: a later run has to start from the state the harness
  // chose, not from whatever the previous run left behind.
  await restoreNativeLocalPlayerFixture(scoped);
  await assert.rejects(lstat(journalScope), /ENOENT/, "the run's journal must not survive restore");

  // A journal that existed before the run is CLEARED for the run and restored afterwards.
  //
  // Clearing is the point: the run receives the TEMPLATE save, which has no programs, so a leftover program
  // describes a world that no longer exists - and an unsettled node in it makes the Mod open RecoveryRequired,
  // decline to compose the controller and refuse every program_submit. Restoring the caller's bytes afterwards keeps
  // the world outside the transaction unchanged.
  await mkdir(journalScope, { recursive: true });
  const preexisting = '{"state":0,"eventHighWater":7}\n';
  await writeFile(join(journalScope, "journal.json"), preexisting);
  await prepareNativeLocalPlayerFixture(scoped);
  await assert.rejects(
    lstat(join(journalScope, "journal.json")),
    /ENOENT/,
    "the run must start from an empty journal, not from the previous run's program",
  );
  await restoreNativeLocalPlayerFixture(scoped);
  assert.equal(await readFile(join(journalScope, "journal.json"), "utf8"), preexisting);
  // Restore consumes the backup (removeBackup), so a completed cycle leaves no
  // recovery artifact behind; the lock is released too.
  await assert.rejects(lstat(prepared.backup), /ENOENT/);
  await assert.rejects(lstat(join(options.root, ".stardew-native-local-player-fixture.lock")), /ENOENT/);
});

/**
 * The journal a run wrote is the only durable record of what its programs DID, and restore deletes it so the next run
 * starts from a coherent world. Keeping a copy in the run's own bundle is what makes that record readable afterwards;
 * measured 2026-10-25, a run reported `programOutcomes: [{observed:false, dispatched:null}]` for three accepted
 * programs while `programStatus` carried `code:"found", state:"failed"` with real node outcomes, and the journal that
 * would have explained it was already gone.
 */
test("restore keeps the journal the run wrote in the bundle, then removes the live scope", async (t) => {
  const options = { ...(await createFixture(t, "journal-archive")), action: "equip_tool" };
  const stardewSaveRoot = join(options.root, "Saves");
  const journalScope = journalScopeFor(options, stardewSaveRoot);
  const template = join(options.root, "templates", options.saveName);
  await mkdir(template, { recursive: true });
  await mkdir(stardewSaveRoot);
  await writeFile(join(template, options.saveName), "template-save");
  await writeFile(join(template, "SaveGameInfo"), "template-info");
  const evidenceDir = join(options.root, "run-bundle");
  await mkdir(evidenceDir, { recursive: true });

  await prepareNativeLocalPlayerFixture({ ...options, stardewSaveRoot });
  // Two files, one nested, so `fileCount` and the per-file digests are comparisons rather than a single-file accident.
  await mkdir(join(journalScope, "nodes"), { recursive: true });
  const journalLive = '{"state":2,"programId":"farm_day5_b","currentNode":"harvest"}\n';
  const nodeLive = '{"nodeId":"harvest","state":"failed","reasonCode":"no_reachable_target"}\n';
  await writeFile(join(journalScope, "journal.json"), journalLive);
  await writeFile(join(journalScope, "nodes", "harvest.json"), nodeLive);
  const liveDigests = [
    { path: "journal.json", sha256: sha256(journalLive) },
    { path: "nodes/harvest.json", sha256: sha256(nodeLive) },
  ];

  const restored = await restoreNativeLocalPlayerFixture({ ...options, stardewSaveRoot, evidenceDir });

  // Guard 1: the run is not merely allowed to keep a journal - it still loses the live scope.
  await assert.rejects(lstat(journalScope), /ENOENT/, "the live scope must still be removed");
  // Guard 2: the copy carries the SAME BYTES, file by file.
  const archiveDirectory = join(evidenceDir, "body-program-journal");
  assert.deepEqual(await journalDigests(archiveDirectory), liveDigests);
  assert.deepEqual(restored.journalArchive, {
    archived: true,
    reason: null,
    directory: archiveDirectory,
    detail: null,
    fileCount: 2,
    files: liveDigests,
  });
});

/**
 * The record travels in the marker - a file inside the transaction's own backup - and the backup is consumed by a
 * successful restore. The tampered-managed-backup path is the existing way to read that marker after restore: the
 * journal step runs first, so its record is on disk before the manifest check refuses.
 */
async function restoreKeepingTheMarker(options) {
  const backup = join(options.root, options.backupName);
  await writeFile(join(backup, "config.json.backup"), "tampered so the backup survives the restore");
  await assert.rejects(restoreNativeLocalPlayerFixture(options), /native_local_fixture_restore_failed/);
  return JSON.parse(await readFile(join(backup, "body-program-journal.json"), "utf8"));
}

test("a bundle that cannot be written is recorded and never stops the removal", async (t) => {
  const options = { ...(await createFixture(t, "journal-bundle-unwritable")), action: "equip_tool" };
  const stardewSaveRoot = join(options.root, "Saves");
  const journalScope = journalScopeFor(options, stardewSaveRoot);
  const template = join(options.root, "templates", options.saveName);
  await mkdir(template, { recursive: true });
  await mkdir(stardewSaveRoot);
  await writeFile(join(template, options.saveName), "template-save");
  await writeFile(join(template, "SaveGameInfo"), "template-info");
  // A FILE where the bundle directory should be: the copy has nowhere to land and cannot be retried into place.
  const evidenceDir = join(options.root, "bundle-blocked-by-a-file");
  await writeFile(evidenceDir, "not a directory");

  const prepared = await prepareNativeLocalPlayerFixture({ ...options, stardewSaveRoot });
  await mkdir(journalScope, { recursive: true });
  await writeFile(join(journalScope, "journal.json"), '{"state":5,"recoveryDiagnostic":"recovery_required"}\n');

  const marker = await restoreKeepingTheMarker({ ...options, stardewSaveRoot, evidenceDir });

  // Guard 3: the removal happened anyway, and the marker says WHY there is no copy.
  await assert.rejects(lstat(journalScope), /ENOENT/, "an unwritable bundle must not keep the journal alive");
  assert.equal(marker.archive.archived, false);
  assert.equal(marker.archive.reason, "copy_failed");
  assert.equal(marker.archive.directory, join(evidenceDir, "body-program-journal"));
  assert.ok(marker.archive.detail.length > 0, "a failed copy names its reason rather than shrugging");
  assert.equal(marker.archive.fileCount, 0);
  assert.equal((await lstat(prepared.backup)).isDirectory(), true, "the refusal leaves its recovery material in place");
});

test("a restore with no bundle path records that refusal instead of skipping it", async (t) => {
  const options = { ...(await createFixture(t, "journal-no-bundle")), action: "equip_tool" };
  const stardewSaveRoot = join(options.root, "Saves");
  const journalScope = journalScopeFor(options, stardewSaveRoot);
  const template = join(options.root, "templates", options.saveName);
  await mkdir(template, { recursive: true });
  await mkdir(stardewSaveRoot);
  await writeFile(join(template, options.saveName), "template-save");
  await writeFile(join(template, "SaveGameInfo"), "template-info");

  await prepareNativeLocalPlayerFixture({ ...options, stardewSaveRoot });
  await mkdir(journalScope, { recursive: true });
  await writeFile(join(journalScope, "journal.json"), '{"state":0}\n');

  const marker = await restoreKeepingTheMarker({ ...options, stardewSaveRoot });

  // Guard 4: no bundle path is a NAMED refusal in the marker, not a silent skip that reads as "nothing to keep".
  await assert.rejects(lstat(journalScope), /ENOENT/);
  assert.equal(marker.archive.archived, false);
  assert.equal(marker.archive.reason, "no_bundle_path");
  assert.equal(marker.archive.directory, null);
  assert.equal(marker.archive.fileCount, 0);
});

/**
 * The physical slot basename the native game assigns to the Player Host world a
 * companion session created. Its farm/player identity is the WorldCreation form
 * (`GameBuddy Farm` / `GameBuddy`), and the suffix is the game's own unique id.
 */
const COMPANION_SLOT = "GameBuddyFarm_451234657";

/**
 * The owner ruling (2026-10-09): a `GameBuddyFarm_*` slot under the Stardew saves
 * root is the player's own progress across bootstrap attempts, and no fixture or
 * live-run transaction may delete, move, rename or overwrite it. This fixture
 * transaction stages its working save inside that same real saves root, so the
 * contract is asserted against the actual failure it guards: a full fixture cycle
 * must leave a companion world sitting beside the fixture slot byte-identical.
 */
test("a fixture cycle leaves a companion world beside the fixture slot byte-identical", async (t) => {
  const options = { ...(await createFixture(t, "companion-slot")), action: "equip_tool" };
  const stardewSaveRoot = join(options.root, "working-saves");
  const template = join(options.root, "templates", options.saveName);
  await mkdir(template, { recursive: true });
  await mkdir(stardewSaveRoot);
  await writeFile(join(template, options.saveName), "template-save");
  await writeFile(join(template, "SaveGameInfo"), "template-info");
  const companion = join(stardewSaveRoot, COMPANION_SLOT);
  await mkdir(companion, { recursive: true });
  await writeFile(join(companion, COMPANION_SLOT), "companion-save-body");
  await writeFile(join(companion, "SaveGameInfo"), "companion-save-info");
  const before = await snapshotTree(companion);

  const prepared = await prepareNativeLocalPlayerFixture({ ...options, stardewSaveRoot });
  await restoreNativeLocalPlayerFixture({ ...options, stardewSaveRoot });

  assert.deepEqual(await snapshotTree(companion), before, "the companion world must survive a fixture cycle untouched");
  await assert.rejects(lstat(join(stardewSaveRoot, options.saveName)), /ENOENT/);
  await assert.rejects(lstat(prepared.backup), /ENOENT/);
});

/**
 * The same ruling from the other side: the slot vocabulary is what makes the
 * guard structural. A slot that is not this tooling's own `GameBuddyFixture*`
 * name is refused with a named code, before any backup, write or removal, rather
 * than silently skipped or resolved through into the player's saves.
 */
test("a non-fixture save slot name is refused loudly instead of being owned", async (t) => {
  const options = { ...(await createFixture(t, "foreign-slot")), action: "equip_tool" };
  const stardewSaveRoot = join(options.root, "working-saves");
  const template = join(options.root, "templates", COMPANION_SLOT);
  await mkdir(template, { recursive: true });
  await mkdir(stardewSaveRoot);
  await writeFile(join(template, COMPANION_SLOT), "companion-save-body");
  await writeFile(join(template, "SaveGameInfo"), "companion-save-info");
  const companion = join(stardewSaveRoot, COMPANION_SLOT);
  await mkdir(companion, { recursive: true });
  await writeFile(join(companion, COMPANION_SLOT), "companion-save-body");
  await writeFile(join(companion, "SaveGameInfo"), "companion-save-info");
  const before = await snapshotTree(companion);
  const foreign = {
    ...options,
    saveName: COMPANION_SLOT,
    backupName: "native-local-foreign-fixture-backup",
    stardewSaveRoot,
  };

  await assert.rejects(validateNativeLocalPlayerFixturePreparation(foreign), (error) =>
    assertRedactedPublicError(error, "invalid_fixture_observed_save_slot", [COMPANION_SLOT]),
  );
  await assert.rejects(prepareNativeLocalPlayerFixture(foreign), (error) =>
    assertRedactedPublicError(error, "invalid_fixture_observed_save_slot", [COMPANION_SLOT]),
  );
  assert.deepEqual(await snapshotTree(companion), before, "a refused slot must not be touched");
  await assert.rejects(lstat(join(options.root, foreign.backupName)), /ENOENT/);
  await assert.rejects(lstat(join(options.root, ".stardew-native-local-player-fixture.lock")), /ENOENT/);
});

/**
 * The journal backup marker is a file inside the transaction's own backup, and
 * restore feeds the path it names into a recursive removal. It is admitted only
 * inside the `<recorded save root>/BodyProgramJournal-v1` scope, so neither the
 * saves root itself nor a save folder beside the journal can ever be named by it.
 */
test("a journal marker can never name a path outside the journal scope", async (t) => {
  const options = { ...(await createFixture(t, "journal-scope")), action: "equip_tool" };
  const stardewSaveRoot = join(options.root, "working-saves");
  const template = join(options.root, "templates", options.saveName);
  await mkdir(template, { recursive: true });
  await mkdir(stardewSaveRoot);
  await writeFile(join(template, options.saveName), "template-save");
  await writeFile(join(template, "SaveGameInfo"), "template-info");
  const companion = join(stardewSaveRoot, COMPANION_SLOT);
  await mkdir(companion, { recursive: true });
  await writeFile(join(companion, COMPANION_SLOT), "companion-save-body");
  await writeFile(join(companion, "SaveGameInfo"), "companion-save-info");
  const before = await snapshotTree(companion);
  const scoped = { ...options, stardewSaveRoot };
  const prepared = await prepareNativeLocalPlayerFixture(scoped);
  const markerPath = join(prepared.backup, "body-program-journal.json");
  const marker = JSON.parse(await readFile(markerPath, "utf8"));

  for (const forged of [stardewSaveRoot, companion]) {
    await writeFile(markerPath, `${JSON.stringify({ ...marker, path: forged })}\n`);
    await assert.rejects(restoreNativeLocalPlayerFixture(scoped), (error) =>
      assertRedactedPublicError(error, "native_local_fixture_journal_scope_unowned", [forged]),
    );
    assert.deepEqual(await snapshotTree(companion), before, "a refused journal scope must not be removed");
  }
});

test("public entry points redact an existing backup path with a fixed code", async (t) => {
  const options = { ...(await createFixture(t, "existing-backup")), action: "equip_tool" };
  const backup = join(options.root, options.backupName);
  await mkdir(backup);

  await assert.rejects(validateNativeLocalPlayerFixturePreparation(options), (error) =>
    assertRedactedPublicError(error, "native_local_fixture_backup_already_exists", [options.root, backup]),
  );
  await assert.rejects(prepareNativeLocalPlayerFixture(options), (error) =>
    assertRedactedPublicError(error, "native_local_fixture_backup_already_exists", [options.root, backup]),
  );
  await assert.rejects(
    bootstrapNativeLocalPlayerFixture({ ...options, logicalSaveName: "GameBuddyFixture" }),
    (error) => assertRedactedPublicError(error, "native_local_fixture_backup_already_exists", [options.root, backup]),
  );
});

test("validation redacts a missing safe-context path without raw details", async (t) => {
  const options = { ...(await createFixture(t, "validation-missing-context")), action: "equip_tool" };
  for (const name of BUNDLE_FILES) await unlink(join(options.releaseDir, name));
  await rmdir(options.releaseDir);

  await assert.rejects(validateNativeLocalPlayerFixturePreparation(options), (error) =>
    assertRedactedPublicError(error, "native_local_fixture_path_missing", [options.root, options.releaseDir]),
  );
});

test("restore redacts an unsafe safe-context path and preserves recovery artifacts", async (t) => {
  const options = { ...(await createFixture(t, "restore-unsafe-context")), action: "equip_tool" };
  const prepared = await prepareNativeLocalPlayerFixture(options);
  const lock = join(options.root, ".stardew-native-local-player-fixture.lock");
  for (const name of BUNDLE_FILES) await unlink(join(options.releaseDir, name));
  await rmdir(options.releaseDir);
  await writeFile(options.releaseDir, "raw-unsafe-context-detail");

  await assert.rejects(restoreNativeLocalPlayerFixture(options), (error) =>
    assertRedactedPublicError(error, "native_local_fixture_unsafe_path", [
      options.root,
      options.releaseDir,
      "raw-unsafe-context-detail",
    ]),
  );
  assert.equal((await lstat(prepared.backup)).isDirectory(), true);
  assert.equal((await lstat(join(prepared.backup, "manifest.json"))).isFile(), true);
  assert.equal((await lstat(lock)).isDirectory(), true);
});

test("failed preparation redacts a deploy failure after successful rollback", async (t) => {
  const options = { ...(await createFixture(t, "deploy-redaction")), action: "equip_tool" };
  const backup = join(options.root, options.backupName);
  const lock = join(options.root, ".stardew-native-local-player-fixture.lock");
  const missingReleaseFile = join(options.releaseDir, BUNDLE_FILES.at(-1));
  const originalManagedFiles = new Map(
    await Promise.all(
      ["config.json", ...BUNDLE_FILES].map(async (name) => [name, await readFile(join(options.modRoot, name))]),
    ),
  );
  await unlink(missingReleaseFile);

  await assert.rejects(prepareNativeLocalPlayerFixture(options), (error) => {
    assert.equal(error.message, "native_local_fixture_preparation_failed");
    assert.equal(String(error), "Error: native_local_fixture_preparation_failed");
    const observableError = [error.message, String(error), error.stack ?? "", JSON.stringify(error)].join("\n");
    assert.equal(observableError.includes(options.releaseDir), false);
    assert.equal(observableError.includes(missingReleaseFile), false);
    assert.doesNotMatch(observableError, /release_bundle_missing|GameBuddy\.Stardew\.deps\.json/);
    assert.equal(Object.hasOwn(error, "cause"), false);
    assert.equal(Object.hasOwn(error, "errors"), false);
    assert.equal(error.cause, undefined);
    assert.equal(error.errors, undefined);
    return true;
  });

  for (const [name, bytes] of originalManagedFiles)
    assert.deepEqual(await readFile(join(options.modRoot, name)), bytes, `${name} must be restored byte-for-byte`);
  await assert.rejects(lstat(backup), { code: "ENOENT" });
  await assert.rejects(lstat(lock), { code: "ENOENT" });
});

test("failed preparation redacts restore failure while preserving recovery state", async (t) => {
  const options = { ...(await createFixture(t, "recovery-redaction")), action: "equip_tool" };
  const backup = join(options.root, options.backupName);
  const lock = join(options.root, ".stardew-native-local-player-fixture.lock");
  const finalReleaseFile = join(options.releaseDir, BUNDLE_FILES.at(-1));

  // Keep deployment active long enough for this offline test to corrupt the
  // completed backup and force a later deployment failure deterministically.
  await writeFile(join(options.releaseDir, BUNDLE_FILES[0]), Buffer.alloc(16 * 1024 * 1024, 0x61));
  const induceFailures = (async () => {
    while (true) {
      try {
        await lstat(join(backup, "manifest.json"));
        break;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        await delay(1);
      }
    }
    await writeFile(join(backup, "config.json.backup"), "arbitrary-sensitive-restore-error-source");
    await unlink(finalReleaseFile);
  })();

  await assert.rejects(prepareNativeLocalPlayerFixture(options), (error) => {
    assert.equal(error.message, "native_local_fixture_recovery_required");
    assert.equal(String(error), "Error: native_local_fixture_recovery_required");
    assert.equal(Object.hasOwn(error, "cause"), false);
    assert.equal(Object.hasOwn(error, "errors"), false);
    assert.equal(error.cause, undefined);
    assert.equal(error.errors, undefined);
    return true;
  });
  await induceFailures;

  assert.equal((await lstat(backup)).isDirectory(), true);
  assert.equal((await lstat(join(backup, "manifest.json"))).isFile(), true);
  assert.equal((await lstat(lock)).isDirectory(), true);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.equal(configured.NativeLocalPlayerFixture.Enable, true);
});

test("navigation mutation fixture activates the bridge only inside its reversible transaction", async (t) => {
  const options = { ...(await createFixture(t, "navigation-mutation")), action: "navigation_mutation" };
  const configPath = join(options.modRoot, "config.json");
  const base = JSON.parse(await readFile(configPath, "utf8"));
  base.EnableLocalBridge = false;
  await writeFile(configPath, `${JSON.stringify(base, null, 2)}\n`);

  const stardewSaveRoot = join(options.root, "working-saves");
  const template = join(options.root, "templates", options.saveName);
  await mkdir(stardewSaveRoot);
  await mkdir(template, { recursive: true });
  await writeFile(join(template, options.saveName), "template-save");
  await writeFile(join(template, "SaveGameInfo"), "template-info");
  const validation = await validateNativeLocalPlayerFixturePreparation({
    ...options,
    stardewSaveRoot,
  });
  assert.equal(validation.state, "ready");

  const prepared = await prepareNativeLocalPlayerFixture(options);
  assert.equal(
    await readFile(join(options.modRoot, "GameBuddy.Stardew.deps.json"), "utf8"),
    "release-GameBuddy.Stardew.deps.json",
  );
  const backupManifest = JSON.parse(await readFile(join(prepared.backup, "manifest.json"), "utf8"));
  assert.ok(backupManifest.entries.some((entry) => entry.name === "GameBuddy.Stardew.deps.json"));
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.equal(configured.EnableLocalBridge, true);
  assert.deepEqual(configured.EnabledActions, ["inspect_world_map", "find_destination", "navigate_to_destination"]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "navigation_mutation_v1");
  const entry = await readFixtureSource();
  assert.equal(configured.NativeLocalPlayerFixture.NavigationMutationTargetLabel ?? "", "");
  const start = entry.indexOf('if (fixture.FixtureScenario == "navigation_mutation_v1")');
  const branch = entry.slice(start, entry.indexOf("if (fixture.FixtureScenario is not", start));
  assert.ok(start >= 0);
  assert.match(branch, /DerivedDestinationSet\.TryCreateCurrent/);
  assert.match(branch, /NavigationRoutePlanner/);
  assert.match(branch, /Helper\.WriteConfig/);
  assert.doesNotMatch(branch, /warpFarmer|Game1\.warp|terrainFeatures|objects\.|player\.Items|Position\s*=/);
  await restoreNativeLocalPlayerFixture(options);
  const restored = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(restored.EnableLocalBridge, false);
  assert.equal(
    await readFile(join(options.modRoot, "GameBuddy.Stardew.deps.json"), "utf8"),
    "original-GameBuddy.Stardew.deps.json",
  );
});

test("native-local lifecycle owner binds staged release and one terminal lifecycle result", async () => {
  const launcher = await readFile(
    new URL("./run-stardew-native-local-player-move-fixture.ps1", import.meta.url),
    "utf8",
  );
  assert.match(launcher, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$ReleaseDir/);
  assert.match(launcher, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$ResultFile/);
  assert.match(launcher, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$LifecycleResultFile/);
  assert.doesNotMatch(launcher, /LifecyclePhaseResultFile|\$phaseResultPath/);
  assert.doesNotMatch(launcher, /integrations\/stardew\/bin\/Release|\$projectRoot/);
  assert.match(launcher, /\[IO\.Path\]::IsPathFullyQualified\(\$ReleaseDir\)/);
  assert.match(launcher, /\[IO\.Path\]::IsPathFullyQualified\(\$ResultFile\)/);
  assert.match(launcher, /\[IO\.Path\]::IsPathFullyQualified\(\$LifecycleResultFile\)/);
  assert.match(launcher, /\$actionResultPath -eq \$lifecycleResultPath/);
  assert.match(launcher, /equip-tool-live-child\.mjs/);
  assert.match(launcher, /write-lifecycle-result\.mjs/);

  const prepare = launcher.indexOf("prepare-stardew-native-local-player-fixture.mjs");
  const launch = launcher.indexOf("$process = Start-Process");
  const ready = launcher.indexOf("Test-GameBuddyNamedPipeListening", launch);
  const identity = launcher.indexOf("Assert-LaunchedSmapiIdentity", ready);
  const child = launcher.indexOf("node $equipToolChild", identity);
  const stop = launcher.indexOf("taskkill /PID $process.Id /T /F", child);
  const restore = launcher.indexOf("restore-stardew-native-local-player-fixture.mjs", stop);
  const cleanup = launcher.indexOf("-Cleanup", restore);
  const lifecycleResult = launcher.indexOf(
    "node $lifecycleResultWriter --result-file $lifecycleResultPath --state completed",
    cleanup,
  );
  const failureReceipt = launcher.indexOf("Publish-FailureLifecycleResult", child);
  const inputValidation = launcher.indexOf('$phase = "input_validation"');
  const resultPathValidation = launcher.indexOf("Action and lifecycle result files must be separate.");
  const runnerResolution = launcher.indexOf('$phase = "runner_resolution"', resultPathValidation);
  assert.ok(prepare >= 0 && prepare < launch, "fixture prepare must precede process launch");
  assert.ok(launch < ready && ready < identity && identity < child, "child must follow readiness and exact identity");
  assert.ok(child < stop && stop < restore && restore < cleanup, "stop must precede fixture restore and save cleanup");
  assert.ok(cleanup < lifecycleResult, "completed lifecycle result must be written only after all cleanup");
  assert.ok(failureReceipt >= 0, "failed lifecycle must publish one bounded terminal result");
  assert.ok(
    inputValidation >= 0 && inputValidation < resultPathValidation,
    "private result input failures must be classified as input validation",
  );
  assert.ok(resultPathValidation < runnerResolution, "result file validation must precede runner resolution");
  assert.match(launcher, /--state failed --phase \$Phase --code failed/);
  assert.doesNotMatch(launcher, /--phase \$_\.Exception|--code \$_\.Exception|Write-.*\$_\.Exception/);
  assert.match(launcher, /\$cleanupFailurePhase = \$phase/);
  assert.match(launcher, /\$failurePhase = \$cleanupFailurePhase/);
  assert.doesNotMatch(launcher, /Remove-Item[^\n]*-Recurse/);
});

test("native-local bootstrap launcher refuses a profile whose bridge is disabled, by name", async () => {
  // Measured 2026-10-16: a profile seeded from config.example.json (`EnableLocalBridge: false`) loaded the save,
  // drained its bootstrap and then died at the pipe gate with "bridge pipe was not ready before timeout" - a
  // cause the message does not name, after a full game boot. The launcher must refuse BEFORE it launches.
  const launcher = await readFile(
    new URL("./run-stardew-native-local-player-move-fixture.ps1", import.meta.url),
    "utf8",
  );
  const precondition = launcher.indexOf('$phase = "bridge_enablement_precondition"');
  const bridgeRead = launcher.indexOf("$bridgeConfig.EnableLocalBridge");
  const launch = launcher.indexOf("$process = Start-Process -FilePath $smapi");
  const readiness = launcher.indexOf('$phase = "pipe_readiness"');
  assert.notEqual(precondition, -1, "the bridge-enablement precondition must exist");
  assert.notEqual(bridgeRead, -1, "it must read the field the Mod reads");
  assert.ok(precondition < launch, "it must run before the game is launched");
  assert.ok(precondition < readiness, "it must run before the pipe wait it explains");
  // The pipe the run waits for comes from that same read, not a second parse of the file.
  assert.match(launcher, /\$pipeName = \$bridgeConfig\.PipeName/);
});

test("native-local bootstrap launcher does not restore an external action template", async () => {
  const launcher = await readFile(
    new URL("./run-stardew-native-local-player-move-fixture.ps1", import.meta.url),
    "utf8",
  );
  const bootstrapStart = launcher.indexOf("if ($BootstrapNativeSave) {");
  const nonBootstrapStart = launcher.indexOf("} else {", bootstrapStart);
  const launchStart = launcher.indexOf("$process = Start-Process", nonBootstrapStart);
  assert.notEqual(bootstrapStart, -1);
  assert.notEqual(nonBootstrapStart, -1);
  assert.notEqual(launchStart, -1);
  assert.doesNotMatch(launcher.slice(bootstrapStart, nonBootstrapStart), /fixtureSaveHarness/);
  assert.match(launcher.slice(nonBootstrapStart, launchStart), /prepare-stardew-native-local-player-fixture\.mjs/);
  assert.match(launcher, /if \(-not \$BootstrapNativeSave\) \{[\s\S]*?\$fixtureSaveHarness/);
  assert.match(launcher, /if \(\$workingSavePrepared\) \{[\s\S]*?\$fixtureSaveHarness/);
});

test("native-local crop-research fixture preps the Jodi's-Request start state only", async (t) => {
  const options = { ...(await createFixture(t, "crop-research")), action: "crop_research" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, [
    "move_to_tile",
    "travel",
    "equip_tool",
    "till_soil",
    "plant_seed",
    "water_crop",
    "observe_scene",
    "refill_watering_can",
  ]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_crop_research_v1");
  const entry = await readFixtureSource();
  const setupStart = entry.indexOf('if (fixture.FixtureScenario == "native_crop_research_v1")');
  assert.ok(setupStart >= 0, "ModEntry must own the crop-research fixture branch");
  const setup = entry.slice(
    setupStart,
    entry.indexOf('if (fixture.FixtureScenario == "native_fertilize_tile_v1")', setupStart),
  );
  // The fixture only establishes the plannable starting state; the Agent must
  // till/plant/water through production actions — no receipt or mutation here.
  assert.match(setup, /const string cauliflowerSeedId = "\(O\)474";/);
  assert.match(setup, /new WateringCan\(\)/);
  assert.doesNotMatch(
    setup,
    /\.checkAction\(|RequestLocalTillSoil|RequestLocalPlantSeed|RequestLocalWaterCrop|PublishReceipt|SpreadSeeds/,
  );
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local fridge fixture provisions a kitchen container without touching it", async (t) => {
  const options = { ...(await createFixture(t, "fridge-store")), action: "fridge_store" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  // The fridge is the same Chest store/take intent, so it publishes the same
  // container action; only the fixture scenario differs.
  assert.deepEqual(configured.EnabledActions, ["chest_store"]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_fridge_store_v1");
  const entry = await readFixtureSource();
  const branchStart = entry.indexOf(
    'if (fixture.FixtureScenario is "native_fridge_store_v1" or "native_fridge_retrieve_v1")',
  );
  assert.ok(branchStart >= 0, "ModEntry must own the fridge fixture branch");
  const branch = entry.slice(
    branchStart,
    entry.indexOf('if (fixture.FixtureScenario == "native_chop_stump_v1")', branchStart),
  );
  // The fixture establishes only the native precondition: a kitchen so the room
  // owns a fridge, a storable item, and a lawful standing tile. It must never run
  // the container transaction or emit a receipt.
  assert.match(branch, /parseDebugInput\("HouseUpgrade 1", null\)/);
  assert.match(branch, /home\.GetFridge\(\)/);
  assert.match(branch, /warpFarmer\(/);
  assert.doesNotMatch(
    branch,
    /RequestLocalChestStore|RequestLocalChestRetrieve|checkAction|PublishReceipt|addItem\(storedItem\)/,
  );
  await restoreNativeLocalPlayerFixture(options);
});

test("the fridge reuses the chest container runner and its second fixture scenario", async () => {
  const { fixtureActions, fixtureScenario } = await import("./lib/stardew-native-local-player-fixture.mjs");
  assert.deepEqual(fixtureActions("fridge_store"), ["chest_store"]);
  assert.deepEqual(fixtureActions("fridge_retrieve"), ["chest_retrieve"]);
  assert.equal(fixtureScenario(fixtureActions("fridge_store"), "fridge_store"), "native_fridge_store_v1");
  assert.equal(fixtureScenario(fixtureActions("fridge_retrieve"), "fridge_retrieve"), "native_fridge_retrieve_v1");
  // The placed-chest harness action keeps its original scenario.
  assert.equal(fixtureScenario(fixtureActions("chest_store"), "chest_store"), "native_chest_store_v1");
  const { resolveStardewActionGateRunner } = await import("./resolve-stardew-action-gate-runner.mjs");
  assert.equal(resolveStardewActionGateRunner("fridge_store"), "run-stardew-native-local-player-chest-store-smoke.mjs");
  assert.equal(
    resolveStardewActionGateRunner("fridge_retrieve"),
    "run-stardew-native-local-player-chest-retrieve-smoke.mjs",
  );
});

test("the move-stall probe reuses the move_to_tile action and its own blocker scenarios", async () => {
  const { fixtureActions, fixtureScenario } = await import("./lib/stardew-native-local-player-fixture.mjs");
  // The pet scenario advertises pet_animal ONLY so the Pet projection publishes
  // the blocker position; the runner never invokes it. The scenario selection
  // must therefore override the plain action->scenario mapping, or the pet
  // scenario would be hijacked into native_pet_animal_v1 (a live run already
  // hit that: fixture prepare wrote native_pet_animal_v1 and the runner refused
  // it as an invalid scenario).
  assert.deepEqual(fixtureActions("move_stall_probe_pet"), ["move_to_tile", "pet_animal"]);
  assert.equal(
    fixtureScenario(fixtureActions("move_stall_probe_pet"), "move_stall_probe_pet"),
    "native_move_stall_probe_pet_v1",
  );
  // The npc scenario has no Pet projection, so it does not advertise pet_animal.
  assert.deepEqual(fixtureActions("move_stall_probe_npc"), ["move_to_tile"]);
  assert.equal(
    fixtureScenario(fixtureActions("move_stall_probe_npc"), "move_stall_probe_npc"),
    "native_move_stall_probe_npc_v1",
  );
  // The plain pet_animal harness keeps its own scenario.
  assert.deepEqual(fixtureActions("pet_animal"), ["pet_animal"]);
  assert.equal(fixtureScenario(fixtureActions("pet_animal"), "pet_animal"), "native_pet_animal_v1");
  const { resolveStardewActionGateRunner } = await import("./resolve-stardew-action-gate-runner.mjs");
  assert.equal(
    resolveStardewActionGateRunner("move_stall_probe_pet"),
    "run-stardew-native-local-player-move-stall-probe-smoke.mjs",
  );
  assert.equal(
    resolveStardewActionGateRunner("move_stall_probe_npc"),
    "run-stardew-native-local-player-move-stall-probe-smoke.mjs",
  );
});

test("the island shipping bin reuses the ship_item runner and its own fixture scenario", async () => {
  const { fixtureActions, fixtureScenario } = await import("./lib/stardew-native-local-player-fixture.mjs");
  assert.deepEqual(fixtureActions("ship_item_island"), ["ship_item"]);
  assert.equal(fixtureScenario(fixtureActions("ship_item_island"), "ship_item_island"), "native_ship_item_island_v1");
  // The Farm bin harness action keeps its original scenario and action set.
  assert.deepEqual(fixtureActions("ship_item"), ["ship_item"]);
  assert.equal(fixtureScenario(fixtureActions("ship_item"), "ship_item"), "native_ship_item_v1");
  const { resolveStardewActionGateRunner } = await import("./resolve-stardew-action-gate-runner.mjs");
  assert.equal(
    resolveStardewActionGateRunner("ship_item_island"),
    "run-stardew-native-local-player-ship-item-smoke.mjs",
  );
});

test("native-local strawberry-covenant fixture supplies a mature crop and an empty native bin only", async (t) => {
  const options = { ...(await createFixture(t, "strawberry-covenant")), action: "strawberry_covenant" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  // Deny-by-exception fixture policy: the Mod catalog is the authority for the
  // Agent's surface, so the fixture denies nothing and enables what the run
  // claims. The scenario is the covenant probe's identity in the mundo.
  assert.deepEqual(configured.DeniedActions, []);
  assert.deepEqual(configured.DeniedActionFamilies, []);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_strawberry_covenant_v1");
  const entry = await readFixtureSource();
  const branchStart = entry.indexOf('if (fixture.FixtureScenario == "native_strawberry_covenant_v1")');
  assert.ok(branchStart >= 0, "ModEntry must own the strawberry-covenant fixture branch");
  const branch = entry.slice(branchStart, branchStart + 1400);
  assert.match(branch, /InitializeNativeLocalStrawberryCovenantFixture\(player, farm\)/);
  assert.match(branch, /return;/);
  // The branch must delegate and return; it must never harvest, ship, or touch
  // the shipping bin itself. Comments may mention the native ship transaction
  // (jodi's test keeps its own branch free of handler calls, not of the word).
  assert.doesNotMatch(
    branch,
    /RequestLocalHarvestCrop|RequestLocalShipItem|\.shipItem\(|checkAction|performUseAction|PublishReceipt/,
  );
  const setupStart = entry.indexOf("private void InitializeNativeLocalStrawberryCovenantFixture");
  assert.ok(setupStart >= 0, "ModEntry must own the strawberry-covenant helper");
  const setup = entry.slice(setupStart, setupStart + 3000);
  // The helper establishes exactly two Given facts: a mature strawberry crop
  // (grown by the target-version debug command, since 8 growth days are scenario
  // setup rather than an Agent wait) and the empty native Shipping Bin as the
  // temptation. It must never harvest, ship, reward or otherwise mutate the
  // outcome itself.
  assert.match(setup, /const string protectedHarvestId = "\(O\)400"/);
  assert.match(setup, /parseDebugInput\("SpreadSeeds 745", null\)/);
  assert.match(setup, /parseDebugInput\("GrowCrops 8", null\)/);
  assert.match(setup, /ShippingBin/);
  assert.match(setup, /getShippingBin\(player\)\.Clear\(\)/);
  assert.doesNotMatch(setup, /RequestLocalShipItem|\.shipItem\(|deliverItem|receiveGift|completeQuest/);
});

test("the strawberry-covenant fixture mapping is stable and isolated", async () => {
  const { fixtureActions, fixtureScenario } = await import("./lib/stardew-native-local-player-fixture.mjs");
  assert.deepEqual(fixtureActions("strawberry_covenant"), [
    "move_to_tile",
    "travel",
    "harvest_crop",
    "ship_item",
    "observe_scene",
  ]);
  assert.equal(
    fixtureScenario(fixtureActions("strawberry_covenant"), "strawberry_covenant"),
    "native_strawberry_covenant_v1",
  );
  // A plain harvest run (no ship temptation) must still choose the harvest
  // scenario, so enabling ship_item is what switches the covenant shape.
  assert.equal(fixtureScenario(["move_to_tile", "travel", "harvest_crop"], "harvest_crop"), "native_harvest_crop_v1");
});

test("native-local jodi-harvest-deliver fixture supplies a mature crop and a reachable villager only", async (t) => {
  const options = { ...(await createFixture(t, "jodi-harvest-deliver")), action: "jodi_harvest_deliver" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  // The Agent must harvest a real crop and then offer it; both execution actions
  // plus navigation and the read-only scene observation are enabled together.
  assert.deepEqual(configured.EnabledActions, [
    "move_to_tile",
    "travel",
    "harvest_crop",
    "interact_npc_with_item",
    "observe_scene",
  ]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_jodi_harvest_deliver_v1");
  const entry = await readFixtureSource();
  const branchStart = entry.indexOf('if (fixture.FixtureScenario == "native_jodi_harvest_deliver_v1")');
  assert.ok(branchStart >= 0, "ModEntry must own the jodi-harvest-deliver fixture branch");
  const branch = entry.slice(
    branchStart,
    entry.indexOf('if (fixture.FixtureScenario == "native_pickup_forage_v1")', branchStart),
  );
  // The branch must delegate to the helper and return before any other scenario runs.
  assert.match(branch, /return;/);
  assert.doesNotMatch(
    branch,
    /RequestLocalHarvestCrop|RequestLocalInteractNpcWithItem|checkAction|performUseAction|questComplete|receiveGift|PublishReceipt/,
  );
  const setup = memberBody(entry, "private void InitializeNativeLocalJodiHarvestDeliverFixture(");
  assert.ok(setup, "ModEntry must own the jodi-harvest-deliver helper");
  // The helper establishes exactly two Given facts: a mature ordinary crop (grown
  // by the target-version debug command, since 12 growth days are scenario setup
  // rather than an Agent wait) and a reachable villager. It must never harvest,
  // offer, complete a quest or reward anything itself.
  assert.match(setup, /const string npcName = "Jodi"/);
  assert.match(setup, /const string desiredHarvestId = "\(O\)190"/);
  assert.match(setup, /parseDebugInput\("SpreadSeeds 474", null\)/);
  assert.match(setup, /parseDebugInput\("GrowCrops 12", null\)/);
  assert.match(setup, /Game1\.warpCharacter\(npc, farm, npcTile\.Value\)/);
  assert.match(setup, /relationship\.Clear\(\)/);
  assert.doesNotMatch(
    setup,
    /RequestLocalHarvestCrop|RequestLocalInteractNpcWithItem|checkAction|\.performUseAction|questComplete|receiveGift|PublishReceipt/,
  );
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local machine-load fixture supplies only an idle Keg and exact Coffee Bean stack", async (t) => {
  const options = { ...(await createFixture(t, "machine-load")), action: "machine_load" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, ["machine_load"]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_machine_coffee_load_v1");
  const entry = await readFixtureSource();
  const setupStart = entry.indexOf(
    'if (fixture.FixtureScenario is "native_machine_inspect_v1" or "native_machine_coffee_load_v1" or "native_machine_coffee_collect_v1")',
  );
  const setup = entry.slice(
    setupStart,
    entry.indexOf('if (fixture.FixtureScenario == "native_dig_artifact_spot_v1")', setupStart),
  );
  assert.match(setup, /ItemRegistry\.Create<StardewValley\.Object>\("\(O\)433", 5\)/);
  assert.match(setup, /fixture_native_local_machine_coffee_input_missing/);
  assert.doesNotMatch(
    setup,
    /\.checkAction\(|PlaceInMachine|performObjectDropInAction|RequestLocalLoadCoffeeIntoKeg|PublishReceipt/,
  );
  const manager = await readExecutionManagerSources();
  const actionStart = manager.indexOf("public LocalExecutionReceipt RequestLocalLoadCoffeeIntoKeg");
  const action = manager.slice(
    actionStart,
    manager.indexOf("public LocalExecutionReceipt RequestLocalInspectMachine", actionStart),
  );
  assert.match(action, /location\.checkAction\(/);
  assert.doesNotMatch(action, /PlaceInMachine|performObjectDropInAction/);
  assert.match(action, /machine_coffee_loaded/);
  const runner = await readFile(
    new URL("./run-stardew-native-local-player-machine-load-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /native_machine_coffee_load_v1/);
  assert.match(runner, /machine_coffee_loaded/);
  assert.match(runner, /input_stack_after === "removed"/);
  // The runner must relate the observed duration to the derived one, not assert the
  // content constant 120: the Mod derives the expected duration from live machine
  // data, so pinning the literal here would defeat that.
  assert.match(runner, /minutes_until_ready === evidence\.expected_minutes_until_ready/);
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local machine-navigate-ab fixture preps a door-side Keg and coffee for walk→inspect→load", async (t) => {
  const options = { ...(await createFixture(t, "machine-navigate-ab")), action: "machine_navigate_ab" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, [
    "find_destination",
    "navigate_to_destination",
    "machine_inspect",
    "machine_load",
    "observe_scene",
  ]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_machine_navigate_ab_v1");
  const entry = await readFixtureSource();
  const setupStart = entry.indexOf('if (fixture.FixtureScenario == "native_machine_navigate_ab_v1")');
  assert.ok(setupStart >= 0, "ModEntry must own the ladder-1 fixture branch");
  const setup = entry.slice(
    setupStart,
    entry.indexOf('if (fixture.FixtureScenario == "native_till_soil_v1")', setupStart),
  );
  assert.match(setup, /FindNativeLocalFarmFixtureTile\(busStop, navigateLanding, 1/);
  assert.match(setup, /ItemRegistry\.Create<StardewValley\.Object>\("\(BC\)12", 1\)/);
  assert.match(setup, /ItemRegistry\.Create<StardewValley\.Object>\("\(O\)433", 5\)/);
  assert.doesNotMatch(
    setup,
    /\.checkAction\(|PlaceInMachine|performObjectDropInAction|RequestLocalLoadCoffeeIntoKeg|RequestLocalInspectMachine|PublishReceipt/,
  );
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local machine-collect fixture starts from loading only; production owns ready-time and collection", async (t) => {
  const options = { ...(await createFixture(t, "machine-collect")), action: "machine_collect_output" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, ["machine_load", "machine_collect_output"]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_machine_coffee_load_v1");
  const entry = await readFixtureSource();
  const setupStart = entry.indexOf(
    'if (fixture.FixtureScenario is "native_machine_inspect_v1" or "native_machine_coffee_load_v1" or "native_machine_coffee_collect_v1")',
  );
  const setup = entry.slice(
    setupStart,
    entry.indexOf('if (fixture.FixtureScenario == "native_dig_artifact_spot_v1")', setupStart),
  );
  assert.doesNotMatch(setup, /readyForHarvest\s*=|MinutesUntilReady\s*=|heldObject\.Value\s*=/);
  const manager = await readExecutionManagerSources();
  const actionStart = manager.indexOf("public LocalExecutionReceipt RequestLocalCollectCoffeeFromKeg");
  const action = manager.slice(
    actionStart,
    manager.indexOf("public LocalExecutionReceipt RequestLocalInspectMachine", actionStart),
  );
  assert.match(action, /location\.checkAction\(/);
  assert.match(action, /machine_coffee_collected/);
  assert.doesNotMatch(action, /PlaceInMachine|performObjectDropInAction/);
  const runner = await readFile(
    new URL("./run-stardew-native-local-player-machine-collect-output-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /waitForReadyTarget/);
  assert.match(runner, /machine_ready_timeout_without_time_skip/);
  assert.match(runner, /machine_coffee_collected/);
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local dig-artifact-spot fixture selects an intact artifact spot and Basic Hoe without consuming sources", async (t) => {
  const options = { ...(await createFixture(t, "dig-artifact-spot")), action: "dig_artifact_spot" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, ["move_to_tile", "travel", "equip_tool", "dig_artifact_spot"]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_dig_artifact_spot_v1");
  const entry = await readFixtureSource();
  const setupStart = entry.indexOf('if (fixture.FixtureScenario == "native_dig_artifact_spot_v1")');
  const setup = entry.slice(
    setupStart,
    entry.indexOf('if (fixture.FixtureScenario == "native_clear_hoedirt_v1")', setupStart),
  );
  assert.match(setup, /new Hoe\(\)/);
  // The dig branch orders candidates by X then Y so a reachable source is chosen.
  // The sort now PREFERS `(O)SeedSpot` first, so the X/Y ordering is spelled
  // `ThenBy` rather than the old leading `OrderBy` (8aecd925).
  assert.match(setup, /\.ThenBy\(pair => pair\.Key\.X\)/);
  assert.match(setup, /\.ThenBy\(pair => pair\.Key\.Y\)/);
  assert.match(setup, /artifactSourceCount < 1/);
  assert.doesNotMatch(
    setup,
    /DoFunction|digUpArtifactSpot|checkAction|RequestLocalDigArtifactSpot|PublishReceipt|\b(?:request|receipt|reward|debris|pickup|outcome)\b|Items\[/i,
  );
  assert.doesNotMatch(setup, /objects\.Remove/);
  assert.match(setup, /artifactSourceCount < 1/);
  assert.match(
    entry,
    /!farm\.IsTileOccupiedBy\(artifactPending\.StandingTile, ~CollisionMask\.Farmers, CollisionMask\.None, useFarmerTile: false\)/,
  );
  const failureMarker = "error=fixture_native_local_artifact_spot_approach_unreachable";
  const failureBranchStart = entry.indexOf(
    "this.nativeLocalDigArtifactSpotFixturePending = null;",
    entry.indexOf("if (this.nativeLocalDigArtifactSpotFixturePending"),
  );
  const failureBranch = entry.slice(
    failureBranchStart,
    entry.indexOf("if (this.nativeLocalClearHoeDirtFixturePending", failureBranchStart),
  );
  const debugLogIndex = failureBranch.indexOf("[DEBUG-artifact-fixture]");
  const genericFailureIndex = failureBranch.indexOf(failureMarker);
  assert.ok(debugLogIndex >= 0 && debugLogIndex < genericFailureIndex);
  for (const fact of [
    "player_is_game1_player",
    "new_location_is_farm",
    "farm_name_equal",
    "source_count",
    "source_present_at_expected_tile",
    "source_qid_is_590",
    "source_on_map",
    "source_terrain_absent",
    "source_hoedirt_absent",
    "source_indoor_pot",
    "standing_on_map",
    "standing_passable",
    "standing_occupied_use_farmer_tile_false",
    "hoe_count",
    "basic_hoe",
    "player_tile",
    "expected_standing_tile",
  ])
    assert.match(failureBranch, new RegExp(`${fact}=`));

  const helperStart = entry.indexOf("private static Vector2? FindNativeLocalArtifactSpotStandingTile");
  const helper = entry.slice(
    helperStart,
    entry.indexOf("private static Vector2? FindNativeLocalFarmFixtureTile", helperStart),
  );
  assert.doesNotMatch(helper, /isTilePassable\(artifactTile\)/);
  assert.match(helper, /candidate => farm\.isTileOnMap\(candidate\) && farm\.isTilePassable\(candidate\)/);
  assert.match(
    helper,
    /!farm\.IsTileOccupiedBy\(candidate, ~CollisionMask\.Farmers, CollisionMask\.None, useFarmerTile: false\)/,
  );

  const artifactWarpStart = entry.indexOf("if (this.nativeLocalDigArtifactSpotFixturePending");
  const artifactWarp = entry.slice(
    artifactWarpStart,
    entry.indexOf("if (this.nativeLocalClearHoeDirtFixturePending", artifactWarpStart),
  );
  assert.doesNotMatch(artifactWarp, /isTilePassable\(artifactPending\.ArtifactTile\)/);
  assert.match(artifactWarp, /farm\.isTileOnMap\(artifactPending\.StandingTile\)/);
  assert.match(artifactWarp, /farm\.isTilePassable\(artifactPending\.StandingTile\)/);
  assert.match(
    artifactWarp,
    /!farm\.IsTileOccupiedBy\(artifactPending\.StandingTile, ~CollisionMask\.Farmers, CollisionMask\.None, useFarmerTile: false\)/,
  );
  assert.doesNotMatch(artifactWarp, /\|\| e\.Player\.Tile == artifactPending\.StandingTile/);
  assert.doesNotMatch(artifactWarp, /CollisionMask\.All, CollisionMask\.None, useFarmerTile: false/);

  assert.doesNotMatch(setup, /isTilePassable\(artifactTile\)/);
  assert.match(setup, /farm\.isTileOnMap\(artifactTile\)/);
  assert.match(setup, /farm\.terrainFeatures\.ContainsKey\(artifactTile\)/);
  assert.match(setup, /farm\.GetHoeDirtAtTile\(artifactTile\) is not null/);
  const runner = await readFile(
    new URL("./run-stardew-native-local-player-dig-artifact-spot-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /const _EXPECTED_ACTIONS = \["move_to_tile", "travel", "equip_tool", "dig_artifact_spot"\]/);
  for (const capability of [
    "cancel_active_execution",
    "dig_artifact_spot",
    "equip_tool",
    "inspect_self",
    "move_to_tile",
    "travel",
  ])
    assert.match(runner, new RegExp(`"${capability}"`));
  assert.match(runner, /equip_tool/);
  assert.match(runner, /target_changed_after_equip/);
  assert.match(runner, /Object\.hasOwn\(result, key\)/);
  assert.match(runner, /artifactSpotResultTargets/);
  assert.match(runner, /initialSourceCount/);
  assert.match(runner, /const preCount = fresh\.artifactSpotFarmSourceCount/);
  assert.match(runner, /preCount < 1/);
  assert.match(runner, /preCount - 1/);
  assert.match(runner, /Number\.isInteger\(initialSourceCount\).*initialSourceCount < 1/);
  assert.doesNotMatch(runner, /artifactSpotFarmSourceCount === 0/);
  assert.match(runner, /artifact_spot_dug/);
  assert.match(runner, /stamina_before/);
  assert.match(runner, /stamina_after/);
  assert.match(runner, /stamina_delta/);
  assert.match(runner, /expected_stamina_cost/);
  assert.match(runner, /parseFiniteDecimal/);
  assert.match(runner, /DIG_ARTIFACT_STAMINA_EVIDENCE_EPSILON = 0\.011/);
  assert.match(
    runner,
    /Math\.abs\(-parseFiniteDecimal\(evidence\.stamina_delta\) - parseFiniteDecimal\(evidence\.expected_stamina_cost\)\) <=\s+DIG_ARTIFACT_STAMINA_EVIDENCE_EPSILON/,
  );
  assert.match(runner, /stamina_delta\) <= 0/);
  const protocol = await readFile(
    new URL("../integrations/stardew/src/Core/Models/BridgeProtocolModels.cs", import.meta.url),
    "utf8",
  );
  assert.match(protocol, /ArtifactSpotFarmSourceCount/);
  const executionManager = await readExecutionManagerSources();
  assert.match(executionManager, /CountArtifactSpotFarmSources/);
  // Both native artifact-spot ids are counted, never `(O)590` alone: the engine
  // routes `(O)590` and `(O)SeedSpot` through one dig branch.
  assert.match(
    executionManager,
    /farm\.objects\.Pairs\.Count\(pair => NativeItemPredicates\.IsArtifactSpot\(pair\.Value\)\)/,
  );
  assert.match(executionManager, /OrderBy\(pair => pair\.Key\.X\)/);
  assert.match(executionManager, /ThenBy\(pair => pair\.Key\.Y\)/);
  assert.match(executionManager, /\.Take\(8\)/);
  const artifactDiscoveryStart = executionManager.indexOf(
    "private static IReadOnlyList<BridgeArtifactSpotTarget> DiscoverArtifactSpotTargets",
  );
  const artifactDiscovery = executionManager.slice(
    artifactDiscoveryStart,
    executionManager.indexOf("private IReadOnlyList<BridgeArtifactSpotResultTarget>", artifactDiscoveryStart),
  );
  assert.doesNotMatch(artifactDiscovery, /location\.isTilePassable\(pair\.Key\)/);
  assert.match(artifactDiscovery, /location\.isTilePassable\(standing\)/);
  assert.match(artifactDiscovery, /\|\| player\.Tile == standing/);
  const execution = await readExecutionManagerSources();
  assert.match(execution, /hoe\.UpgradeLevel != 0/);
  assert.match(execution, /basic_hoe_not_equipped_in_requested_slot/);
  assert.match(
    execution,
    /if \(hoeDirtPresentBefore\)\s+return this\.RememberTerminal\(requestId, executionId, ExecutionState\.Rejected, "artifact_spot_hoedirt_present_before"/,
  );
  // The artifact-spot dig is a tool-family direct dispatch: it captures the
  // pre-swing stamina, routes its ONE native swing through the shared seam, and
  // reads the post-swing stamina. Pinning the seam CALL keeps the handler from
  // hand-rolling Farmer.useTool again; the seam's own body is pinned below, so
  // neither half can drift alone. The handler must not reach DoFunction directly.
  // The stamina window lives in `ExecuteDigArtifactSpot`, which both the in-range
  // and the post-approach paths call, so the two cannot capture it differently.
  const artifactHandler = memberBody(execution, "private LocalExecutionReceipt ExecuteDigArtifactSpot(");
  assert.ok(artifactHandler, "the artifact-spot execution body must live in an owned execution-manager partial");
  assert.match(
    artifactHandler,
    /float staminaBefore = Game1\.player\.Stamina;[\s\S]*UseNativeToolOnTile\(hoe, location, targetX, targetY, Game1\.player, staminaBefore\);[\s\S]*float staminaAfter = Game1\.player\.Stamina;/,
  );
  assert.doesNotMatch(artifactHandler, /hoe\.DoFunction\(/);

  // The shared seam is the single owner of Farmer.useTool's closing steps: clear
  // the click anchor, THEN apply the exhaustion consequence, after the swing.
  const toolUseSeam = memberBody(execution, "private static void UseNativeToolOnTile(");
  assert.ok(toolUseSeam, "the shared native tool-use seam must live in an owned execution-manager partial");
  assert.match(
    toolUseSeam,
    /DoFunction\([\s\S]*who\.lastClick = Vector2\.Zero;[\s\S]*who\.checkForExhaustion\(staminaBefore\);/,
  );
  assert.doesNotMatch(execution, /Stamina\s*[<>]=?\s*2|stamina_insufficient|insufficient_stamina/);
  assert.match(execution, /stamina_before=.*stamina_after=.*stamina_delta=.*expected_stamina_cost=/);
  assert.match(execution, /bool succeeded = !hoeDirtPresentBefore && !sourcePresentAfter && hoeDirtPresentAfter/);
  assert.match(execution, /artifactSpotResultExecutionId/);
  assert.match(execution, /artifactSpotResultRequestId/);
  assert.match(execution, /InvalidateArtifactSpotResult\(\)/);
  assert.match(execution, /receipt\.ReasonCode != "artifact_spot_dug"/);
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local bait-crab-pot fixture is pre-attachment only and preserves the native mutation boundary", async (t) => {
  const options = { ...(await createFixture(t, "bait-crab-pot")), action: "bait_crab_pot" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, ["bait_crab_pot"]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_bait_crab_pot_v1");
  const entry = await readFixtureSource();
  const start = entry.indexOf('if (fixture.FixtureScenario == "native_bait_crab_pot_v1")');
  const setup = entry.slice(start, entry.indexOf('if (fixture.FixtureScenario == "native_place_crab_pot_v1")', start));
  assert.match(setup, /const string baitId = "\(O\)685"/);
  assert.match(setup, /StardewValley\.Objects\.CrabPot pot = new\(\)/);
  assert.match(setup, /pot\.owner\.Value = player\.UniqueMultiplayerID/);
  assert.match(setup, /pot\.bait\.Value is not null/);
  assert.match(setup, /player\.warpFarmer/);
  assert.doesNotMatch(setup, /performObjectDropInAction|reduceActiveItemByOne|PublishReceipt/i);
  const runner = await readFile(
    new URL("./run-stardew-native-local-player-bait-crab-pot-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /executeFresh\(client, \{/);
  assert.match(runner, /requestId,/);
  assert.match(runner, /receipt\.revision === after\.revision/);
  assert.match(runner, /inventory_before\) === 1|Number\(evidence\.inventory_before\) === 1/);
  assert.match(runner, /requireActionable: true/);
  assert.match(runner, /baitCrabPotResultTargets/);
  const execution = await readExecutionManagerSources();
  assert.match(execution, /RequestLocalBaitCrabPot/);
  assert.match(execution, /location\.checkAction\(new xTile\.Dimensions\.Location\(targetX, targetY\)/);
  assert.match(execution, /BuildBaitCrabPotTargetId/);
  assert.match(execution, /bait_crab_pot_[\s\S]*SHA256/);
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local place-crab-pot fixture discovers one exact native target and never performs placement", async (t) => {
  const options = { ...(await createFixture(t, "place-crab-pot")), action: "place_crab_pot" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, ["move_to_tile", "travel", "place_crab_pot"]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_place_crab_pot_v1");
  const entry = await readFixtureSource();
  const setupStart = entry.indexOf('if (fixture.FixtureScenario == "native_place_crab_pot_v1")');
  const setup = entry.slice(
    setupStart,
    entry.indexOf('if (fixture.FixtureScenario == "native_plant_seed_v1")', setupStart),
  );
  assert.match(setup, /const string crabPotId = "\(O\)710"/);
  assert.match(setup, /CrabPot\.IsValidCrabPotLocationTile/);
  assert.match(setup, /IsExcludedCrabPotLocation\(farm\)/);
  assert.match(setup, /player\.warpFarmer/);
  assert.match(setup, /inventoryBefore/);
  assert.match(setup, /inventoryAfter/);
  assert.match(setup, /ReferenceEquals\(existingCrabPots\[0\], crabPotsAfter\[0\]\)/);
  assert.match(setup, /fixture_native_local_crab_pot_inventory_multiple_stacks/);
  assert.match(setup, /fixture_native_local_crab_pot_inventory_stack_must_be_exactly_one/);
  assert.match(setup, /crabPotStack/);
  assert.match(setup, /Native inventory insertion may normalize unrelated item object/);
  assert.match(setup, /inventoryStacksBefore|inventoryIdsBefore|fixture_native_local_crab_pot_inventory_changed/);
  assert.doesNotMatch(setup, /ReferenceEquals\(inventoryBefore\[slot\], inventoryAfter\[slot\]\)/);
  assert.doesNotMatch(
    setup,
    /player\.Items\.Remove|new CrabPot\(|placementAction|reduceActiveItemByOne|dropObject|createItemDebris|PublishReceipt|receipt/i,
  );
  const helperStart = entry.indexOf(
    "private static (Vector2 TargetTile, Vector2 StandingTile)? FindNativeLocalCrabPotFixtureTarget",
  );
  const helper = entry.slice(
    helperStart,
    entry.indexOf("private static Vector2? FindNativeLocalFarmFixtureTile", helperStart),
  );
  assert.match(helper, /CrabPot\.IsValidCrabPotLocationTile/);
  assert.match(helper, /validStanding\.Length == 1/);
  assert.match(helper, /farm\.isTileOnMap\(standing\)/);
  assert.match(helper, /farm\.isTilePassable\(standing\)/);
  assert.match(helper, /IsTileOccupiedBy\(standing, ~CollisionMask\.Farmers/);
  const warpStart = entry.indexOf("if (this.nativeLocalPlaceCrabPotFixturePending");
  const warp = entry.slice(warpStart, entry.indexOf("if (this.nativeLocalDigArtifactSpotFixturePending", warpStart));
  assert.match(warp, /CrabPot\.IsValidCrabPotLocationTile/);
  assert.match(warp, /ReferenceEquals\(item, crabPotPending\.CrabPot\)/);
  assert.match(warp, /crabPotPending\.CrabPot\.Stack == crabPotPending\.CrabPotStack/);
  assert.doesNotMatch(
    warp,
    /new CrabPot\(|placementAction|reduceActiveItemByOne|PublishReceipt|dropObject|createItemDebris/i,
  );
  const resetStart = entry.indexOf("private void OnReturnedToTitle");
  const reset = entry.slice(resetStart, entry.indexOf("private void StatusCommand", resetStart));
  assert.match(reset, /nativeLocalPlaceCrabPotFixturePending = null/);
  const runner = await readFile(
    new URL("./run-stardew-native-local-player-place-crab-pot-fixture-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /state: "fixture_prepared"/);
  assert.match(runner, /productionRequestSent: false/);
  assert.match(runner, /snapshot\.capabilities\.includes\(action\)/);
  assert.match(runner, /productionRequestSent: false/);
  assert.match(runner, /productionRequestSent: false/);
  assert.match(runner, /latestReceipt/);
  assert.match(runner, /latestReceipt/);
  assert.match(runner, /productionRequestSent: false/);
  assert.doesNotMatch(runner, /client\.execute\(/);
  const launcher = await readFile(
    new URL("./run-stardew-native-local-player-move-fixture.ps1", import.meta.url),
    "utf8",
  );
  assert.match(launcher, /resolve-stardew-action-gate-runner\.mjs/);
  const descriptors = await readFile(new URL("./stardew-action-gate-descriptors.mjs", import.meta.url), "utf8");
  assert.match(
    descriptors,
    /gate\(\s*"place_crab_pot",\s*1,\s*"run-stardew-native-local-player-place-crab-pot-smoke\.mjs"/s,
  );
  const config = await readFile(new URL("../integrations/stardew/ModConfig.cs", import.meta.url), "utf8");
  // The armed/bootstrap gate no longer enumerates scenarios inline: both paths
  // validate against the one closed `KnownFixtureScenarios` set (91638ce0).
  const scenarioSetStart = config.indexOf("KnownFixtureScenarios = new[]");
  const scenarioSet = config.slice(scenarioSetStart, config.indexOf("];", scenarioSetStart));
  assert.match(scenarioSet, /"native_place_crab_pot_v1"/);
  const definitions = await readFile(
    new URL("../integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs", import.meta.url),
    "utf8",
  );
  assert.match(
    definitions,
    /E\("place_crab_pot",\s*"buildings_farm_management",\s*FarmhandActionHandlerGroup\.ResourceTools/,
  );
  const productionRunner = await readFile(
    new URL("./run-stardew-native-local-player-place-crab-pot-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(productionRunner, /executeFresh\(/);
  assert.match(productionRunner, /source.*target disappearance|crabPotTargets/);
  assert.match(productionRunner, /overlayTiles/);
  const execution = await readExecutionManagerSources();
  assert.match(execution, /RequestLocalPlaceCrabPot/);
  assert.match(execution, /BuildCrabPotOverlayFacts/);
  assert.match(execution, /OverlayTiles/);
  const protocol = await readFile(
    new URL("../integrations/stardew/src/Core/Models/BridgeProtocolModels.cs", import.meta.url),
    "utf8",
  );
  assert.match(protocol, /BridgeCrabPotOverlayTile/);
  assert.match(protocol, /BridgeCrabPotResultTarget/);
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local break-rock-source fixture is isolated and cannot perform the hit", async (t) => {
  const options = { ...(await createFixture(t, "break-rock-source")), action: "break_rock_source" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, ["move_to_tile", "travel", "equip_tool", "break_rock_source"]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_break_rock_source_v1");
  const entry = await readFixtureSource();
  const setup = entry.slice(
    entry.indexOf('fixture.FixtureScenario == "native_break_rock_source_v1"'),
    scenarioBranchAt(entry, "native_chop_tree_source_v1"),
  );
  assert.match(setup, /ItemRegistry\.Create<StardewValley\.Object>\("\(O\)2", 1\)/);
  assert.match(setup, /rock.MinutesUntilReady = 1/);
  assert.doesNotMatch(setup, /DoFunction|RequestLocalBreakRockSource|PublishReceipt/);
  const runner = await readFile(
    new URL("./run-stardew-native-local-player-break-rock-source-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /durability_before === "1"/);
  assert.match(runner, /durability_after === "removed"/);
  assert.match(runner, /removed === "true"/);
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local clear-hoedirt fixture establishes only the intact empty ground precondition", async (t) => {
  const options = { ...(await createFixture(t, "clear-hoedirt")), action: "clear_hoedirt" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, ["move_to_tile", "travel", "equip_tool", "clear_hoedirt"]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_clear_hoedirt_v1");

  const entry = await readFixtureSource();
  const setupStart = entry.indexOf('if (fixture.FixtureScenario == "native_clear_hoedirt_v1")');
  const setup = entry.slice(setupStart, scenarioBranchAt(entry, "native_chop_tree_source_v1", setupStart));
  assert.match(setup, /new Pickaxe\(\)/);
  assert.match(setup, /Vector2 fixtureArrival = new\(64f, 15f\)/);
  assert.match(setup, /FindNativeLocalFarmFixtureTile\(farm, fixtureArrival, 12/);
  assert.match(setup, /NativeLocalClearHoeDirtFixturePending/);
  assert.match(setup, /player\.warpFarmer\(new StardewValley\.Warp/);
  assert.match(setup, /StardewValley\.TerrainFeatures\.HoeDirt dirt = new\(\)/);
  assert.match(setup, /dirt\.crop is not null/);
  assert.match(setup, /IndoorPot/);
  assert.doesNotMatch(setup, /Utility\.tileWithinRadiusOfPlayer/);
  assert.match(entry, /fixture_native_local_clear_hoedirt_approach_unreachable/);
  assert.doesNotMatch(setup, /^\s*pickaxe\.DoFunction\(/m);
  assert.doesNotMatch(setup, /RequestLocalClearHoeDirt|PublishReceipt|terrainFeatures\.Remove/);

  const protocol = await readFile(
    new URL("../integrations/stardew/src/Core/Models/BridgeProtocolModels.cs", import.meta.url),
    "utf8",
  );
  assert.match(
    protocol,
    /BridgeClearHoeDirtTarget\(string TargetId, string Location, int X, int Y, bool Crop, bool Ground\)/,
  );
  const session = await readFile(new URL("../integrations/stardew/BridgeSession.cs", import.meta.url), "utf8");
  // Per-action argument validation moved out of BridgeSession's inline chain into
  // the descriptor-driven `FarmhandExecutionAcceptance` when dispatch converged on
  // the single action registry (305ddc09). Pinning the per-action call site would
  // pin a shape that no longer exists; the shape is declared in the catalogue.
  const acceptance = await readFile(
    new URL("../integrations/stardew/src/Core/Policy/FarmhandExecutionAcceptance.cs", import.meta.url),
    "utf8",
  );
  assert.match(acceptance, /HasExactArgumentShape\(descriptor, args\)/);
  assert.match(session, /actionRouter\.CanExecute\(request\.Action, out reasonCode\)/);
  const runner = await readFile(
    new URL("./run-stardew-native-local-player-clear-hoedirt-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /\["move_to_tile", "travel", "equip_tool", "clear_hoedirt"\]/);
  assert.match(runner, /evidence\.crop_before === "false"/);
  assert.match(runner, /evidence\.hoedirt_present_before === "true"/);
  assert.match(runner, /evidence\.hoedirt_present_after === "false"/);
  assert.match(runner, /evidence\.removed === "true"/);
  assert.match(runner, /reread === undefined/);
  assert.match(runner, /if \(snapshot\.location === "FarmHouse"\) snapshot = await travelToFarm\(snapshot\);/);
  assert.match(
    runner,
    /else if \(snapshot\.location !== "Farm"\)\s+throw new Error\("clear_hoedirt_route_must_start_at_farmhouse_or_fixture_farm"\);/,
  );
  assert.match(runner, /const target = chooseHoeDirt\(snapshot\);/);
  assert.doesNotMatch(runner, /moveToReachableHoeDirt/);
  assert.doesNotMatch(runner, /move_to_clear_hoedirt_fixture/);
  const launcher = await readFile(
    new URL("./run-stardew-native-local-player-move-fixture.ps1", import.meta.url),
    "utf8",
  );
  assert.match(launcher, /function Assert-LaunchedSmapiIdentity\(/);
  assert.match(launcher, /Assert-LaunchedSmapiIdentity -ExpectedSmapi \$smapi -ExpectedModsPath \$ModsPath/);
  assert.match(launcher, /actual\.ExecutablePath/);
  assert.match(launcher, /\$modsPathMatches = \[regex\]::Matches\(/);
  assert.match(launcher, /--mods-path\\s\+/);
  assert.match(launcher, /\$modsPathMatches\.Count -ne 1/);
  assert.match(launcher, /Get-NormalizedWindowsPath \$actualModsPath/);
  assert.doesNotMatch(launcher, /actual\.CommandLine\.IndexOf\(\$expectedModsPath/);
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local clear-debris fixture establishes one intact native resource clump only", async (t) => {
  const options = { ...(await createFixture(t, "clear-debris")), action: "clear_debris" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, ["move_to_tile", "travel", "equip_tool", "clear_debris"]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_clear_debris_resource_clump_v1");

  const entry = await readFixtureSource();
  const setupStart = entry.indexOf('if (fixture.FixtureScenario == "native_clear_debris_resource_clump_v1")');
  const setup = entry.slice(setupStart, scenarioBranchAt(entry, "native_chop_tree_source_v1", setupStart));
  assert.match(setup, /const int debrisParentSheetIndex = 752/);
  assert.match(setup, /const int debrisWidth = 2/);
  assert.match(setup, /const int debrisHeight = 2/);
  assert.match(setup, /const int debrisDefaultHealth = 8/);
  assert.match(setup, /Vector2 debrisTile = new\(62f, 17f\)/);
  assert.match(setup, /fixture_native_local_debris_fixed_placement_unavailable/);
  assert.match(setup, /fixture_native_local_debris_parent_already_present/);
  assert.doesNotMatch(setup, /FindNativeLocalFarmResourceClumpFixtureTile\(/);
  assert.doesNotMatch(setup, /player\.Position =/);
  assert.match(entry, /farm\.CanItemBePlacedHere\(footprint/);
  assert.match(
    setup,
    /farm\.addResourceClumpAndRemoveUnderlyingTerrain\(debrisParentSheetIndex, debrisWidth, debrisHeight, debrisTile\)/,
  );
  assert.match(setup, /new Pickaxe\(\)/);
  assert.doesNotMatch(
    setup,
    /resourceClumps\.Add|DoFunction|RequestLocalClearDebris|performToolAction|health\.Value\s*=|PublishReceipt/,
  );

  const executionManager = await readExecutionManagerSources();
  const protocol = await readFile(
    new URL("../integrations/stardew/src/Core/Models/BridgeProtocolModels.cs", import.meta.url),
    "utf8",
  );
  assert.match(
    protocol,
    /BridgeDebrisTarget\(string TargetId, int Slot, int X, int Y, int ParentSheetIndex, string ToolKind, int RequiredUpgradeLevel, int Health\)/,
  );

  const requestStart = executionManager.indexOf("public LocalExecutionReceipt RequestLocalClearDebris");
  const request = executionManager.slice(
    requestStart,
    executionManager.indexOf(
      "private static StardewValley.TerrainFeatures.ResourceClump? FindDebrisTarget",
      requestStart,
    ),
  );
  // The reach gate is the tool's own reach, measured against the WHOLE footprint: one Chebyshev step from any tile
  // the clump occupies. It used to be `IsDebrisTargetWithinPlayerRadius`, which answers the DISCOVERY question over
  // six steps - so an actor six tiles away was admitted and swung at a tile the swing could not reach, and a clump 3-6
  // tiles away was neither walked to nor refused.
  assert.match(request, /IsDebrisFootprintWithinChebyshev\(Game1\.player, clump, 1\)/);
  assert.match(request, /TryBeginToolApproach\(/);
  assert.match(executionManager, /internal static bool IsDebrisFootprintWithinChebyshev/);
  assert.match(
    executionManager,
    /internal static System\.Collections\.Generic\.IReadOnlyList<\(int X, int Y\)> DebrisFootprint/,
  );
  // Discovery keeps its own radius, and the two must not be the same call.
  assert.match(executionManager, /private static bool IsDebrisTargetWithinPlayerRadius/);
  assert.doesNotMatch(request, /if \(!IsDebrisTargetWithinPlayerRadius\(clump, Game1\.player\)\)/);
  const findTarget = executionManager.slice(
    executionManager.indexOf("private static StardewValley.TerrainFeatures.ResourceClump? FindDebrisTarget"),
    executionManager.indexOf("private static string BuildDebrisTargetId"),
  );
  assert.match(findTarget, /string\.Equals\(targetId, expectedTargetId, StringComparison\.Ordinal\)/);
  assert.doesNotMatch(findTarget, /Utility\.tileWithinRadiusOfPlayer/);
  assert.match(request, /float healthBefore = clump\.health\.Value/);
  assert.match(request, /health_before=\{healthBefore:0\.##\}/);
  assert.match(request, /health_after=\{healthAfter:0\.##\}/);
  assert.match(executionManager, /new BridgeDebrisTarget\([^\n]+, \(int\)clump\.health\.Value\)/);

  const runner = await readFile(
    new URL("./run-stardew-native-local-player-clear-debris-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /\["move_to_tile", "travel", "equip_tool", "clear_debris"\]/);
  assert.match(runner, /initialTarget\.health !== 8/);
  assert.match(runner, /target\.health !== expectedHealth/);
  // ONE clear_debris dispatch, not eight. A non-terminal `partially_succeeded` receipt left the Body Program node
  // bound-Running for ever (the router only projects Succeeded/Failed/Rejected/Cancelled), so the action owns the
  // swing loop and the caller names one request.
  assert.match(runner, /receipt\.state === "succeeded"/u);
  assert.match(runner, /receipt\.reasonCode === "debris_cleared"/u);
  // The transition, not the word: the runner explains the old behaviour in a comment, and a check that forbade the
  // word would forbid the explanation too. What must not exist is a receipt COMPARED against those states.
  assert.doesNotMatch(runner, /receipt\.state === "partially_succeeded"/u);
  assert.doesNotMatch(runner, /receipt\.reasonCode === "debris_hit"/u);
  assert.doesNotMatch(runner, /for \(let hit = 1; hit <= 8; hit \+= 1\)/u);
  assert.match(runner, /Number\(evidence\.swings\) >= 1/u);
  assert.match(runner, /evidence\.health_before === String\(expectedHealth\)/);
  assert.match(runner, /connectWithRetry\(config, 15_000\)/);
  assert.match(runner, /error\.code === "ENOENT"/);
  assert.match(
    runner,
    /const fixtureApproaches = \[\s*\{ x: 61, y: 17 \},\s*\{ x: 64, y: 17 \},\s*\{ x: 62, y: 19 \},\s*\]/,
  );
  assert.match(runner, /fixtureTargets\(snapshot\)\.length === 1/);
  assert.match(runner, /move_to_clear_debris_fixture_anchor/);
  assert.match(runner, /clear_debris_fixture_target_not_at_bounded_anchor/);
  assert.doesNotMatch(runner, /for \(let radius = 1; radius <= 12/);
  const helper = await readFile(new URL("./lib/stardew-native-local-player-fixture.mjs", import.meta.url), "utf8");
  assert.match(helper, /native_local_fixture_bundle_deploy_hash_mismatch/);
  assert.doesNotMatch(runner, /for \(let radius = 1; radius <= 12/);
  assert.match(runner, /freshPostcondition: \{ targetGone \}/);
  assert.match(runner, /waitForTerminal\(receipts, accepted, timeoutMs\)/);
  assert.match(runner, /executeFresh\(client, \{/);
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local pet-animal fixture establishes only an unpetted native Pet precondition", async (t) => {
  const options = { ...(await createFixture(t, "pet-animal")), action: "pet_animal" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, ["pet_animal"]);
  // `pet_animal` was promoted to LiveVerified (ebd75189), so it is no longer
  // eligible for the test-only rung: the fixture derives ExperimentalActions
  // from the Mod catalog and a promoted action must not linger there.
  assert.deepEqual(configured.ExperimentalActions, []);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_pet_animal_v1");

  const entry = await readFixtureSource();
  const setupStart = entry.indexOf("private void InitializeNativeLocalPetFixture");
  const setup = entry.slice(
    setupStart,
    entry.indexOf("private static Vector2? FindNativeLocalFarmFixtureTile", setupStart),
  );
  assert.match(setup, /player\.Items\[player\.CurrentToolIndex\] = null/);
  assert.match(setup, /fixture_native_local_pet_hands_not_empty/);
  assert.match(setup, /new\(\(int\)targetTile\.Value\.X, \(int\)targetTile\.Value\.Y, "0", "Dog"\)/);
  assert.match(setup, /pet\.grantedFriendshipForPet\.Value = false/);
  assert.match(setup, /pet\.friendshipTowardFarmer\.Value = 0/);
  assert.match(setup, /location\.addCharacter\(pet\)/);
  assert.doesNotMatch(setup, /RequestLocalPetAnimal|PublishReceipt/);

  const runner = await readFile(
    new URL("./run-stardew-native-local-player-pet-animal-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /\["cancel_active_execution", "inspect_self", "pet_animal"\]/);
  assert.match(runner, /target\.friendship !== 0 \|\| target\.pettedToday !== false/);
  assert.match(runner, /evidence\.friendship_before === "0"/);
  assert.match(runner, /evidence\.friendship_after === "12"/);
  assert.match(runner, /evidence\.day_recorded === "true"/);
  assert.match(runner, /evidence\.friendship_callback === "true"/);
  assert.match(runner, /targetGone/);
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local npc-relationship fixture establishes an unchanged persisted fact and native villager target", async (t) => {
  const options = { ...(await createFixture(t, "npc-relationship")), action: "npc_relationship" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, ["move_to_tile", "travel", "npc_relationship"]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_npc_relationship_v1");

  const entry = await readFixtureSource();
  const setupStart = entry.indexOf("private void InitializeNativeLocalNpcRelationshipFixture");
  const setup = entry.slice(setupStart, entry.indexOf("private void InitializeNativeLocalPetFixture", setupStart));
  assert.match(setup, /const string npcName = "Robin"/);
  assert.match(setup, /FindNativeLocalFarmFixtureTile\(farm, new Vector2\(farmWarp\.TargetX, farmWarp\.TargetY\), 6/);
  assert.match(setup, /relationship = new Friendship\(\)/);
  assert.match(setup, /relationship\.Clear\(\)/);
  assert.match(setup, /relationship\.Points = 250/);
  assert.match(setup, /Game1\.warpCharacter\(npc, farm, targetTile\.Value\)/);
  assert.match(
    setup,
    /actual\.Points != 250 \|\| actual\.TalkedToToday \|\| actual\.GiftsToday != 0 \|\| actual\.GiftsThisWeek != 0/,
  );
  assert.doesNotMatch(setup, /RequestLocalInspectNpcRelationship|PublishReceipt|friendshipData\.Remove/);
  const runner = await readFile(
    new URL("./run-stardew-native-local-player-npc-relationship-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    runner,
    /travelFreshHop\(\s*client,\s*receipts,\s*trace,\s*snapshot,\s*"FarmHouse",\s*"Farm",\s*"farmhouse_to_farm"/,
  );
  assert.match(runner, /chooseOnlyFreshFixtureTarget/);
  assert.match(runner, /target\.npcName !== "Robin" \|\|\s*target\.friendshipPoints !== 250/);
  assert.match(
    runner,
    /moveToLiveTarget\(\s*client,\s*receipts,\s*trace,\s*target,\s*"move_to_npc_relationship_fixture"/,
  );
  assert.match(
    runner,
    /accepted\.state !== "accepted" &&\s*!\(accepted\.state === "succeeded" && accepted\.reasonCode === "npc_relationship_inspected"\)/,
  );
  assert.match(runner, /nearestCardinalApproach\(snapshot\.tile, current\)/);
  assert.match(runner, /withinRadius\(snapshot\.tile, target, 6\)/);
  assert.doesNotMatch(runner, /travelToTown/);
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local interact-npc-with-item fixture establishes only an active delivery quest and one carried item", async (t) => {
  const options = { ...(await createFixture(t, "npc-relationship")), action: "interact_npc_with_item" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, ["move_to_tile", "travel", "interact_npc_with_item"]);
  // Promoted to LiveVerified in ebd75189 with `pet_animal`, so the test-only rung
  // is empty for this scenario as well.
  assert.deepEqual(configured.ExperimentalActions, []);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_interact_npc_with_item_v1");

  const entry = await readFixtureSource();
  const setupStart = entry.indexOf("private void InitializeNativeLocalInteractNpcWithItemFixture");
  const setup = entry.slice(
    setupStart,
    entry.indexOf("private void InitializeNativeLocalNpcRelationshipFixture", setupStart),
  );
  // The fixture establishes exactly the declared Given: a clean relationship,
  // one active native delivery quest, one carried target item, and a reachable
  // villager placement. It never invokes the interaction or completes the quest.
  assert.match(setup, /const string npcName = "Jodi"/);
  assert.match(setup, /const string targetItemId = "\(O\)190"/);
  assert.match(setup, /relationship\.Clear\(\)/);
  assert.match(setup, /new StardewValley\.Quests\.ItemDeliveryQuest\(npcName, targetItemId\)/);
  assert.match(setup, /player\.questLog\.Add\(quest\)/);
  assert.match(setup, /ItemRegistry\.Create<StardewValley\.Object>\(targetItemId, 1\)/);
  assert.match(setup, /Game1\.warpCharacter\(npc, farm, targetTile\.Value\)/);
  assert.doesNotMatch(
    setup,
    /RequestLocalInteractNpcWithItem|checkAction|questComplete|changeFriendship|PublishReceipt/,
  );

  const executions = await readExecutionManagerSources();
  // The executor must discriminate a quest delivery from an ordinary recorded
  // gift and expose both terminals plus the delivery bookkeeping.
  assert.match(executions, /"quest_item_delivered"/);
  assert.match(executions, /"gift_given"/);
  assert.match(executions, /completedQuestsBefore/);
  assert.match(executions, /"interact_npc_with_item"/);

  // The offer action itself must reproduce the native quest hook and keep the
  // delivery body windowless. `location.checkAction` is deliberately NOT the
  // route for this action: its non-probe branch mounts a DialogueBox
  // (ItemDeliveryQuest.cs:505-506) and can open shop menus, which a headless
  // companion can never close. The action instead settles the delivery from the
  // quest's own side-effect-free `probe: true` decision and reproduces the
  // non-probe mutations without either UI line.
  const actionStart = executions.indexOf("public LocalExecutionReceipt RequestLocalInteractNpcWithItem");
  assert.ok(actionStart >= 0, "the offer action must live in the execution-manager sources");
  const action = executions.slice(
    actionStart,
    executions.indexOf("private static string GiftEvidencePrefix", actionStart),
  );
  assert.match(action, /\.OnItemOfferedToNpc\(npc, offered, probe: true\)/);
  assert.match(action, /quest_item_delivered/);
  assert.match(action, /quest_quantity_mismatch/);
  assert.match(action, /quest_delivery_postcondition_unavailable/);
  assert.match(action, /gift_given/);
  assert.match(action, /Game1\.dialogueUp/);
  assert.doesNotMatch(action, /Game1\.(?:draw|Draw)Dialogue\(|createQuestionDialogue\(|new DialogueBox\(/);
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local chop-tree-source fixture establishes only the terminal-tree precondition", async (t) => {
  const options = { ...(await createFixture(t, "chop-tree-source")), action: "chop_tree_source" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, ["move_to_tile", "travel", "equip_tool", "chop_tree_source"]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_chop_tree_source_v1");
  const entry = await readFixtureSource();
  const setup = entry.slice(
    scenarioBranchAt(entry, "native_chop_tree_source_v1"),
    entry.indexOf('fixture.FixtureScenario == "native_use_item_v1"'),
  );
  assert.match(setup, /float fixtureHealth = 1f/);
  assert.match(setup, /tree\.health\.Value = fixtureHealth/);
  assert.doesNotMatch(setup, /DoFunction|RequestLocalChopTreeSource|performTreeFall|PublishReceipt/);
  const runner = await readFile(
    new URL("./run-stardew-native-local-player-chop-tree-source-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /\["move_to_tile", "travel", "equip_tool", "chop_tree_source"\]/);
  assert.match(runner, /treeChopSourceTargets/);
  assert.match(runner, /treeChopResultTargets/);
  assert.match(runner, /evidence\.health_before === "1"/);
  assert.match(runner, /evidence\.health_after === "5"/);
  assert.match(runner, /evidence\.stump_after === "true"/);
  assert.match(runner, /evidence\.source_transformed === "true"/);
  assert.match(runner, /reread\?\.health === 5/);
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local refill-watering-can fixture remains isolated and pre-action only", async (t) => {
  const options = { ...(await createFixture(t, "refill-watering-can")), action: "refill_watering_can" };
  const _prepared = await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, ["move_to_tile", "equip_tool", "refill_watering_can"]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_refill_watering_can_v1");
  const entry = await readFixtureSource();
  const setup = entry.slice(
    entry.indexOf('fixture.FixtureScenario == "native_refill_watering_can_v1"'),
    entry.indexOf('fixture.FixtureScenario != "native_water_crop_v1"'),
  );
  assert.ok(setup.includes("suppliedCan.WaterLeft = Math.Max(1, suppliedCan.waterCanMax - 1)"));
  assert.match(setup, /farmHouse\.map\.GetLayer\("Back"\)/);
  assert.match(setup, /Properties\["WaterSource"\] = "GameBuddyNativeLocalFixture"/);
  assert.match(setup, /farmHouse\.doesTileHaveProperty\(sourceTile\.X, sourceTile\.Y, "WaterSource", "Back"\)/);
  assert.match(setup, /farmHouse\.CanRefillWateringCanOnTile\(sourceTile\.X, sourceTile\.Y\)/);
  assert.doesNotMatch(
    setup,
    /DoFunction|RequestLocalRefillWateringCan|PublishReceipt|WaterLeft = suppliedCan.waterCanMax/,
  );
  const runner = await readFile(
    new URL("./run-stardew-native-local-player-refill-watering-can-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /["move_to_tile", "equip_tool", "refill_watering_can"]/);
  assert.ok(runner.includes("evidence.water_after === String(freshCan.max)"));
  assert.ok(runner.includes("reread?.water === freshCan.max"));
  assert.match(runner, /terminal\.executionId === accepted\.executionId/);
  assert.match(runner, /terminal\.requestId === accepted\.requestId/);
  assert.match(runner, /terminal\.state !== "succeeded" \|\| terminal\.reasonCode !== "target_reached"/);
  assert.match(runner, /evidence\.target !== `\$\{target\.x\},\$\{target\.y\}` \|\| evidence\.arrival !== "exact"/);
  assert.match(runner, /throw new Error\("move_evidence_mismatch"\)/);
  assert.match(runner, /phase: "move_terminal"/);
  const executionManager = await readExecutionManagerSources();
  const discoveryStart = executionManager.indexOf(
    "private static IReadOnlyList<BridgeRefillWateringCanTarget> DiscoverRefillWateringCanTargets",
  );
  const discovery = executionManager.slice(
    discoveryStart,
    executionManager.indexOf("BuildRefillWateringCanTargetId", discoveryStart),
  );
  // Every discovery radius is the one shared constant (674b4033 aligned them all
  // to `TargetDiscoveryRadius`); a literal `+ 1` window no longer exists.
  assert.match(discovery, /Math\.Min\(1000, player\.TilePoint\.Y \+ TargetDiscoveryRadius\)/);
  assert.match(discovery, /Math\.Max\(0, player\.TilePoint\.Y - TargetDiscoveryRadius\)/);
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local collect-animal-product fixture establishes only the approved pre-attachment state", async (t) => {
  const options = { ...(await createFixture(t, "collect-animal-product")), action: "collect_animal_product" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, ["collect_animal_product"]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_collect_animal_product_v1");

  const entry = await readFixtureSource();
  const setupStart = entry.indexOf('if (fixture.FixtureScenario == "native_collect_animal_product_v1")');
  const setup = entry.slice(
    setupStart,
    entry.indexOf('if (fixture.FixtureScenario == "native_refill_watering_can_v1")', setupStart),
  );
  assert.match(setup, /parseDebugInput\("SetupBigFarm", null\)/);
  assert.match(setup, /candidate\.Animal\.isAdult\(\) && candidate\.Animal\.currentProduce\.Value is not null/);
  assert.match(setup, /CanGetProduceWithTool\(new MilkPail\(\)\)/);
  assert.match(setup, /CanGetProduceWithTool\(new Shears\(\)\)/);
  assert.match(setup, /player\.addItemToInventory\(compatible\.Value\.Tool\)/);
  assert.match(setup, /player\.warpFarmer\(/);
  assert.match(setup, /NativeLocalCollectAnimalProductFixturePending/);
  assert.doesNotMatch(
    setup,
    /BeginUsingTool|DoFunction|RequestLocalCollectAnimalProduct|PublishReceipt|currentProduce\.Value =|addItemToInventory\(produce/,
  );
  const warpedStart = entry.indexOf("private void OnWarped");
  const warped = entry.slice(
    entry.indexOf("if (this.nativeLocalCollectAnimalProductFixturePending", warpedStart),
    entry.indexOf("if (this.nativeLocalFeedFixturePending", warpedStart),
  );
  assert.match(warped, /animal\.isAdult\(\) && animal\.currentProduce\.Value == productPending\.ProduceId/);
  assert.doesNotMatch(
    warped,
    /BeginUsingTool|DoFunction|RequestLocalCollectAnimalProduct|PublishReceipt|currentProduce\.Value\s*=(?!=)|addItemToInventory/,
  );

  const runner = await readFile(
    new URL("./run-stardew-native-local-player-collect-animal-product-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(
    runner,
    /const REQUIRED_CAPABILITIES = \["cancel_active_execution", "collect_animal_product", "inspect_self"\]/,
  );
  assert.match(runner, /assertRequiredCapabilities\(before, REQUIRED_CAPABILITIES\)/);
  assert.match(runner, /waitForTerminal\(receipts, accepted, terminalTimeoutMs\)/);
  assert.match(
    runner,
    /targets\.sort\(\(left, right\) => left\.y - right\.y \|\| left\.x - right\.x \|\| left\.targetId\.localeCompare\(right\.targetId\)\)/,
  );
  assert.match(runner, /evidence\.produce_cleared === "true"/);
  assert.match(runner, /evidence\.inventory_gained === "true"/);
  assert.match(runner, /evidence\.animation_complete === "true"/);
  assert.match(runner, /countQualifiedInventory\(before, target\.qualifiedProduceItemId\)/);
  assert.match(runner, /countQualifiedInventory\(after, target\.qualifiedProduceItemId\)/);
  assert.match(runner, /inventoryGainedFresh/);
  assert.match(runner, /inventoryItemFacts/);
  assert.match(runner, /targetGone/);
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local feed-animal fixture is isolated, pre-bridge only, and requires typed navigation evidence", async (t) => {
  const options = { ...(await createFixture(t, "feed-animal")), action: "feed_animal" };
  await prepareNativeLocalPlayerFixture(options);
  const configured = JSON.parse(await readFile(join(options.modRoot, "config.json"), "utf8"));
  assert.deepEqual(configured.EnabledActions, ["move_to_tile", "travel", "enter_exit", "feed_animal"]);
  assert.equal(configured.NativeLocalPlayerFixture.FixtureScenario, "native_feed_animal_v1");

  const entry = await readFixtureSource();
  const setupStart = entry.lastIndexOf('if (fixture.FixtureScenario == "native_feed_animal_v1")');
  const setup = entry.slice(
    setupStart,
    entry.indexOf('fixture.FixtureScenario == "native_refill_watering_can_v1"', setupStart),
  );
  assert.match(setup, /parseDebugInput\("SetupBigFarm", null\)/);
  assert.match(setup, /GetIndoors\(\) is StardewValley\.AnimalHouse/);
  assert.match(setup, /configuredBarns/);
  assert.match(setup, /building\.buildingType\.Value, "Deluxe Barn"/);
  assert.match(setup, /building\.tileX\.Value == 16/);
  assert.match(setup, /building\.tileY\.Value == 9/);
  assert.doesNotMatch(setup, /NameOrUniqueName, "Barn"/);
  assert.match(setup, /getPointForHumanDoor\(\)/);
  assert.match(setup, /getWarpFromDoor/);
  assert.match(setup, /emptyTroughs/);
  assert.match(setup, /standingCandidates/);
  assert.match(setup, /player\.warpFarmer\(/);
  assert.match(setup, /NativeLocalFeedFixturePending/);
  assert.match(entry, /fixture_native_feed_animal_trough_approach_unreachable/);
  assert.match(entry, /addItemToInventory\(ItemRegistry\.Create<StardewValley\.Object>\("\(O\)178", 2\)\)/);
  assert.doesNotMatch(setup, /RequestLocalFeedAnimal|PublishReceipt|hay_before|hay_after|objects\.Add|objects\[/);

  const runner = await readFile(
    new URL("./run-stardew-native-local-player-feed-animal-smoke.mjs", import.meta.url),
    "utf8",
  );
  assert.match(runner, /\["move_to_tile", "travel", "enter_exit", "feed_animal"\]/);
  assert.match(runner, /travel_to_farm/);
  assert.match(runner, /enter_animal_house/);
  assert.match(runner, /awaitSetupBigFarmFirstDeluxeBarnDoor/);
  assert.match(runner, /awaitActionableSnapshotAfterEnter/);
  assert.match(runner, /native_local_feed_animal_post_enter_not_actionable/);
  assert.match(runner, /const deadline = Date\.now\(\) \+ 5_000/);
  assert.match(runner, /await delay\(100\)/);
  assert.match(runner, /isSetupBigFarmFirstDeluxeBarnDoor/);
  assert.match(runner, /entry\.sourceX === 17/);
  assert.match(runner, /entry\.sourceY === 12/);
  assert.match(runner, /\^Barn3\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{12\}\$/);
  assert.doesNotMatch(runner, /entry\.targetLocation === "Barn"/);
  assert.match(runner, /moveAdjacentToDoor/);
  assert.match(runner, /move_to_animal_house_entry_\$\{candidate\.x\}_\$\{candidate\.y\}/);
  assert.match(runner, /accepted\.state === "rejected" && accepted\.reasonCode === "no_native_path"/);
  assert.match(runner, /no_native_path_to_animal_house_entry/);
  assert.match(runner, /chooseSingleFeedTarget/);
  assert.match(runner, /targets\.sort\(\(left, right\) => left\.y - right\.y \|\| left\.x - right\.x/);
  assert.match(runner, /no_live_empty_feed_trough_target/);
  assert.match(runner, /sameIdentity\(entry, accepted\)/);
  assert.match(runner, /evidence\.hay_after\) === target\.hayStack - 1/);
  assert.match(runner, /evidence\.trough_filled === "true"/);
  assert.match(runner, /targetGone/);
  assert.match(runner, /native_local_feed_animal_topology_invalid/);
  await restoreNativeLocalPlayerFixture(options);
});

test("native-local fixture topology refusal returns before scenario setup while valid topology remains allowed", async () => {
  const entry = await readFixtureSource();
  const methodStart = entry.indexOf("private void TryInitializeNativeLocalPlayerFixture()");
  const methodEnd = entry.indexOf("private void TryBootstrapNativeLocalPlayerFixture", methodStart);
  const method = entry.slice(methodStart, methodEnd);

  assert.notEqual(methodStart, -1);
  assert.notEqual(methodEnd, -1);
  assert.match(
    method,
    /if \(Context\.IsMultiplayer[\s\S]*?this\.nativeLocalPlayerFixtureTerminal = true;[\s\S]*?LogLevel\.Error\);\s*return;\s*}\s*this\.TryInitializeNativeLocalPlayerFixtureScenario\(fixture\);/,
  );
  assert.match(
    method,
    /}\s*this\.TryInitializeNativeLocalPlayerFixtureScenario\(fixture\);[\s\S]*?\/\/ The shared embodiment initializes only after the native load/,
  );
});

test("native-local fixture setup fails closed while any warp continuation is pending", async () => {
  const entry = await readFixtureSource();
  const methodStart = entry.indexOf("private void TryInitializeNativeLocalPlayerFixtureScenario");
  const method = entry.slice(methodStart);
  const guardStart = method.indexOf("if (this.nativeLocalFeedFixturePending is not null");
  const scenarioSetupStart = method.indexOf('if (fixture.FixtureScenario == "native_npc_relationship_v1")');

  assert.notEqual(methodStart, -1);
  assert.notEqual(guardStart, -1);
  assert.notEqual(scenarioSetupStart, -1);
  assert.ok(guardStart < scenarioSetupStart, "pending continuation guard must precede scenario setup");
  for (const pendingField of [
    "nativeLocalFeedFixturePending",
    "nativeLocalCollectAnimalProductFixturePending",
    "nativeLocalClearHoeDirtFixturePending",
    "nativeLocalDigArtifactSpotFixturePending",
  ]) {
    assert.match(method.slice(guardStart, scenarioSetupStart), new RegExp(`${pendingField} is not null`));
  }
});

test("native-local fixture restore fails closed when a registered backup is tampered", async (t) => {
  const options = { ...(await createFixture(t, "tampered-restore")), action: "chop_tree_source" };
  const prepared = await prepareNativeLocalPlayerFixture(options);
  const preparedConfig = await readFile(join(options.modRoot, "config.json"), "utf8");
  await writeFile(join(prepared.backup, "config.json.backup"), "tampered backup");

  await assert.rejects(restoreNativeLocalPlayerFixture(options), (error) =>
    assertRedactedPublicError(error, "native_local_fixture_restore_failed", [
      options.root,
      prepared.backup,
      "config.json",
      "tampered backup",
    ]),
  );
  assert.equal(await readFile(join(options.modRoot, "config.json"), "utf8"), preparedConfig);
  assert.equal(await readFile(join(prepared.backup, "config.json.backup"), "utf8"), "tampered backup");
  assert.ok(
    await readFile(join(options.root, ".stardew-native-local-player-fixture.lock", "transaction.json"), "utf8"),
  );
});

test("Navigation fixture launchers continue cleanup after restore failure", async () => {
  for (const filename of [
    "./run-stardew-native-local-player-navigation-mutation-fixture.ps1",
    "./run-stardew-native-local-player-navigation-read-only-fixture.ps1",
  ]) {
    const launcher = await readFile(new URL(filename, import.meta.url), "utf8");
    const restore = launcher.indexOf("restore-stardew-native-local-player-fixture.mjs");
    const cleanup = launcher.indexOf("-Cleanup", restore);
    assert.ok(restore >= 0 && cleanup > restore, `${filename} must retain save cleanup after restore`);
    assert.match(launcher, /\$cleanupFailure = \$null/);
    assert.match(launcher, /if \(\$null -eq \$cleanupFailure\) \{ \$cleanupFailure = \$_ \}/);
    assert.doesNotMatch(
      launcher,
      /if \(\$LASTEXITCODE -ne 0\) \{ throw[^\n]+\n\s*\}\n\s*\}\n\s*if \(\$workingSavePrepared\)/,
    );
    assert.match(launcher, /Join-Path \$ModsPath "GameBuddy\.Stardew\/config\.json"/);
    assert.doesNotMatch(launcher, /Join-Path \$ModsPath "GameBuddy\/config\.json"/);
  }
});
