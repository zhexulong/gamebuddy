#!/usr/bin/env node
/**
 * Freeze one native-created ordinary Stardew save as the only accepted source
 * for the P4 read-only WorldMap runtime probe. This tool never changes the
 * source template or starts Stardew; the probe runner later copies this root
 * into a private APPDATA transaction.
 */
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const _SHA256 = /^[a-f0-9]{64}$/;
const saveNamePattern = /^GameBuddyFixture[A-Za-z0-9]{0,64}_[0-9]{1,32}$/;
const required = (value, error) => {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(error);
  return resolve(value);
};
const inside = (root, path) => {
  const value = relative(root, path);
  return value && value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function assertRegular(path, io) {
  const entry = await io.lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("p4_fixture_source_entry_not_regular");
}

async function assertSourceIsNotCurrentSave(source, saveDirectoryName) {
  const appData = process.env.APPDATA;
  if (!appData) return;
  const activeSlot = resolve(appData, "StardewValley", "Saves", saveDirectoryName);
  if (resolve(source).toLowerCase() === activeSlot.toLowerCase())
    throw new Error("p4_fixture_source_must_not_be_current_active_save_slot");
}

export async function createNavigationP4Fixture({
  sourceSavePath,
  fixtureRoot,
  io = { cp, lstat, mkdir, readFile, readdir, rm, writeFile },
}) {
  const source = required(sourceSavePath, "p4_fixture_source_save_missing_or_relative");
  const destination = required(fixtureRoot, "p4_fixture_root_missing_or_relative");
  const saveDirectoryName = basename(source);
  if (!saveNamePattern.test(saveDirectoryName)) throw new Error("p4_fixture_source_save_name_invalid");
  await assertSourceIsNotCurrentSave(source, saveDirectoryName);
  if (inside(source, destination) || inside(destination, source))
    throw new Error("p4_fixture_source_and_destination_overlap");
  const sourceStat = await io.lstat(source);
  const names = (await io.readdir(source)).sort();
  const requiredNames = [saveDirectoryName, "SaveGameInfo"];
  if (
    !sourceStat.isDirectory() ||
    sourceStat.isSymbolicLink() ||
    JSON.stringify(names) !== JSON.stringify(requiredNames.sort())
  )
    throw new Error("p4_fixture_source_shape_invalid");
  for (const name of names) await assertRegular(join(source, name), io);
  try {
    await io.lstat(destination);
    throw new Error("p4_fixture_root_already_exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await io.mkdir(destination, { recursive: false });
  let completed = false;
  try {
    const files = [];
    for (const name of names) {
      const sourceFile = join(source, name),
        targetFile = join(destination, saveDirectoryName, name);
      await io.mkdir(dirname(targetFile), { recursive: true });
      const bytes = await io.readFile(sourceFile);
      await io.writeFile(targetFile, bytes, { flag: "wx" });
      const copied = await io.readFile(targetFile);
      const sha256 = digest(bytes);
      if (digest(copied) !== sha256) throw new Error("p4_fixture_copy_hash_mismatch");
      files.push({ path: `${saveDirectoryName}/${name}`, sha256 });
    }
    const manifest = {
      schemaVersion: 1,
      fixtureKind: "stardew_navigation_p4_ordinary_native_save",
      saveDirectoryName,
      files,
    };
    await io.writeFile(join(destination, "fixture-manifest.json"), `${JSON.stringify(manifest)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    completed = true;
    return Object.freeze({
      state: "fixture_created",
      fixtureRoot: destination,
      saveDirectoryName,
      fileCount: files.length,
      manifestSha256: digest(await io.readFile(join(destination, "fixture-manifest.json"))),
    });
  } finally {
    if (!completed) await io.rm(destination, { recursive: true, force: true });
  }
}

function args(values) {
  if (values.length !== 4 || values[0] !== "--source-save" || values[2] !== "--fixture-root")
    throw new Error("usage: --source-save <absolute-native-save-dir> --fixture-root <new-absolute-fixture-root>");
  return { sourceSavePath: values[1], fixtureRoot: values[3] };
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  console.log(JSON.stringify(await createNavigationP4Fixture(args(process.argv.slice(2)))));
