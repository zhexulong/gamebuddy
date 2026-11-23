#!/usr/bin/env node
/**
 * Actor-admissibility closure checker  (设计自闭环的判定器)
 *
 * WHAT IT DECIDES, and where each answer comes from:
 *
 *   THE FACT ALGEBRA (the contract + the Mod + the decompiled tree):
 *     FACT-1 population    every member of `ActorWorldFacts` has a row, in declaration order, and no row is stale
 *     FACT-2 publishes     each row's kind / wire spelling / reason code / transient word is the one the mint its
 *                          `classifyAt` names decides - re-read from `Classify` (inline, or through the private
 *                          transient factory), `KindForWire` and `HoldReasonCode`, not trusted. The headline counts
 *                          the rows per producer, so a reader sees which function owns what
 *     FACT-3 named         every kind `Classify` can return is either `Idle` (the word for a body that is NOT held) or
 *                          published by at least one fact, and `Idle` carries the fallback code
 *     IFACE-1 reads        every declared read resolves to a real member declaration in the decompiled tree
 *     FACT-4 release       every row's release anchor still writes what the row says, and writes it in the direction
 *                          that CLEARS the fact - a hold whose release was deleted or moved is red here
 *     IFACE-2 sufficiency  the shared counter-example search: every `canMove = false` write is accompanied by a
 *                          HOLDING write of a declared read, or carries an adjudicated residual row
 *     DECISION-1 sites     every file that decides the hold vocabulary is adjudicated, no row is stale, and each
 *                          `not_a_decision` row's matches are still prose rather than code
 *     DECISION-2 inputs    no source line decides on a derived boolean the contract forbids
 *     DECISION-3 owed      every `second_spelling_owed` row names an owner and the condition that closes it
 *
 * WHAT THIS GATE DOES NOT CLAIM, and why that is stated rather than dropped. It used to declare INV-1 totality,
 * INV-3 liveness and INV-4 acyclicity over an ACTION algebra: which of the catalog's actions is admissible in which
 * disposition, and which remedy restores it. That statement cannot be derived honestly here - `admissibleIn` for one
 * action is decided by `ExecutionAdmission.Admit`'s own ladder over the action's `AdmissionProfile` and its event path,
 * and a generator that re-encoded that ladder would be a second authority for a fact the Mod already owns, which is the
 * duplicate-authority defect this repository has paid for repeatedly. The action algebra is therefore absent from the
 * contract and unclaimed here; what is claimed is the fact algebra above, which the contract does own, plus the
 * engine-side release and hold-sufficiency assertions the residual supplies.
 *
 * A report is printed either way, because a failing check has to say WHICH row failed. With no contract on disk there
 * is no algebra to decide and the run reports `blocked` (exit 2) naming the path, rather than passing over nothing or
 * dying on an ENOENT that reads like a defect in this file. A run that examined nothing is `blocked` for the same
 * reason: `0 findings` means nothing without `examined N`.
 *
 * The engine's source is the gate's other input and it is a gitignored mount (`ref/external/StardewValleyDecompiled`), so
 * a checkout without it prints `stardew_actor_admissibility_skipped:` and exits 2 - the same blocked code, with the
 * reason stated. `tools/prelive.mjs` reads exit 2 beside that marker as UNAVAILABLE, so the L0b rung says "this checkout
 * cannot measure the hold algebra" instead of red, and a person running the file by hand gets the same line and a
 * non-zero exit rather than a green reading over nothing.
 *
 * WHERE A TRANSIENT'S WORD COMES FROM, so the next reader looks in the right place. A disposition's transient word is
 * not a string a branch spells any more: `Classify` names an `ActorTransientKind` member and the private factory beside
 * it mints `new(ActorDispositionKind.Transient, null, false, KindForWire(kind))`, so the WORD (`KindForWire`'s overload
 * over `ActorTransientKind`) and the SETTLE WINDOW (`SettleWindowMs`, read by `NoteObservedTransient` /
 * `TransientSettle`) of one transient come from the one declaration the member sits in - a word that cannot exist
 * without the ending it promises. That is why `Classify` mints FOUR kinds even though only three branches spell a
 * `new ActorDisposition(...)` inline, and why a FACT-2 row for a transient fact cites a `return
 * Transient(ActorTransientKind.X)` line. The reader for both forms is `tools/lib/stardew-disposition-mint.mjs`, shared
 * with the generator that wrote the rows: the two halves disagreed once, and the cost was seven rows citing lines that
 * mint nothing.
 *
 * red-proof: inject  the Idle hold reason given a code the Mod never mints (`player_busy_probe`) ->
 *   `FAIL  FACT-3 named`, report status failed at examined 15 with detail `Idle carries player_busy_probe; a body
 *   that is not held must not carry a hold code`, exit 1
 * red-proof: inject  a row's `classifyAt.line` moved off its mint (the FreezePaused row pointed at WorldModel.cs:250,
 *   the `SettleWindowMs` arm) -> `FAIL  FACT-2 publishes` at `15 fact(s) re-read from the mint their row names:
 *   Classify 8 · Transient 6` with detail `FreezePaused: classifyAt integrations/stardew/WorldModel.cs:250 mints no
 *   disposition - it reads "ActorTransientKind.FreezePause => FreezePauseSettleWindowMs,", not \`return new
 *   ActorDisposition(...)\` nor \`return Transient(ActorTransientKind.X)\``, exit 1
 */

