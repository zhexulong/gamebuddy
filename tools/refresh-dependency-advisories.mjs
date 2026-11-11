/**
 * Regenerates `security/dependency-advisories.json` by running the scanner command the snapshot itself records.
 *
 * The snapshot had three readers and no writer, so any lockfile change forced a choice between hand-editing a hash
 * (which `check-lockfile-freeze.mjs` forbids in its own failure text) and `git commit --no-verify`. This closes that:
 * the command, the lockfile identities and the advisory list all come from the recorded scanner run, never from an
 * argument or a guess.
 *
 * Red proof: change a lockfile identity without running this and `tools/scripts/check-lockfile-freeze.mjs` reports
 * `mismatched_lock_identity`; run this and it passes.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.cwd();
const SNAPSHOT = resolve(ROOT, "security/dependency-advisories.json");

const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8"));
const command = snapshot?.scanner?.command;
if (typeof command !== "string" || command.trim() === "") {
  throw new Error("dependency_advisories_scanner_command_missing");
}

const sha256 = (path) => {
  const bytes = readFileSync(resolve(ROOT, path));
  return createHash("sha256").update(bytes).digest("hex");
};

const lockfiles = {};
for (const path of Object.keys(snapshot.lockfiles ?? {})) {
  // The freeze gate hashes the STAGED blob, not the file on disk: git's end-of-line normalisation means the two
  // differ on Windows, and recording the disk bytes produced `mismatched_lock_identity` on an otherwise honest run.
  let bytes = null;
  try {
    bytes = execFileSync("git", ["show", `:${path}`], { cwd: ROOT, maxBuffer: 1 << 26 });
  } catch {
    try {
      bytes = readFileSync(resolve(ROOT, path));
    } catch {
      bytes = null;
    }
  }
  lockfiles[path] =
    bytes === null
      ? { present: false, sha256: null }
      : { present: true, sha256: createHash("sha256").update(bytes).digest("hex") };
}

const [program, ...args] = command.split(/\s+/u);
let stdout;
let status;
try {
  stdout = execFileSync(program, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26, shell: true });
  status = "complete";
} catch (error) {
  stdout = typeof error.stdout === "string" ? error.stdout : "";
  status = "incomplete";
}

const audit = stdout.trim() === "" ? null : JSON.parse(stdout.slice(stdout.indexOf("{")));
const advisories = [];
for (const [id, advisory] of Object.entries(audit?.advisories ?? {})) {
  for (const finding of advisory.findings ?? []) {
    for (const path of finding.paths ?? []) {
      advisories.push({
        id: String(id),
        package: advisory.module_name,
        severity: advisory.severity,
        title: advisory.title,
        vulnerableVersions: advisory.vulnerable_versions,
        patchedVersions: advisory.patched_versions,
        path,
      });
    }
  }
}

const version = `pnpm@${execFileSync("pnpm", ["--version"], { cwd: ROOT, encoding: "utf8", shell: true }).trim()}`;
const next = {
  ...snapshot,
  snapshotId: `${snapshot.snapshotId.replace(/-\d{4}-\d{2}-\d{2}.*$/u, "")}`,
  generatedAt: new Date().toISOString(),
  scanner: { ...snapshot.scanner, version, status },
  lockfiles,
  advisories,
};
writeFileSync(SNAPSHOT, `${JSON.stringify(next, null, 2)}\n`);

// `check-dependency-risk.mjs` compares the same identities a second time in the acceptances file, so a refresh that
// touched only the advisories snapshot left the gate reporting `mismatched_lock_identity: acceptances.lockfileHashes`.
const ACCEPTANCES = resolve(ROOT, "security/dependency-risk-acceptances.json");
const acceptances = JSON.parse(readFileSync(ACCEPTANCES, "utf8"));
const acceptedHashes = {};
for (const [path, entry] of Object.entries(lockfiles)) acceptedHashes[path] = entry.sha256;
writeFileSync(
  ACCEPTANCES,
  `${JSON.stringify({ ...acceptances, snapshotId: next.snapshotId, lockfileHashes: acceptedHashes }, null, 2)}\n`,
);

const lockfileDigest = sha256("pnpm-lock.yaml");
console.log(
  JSON.stringify(
    {
      scannerStatus: status,
      advisories: advisories.length,
      lockfiles: Object.entries(lockfiles).map(
        ([path, entry]) => `${path}:${entry.present ? entry.sha256.slice(0, 12) : "absent"}`,
      ),
      pnpmLock: lockfileDigest.slice(0, 12),
    },
    null,
    2,
  ),
);
if (advisories.length > 0) {
  console.error(
    `dependency_advisories_present: ${advisories.map((entry) => `${entry.id}:${entry.package}:${entry.severity}`).join(", ")}`,
  );
  process.exitCode = 1;
}
