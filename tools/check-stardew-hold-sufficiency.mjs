#!/usr/bin/env node
/**
 * Hold-sufficiency counter-example search  (环境侧闭环：反例消除)
 *
 * THE ASSERTION THIS DECIDES:
 *
 *     every site that writes `Farmer.canMove = false` in the decompiled tree has, in its own method or one same-file
 *     callee, a write that ESTABLISHES one of the facts `WorldModel.ReadFacts` reads - or carries an adjudicated row
 *     in the contract naming the fact that holds there (or, where no fact can name it, the reason and what evidence
 *     would settle it).
 *
 *   because if one does not, the game holds the actor while our reads still say `Idle` - an orphan hold, a state we
 *   cannot name, cannot report, and cannot remedy. That is a hole in the state space, not a documentation gap.
 *
 * THE COMPANION SIDE IS THE CONTRACT'S, AND IT IS DIRECTIONAL. `environmentReads` is derived from `ReadFacts`, so the
 * population cannot go stale (`tools/derive-stardew-actor-admissibility.mjs`), and each read carries the predicate it
 * is HOLDING under (`bool` -> `= true`, `IClickableMenu` -> `!= null`, `freezePause` -> `> 0`, `timeOfDay` -> `>= 2600`,
 * `Stamina` -> `<= -15`, `toolPower` -> `!= 0`). That predicate is not decoration: the earlier version of this search
 * accepted ANY write to a companion member, so `PauseForSingleAnimation = false` (Farmer.cs:8448) and
 * `globalFade = false` (ScreenFade.cs:82) counted as accompaniment for the holds those lines CREATE. Five sites were
 * rescued that way and two of them are not accompanied at all - they are holds whose establishing write is elsewhere.
 * A check that counts a CLEARING write as evidence for a hold is a check that says the opposite of what it claims.
 *
 * DECLARED BOUND OF THE ANALYSIS (a bound that is not stated is a lie):
 *   - lexical, not dataflow; brace matching over the decompiled C#
 *   - "accompanied" is decided at METHOD granularity, and follows same-file callees ONE level deep
 *   - a write whose right-hand side is not a literal counts as establishing, because this analysis cannot evaluate
 *     it; that is a bound, and it is why the residual rows exist rather than a claim of zero
 *   - a companion established in another TYPE is invisible here (that is the `deeper_accompaniment` family)
 *   Therefore a residual row is a JUDGEMENT about Stardew's source, checked against the engine on every run by the
 *   row's own release anchor: the line that row blames for the release must still write what the row says it writes.
 *
 * WHAT IT REFUSES TO REPORT GREEN OVER: `examined: 0`. A search that scanned no file has not shown anything, so the
 * report says `blocked` and the exit code says so too.
 *
 * red-proof: inject  one `environmentReads` entry removed from the contract, so a hold loses the read that
 *   establishes it -> report status failed with `residual_adjudicated` (18 orphans against 16 adjudicated rows) and
 *   `adjudication_named` naming a `namedBy` that is not a declared fact, exit 1
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { reportBlockedInput } from "./lib/blocked-input-report.mjs";

export const HELD_FACT = "Farmer.canMove";

export const ACTOR_ADMISSIBILITY_CONTRACT =
  "integrations/stardew/action-development/contracts/actor-admissibility/actor-admissibility.v1.json";

/**
 * The contract's text, or null when it is not there - the caller reports the blocked reading its own id names.
 *
 * An absent input is neither a pass nor a finding, and it is the one verdict a gate with no subject can honestly
 * reach.
 */
export function readActorAdmissibilityContract(root) {
  try {
    return readFileSync(join(root, ACTOR_ADMISSIBILITY_CONTRACT), "utf8");
  } catch {
    return null;
  }
}

export function repoRoot(from = process.cwd()) {
  let d = from;
  for (let i = 0; i < 8; i++) {
    try {
      if (statSync(join(d, "AGENTS.md")).isFile()) return d;
    } catch {}
    d = join(d, "..");
  }
  throw new Error("repository root not found");
}

