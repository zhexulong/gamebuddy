#!/usr/bin/env node
/**
 * Hold-sufficiency counter-example search  (环境侧闭环：反例消除)
 *
 * THE QUESTION THIS ANSWERS, and why the earlier version did not:
 *
 *   A whitelist of ~100 game filenames proves nothing. It only silences the linter. What has to be
 *   decided is the ASSERTION:
 *
 *     every site that sets `canMove = false` is accompanied by at least one of the companion facts
 *     (activeClickableMenu / eventUp / dialogueUp / freezePause / isEating / UsingTool / isWarping /
 *      stamina<=-15 / timeOfDay>=2600)
 *
 *   because if one is NOT, the game holds the actor while our reads still say `Idle` - an orphan hold,
 *   a state we cannot name, cannot report, and cannot remedy. That is a hole in the state space, not a
 *   documentation gap.
 *
 *   So the tool SEARCHES FOR COUNTER-EXAMPLES. Its output is the residual: the sites it could not
 *   accompany. The declaration then only ever lists that residual (each with a reason and an anchor),
 *   and the set is compared bidirectionally - a new orphan fails the check, and a fixed one fails until
 *   the row is deleted. Zero humans written down when the residual is empty.
 *
 * DECLARED BOUND OF THE ANALYSIS (a bound that is not stated is a lie):
 *   - lexical, not dataflow; brace matching over the decompiled C#
 *   - "accompanied" is decided at METHOD granularity, and follows same-file callees ONE level deep
 *   - a companion WRITE counts; a companion READ does not (a branch on `eventUp` does not establish it)
 *   Therefore a residual row is a PROMPT TO READ THE CODE, not a verdict. Each residual must be
 *   adjudicated as exactly one of:
 *       missing_read          -> the state space is incomplete; add the fact (the finding we want)
 *       deeper_accompaniment  -> established in a callee this analysis cannot see; name the anchor
 *       not_a_hold            -> the write does not hold the actor (e.g. it is followed by a release
 *                                in the same method, or it belongs to a debug/non-production entry)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { reportBlockedInput } from "./lib/blocked-input-report.mjs";

export const HELD_FACT = "Farmer.canMove";

/**
 * The algebra both admissibility checks are properties OF: the states, the causes, the remedies, the adjudicated
 * decision sites and the residual this search has to account for.
 *
 * Nothing in this repository produces it and no commit has ever carried it, so a checkout has no subject for either
 * gate and neither can report on the invariants it exists to decide.
 *
 * WHY IT IS STILL BLOCKED, AND WHAT WOULD UNBLOCK IT (decided 2026-11-12; measured, not assumed):
 *
 *   The algebra half of this document IS derivable, and a producer should read it from the authorities that already
 *   own each part rather than restating them: the states from `ActorDispositionKind` and its wire spellings
 *   (`integrations/stardew/WorldModel.cs:23` and `:118`), the causes from `WorldModel.HoldReasonCode` (`:308`), the
 *   companion reads from `WorldModel.ReadFacts` (`:251` - the facts the disposition is a pure function of, and the
 *   only honest source for `environmentReads`), the actions and their `admissibleIn` from
 *   `FarmhandActionCatalog.ModalResolvingActionIds` / `EventActingActionIds` / `ModalFamilyActionsWithoutAnEventPath`
 *   (`integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs:895`, `:921`, `:936`) joined to the profile
 *   rule in `integrations/stardew/ExecutionAdmission.cs:353`, and the remedies from
 *   `host/src/stardew-action-remedy.ts:49`.
 *
 *   What cannot be derived is `orphanHoldResidual`, and it is the part that blocks the document. Run with the
 *   companion set above against `ref/external/StardewValleyDecompiled`, this search measures 948 files, 58 writes of
 *   `Farmer.canMove = false`, 41 accompanied, **17 orphans and 4 unparsed sites** - and 16 of the 17 are holds no
 *   declared read can name (the one exception releases the flag in its own method). Each row is a verdict about the
 *   ENGINE - `missing_read` (our state space is incomplete: add the fact), `deeper_accompaniment` (established in a
 *   callee this analysis cannot see: name the anchor) or `not_a_hold` (the write does not hold the actor: say why) -
 *   and writing one from here would be a claim about Stardew's source that only a read of that source can support.
 *   A `missing_read` verdict is not paperwork: it is a new fact in `ActorWorldFacts` plus a hold code in
 *   `WorldModel.HoldReasonCode`, which is the Mod's gameplay state and therefore the `game-action-boundary` ->
 *   `game-action-implement` pipeline's decision, not this gate's.
 *
 *   The four `unparsed` rows are this file's own bound rather than a decision (the brace walk in `enclosingMethod`
 *   loses GameLocation.cs:9287/9297/9321/9345), and they block the CLI's green as well; they are recorded here
 *   rather than silently dropped.
 *
 *   Once the residual is adjudicated and the rest is produced from the authorities above, this gate checks exactly
 *   what it checks today: every write of `Farmer.canMove = false` in the decompiled tree is accompanied by one of the
 *   declared reads, or carries an adjudicated row - compared bidirectionally, so a new orphan and a row that stopped
 *   describing one are both red.
 */
