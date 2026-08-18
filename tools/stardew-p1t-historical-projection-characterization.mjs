import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
export const PINNED_COMMIT = "b1786160e98d3f110a4fdf80e9b2d2504de6e12d";
export const PINNED_PATH = "integrations/stardew/ExecutionManager.cs";
export const PINNED_SHA256 = "6630fb40e2c97b287acb8e745d2c5924f3ba9d23a2157c12c59c25f52f0683c5";

function fail(code) {
  throw new Error(`stardew_p1t_historical_projection_${code}`);
}

async function runGit(args) {
  try {
    const { stdout } = await execFile("git", args, { cwd: process.cwd(), encoding: "utf8" });
    return stdout;
  } catch {
    fail("git_unavailable_or_object_missing");
  }
}

function methodBody(source) {
  const signature = "private static IReadOnlyList<string> CreateCapabilities(IReadOnlySet<string>? enabledActions)";
  if (source.split(signature).length !== 2) fail("method_signature_drift");
  const signatureOffset = source.indexOf(signature);
  const opening = source.indexOf("{", signatureOffset + signature.length);
  if (opening === -1 || !/^\s*$/.test(source.slice(signatureOffset + signature.length, opening))) fail("method_form_drift");
  let depth = 0;
  for (let index = opening; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) return source.slice(opening + 1, index);
  }
  fail("method_braces_drift");
}

function extractCreateCapabilitiesMembership(source) {
  if (typeof source !== "string") fail("source_invalid");
  const body = methodBody(source).replaceAll("\r\n", "\n").replace(/^\n/, "").trimEnd();
  const lines = body.split("\n");
  const base = /^        List<string> result = new\(\) \{ "([a-z][a-z0-9_]*)", "([a-z][a-z0-9_]*)" \};$/;
  const condition = /^        if \(enabledActions\?\.Contains\("([a-z][a-z0-9_]*)"\) == true\)$/;
  const insertion = /^            result\.Insert\(0, "([a-z][a-z0-9_]*)"\);$/;
  const membership = [];
  const first = base.exec(lines.shift());
  if (!first) fail("method_form_drift");
  membership.push(first[1], first[2]);
  while (lines.length > 1) {
    const enabled = condition.exec(lines.shift());
    const projected = insertion.exec(lines.shift());
    if (!enabled || !projected || enabled[1] !== projected[1]) fail("method_membership_form_drift");
    membership.push(enabled[1]);
  }
  if (lines.length !== 1 || lines[0] !== "        return result;") fail("method_form_drift");
  if (new Set(membership).size !== membership.length) fail("method_membership_duplicate");
  return Object.freeze(membership);
}

export async function characterizeHistoricalProjection({ gitRunner = runGit } = {}) {
  const commitType = await gitRunner(["cat-file", "-t", PINNED_COMMIT]);
  if (commitType.trim() !== "commit") fail("commit_object_drift");
  const resolvedCommit = await gitRunner(["rev-parse", `${PINNED_COMMIT}^{commit}`]);
  if (resolvedCommit.trim() !== PINNED_COMMIT) fail("commit_resolution_drift");
  const objectSpec = `${PINNED_COMMIT}:${PINNED_PATH}`;
  const blobType = await gitRunner(["cat-file", "-t", objectSpec]);
  if (blobType.trim() !== "blob") fail("blob_object_drift");
  const source = await gitRunner(["show", objectSpec]);
  const sha256 = createHash("sha256").update(source).digest("hex");
  if (sha256 !== PINNED_SHA256) fail("blob_hash_drift");
  const membership = extractCreateCapabilitiesMembership(source);
  const includesTreeFirstHit = membership.includes("tree_first_hit");
  const excluded = ["place_crab_pot", "bait_crab_pot", "chop_tree_source"];
  if (!includesTreeFirstHit || excluded.some((actionId) => membership.includes(actionId))) fail("expected_drift_fact_missing");
  return Object.freeze({
    artifactKind: "stardew_p1t_historical_projection_characterization/v1",
    source: Object.freeze({ commit: PINNED_COMMIT, path: PINNED_PATH, sha256 }),
    verification: Object.freeze({ expectedDriftVerified: true, projectedActionCount: membership.length }),
    authority: "none",
    liveClosure: "none",
  });
}

if (import.meta.main) {
  try {
    console.log(JSON.stringify(await characterizeHistoricalProjection()));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