function walk(dir, acc = []) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (e.name.endsWith(".cs")) acc.push(p);
  }
  return acc;
}

/** The member name of a declared read, e.g. `Farmer.canMove` -> `canMove`. */
const memberOf = (read) => read.split(".").slice(-1)[0];

/**
 * Enclosing method body for a line, by scanning back for a signature and forward to its matching brace.
 * Returns null when the shape is not recognised (honest: the caller must count those, not ignore them).
 */
export function enclosingMethod(lines, index) {
  for (let i = index; i >= 0 && index - i < 400; i--) {
    const line = lines[i];
    if (!/\b(public|private|protected|internal)\b/.test(line)) continue;
    if (/;\s*$/.test(line.trim())) continue; // a declaration, not a body
    if (!/\)\s*$/.test(line.trim()) && !/\)\s*\{/.test(line.trim())) continue;
    let depth = 0;
    let started = false;
    for (let j = i; j < lines.length && j < i + 4000; j++) {
      for (const ch of lines[j]) {
        if (ch === "{") {
          depth++;
          started = true;
        } else if (ch === "}") {
          depth--;
        }
      }
      if (started && depth === 0) {
        const name = (line.match(/\b([A-Za-z_]\w*)\s*\(/) ?? [])[1] ?? "?";
        return { name, start: i, end: j, lines: lines.slice(i, j + 1) };
      }
    }
    return null;
  }
  return null;
}

/** Whether `value` satisfies the read's holding predicate. */
function satisfies(value, relation, threshold) {
  switch (relation) {
    case "=":
      return value === threshold;
    case "!=":
      return value !== threshold;
    case "<":
      return value < threshold;
    case "<=":
      return value <= threshold;
    case ">":
      return value > threshold;
    case ">=":
      return value >= threshold;
    default:
      return false;
  }
}

/**
 * Whether a write to `member` ESTABLISHES its read, i.e. moves it into the holding predicate.
 *
 * The value is read off the assignment's right-hand side. A literal is evaluated against the predicate; anything else
 * (a call, a field, an expression) is counted as establishing, because this analysis cannot evaluate it - a stated
 * bound, and the reason the residual rows exist.
 */
export function writeEstablishes(holdsWhen, rhsText) {
  const rhs = rhsText.trim().replace(/;$/, "").trim();
  const literal = /^-?\d+(?:\.\d+)?[fFdD]?$/.test(rhs) ? Number(rhs.replace(/[fFdD]$/, "")) : null;
  if (holdsWhen.value === true || holdsWhen.value === false) {
    if (rhs === "true") return true;
    if (rhs === "false" || rhs === "0") return false;
    return literal === null;
  }
  if (holdsWhen.value === null) return rhs !== "null";
  if (literal === null) return true;
  return satisfies(literal, holdsWhen.relation, holdsWhen.value);
}

/** The right-hand side of an assignment to `member` on this line, or null when the line does not assign it. */
function assignmentTo(line, member) {
  const match = new RegExp(`(?:${member})\\s*(\\.Value\\s*)?=(?!=)\\s*([^;]*);`, "i").exec(line);
  return match === null ? null : match[2];
}

/** The events of a hold site, one per declared read, with the write that accompanies it (if any). */
function accompaniment(body, companions) {
  for (const companion of companions) {
    for (const line of body) {
      const rhs = assignmentTo(line, memberOf(companion.member));
      if (rhs !== null && writeEstablishes(companion.holdsWhen, rhs))
        return { member: companion.member, write: line.trim() };
    }
  }
  return null;
}

/**
 * The measured population: every literal `canMove = false` write, whether a declared read establishes a fact at that
 * site, and the sites the brace walk cannot attribute at all.
 *
 * `companions` is `contract.environmentReads`; `residual` and `unattributed` are the contract's adjudications, compared
 * bidirectionally so a new orphan fails and a row that stopped describing one fails too.
 */
