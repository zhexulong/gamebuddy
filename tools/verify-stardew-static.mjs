import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { normalize, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const STATIC_PORTFOLIO_SCHEMA = "gamebuddy_stardew_static_portfolio/v2";
const PORTFOLIO_URL = new URL("./stardew-static-portfolio.v1.json", import.meta.url);
const PACKAGE_URL = new URL("../package.json", import.meta.url);
const ROOT_URL = new URL("../", import.meta.url);
const ROOT_PATH = fileURLToPath(ROOT_URL);
const ID = /^[a-z][a-z0-9_]{2,63}$/;
const SCRIPT_CLASS = new Set(["static_non_action_leaf", "blocked_target_live", "out_of_scope_action_platform"]);
const ARTIFACT_IDENTITY = /^[A-Za-z0-9_./+:-]{3,256}$/;
const VERSIONED_OWNER = /^[a-z][a-z0-9.-]{2,127}@v[1-9][0-9]*$/;
const VERSIONED_RISK_ID = /^[A-Z][A-Z0-9_-]{2,127}@v[1-9][0-9]*$/;
// These are the complete external assembly closure declared by both standalone
// contract projects. Keep this list in lockstep with their <Reference HintPath>s.
const TARGET_ASSEMBLIES = Object.freeze([
  "Stardew Valley.dll",
  "StardewModdingAPI.dll",
  "MonoGame.Framework.dll",
  "SMAPI.Toolkit.CoreInterfaces.dll",
  "smapi-internal/Newtonsoft.Json.dll",
]);
const CONTRACT_ASSEMBLIES = new Set([
  "integrations/stardew/tests/bin/Release/net6.0/PortfolioMineElevatorProjection.Contract.dll",
]);
const PRODUCTION_ASSEMBLY = "integrations/stardew/bin/Release/net6.0/GameBuddy.Stardew.dll";
const VERIFIER_ENTRYPOINT = "tools/verify-stardew-static.mjs";
const VERIFIER_SELF_TEST = "tools/verify-stardew-static.test.mjs";
const VERIFIER_SELF_TEST_SCRIPT = "test:stardew:static";

export class StardewStaticPortfolioError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const fail = (code) => {
  throw new StardewStaticPortfolioError(code);
};
const digest = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const exactKeys = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

export function normalizeCommand(command) {
  if (
    !Array.isArray(command) ||
    command.length < 2 ||
    command.some((part) => typeof part !== "string" || !part || /[\r\n\0]/.test(part))
  )
    fail("static_portfolio_command_invalid");
  return command.map((part, index) => {
    const compact = part.trim().replace(/\s+/g, " ");
    if (!compact) fail("static_portfolio_command_invalid");
    if (index === 0) return compact.toLowerCase();
    if (compact.includes("/") || compact.includes("\\"))
      return posix.normalize(normalize(compact).replace(/\\/g, "/")).replace(/^\.\//, "");
    return compact;
  });
}

function isDotnetContractCommand(normalized) {
  // Static verification builds the checked solution once, then invokes each
  // exact compiled entrypoint. Project-launch resolution is deliberately not
  // part of the execution surface: sibling contracts must never substitute
  // their launcher from a shared output directory.
  return (
    normalized[0] === "dotnet" &&
    normalized.length === 3 &&
    CONTRACT_ASSEMBLIES.has(normalized[1]) &&
    normalized[2] === PRODUCTION_ASSEMBLY
  );
}

function normalizeCommandPathForSecurityComparison(token) {
  return posix.normalize(token.replace(/\\/g, "/")).replace(/^\.\//, "").toLowerCase();
}

function isVerifierReentrantCommand(command) {
  const normalized = normalizeCommand(command);
  const protectedEntrypoints = new Set([
    normalizeCommandPathForSecurityComparison(VERIFIER_ENTRYPOINT),
    normalizeCommandPathForSecurityComparison(VERIFIER_SELF_TEST),
  ]);
  return normalized.some(
    (token) =>
      (token.includes("/") || token.includes("\\")) &&
      protectedEntrypoints.has(normalizeCommandPathForSecurityComparison(token)),
  );
}

export function isSafeStaticCommand(command) {
  const normalized = normalizeCommand(command);
  if (normalized.some((part) => /[;&|><`$]/.test(part)) || isVerifierReentrantCommand(normalized)) return false;
  if (normalized[0] === "node")
    return (
      normalized[1] === "--test" &&
      normalized.length >= 3 &&
      normalized.slice(2).every((part) => part.startsWith("tools/") && part.endsWith(".test.mjs"))
    );
  return isDotnetContractCommand(normalized);
}

export function validateStaticPortfolio(value, { scripts } = {}) {
  if (
    !exactKeys(value, ["schema", "portfolioId", "scripts", "leaves"]) ||
    value.schema !== STATIC_PORTFOLIO_SCHEMA ||
    value.portfolioId !== "stardew_non_action_engineering_v1" ||
    !Array.isArray(value.scripts) ||
    !Array.isArray(value.leaves) ||
    value.leaves.length === 0
  )
    fail("static_portfolio_invalid");
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) fail("static_portfolio_scripts_unavailable");
  const scriptNames = Object.keys(scripts)
    .filter((name) => name.toLowerCase().includes("stardew") && name !== VERIFIER_SELF_TEST_SCRIPT)
    .sort();
  const seenIds = new Set(),
    seenScripts = new Set(),
    seenCommands = new Set();
  for (const entry of value.scripts) {
    if (
      !exactKeys(entry, ["id", "script", "command", "class", "owner", "riskId"]) ||
      !ID.test(entry.id) ||
      typeof entry.script !== "string" ||
      entry.script === VERIFIER_SELF_TEST_SCRIPT ||
      !SCRIPT_CLASS.has(entry.class) ||
      typeof entry.command !== "string" ||
      !entry.command ||
      !VERSIONED_OWNER.test(entry.owner) ||
      !VERSIONED_RISK_ID.test(entry.riskId)
    )
      fail("static_portfolio_script_invalid");
    if (seenIds.has(entry.id)) fail("static_portfolio_duplicate_id");
    if (seenScripts.has(entry.script)) fail("static_portfolio_duplicate_script");
    if (!Object.hasOwn(scripts, entry.script) || scripts[entry.script] !== entry.command)
      fail("static_portfolio_script_drift");
    const normalized = JSON.stringify(normalizeShellCommand(entry.command));
    if (seenCommands.has(normalized)) fail("static_portfolio_alias_script");
    seenIds.add(entry.id);
    seenScripts.add(entry.script);
    seenCommands.add(normalized);
  }
  if (seenScripts.size !== scriptNames.length || scriptNames.some((name) => !seenScripts.has(name)))
    fail("static_portfolio_script_unlisted");
  const leafIds = new Set(),
    leafCommands = new Set(),
    leafScripts = new Set();
  for (const leaf of value.leaves) {
    if (
      !exactKeys(leaf, ["id", "script", "command", "evidenceKind", "artifactIdentity", "owner", "riskId"]) ||
      !ID.test(leaf.id) ||
      typeof leaf.script !== "string" ||
      leaf.script === VERIFIER_SELF_TEST_SCRIPT ||
      !Array.isArray(leaf.command) ||
      !ID.test(leaf.evidenceKind) ||
      !ARTIFACT_IDENTITY.test(leaf.artifactIdentity) ||
      !VERSIONED_OWNER.test(leaf.owner) ||
      !VERSIONED_RISK_ID.test(leaf.riskId)
    )
      fail("static_portfolio_leaf_invalid");
    const scriptEntry = value.scripts.find((entry) => entry.script === leaf.script);
    if (!scriptEntry || !seenScripts.has(leaf.script) || scriptEntry.class !== "static_non_action_leaf")
      fail("static_portfolio_leaf_class_invalid");
    if (leaf.id !== scriptEntry.id) fail("static_portfolio_leaf_id_mismatch");
    const normalized = JSON.stringify(normalizeCommand(leaf.command));
    if (normalized !== JSON.stringify(normalizeShellCommand(scriptEntry.command)))
      fail("static_portfolio_leaf_script_drift");
    if (isVerifierReentrantCommand(leaf.command)) fail("static_portfolio_self_reentrant_leaf");
    if (!isSafeStaticCommand(leaf.command)) fail("static_portfolio_unsafe_static_command");
    if (leafIds.has(leaf.id)) fail("static_portfolio_duplicate_leaf");
    if (leafCommands.has(normalized)) fail("static_portfolio_alias_leaf");
    if (leafScripts.has(leaf.script)) fail("static_portfolio_duplicate_leaf_script");
    leafIds.add(leaf.id);
    leafCommands.add(normalized);
    leafScripts.add(leaf.script);
  }
  return Object.freeze(value);
}

function normalizeShellCommand(command) {
  if (typeof command !== "string" || !command.trim() || /[\r\n\0]/.test(command))
    fail("static_portfolio_script_invalid");
  return command
    .trim()
    .split(/\s+/)
    .map((part, index) =>
      index === 0
        ? part.toLowerCase()
        : part.includes("/") || part.includes("\\")
          ? posix.normalize(normalize(part).replace(/\\/g, "/")).replace(/^\.\//, "")
          : part,
    );
}

export async function loadStaticPortfolio({ read = readFile } = {}) {
  let portfolioText, packageText;
  try {
    [portfolioText, packageText] = await Promise.all([read(PORTFOLIO_URL, "utf8"), read(PACKAGE_URL, "utf8")]);
  } catch {
    fail("static_portfolio_unavailable");
  }
  try {
    const scripts = JSON.parse(packageText).scripts;
    return Object.freeze({
      portfolio: validateStaticPortfolio(JSON.parse(portfolioText), { scripts }),
      identity: `sha256:${digest(portfolioText)}`,
      scripts,
    });
  } catch (error) {
    if (error instanceof StardewStaticPortfolioError) throw error;
    fail("static_portfolio_invalid");
  }
}

export function targetAssemblyAvailability({ environment = process.env, exists = existsSync } = {}) {
  const gamePath = environment.GAMEBUDDY_STARDEW_GAME_PATH;
  if (typeof gamePath !== "string" || !gamePath.trim())
    return Object.freeze({ available: false, reasonCode: "blocked_missing_target_assemblies" });
  const resolvedGamePath = resolve(gamePath);
  const missing = TARGET_ASSEMBLIES.filter((file) => !exists(resolve(resolvedGamePath, file)));
  return missing.length === 0
    ? Object.freeze({ available: true, gamePath: resolvedGamePath })
    : Object.freeze({ available: false, reasonCode: "blocked_missing_target_assemblies" });
}

function commandRequiresTargetAssemblies(command) {
  return isDotnetContractCommand(normalizeCommand(command));
}

function runProcess(command, arguments_, { spawnFn = spawn } = {}) {
  return new Promise((resolveResult) => {
    const started = performance.now();
    let child;
    try {
      child = spawnFn(command, arguments_, { cwd: ROOT_URL, env: process.env, stdio: "ignore", shell: false });
    } catch {
      resolveResult({ exitCode: null, durationMs: Math.round(performance.now() - started) });
      return;
    }
    child.once("error", () => resolveResult({ exitCode: null, durationMs: Math.round(performance.now() - started) }));
    child.once("exit", (exitCode) => resolveResult({ exitCode, durationMs: Math.round(performance.now() - started) }));
  });
}

export function buildTargetProduction({ targetGamePath, spawnFn = spawn } = {}) {
  return runProcess(
    "dotnet",
    ["build", "GameBuddy.sln", "--configuration", "Release", "--no-restore", `-p:GamePath=${targetGamePath}`],
    { spawnFn },
  );
}

export function executeStaticLeaf(command, { spawnFn = spawn } = {}) {
  return runProcess(command[0], [...command.slice(1)], { spawnFn });
}

function sameFileSnapshot(before, after) {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeMs === after.mtimeMs &&
    before.ctimeMs === after.ctimeMs
  );
}

export async function hashProductionAssembly({
  path = resolve(ROOT_PATH, PRODUCTION_ASSEMBLY),
  read = readFile,
  stat = lstat,
} = {}) {
  let before, bytes, after;
  try {
    before = await stat(path);
    if (!before.isFile()) fail("static_portfolio_production_assembly_invalid");
    bytes = await read(path);
    after = await stat(path);
  } catch (error) {
    if (error instanceof StardewStaticPortfolioError) throw error;
    fail("static_portfolio_production_assembly_invalid");
  }
  if (!after.isFile() || !sameFileSnapshot(before, after)) fail("static_portfolio_production_assembly_changed");
  const expectedSha256 = createHash("sha256").update(bytes).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) fail("static_portfolio_production_assembly_invalid");
  return Object.freeze({ path, expectedSha256 });
}

export async function verifyStaticPortfolio({
  portfolio,
  identity,
  scripts,
  executeLeaf = executeStaticLeaf,
  buildTarget = buildTargetProduction,
  hashProduction = hashProductionAssembly,
  targetAvailability = targetAssemblyAvailability(),
} = {}) {
  validateStaticPortfolio(portfolio, { scripts });
  if (typeof identity !== "string" || !/^sha256:[a-f0-9]{64}$/.test(identity))
    fail("static_portfolio_identity_invalid");
  if (!targetAvailability || typeof targetAvailability.available !== "boolean")
    fail("static_portfolio_target_availability_invalid");
  const targetLeaves = portfolio.leaves.filter((leaf) => commandRequiresTargetAssemblies(leaf.command));
  const targetBuild =
    targetAvailability.available && targetLeaves.length > 0
      ? await buildTarget({ targetGamePath: targetAvailability.gamePath })
      : undefined;
  if (targetBuild && !Number.isInteger(targetBuild.exitCode) && targetBuild.exitCode !== null)
    fail("static_portfolio_target_build_invalid");
  const leaves = [];
  for (const leaf of portfolio.leaves) {
    if (commandRequiresTargetAssemblies(leaf.command) && !targetAvailability.available) {
      leaves.push(
        Object.freeze({
          id: leaf.id,
          script: leaf.script,
          command: Object.freeze([...leaf.command]),
          evidenceKind: leaf.evidenceKind,
          artifactIdentity: leaf.artifactIdentity,
          owner: leaf.owner,
          riskId: leaf.riskId,
          exitCode: null,
          durationMs: 0,
          state: "blocked_missing_target_assemblies",
          reasonCode: "blocked_missing_target_assemblies",
        }),
      );
      continue;
    }
    if (commandRequiresTargetAssemblies(leaf.command) && targetBuild.exitCode !== 0) {
      leaves.push(
        Object.freeze({
          id: leaf.id,
          script: leaf.script,
          command: Object.freeze([...leaf.command]),
          evidenceKind: leaf.evidenceKind,
          artifactIdentity: leaf.artifactIdentity,
          owner: leaf.owner,
          riskId: leaf.riskId,
          exitCode: targetBuild.exitCode,
          durationMs: targetBuild.durationMs,
          state: "failed",
        }),
      );
      continue;
    }
    let command = leaf.command;
    if (commandRequiresTargetAssemblies(leaf.command)) {
      const binding = await hashProduction();
      if (
        !binding ||
        typeof binding.path !== "string" ||
        !/^[a-f0-9]{64}$/.test(binding.expectedSha256) ||
        !resolve(binding.path)
      )
        fail("static_portfolio_production_assembly_invalid");
      command = [leaf.command[0], leaf.command[1], "--expected-sha256", binding.expectedSha256, resolve(binding.path)];
    }
    const result = await executeLeaf(
      command,
      commandRequiresTargetAssemblies(leaf.command) ? { targetGamePath: targetAvailability.gamePath } : undefined,
    );
    if (
      !result ||
      (!Number.isInteger(result.exitCode) && result.exitCode !== null) ||
      !Number.isInteger(result.durationMs) ||
      result.durationMs < 0
    )
      fail("static_portfolio_leaf_execution_invalid");
    leaves.push(
      Object.freeze({
        id: leaf.id,
        script: leaf.script,
        command: Object.freeze([...leaf.command]),
        evidenceKind: leaf.evidenceKind,
        artifactIdentity: leaf.artifactIdentity,
        owner: leaf.owner,
        riskId: leaf.riskId,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        state: result.exitCode === 0 ? "passed" : "failed",
      }),
    );
  }
  const byId = new Map(leaves.map((leaf) => [leaf.id, leaf]));
  const commands = Object.freeze(
    portfolio.scripts.map((entry) =>
      Object.freeze({
        id: entry.id,
        script: entry.script,
        class: entry.class,
        owner: entry.owner,
        riskId: entry.riskId,
        state: byId.get(entry.id)?.state ?? "blocked_not_run",
      }),
    ),
  );
  const passed = leaves.filter((leaf) => leaf.state === "passed").length;
  const failed = leaves.filter((leaf) => leaf.state === "failed").length;
  const blocked = leaves.filter((leaf) => leaf.state === "blocked_missing_target_assemblies").length;
  const state = failed > 0 ? "failed" : blocked > 0 ? "blocked" : "passed";
  return Object.freeze({
    schema: "gamebuddy_stardew_static_verification/v2",
    portfolioId: portfolio.portfolioId,
    portfolioIdentity: identity,
    state,
    reasonCode: blocked > 0 ? "blocked_missing_target_assemblies" : undefined,
    summary: Object.freeze({ passed, failed, blocked, passDenominator: passed + failed }),
    leaves: Object.freeze(leaves),
    commands,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { portfolio, identity, scripts } = await loadStaticPortfolio();
    const report = await verifyStaticPortfolio({ portfolio, identity, scripts });
    console.log(JSON.stringify(report));
    if (report.state !== "passed") process.exitCode = 2;
  } catch (error) {
    console.log(
      JSON.stringify({
        schema: "gamebuddy_stardew_static_verification/v2",
        state: "failed",
        reasonCode:
          error instanceof StardewStaticPortfolioError ? error.code : "static_portfolio_verification_unavailable",
      }),
    );
    process.exitCode = 2;
  }
}
