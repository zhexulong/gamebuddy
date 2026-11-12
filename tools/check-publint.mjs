#!/usr/bin/env node
/**
 * Run publint against the vendored public package. The baseline is deliberately limited to the two already-audited
 * vendor gaps; every other strict publint error remains a blocking result.
 *
 * A VERDICT REQUIRES THAT THE TOOL RAN. `spawnSync("bun", …)` with `shell: false` executes no file on a machine whose
 * `bun` is one of npm's shims: Win32 needs an executable image, Node applies no `PATHEXT` without a shell, and it
 * refuses a `.cmd` outright. The child then never started, `status` was `null`, the message list was empty, and the
 * tolerance branch below read that emptiness as "every failure maps to a known vendor baseline gap" - a pass over no
 * publint message at all. Three facts are required before any verdict is printed:
 *
 *   1. the runner resolves to a file this process can spawn - not a shim it cannot;
 *   2. the runner answers `<runner> --version`;
 *   3. the run's own output carries publint's identifying line.
 *
 * Any of the three missing is `publint_not_measured:<reason>:<what was found>` and exit 2, the repository's
 * not-measured status. The tolerance for the two vendor gaps survives, but it now needs messages that were actually
 * parsed: an unexplained non-zero exit is a failure whether or not a gap happens to be active.
 */
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_RELATIVE_PATH = "vendor/magic-context/packages/pi-plugin";
const PACKAGE_PATH = path.join(REPOSITORY_ROOT, PACKAGE_RELATIVE_PATH);
const PACKAGE_JSON_PATH = path.join(PACKAGE_PATH, "package.json");
const DIST_PATH = path.join(PACKAGE_PATH, "dist");
const PUBLINT_EXPORT_PATHS = Object.freeze([".", "./tavern", "./memory"]);

const PUBLINT_RUNNER = "bun";
const PUBLINT_RUN_ARGS = Object.freeze(["x", "publint", "--strict"]);
const SEMVER = /(\d+\.\d+\.\d+)/u;
/** publint's own first line of every run - the proof that the process this gate started is publint. */
const PUBLINT_IDENTITY = /Running publint v(\d+\.\d+\.\d+)/u;
const NOT_MEASURED = "publint_not_measured";

// Remove these entries when the independent vendor declaration task publishes
// types for every export and emits declaration files from its build.
const KNOWN_VENDOR_GAP_RULES = Object.freeze([
  Object.freeze({
    id: "missing-types-condition",
    description: "pi-plugin exports omit a `types` condition",
  }),
  Object.freeze({
    id: "missing-declaration-artifacts",
    description: "pi-plugin dist contains no `.d.ts` declaration artifacts",
  }),
]);

function knownGap(id, detail) {
  return Object.freeze({ id, detail });
}

function hasTypesCondition(value) {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasTypesCondition);
  if (Object.hasOwn(value, "types")) return true;
  return Object.values(value).some(hasTypesCondition);
}

async function countDeclarationFiles(directory) {
  let count = 0;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return 0;
    throw error;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      count += await countDeclarationFiles(entryPath);
    } else if (entry.isFile() && entry.name.endsWith(".d.ts")) {
      count += 1;
    }
  }
  return count;
}

async function readActiveKnownGaps() {
  const packageJson = JSON.parse(await readFile(PACKAGE_JSON_PATH, "utf8"));
  const activeGaps = [];
  const exports = packageJson.exports;

  const missingTypesPaths = PUBLINT_EXPORT_PATHS.filter((exportPath) => !hasTypesCondition(exports?.[exportPath]));
  if (missingTypesPaths.length > 0) {
    activeGaps.push(
      knownGap(KNOWN_VENDOR_GAP_RULES[0].id, `missing types condition for exports: ${missingTypesPaths.join(", ")}`),
    );
  }

  const declarationCount = await countDeclarationFiles(DIST_PATH);
  if (declarationCount === 0) {
    activeGaps.push(knownGap(KNOWN_VENDOR_GAP_RULES[1].id, "dist/**/*.d.ts count: 0"));
  }

  return { packageJson, activeGaps };
}