export const gateDeclaration = {
  id: "check-stardew-actor-admissibility",
  domain: "stardew",
  tier: "l0",
  kind: "contract",
};

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import {
  ACTOR_ADMISSIBILITY_CONTRACT,
  readActorAdmissibilityContract,
  repoRoot,
  searchCounterExamples,
  writeEstablishes,
} from "../../tools/lib/stardew-actor-holds.mjs";
import { reportBlockedInput } from "../../tools/lib/blocked-input-report.mjs";
import { mintedKinds, namedFindings, publishFindings } from "../../tools/lib/stardew-disposition-mint.mjs";
import { basename, join, relative } from "node:path";

const ROOT = repoRoot();
const GAME_ROOT = join(ROOT, "ref/external/StardewValleyDecompiled");
const WORLD_MODEL = "integrations/stardew/WorldModel.cs";

const modelSource = readActorAdmissibilityContract(ROOT);
if (modelSource === null)
  reportBlockedInput({
    gate: "stardew_actor_admissibility/v1",
    input: ACTOR_ADMISSIBILITY_CONTRACT,
    examined: 0,
    checks: ["contract_readable"],
  });
const model = JSON.parse(modelSource);
if (!existsSync(GAME_ROOT)) {
  // IFACE-1, FACT-4 and IFACE-2 are all decided against the engine's own source; without it this gate can resolve no
  // read, pin no release and accompany no hold, so there is nothing to report a verdict over.
  process.stdout.write(
    `stardew_actor_admissibility_skipped: needs ref/external/StardewValleyDecompiled - IFACE-1 reads, FACT-4 releases ` +
      "and IFACE-2 holds are all decided against the engine's own source\n",
  );
  process.exit(2);
}
const worldModel = readFileSync(join(ROOT, WORLD_MODEL), "utf8");
const worldModelLines = worldModel.split("\n");

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
const repoPath = (file) => relative(ROOT, file).replace(/\\/g, "/");

// A read "Class.member" resolves to a declaration-shaped line in a file named Class.cs. A property's opening brace can
// be on the NEXT line, so end-of-line is a legal terminator; an expression-bodied member ends with `=>`.
function resolveRead(member) {
  const [cls, name] = member.split(".");
  const candidates = gameFiles().filter((f) => basename(f) === `${cls}.cs`);
  const decl = new RegExp(
    `^\\s*(?:public|internal|private|protected|readonly|static|virtual|override)[^;=()]*\\b${name}\\b\\s*(?:;[^;]*$|=|=>|\\{|$)`,
  );
  for (const f of candidates) {
    const lines = readFileSync(f, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++)
      if (decl.test(lines[i]))
        return {
          file: repoPath(f),
          line: i + 1,
          text: lines[i].trim().replace(/\s+/g, " "),
        };
  }
  return null;
}

// ---------------------------------------------------------------- FACT-1 population
const unionAt = worldModel.indexOf("record struct ActorWorldFacts(");
const unionList = unionAt < 0 ? "" : worldModel.slice(worldModel.indexOf("(", unionAt));
const unionMembers = [];
{
  let depth = 0;
  let part = "";
  for (const ch of unionList) {
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) break;
    } else if (depth === 1) part += ch;
  }
  for (const declaration of part.split("\n").map((line) => line.replace(/\/\/.*$/u, "").trim())) {
    const name = /([A-Za-z_]\w*)\s*,?$/.exec(declaration)?.[1];
    if (name !== undefined && !/^$/.test(declaration)) unionMembers.push(name);
  }
}
{
  const rows = [];
  const declared = (model.facts ?? []).map((fact) => fact.fact);
  for (const member of unionMembers) if (!declared.includes(member)) rows.push(`UNDECLARED fact: ${member}`);
  for (const member of declared)
    if (!unionMembers.includes(member)) rows.push(`STALE row: ${member} is not a member of ActorWorldFacts`);
  if (unionMembers.length === 0) rows.push("ActorWorldFacts was not found, so no population could be derived");
  record(
    "FACT-1 population",
    rows.length === 0,
    `${unionMembers.length} ActorWorldFacts member(s), ${declared.length} declared`,
    rows,
  );
}

