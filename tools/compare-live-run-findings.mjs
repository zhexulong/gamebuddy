/**
 * Compare two live-run result files and report what changed in the system-level
 * signal between them.
 *
 * Usage:
 *   node tools/compare-live-run-findings.mjs <baseline.result.json> <after.result.json>
 *
 * Exit code 0 = no regressions; 1 = a regression was found; 2 = usage error.
 *
 * Why this exists: a live run is feedback for the SYSTEM (its observation
 * design, action contracts, verifier, orchestration). Reading one run tells you
 * what happened; only comparing two tells you whether a system change helped.
 * Before this tool that comparison was done by hand, and a change that removed a
 * blind-guess finding could silently introduce a delivery rejection elsewhere.
 *
 * It reports the facts a system change is expected to move:
 *   - rejected / accepted / total action counts
 *   - every rejection reason code and its count
 *   - every system finding id and its count
 *   - the terminal verdict, per-stage receipts, and interaction-gate result
 * and classifies each difference as an improvement, a regression, or neutral.
 */
import { existsSync, readFileSync } from "node:fs";

const [baselinePath, afterPath] = process.argv.slice(2);
if (!baselinePath || !afterPath || !existsSync(baselinePath) || !existsSync(afterPath)) {
  console.error("usage: node tools/compare-live-run-findings.mjs <baseline.result.json> <after.result.json>");
  process.exit(2);
}

/** @param {string} p */
function load(p) {
  const parsed = JSON.parse(readFileSync(p, "utf8"));
  return {
    path: p,
    state: parsed.state ?? "unknown",
    ladder: parsed.ladder ?? null,
    findings: parsed.systemFindings ?? {},
    reasons: parsed.systemFindings?.reasonSummaries ?? {},
    interaction: parsed.interactionAssessment ?? null,
    agentTurn: parsed.agentTurn ?? null,
    voice: parsed.voiceResult ?? null,
    receipts: {
      walk: parsed.walkReceipt?.reasonCode ?? null,
      inspect: parsed.inspectReceipt?.reasonCode ?? null,
      load: parsed.loadReceipt?.reasonCode ?? null,
      till: parsed.tillReceipt?.reasonCode ?? null,
      plant: parsed.plantReceipt?.reasonCode ?? null,
      water: parsed.waterReceipt?.reasonCode ?? null,
      harvest: parsed.harvestReceipt?.reasonCode ?? null,
      offer: parsed.offerReceipt?.reasonCode ?? null,
    },
  };
}

const base = load(baselinePath);
const after = load(afterPath);

/** @type {readonly {kind: string, name: string, before: unknown, after: unknown, verdict: "improvement"|"regression"|"neutral", detail: string}[]} */
const rows = [];

/**
 * A counter that should go DOWN. Lower is better, so a decrease is an
 * improvement and an increase is a regression.
 */
function compareCounter(name, before, after, detail) {
  const b = Number(before ?? 0);
  const a = Number(after ?? 0);
  if (b === a) return;
  rows.push({
    kind: "counter",
    name,
    before: b,
    after: a,
    verdict: a < b ? "improvement" : "regression",
    detail,
  });
}

compareCounter(
  "rejectedCount",
  base.findings.rejectedCount,
  after.findings.rejectedCount,
  "actions the system refused; every one is a system-side signal",
);
compareCounter(
  "findingCount",
  (base.findings.findings ?? []).length,
  (after.findings.findings ?? []).length,
  "distinct system findings raised by this run",
);

// Per reason code: appearing where it did not before is a regression; vanishing
// is an improvement. Both directions stay visible.
const reasonCodes = new Set([...Object.keys(base.reasons), ...Object.keys(after.reasons)]);
for (const code of [...reasonCodes].sort()) {
  const b = Number(base.reasons[code] ?? 0);
  const a = Number(after.reasons[code] ?? 0);
  if (b === a) continue;
  rows.push({
    kind: "reason",
    name: code,
    before: b,
    after: a,
    verdict: a < b ? "improvement" : "regression",
    detail: "rejection reason frequency",
  });
}

// Per finding id: same rule, and a newly introduced finding id is always a
// regression regardless of count, because it names a defect class that was
// absent before.
const countFindings = (run) => {
  const map = {};
  for (const finding of run.findings.findings ?? []) {
    map[finding.id] = Number(finding.count ?? 1);
  }
  return map;
};
const baseFindings = countFindings(base);
const afterFindings = countFindings(after);
const findingIds = new Set([...Object.keys(baseFindings), ...Object.keys(afterFindings)]);
for (const id of [...findingIds].sort()) {
  const b = baseFindings[id] ?? 0;
  const a = afterFindings[id] ?? 0;
  if (b === a) continue;
  rows.push({
    kind: "finding",
    name: id,
    before: b,
    after: a,
    verdict: a < b ? "improvement" : "regression",
    detail: "system finding count",
  });
}

// Stage-level facts that must not silently get worse. Booleans have an obvious
// direction (a settled turn or a passed gate is better), so they are graded;
// opaque values such as a receipt reason code only change, they do not rank.
const compareStage = (name, before, after, detail) => {
  if (before === after) return;
  if (typeof before === "boolean" && typeof after === "boolean") {
    rows.push({
      kind: "stage",
      name,
      before,
      after,
      verdict: after ? "improvement" : "regression",
      detail,
    });
    return;
  }
  if (before === null) {
    rows.push({ kind: "stage", name, before, after, verdict: "improvement", detail });
    return;
  }
  if (after === null) {
    rows.push({ kind: "stage", name, before, after, verdict: "regression", detail });
    return;
  }
  rows.push({ kind: "stage", name, before, after, verdict: "neutral", detail });
};

compareStage("state", base.state, after.state, "terminal verdict of the run");
compareStage(
  "interaction.passed",
  base.interaction?.passed ?? null,
  after.interaction?.passed ?? null,
  "companion interaction gate",
);
compareStage("agentTurn.settled", base.agentTurn?.settled ?? null, after.agentTurn?.settled ?? null, "agent turn settled");
compareStage("voice.state", base.voice?.state ?? null, after.voice?.state ?? null, "voice lane result");

for (const stage of Object.keys(base.receipts)) {
  compareStage(
    `receipt.${stage}`,
    base.receipts[stage],
    after.receipts[stage],
    "stage receipt reason code",
  );
}

const regressions = rows.filter((row) => row.verdict === "regression");
const improvements = rows.filter((row) => row.verdict === "improvement");

console.log(
  JSON.stringify(
    {
      schema: "gamebuddy_live_run_findings_comparison/v1",
      baseline: base.path,
      after: after.path,
      summary: {
        improvements: improvements.length,
        regressions: regressions.length,
        neutral: rows.length - improvements.length - regressions.length,
      },
      rows,
    },
    null,
    2,
  ),
);

if (regressions.length > 0) {
  console.error(
    `REGRESSION: ${regressions.length} system signal(s) got worse: ${regressions.map((row) => row.name).join(", ")}`,
  );
  process.exit(1);
}
process.exit(0);
