#!/usr/bin/env node
/**
 * Guard: a declared quality gate must show a red proof - a falsifier, not a promise.
 *
 * WHY (measured 2026-11-01)
 *
 * Three gates were wrong at once and none of them said so. `problem-code.13` was red before the session
 * started and nobody noticed, because its regex needed two identifiers on one line and prettier folded
 * them across three: a gate that cannot run is indistinguishable from a gate that passes.
 * `affordance-action-agreement` carried a "radar escape" branch true for all seven action kinds, so one
 * of its assertions had never distinguished anything. And `check-live-run-verdict-guards.mjs` exists
 * only because "a gate whose default on missing evidence is PASS" keeps recurring.
 *
 * The tree's existing answer to the same question is `tools/lib/harness-conformance.mjs`'s
 * `checkGateFalsifiers`, and it does not hold. Measured here: (1) its population is a `tools/check-*.mjs`
 * directory scan, so a gate declared in `package.json` outside `tools/` is invisible to it; (2) it
 * accepts a gate on the strength of a hand-maintained `GATES_WITHOUT_FALSIFIER` reason whose claim
 * ("falsifier in its test") it never resolves, so an entry can outlive the test it names; (3) it is red
 * at HEAD - four gate files have neither a printed report nor an entry - and no job runs its test file,
 * so the gap survived. A meta-gate cannot fail where nobody looks.
 *
 * THE POPULATION is the union `tools/lib/gate-population.mjs` derives once for this audit AND for
 * `tools/lib/harness-conformance.mjs`, so the two tools cannot disagree about how many gates there are:
 *   A. every `package.json` script named like a gate (`audit:` / `check:` / `test:`), with the files its
 *      command runs as that gate's entry points;
 *   B. every `tools/check-*.mjs` file no script names - today 16 of them, which is the half check 5 of
 *      the harness-conformance suite cannot see.
 * The two halves overlap by construction and are merged on the entry file, so a gate has one record. The
 * conformance suite reads the same derivation and judges only the members whose default run it can execute;
 * it prints the bucket it excluded and why, and the census line is built from these numbers.
 *
 * THE POPULATION IS THE INDEX (`tools/lib/indexed-sources.mjs`), because a gate that is not in the index
 * cannot be run by CI and therefore cannot be proven or owed anything yet. Measured 2026-11-12: an untracked
 * `tools/check-source-shape-readers.mjs` from another lane was counted as a proven gate here and as an
 * undeclared one there, so the census went red for every lane over a file no commit contained. It is now
 * dropped from the population and published by name as `untracked_not_counted N: <paths>`. The restriction
 * is about which gate is judged, never about how its claim is parsed: a gate that IS in the index has its
 * markers read exactly as before, and one whose marker cannot be read still fails the run.
 *
 * THE QUESTION, per gate: has this gate been shown to fail on a real injected violation? The answer is a
 * `red-proof:` marker in a comment line of a file the gate owns - its entry file or its falsifier suite -
 * naming the kind of falsifier and the violation it injects:
 *
 *   red-proof: <kind> <the violation injected -> the finding or exit the gate produced> (where it lives)
 *
 * with `<kind>` one of `inject`, `history` (a real shipped defect replayed), `fixture` (a known-rejected
 * input) or `self-check` (the gate exercises its own rules on violating samples). A marker is read from
 * COMMENT LINES ONLY, so a gate cannot satisfy itself with the regex it uses to find markers; every
 * repo-relative path a marker names must exist, or the claim points at nothing; a kind outside that set
 * is reported rather than skipped.
 *
 * THE FIFTH KIND, `external`, is for a gate whose rule lives in another program - `dotnet test`,
 * `pnpm knip`, `depcruise --config ...`, a project runner - and behind a mount this repository does not
 * carry. Such a gate cannot be turned red by any file here, so the honest record is the runner plus the
 * failure that runner produces, in one comment line:
 *
 *   `red-proof: external <runner command> — <how it fails>`
 *
 * Two rules make that label a claim rather than a silencer. The command must be the one the repository
 * actually invokes - it is matched against every `package.json` script and every workflow, and a command
 * found nowhere there is `external_runner_not_invoked:<gate>:<command>` and fails the run. The `<how it
 * fails>` clause must be present, or the marker is unreadable like any other malformed claim. And the
 * label is only written after the failure was seen once: break the thing the runner checks, run the
 * runner, watch it exit non-zero. An external gate leaves the population that owes an in-repo proof, so
 * its baseline entry is stale and must go - the ratchet tightens in this direction too.
 *
 * THE BASELINE, and why this gate is not simply red. Measured at this commit, of 220 declared gates: 11
 * carry a red proof and 209 do not - two of those are aggregates whose members are unproven, and 6 cannot
 * be assessed at all (their commands run `pnpm`, `dotnet` or `depcruise` over a project or a directory, so
 * no single file in this repo holds their rules). Writing 209 plausible falsifiers would manufacture the
 * exact illusion this gate exists to remove, so the reading is published instead of invented:
 * `tools/gate-red-proof-baseline.json` records those 209 gates. The ratchet over that recording is what
 * the gate enforces -
 *
 *   * a declared gate that is unproven and NOT in the baseline is a finding (a new gap cannot arrive
 *     quietly, which is the whole failure being prevented);
 *   * a baseline entry that is proven now, or whose gate no longer exists, is a finding (the baseline
 *     only tightens: add a proof, delete the entry);
 *   * a marker that cannot be read - wrong kind, or a pointer to a file that is gone - is a finding
 *     regardless of the baseline, because a claim nobody can read is a claim nobody can check.
 *
 * The baseline is a record of measured debt, not a claim that the debt is acceptable: every run prints
 * the proven set, the gap count and the totals, and `--gaps` prints every gate still owing a proof.
 * The same shape as `tools/scripts/check-format-ratchet.mjs`, for the same reason.
 *
 * Usage:
 *   node tools/audit-gate-red-proofs.mjs              # the ratchet; exit 1 on a new or stale entry
 *   node tools/audit-gate-red-proofs.mjs --gaps       # every gate that still owes a red proof
 *   node tools/audit-gate-red-proofs.mjs --json       # every gate's record, with its proofs
 *   node tools/audit-gate-red-proofs.mjs --run        # also execute the declared falsifier suites
 *   node tools/audit-gate-red-proofs.mjs --update     # re-record the baseline, in its own commit
 *   node tools/audit-gate-red-proofs.mjs --root <dir> # the gate's own fixture
 *
 * red-proof: inject  deleting a gate's marker in a synthetic tree -> `no_red_proof` names that gate, its
 *                    aggregate, and `baseline_entry_stale` for the entry the proof had closed
 *                    (tools/audit-gate-red-proofs.test.mjs)
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { POPULATION_FIELDS, populationFieldPattern } from "./lib/assert-non-vacuous.mjs";
import { describeUntracked, indexedGatePopulation } from "./lib/indexed-sources.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = "tools/gate-red-proof-baseline.json";

/** `red-proof: <kind> <claim>`; the claim may continue on the following comment lines. */
const RED_PROOF = /red-proof:\s*([A-Za-z][A-Za-z-]*)\s+([\s\S]{12,})/u;
/** The kinds that prove a gate can fail by showing this repository's own falsifier fail. */
const PROOF_KINDS = new Set(["inject", "history", "fixture", "self-check"]);
/** The kind for a gate whose rule lives in another program: it is falsified by that program, not by a file here. */
const EXTERNAL_KIND = "external";
/** Every kind a marker may carry; one outside this set is reported rather than skipped. */
const KINDS = new Set([...PROOF_KINDS, EXTERNAL_KIND]);
/** An `external` claim's two halves: the runner command, and the failure that runner is expected to produce. */
const EXTERNAL_CLAIM = /^([\s\S]+?)\s+[—–]\s+([\s\S]+)$/u;
/** A repo-relative path inside a claim that must resolve. Longest extension first, or `x.json` resolves to `x.js`. */
const POINTER =
  /(?:tools|host|dialogue-web|integrations|scripts|desktop|vendor|\.github|packages)\/[\w./-]+\.(?:json|mjs|cjs|tsx|yml|ps1|cs|js|ts|py)/gu;
