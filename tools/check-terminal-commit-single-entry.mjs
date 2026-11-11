#!/usr/bin/env node
/**
 * ONE TERMINAL COMMIT, ONE ENTRY.
 *
 * Measured on this tree: the Mod settles an execution in ~870 places, and every one of them must reach the receipt
 * ledger through ONE method - `ExecutionManager.RememberTerminal` (farmhandexecutioncontroller.cs:6213). That method is
 * the whole terminal commit: it binds the immutable action identity the router stored at dispatch, builds the
 * `LocalExecutionReceipt`, stores it (`Remember`, which also releases the modal owner lease and evicts the oldest
 * request), publishes the fact and the trace (`AddTrace`, which re-stamps the action identity and refuses to publish a
 * revision that is not strictly above the last one it published), and publishes the execution's one `body_idle`
 * transition once every manager-owned representation of it has been released (`PublishIdleAfterRelease`).
 *
 * The defect family this gate exists for is the site that does not call it. Such a site re-assembles the ending by
 * hand - `this.Remember(receipt); this.AddTrace(receipt);` - and every one of the four facts the seam guarantees has
 * historically been dropped by at least one of them: an `ActionId`-less receipt that `BridgeSession` refuses to
 * project (measured 2026-10-22: 14 terminal receipts in one run, one whole night reported `night_terminal_missing`), a
 * refusal that drops a fact it already read, a `before` written as a literal `"none"`, a `chunk_removed` that was
 * never observed. Each was a hand-written terminal record that got it wrong. The seam exists; the gate is what stops
 * the next site from walking around it.
 *
 * THE POPULATION IS DERIVED, NEVER LISTED. Two shapes are scanned for in `integrations/stardew/**\/*.cs`:
 *
 *   1. a SEAM CALL - an occurrence of `RememberTerminal(` that is not a declaration. The two declarations (the
 *      `IExecutionLedger` contract and the private implementation) and the explicit interface implementation that
 *      forwards to it are recognised by their own shapes and are not counted as commits.
 *   2. a STORE-AND-PUBLISH PAIR - `Remember(<v>)` followed by `AddTrace(<v>)` for the SAME receipt variable, on the
 *      same line or with nothing but blank lines between. That pair IS the seam's body; a copy of it anywhere else is
 *      a terminal commit that bypassed the seam.
 *
 * The member a site sits in is found by walking back to the nearest class-member signature, so a line inserted above a
 * site cannot turn this gate red. The family is the partial's own name (`farmhandexecutioncontroller.busactions.cs` ->
 * `busactions`, the main partial -> `controller`), so the owner of an exemption is named by the file the product
 * already uses to separate the families.
 *
 * WHAT IS A FINDING:
 *   terminal_commit_bypasses_seam:<file>:<line>:<family>   a store-and-publish pair outside the seam and outside the
 *                                                          exempt list
 *   stale_terminal_seam_exemption:<file>:<line>            an exemption whose site no longer exists: the ratchet may
 *                                                          only shrink, so a fix is recorded rather than left behind
 *
 * THE EXEMPT LIST IS A RATCHET, NOT AN ACCEPT LIST (`tools/terminal-commit-seam-exemptions.json`). Every entry names
 * the file, the member (stable across line shifts), the family that owes the conversion and a one-line reason. An
 * entry that matches no site is `stale`, and an entry that names an already-converted member is `stale` too.
 *
 * ZERO POPULATION IS BLOCKED, NEVER GREEN: a scan that finds no seam call at all has measured nothing (wrong root,
 * wrong glob, a tree that moved), and it exits 2 naming the reason instead of agreeing with itself.
 *
 * WHAT THIS GATE DOES NOT ASSERT: that a seam call passes a terminal state. `RememberTerminal` is also used for the
 * non-terminal store-and-publish transitions (an `Accepted` marker, a `Running` receipt), and that is legitimate - the
 * seam's terminal-only work is guarded by `state.IsTerminal()` inside it. Nor does it assert anything about a receipt
 * minted and stored WITHOUT a trace (`Remember` alone, `AttachNativeNotices`), which publishes no fact of its own.
 *
 * USAGE:
 *   node tools/check-terminal-commit-single-entry.mjs
 *
 * red-proof: inject  a hand-rolled `this.Remember(receipt); this.AddTrace(receipt);` terminal into the converted
 *                    `busactions` family -> `terminal_commit_bypasses_seam:integrations/stardew/
 *                    farmhandexecutioncontroller.busactions.cs:<line>:busactions`, exit 1
 *                    (tools/check-terminal-commit-single-entry.test.mjs)
 * red-proof: inject  an exemption for a member that calls the seam -> `stale_terminal_seam_exemption:<file>:<line>`
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const GATE_ID = "terminal-commit-single-entry";
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOT = "integrations/stardew";
const EXEMPTION_PATH = "tools/terminal-commit-seam-exemptions.json";

/** The seam, named once. */
export const SEAM_METHOD = "RememberTerminal";