// ---------------------------------------------------------------- FACT-2 publishes
{
  const { rows, census } = publishFindings({ where: WORLD_MODEL, worldModel, facts: model.facts ?? [] });
  record(
    "FACT-2 publishes",
    rows.length === 0,
    `${(model.facts ?? []).length} fact(s) re-read from the mint their row names: ${census}`,
    rows,
  );
}

// ---------------------------------------------------------------- FACT-3 named
{
  const kinds = mintedKinds(worldModel);
  const rows = namedFindings({ kinds, facts: model.facts ?? [], holdReasons: model.holdReasons ?? [] });
  record("FACT-3 named", rows.length === 0, `${kinds.length} kind(s) the classifier returns, each named or Idle`, rows);
}

// ---------------------------------------------------------------- IFACE-1 reads resolve
{
  const rows = [];
  for (const read of model.environmentReads ?? []) {
    const found = resolveRead(read.member);
    if (found === null) {
      rows.push(`UNRESOLVED read: ${read.member} - no declaration-shaped member found in the game source`);
      continue;
    }
    if (read.declaredAt !== undefined && (read.declaredAt.line !== found.line || read.declaredAt.file !== found.file))
      rows.push(
        `${read.member}: declaration moved to ${found.file}:${found.line}, the contract cites ${read.declaredAt.file}:${read.declaredAt.line}`,
      );
  }
  record(
    "IFACE-1 reads resolve",
    rows.length === 0,
    `${(model.environmentReads ?? []).length} declared read(s) resolved against the decompiled tree`,
    rows,
  );
}

// ---------------------------------------------------------------- FACT-4 release
{
  const rows = [];
  let anchors = 0;
  for (const fact of model.facts ?? []) {
    const release = fact.release ?? {};
    if (!Array.isArray(release.clears) || release.clears.length === 0) {
      rows.push(`${fact.fact}: no release path - a hold nobody releases is not admissible`);
      continue;
    }
    for (const clear of release.clears) {
      anchors += 1;
      const text = lineOf(clear.anchor);
      if (text === null) {
        rows.push(`${fact.fact}: release anchor ${clear.anchor} does not resolve`);
        continue;
      }
      const statement = text.replace(/\s+/g, " ").trim();
      if (statement !== clear.statement)
        rows.push(`${fact.fact}: ${clear.anchor} now reads "${statement}", the contract pinned "${clear.statement}"`);
      // The write must CLEAR the fact, not establish it: a release that raises the same fact would be the hold
      // entering, not leaving. The engine spells one member twice (`Farmer.Stamina` the property over `stamina` the
      // field), so every spelling this row resolves to is accepted - case-insensitively, because `CanMove` the
      // property and `canMove` the field are the same fact and writers use both.
      const read = fact.reads?.find((entry) => clear.reads.includes(entry.member));
      const names = [
        ...new Set([
          clear.reads?.[0]?.split(".").slice(-1)[0],
          read?.resolvesTo?.split(".").slice(-1)[0],
          `_${clear.reads?.[0]?.split(".").slice(-1)[0]}`,
        ]),
      ]
        .filter((name) => name !== undefined && name !== "_undefined")
        .join("|");
      const rhs = new RegExp(`(?:${names})\\s*(?:\\.Value\\s*)?=(?!=)\\s*([^;]*);`, "i").exec(statement)?.[1];
      if (rhs === undefined) rows.push(`${fact.fact}: ${clear.anchor} no longer assigns ${clear.reads?.join("/")}`);
      else {
        // Only a LITERAL can be judged here. `writeEstablishes` counts an unevaluable right-hand side as
        // establishing, which is the generous direction that belongs on the accompaniment side; reading it as
        // "this release does nothing" would fail `stamina = maxStamina.Value`, which restores the actor.
        const literal = /^-?\d+(?:\.\d+)?[fFdD]?$/.test(rhs.trim());
        const holdsWhen = read?.holdsWhen;
        if (literal && holdsWhen !== undefined && writeEstablishes(holdsWhen, rhs))
          rows.push(
            `${fact.fact}: ${clear.anchor} writes "${rhs.trim()}", which ESTABLISHES the fact rather than releasing it`,
          );
      }
    }
    const body = release.bodyRelease ?? {};
    if (body.anchor !== undefined) {
      anchors += 1;
      const text = lineOf(body.anchor);
      if (text === null) rows.push(`${fact.fact}: body release ${body.anchor} does not resolve`);
      else if (text.replace(/\s+/g, " ").trim() !== body.statement)
        rows.push(
          `${fact.fact}: body release ${body.anchor} now reads "${text.trim()}", the contract pinned "${body.statement}"`,
        );
    } else if ((body.mechanism ?? "").trim() === "") {
      rows.push(`${fact.fact}: the release names no body anchor and no mechanism - that is a silent unknown`);
    }
  }
  record("FACT-4 release", rows.length === 0, `${anchors} release anchor(s) still write what their row says`, rows);
}

