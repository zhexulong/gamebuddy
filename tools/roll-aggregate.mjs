#!/usr/bin/env node
/**
 * Roll aggregator for the observation loop (design §observation loop).
 *
 * Single-run verdicts stay deterministic (receipts / assembly facts); text-level
 * quality is a RANDOM DRAW, so whether a prompt/context change actually beats
 * its baseline can only be decided ACROSS runs. This tool does exactly that:
 *
 *   --runs <dir|files...>        one group: summarize the rolls per
 *                                (ladder + promptSha256) group
 *   --base <...> --changed <...> two groups: per-metric mean difference with a
 *                                Welch 95% interval; inside the noise window is
 *                                "no_conclusion" — never claimed as an
 *                                improvement.
 *
 * Monitoring data comes from the `observation` block each runner writes on
 * every real run. Runs without an observation block are excluded from
 * distribution stats (counted in `excludedOldRuns`) — an old run must not be
 * silently treated as a zero-draw sample.
 *
 * This is a diagnostic tool, not a gate: exit 0 on success (usage error = 2).
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const usage = `usage: node tools/roll-aggregate.mjs --runs <dir|files...>
       node tools/roll-aggregate.mjs --base <dir|files...> --changed <dir|files...>`;

/**
 * Metric definitions: name → observation field (or null for per-run gate),
 * plus the direction that counts as an improvement. A change in the WRONG
 * direction is `regressed`; a neutral metric only reports the difference.
 */
const METRICS = [
  { name: "gatePassed", field: null, direction: "higher" },
  { name: "contextAssembled", field: "contextAssembled", direction: "higher" },
  { name: "worldBookAssembled", field: "worldBookAssembled", direction: "higher" },
  { name: "rejectionRate", field: "rejectionRate", direction: "lower" },
  { name: "actionCount", field: "actionCount", direction: "neutral" },
  { name: "turnMs", field: "turnMs", direction: "lower" },
  { name: "summaryChars", field: "summaryChars", direction: "neutral" },
];

async function collectRunFiles(spec) {
  const files = [];
  for (const entry of spec) {
    let stat;
    try {
      stat = await import("node:fs/promises").then((fs) => fs.stat(entry));
    } catch {
      throw new Error(`no_such_path:${entry}`);
    }
    if (stat.isDirectory()) {
      const names = await readdir(entry);
      for (const name of names) if (name.endsWith(".json")) files.push(join(entry, name));
    } else {
      files.push(entry);
    }
  }
  return files;
}

async function loadRuns(files) {
  const runs = [];
  const excludedOldRuns = [];
  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch {
      excludedOldRuns.push({ file, reason: "unparseable" });
      continue;
    }
    const observation = parsed?.observation;
    if (observation === undefined || observation === null) {
      excludedOldRuns.push({ file, reason: "no_observation_block" });
      continue;
    }
    runs.push({ file, run: parsed, observation });
  }
  return { runs, excludedOldRuns };
}