function exportPathFromMessage(message) {
  if (!Array.isArray(message.path) || message.path[0] !== "exports") return undefined;
  return typeof message.path[1] === "string" ? message.path[1] : undefined;
}

function matchesKnownGap(message, activeGaps) {
  const activeIds = new Set(activeGaps.map((gap) => gap.id));
  const exportPath = exportPathFromMessage(message);

  if (
    activeIds.has("missing-types-condition") &&
    message.code === "TYPES_NOT_EXPORTED" &&
    exportPath !== undefined &&
    PUBLINT_EXPORT_PATHS.includes(exportPath)
  ) {
    return "missing-types-condition";
  }

  if (
    activeIds.has("missing-declaration-artifacts") &&
    message.code === "FILE_DOES_NOT_EXIST" &&
    exportPath !== undefined &&
    PUBLINT_EXPORT_PATHS.includes(exportPath) &&
    message.path.at(-1) === "types"
  ) {
    return "missing-declaration-artifacts";
  }

  return undefined;
}

function isKnownGap(message, activeGaps) {
  return matchesKnownGap(message, activeGaps) !== undefined;
}

function isFile(candidate) {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Why a file on PATH is not a runner this process can start.
 *
 * The three shapes npm writes on Windows beside a real install. Each is named rather than called "not found", because
 * "bun is not on PATH" and "bun is here as a shim Node will not execute" send a reader to different fixes.
 */
function describeUnspawnable(suffix) {
  if (suffix === ".ps1") return "a PowerShell shim, not an executable image";
  if (suffix === ".cmd" || suffix === ".bat") return "a batch shim, which Node refuses to spawn with `shell: false`";
  return "an extensionless shell-script shim, not a Win32 executable image";
}

/**
 * The runner file this process can actually start, or the shims it found instead.
 *
 * The whole PATH is searched before answering: a shim in one directory must not hide a real `bun.exe` in the next.
 * `platform` is a parameter so both shapes are testable from one machine, and neither branch is "if Windows, skip".
 */
export function resolveRunnerExecutable({
  name = PUBLINT_RUNNER,
  env = process.env,
  platform = process.platform,
  fileExists = isFile,
} = {}) {
  const directories = (env.PATH ?? env.Path ?? "")
    .split(platform === "win32" ? ";" : ":")
    .filter((directory) => directory.trim() !== "");
  const suffixes = platform === "win32" ? [".exe", ".cmd", ".bat", ".ps1", ""] : [""];
  const found = [];
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const candidate = path.join(directory, `${name}${suffix}`);
      if (!fileExists(candidate)) continue;
      if (platform !== "win32" || suffix === ".exe") return { ok: true, executable: candidate, found };
      found.push({ path: candidate, reason: describeUnspawnable(suffix) });
    }
  }
  return { ok: false, executable: null, found };
}

/** What a runner printed for `--version`, or `null` when it printed nothing that identifies a version. */
export function runnerVersion(result) {
  if (result?.status !== 0) return null;
  return SEMVER.exec(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)?.[1] ?? null;
}

/** publint's version from the run's own output, or `null` when the output is not a publint run. */
export function publintIdentity(result) {
  return PUBLINT_IDENTITY.exec(`${result?.stdout ?? ""}\n${result?.stderr ?? ""}`)?.[1] ?? null;
}

/** The messages publint reported as machine-readable lines, when it reports any at all. */
export function parsedPublintMessages(result) {
  const text = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
  const messages = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    for (const message of Array.isArray(parsed) ? parsed : [parsed])
      if (message !== null && typeof message === "object" && typeof message.code === "string") messages.push(message);
  }
  return messages;
}

