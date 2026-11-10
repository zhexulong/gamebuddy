/**
 * Gate for the UNREPORTED FAILURE defect class: a `catch` in the browser product that leaves the
 * player nothing to read.
 *
 * Confirmed instance (2026-11): seven message handlers - `rewind`, `delete`, `edit`, `regenerate`,
 * `swipe`, the opening-variant switch and the variant discard - each ended in
 * `catch { await rereadChat(); }` and nothing else. The re-read restored the transcript from the
 * Host, so the press flickered and reverted with no sentence: the player watched their own act
 * undone and was told nothing. Every one of them passed its test, because the test asserted the
 * transcript had not moved.
 *
 * THE POPULATION is every `catch` clause in the `.ts`/`.tsx` files under `dialogue-web/src`, read
 * from a TypeScript AST (the dialogue-web workspace's own compiler). A `catch` written inside a
 * comment, a string or a regex is not a catch clause and never enters.
 *
 * WHAT COUNTS AS TELLING THE PLAYER, one of four:
 *
 *   - `throw` - the failure is handed on, not swallowed. A catch that rethrows one error and
 *     reports another still counts: the walk looks for a throw anywhere in the block.
 *   - a call to state or to a notice: a React-style setter (`setXxx(`), the shell's commit
 *     (`commit(`), a panel's reporter (`report(`), or an error channel it hands to (`onError(`).
 *     A LOG IS NOT ONE OF THESE: `console.error` leaves the player watching a press revert with a
 *     message only a developer can read, which is the defect, not the cure.
 *   - an assignment to an identifier declared outside the catch: the catch's answer flows
 *     somewhere a render can reach. `failure = problemTextWithCode(...)` is how three panels in
 *     this tree hand a refusal to their notice.
 *   - a `return` whose expression names something. `return { kind: "error" }`, `return "unavailable"`
 *     and `return false` are answers the caller renders; `return`, `return undefined`, `return null`
 *     and `return true` name nothing and are findings. The distinction is deliberate: a boolean that
 *     a caller turns into `copyNoticeFailed` is a report, an `undefined` a caller must interpret is
 *     not.
 *
 * Everything left is a finding that names the file, the line, the enclosing function, and what the
 * catch does instead - `calls rereadChat`, `calls console.error`, `returns undefined`, `does
 * nothing`. A catch that only re-reads is exactly the shape being caught, so "calls rereadChat" is
 * a finding the reading prints rather than a verb it accepts.
 *
 * EXEMPTIONS are declared in `DECLARED`, each with the reason silence is right there, the exact
 * source text it waives (`witness`) and how many sites that text covers (`sites`). The gate fails
 * when a witness is no longer in its file or the count has drifted, so a declaration cannot
 * outlive the code it was written for - the same shape `tools/lib/silent-failure.mjs` uses.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, sep } from "node:path";

/** The browser product's own sources; no other tree is in this gate's population. */
const UI_ROOT = "dialogue-web/src";
const SCAN_EXTENSIONS = Object.freeze([".ts", ".tsx"]);
const MAX_SCANNED_BYTES = 2 * 1024 * 1024;

/** A call whose name is a state setter or a notice reporter. Logging is not one of them. */
const REPORTING_CALL = /^(?:set[A-Z][\w$]*|commit|report|notify|onError)$/u;

const requireFromDialogueWeb = createRequire(join(import.meta.dirname, "..", "..", "dialogue-web", "package.json"));

function typescript() {
  return requireFromDialogueWeb("typescript");
}

function toPosix(path) {
  return path.split(sep).join("/");
}

function hasScannedExtension(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 && SCAN_EXTENSIONS.includes(name.slice(dot));
}

/** Every scanned source file under `directory`, as absolute paths. */
function listSourceFiles(directory) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith("dist")) continue;
        walk(path);
        continue;
      }
      if (!entry.isFile() || !hasScannedExtension(entry.name)) continue;
      if (statSync(path).size > MAX_SCANNED_BYTES) continue;
      files.push(path);
    }
  };
  walk(directory);
  return files.sort();
}

