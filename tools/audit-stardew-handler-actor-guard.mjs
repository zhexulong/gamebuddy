/**
 * Per-handler scope-bound actor guard audit, as a ratchet.
 *
 * Counts, for every `RequestLocal*` handler in the Mod execution controller
 * (public or private — `RequestLocalDoorTransition` is a private helper reached
 * from the two enter/exit entry points), whether that handler's OWN body routes
 * through the scope-bound actor proof or the shared admission. A whole-file count
 * is not enough: a partial file with 11 handlers and 3 references leaves 8 handlers
 * unguarded, and a file-level check reports the file as "guarded".
 *
 * A naive regex is not enough either: `Request\w*\(` must not be allowed to skip
 * a handler, so handlers are located by scanning for the exact declaration
 * prefix and then brace-matching to the end of the method.
 *
 * WHAT "GUARDED" MEANS, AND WHY IT IS DERIVED. A handler is guarded when its own
 * body calls `TryGetBoundActor`, or calls a method of this controller whose body
 * performs the shared admission (`admissionSeams` derives that set from the source).
 * It used to be two literal markers, `TryGetBoundActor` and `AdmitExecution(`, and
 * the reading it produced on 2026-11-13 was **71 unguarded** — which was false. The
 * walking-subject handlers had moved onto `RequestLocalTileTarget`, the machine and
 * animal handlers onto `AdmitLocalExecution`, and neither spelling was in the list,
 * so 71 handlers that route through the authority were counted as holes. The same
 * census over the commit the 71 was measured at reports 0 with the derived set. That
 * is the defect this file can now state: a hand-list of spellings is the thing that
 * goes stale, so the seam set is derived from the Mod and printed by name.
 *
 * WHY IT HAS AN EXIT CODE AND A BASELINE. For two days this file printed a number and
 * exited 0, so the number had no verdict: a handler added without a guard arrived in
 * silence. It is a ratchet now. The sites unguarded when the baseline was recorded
 * live in `tools/audit-stardew-handler-actor-guard-baseline.json`, keyed by file and
 * handler (never by line number), and they may only shrink:
 *
 *   - a site unguarded and NOT in the baseline is `handler_actor_guard_grew` and exits
 *     1 — the regression this file could not report before;
 *   - a site in the baseline that is guarded now is `handler_actor_guard_shrunk` and
 *     exits 1 with the remedy, because a stale ceiling absorbs the next regression:
 *     `--record-shrinks` rewrites the list, and it refuses when anything grew in the
 *     same run;
 *   - no handler at all at the revision read is `handler_actor_guard_measured_nothing`
 *     and exits 2: a ratchet over zero handlers agrees with itself.
 *
 * The ceiling at HEAD is EMPTY, and that is a reading rather than a pass: every handler
 * routes somewhere, `examined 105` says the population was read, and the first handler
 * that does not is the finding. Nothing here says an unguarded handler is acceptable —
 * it says there is none today.
 *
 * Usage: node tools/audit-stardew-handler-actor-guard.mjs [--rev <sha>] [--record-shrinks]
 *
 * red-proof: inject  a `RequestLocal*` handler whose body carries neither the actor proof nor a call to a derived seam
 *   -> `handler_actor_guard_grew: farmhandexecutioncontroller.synthetic.cs#RequestLocalSynthetic` above
 *   `handler_actor_guard: FAILED` and exit 1; a revision with no handler at all (the root commit) ->
 *   `handler_actor_guard_measured_nothing` and exit 2; a recorded site that a later edit guards ->
 *   `handler_actor_guard_shrunk` and exit 1
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanOutputLines } from "./lib/subprocess-output.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = "tools/audit-stardew-handler-actor-guard-baseline.json";

const argv = process.argv.slice(2);
let rev = "HEAD";
let recordShrinks = false;
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "--rev") rev = argv[++index];
  else if (argv[index] === "--record-shrinks") recordShrinks = true;
  else throw new Error(`unknown_argument:${argv[index]}`);
}

const DECLARATION = "LocalExecutionReceipt RequestLocal";
const INLINE_GUARD = "TryGetBoundActor";
const SHARED_ADMISSION = "AdmitExecution(";

/**
 * The name of the member a C# line sits in, walking back to the nearest four-space indented declaration.
 *
 * A local reader rather than the engine walk in `tools/lib/stardew-actor-holds.mjs`, because that one requires the
 * signature on a SINGLE line (`)` at the end) and the controller declares its seams across several: it would name the
 * method above instead, which is how a derived seam list silently loses every multi-line seam.
 */