function firstOutputLine(result) {
  const line = `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry !== "");
  if (line === undefined) return "(no output)";
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

/** What a spawned child produced, in one phrase: a spawn failure is named as one, never as silent output. */
function describeResult(result) {
  if (result?.error !== undefined && result?.error !== null)
    return `could not start: ${result.error.code ?? result.error.message}`;
  return firstOutputLine(result);
}

function describeFound(found) {
  if (found.length === 0) return "nothing named that on PATH";
  return found.map((entry) => `${entry.path} (${entry.reason})`).join(", ");
}

/**
 * The three verdicts, decided from what the process actually produced.
 *
 * `not_measured` (exit 2) is reserved for the three proofs above going missing; a run that started, spoke as publint
 * and reported problems is `failed` (its own exit status), never not-measured. The vendor-gap tolerance needs parsed
 * messages, so an exit status nobody can explain stays red.
 */
export function assessPublintRun({ resolution, handshake, run, version, activeGaps = [], executable }) {
  const lines = [];
  if (!resolution.ok) {
    return {
      status: "not_measured",
      exitCode: 2,
      lines: [
        `${NOT_MEASURED}:executable_unresolvable:${PUBLINT_RUNNER} - no file this process can spawn; found ${describeFound(resolution.found)}`,
      ],
    };
  }

  const target = executable ?? resolution.executable;
  if (version === null || version === undefined) {
    return {
      status: "not_measured",
      exitCode: 2,
      lines: [
        `${NOT_MEASURED}:runner_did_not_answer:${target} --version exited ${handshake?.status ?? "null"} - ${describeResult(handshake)}`,
      ],
    };
  }

  const identity = publintIdentity(run);
  if (identity === null) {
    return {
      status: "not_measured",
      exitCode: 2,
      lines: [
        `${NOT_MEASURED}:no_publint_output:${target} exited ${run?.status ?? "null"} printing no "Running publint v…" line - ${describeResult(run)}`,
      ],
    };
  }

  const messages = parsedPublintMessages(run);
  const blocked = messages.filter((message) => !isKnownGap(message, activeGaps));
  const ignored = messages.filter((message) => isKnownGap(message, activeGaps));
  lines.push(
    `publint ran: ${target} (${PUBLINT_RUNNER} ${version}, ${PUBLINT_RUN_ARGS.join(" ")}), publint v${identity}, ` +
      `exit ${run?.status ?? "null"}, messages ${messages.length} (known gaps ${ignored.length}, blocking ${blocked.length})`,
  );

  if (activeGaps.length > 0) {
    lines.push(`Known vendor publint baseline gaps (pending independent vendor task):`);
    for (const gap of activeGaps) lines.push(`- ${gap.id}: ${gap.detail}`);
  }

  if (run?.status === 0) return { status: "passed", exitCode: 0, lines };

  if (messages.length > 0 && blocked.length === 0 && activeGaps.length > 0) {
    lines.push(
      `publint exited ${run.status} and every message it printed maps to a known vendor baseline gap; non-blocking here.`,
    );
    return { status: "passed", exitCode: 0, lines };
  }

  const reason =
    messages.length === 0
      ? "it printed no machine-readable message that could be matched against the vendor baseline"
      : `it printed ${blocked.length} message(s) outside the vendor baseline: ${blocked.map((message) => message.code).join(", ")}`;
  lines.push(`publint failed: exit ${run.status} and ${reason}`);
  return { status: "failed", exitCode: typeof run.status === "number" ? run.status : 1, lines };
}

async function main() {
  const { activeGaps } = await readActiveKnownGaps();
  const resolution = resolveRunnerExecutable();
  const handshake = resolution.ok ? spawnSync(resolution.executable, ["--version"], { encoding: "utf8" }) : null;
  const run = resolution.ok
    ? spawnSync(resolution.executable, [...PUBLINT_RUN_ARGS], {
        cwd: PACKAGE_PATH,
        encoding: "utf8",
        shell: false,
      })
    : null;

  if (run?.stdout) process.stdout.write(run.stdout);
  if (run?.stderr) process.stderr.write(run.stderr.endsWith("\n") ? run.stderr : `${run.stderr}\n`);

  const verdict = assessPublintRun({
    resolution,
    handshake,
    run,
    version: handshake === null ? null : runnerVersion(handshake),
    activeGaps,
  });
  for (const line of verdict.lines) process.stdout.write(`${line}\n`);
  process.exitCode = verdict.exitCode;
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(`check-publint failed: ${error?.message ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