/** The name of the nearest enclosing function-like node, for a finding that has to say where it is. */
function enclosingName(node) {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (current.name !== undefined && typeof current.name.getText === "function") return current.name.getText();
  }
  return "<module>";
}

/** `x.catch(...)`: its argument runs only when `x` fails, so it is not this clause's report. */
function nestedCatchCall(ts, node) {
  if (!ts.isCallExpression(node)) return false;
  const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
  return ts.isIdentifier(callee) && callee.text === "catch";
}

/** The callee names one catch block calls, as the root the reader recognises (`console.error`). */
function calledNames(ts, block) {
  const names = [];
  const visit = (node) => {
    if (ts.isCatchClause(node)) return;
    if (nestedCatchCall(ts, node)) {
      visit(node.expression);
      return;
    }
    if (ts.isCallExpression(node) && typeof node.expression.getText === "function")
      names.push(node.expression.getText().split("(")[0]);
    ts.forEachChild(node, visit);
  };
  visit(block);
  return names;
}

/**
 * Whether the catch block reports. Returns `{ reports: true, how }` or `{ reports: false, does }`.
 */
function classifyCatch(ts, clause) {
  const block = clause.block;
  let how = null;
  const visit = (node) => {
    if (how !== null) return;
    if (ts.isCatchClause(node)) return;
    if (nestedCatchCall(ts, node)) {
      // `await rereadChat().catch(() => commit(...))` reports only when the re-read fails too, which
      // is the shape that shipped: the re-read usually succeeds, nothing is said, and the press
      // flickers back. The receiver is still read - that is the call the catch actually makes.
      visit(node.expression);
      return;
    }
    if (ts.isThrowStatement(node)) {
      how = "rethrows";
      return;
    }
    if (ts.isCallExpression(node)) {
      const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name : node.expression;
      if (ts.isIdentifier(callee) && REPORTING_CALL.test(callee.text)) {
        how = `calls ${callee.text}`;
        return;
      }
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left)
    ) {
      // An assignment to a name this clause declares is local bookkeeping; to anything else it is
      // state that outlives the catch, which is what a notice is.
      if (!declaresWithin(ts, clause, node.left.text)) {
        how = `assigns ${node.left.text}`;
        return;
      }
    }
    if (ts.isReturnStatement(node)) {
      if (namesSomething(ts, node.expression)) {
        how = `returns ${node.expression.getText().replace(/\s+/gu, " ").slice(0, 60)}`;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(block);
  if (how !== null) return { reports: true, how };
  const calls = calledNames(ts, block);
  if (calls.length > 0) return { reports: false, does: `only calls ${[...new Set(calls)].join(", ")}` };
  const returned = returnsWithoutValue(ts, block);
  if (returned !== null) return { reports: false, does: `only returns ${returned}` };
  return { reports: false, does: "does nothing" };
}

function namesSomething(ts, expression) {
  if (expression === undefined) return false;
  if (ts.isIdentifier(expression) && ["undefined", "null", "NaN"].includes(expression.text)) return false;
  if (
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword
  )
    return false;
  return true;
}

/** The text of the first bare or undefined/null `return` in a block, or null. */
function returnsWithoutValue(ts, block) {
  let found = null;
  const visit = (node) => {
    if (found === null && ts.isReturnStatement(node) && !namesSomething(ts, node.expression))
      found = node.expression === undefined ? "nothing" : node.expression.getText();
    ts.forEachChild(node, visit);
  };
  visit(block);
  return found;
}

/** Whether `name` is declared inside the catch clause itself (a parameter or a local). */
function declaresWithin(ts, clause, name) {
  let declared = false;
  const matches = (node) => {
    if (ts.isVariableDeclaration(node)) return node.name.getText() === name;
    if (ts.isParameter(node)) return node.name.getText() === name;
    if (ts.isFunctionLike(node) && node.name !== undefined) return node.name.getText() === name;
    return false;
  };
  const visit = (node) => {
    if (declared) return;
    if (matches(node)) declared = true;
    else ts.forEachChild(node, visit);
  };
  visit(clause);
  return declared;
}

/**
 * Exemptions: a catch whose silence is the right answer, quoted by the text it waives and counted.
 */
export const DECLARED = Object.freeze([
  Object.freeze({
    path: "dialogue-web/src/components/use-appearance.ts",
    witness: "// The OS answer stands in until the Host can answer; the stored choice is untouched.",
    sites: 1,
    reason:
      "a cosmetic read the Host refuses leaves `system` in force: the OS answer paints, the record still holds what " +
      "the player chose, and a preference nobody could read is indistinguishable from one nobody ever set",
  }),
  Object.freeze({
    path: "dialogue-web/src/components/GameSurface.tsx",
    witness: "/* retain the current authoritative projection */",
    sites: 12,
    reason:
      "every one of these is the read-back inside an operation's own catch: the operation's failure is what " +
      "the outer handler reports, and the projection on screen is still the last authoritative read. Reporting " +
      "the read-back as well would replace the sentence about the act the player took with one about a refresh",
  }),
  Object.freeze({
    path: "dialogue-web/src/components/GameSurface.tsx",
    witness: "{ // Preserve the original key while the command outcome is uncertain. }",
    sites: 1,
    reason:
      "the cancelled re-read leaves the idempotency key in place, which is what the enclosing handler reports about",
  }),
  Object.freeze({
    path: "dialogue-web/src/components/CharactersPanel.tsx",
    witness: "// The refusal stands on its own; the next save is CASed on the revision shown.",
    sites: 3,
    reason:
      "the inner catch is the revision re-read inside a save's own handler; the refusal it exists to make " +
      "retryable is reported by the same handler one line below (`setPersonaNotice`/`setScenarioNotice`/" +
      "`setOpeningNotice`)",
  }),
  Object.freeze({
    path: "dialogue-web/src/components/management-surface-panels.tsx",
    witness: "// The refusal stands on its own; the rows stay as they were read.",
    sites: 1,
    reason:
      'the inner catch is the projection re-read before the failure is reported; `report({ kind: "failure" })` ' +
      "three lines below is the sentence the player reads, and rendering `error` instead would unmount the " +
      "authoring form and the unsaved words in it",
  }),
  Object.freeze({
    path: "dialogue-web/src/components/ComposedReferenceGameApp.tsx",
    witness: "await recover(true)",
    sites: 2,
    reason:
      "the failure is handed to `recover`, which re-reads the authority and commits either the projection or " +
      "`problemView(error)` - or, for a read that failed but did not terminate, `setStreamNotice`",
  }),
  Object.freeze({
    path: "dialogue-web/src/components/ComposedReferenceGameApp.tsx",
    witness: "{ // The read-back failed too",
    sites: 1,
    reason:
      "the notice for the read this handler already failed is what the player reads; a second sentence about the read-back would replace it",
  }),
  Object.freeze({
    path: "dialogue-web/src/components/MessageBubble.tsx",
    witness: "// A refused permission is not a verdict: the selection path below may still work.",
    sites: 1,
    reason:
      "the clipboard write falls through to `copyThroughSelection`, and only when BOTH paths fail does the row " +
      "say `copyNoticeFailed`",
  }),
  Object.freeze({
    path: "dialogue-web/src/components/MessageBubble.tsx",
    witness: "{ return false; }",
    sites: 1,
    reason: "`false` is this helper's answer, and `writeToClipboard`'s caller renders `copyNoticeFailed` for it",
  }),
  Object.freeze({
    path: "dialogue-web/src/components/png-character-card.ts",
    witness: "{ return null; }",
    sites: 2,
    reason:
      'documented at the function: `null` is "this browser could not decode the picture", a different fact ' +
      "from any Host refusal and the one case the caller answers in its own words",
  }),
  Object.freeze({
    path: "dialogue-web/src/management-pipeline-api.ts",
    witness: "{ return undefined; }",
    sites: 1,
    reason:
      "`readJson`'s `undefined` is not a report but an input: `exchange` passes it to `isProblem`/`decode`, " +
      "which throw `TavernProtocolError` for it - the named refusal the surface renders",
  }),
  Object.freeze({
    path: "dialogue-web/src/reference-pipeline-api.ts",
    witness: "{ return undefined; }",
    sites: 1,
    reason:
      "the same `readJson` contract as the management client: `undefined` is handed to the body decoder and " +
      "becomes a thrown protocol error, never a silent absence",
  }),
  Object.freeze({
    path: "dialogue-web/src/components/use-composed-bootstrap.ts",
    witness: "// The first-paint cache stands in; nothing about the conversation depends on this read.",
    sites: 1,
    reason:
      "the language the surface paints with is a preference, and the first-paint cache is the answer when the " +
      "Host cannot answer: the player still gets a language, the conversation does not depend on the read, and " +
      "a notice about it would be the only thing on a first frame that is otherwise ready",
  }),
]);

/** Every catch clause in the tree, with what it does and whether that counts as reporting. */
function findUnreportedCatches({ repoRoot, files = listSourceFiles(join(repoRoot, UI_ROOT)) } = {}) {
  const ts = typescript();
  const sites = [];
  for (const file of files) {
    const path = toPosix(relative(repoRoot, file));
    const text = readFileSync(file, "utf8");
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const visit = (node) => {
      if (ts.isCatchClause(node)) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const reading = classifyCatch(ts, node);
        sites.push({
          path,
          line,
          symbol: enclosingName(node),
          text: node.block.getText(source).replace(/\s+/gu, " ").trim(),
          reports: reading.reports,
          how: reading.reports ? reading.how : null,
          does: reading.reports ? null : reading.does,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  sites.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
  return sites;
}

/** The one-line, greppable form the CLI prints and CI matches on. */
export function formatFinding(finding) {
  return `unreported_catch:${finding.path}:${finding.line}:${finding.symbol}`;
}

/**
 * The verdict: every silent catch no declaration waives, plus every declaration that no longer
 * describes the code it waives.
 */
export function checkUnreportedCatches({ repoRoot, declared = DECLARED, files } = {}) {
  const sites = findUnreportedCatches({ repoRoot, ...(files === undefined ? {} : { files }) });
  const silent = sites.filter((site) => !site.reports);
  const problems = [];
  const waived = new Set();
  for (const entry of declared) {
    if (typeof entry.reason !== "string" || entry.reason.trim() === "")
      problems.push({ code: "declaration_unreasoned", path: entry.path });
    if (!Number.isInteger(entry.sites) || entry.sites < 1)
      problems.push({ code: "declaration_uncounted", path: entry.path, witness: entry.witness });
    let text;
    try {
      text = readFileSync(join(repoRoot, entry.path), "utf8");
    } catch {
      problems.push({ code: "declaration_stale_path", path: entry.path });
      continue;
    }
    const matching = silent.filter((site) => site.path === entry.path && site.text.includes(entry.witness));
    // A witness may span lines in the source and is compared against whitespace-collapsed text
    // everywhere, so the occurrence count has to be taken the same way or a wrapped comment could
    // never be found.
    const occurrences = text.replace(/\s+/gu, " ").split(entry.witness).length - 1;
    if (occurrences === 0 || matching.length !== entry.sites) {
      problems.push({
        code: "declaration_count_drift",
        path: entry.path,
        witness: entry.witness,
        detail: `declared ${entry.sites}, found ${matching.length} silent site(s) naming it (${occurrences} occurrence(s) in the file)`,
      });
      continue;
    }
    for (const site of matching) waived.add(site);
  }
  return {
    counts: { sites: sites.length, silent: silent.length, declared: declared.length },
    sites,
    unreported: silent.filter((site) => !waived.has(site)),
    problems,
  };
}