function lineOf(anchor) {
  const [, path, number] = /^(.*):(\d+)$/.exec(anchor ?? "") ?? [];
  if (path === undefined) return null;
  try {
    return readFileSync(join(ROOT, path), "utf8").split("\n")[Number(number) - 1] ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- IFACE-2 hold sufficiency (shared with the search)
{
  const companions = (model.environmentReads ?? []).filter((read) => !/canmove$/i.test(read.member));
  const found = searchCounterExamples({
    root: ROOT,
    companions,
    residual: model.orphanHoldResidual ?? [],
    unattributed: model.unattributedHoldSites ?? [],
  });
  const rows = [
    `scanned ${found.fileCount} files: ${found.siteCount} writes of the move flag, ${found.accompanied} accompanied, ${found.orphans.length} orphans, ${found.unparsed.length} unparsed`,
    ...found.undeclaredOrphans.map((o) => `UNADJUDICATED orphan: ${o.site} ${o.method}()`),
    ...found.staleRows.map((r) => `stale residual row: ${r.site} is no longer an orphan`),
    ...found.undeclaredUnattributed.map((u) => `UNNAMED site: ${u.site} is not adjudicated`),
    ...found.staleUnattributed.map((r) => `stale unattributed row: ${r.site}`),
  ];
  record(
    "IFACE-2 hold sufficiency",
    found.undeclaredOrphans.length === 0 &&
      found.staleRows.length === 0 &&
      found.undeclaredUnattributed.length === 0 &&
      found.staleUnattributed.length === 0 &&
      found.siteCount > 0,
    "every site that holds the actor is accompanied by a holding write of a declared read, or adjudicated",
    rows,
  );
}

// ---------------------------------------------------------------- decision sites
const DECISION_PATTERNS = [
  {
    id: "body-env triple (fork)",
    re: /Game1\.activeClickableMenu is not null \|\| Game1\.eventUp \|\| !(Game1\.player|actor)\.CanMove/,
  },
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
const scannedLines = [];
for (const f of ourSources) {
  const rel = repoPath(f);
  readFileSync(f, "utf8")
    .split("\n")
    .forEach((line, i) => {
      scannedLines.push({ file: rel, line: i + 1, text: line.trim() });
      for (const p of DECISION_PATTERNS)
        if (p.re.test(line))
          decisionSites.push({ file: rel, line: i + 1, kind: p.id, text: line.trim().slice(0, 120) });
    });
}

// ---------------------------------------------------------------- DECISION-1 sites
{
  const rows = [];
  const declared = new Map((model.adjudication?.decisionSites ?? []).map((entry) => [entry.file, entry]));
  const byFile = new Map();
  for (const site of decisionSites) byFile.set(site.file, (byFile.get(site.file) ?? 0) + 1);
  for (const [file, count] of [...byFile].sort()) {
    const entry = declared.get(file);
    if (entry === undefined) {
      rows.push(`UNDECLARED decision site: ${file} (${count} occurrences)`);
      continue;
    }
    if (!["not_a_decision", "second_spelling_owed"].includes(entry.verdict))
      rows.push(`${file}: verdict "${entry.verdict}" is not in the closed set`);
    // `not_a_decision` is a claim about the matches themselves: they are prose. A code line carrying the same text
    // would make the claim false while the row stayed in place, so it is checked rather than believed.
    const matches = decisionSites.filter((site) => site.file === file);
    if (
      entry.verdict === "not_a_decision" &&
      matches.some(
        (site) =>
          !/^\s*(\/\/|\/\*|\*)/.test(scannedLines.find((l) => l.file === file && l.line === site.line)?.text ?? ""),
      )
    )
      rows.push(`${file}: declared "not_a_decision" but a match is a code line, not prose`);
    if (
      entry.verdict === "second_spelling_owed" &&
      matches.every((site) =>
        /^\s*(\/\/|\/\*|\*)/.test(scannedLines.find((l) => l.file === file && l.line === site.line)?.text ?? ""),
      )
    )
      rows.push(`${file}: declared "second_spelling_owed" but every match is prose`);
  }
  for (const entry of declared.values())
    if (!byFile.has(entry.file)) rows.push(`stale adjudication row: ${entry.file} decides nothing any more`);
  record(
    "DECISION-1 sites",
    rows.length === 0,
    `${decisionSites.length} decision site(s) in ${byFile.size} file(s), ${declared.size} adjudicated`,
    rows,
  );
}

// ---------------------------------------------------------------- DECISION-2 derived inputs
{
  const rows = [];
  for (const derived of model.adjudication?.derivedInputs ?? []) {
    for (const site of scannedLines)
      if (site.text.includes(derived.form))
        rows.push(`${site.file}:${site.line} decides on ${derived.form} (${derived.id})`);
  }
  record(
    "DECISION-2 derived inputs",
    rows.length === 0,
    `${(model.adjudication?.derivedInputs ?? []).length} forbidden derived input(s) across ${scannedLines.length} scanned line(s)`,
    rows,
  );
}

// ---------------------------------------------------------------- DECISION-3 owed rows
{
  const rows = [];
  const owed = (model.adjudication?.decisionSites ?? []).filter((entry) => entry.verdict === "second_spelling_owed");
  for (const entry of owed) {
    if ((entry.owner ?? "").trim() === "") rows.push(`${entry.file}: owed row names no owner`);
    if ((entry.closesWhen ?? "").trim() === "") rows.push(`${entry.file}: owed row names no closing condition`);
    if ((entry.what ?? "").trim() === "") rows.push(`${entry.file}: owed row does not say what is second-spelled`);
  }
  record(
    "DECISION-3 owed",
    rows.length === 0,
    `${owed.length} second spelling(s) the tree still carries, each with an owner and a closing condition`,
    rows,
  );
}

// ---------------------------------------------------------------- report
console.log(`\n=== actor-admissibility closure  (slice: ${model.slice}) ===\n`);
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.id.padEnd(24)} ${r.headline}`);
  for (const row of r.rows.slice(0, 12)) console.log(`        - ${row}`);
  if (r.rows.length > 12) console.log(`        ... and ${r.rows.length - 12} more`);
}
const owed = (model.adjudication?.decisionSites ?? []).filter((entry) => entry.verdict === "second_spelling_owed");
if (owed.length > 0) {
  console.log(`\n-- DECLARED, NOT CLOSED: ${owed.length} second spelling(s) of the hold vocabulary --`);
  for (const entry of owed) console.log(`   ${entry.file}  (owner ${entry.owner})  closes when: ${entry.closesWhen}`);
}
// A QUERY, not a report to interpret: the catalog is not this contract's population, and neither number decides
// anything above.
const catalog = (() => {
  try {
    return new Set(
      [
        ...readFileSync(
          join(ROOT, "integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs"),
          "utf8",
        ).matchAll(/E\("([a-z0-9_]+)"/g),
      ].map((m) => m[1]),
    );
  } catch {
    return new Set();
  }
})();
console.log(
  `\n-- query (not a verdict): ${catalog.size} registered action(s); the action algebra is NOT claimed by this gate --\n`,
);

const examined = (model.facts ?? []).length;
console.log(`\n=== ${failed === 0 ? "DESIGN CLOSED over the fact algebra" : `${failed} check(s) FAILED`} ===\n`);
console.log(
  JSON.stringify({
    gate: "stardew_actor_admissibility/v1",
    status: failed === 0 ? "passed" : "failed",
    examined,
    checks: results.map((r) => ({
      id: r.id,
      status: r.ok ? "passed" : "failed",
      ...(r.rows.length === 0 ? {} : { detail: r.rows.slice(0, 6).join("; ") }),
    })),
  }),
);
process.exit(examined === 0 ? 2 : failed === 0 ? 0 : 1);
