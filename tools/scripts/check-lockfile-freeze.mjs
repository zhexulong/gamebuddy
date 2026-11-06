/**
 * Does this commit change a lockfile without re-freezing the artifacts that record it?
 *
 * `check:dependency-risk` compares three lockfile hashes against two frozen copies of them
 * (`security/dependency-risk-*`). When a commit changes `pnpm-lock.yaml`, those copies no longer
 * describe the tree and the gate goes red - correctly, because a risk certificate that names a tree
 * it was not computed on is not a certificate.
 *
 * Twice in one session the same thing happened: `f0694ac0` added a coverage devDependency and did not
 * re-freeze, then the minimatch bump did it again. Both times the gate was right and both times nobody
 * ran it, because nothing connects "I changed the lockfile" to "readings about the lockfile exist".
 *
 * Scope, deliberately narrow like its neighbours in the parent hook:
 *   - Only fires when a lockfile is IN THIS COMMIT. A neighbour's lockfile edit cannot block you.
 *   - Only runs the dependency-risk gate, not the tree-wide ratchets (those fail on a neighbour's file).
 *   - Prints the gate's own finding rather than a summary, so the fix is visible: re-run the snapshot's
 *     `scanner.command`, never hand-edit a hash.
 *   - Runs the gate from the WORKING TREE on purpose. The hashes are read from disk, so a tree that is
 *     already re-frozen passes here, which is the state the author must be in to commit a coherent unit.
 */
import { execFileSync } from "node:child_process";
import { cleanOutputLines } from "../lib/subprocess-output.mjs";

const LOCKFILES = new Set([
  "pnpm-lock.yaml",
  "vendor/magic-context/bun.lock",
  "integrations/stardew/packages.lock.json",
]);
const GATE = "tools/check-dependency-risk.mjs";

let staged;
try {
  staged = cleanOutputLines(
    execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR"], {
      encoding: "utf8",
      maxBuffer: 1 << 26,
    }),
  ).filter((path) => path.length > 0);
} catch {
  console.log("dependency-risk-freeze: could not read the staged set; skipping (CI still runs the gate)");
  process.exit(0);
}

const lockfiles = staged.filter((path) => LOCKFILES.has(path));
if (lockfiles.length === 0) {
  console.log("dependency-risk-freeze: this commit changes no lockfile, so no reading about one can go stale");
  process.exit(0);
}

console.log(
  `dependency-risk-freeze: this commit changes ${lockfiles.join(", ")}, so the frozen readings must match it`,
);

try {
  const output = execFileSync("node", [GATE], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const line = cleanOutputLines(output.trim()).slice(-1)[0];
  console.log(`dependency-risk-freeze: ${line}`);
  process.exit(0);
} catch (error) {
  const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
  if (typeof error.status !== "number") {
    console.log(`dependency-risk-freeze: could not run ${GATE}; CI still runs it\n${detail || error.message}`);
    process.exit(0);
  }
  console.error(
    [
      "dependency-risk-freeze: this commit changes a lockfile and the frozen readings do not describe the tree.",
      "",
      detail,
      "",
      "Re-freeze by running the snapshot's own scanner command - never hand-edit a hash:",
      "  node tools/check-dependency-risk.mjs --help   # prints the scanner it expects",
      "",
      "Escape hatch: git commit --no-verify (CI will still refuse the push).",
    ].join("\n"),
  );
  process.exit(1);
}
