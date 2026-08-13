#!/usr/bin/env node
/**
 * Generate the deliberately narrow, lockfile-bound Node dependency inventory.
 * This is not an artifact-scoped or multi-ecosystem release SBOM.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LICENSE_COMMAND = Object.freeze(["licenses", "list", "--json"]);
const LOCKFILE = "pnpm-lock.yaml";
const DEFAULT_OUTPUT = "third_party/sbom-node.json";
const MAX_BUFFER = 16 * 1024 * 1024;
const ALLOWED_CLAIM_ECOSYSTEMS = new Set([
  "node",
  "node.js",
  "nodejs",
  "npm",
  "pnpm",
  "bun",
  "c#",
  "csharp",
  "nuget",
  ".net",
  "dotnet",
]);
const CLAIM_FIELDS = ["ecosystem", "language", "runtime", "packageManager", "platform", "type"];
const ECOSYSTEM_CLAIM_FIELDS = new Set(["ecosystem", "language", "runtime", "packageManager", "type"]);

const rootFromModule = resolve(import.meta.dirname, "..");

function compareDeterministically(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidInput(message) {
  const error = new Error(message);
  error.code = "INPUT";
  return error;
}

function claimValues(value, field) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  throw invalidInput(`Unsupported ${field} claim; only Node, Bun, or C# claims are accepted`);
}

function validateEntryClaims(entry, field) {
  for (const claimField of CLAIM_FIELDS) {
    if (!Object.hasOwn(entry, claimField) || entry[claimField] === null || entry[claimField] === undefined) continue;
    for (const value of claimValues(entry[claimField], `${field}.${claimField}`)) {
      const normalized = value.trim().toLowerCase();
      if (
        ECOSYSTEM_CLAIM_FIELDS.has(claimField) &&
        !ALLOWED_CLAIM_ECOSYSTEMS.has(normalized) &&
        !/^(?:node(?:\.js)?|nodejs|npm|pnpm|bun|c#|csharp|nuget|\.net|dotnet)(?:[ /_-].*)?$/.test(normalized)
      ) {
        throw invalidInput(`Unsupported ${claimField} claim ${JSON.stringify(value)} at ${field}`);
      }
    }
  }
}

/** Normalize and validate pnpm's JSON shape without accepting another ecosystem's claims. */
export function normalizeLicenseInventory(byLicense) {
  if (byLicense === null || typeof byLicense !== "object" || Array.isArray(byLicense))
    throw invalidInput("pnpm license output must be an object keyed by license");
  const packages = [];
  for (const [license, entries] of Object.entries(byLicense)) {
    if (!license || !Array.isArray(entries))
      throw invalidInput(`Invalid license inventory group ${JSON.stringify(license)}`);
    for (const [index, entry] of entries.entries()) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry))
        throw invalidInput(`Invalid license inventory entry ${license}[${index}]`);
      validateEntryClaims(entry, `${license}[${index}]`);
      if (typeof entry.name !== "string" || entry.name.length === 0)
        throw invalidInput(`Invalid package name at ${license}[${index}]`);
      if (
        !Array.isArray(entry.versions) ||
        entry.versions.some((version) => version !== null && (typeof version !== "string" || version.length === 0))
      )
        throw invalidInput(`Invalid package versions at ${license}[${index}]`);
      if (entry.homepage !== undefined && entry.homepage !== null && typeof entry.homepage !== "string")
        throw invalidInput(`Invalid package homepage at ${license}[${index}]`);
      packages.push({
        name: entry.name,
        versions: entry.versions.map((version) => version ?? "").sort(compareDeterministically),
        license,
        homepage: entry.homepage ?? null,
      });
    }
  }
  packages.sort((left, right) => {
    const nameOrder = compareDeterministically(left.name, right.name);
    return nameOrder || compareDeterministically(left.versions.join(","), right.versions.join(","));
  });
  return packages;
}

export function buildSbom({ packages, lockfileSha256 }) {
  if (!/^[a-f0-9]{64}$/.test(lockfileSha256)) throw invalidInput("pnpm lockfile SHA-256 is invalid");
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: "urn:uuid:00000000-0000-4000-8000-000000000001",
    version: 1,
    metadata: {
      component: { type: "application", name: "gamebuddy", version: "0.0.0" },
      tools: [{ vendor: "pnpm", name: "pnpm licenses list", version: "11.1.3" }],
      properties: [
        { name: "gamebuddy:inventory-scope", value: "node-dependencies-only" },
        { name: "gamebuddy:accepted-claim-ecosystems", value: "Node,Bun,C#" },
        { name: "gamebuddy:generator-input-command", value: "pnpm licenses list --json" },
        { name: "gamebuddy:generator-input-lockfile", value: LOCKFILE },
        { name: "gamebuddy:generator-input-lockfile-sha256", value: lockfileSha256 },
      ],
    },
    components: packages.map((entry) => ({
      type: "library",
      name: entry.name,
      version: entry.versions.join(","),
      licenses: [{ license: { id: entry.license } }],
      externalReferences: entry.homepage === null ? [] : [{ type: "website", url: entry.homepage }],
    })),
  };
}

