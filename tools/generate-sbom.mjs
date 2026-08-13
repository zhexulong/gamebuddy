#!/usr/bin/env node
/** Generate and verify the deliberately narrow, descriptor-bound Node dependency inventory. */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const LICENSE_COMMAND = Object.freeze(["licenses", "list", "--json"]);
const LOCKFILE = "pnpm-lock.yaml";
const DEFAULT_OUTPUT = "third_party/sbom-node.json";
const DEFAULT_POLICY = "third_party/sbom-node-policy.json";
const MAX_BUFFER = 16 * 1024 * 1024;
const CLAIM_FIELDS = ["ecosystem", "language", "runtime", "packageManager", "platform", "type"];
const ECOSYSTEM_CLAIM_FIELDS = new Set(["ecosystem", "language", "runtime", "packageManager", "type"]);
const rootFromModule = resolve(import.meta.dirname, "..");

function compare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
function invalidInput(message) {
  const error = new Error(message);
  error.code = "INPUT";
  return error;
}
function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value, keys, field) {
  if (!plainObject(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(","))
    throw invalidInput(`SBOM descriptor schema drift at ${field}`);
}

export function validatePolicy(policy) {
  exactKeys(policy, ["schemaVersion", "descriptor", "bom", "inventory"], "root");
  exactKeys(policy.descriptor, ["name", "version"], "descriptor");
  exactKeys(policy.bom, ["format", "specVersion", "component"], "bom");
  exactKeys(policy.bom.component, ["type", "name", "version"], "bom.component");
  exactKeys(policy.inventory, ["scope", "acceptedClaimEcosystems", "input"], "inventory");
  exactKeys(policy.inventory.input, ["command", "lockfile"], "inventory.input");
  if (policy.schemaVersion !== 1) throw invalidInput("Unsupported SBOM descriptor schema version");
  if (policy.descriptor.name !== "gamebuddy-node-sbom" || policy.descriptor.version !== "1")
    throw invalidInput("Unsupported SBOM descriptor identity");
  if (
    policy.bom.format !== "CycloneDX" ||
    policy.bom.specVersion !== "1.5" ||
    policy.bom.component.type !== "application" ||
    policy.bom.component.name !== "gamebuddy" ||
    policy.bom.component.version !== "0.0.0"
  )
    throw invalidInput("Unsupported SBOM descriptor BOM schema");
  if (
    policy.inventory.scope !== "node-dependencies-only" ||
    policy.inventory.input.command !== "pnpm licenses list --json" ||
    policy.inventory.input.lockfile !== LOCKFILE
  )
    throw invalidInput("Unsupported SBOM descriptor input scope");
  if (
    !Array.isArray(policy.inventory.acceptedClaimEcosystems) ||
    policy.inventory.acceptedClaimEcosystems.length === 0 ||
    policy.inventory.acceptedClaimEcosystems.some(
      (value) => typeof value !== "string" || !/^(?:node|node\.js|nodejs|npm|pnpm)$/.test(value),
    )
  )
    throw invalidInput("Unsupported SBOM descriptor claim ecosystem scope");
  return policy;
}
async function loadPolicy(root, policyPath, read = readFile) {
  let raw;
  try {
    raw = await read(resolve(root, policyPath), "utf8");
  } catch (error) {
    throw invalidInput(`Cannot read SBOM descriptor: ${error.message}`);
  }
  try {
    return validatePolicy(JSON.parse(raw));
  } catch (error) {
    if (error?.code === "INPUT") throw error;
    throw invalidInput(`SBOM descriptor is not valid JSON: ${error.message}`);
  }
}
function claimValues(value, field) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
  throw invalidInput(`Unsupported ${field} claim; only declared Node claims are accepted`);
}
export function normalizeLicenseInventory(
  byLicense,
  { allowedClaimEcosystems = new Set(["node", "node.js", "nodejs", "npm", "pnpm"]) } = {},
) {
  if (!plainObject(byLicense)) throw invalidInput("pnpm license output must be an object keyed by license");
  const packages = [];
  for (const [license, entries] of Object.entries(byLicense)) {
    if (!license || !Array.isArray(entries))
      throw invalidInput(`Invalid license inventory group ${JSON.stringify(license)}`);
    for (const [index, entry] of entries.entries()) {
      if (!plainObject(entry)) throw invalidInput(`Invalid license inventory entry ${license}[${index}]`);
      for (const claimField of CLAIM_FIELDS)
        if (entry[claimField] !== null && entry[claimField] !== undefined)
          for (const value of claimValues(entry[claimField], `${license}[${index}].${claimField}`))
            if (ECOSYSTEM_CLAIM_FIELDS.has(claimField) && !allowedClaimEcosystems.has(value.trim().toLowerCase()))
              throw invalidInput(`Unsupported ${claimField} claim ${JSON.stringify(value)} at ${license}[${index}]`);
      if (typeof entry.name !== "string" || !entry.name)
        throw invalidInput(`Invalid package name at ${license}[${index}]`);
      if (
        !Array.isArray(entry.versions) ||
        entry.versions.some((version) => version !== null && (typeof version !== "string" || !version))
      )
        throw invalidInput(`Invalid package versions at ${license}[${index}]`);
      if (entry.homepage !== undefined && entry.homepage !== null && typeof entry.homepage !== "string")
        throw invalidInput(`Invalid package homepage at ${license}[${index}]`);
      packages.push({
        name: entry.name,
        versions: entry.versions.map((version) => version ?? "").sort(compare),
        license,
        homepage: entry.homepage ?? null,
      });
    }
  }
  return packages.sort(
    (left, right) => compare(left.name, right.name) || compare(left.versions.join(","), right.versions.join(",")),
  );
}
export function buildSbom({ packages, lockfileSha256, policy }) {
  if (!/^[a-f0-9]{64}$/.test(lockfileSha256)) throw invalidInput("pnpm lockfile SHA-256 is invalid");
  return {
    bomFormat: policy.bom.format,
    specVersion: policy.bom.specVersion,
    serialNumber: "urn:uuid:00000000-0000-4000-8000-000000000001",
    version: 1,
    metadata: {
      component: policy.bom.component,
      tools: [{ vendor: "pnpm", name: "pnpm licenses list", version: "11.1.3" }],
      properties: [
        { name: "gamebuddy:sbom-descriptor-name", value: policy.descriptor.name },
        { name: "gamebuddy:sbom-descriptor-version", value: policy.descriptor.version },
        { name: "gamebuddy:sbom-policy-schema-version", value: String(policy.schemaVersion) },
        { name: "gamebuddy:inventory-scope", value: policy.inventory.scope },
        { name: "gamebuddy:accepted-claim-ecosystems", value: policy.inventory.acceptedClaimEcosystems.join(",") },
        { name: "gamebuddy:generator-input-command", value: policy.inventory.input.command },
        { name: "gamebuddy:generator-input-lockfile", value: policy.inventory.input.lockfile },
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
  return (
    await execFileAsync("pnpm", LICENSE_COMMAND, {
      cwd,
      shell: process.platform === "win32",
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
    })
  ).stdout;
}
async function hashLockfile(root, read = readFile) {
  return createHash("sha256")
    .update(await read(resolve(root, LOCKFILE)))
    .digest("hex");
}
export async function publishWithoutOverwrite(output, content) {
  const temporary = `${output}.tmp-${process.pid}`;
  let made = false;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    made = true;
    await link(temporary, output);
    await unlink(temporary);
    made = false;
  } finally {
    if (made) await unlink(temporary).catch(() => {});
  }
}
export async function generateSbom({
  root = rootFromModule,
  output = resolve(root, DEFAULT_OUTPUT),
  policyPath = DEFAULT_POLICY,
  run = runPnpmLicenses,
  read = readFile,
  mkdirImpl = mkdir,
  publish = publishWithoutOverwrite,
} = {}) {
  const rootPath = resolve(root);
  const outputPath = resolve(output);
  if (outputPath === rootPath || relative(rootPath, outputPath).startsWith(".."))
    throw invalidInput("SBOM output must be inside the repository root");
  const policy = await loadPolicy(rootPath, policyPath, read);
  const lockfileSha256 = await hashLockfile(rootPath, read);
  let inventory;
  try {
    inventory = JSON.parse(await run({ cwd: rootPath, command: [...LICENSE_COMMAND] }));
  } catch (error) {
    if (error instanceof SyntaxError) throw invalidInput(`pnpm license output is not valid JSON: ${error.message}`);
    throw error;
  }
  const sbom = buildSbom({
    packages: normalizeLicenseInventory(inventory, {
      allowedClaimEcosystems: new Set(policy.inventory.acceptedClaimEcosystems),
    }),
    lockfileSha256,
    policy,
  });
  await mkdirImpl(dirname(outputPath), { recursive: true });
  await publish(outputPath, `${JSON.stringify(sbom, null, 2)}\n`);
  return sbom;
}
export async function verifySbom({
  root = rootFromModule,
  output = resolve(root, DEFAULT_OUTPUT),
  policyPath = DEFAULT_POLICY,
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
  if (dirname(temporaryOutput) !== dirname(outputPath))
    throw invalidInput("SBOM verification temporary output escapes destination directory");
  try {
    await generate({ root: rootPath, output: temporaryOutput, policyPath });
    const [expected, actual] = await Promise.all([read(outputPath), read(temporaryOutput)]);
    if (!Buffer.from(expected).equals(Buffer.from(actual)))
      throw invalidInput("SBOM output drifted; regenerate and review third_party/sbom-node.json");
    return Object.freeze({ output: outputPath });
  } finally {
    await remove(temporaryOutput).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}
function parseCliArgs(args) {
  if (!args.length) return { mode: "write", output: DEFAULT_OUTPUT };
  if (args.length === 1 && args[0] === "--verify") return { mode: "verify", output: DEFAULT_OUTPUT };
  if (args.length === 1 && !args[0].startsWith("-")) return { mode: "write", output: args[0] };
  throw invalidInput("usage: generate-sbom.mjs [--verify|output-path]");
}
if (import.meta.main)
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
