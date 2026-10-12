#!/usr/bin/env node
/**
 * Actor-admissibility closure checker  (设计自闭环的判定器)
 *
 * It decides two DIFFERENT things, and keeping them apart is the point:
 *
 *   DESIGN CLOSURE (offline, no game):
 *     INV-1 totality      every (action x state) is decided: either admissible, or a named cause
 *     INV-2 determinism   the algebra is decided in ONE place; every decision site is declared
 *     INV-3 liveness      every cause has a remedy, and the remedy's state makes the blocked actions admissible
 *     INV-4 acyclicity    the remedy graph over states is acyclic and settles at idle
 *     INV-5 no hidden input  no decision may key on a DERIVED boolean (e.g. `actionable`)
 *
 *   INTERFACE VALIDATION (against the immutable game source):
 *     IFACE-1 every declared read resolves to a real member declaration in the decompiled tree
 *     IFACE-2 every writer of a declared read names its mechanism in the contract
 *
 * Exit 0 only when both halves pass. A report is printed either way, because a failing
 * check has to say WHICH row failed.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { searchCounterExamples } from "./check-stardew-hold-sufficiency.mjs";
import { join, basename, relative } from "node:path";

const ROOT = (() => {
  let d = process.cwd();
  for (let i = 0; i < 8; i++) {
    try {
      if (statSync(join(d, "AGENTS.md")).isFile()) return d;
    } catch {}
    d = join(d, "..");
  }
  throw new Error("repository root not found (no AGENTS.md above cwd)");
})();

const CONTRACT = "integrations/stardew/action-development/contracts/actor-admissibility/actor-admissibility.v1.json";
const GAME_ROOT = join(ROOT, "ref/external/StardewValleyDecompiled");
const model = JSON.parse(readFileSync(join(ROOT, CONTRACT), "utf8"));

const BLOCKED = new Set(model.blockedActions ?? []);
const results = [];
const record = (id, ok, headline, rows = []) => results.push({ id, ok, headline, rows });

// ---------------------------------------------------------------- source walking
function walk(dir, filter, acc = []) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, filter, acc);
    else if (filter(e.name)) acc.push(p);
  }
  return acc;
}

const gameFiles = () => walk(GAME_ROOT, (n) => n.endsWith(".cs"));
const repoFiles = (dir, filter) => walk(join(ROOT, dir), filter);

// A read "Class.member" resolves to a declaration-shaped line in a file named Class.cs.
function resolveRead(member) {
  const [cls, name] = member.split(".");
  const candidates = gameFiles().filter((f) => basename(f) === cls + ".cs");
  // A property's opening brace can be on the NEXT line, so end-of-line is a legal terminator; and an
  // expression-bodied member ends with `=>`. Missing the first case made three real declarations
  // (Game1.activeClickableMenu, Farmer.UsingTool, Farmer.stamina) look unresolvable.
  const decl = new RegExp(`^\\s*(?:public|internal|private|protected|readonly|static|virtual|override)[^;=()]*\\b${name}\\b\\s*(?:;[^;]*$|=|=>|\\{|$)`);
  for (const f of candidates) {
    const lines = readFileSync(f, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (decl.test(lines[i])) return { file: relative(ROOT, f).replace(/\\/g, "/"), line: i + 1, text: lines[i].trim() };
    }
  }
  return null;
}

// Every place the game WRITES one of the declared reads.
function writeSites(member) {
  const [, name] = member.split(".");
  // Case-insensitive: the field is `Farmer.canMove` and the property `Farmer.CanMove`, and writers use
  // both spellings. A case-sensitive scan silently under-reported.
  const re = new RegExp(`\\b${name}\\s*=[^=]`, "i");
  const out = [];
  for (const f of gameFiles()) {
    const lines = readFileSync(f, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i];
      if (!re.test(t)) continue;
      if (/\bpublic\b[^;=]*\b/.test(t) && /(;|=|$)/.test(t) && /^\s*(public|internal|private|protected)/.test(t)) continue; // a declaration, not a write
      out.push({ file: basename(f), line: i + 1 });
    }
  }
  return out;
}

// ---------------------------------------------------------------- INV-1 totality
{
  const rows = [];
  // Only the BLOCKED actions need a cause when a state refuses them: a remedy action is legitimately
  // inapplicable in most states, and demanding otherwise was a mis-specified invariant.
  for (const action of model.actions.filter((a) => BLOCKED.has(a.id))) {
    for (const state of model.states) {
      const admissible = (action.admissibleIn ?? []).includes(state.id);
      const cause = model.causes.find((c) => c.state === state.id);
      if (!admissible && !cause) rows.push(`${action.id} x ${state.id}: neither admissible nor a named cause`);
    }
  }
  record("INV-1 totality", rows.length === 0, `${model.actions.length} actions x ${model.states.length} states all decided`, rows);
}

// ---------------------------------------------------------------- INV-3 liveness
{
  const rows = [];
  for (const cause of model.causes) {
    const remedies = model.remedies.filter((r) => r.cause === cause.id);
    if (remedies.length === 0) {
      rows.push(`${cause.id}: no remedy declared`);
      continue;
    }
    const blocked = model.actions.filter((a) => BLOCKED.has(a.id) && !(a.admissibleIn ?? []).includes(cause.state));
    for (const r of remedies) {
      if (r.kind === "action" && !model.actions.some((a) => a.id === r.action))
        rows.push(`${cause.id}: remedy action "${r.action}" is not in the algebra`);
      if (r.kind === "action") {
        const remedyAdmissible = model.actions.find((a) => a.id === r.action)?.admissibleIn ?? [];
        if (!remedyAdmissible.includes(cause.state))
          rows.push(`${cause.id}: remedy "${r.action}" is NOT admissible in the state it must fix (${cause.state})`);
      }
      for (const a of blocked)
        if (!(a.admissibleIn ?? []).includes(r.establishes))
          rows.push(`${cause.id}: after "${r.action ?? r.kind}" the state is ${r.establishes}, where ${a.id} is still inadmissible`);
    }
  }
  record("INV-3 liveness", rows.length === 0, `${model.causes.length} causes, each with a remedy that restores the blocked actions`, rows);
}

// ---------------------------------------------------------------- INV-4 acyclicity
{
  const rows = [];
  const edges = new Map();
  for (const r of model.remedies) {
    const cause = model.causes.find((c) => c.id === r.cause);
    if (!cause) continue;
    if (!edges.has(cause.state)) edges.set(cause.state, new Set());
    edges.get(cause.state).add(r.establishes);
  }
  if (edges.has("idle")) rows.push("idle has an outgoing remedy edge: idle is not a sink");
  const seen = new Set();
  const stack = new Set();
  const visit = (n) => {
    if (stack.has(n)) {
      rows.push(`cycle in the remedy graph through ${n}`);
      return;
    }
    if (seen.has(n)) return;
    stack.add(n);
    for (const m of edges.get(n) ?? []) visit(m);
    stack.delete(n);
    seen.add(n);
  };
  for (const n of edges.keys()) visit(n);
  record("INV-4 acyclicity", rows.length === 0, `${edges.size} non-idle states, remedy graph is a DAG settling at idle`, rows);
}

// ---------------------------------------------------------------- decision sites (shared by INV-2 and INV-5)
const DECISION_PATTERNS = [
  { id: "body-env triple (fork)", re: /Game1\.activeClickableMenu is not null \|\| Game1\.eventUp \|\| !(Game1\.player|actor)\.CanMove/ },
  { id: "body-env guards, split", re: /player_menu_open|player_cannot_move|player_event_active/ },
  { id: "legacy collapse code", re: /"player_not_actionable"/ },
  { id: "derived boolean decision", re: /!\s*snapshot\.actionable\b/ },
  { id: "derived boolean decision", re: /if \(!snapshot\.actionable\)/ },
];

const ourSources = [
  ...repoFiles("integrations/stardew", (n) => n.startsWith("farmhandexecutioncontroller") && n.endsWith(".cs")),
  ...repoFiles("integrations/stardew", (n) => n === "StardewBodyController.cs"),
  ...repoFiles("host/src", (n) => n.endsWith(".ts") && !n.endsWith(".test.ts")),
];

const decisionSites = [];
for (const f of ourSources) {
  const rel = relative(ROOT, f).replace(/\\/g, "/");
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const p of DECISION_PATTERNS)
      if (p.re.test(line)) decisionSites.push({ file: rel, line: i + 1, kind: p.id, text: line.trim().slice(0, 110) });
  });
}

// The adjudication table is keyed by FILE, matching the enumerator's granularity.
function declaredVerdict(file) {
  return model.adjudication.decisionSites.find((d) => d.file === file) ?? null;
}
// ---------------------------------------------------------------- INV-2 determinism
{
  const rows = [];
  const byFile = new Map();
  for (const s of decisionSites) byFile.set(s.file, (byFile.get(s.file) ?? 0) + 1);

  for (const [file, count] of [...byFile].sort()) {
    const d = declaredVerdict(file);
    if (!d) rows.push(`UNDECLARED decision site: ${file} (${count} occurrences)`);
    else if (d.verdict === "fork_to_remove") rows.push(`unconverged fork: ${file} (${count}) - declared as fork_to_remove`);
  }
  // The declaration must also be true: every adjudicated file must still DECIDE something, or the row is
  // stale and is hiding a site that moved (or a mechanism that stopped deciding).
  for (const d of model.adjudication.decisionSites) {
    if (!byFile.has(d.file)) rows.push(`stale adjudication row: ${d.file} decides nothing any more`);
  }
  record(
    "INV-2 determinism",
    rows.length === 0,
    `${decisionSites.length} decision sites in ${byFile.size} files; algebra must be decided in one place`,
    rows,
  );
}

// ---------------------------------------------------------------- INV-5 no hidden input
{
  const rows = [];
  for (const d of model.derivedInputs) {
    const hits = decisionSites.filter((s) => new RegExp(d.form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(s.text));
    const seenHidden = new Set();
    for (const h of hits) {
      const key = `${h.file}:${h.line}`;
      if (seenHidden.has(key)) continue;
      seenHidden.add(key);
      rows.push(`${h.file}:${h.line} decides on ${d.form} (${d.id}) - ${d.why_forbidden.slice(0, 80)}`);
    }
  }
  record("INV-5 no hidden input", rows.length === 0, `${model.derivedInputs.length} derived input(s) forbidden as decision inputs`, rows);
}

// ---------------------------------------------------------------- IFACE-1 reads resolve
{
  const rows = [];
  for (const r of model.environmentReads) {
    const found = resolveRead(r.member);
    if (!found) rows.push(`UNRESOLVED read: ${r.member} - no declaration-shaped member found in the game source`);
    else r.resolved = found;
  }
  record(
    "IFACE-1 reads resolve",
    rows.length === 0,
    `${model.environmentReads.length} declared reads resolved against the decompiled tree`,
    rows,
  );
}

// ---------------------------------------------------------------- IFACE-2 hold sufficiency
// Replaced a filename whitelist, which proved nothing: it only suppressed the warning. The decidable
// assertion is that every site setting the actor's move flag false is accompanied by a companion read,
// i.e. that the declared reads are a SUFFICIENT STATISTIC. The tool searches for counter-examples and
// the contract only has to adjudicate the residual - each row a reason plus an anchor, compared
// bidirectionally, so a new orphan fails and an adjudicated-but-now-accompanied row fails too.
{
  const companions = model.environmentReads.map((r) => r.member).filter((m) => !/canmove$/i.test(m));
  const found = searchCounterExamples({
    root: ROOT,
    companionReads: companions,
    residual: model.orphanHoldResidual ?? [],
  });
  const rows = [
    `scanned ${found.fileCount} files: ${found.siteCount} writes of the move flag, ${found.accompanied} accompanied, ${found.orphans.length} orphans, ${found.unparsed.length} unparsed`,
    ...found.undeclaredOrphans.map((o) => `UNADJUDICATED orphan: ${o.file}:${o.line} ${o.method}()`),
    ...found.staleRows.map((r) => `stale residual row: ${r.site} is no longer an orphan`),
  ];
  record(
    "IFACE-2 hold sufficiency",
    found.undeclaredOrphans.length === 0 && found.staleRows.length === 0,
    "every site that holds the actor is accompanied by a declared read (sufficient statistic)",
    rows,
  );
}
// ---------------------------------------------------------------- algebra coverage (the "what action is missing" query)
const catalog = (() => {
  const f = join(ROOT, "integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs");
  try {
    return [...new Set([...readFileSync(f, "utf8").matchAll(/E\("([a-z0-9_]+)"/g)].map((m) => m[1]))];
  } catch {
    return [];
  }
})();
const inAlgebra = new Set(model.actions.map((a) => a.id));
const notInAlgebra = catalog.filter((a) => !inAlgebra.has(a));
const staleInAlgebra = model.actions.filter((a) => !catalog.includes(a.id)).map((a) => a.id);

// ---------------------------------------------------------------- report
let failed = 0;
console.log(`\n=== actor-admissibility closure  (slice: ${model.slice}) ===\n`);
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.id.padEnd(24)} ${r.headline}`);
  for (const row of r.rows.slice(0, 12)) console.log(`        - ${row}`);
  if (r.rows.length > 12) console.log(`        ... and ${r.rows.length - 12} more`);
}
console.log(`\n-- algebra coverage (a QUERY, not a report to interpret) --`);
console.log(`   registered actions:            ${catalog.length}`);
console.log(`   with admissibility declared:   ${inAlgebra.size - staleInAlgebra.length}`);
console.log(`   NO admissibility declared:     ${notInAlgebra.length}  (first: ${notInAlgebra.slice(0, 8).join(", ") || "none"})`);
if (staleInAlgebra.length) console.log(`   in the algebra but NOT in the catalog: ${staleInAlgebra.join(", ")}`);
console.log(`\n=== ${failed === 0 ? "DESIGN CLOSED" : failed + " invariant(s) or interface check(s) FAILED"} ===\n`);
process.exit(failed === 0 ? 0 : 1);