export function searchCounterExamples({
  root,
  heldFact = HELD_FACT,
  companions = [],
  residual = [],
  unattributed = [],
}) {
  const gameRoot = join(root, "ref/external/StardewValleyDecompiled");
  const files = walk(gameRoot);
  const held = memberOf(heldFact);
  const heldFalseRe = new RegExp(`\\b${held}\\s*=\\s*false`, "i");
  const repoPath = (file) => relative(root, file).replace(/\\/g, "/");

  const sites = [];
  const unparsed = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (!heldFalseRe.test(text)) continue;
    const lines = text.split("\n");
    const declIndex = lines.findIndex((l) =>
      /^\s*(public|private|protected|internal)[^;=]*\bcanMove\b\s*=\s*true\s*;/.test(l),
    );
    lines.forEach((line, i) => {
      if (!heldFalseRe.test(line)) return;
      if (/==|!=/.test(line)) return;
      if (i === declIndex) return; // the field initialiser
      const method = enclosingMethod(lines, i);
      if (method === null) {
        unparsed.push({ site: `${repoPath(file)}:${i + 1}` });
        return;
      }
      const own = accompaniment(method.lines, companions);
      let accompanied = own !== null;
      let where = own === null ? null : "own method";
      let companion = own?.member ?? null;
      if (!accompanied) {
        // one level of same-file callees
        for (const name of calledNames(method.lines)) {
          const calleeIndex = lines.findIndex(
            (l, k) =>
              k !== i &&
              new RegExp(`\\b${name}\\s*\\(`).test(l) &&
              /\b(public|private|protected|internal)\b/.test(l) &&
              !/;\s*$/.test(l.trim()),
          );
          if (calleeIndex < 0) continue;
          const callee = enclosingMethod(lines, calleeIndex);
          if (callee === null) continue;
          const viaCallee = accompaniment(callee.lines, companions);
          if (viaCallee !== null) {
            accompanied = true;
            where = `callee ${callee.name}`;
            companion = viaCallee.member;
            break;
          }
        }
      }
      sites.push({
        site: `${repoPath(file)}:${i + 1}`,
        method: method.name,
        accompanied,
        where,
        companion,
        text: line.trim().slice(0, 110),
      });
    });
  }

  const orphans = sites.filter((s) => !s.accompanied);
  const declaredKeys = new Set(residual.map((r) => r.site));
  const key = (s) => s.site;
  const declaredUnattributed = new Set(unattributed.map((r) => r.site));
  return {
    fileCount: files.length,
    siteCount: sites.length,
    accompanied: sites.length - orphans.length,
    orphans,
    unparsed,
    undeclaredOrphans: orphans.filter((s) => !declaredKeys.has(key(s))),
    staleRows: residual.filter((r) => !orphans.some((s) => key(s) === r.site)),
    undeclaredUnattributed: unparsed.filter((u) => !declaredUnattributed.has(u.site)),
    staleUnattributed: unattributed.filter((row) => !unparsed.some((u) => u.site === row.site)),
  };
}