const SEAM_DECLARATION =
  /^\s*(?:(?:private|public|internal|protected|static|sealed|partial|override|virtual|async)\s+)*LocalExecutionReceipt\s+RememberTerminal\s*\(/;
const SEAM_INTERFACE_DECLARATION =
  /^\s*(?:(?:private|public|internal|protected|static|sealed|partial|override|virtual|async)\s+)*LocalExecutionReceipt\s+IExecutionLedger\.RememberTerminal\s*\(/;
const SEAM_OCCURRENCE = /\bRememberTerminal\s*\(/;
const REMEMBER_CALL = /(?:this|ledger)\.Remember\s*\(\s*([A-Za-z_]\w*)\s*\)/;
const ADD_TRACE_CALL = /(?:this|ledger|manager)\.AddTrace\s*\(\s*([A-Za-z_]\w*)\s*\)/;
const MEMBER_SIGNATURE =
  /^ {4}(?:(?:public|private|internal|protected|static|virtual|override|sealed|async|partial|extern|new|readonly)\s+)*[\w<>[\],.?]+\s+([A-Za-z_]\w*)\s*\(/;

/** Every `.cs` file the gate examines: production Mod sources, with generated and test trees removed. */
export function collectSourceFiles(root = REPOSITORY_ROOT) {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "obj" || entry.name === "bin" || entry.name === "tests") continue;
        walk(absolute);
        continue;
      }
      if (entry.name.endsWith(".cs")) found.push(absolute);
    }
  };
  walk(path.join(root, SOURCE_ROOT));
  return found.sort();
}

/** The family a file belongs to, read from the name the product already uses to separate them. */
export function familyOf(relativePath) {
  const base = path.posix.basename(relativePath.split(path.sep).join("/"));
  const match = /^farmhandexecutioncontroller\.(.+)\.cs$/u.exec(base);
  if (match) return match[1];
  if (base === "farmhandexecutioncontroller.cs") return "controller";
  return base.replace(/\.cs$/u, "");
}

/** The line range of the method body that starts at `declarationLine`, or null when it has no body. */
function methodBodyRange(lines, declarationLine) {
  let depth = 0;
  let opened = false;
  for (let index = declarationLine; index < lines.length; index++) {
    for (const character of lines[index]) {
      if (character === "{") {
        depth++;
        opened = true;
      } else if (character === "}") {
        depth--;
        if (opened && depth === 0) return [declarationLine, index];
      }
    }
    // A declaration with no body (`;` or `=>` ending it) owns no range.
    if (!opened && (lines[index].includes(";") || lines[index].includes("=>"))) {
      if (lines[index].includes("=>")) {
        // An expression body: own the expression's own lines.
        return [declarationLine, index];
      }
      return null;
    }
  }
  return null;
}