export const ACTOR_ADMISSIBILITY_CONTRACT =
  "integrations/stardew/action-development/contracts/actor-admissibility/actor-admissibility.v1.json";

/**
 * The contract's text, or null when it is not there - the caller reports the blocked reading its own id names.
 *
 * This replaces `JSON.parse(readFileSync(...))` at both entry points, whose ENOENT stack trace was non-zero for a
 * reason no reader could tell from a defect in the gate reading it. An absent input is neither a pass nor a finding,
 * and it is the one verdict a gate with no subject can honestly reach.
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

const COMPANION_RE = (members) => new RegExp(`(?:${members.join("|")})\\s*(?:=[^=]|\\.Value\\s*=|\\.Add)`, "i");

function calledNames(body) {
  const names = new Set();
  for (const line of body) {
    if (/^\s*\/\//.test(line) || /^\s*\/\*/.test(line)) continue;
    for (const m of line.matchAll(/(?:\.|^|\s)([A-Za-z_]\w*)\s*\(/g)) names.add(m[1]);
  }
  return names;
}

export function searchCounterExamples({ root, heldFact = HELD_FACT, companionReads, residual = [] }) {
  const gameRoot = join(root, "ref/external/StardewValleyDecompiled");
  const files = walk(gameRoot);
  const held = memberOf(heldFact);
  const companions = companionReads.map(memberOf);
  const companionRe = COMPANION_RE(companions);
  const heldFalseRe = new RegExp(`\\b${held}\\s*=\\s*false`, "i");

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
        unparsed.push({ file: relative(root, file).replace(/\\/g, "/"), line: i + 1 });
        return;
      }
      const ownBody = method.lines.join("\n");
      let accompanied = companionRe.test(ownBody);
      let where = accompanied ? "own method" : null;
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
          if (companionRe.test(callee.lines.join("\n"))) {
            accompanied = true;
            where = `callee ${callee.name}`;
            break;
          }
        }
      }
      sites.push({
        file: relative(root, file).replace(/\\/g, "/"),
        line: i + 1,
        method: method.name,
        accompanied,
        where,
        text: line.trim().slice(0, 110),
      });
    });
  }

  const asOrphan = sites.filter((s) => !s.accompanied);
  const declaredKeys = new Set(residual.map((r) => r.site));
  const key = (s) => `${s.file}:${s.line}`;
  return {
    fileCount: files.length,
    siteCount: sites.length,
    accompanied: sites.length - asOrphan.length,
    orphans: asOrphan,
    unparsed,
    undeclaredOrphans: asOrphan.filter((s) => !declaredKeys.has(key(s))),
    staleRows: residual.filter((r) => !asOrphan.some((s) => key(s) === r.site)),
  };
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
  const companions = model.environmentReads
    .map((r) => r.member)
    .filter((m) => memberOf(m).toLowerCase() !== memberOf(HELD_FACT).toLowerCase());
  const residual = model.orphanHoldResidual ?? [];
  const r = searchCounterExamples({ root, companionReads: companions, residual });

  console.log(`\n=== hold-sufficiency counter-example search  (${HELD_FACT} = false) ===\n`);
  console.log(`  scanned files:                    ${r.fileCount}`);
  console.log(`  writes of ${HELD_FACT}=false:      ${r.siteCount}`);
  console.log(`  ACCOMPANIED by a companion fact:  ${r.accompanied}`);
  console.log(`  ORPHANS (no companion in scope):  ${r.orphans.length}`);
  console.log(`  unparsed (no method recognised):  ${r.unparsed.length}`);
  console.log(`\n  --- orphans requiring adjudication ---`);
  for (const o of r.orphans.slice(0, 40)) console.log(`  ${o.file}:${o.line}  ${o.method}()  ::  ${o.text}`);
  if (r.orphans.length > 40) console.log(`  ... and ${r.orphans.length - 40} more`);
  if (r.unparsed.length) {
    console.log(`\n  --- unparsed (the analysis bound, stated rather than hidden) ---`);
    for (const u of r.unparsed.slice(0, 10)) console.log(`  ${u.file}:${u.line}`);
  }
  if (r.undeclaredOrphans.length) {
    console.log(`\n  FAIL  ${r.undeclaredOrphans.length} orphan(s) are NOT adjudicated in the contract`);
  }
  if (r.staleRows.length) {
    console.log(`\n  FAIL  ${r.staleRows.length} adjudication row(s) no longer describe an orphan`);
  }
  const ok = r.undeclaredOrphans.length === 0 && r.staleRows.length === 0 && r.unparsed.length === 0;
  console.log(`\n=== ${ok ? "ENVIRONMENT CLOSED: the reads are a sufficient statistic" : "NOT CLOSED"} ===\n`);
  process.exit(ok ? 0 : 1);
}