function enclosingMemberName(lines, index) {
  for (let at = index; at >= 0; at -= 1) {
    const line = lines[at];
    if (!/^\s{4}(?:private|internal|public|protected)\s/u.test(line)) continue;
    if (line.trim().startsWith("//")) continue;
    const names = [...line.matchAll(/([A-Za-z_]\w*)\s*\(/gu)].map((match) => match[1]);
    if (names.length > 0) return { name: names[names.length - 1], isPublic: /^\s{4}public\s/u.test(line) };
  }
  return null;
}

/**
 * Every method in the controller whose OWN body performs the shared admission or the scope-bound actor proof.
 *
 * Derived from the source rather than listed, because the list of spellings is the thing that goes stale: this census
 * recognised only `AdmitExecution(` and reported 71 unguarded handlers on 2026-11-13, when the truth was far lower -
 * the machine/animal handlers had moved onto `AdmitLocalExecution` (which wraps it) and the walking-subject handlers
 * onto `RequestLocalTileTarget` (which calls it between `BeginLocalExecution` and the body). A hand list would have
 * needed the same edit a fourth time. The derivation asks the Mod which methods reach the authority, so a new seam
 * joins the census by existing and a handler that stops routing through one is still the finding.
 *
 * DECLARED BOUND: one level, like every other census in this tree. A handler that calls a helper which itself calls the
 * seam is unguarded to this reading, and that is a bound rather than a claim of zero.
 *
 * A PUBLIC `RequestLocal*` method is a wire handler, not a seam: it performs the admission for its own request, so calling
 * it from another handler is one request delegating to another rather than a proof in the caller's body. Including them
 * made the census vacuous - every dispatcher-shaped handler read as guarded by the handler it forwarded to.
 */
export function admissionSeams(files) {
  const seams = new Set(["AdmitExecution"]);
  for (const { text } of files) {
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].includes(SHARED_ADMISSION) && !lines[index].includes(`${INLINE_GUARD}(`)) continue;
      const member = enclosingMemberName(lines, index);
      if (member === null) continue;
      if (member.isPublic && member.name.startsWith("RequestLocal")) continue;
      seams.add(member.name);
    }
  }
  return seams;
}

/** Extract each handler body by brace matching from its declaration. */
export function handlersIn(text) {
  const found = [];
  let cursor = 0;
  for (;;) {
    const start = text.indexOf(DECLARATION, cursor);
    if (start < 0) break;
    // The declaration may be reached via `public` or `private`; walk back to the
    // start of the member so the extracted body includes the whole signature.
    const lineStart = text.lastIndexOf("\n", start) + 1;
    const nameStart = start + DECLARATION.length;
    const paren = text.indexOf("(", nameStart);
    const name = `RequestLocal${text.slice(nameStart, paren).trim()}`;
    // Brace-match from the opening brace of the method body.
    const open = text.indexOf("{", paren);
    let depth = 0;
    let end = open;
    for (let index = open; index < text.length; index += 1) {
      if (text[index] === "{") depth += 1;
      else if (text[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index;
          break;
        }
      }
    }
    found.push({ name, body: text.slice(lineStart, end + 1) });
    cursor = end + 1;
  }
  return found;
}

/**
 * Every `RequestLocal*` handler at `revision`, with whether its own body guards the actor.
 *
 * The reading is a revision's tree rather than the worktree (`git ls-tree` + `git show`), because that is the only state
 * this census can name: `uncommitted work is not a handler count`. The site key is `<file>#<handler>` and carries no line
 * number, so an unrelated edit above a handler cannot make the baseline read as a change.
 */
export function censusHandlers({ revision = "HEAD", git = execFileSync } = {}) {
  const files = cleanOutputLines(
    git("git", ["ls-tree", "-r", "--name-only", revision, "--", "integrations/stardew/"], { encoding: "utf8" }),
  ).filter((file) => file.length > 0 && /farmhandexecutioncontroller.*[.]cs$/.test(file));
  const sources = files.map((file) => ({
    file,
    text: git("git", ["show", `${revision}:${file}`], { encoding: "utf8" }),
  }));
  const seams = admissionSeams(sources);
  const sites = [];
  for (const { file, text } of sources) {
    for (const handler of handlersIn(text)) {
      const routes = [...seams].some((seam) => handler.body.includes(`${seam}(`));
      sites.push({
        site: `${file}#${handler.name}`,
        file: file.replace("integrations/stardew/farmhandexecutioncontroller.", ""),
        handler: handler.name,
        guarded: handler.body.includes(`${INLINE_GUARD}(`) || routes,
      });
    }
  }
  return { revision, files: files.length, seams: [...seams].sort(), sites };
}