/** The class member a line sits in, by walking back to the nearest member signature. */
export function memberAt(lines, lineIndex) {
  for (let index = lineIndex; index >= 0; index--) {
    const match = MEMBER_SIGNATURE.exec(lines[index]);
    if (match) return match[1];
  }
  return "<file>";
}

/**
 * The one scan. Returns every site the population is built from, each carrying enough identity to be named in a
 * finding without a line number (file + member) and enough detail to be read with one (line + kind).
 */
export function scanSource(relativePath, text) {
  const lines = text.split(/\r?\n/u);
  const family = familyOf(relativePath);
  const { declarations, seamCalls } = classifySeamOccurrences(lines, relativePath, family);
  const seamBodyRanges = seamImplementationRanges(lines);

  const seamSites = [];
  const bypasses = [];
  for (let index = 0; index < lines.length; index++) {
    const site = storeAndPublishAt(lines, index, { path: relativePath, family });
    if (site === null) continue;
    const insideSeam = seamBodyRanges.some(([start, end]) => index >= start && index <= end);
    (insideSeam ? seamSites : bypasses).push(site);
  }

  return { family, declarations, seamCalls, seamSites, bypasses };
}

/** Every occurrence of the seam's name, split into its two declarations and the calls that reach it. */
function classifySeamOccurrences(lines, relativePath, family) {
  const declarations = [];
  const seamCalls = [];
  for (let index = 0; index < lines.length; index++) {
    if (!SEAM_OCCURRENCE.test(lines[index])) continue;
    const isInterfaceDeclaration = SEAM_INTERFACE_DECLARATION.test(lines[index]);
    const isDeclaration = SEAM_DECLARATION.test(lines[index]);
    if (isInterfaceDeclaration || isDeclaration) {
      declarations.push({ path: relativePath, family, line: index + 1, kind: "declaration" });
      continue;
    }
    seamCalls.push({ path: relativePath, family, line: index + 1, member: memberAt(lines, index) });
  }
  return { declarations, seamCalls };
}

/**
 * The private implementation's body, which is the ONLY place a store-and-publish pair belongs. The explicit interface
 * implementation is excluded: it forwards to this one and owns no commit of its own.
 */
function seamImplementationRanges(lines) {
  const ranges = [];
  for (let index = 0; index < lines.length; index++) {
    if (!SEAM_DECLARATION.test(lines[index]) || SEAM_INTERFACE_DECLARATION.test(lines[index])) continue;
    const range = methodBodyRange(lines, index);
    if (range) ranges.push([range[0], range[1]]);
  }
  return ranges;
}

/** The line `this.AddTrace(<variable>)` is called on, when it follows `this.Remember(<variable>)` closely. */
function addTraceLineFor(lines, rememberLine, variable) {
  const remembered = REMEMBER_CALL.exec(lines[rememberLine]);
  const sameLine = lines[rememberLine].slice(remembered.index + remembered[0].length);
  const sameLineTrace = ADD_TRACE_CALL.exec(sameLine);
  if (sameLineTrace && sameLineTrace[1] === variable) return rememberLine;

  for (let next = rememberLine + 1; next <= Math.min(rememberLine + 3, lines.length - 1); next++) {
    if (lines[next].trim() === "") continue;
    const traced = ADD_TRACE_CALL.exec(lines[next]);
    return traced && traced[1] === variable ? next : -1;
  }
  return -1;
}

/** One store-and-publish site at `index`, or null when the line is not one. */
function storeAndPublishAt(lines, index, identity) {
  const remembered = REMEMBER_CALL.exec(lines[index]);
  if (!remembered) return null;
  const variable = remembered[1];
  if (addTraceLineFor(lines, index, variable) < 0) return null;
  return { ...identity, line: index + 1, member: memberAt(lines, index), variable };
}

