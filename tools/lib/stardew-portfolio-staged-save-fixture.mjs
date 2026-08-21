import { createHash } from "node:crypto";
import { cp, lstat, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

const JOURNAL_FILE = ".gamebuddy-m8-staged-save-transaction.json";
const TARGET_VERSION = "1.6.15.24356";
const TARGET_ASSEMBLY_SHA256 = "7f1e5b8e58d2758b78570ba771bbeb03d33522f62188bf6c32edf0cf626deaee";
const SHA256 = /^[a-f0-9]{64}$/;
const SLOT_NAME = /^GameBuddyPortfolio[A-Za-z0-9_-]{1,128}_[0-9]{1,32}$/;
const TRANSACTION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAVE_ROOT_FILES = Object.freeze(["SaveGameInfo", "SaveGameInfo_old"]);

export const M8_STAGED_SAVE_FIXTURES = Object.freeze({
  m8_ladder_given_v1: Object.freeze({
    fixtureId: "m8_ladder_given_v1",
    actionId: "use_mine_ladder",
    target: Object.freeze({ gameVersion: TARGET_VERSION, assemblySha256: TARGET_ASSEMBLY_SHA256 }),
    stagedSlotSuffix: "M8Ladder",
    // Floor 2 is the first ordinary floor eligible for the target version's
    // initial native ladder-generation branch. Generation, not serialized
    // setup, must still produce facility tile 173.
    allowedGiven: Object.freeze({ mine: Object.freeze({ lowestMineLevel: 2, lowestMineLevelForOrder: -1 }) }),
  }),
  m8_elevator_floor_5_given_v1: Object.freeze({
    fixtureId: "m8_elevator_floor_5_given_v1",
    actionId: "select_mine_elevator_floor",
    target: Object.freeze({ gameVersion: TARGET_VERSION, assemblySha256: TARGET_ASSEMBLY_SHA256 }),
    stagedSlotSuffix: "M8Elevator",
    // The fixture still observes the normal floor-five elevator, but the
    // staged progress must unlock one distinct target checkpoint. The native
    // action retains its own fresh finite/unlocked/non-current validation.
    allowedGiven: Object.freeze({ mine: Object.freeze({ lowestMineLevel: 10, lowestMineLevelForOrder: -1 }) }),
  }),
});

/**
 * Create a unique staged root inside the real Stardew Saves directory. The
 * staged root is deliberately not a profile/data-root artifact: SaveGame.Load
 * resolves a physical slot by basename below Constants.SavesPath. The journal
 * lives in the staged root so no unrelated root is ever locked or deleted.
 */
export async function prepareM8StagedSaveFixture(input) {
  const request = validatePrepareInput(input);
  await assertSafeExistingDirectory(request.canonicalSlotDirectory, "m8_stage_canonical_slot");
  await assertSafeExistingDirectory(request.saveRoot, "m8_stage_save_root");
  assertCanonicalIsDirectChild(request.canonicalSlotDirectory, request.saveRoot);
  const canonical = await buildManifest(request.canonicalSlotDirectory);
  const canonicalSlotName = basename(request.canonicalSlotDirectory);
  assertSlotShape(canonicalSlotName);
  assertRequiredSlotFiles(canonical.files, canonicalSlotName);

  const stageName = stageSlotName(canonicalSlotName, request.declaration.stagedSlotSuffix, request.transactionId);
  const stagedSlotDirectory = join(request.saveRoot, stageName);
  if (await pathExists(stagedSlotDirectory)) throw new Error("m8_stage_root_already_exists");

  await cp(request.canonicalSlotDirectory, stagedSlotDirectory, { recursive: true, errorOnExist: true, force: false });
  try {
    await renameStagedSlotFiles(stagedSlotDirectory, canonicalSlotName, stageName);
    const stagedFiles = await buildManifest(stagedSlotDirectory);
    assertRequiredSlotFiles(stagedFiles.files, stageName);
    const stagedBaseline = payloadManifest(stagedFiles);
    const stagedSaveName = readSaveName(await readFile(join(stagedSlotDirectory, stageName), "utf8"));
    const journal = Object.freeze({
      version: 1,
      kind: "m8_staged_save_fixture",
      transactionId: request.transactionId,
      fixtureId: request.declaration.fixtureId,
      actionId: request.declaration.actionId,
      canonicalSlotDirectory: request.canonicalSlotDirectory,
      canonicalManifestSha256: canonical.digest,
      stagedSlotDirectory,
      stagedSlotName: stageName,
      stagedSaveName,
      stagedBaselineManifestSha256: stagedBaseline.digest,
      createdAtUnixMs: Date.now(),
    });
    await writeExclusiveJson(join(stagedSlotDirectory, JOURNAL_FILE), journal, "m8_stage_transaction_locked");
    await verifyM8CanonicalSaveUnchanged({
      canonicalSlotDirectory: request.canonicalSlotDirectory,
      expectedManifestSha256: canonical.digest,
    });
    return Object.freeze({
      stagedSlotDirectory,
      stagedSlotName: stageName,
      stagedSaveName,
      canonicalManifestSha256: canonical.digest,
      stagedBaselineManifestSha256: stagedBaseline.digest,
    });
  } catch (error) {
    // If copy happened but ownership could not be journaled, do not guess that
    // cleanup is safe. Preserve it for inspection and fail closed.
    throw error;
  }
}

export async function applyM8StagedSaveGiven(input) {
  const stagedSlotDirectory = absoluteDirectory(input?.stagedSlotDirectory, "m8_stage_directory_invalid");
  const declaration = validateDeclaration(input?.declaration);
  const journal = await readJournalForStage(stagedSlotDirectory);
  if (journal.fixtureId !== declaration.fixtureId || journal.actionId !== declaration.actionId)
    throw new Error("m8_stage_fixture_owner_mismatch");
  await assertSafeExistingDirectory(stagedSlotDirectory, "m8_stage_directory");
  const slotName = basename(stagedSlotDirectory);
  assertSlotShape(slotName);
  const stagedFiles = await buildManifest(stagedSlotDirectory);
  assertRequiredSlotFiles(stagedFiles.files, slotName);
  const before = payloadManifest(stagedFiles);
  if (before.digest !== journal.stagedBaselineManifestSha256) throw new Error("m8_stage_baseline_changed");
  const main = join(stagedSlotDirectory, slotName);
  const original = await readFile(main, "utf8");
  const changed = patchClosedFixtureXml(original, declaration, slotName);
  if (changed === original) throw new Error("m8_stage_fixture_no_change");
  await writeFile(main, changed, "utf8");
  try {
    const after = payloadManifest(await buildManifest(stagedSlotDirectory));
    assertOnlyMainXmlTextChanged(before, after, slotName);
    patchClosedFixtureXml(changed, declaration, slotName, { requireTarget: true });
    await writeJournalPatchManifest(stagedSlotDirectory, journal, after.digest);
    await verifyM8CanonicalSaveUnchanged({
      canonicalSlotDirectory: journal.canonicalSlotDirectory,
      expectedManifestSha256: journal.canonicalManifestSha256,
    });
    return Object.freeze({ changedPaths: Object.freeze([slotName]), allowedXmlTextChanges: Object.freeze(["mine_lowestLevelReached"]) });
  } catch (error) {
    await writeFile(main, original, "utf8");
    throw error;
  }
}

export async function verifyM8StagedSaveFixtureReady(input) {
  const stagedSlotDirectory = absoluteDirectory(input?.stagedSlotDirectory, "m8_stage_directory_invalid");
  const transactionId = input?.transactionId;
  if (typeof transactionId !== "string" || !TRANSACTION_ID.test(transactionId)) throw new Error("m8_stage_transaction_id_invalid");
  const journal = await readJournalForStage(stagedSlotDirectory);
  if (journal.transactionId !== transactionId) throw new Error("m8_stage_transaction_owner_mismatch");
  if (typeof journal.stagedPatchedManifestSha256 !== "string" || !SHA256.test(journal.stagedPatchedManifestSha256))
    throw new Error("m8_stage_patch_not_applied");
  const manifest = payloadManifest(await buildManifest(stagedSlotDirectory));
  if (manifest.digest !== journal.stagedPatchedManifestSha256) throw new Error("m8_stage_patched_manifest_changed");
  await verifyM8CanonicalSaveUnchanged({
    canonicalSlotDirectory: journal.canonicalSlotDirectory,
    expectedManifestSha256: journal.canonicalManifestSha256,
  });
  return Object.freeze({ stagedSlotName: journal.stagedSlotName, stagedSaveName: journal.stagedSaveName, fixtureId: journal.fixtureId, actionId: journal.actionId });
}

export async function verifyM8CanonicalSaveUnchanged(input) {
  const directory = absoluteDirectory(input?.canonicalSlotDirectory, "m8_stage_canonical_slot_invalid");
  if (typeof input?.expectedManifestSha256 !== "string" || !SHA256.test(input.expectedManifestSha256))
    throw new Error("m8_stage_canonical_manifest_invalid");
  await assertSafeExistingDirectory(directory, "m8_stage_canonical_slot");
  const manifest = await buildManifest(directory);
  if (manifest.digest !== input.expectedManifestSha256) throw new Error("m8_stage_canonical_changed");
}

export async function disposeM8StagedSaveFixture(input) {
  const stagedSlotDirectory = absoluteDirectory(input?.stagedSlotDirectory, "m8_stage_directory_invalid");
  const transactionId = input?.transactionId;
  if (typeof transactionId !== "string" || !TRANSACTION_ID.test(transactionId)) throw new Error("m8_stage_transaction_id_invalid");
  const journal = await readJournalForStage(stagedSlotDirectory);
  if (journal.transactionId !== transactionId) throw new Error("m8_stage_transaction_owner_mismatch");
  await assertSafeExistingDirectory(stagedSlotDirectory, "m8_stage_directory");
  await verifyM8CanonicalSaveUnchanged({
    canonicalSlotDirectory: journal.canonicalSlotDirectory,
    expectedManifestSha256: journal.canonicalManifestSha256,
  });
  await rm(stagedSlotDirectory, { recursive: true, force: false, maxRetries: 0 });
}

function validatePrepareInput(input) {
  const canonicalSlotDirectory = absoluteDirectory(input?.canonicalSlotDirectory, "m8_stage_canonical_slot_invalid");
  const saveRoot = absoluteDirectory(input?.saveRoot, "m8_stage_save_root_invalid");
  const declaration = validateDeclaration(input?.declaration);
  const transactionId = input?.transactionId;
  if (typeof transactionId !== "string" || !TRANSACTION_ID.test(transactionId)) throw new Error("m8_stage_transaction_id_invalid");
  return Object.freeze({ canonicalSlotDirectory, saveRoot, declaration, transactionId });
}
function validateDeclaration(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("m8_stage_fixture_invalid");
  const registered = M8_STAGED_SAVE_FIXTURES[value.fixtureId];
  if (!registered || (registered !== value && JSON.stringify(registered) !== JSON.stringify(value)))
    throw new Error("m8_stage_fixture_invalid");
  return registered;
}
function stageSlotName(canonicalSlotName, suffix, transactionId) {
  const separator = canonicalSlotName.lastIndexOf("_");
  const stageName = `${canonicalSlotName.slice(0, separator)}_${suffix}_${transactionId}${canonicalSlotName.slice(separator)}`;
  assertSlotShape(stageName);
  return stageName;
}
function patchClosedFixtureXml(xml, declaration, slotName, options = {}) {
  const leadingBom = xml.startsWith("\ufeff") ? "\ufeff" : "";
  const withoutBom = leadingBom ? xml.slice(1) : xml;
  if (!withoutBom.startsWith("<?xml")) throw new Error("m8_stage_save_xml_invalid");
  if (!/^<SaveGame(?:\s[^>]*)?>/.test(withoutBom.replace(/^<\?xml[^>]*>\s*/, ""))) throw new Error("m8_stage_save_root_invalid");
  const rootId = readSingleText(withoutBom, "uniqueIDForThisGame");
  const suffix = slotName.slice(slotName.lastIndexOf("_") + 1);
  if (rootId !== suffix) throw new Error("m8_stage_save_slot_identity_mismatch");
  const permanent = singleElement(withoutBom, "mine_permanentMineChanges");
  if (/xsi:nil\s*=\s*["']true["']/.test(permanent)) throw new Error("m8_stage_mine_changes_invalid");
  const order = readSingleText(withoutBom, "mine_lowestLevelReachedForOrder");
  if (order !== "-1") throw new Error("m8_stage_lowest_mine_level_for_order_invalid");
  const current = readSingleText(withoutBom, "mine_lowestLevelReached");
  if (!/^(?:0|1|2|3|4|5|6|7|8|9|10)$/.test(current)) throw new Error("m8_stage_lowest_mine_level_invalid");
  const target = String(declaration.allowedGiven.mine.lowestMineLevel);
  if (options.requireTarget) {
    if (current !== target) throw new Error("m8_stage_fixture_target_invalid");
    return xml;
  }
  if (current === target) throw new Error("m8_stage_fixture_baseline_invalid");
  return `${leadingBom}${withoutBom.replace(singleElement(withoutBom, "mine_lowestLevelReached"), (element) => element.replace(current, target))}`;
}
function readSaveName(xml) {
  const leadingBom = xml.startsWith("\ufeff") ? "\ufeff" : "";
  const withoutBom = leadingBom ? xml.slice(1) : xml;
  if (!withoutBom.startsWith("<?xml") || !/^<SaveGame(?:\s[^>]*)?>/.test(withoutBom.replace(/^<\?xml[^>]*>\s*/, "")))
    throw new Error("m8_stage_save_xml_invalid");
  const matches = [...withoutBom.matchAll(/<farmName>([^<]+)<\/farmName>/g)];
  // Legacy/minimal unit fixtures need not contain a Farmer payload. Actual
  // staged saves must carry exactly one logical save name; the launcher then
  // uses it rather than the physical directory name for native-load identity.
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new Error("m8_stage_farmName_invalid");
  const name = matches[0][1];
  if (!/^[A-Za-z0-9 _-]{1,64}$/.test(name)) throw new Error("m8_stage_save_name_invalid");
  return name;
}
function readSingleText(xml, name) {
  const element = singleElement(xml, name);
  const match = new RegExp(`^<${name}>([^<>]*)</${name}>$`).exec(element);
  if (!match) throw new Error(`m8_stage_${name}_invalid`);
  return match[1];
}
function singleElement(xml, name) {
  const paired = new RegExp(`<${name}>([^<>]*)</${name}>`, "g");
  const empty = new RegExp(`<${name}\\s*/>`, "g");
  const matches = [...(xml.match(paired) ?? []), ...(xml.match(empty) ?? [])];
  if (matches.length !== 1) throw new Error(`m8_stage_${name}_invalid`);
  return matches[0];
}
async function renameStagedSlotFiles(directory, oldName, newName) {
  for (const source of [oldName, `${oldName}_old`]) {
    const destination = source === oldName ? newName : `${newName}_old`;
    const oldPath = join(directory, source);
    const newPath = join(directory, destination);
    if (!(await pathExists(oldPath)) || (await pathExists(newPath))) throw new Error("m8_stage_main_save_invalid");
    await rename(oldPath, newPath);
  }
}
function assertOnlyMainXmlTextChanged(before, after, slotName) {
  const names = new Set([...before.files.map((entry) => entry.relativePath), ...after.files.map((entry) => entry.relativePath)]);
  for (const name of names) {
    const first = before.files.find((entry) => entry.relativePath === name);
    const second = after.files.find((entry) => entry.relativePath === name);
    if (!first || !second || first.sha256 !== second.sha256) {
      if (name !== slotName) throw new Error("m8_stage_fixture_changed_unowned_file");
    }
  }
}
async function buildManifest(root) {
  const files = [];
  async function visit(current, prefix) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(current, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const info = await lstat(path);
      if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error("m8_stage_reparse_or_special_path");
      if (info.isDirectory()) await visit(path, relativePath);
      else files.push(Object.freeze({ relativePath, sha256: sha256(await readFile(path)) }));
    }
  }
  await visit(root, "");
  return manifestFromFiles(files);
}
function payloadManifest(manifest) {
  return manifestFromFiles(manifest.files.filter((entry) => entry.relativePath !== JOURNAL_FILE));
}
function manifestFromFiles(files) {
  const frozenFiles = Object.freeze([...files]);
  const canonical = frozenFiles.map((entry) => `${entry.relativePath}\n${entry.sha256}\n`).join("");
  return Object.freeze({ files: frozenFiles, digest: sha256(canonical) });
}
function assertRequiredSlotFiles(files, slotName) {
  const names = new Set(files.map((entry) => entry.relativePath));
  // _old is the normal target-version fallback. The temporary fallback must
  // never be present in an input or staged slot, because it would make loader
  // recovery a hidden third save authority.
  if (
    files.some(
      (entry) =>
        entry.relativePath.endsWith("_STARDEWVALLEYSAVETMP") ||
        (entry.relativePath.endsWith("_old") &&
          entry.relativePath !== `${slotName}_old` &&
          entry.relativePath !== "SaveGameInfo_old"),
    )
  )
    throw new Error("m8_stage_fallback_save_file_invalid");
  const expected = new Set([slotName, `${slotName}_old`, ...SAVE_ROOT_FILES, JOURNAL_FILE]);
  // Canonical roots have no journal. A staged root always has precisely one.
  const hasJournal = names.has(JOURNAL_FILE);
  const required = hasJournal ? expected : new Set([slotName, `${slotName}_old`, ...SAVE_ROOT_FILES]);
  if ([...required].some((name) => !names.has(name))) throw new Error("m8_stage_required_save_file_missing");
  if (files.some((entry) => entry.relativePath.includes("/") || !required.has(entry.relativePath)))
    throw new Error("m8_stage_unknown_save_file");
}
function assertCanonicalIsDirectChild(slot, root) {
  if (resolve(slot, "..") !== resolve(root)) throw new Error("m8_stage_canonical_not_in_save_root");
}
function assertSlotShape(name) { if (!SLOT_NAME.test(name)) throw new Error("m8_stage_slot_name_invalid"); }
async function assertSafeExistingDirectory(path, code) {
  const info = await lstat(path).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`${code}_invalid`);
  if (await hasReparsePathComponent(path)) throw new Error("m8_stage_reparse_or_special_path");
}
async function hasReparsePathComponent(path) {
  let current = resolve(path);
  while (true) {
    const info = await lstat(current).catch((error) => (error?.code === "ENOENT" ? null : Promise.reject(error)));
    if (info?.isSymbolicLink()) return true;
    const parent = resolve(current, "..");
    if (parent === current) return false;
    current = parent;
  }
}
function absoluteDirectory(value, code) { if (typeof value !== "string" || !isAbsolute(value)) throw new Error(code); return resolve(value); }
async function writeJournalPatchManifest(stagedSlotDirectory, journal, stagedPatchedManifestSha256) {
  const path = join(stagedSlotDirectory, JOURNAL_FILE);
  const updated = Object.freeze({ ...journal, stagedPatchedManifestSha256 });
  await writeFile(path, `${JSON.stringify(updated)}\n`, { encoding: "utf8", flag: "w" });
}
async function readJournalForStage(stagedSlotDirectory) {
  const journal = await readJson(join(stagedSlotDirectory, JOURNAL_FILE), "m8_stage_transaction_journal_invalid");
  if (journal?.version !== 1 || journal?.kind !== "m8_staged_save_fixture" || journal.stagedSlotDirectory !== stagedSlotDirectory)
    throw new Error("m8_stage_transaction_owner_mismatch");
  return journal;
}
async function readJson(path, code) { try { return JSON.parse(await readFile(path, "utf8")); } catch { throw new Error(code); } }
async function writeExclusiveJson(path, value, code) {
  try { await writeFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx" }); }
  catch (error) { if (error?.code === "EEXIST") throw new Error(code); throw error; }
}
async function pathExists(path) { try { await stat(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } }
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