/** A marker is prose: read from a comment line only. */
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*|#|--)/u;
/** A marker's claim may continue this many comment lines below its anchor. */
const MARKER_WINDOW = 3;
/** A script whose command names another gate script is an aggregate: it inherits, it has no rule of its own. */
const MEMBER_SCRIPT = /(?:^|[\s"'&|]+)((?:audit|check|test):[\w:-]+)/gu;
/**
 * A gate that prints a self-verification report: a JSON object carrying the gate's own id.
 *
 * The next two patterns are a STATIC reading of the gate's source, which is the only reading this audit can make of
 * 300 gates without running them. They answer one question - could a zero population in this gate be seen? - and say
 * so in the census line, so the number is never mistaken for an execution.
 */
const REPORT_LITERAL = /JSON\.stringify\(\{[^}]*\bgate\b|\bgate["']?\s*:\s*["'`]/u;
/** The population fields `tools/lib/assert-non-vacuous.mjs` reads: name none of them and a zero is invisible. */
const POPULATION_FIELD = populationFieldPattern();

const stripDecoration = (line) => line.replace(/^\s*(?:\/\*\*?|\*|\/\/|#|--)\s?/u, "").trim();

const read = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** Every `red-proof:` marker in the comment lines of one file. */
export function readRedProofMarkers({ root, file }) {
  const text = read(join(root, file));
  if (text === null) return [];
  const lines = text.split("\n");
  const markers = [];
  // A marker is an ANCHOR line (`red-proof:` on it) plus its continuation lines; a continuation line is
  // never a second marker, or one claim would be counted twice with its tail truncated.
  let consumedUntil = -1;
  lines.forEach((line, index) => {
    if (index <= consumedUntil || !COMMENT_LINE.test(line)) return;
    // An anchor is the keyword followed by a word-shaped kind. Prose that names the keyword - this file's own
    // documentation, including the `<kind>` template line - is documentation, not a claim, so it is skipped;
    // a wrong kind such as `vibes` is word-shaped and is reported below rather than skipped.
    if (!/^red-proof:\s+[A-Za-z][A-Za-z-]*\s/u.test(stripDecoration(line))) return;
    const window = [];
    for (let cursor = index; cursor < Math.min(index + MARKER_WINDOW, lines.length); cursor += 1) {
      if (!COMMENT_LINE.test(lines[cursor])) break;
      window.push(lines[cursor]);
    }
    consumedUntil = index + window.length - 1;
    // Decoration is stripped per line and the lines are joined with a space, so a path a continuation
    // line names stays one token for the pointer check.
    const claim = window.map(stripDecoration).join(" ").trim();
    const match = RED_PROOF.exec(claim);
    if (match === null) {
      markers.push({ file, line: index + 1, kind: null, claim: line.trim(), valid: false });
      return;
    }
    markers.push({ file, line: index + 1, kind: match[1].toLowerCase(), claim: match[2].trim(), valid: true });
  });
  return markers;
}

/**
 * The markers a gate declares in `package.json`'s `gateRedProofs` map, keyed by gate id.
 *
 * A gate whose command runs a project (`dotnet test ...`, `pnpm knip && pnpm knip:production`, a workspace filter)
 * names no file in this repository, so it has no file to carry a comment marker and could never be recorded at all.
 * The declaration lives beside the command that defines it - in the same file, one string per gate - and is parsed by
 * the same rules as a comment marker:
 *
 *   "gateRedProofs": { "check:knip": "external pnpm knip && pnpm knip:production - an unused export fails the run" }
 */
export function declaredRedProofMarkers(root) {
  const parsed = JSON.parse(read(join(root, "package.json")) ?? "{}");
  return new Map(
    Object.entries(parsed.gateRedProofs ?? {}).map(([gate, text]) => [gate, { file: "package.json", text }]),
  );
}

/** One declaration as a marker: same keyword, same kinds, same claim - read from data instead of a comment line. */
function declarationMarker(declaration) {
  if (declaration === undefined) return null;
  const match = RED_PROOF.exec(`red-proof: ${declaration.text}`);
  if (match === null)
    return { file: "package.json (gateRedProofs)", line: 0, kind: null, claim: declaration.text, valid: false };
  return {
    file: "package.json (gateRedProofs)",
    line: 0,
    kind: match[1].toLowerCase(),
    claim: match[2].trim(),
    valid: true,
  };
}

/** The falsifier files that sit beside a gate, whether or not the gate declares them. */
function siblingFalsifiers(root, entryFiles) {
  return entryFiles
    .flatMap((entry) => {
      const stem = entry.replace(/\.[a-z]+$/u, "");
      return [".test.mjs", ".test.ts", ".mutation.mjs"].map((suffix) => `${stem}${suffix}`);
    })
    .filter((candidate) => existsSync(join(root, candidate)));
}

/** The other gate scripts an aggregate gate runs; it has no rule of its own to prove. */
function memberScripts(id, command, scriptNames) {
  return [...new Set([...command.matchAll(MEMBER_SCRIPT)].map((match) => match[1]))].filter(
    (name) => name !== id && scriptNames.has(name),
  );
}

/** Every file a declared script or a CI workflow names, so a proof nothing runs is visible. */
function declaredRunnerText(root) {
  const parsed = JSON.parse(read(join(root, "package.json")) ?? "{}");
  const workflows = join(root, ".github", "workflows");
  const workflowText = existsSync(workflows)
    ? readdirSync(workflows)
        .filter((name) => name.endsWith(".yml"))
        .map((name) => read(join(workflows, name)) ?? "")
        .join("\n")
    : "";
  return `${Object.values(parsed.scripts ?? {}).join("\n")}\n${workflowText}`;
}

/** One gate's record: what it owns, what it claims, and whether those claims can be read. */
function classify({ root, gate, scriptNames, runnerText, declarations }) {
  const owned = [...new Set([...gate.entryFiles, ...siblingFalsifiers(root, gate.entryFiles)])]
    .filter((file) => existsSync(join(root, file)))
    .sort();
  const declared = declarationMarker(declarations.get(gate.id));
  const markers = [
    ...owned.flatMap((file) => readRedProofMarkers({ root, file })),
    ...(declared === null ? [] : [declared]),
  ];
  const readable = markers.filter((marker) => marker.valid && KINDS.has(marker.kind));
  const unreadable = markers.filter((marker) => !(marker.valid && KINDS.has(marker.kind)));
  const proofMarkers = readable.filter((marker) => PROOF_KINDS.has(marker.kind));
  const runners = externalRunners({ markers: readable.filter((marker) => marker.kind === EXTERNAL_KIND), runnerText });
  const pointers = [...new Set(proofMarkers.flatMap((marker) => marker.claim.match(POINTER) ?? []))];
  return {
    ...gate,
    owned,
    members: memberScripts(gate.id, gate.command, scriptNames),
    proofs: proofMarkers.map((marker) => ({
      kind: marker.kind,
      claim: marker.claim,
      file: marker.file,
      line: marker.line,
      pointers: marker.claim.match(POINTER) ?? [],
    })),
    external: runners.external,
    unreadable: [...unreadable, ...runners.unreadable],
    unresolved: pointers.filter((pointer) => !existsSync(join(root, pointer))),
    // A proof nothing runs is a proof that has stopped holding; reported beside the verdict, not in it.
    unexecuted: pointers.filter((pointer) => !runnerText.includes(pointer)),
  };
}

/**
 * The `external` markers of one gate, split into the runner command and the failure that runner produces.
 *
 * A marker carrying one half and not the other is UNREADABLE rather than external: `red-proof: external pnpm
 * knip` says a rule lives elsewhere and nothing about how it fails, which is the promise this ledger exists to
 * replace. It joins the unreadable list, so the gate reads `malformed` however much else it claims, and a
 * command no script or workflow invokes is `invoked: false` - `evaluate` turns that into a finding.
 */
function externalRunners({ markers, runnerText }) {
  const external = [];
  const unreadable = [];
  for (const marker of markers) {
    const parsed = EXTERNAL_CLAIM.exec(marker.claim);
    const command = (parsed?.[1] ?? "").trim();
    const howItFails = (parsed?.[2] ?? "").trim();
    if (command.length === 0 || howItFails.length < 12) {
      unreadable.push({
        file: marker.file,
        line: marker.line,
        claim: `${marker.claim} (an external claim is \`red-proof: external <runner command> - <how it fails>\`)`,
      });
      continue;
    }
    external.push({ command, howItFails, file: marker.file, line: marker.line, invoked: runnerText.includes(command) });
  }
  return { external, unreadable };
}

/**
 * The second census: gates that would pass on a zero population.
 *
 * A gate that prints a report and names no population the shared judge reads cannot be told apart from one that
 * measured nothing - there is no number for `assertNonVacuous` to read, so `0 findings` stands beside no `examined N`.
 * The audit prints the count and the members rather than leaving a reader to count them by hand. What this is NOT: an
 * execution. It reads the gate's source; a population computed under a name the shared field list does not carry
 * (`runsJudged`, `tokens`) reads as absent here even when the gate does defend it, which is why the members are
 * printed - each one is a gate to inspect, not a proven defect.
 */
export function zeroPopulationPass({ root, files }) {
  const reporting = [];
  const invisible = [];
  for (const file of files.map((entry) => entry.entryFiles[0])) {
    const text = read(join(root, file));
    if (text === null || !REPORT_LITERAL.test(text)) continue;
    reporting.push(file);
    if (!POPULATION_FIELD.test(text)) invisible.push(file);
  }
  return { reporting, invisible };
}

/** The reading: for every declared gate, whether a red proof exists and where, or that it does not.
 *
 * `status` is one of `proven`, `unproven`, `unproven_via_members` (an aggregate with an unproven member),
 * `pointer_missing` (a proof naming a file that is gone), `malformed` (a marker that cannot be read) or
 * `unassessed` (the command runs no file in this repo, so there is nothing to read).
 */
export function auditGateRedProofs({ root = REPOSITORY_ROOT } = {}) {
  // One derivation, shared with the conformance suite: `tools/lib/gate-population.mjs`, restricted to the index. A
  // `tools/check-*.mjs` a script runs is ONE gate there, and the script is its id - what an operator types and what
  // CI's derived job names - so the directory half contributes only the gates no script names at all.
  const { gates, gateFiles: files, untrackedNotCounted } = indexedGatePopulation({ root });
  const scripts = gates.filter((gate) => gate.kind === "script");
  const scriptNames = new Set(scripts.map((gate) => gate.id));
  const runnerText = declaredRunnerText(root);
  const declarations = declaredRedProofMarkers(root);
  const records = gates.map((gate) => classify({ root, gate, scriptNames, runnerText, declarations }));
  const status = assignStatus(records);
  const gaps = records
    .filter((record) => !["proven", "external"].includes(status.get(record.id)))
    .map((record) => ({ gate: record.id, status: status.get(record.id), detail: describeGap({ record, status }) }));
  return {
    population: {
      total: records.length,
      scripts: scripts.length,
      gateFiles: files.length,
      unclaimedByScript: gates.length - scripts.length,
      untrackedNotCounted,
    },
    records: records.map((record) => ({ ...record, status: status.get(record.id) })),
    proven: records.filter((record) => status.get(record.id) === "proven"),
    // The gates whose rule lives in another program: they owe no in-repo falsifier, and they are counted as
    // their own population so `proven + external + recorded + undeclared = examined` reconciles on one line.
    external: records.filter((record) => status.get(record.id) === "external"),
    // An `external` label whose command no script or workflow invokes is the silencer this ledger exists to name.
    externalWithoutRunner: records.flatMap((record) =>
      status.get(record.id) === "external"
        ? record.external
            .filter((runner) => !runner.invoked)
            .map((runner) => ({ gate: record.id, command: runner.command }))
        : [],
    ),
    zeroPopulationPass: zeroPopulationPass({ root, files }),
    gaps,
    // A claim that cannot be read is reported whatever the baseline says. Recording it would be
    // recording the disease: the baseline exists for gates with no proof, not for proofs nobody can check.
    unreadableClaims: gaps.filter((gap) => ["malformed", "pointer_missing"].includes(gap.status)),
    unexecutedProofs: records.flatMap((record) => record.unexecuted.map((pointer) => ({ gate: record.id, pointer }))),
  };
}

/** Each gate's verdict, plus the inheritance an aggregate needs from the gates it runs. */
function assignStatus(records) {
  const status = new Map();
  for (const record of records) {
    if (record.unreadable.length > 0) status.set(record.id, "malformed");
    // `external` sits above the gaps: a gate whose rule lives in another program is not one that owes a proof here,
    // and an in-repo proof wins over the label when both are present - a demonstrated falsifier needs no excuse.
    else if (record.proofs.length === 0 && record.external.length > 0) status.set(record.id, "external");
    else if (record.proofs.length === 0 && record.owned.length === 0 && record.members.length === 0)
      status.set(record.id, "unassessed");
    else if (record.proofs.length === 0 && record.members.length > 0) status.set(record.id, "unproven_via_members");
    else if (record.proofs.length === 0) status.set(record.id, "unproven");
    else if (record.unresolved.length > 0) status.set(record.id, "pointer_missing");
    else status.set(record.id, "proven");
  }
  // An aggregate inherits: it is proven only when every member it runs is proven, or external when the members are
  // a mix of proven and external - an alias whose one unproven member is measured by another program owes nothing
  // here either. Two passes settle any nesting an aggregate of aggregates can have, and a cycle stops rather than
  // loops.
  for (let pass = 0; pass < 2; pass += 1)
    for (const record of records)
      if (status.get(record.id) === "unproven_via_members")
        status.set(record.id, inheritedStatus(record.members.map((member) => status.get(member))));
  return status;
}

/** What an aggregate's members make it: proven when all are proven, external when the rest are measured elsewhere. */
function inheritedStatus(memberStatuses) {
  if (memberStatuses.every((member) => member === "proven")) return "proven";
  if (memberStatuses.every((member) => member === "proven" || member === "external")) return "external";
  return "unproven_via_members";
}

/**
 * The census line BOTH tools print, from the same reading: how many gates the population has, how many carry a red proof,
 * how many owe one with the debt recorded, how many nobody has declared at all, and how many print a report that cannot
 * show whether it measured anything.
 *
 * It lives here rather than in each printer because these numbers are one reading of one population. Two printers writing
 * them out separately is how "we have N gates" acquired two answers in the first place. The two trailing buckets are the
 * ones a caller adds to the ledger's five: `unlisted` (a judged gate nobody declared) and `untracked_not_counted` (a gate
 * file the index does not carry, so it is nobody's yet). Both are named, not counted alone, and both vanish from the line
 * when they are empty.
 */
export function describeGateCensus({
  examined,
  withRedProof,
  external,
  recorded,
  undeclared,
  zeroPopulationPass,
  unlisted = [],
  untrackedNotCounted = [],
}) {
  return (
    `gates examined ${examined} · with a red proof ${withRedProof} · external ${external} · ` +
    `declared without ${recorded} · undeclared ${undeclared} · zero-population-pass ${zeroPopulationPass}` +
    (unlisted.length === 0 ? "" : ` · unlisted ${unlisted.length} (${unlisted.join(", ")})`) +
    (untrackedNotCounted.length === 0 ? "" : ` · untracked_not_counted ${describeUntracked(untrackedNotCounted)}`)
  );
}

/** One sentence naming what is wrong with a gate, for the operator who has to fix it. */
function describeGap({ record, status }) {
  const verdict = status.get(record.id);
  if (verdict === "malformed") {
    const [marker] = record.unreadable;
    const kinds = [...KINDS].join("|");
    return `the marker at ${marker.file}:${marker.line} is not readable as \`red-proof: <${kinds}> <claim>\`: ${JSON.stringify(marker.claim.slice(0, 80))}`;
  }
  if (verdict === "pointer_missing") return `the red proof names ${record.unresolved.join(", ")}, which is not on disk`;
  if (verdict === "unassessed") return `\`${record.command}\` runs no file in this repository, so nothing can be read`;
  if (verdict === "unproven_via_members")
    return `delegates to ${record.members.map((member) => `${member}=${status.get(member)}`).join(", ")}`;
  return `no \`red-proof:\` marker in ${record.owned.join(", ") || "any owned file"}`;
}

/** The recorded gap set: readings measured and not yet closed, one gate id per line in the file. */
export function readBaseline(root) {
  const text = read(join(root, BASELINE_PATH));
  if (text === null) return { gates: [], note: null };
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed.gates)) throw new Error("gate_red_proof_baseline_malformed:gates");
  return { gates: parsed.gates, note: parsed.note };
}

/** Why one run is red: a gap nobody recorded, a recorded gap that has closed, or an unreadable claim. */
export function evaluate({ reading, baseline }) {
  const recorded = new Set(baseline.gates);
  const gaps = new Set(reading.gaps.map((gap) => gap.gate));
  const unreadable = new Set(reading.unreadableClaims.map((claim) => claim.gate));
  const findings = [];
  for (const gap of reading.gaps) {
    if (unreadable.has(gap.gate)) {
      findings.push({
        code: gap.status === "pointer_missing" ? "red_proof_pointer_missing" : "red_proof_kind_unknown",
        gate: gap.gate,
        detail: gap.detail,
      });
      continue;
    }
    if (recorded.has(gap.gate)) continue;
    findings.push({
      code: gap.status === "unassessed" ? "gate_unassessed" : "no_red_proof",
      gate: gap.gate,
      detail: gap.detail,
    });
  }
  for (const runner of reading.externalWithoutRunner)
    findings.push({
      code: "external_runner_not_invoked",
      gate: runner.gate,
      detail:
        `claims \`external ${runner.command}\`, which no package.json script and no workflow invokes, so the ` +
        "label names a rule nothing the repository runs checks",
    });
  for (const gate of baseline.gates)
    if (!gaps.has(gate))
      findings.push({
        code: "baseline_entry_stale",
        gate,
        detail: "this gate is proven now (or no longer declared); delete its entry so the baseline only tightens",
      });
  return { findings, held: reading.gaps.filter((gap) => recorded.has(gap.gate) && !unreadable.has(gap.gate)).length };
}

/** Execute each declared falsifier suite; a proof whose suite has rotted is not a proof. */
function runProofSuites(root, proven) {
  const files = [...new Set(proven.flatMap((record) => record.proofs.flatMap((proof) => proof.pointers)))].filter(
    (pointer) => /\.test\.(?:mjs|ts)$/u.test(pointer),
  );
  const findings = [];
  for (const file of files) {
    const result = spawnSync(process.execPath, ["--test", file], { cwd: root, stdio: "ignore", timeout: 5 * 60_000 });
    process.stdout.write(`red_proof_suite:${file}:${result.status === 0 ? "passed" : "failed"}\n`);
    if (result.status !== 0)
      findings.push({
        code: "red_proof_suite_red",
        gate: file,
        detail: "the falsifier suite of a proven gate is red, so the proof no longer holds",
      });
  }
  return findings;
}

function report({ reading, held, gaps, undeclared = 0 }) {
  const { population } = reading;
  const byStatus = (status) => reading.records.filter((record) => record.status === status).length;
  process.stdout.write(
    `gate_red_proofs population=${population.total} script_gates=${population.scripts} ` +
      `gate_files=${population.gateFiles} unclaimed_by_any_script=${population.unclaimedByScript} ` +
      `proven=${reading.proven.length} held=${held} unproven=${byStatus("unproven") + byStatus("unproven_via_members")} ` +
      `unassessed=${byStatus("unassessed")} unreadable=${reading.unreadableClaims.length}\n`,
  );
  for (const record of reading.proven) {
    const proof = record.proofs[0];
    if (proof === undefined) {
      process.stdout.write(`  proven:${record.id} inherited from ${record.members.join(", ")}\n`);
      continue;
    }
    process.stdout.write(`  proven:${record.id} kind=${proof.kind} at=${proof.file}:${proof.line}\n`);
  }
  // The external rows carry their command, so a reader can run one and watch it fail rather than trust the label.
  for (const record of reading.external) {
    if (record.external.length === 0) {
      process.stdout.write(`  external:${record.id} inherited from ${record.members.join(", ")}\n`);
      continue;
    }
    for (const runner of record.external)
      process.stdout.write(
        `  external:${record.id} runner=${runner.command} at=${runner.file}:${runner.line} ` +
          `invoked=${runner.invoked ? "yes" : "NO"} — ${runner.howItFails}\n`,
      );
  }
  // The census a reader would otherwise take a day to count: how many gates there are, how many carry a red proof,
  // which of the rest are recorded debt and which nobody has declared at all, and how many cannot see a zero
  // population. These numbers belong on ONE line, because they are the answer to "how much of this is measured" and
  // reading one without the others is how "0 violations" gets quoted.
  const zero = reading.zeroPopulationPass;
  process.stdout.write(
    `  ${describeGateCensus({
      examined: population.total,
      withRedProof: reading.proven.length,
      external: reading.external.length,
      recorded: held,
      undeclared,
      zeroPopulationPass: zero.invisible.length,
      untrackedNotCounted: population.untrackedNotCounted,
    })}\n`,
  );
  process.stdout.write(
    `  zero-population-pass reads ${zero.reporting.length} gate file(s) that print a report; these ` +
      `${zero.invisible.length} name no ${POPULATION_FIELDS.map((field) => `\`${field}\``).join("/")} field the ` +
      `shared judge reads, so a zero in them is invisible: ` +
      `${zero.invisible.map((file) => file.replace(/^tools\//u, "")).join(", ")}\n`,
  );
  if (gaps) for (const gap of reading.gaps) process.stdout.write(`  gap:${gap.gate} status=${gap.status}\n`);
  for (const entry of reading.unexecutedProofs)
    process.stdout.write(`  proven_but_nothing_runs:${entry.gate}:${entry.pointer}\n`);
  process.stdout.write(
    `  ${reading.gaps.length} gate(s) still owe a red proof; ${held} of them are recorded in ${BASELINE_PATH}` +
      `; ${reading.external.length} are external and ${reading.gaps.length + reading.external.length + reading.proven.length} ` +
      `of ${population.total} are accounted for\n`,
  );
}

function main(argv) {
  const json = argv.includes("--json");
  const rootIndex = argv.indexOf("--root");
  const root =
    rootIndex >= 0 && typeof argv[rootIndex + 1] === "string" ? resolve(argv[rootIndex + 1]) : REPOSITORY_ROOT;
  const reading = auditGateRedProofs({ root });
  if (argv.includes("--update")) {
    const gates = reading.gaps.map((gap) => gap.gate).sort();
    writeFileSync(
      join(root, BASELINE_PATH),
      `${JSON.stringify(
        {
          schema: "gamebuddy-gate-red-proof-baseline/v1",
          note: "Gates measured with no red proof at this commit. A record of debt, not an acceptance of it: delete an entry by adding its proof, never by recording more gates.",
          gates,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    process.stdout.write(`gate_red_proof_baseline_recorded gates=${gates.length} into ${BASELINE_PATH}\n`);
    return 0;
  }
  const baseline = readBaseline(root);
  const { findings, held } = evaluate({ reading, baseline });
  // `undeclared` is the half the baseline does not cover: a gate with no red proof and no record saying it owes one.
  // It is the number the conformance suite fails on, so it is counted here once and read from the same reading there.
  // Unreadable claims and external labels with no invoked runner are findings of their own and are NOT counted as
  // undeclared gates: they would break the arithmetic `proven + external + declared + undeclared = examined`.
  const undeclared = findings.filter((finding) => ["no_red_proof", "gate_unassessed"].includes(finding.code)).length;
  const all = argv.includes("--run") ? [...findings, ...runProofSuites(root, reading.proven)] : findings;
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ...reading, baseline: baseline.gates.length, findings: all }, null, 2)}\n`,
    );
    return all.length === 0 ? 0 : 1;
  }
  report({ reading, held, gaps: argv.includes("--gaps"), undeclared });
  for (const finding of all)
    process.stderr.write(`gate_red_proof_${finding.code}:${finding.gate}: ${finding.detail}\n`);
  if (all.length > 0)
    process.stderr.write(
      "  fix: show the gate red on a real injected violation, then write it down in the gate or its falsifier as\n" +
        "       `red-proof: <inject|history|fixture|self-check> <the violation injected -> what the gate then said>`\n" +
        "       or, when the rule lives in another program, `red-proof: external <runner command> - <how it fails>`\n" +
        "       with that command written the way package.json or a workflow invokes it\n",
    );
  return all.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