/** The whole population across every examined file. */
export function scanTree(sources) {
  const result = { declarations: [], seamCalls: [], seamSites: [], bypasses: [], families: new Set() };
  for (const { path: relativePath, text } of sources) {
    const file = scanSource(relativePath, text);
    result.families.add(file.family);
    result.declarations.push(...file.declarations);
    result.seamCalls.push(...file.seamCalls);
    result.seamSites.push(...file.seamSites);
    result.bypasses.push(...file.bypasses);
  }
  result.families = [...result.families].sort();
  return result;
}

const siteKey = (site) => `${site.path}\u0000${site.member}`;

/**
 * The verdict. `through` is every site that reaches the ledger through the seam: the seam's own body, the calls to
 * it, and the exempt sites (which are the debt this ratchet records). Everything else is a finding.
 *
 * An exemption records HOW MANY bypass sites its member still owes, because one member can hold nine of them (the
 * `Cancel` funnel does). Comparing counts rather than mere presence is what makes the ratchet real: converting eight
 * of nine unrelated bypasses inside one member leaves the remaining one exempt, while converting one of them must be
 * recorded - so a partial conversion cannot hide behind the entry that covered the whole member.
 */
export function classifyTree(scanned, exemptions) {
  const exemptByKey = new Map();
  for (const entry of exemptions) {
    const key = `${entry.file}\u0000${entry.member}`;
    exemptByKey.set(key, [...(exemptByKey.get(key) ?? []), entry]);
  }
  const findings = [];
  const exempt = [];
  const observedByKey = new Map();

  for (const site of scanned.bypasses) {
    const key = siteKey(site);
    observedByKey.set(key, [...(observedByKey.get(key) ?? []), site]);
  }

  for (const [key, sites] of observedByKey) {
    const entries = exemptByKey.get(key) ?? [];
    let remaining = entries.reduce((total, entry) => total + entry.sites, 0);
    const ordered = [...sites].sort((left, right) => left.line - right.line);
    for (const site of ordered) {
      if (remaining > 0) {
        remaining--;
        exempt.push({ ...site, reason: entries[0].reason, family: entries[0].family });
        continue;
      }
      findings.push({
        code: `terminal_commit_bypasses_seam:${site.path}:${site.line}:${site.family}`,
        detail: `${site.member} stores and publishes \`${site.variable}\` itself instead of calling ${SEAM_METHOD}`,
      });
    }
    if (remaining > 0)
      findings.push({
        code: `stale_terminal_seam_exemption:${entries[0].file}:${entries[0].line ?? 0}`,
        detail: `${entries[0].member} now owes ${sites.length} bypass site(s) but its exemption records ${entries[0].sites}; the conversion must be recorded`,
      });
  }

  for (const entry of exemptions) {
    const key = `${entry.file}\u0000${entry.member}`;
    if (observedByKey.has(key)) continue;
    const reached = [...scanned.seamCalls, ...scanned.seamSites].some((site) => siteKey(site) === key);
    findings.push({
      code: `stale_terminal_seam_exemption:${entry.file}:${entry.line ?? 0}`,
      detail: reached
        ? `${entry.member} now reaches the ledger through the seam, so its exemption must be removed`
        : `${entry.member} no longer stores and publishes a receipt in ${entry.file}, so its exemption must be removed`,
    });
  }

  const through = scanned.seamSites.length + scanned.seamCalls.length + exempt.length;
  const families = new Set([...scanned.bypasses, ...scanned.seamCalls, ...scanned.seamSites].map((s) => s.family));
  return {
    examined: scanned.seamCalls.length + scanned.seamSites.length + scanned.bypasses.length,
    through,
    seamCalls: scanned.seamCalls.length,
    seamBody: scanned.seamSites.length,
    exempt: exempt.length,
    families: families.size,
    findings,
  };
}

function loadSources(root) {
  return collectSourceFiles(root).map((absolute) => ({
    path: path.relative(root, absolute).split(path.sep).join("/"),
    text: readFileSync(absolute, "utf8"),
  }));
}

