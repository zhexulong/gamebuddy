import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  M8_STAGED_SAVE_FIXTURES,
  applyM8StagedSaveGiven,
  disposeM8StagedSaveFixture,
  prepareM8StagedSaveFixture,
  verifyM8CanonicalSaveUnchanged,
  verifyM8StagedSaveFixtureReady,
} from "./stardew-portfolio-staged-save-fixture.mjs";

async function context(t, { level = 0, order = -1, missingOld = false, permanent = "<mine_permanentMineChanges />" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-m8-stage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const saveRoot = join(root, "Saves");
  const slot = "GameBuddyPortfolioNative02_445880081";
  const canonical = join(saveRoot, slot);
  await mkdir(canonical, { recursive: true });
  const save = sampleSave({ level, order, permanent });
  await writeFile(join(canonical, slot), save);
  await writeFile(join(canonical, "SaveGameInfo"), "info\n");
  if (!missingOld) {
    await writeFile(join(canonical, `${slot}_old`), save);
    await writeFile(join(canonical, "SaveGameInfo_old"), "info-old\n");
  }
  return { root, saveRoot, slot, canonical };
}
function sampleSave({ level, order, permanent }) {
  return `\ufeff<?xml version="1.0" encoding="utf-8"?><SaveGame xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><uniqueIDForThisGame>445880081</uniqueIDForThisGame>${permanent}<mine_lowestLevelReached>${level}</mine_lowestLevelReached><mine_lowestLevelReachedForOrder>${order}</mine_lowestLevelReachedForOrder></SaveGame>`;
}
async function prepare(t, setup = {}) {
  const c = await context(t, setup);
  const declaration = M8_STAGED_SAVE_FIXTURES.m8_elevator_floor_5_given_v1;
  const staged = await prepareM8StagedSaveFixture({
    canonicalSlotDirectory: c.canonical,
    saveRoot: c.saveRoot,
    declaration,
    transactionId: "fixture-1",
  });
  return { ...c, declaration, staged };
}

test("prepares a current-Saves staged copy, renames normal _old files, keeps canonical immutable, and disposes only its owned root", async (t) => {
  const { canonical, saveRoot, declaration, staged } = await prepare(t);
  assert.equal(staged.stagedSlotDirectory, join(saveRoot, staged.stagedSlotName));
  assert.match(staged.stagedSlotName, /^GameBuddyPortfolio.*_445880081$/);
  assert.equal(await readFile(join(staged.stagedSlotDirectory, "SaveGameInfo"), "utf8"), "info\n");
  await readFile(join(staged.stagedSlotDirectory, `${staged.stagedSlotName}_old`));
  await readFile(join(staged.stagedSlotDirectory, "SaveGameInfo_old"));
  await verifyM8CanonicalSaveUnchanged({ canonicalSlotDirectory: canonical, expectedManifestSha256: staged.canonicalManifestSha256 });
  await disposeM8StagedSaveFixture({ stagedSlotDirectory: staged.stagedSlotDirectory, transactionId: "fixture-1" });
  await assert.rejects(() => readFile(staged.stagedSlotDirectory), /ENOENT|EISDIR/);
  await verifyM8CanonicalSaveUnchanged({ canonicalSlotDirectory: canonical, expectedManifestSha256: staged.canonicalManifestSha256 });
  const second = await prepareM8StagedSaveFixture({
    canonicalSlotDirectory: canonical,
    saveRoot,
    declaration,
    transactionId: "fixture-2",
  });
  await disposeM8StagedSaveFixture({ stagedSlotDirectory: second.stagedSlotDirectory, transactionId: "fixture-2" });
});

test("rejects a non-Saves staging root, missing normal backup variants, and duplicate stage ownership", async (t) => {
  const c = await context(t);
  const declaration = M8_STAGED_SAVE_FIXTURES.m8_elevator_floor_5_given_v1;
  await assert.rejects(
    () => prepareM8StagedSaveFixture({ canonicalSlotDirectory: c.canonical, saveRoot: join(c.root, "elsewhere"), declaration, transactionId: "fixture-1" }),
    /save_root|canonical_not_in_save_root/i,
  );
  const incomplete = await context(t, { missingOld: true });
  await assert.rejects(
    () => prepareM8StagedSaveFixture({ canonicalSlotDirectory: incomplete.canonical, saveRoot: incomplete.saveRoot, declaration, transactionId: "fixture-1" }),
    /required_save_file_missing/i,
  );
  const value = await prepare(t);
  await assert.rejects(
    () => prepareM8StagedSaveFixture({ canonicalSlotDirectory: value.canonical, saveRoot: value.saveRoot, declaration, transactionId: "fixture-1" }),
    /already_exists/i,
  );
});

test("elevator closed fixture patches only staged current main XML and preserves both canonical variants", async (t) => {
  const { canonical, declaration, staged } = await prepare(t, { level: 0 });
  const result = await applyM8StagedSaveGiven({ stagedSlotDirectory: staged.stagedSlotDirectory, declaration });
  assert.deepEqual(result.changedPaths, [staged.stagedSlotName]);
  assert.deepEqual(result.allowedXmlTextChanges, ["mine_lowestLevelReached"]);
  const ready = await verifyM8StagedSaveFixtureReady({ stagedSlotDirectory: staged.stagedSlotDirectory, transactionId: "fixture-1" });
  assert.equal(ready.stagedSlotName, staged.stagedSlotName);
  const stagedSave = await readFile(join(staged.stagedSlotDirectory, staged.stagedSlotName), "utf8");
  assert.match(stagedSave, /<mine_lowestLevelReached>10<\/mine_lowestLevelReached>/);
  assert.match(stagedSave, /<mine_lowestLevelReachedForOrder>-1<\/mine_lowestLevelReachedForOrder>/);
  assert.match(stagedSave, /^\ufeff<\?xml/);
  await assert.rejects(() => applyM8StagedSaveGiven({ stagedSlotDirectory: staged.stagedSlotDirectory, declaration }), /baseline|no_change/i);
  await verifyM8CanonicalSaveUnchanged({ canonicalSlotDirectory: canonical, expectedManifestSha256: staged.canonicalManifestSha256 });
});

test("ladder closed fixture patches only staged Mine progress to the first native-generation-eligible floor", async (t) => {
  const c = await context(t, { level: 0 });
  const declaration = M8_STAGED_SAVE_FIXTURES.m8_ladder_given_v1;
  const staged = await prepareM8StagedSaveFixture({
    canonicalSlotDirectory: c.canonical,
    saveRoot: c.saveRoot,
    declaration,
    transactionId: "ladder-1",
  });
  const result = await applyM8StagedSaveGiven({ stagedSlotDirectory: staged.stagedSlotDirectory, declaration });
  assert.deepEqual(result.allowedXmlTextChanges, ["mine_lowestLevelReached"]);
  const stagedSave = await readFile(join(staged.stagedSlotDirectory, staged.stagedSlotName), "utf8");
  assert.match(stagedSave, /<mine_lowestLevelReached>2<\/mine_lowestLevelReached>/);
  assert.match(stagedSave, /<mine_lowestLevelReachedForOrder>-1<\/mine_lowestLevelReachedForOrder>/);
  await verifyM8CanonicalSaveUnchanged({ canonicalSlotDirectory: c.canonical, expectedManifestSha256: staged.canonicalManifestSha256 });
});

test("fixture declarations contain no player pose, facility, ladder, or XML-selector authority", () => {
  assert.equal(M8_STAGED_SAVE_FIXTURES.m8_ladder_given_v1.allowedGiven.mine.lowestMineLevel, 2);
  assert.equal(M8_STAGED_SAVE_FIXTURES.m8_elevator_floor_5_given_v1.allowedGiven.mine.lowestMineLevel, 10);
  for (const declaration of Object.values(M8_STAGED_SAVE_FIXTURES)) {
    assert.deepEqual(Object.keys(declaration.allowedGiven), ["mine"]);
    assert.deepEqual(Object.keys(declaration.allowedGiven.mine).sort(), ["lowestMineLevel", "lowestMineLevelForOrder"]);
    assert.equal(JSON.stringify(declaration.allowedGiven).match(/position|location|tile|ladder|elevator|xpath|selector/i), null);
  }
});

test("fixture rejects any staged baseline drift before applying its sole owned XML change", async (t) => {
  const { declaration, staged } = await prepare(t, { level: 0 });
  await writeFile(join(staged.stagedSlotDirectory, "SaveGameInfo"), "tampered\n");
  await assert.rejects(
    () => applyM8StagedSaveGiven({ stagedSlotDirectory: staged.stagedSlotDirectory, declaration }),
    /baseline_changed/,
  );
});

test("fixture rechecks canonical integrity before applying a staged XML change", async (t) => {
  const { canonical, declaration, staged } = await prepare(t, { level: 0 });
  await writeFile(join(canonical, "SaveGameInfo"), "tampered\n");
  await assert.rejects(
    () => applyM8StagedSaveGiven({ stagedSlotDirectory: staged.stagedSlotDirectory, declaration }),
    /canonical_changed/,
  );
  const stagedSave = await readFile(join(staged.stagedSlotDirectory, staged.stagedSlotName), "utf8");
  assert.match(stagedSave, /<mine_lowestLevelReached>0<\/mine_lowestLevelReached>/);
});

test("closed patch rejects bad Mine serialization and cannot dispose a foreign transaction", async (t) => {
  for (const setup of [
    { level: 0, order: 0 },
    { level: 11 },
    { permanent: '<mine_permanentMineChanges xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:nil="true" />' },
  ]) {
    const value = await prepare(t, setup);
    await assert.rejects(() => applyM8StagedSaveGiven({ stagedSlotDirectory: value.staged.stagedSlotDirectory, declaration: value.declaration }), /m8_stage_/);
  }
  const value = await prepare(t);
  await assert.rejects(() => disposeM8StagedSaveFixture({ stagedSlotDirectory: value.staged.stagedSlotDirectory, transactionId: "someone-else" }), /owner/i);
  await readFile(join(value.staged.stagedSlotDirectory, "SaveGameInfo"));
});

test("patched staged drift fails readiness and disposal cannot delete a foreign stage", async (t) => {
  const { declaration, staged } = await prepare(t, { level: 0 });
  await applyM8StagedSaveGiven({ stagedSlotDirectory: staged.stagedSlotDirectory, declaration });
  await writeFile(join(staged.stagedSlotDirectory, "SaveGameInfo"), "tampered\n");
  await assert.rejects(
    () => verifyM8StagedSaveFixtureReady({ stagedSlotDirectory: staged.stagedSlotDirectory, transactionId: "fixture-1" }),
    /patched_manifest_changed/,
  );
  await assert.rejects(
    () => disposeM8StagedSaveFixture({ stagedSlotDirectory: staged.stagedSlotDirectory, transactionId: "someone-else" }),
    /owner/i,
  );
  await readFile(join(staged.stagedSlotDirectory, "SaveGameInfo"));
});

test("canonical drift fails closed and never permits cleanup to overwrite it", async (t) => {
  const { canonical, staged } = await prepare(t);
  await writeFile(join(canonical, "SaveGameInfo"), "tampered\n");
  await assert.rejects(() => verifyM8CanonicalSaveUnchanged({ canonicalSlotDirectory: canonical, expectedManifestSha256: staged.canonicalManifestSha256 }), /canonical_changed/);
  await assert.rejects(() => disposeM8StagedSaveFixture({ stagedSlotDirectory: staged.stagedSlotDirectory, transactionId: "fixture-1" }), /canonical_changed/);
  await readFile(join(staged.stagedSlotDirectory, "SaveGameInfo"));
});