async function runPnpmLicenses({ cwd }) {
  // `shell` allows pnpm's .cmd shim to resolve on Windows; the command and
  // arguments are constants, never influenced by user input.
  const result = await execFileAsync("pnpm", LICENSE_COMMAND, {
    cwd,
    shell: process.platform === "win32",
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
  });
  return result.stdout;
}

async function hashLockfile(root, read = readFile) {
  const bytes = await read(resolve(root, LOCKFILE));
  return createHash("sha256").update(bytes).digest("hex");
}

export async function publishWithoutOverwrite(output, content) {
  const temporary = `${output}.tmp-${process.pid}`;
  let temporaryCreated = false;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    temporaryCreated = true;
    // A hard-link publish is atomic and, unlike rename, cannot replace a
    // concurrently-created destination. Both paths are in the output folder.
    await link(temporary, output);
    await unlink(temporary);
    temporaryCreated = false;
  } finally {
    if (temporaryCreated) await unlink(temporary).catch(() => {});
  }
}

export async function generateSbom({
  root = rootFromModule,
  output = resolve(root, DEFAULT_OUTPUT),
  run = runPnpmLicenses,
  read = readFile,
  mkdirImpl = mkdir,
  publish = publishWithoutOverwrite,
} = {}) {
  const rootPath = resolve(root);
  const outputPath = resolve(output);
  if (outputPath === rootPath || relative(rootPath, outputPath).startsWith(".."))
    throw invalidInput("SBOM output must be inside the repository root");
  const lockfileSha256 = await hashLockfile(rootPath, read);
  const raw = await run({ cwd: rootPath, command: [...LICENSE_COMMAND] });
  let byLicense;
  try {
    byLicense = JSON.parse(raw);
  } catch (error) {
    throw invalidInput(`pnpm license output is not valid JSON: ${error.message}`);
  }
  const packages = normalizeLicenseInventory(byLicense);
  const sbom = buildSbom({ packages, lockfileSha256 });
  await mkdirImpl(dirname(outputPath), { recursive: true });
  await publish(outputPath, `${JSON.stringify(sbom, null, 2)}\n`);
  return sbom;
}

/** Regenerate beside the committed inventory, compare exact bytes, then remove
 * the temporary output. This verifies drift without weakening the normal
 * no-overwrite publishing contract or leaving generated residue behind. */
export async function verifySbom({
  root = rootFromModule,
  output = resolve(root, DEFAULT_OUTPUT),
  generate = generateSbom,
  read = readFile,
  remove = unlink,
  temporaryName = `.sbom-verify-${process.pid}-${randomUUID()}.json`,
} = {}) {
  const rootPath = resolve(root);
  const outputPath = resolve(output);
  if (outputPath === rootPath || relative(rootPath, outputPath).startsWith(".."))
    throw invalidInput("SBOM output must be inside the repository root");
  const temporaryOutput = resolve(dirname(outputPath), temporaryName);
  if (dirname(temporaryOutput) !== dirname(outputPath)) throw invalidInput("SBOM verification temporary output escapes destination directory");
  try {
    await generate({ root: rootPath, output: temporaryOutput });
    const [expected, actual] = await Promise.all([read(outputPath), read(temporaryOutput)]);
    if (!Buffer.from(expected).equals(Buffer.from(actual))) throw invalidInput("SBOM output drifted; regenerate and review third_party/sbom-node.json");
    return Object.freeze({ output: outputPath });
  } finally {
    await remove(temporaryOutput).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

function parseCliArgs(args) {
  if (args.length === 0) return { mode: "write", output: DEFAULT_OUTPUT };
  if (args.length === 1 && args[0] === "--verify") return { mode: "verify", output: DEFAULT_OUTPUT };
  if (args.length === 1 && !args[0].startsWith("-")) return { mode: "write", output: args[0] };
  throw invalidInput("usage: generate-sbom.mjs [--verify|output-path]");
}

if (import.meta.main) {
  try {
    const args = parseCliArgs(process.argv.slice(2));
    const output = resolve(process.cwd(), args.output);
    if (args.mode === "verify") {
      await verifySbom({ root: process.cwd(), output });
      console.log(`Verified Node dependency records match ${output}.`);
    } else {
      const sbom = await generateSbom({ root: process.cwd(), output });
      console.log(`Wrote ${sbom.components.length} Node dependency records to ${output}.`);
    }
  } catch (error) {
    console.error(`SBOM generation failed closed: ${error.message}`);
    process.exitCode = 1;
  }
}
