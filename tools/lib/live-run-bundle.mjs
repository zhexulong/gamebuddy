import path from "node:path";

/**
 * The launcher names a run's bundle `_<scenario>-<label>.result.json`, so `label` is a path component. Keeping these
 * four decisions here (rather than inline in the iterate script) is what lets the mask defect that cost round40 its
 * real result - a stale bundle read as if it were this attempt's - be asserted instead of described.
 */

export const RESULT_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u;

export function assertResultLabel(label) {
  if (typeof label !== "string" || !RESULT_LABEL_PATTERN.test(label) || label.includes(".."))
    throw new Error(`invalid label for a result file name: ${JSON.stringify(label)}`);
  return label;
}

export function planResultFile({ repo, scenario, label }) {
  assertResultLabel(label);
  const toolsDir = path.resolve(repo, "tools");
  const file = path.join(toolsDir, `_${scenario}-${label}.result.json`);
  if (path.dirname(path.resolve(file)) !== toolsDir) throw new Error(`the result path is not inside tools/: ${file}`);
  return file;
}

/**
 * A bundle this launch did not write is not this run's answer, whatever it says. Two seconds of tolerance because a
 * file system clock can lead the process clock by a tick.
 */
export function assessResultFreshness({ mtimeMs, launchedAtMs, toleranceMs = 2000 }) {
  if (typeof mtimeMs !== "number" || typeof launchedAtMs !== "number")
    throw new Error("assessResultFreshness needs two numbers");
  const behindMs = launchedAtMs - mtimeMs;
  if (behindMs <= toleranceMs) return { fresh: true, behindMs: 0 };
  return { fresh: false, behindMs };
}

export function supersededResultName(file, nowMs) {
  if (!file.endsWith(".result.json")) throw new Error(`not a result bundle name: ${file}`);
  return `${file.slice(0, -".result.json".length)}.result.superseded-${String(nowMs)}.json`;
}