function calledNames(body) {
  const names = new Set();
  for (const line of body) {
    if (/^\s*\/\//.test(line) || /^\s*\/\*/.test(line)) continue;
    for (const m of line.matchAll(/(?:\.|^|\s)([A-Za-z_]\w*)\s*\(/g)) names.add(m[1]);
  }
  return names;
}

/**
 * The release each residual row blames: the engine line must still say what the row says it says.
 *
 * This is the half the two gates were missing. Both counted ENTRY sites only, so a hold that lost its release kept
 * every gate green - and "the engine can no longer leave this hold" is exactly the defect the residual exists to
 * adjudicate. The statement is pinned by content (normalised, not by line number alone), so a moved, edited or deleted
 * release is red here with the line it was on.
 */
export function releasePins(root, rows) {
  const failures = [];
  let examined = 0;
  for (const row of rows) {
    const release = row.release;
    if (release?.anchor === undefined) {
      failures.push(`${row.site}: no release anchor (a hold with no stated release is not adjudicated)`);
      continue;
    }
    examined += 1;
    const [, path, line] = /^(.*):(\d+)$/.exec(release.anchor) ?? [];
    let text = null;
    try {
      text = readFileSync(join(root, path), "utf8").split("\n")[Number(line) - 1] ?? null;
    } catch {
      text = null;
    }
    if (text === null) {
      failures.push(`${row.site}: release anchor ${release.anchor} does not resolve`);
      continue;
    }
    const statement = text.replace(/\s+/g, " ").trim();
    if (statement !== release.statement)
      failures.push(
        `${row.site}: release anchor ${release.anchor} now reads "${statement}", the row pinned "${release.statement}"`,
      );
    else if (
      !/\b[Cc]anMove\s*=\s*true\b|\bcanMove\s*=\s*true\b|forceCanMove\s*\(|currentMinigame\s*=\s*null\b/.test(statement)
    )
      failures.push(`${row.site}: release anchor ${release.anchor} no longer writes a release ("${statement}")`);
  }
  return { examined, failures };
}

/**
 * Whether each row's adjudication is a REAL one, in both directions.
 *
 * A `named_by_fact` row must name a fact the contract itself declares (`environmentReads`, derived from `ReadFacts`),
 * because the row's whole claim is "a read we publish covers this hold" and a name nobody reads covers nothing. A row
 * that no fact names must state why and what would settle it - a named unknown is acceptable, a silent one is not.
 * The population is the contract's rows, so a hand-edited row is checked by the same rule as a derived one.
 */
export function adjudicationNames(model, rows) {
  const facts = new Set((model.environmentReads ?? []).map((read) => read.fact));
  const failures = [];
  let named = 0;
  let unnamed = 0;
  for (const row of rows) {
    if (row.namedBy === null) {
      unnamed += 1;
      if (row.verdict !== "named_unknown")
        failures.push(`${row.site}: names no fact but its verdict is "${row.verdict}", not named_unknown`);
      if (!row.unknownReason || !row.settledBy)
        failures.push(`${row.site}: no fact names it, so it must state why and what would settle it`);
      continue;
    }
    named += 1;
    if (row.verdict !== "named_by_fact")
      failures.push(`${row.site}: names ${row.namedBy} but its verdict is "${row.verdict}", not named_by_fact`);
    if (!facts.has(row.namedBy))
      failures.push(`${row.site}: namedBy "${row.namedBy}" is not a declared fact of ${[...facts].join(", ")}`);
  }
  return { named, unnamed, failures };
}

// ------------------------------------------------------------------ CLI
// Windows: import.meta.url is file:///E:/... while argv[1] is E:\..., so compare by resolved URL.
const invokedDirectly = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  const root = repoRoot();
  const modelSource = readActorAdmissibilityContract(root);
  if (modelSource === null)
    reportBlockedInput({
      gate: "stardew_hold_sufficiency/v1",
      input: ACTOR_ADMISSIBILITY_CONTRACT,
      examined: 0,
      checks: ["contract_readable"],
    });
  const model = JSON.parse(modelSource);
  const companions = (model.environmentReads ?? []).filter(
    (read) => memberOf(read.member).toLowerCase() !== memberOf(HELD_FACT).toLowerCase(),
  );
  const residual = model.orphanHoldResidual ?? [];
  const unattributed = model.unattributedHoldSites ?? [];
  const found = searchCounterExamples({ root, companions, residual, unattributed });
  // Every row states the release it blames, whether the analysis could place it or not: an entry site whose release
  // nobody checked is the hole both gates used to have.
  const pins = releasePins(root, [...residual, ...unattributed]);
  const naming = adjudicationNames(model, [...residual, ...unattributed]);

  const checks = [
    {
      id: "contract_readable",
      status: "passed",
      detail: `${ACTOR_ADMISSIBILITY_CONTRACT}: ${companions.length} declared reads`,
    },
    {
      id: "companions_declared",
      status: companions.length > 0 ? "passed" : "failed",
      detail:
        companions.length > 0
          ? `${companions.length} reads, each with the predicate it is holding under`
          : "no declared read, so nothing could accompany a hold",
    },
    {
      id: "residual_adjudicated",
      status: found.undeclaredOrphans.length === 0 && found.staleRows.length === 0 ? "passed" : "failed",
      detail:
        `${found.orphans.length} orphan(s) against ${residual.length} adjudicated row(s)` +
        (found.undeclaredOrphans.length > 0
          ? `; UNADJUDICATED: ${found.undeclaredOrphans.map((o) => `${o.site} ${o.method}()`).join(", ")}`
          : "") +
        (found.staleRows.length > 0 ? `; STALE: ${found.staleRows.map((r) => r.site).join(", ")}` : ""),
    },
    {
      id: "unattributed_named",
      status: found.undeclaredUnattributed.length === 0 && found.staleUnattributed.length === 0 ? "passed" : "failed",
      detail:
        `${found.unparsed.length} site(s) the brace walk cannot attribute against ` +
        `${unattributed.length} named one(s)` +
        (found.undeclaredUnattributed.length > 0
          ? `; UNNAMED: ${found.undeclaredUnattributed.map((u) => u.site).join(", ")}`
          : "") +
        (found.staleUnattributed.length > 0 ? `; STALE: ${found.staleUnattributed.map((r) => r.site).join(", ")}` : ""),
    },
    {
      id: "adjudication_named",
      status: naming.failures.length === 0 && naming.named + naming.unnamed > 0 ? "passed" : "failed",
      detail:
        naming.failures.length > 0
          ? naming.failures.join("; ")
          : naming.named + naming.unnamed === 0
            ? "no adjudicated row, so nothing named the holds"
            : `${naming.named} row(s) name a declared fact; ${naming.unnamed} state why none can`,
    },
    {
      id: "release_pins",
      status: pins.failures.length === 0 ? "passed" : "failed",
      detail:
        pins.failures.length === 0
          ? `${pins.examined} release anchor(s) still write what their row says`
          : pins.failures.join("; "),
    },
  ];

  console.log(`\n=== hold-sufficiency counter-example search  (${HELD_FACT} = false) ===\n`);
  console.log(`  scanned files:                    ${found.fileCount}`);
  console.log(`  writes of ${HELD_FACT}=false:      ${found.siteCount}`);
  console.log(`  ACCOMPANIED by a holding write:   ${found.accompanied}`);
  console.log(`  ORPHANS (no holding write):       ${found.orphans.length}`);
  console.log(`  unparsed (no method recognised):  ${found.unparsed.length}`);
  console.log(`\n  --- orphans, each adjudicated in the contract ---`);
  for (const o of found.orphans) {
    const row = residual.find((r) => r.site === o.site);
    console.log(
      `  ${o.site}  ${o.method}()  ->  ${row === undefined ? "UNADJUDICATED" : `${row.verdict}${row.namedBy === null ? "" : ` (${row.namedBy})`}`}`,
    );
  }
  if (found.unparsed.length) {
    console.log(`\n  --- unparsed (the analysis bound, stated rather than hidden) ---`);
    for (const u of found.unparsed) console.log(`  ${u.site}`);
  }

  const failed = checks.filter((check) => check.status === "failed");
  const examined = found.siteCount + found.unparsed.length;
  console.log(
    `\n=== ${failed.length === 0 ? "ENVIRONMENT CLOSED: the declared reads are a sufficient statistic" : `${failed.length} check(s) FAILED`} ===\n`,
  );
  console.log(
    JSON.stringify({
      gate: "stardew_hold_sufficiency/v1",
      status: failed.length === 0 ? "passed" : "failed",
      examined,
      checks,
    }),
  );
  if (examined === 0 || failed.length > 0) process.exit(examined === 0 ? 2 : 1);
}