/** The recorded ceiling: `{ schema, sites: [...] }` in path order, or null when it is not on disk. */
export function readBaseline({ root = ROOT } = {}) {
  try {
    const parsed = JSON.parse(readFileSync(join(root, BASELINE_PATH), "utf8"));
    return Array.isArray(parsed.sites) ? new Set(parsed.sites) : null;
  } catch {
    return null;
  }
}

/**
 * The verdict. `grew` is a regression, `shrunk` a stale ceiling, an empty population a blocked reading - and the three
 * are separate lines because they ask for three different things.
 */
export function decide({ census, baseline }) {
  const unguarded = census.sites.filter((entry) => !entry.guarded);
  const keys = new Set(unguarded.map((entry) => entry.site));
  const grew = [...keys].filter((site) => !baseline.has(site)).sort();
  const shrunk = [...baseline].filter((site) => !keys.has(site)).sort();
  const findings = [];
  if (census.sites.length === 0)
    findings.push({
      code: "handler_actor_guard_measured_nothing",
      detail: `revision ${census.revision} holds no \`RequestLocal*\` handler under integrations/stardew`,
    });
  for (const site of grew) findings.push({ code: "handler_actor_guard_grew", detail: site });
  for (const site of shrunk) findings.push({ code: "handler_actor_guard_shrunk", detail: site });
  return {
    examined: census.sites.length,
    files: census.files,
    guarded: census.sites.length - unguarded.length,
    unguarded,
    baselined: baseline.size,
    grew,
    shrunk,
    findings,
    status: census.sites.length === 0 ? "blocked" : grew.length > 0 || shrunk.length > 0 ? "failed" : "passed",
  };
}

function main() {
  const census = censusHandlers({ revision: rev });
  const baseline = readBaseline();
  if (baseline === null && !recordShrinks) {
    console.log(`handler_actor_guard_baseline_missing: ${BASELINE_PATH}`);
    console.log(
      "handler_actor_guard: blocked - with no recorded ceiling every reading would be a new one; record it once with " +
        "--record-shrinks",
    );
    process.exit(2);
  }
  const verdict = decide({ census, baseline: baseline ?? new Set() });

  console.log(
    `handler_actor_guard: examined ${verdict.examined} handler(s) in ${verdict.files} file(s) at ${rev} · ` +
      `unguarded ${verdict.unguarded.length} · baselined ${verdict.baselined}`,
  );
  console.log(`handler_actor_guard_seams: ${census.seams.length} derived - ${census.seams.join(", ")}`);
  for (const entry of verdict.unguarded) console.log(`  ${entry.file.padEnd(34)} ${entry.handler}`);

  if (recordShrinks) {
    // The first record has no ceiling to grow past; every later one may only shrink.
    if (verdict.grew.length > 0 && baseline !== null) {
      console.log(`handler_actor_guard_grew: ${verdict.grew.join(", ")}`);
      console.log("handler_actor_guard: FAILED - the ratchet records only downward, so nothing was written");
      process.exit(1);
    }
    writeFileSync(
      join(ROOT, BASELINE_PATH),
      `${JSON.stringify(
        {
          schema: "gamebuddy-handler-actor-guard-baseline/v1",
          note:
            "The `RequestLocal*` handlers whose own body neither calls the scope-bound actor proof nor routes through " +
            "a controller method that performs the shared admission, read out of the revision this was recorded from. A " +
            "ceiling, not debt accepted: rewrite it with `node tools/audit-stardew-handler-actor-guard.mjs " +
            "--record-shrinks`, which refuses when anything grew.",
          sites: verdict.unguarded.map((entry) => entry.site).sort(),
        },
        null,
        2,
      )}\n`,
    );
    console.log(
      `handler_actor_guard_baseline_recorded: ${baseline === null ? "none" : baseline.size} -> ${verdict.unguarded.length} ` +
        `at ${rev} (${verdict.shrunk.length} shrank)`,
    );
    process.exit(0);
  }

  for (const finding of verdict.findings) console.log(`${finding.code}: ${finding.detail}`);
  if (verdict.status === "failed")
    console.log(
      "handler_actor_guard: FAILED - a new unguarded handler is the regression, a guarded one that is still recorded " +
        "means the ceiling is stale: run --record-shrinks when the only change is a shrink",
    );
  if (verdict.status === "blocked")
    console.log("handler_actor_guard: blocked - a ratchet over no handler agrees with itself");
  process.exit(verdict.status === "blocked" ? 2 : verdict.status === "failed" ? 1 : 0);
}

if (import.meta.main) main();