function groupRuns(runs) {
  const groups = new Map();
  for (const entry of runs) {
    const obs = entry.observation;
    const key = `${obs.ladder ?? "?"}|${obs.promptSha256 ?? "unknown"}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { key, ladder: obs.ladder ?? "?", promptSha256: obs.promptSha256 ?? "unknown", runs: [] };
      groups.set(key, group);
    }
    group.runs.push(entry);
  }
  return [...groups.values()];
}

function valueOf(entry, metric) {
  if (metric.field === null) return entry.run.state === "passed" ? 1 : 0;
  const value = entry.observation[metric.field];
  // Booleans are counts too (assembly facts): true = 1, false = 0. Anything
  // non-numeric is an unobserved sample, never a silent zero.
  if (typeof value === "boolean") return value ? 1 : 0;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function summarize(group) {
  const values = {};
  let count = 0;
  for (const metric of METRICS) {
    const samples = group.runs.map((entry) => valueOf(entry, metric)).filter((v) => v !== null);
    if (samples.length === 0) {
      values[metric.name] = null;
      continue;
    }
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const variance =
      samples.length > 1
        ? samples.reduce((a, b) => a + (b - mean) ** 2, 0) / (samples.length - 1)
        : 0;
    values[metric.name] = { n: samples.length, mean, stddev: Math.sqrt(variance) };
    count = samples.length;
  }
  return { key: group.key, ladder: group.ladder, promptSha256: group.promptSha256, count, values };
}

function compareGroups(base, changed) {
  const verdicts = [];
  for (const metric of METRICS) {
    const a = base.values[metric.name];
    const b = changed.values[metric.name];
    if (a === null || b === null || a.n < 3 || b.n < 3) {
      verdicts.push({
        metric: metric.name,
        verdict: "insufficient_samples",
        baseN: a?.n ?? 0,
        changedN: b?.n ?? 0,
      });
      continue;
    }
    const se = Math.sqrt((a.stddev ** 2) / a.n + (b.stddev ** 2) / b.n);
    const diff = b.mean - a.mean;
    const halfWidth = 1.96 * se;
    // A statistically distinguishable difference is only an improvement when it
    // moves in the metric's good direction; a neutral metric reports the delta
    // without claiming a win.
    const outsideNoise = Math.abs(diff) > halfWidth;
    const better =
      metric.direction === "higher" ? diff > 0 : metric.direction === "lower" ? diff < 0 : false;
    const verdict = !outsideNoise
      ? "no_conclusion"
      : metric.direction === "neutral"
        ? "changed"
        : better
          ? "improved"
          : "regressed";
    verdicts.push({
      metric: metric.name,
      direction: metric.direction,
      verdict,
      diff: round(diff),
      ci: [round(diff - halfWidth), round(diff + halfWidth)],
      baseMean: round(a.mean),
      changedMean: round(b.mean),
      baseN: a.n,
      changedN: b.n,
    });
  }
  return verdicts;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

async function main(argv) {
  const args = [...argv];
  const flags = new Map();
  let mode = "runs";
  let current = null;
  for (const arg of args) {
    if (arg === "--runs" || arg === "--base" || arg === "--changed") {
      mode = arg.slice(2);
      current = mode;
      if (!flags.has(current)) flags.set(current, []);
    } else if (arg === "--help" || arg === "-h") {
      console.log(usage);
      return 0;
    } else {
      if (current === null) throw new Error(usage);
      flags.get(current).push(arg);
    }
  }
  if (!flags.has("runs") && (!flags.has("base") || !flags.has("changed"))) throw new Error(usage);

  const result = { summary: {} };
  if (flags.has("runs")) {
    const files = await collectRunFiles(flags.get("runs"));
    const { runs, excludedOldRuns } = await loadRuns(files);
    const groups = groupRuns(runs);
    result.mode = "runs";
    result.excludedOldRuns = excludedOldRuns;
    result.groups = groups.map((group) => summarize(group));
  } else {
    const baseFiles = await collectRunFiles(flags.get("base"));
    const changedFiles = await collectRunFiles(flags.get("changed"));
    const base = await loadRuns(baseFiles);
    const changed = await loadRuns(changedFiles);
    const baseGroups = groupRuns(base.runs);
    const changedGroups = groupRuns(changed.runs);
    if (baseGroups.length !== 1 || changedGroups.length !== 1) {
      result.mode = "compare";
      result.excludedOldRuns = { base: base.excludedOldRuns, changed: changed.excludedOldRuns };
      result.verdicts = [
        {
          metric: "grouping",
          verdict: baseGroups.length === 1 && changedGroups.length === 1 ? "ok" : "mixed_groups",
          baseGroups: baseGroups.map((g) => g.key),
          changedGroups: changedGroups.map((g) => g.key),
        },
      ];
    } else if (baseGroups[0].key !== changedGroups[0].key) {
      result.mode = "compare";
      result.excludedOldRuns = { base: base.excludedOldRuns, changed: changed.excludedOldRuns };
      result.verdicts = [
        {
          metric: "grouping",
          verdict: "group_mismatch",
          baseKey: baseGroups[0].key,
          changedKey: changedGroups[0].key,
        },
      ];
    } else {
      result.mode = "compare";
      result.key = baseGroups[0].key;
      result.excludedOldRuns = { base: base.excludedOldRuns, changed: changed.excludedOldRuns };
      result.base = summarize(baseGroups[0]);
      result.changed = summarize(changedGroups[0]);
      result.verdicts = compareGroups(result.base, result.changed);
    }  }
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(String(error?.message ?? error));
    process.exitCode = 2;
  },
);