function loadExemptions(root) {
  let raw;
  try {
    raw = readFileSync(path.join(root, EXEMPTION_PATH), "utf8");
  } catch {
    return [];
  }
  const parsed = JSON.parse(raw);
  const entries = Array.isArray(parsed) ? parsed : (parsed.exemptions ?? []);
  for (const entry of entries) {
    if (
      typeof entry?.file !== "string" ||
      typeof entry?.member !== "string" ||
      typeof entry?.family !== "string" ||
      typeof entry?.reason !== "string" ||
      !Number.isInteger(entry?.sites) ||
      entry.sites < 1
    )
      throw new Error(`exemption_entry_incomplete:${JSON.stringify(entry)}`);
  }
  return entries;
}

/**
 * The rules this gate can go red on. One spelling, read by the report below and by the conformance mechanism, so a
 * rule cannot exist as a finding code without an entry here that names it.
 */
const RULE_CODES = Object.freeze([
  "terminal_commit_bypasses_seam",
  "stale_terminal_seam_exemption",
  "no_terminal_commit_found",
]);

/** The self-verification report: one entry per rule, saying whether this run exercised it and what it saw. */
function report(out, { status, examined, verdict }) {
  const findings = verdict?.findings ?? [];
  const checks = RULE_CODES.map((id) => ({
    id,
    status:
      status === "blocked" ? "blocked" : findings.some((finding) => finding.code.startsWith(id)) ? "failed" : "passed",
    detail:
      status === "blocked"
        ? "the gate refused to decide, so this rule was not exercised"
        : findings
            .filter((finding) => finding.code.startsWith(id))
            .map((finding) => finding.code)
            .join("; ") || "no violation",
  }));
  out(
    `${JSON.stringify({
      gate: GATE_ID,
      status,
      examined,
      throughSeam: verdict?.through ?? 0,
      seamCalls: verdict?.seamCalls ?? 0,
      seamBody: verdict?.seamBody ?? 0,
      exempt: verdict?.exempt ?? 0,
      families: verdict?.families ?? 0,
      findings: findings.length,
      checks,
    })}\n`,
  );
}

/** The gate, callable from a test with any root. Returns the exit code and the two streams it produced. */
export function runGate(root = REPOSITORY_ROOT) {
  let written = "";
  let writtenError = "";
  const out = (text) => {
    written += text;
  };
  const err = (text) => {
    writtenError += text;
  };
  const code = decide(root, out, err);
  return { code, stdout: written, stderr: writtenError };
}

function decide(root, out, err) {
  let sources;
  let exemptions;
  try {
    sources = loadSources(root);
    exemptions = loadExemptions(root);
  } catch (error) {
    err(`${GATE_ID}_blocked:${error instanceof Error ? error.message : String(error)}\n`);
    report(out, { status: "blocked", examined: 0, verdict: null });
    return 2;
  }
  if (sources.length === 0) {
    err(`${GATE_ID}_blocked:no_source_examined:${SOURCE_ROOT} resolved to 0 .cs files\n`);
    report(out, { status: "blocked", examined: 0, verdict: null });
    return 2;
  }
  const scanned = scanTree(sources);
  const verdict = classifyTree(scanned, exemptions);
  if (verdict.examined === 0) {
    err(
      `${GATE_ID}_blocked:no_terminal_commit_found: examined ${sources.length} files and matched neither a ` +
        `${SEAM_METHOD} call nor a Remember/AddTrace pair\n`,
    );
    report(out, { status: "blocked", examined: 0, verdict: null });
    return 2;
  }
  for (const finding of verdict.findings) err(`${finding.code} ${finding.detail}\n`);
  out(
    `sites examined ${verdict.examined} · through the seam ${verdict.through} · exempt ${verdict.exempt} · ` +
      `families ${verdict.families}\n`,
  );
  report(out, {
    status: verdict.findings.length === 0 ? "passed" : "failed",
    examined: verdict.examined,
    verdict,
  });
  return verdict.findings.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runGate(REPOSITORY_ROOT);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.code);
}
