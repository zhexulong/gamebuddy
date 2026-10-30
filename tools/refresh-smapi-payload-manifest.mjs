#!/usr/bin/env node
/**
 * Regenerates `assets/smapi/payload-manifest.json` from the vendored SMAPI payload.
 *
 * The manifest is the payload's byte authority: the release packager stages these
 * exact files into every generation and refuses a tree whose set or digests differ,
 * so a manual edit under `assets/smapi/win-x64/` cannot silently ship. Running this
 * script is the one deliberate act that accepts a new SMAPI version, which is why it
 * also records where the bytes came from (release archive, entry, digest).
 *
 * Usage: node tools/refresh-smapi-payload-manifest.mjs --version 4.5.2 \
 *   --source-url <release zip> --source-archive-sha256 <hex> [--archive-entry <entry>]
 */
import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const payloadRoot = resolve(repositoryRoot, "assets", "smapi");
const filesRoot = resolve(payloadRoot, "win-x64");
const MANIFEST_PATH = resolve(payloadRoot, "payload-manifest.json");
const LICENSE_FILE = "SMAPI-LICENSE.txt";
/** Files SMAPI itself treats as the player's settings; a one-click install writes them only when absent. */
const PLAYER_OWNED_FILES = Object.freeze(["smapi-internal/config.json"]);

function parseArguments(argv) {
  const options = {
    version: undefined,
    sourceUrl: undefined,
    sourceArchiveSha256: undefined,
    archiveEntry: "internal/windows/install.dat",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--version") options.version = argv[++index];
    else if (argument === "--source-url") options.sourceUrl = argv[++index];
    else if (argument === "--source-archive-sha256") options.sourceArchiveSha256 = argv[++index];
    else if (argument === "--archive-entry") options.archiveEntry = argv[++index];
    else throw new Error(`unknown_argument:${argument}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(options.version ?? "")) throw new Error("smapi_version_required");
  if (!/^https:\/\/github\.com\/Pathoschild\/SMAPI\/releases\/download\//.test(options.sourceUrl ?? ""))
    throw new Error("smapi_source_url_required");
  if (!/^[a-f0-9]{64}$/.test(options.sourceArchiveSha256 ?? ""))
    throw new Error("smapi_source_archive_sha256_required");
  return options;
}

async function listFiles(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listFiles(join(directory, entry.name), name)));
    else if (entry.isFile()) files.push(name);
    else throw new Error(`smapi_payload_nonregular_entry:${name}`);
  }
  return files.sort();
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const license = await readFile(resolve(payloadRoot, LICENSE_FILE));
  if (
    !license.includes(Buffer.from("GNU LESSER GENERAL PUBLIC LICENSE")) ||
    !license.includes(Buffer.from("Version 3, 29 June 2007"))
  )
    throw new Error("smapi_license_text_missing");
  const files = [];
  for (const path of await listFiles(filesRoot)) {
    const bytes = await readFile(resolve(filesRoot, path));
    files.push(Object.freeze({ path, size: (await stat(resolve(filesRoot, path))).size, sha256: sha256(bytes) }));
  }
  if (!files.some((file) => file.path === "StardewModdingAPI.exe")) throw new Error("smapi_payload_loader_missing");
  const manifest = Object.freeze({
    schema: "gamebuddy-smapi-payload-manifest/v1",
    version: options.version,
    sourceUrl: options.sourceUrl,
    sourceArchiveSha256: options.sourceArchiveSha256,
    sourceArchiveEntry: options.archiveEntry,
    license: Object.freeze({ file: LICENSE_FILE, sha256: sha256(license) }),
    root: "win-x64",
    files: Object.freeze(files),
    playerOwnedFiles: Object.freeze([...PLAYER_OWNED_FILES]),
  });
  await writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ manifest: MANIFEST_PATH, files: files.length, version: manifest.version })}\n`,
  );
}

await main();
