#!/usr/bin/env node
/**
 * A TERMINAL RECEIPT TELLS THE BODY IT IS FREE.
 *
 * `ExecutionManager.RememberTerminal` (farmhandexecutioncontroller.cs:6213) is the one terminal commit, and its body is
 * three things: store the receipt (`Remember`, which also releases the modal owner lease), publish the trace
 * (`AddTrace`), and announce that the body is idle again (`PublishIdleAfterRelease`). The seam's body is copied by hand
 * in ~90 places, because the ledger's own gate (`tools/check-terminal-commit-single-entry.mjs`) ratchets the copies
 * down one at a time. Every field a copy can drop has been dropped by one of them at some point; this gate reads the
 * one that nothing has measured - the LAST of the three, the idle transition.
 *
 * WHAT THE IDLE TRANSITION IS FOR. `PublishIdleAfterRelease` is also the only writer of the `body_idle` body trace
 * (`DrainPendingIdleAfterRelease` -> `AddPublicTrace("body_idle", ...)`), which is the fact that says the actor is free
 * and WHERE it stands now: `BridgeSession.TryCreateBodyTraceEvent` turns it into a `semantic_event`, and the Host holds
 * it as progress so the companion's next turn knows the body is not busy. A site that stores and publishes a terminal
 * but never asks for the idle leaves the companion with a settled execution and no announcement that the actor came
 * back - the acknowledgement that never arrives, one layer out.
 *
 * WHY THIS IS NOT THE SAME QUESTION AS THE SEAM GATE. Most copies are not debts: a `Running`/`Accepted` marker must NOT
 * idle (the execution still owns the body), and a cancellation that keeps a native animation alive must not idle either
 * (the animation is still using the actor, and its own settle publishes the idle when it ends). The population here is
 * therefore the pairs that say NOTHING, and the property is that each of them is provably non-terminal or named with a
 * reason. A gate that demanded an idle from every pair would demand a bug.
 *
 * THE STATE IS READ FROM THE SITE. The receipt is built one or two lines above the store, as
 * `new LocalExecutionReceipt(executionId, requestId, <state>, ...)`. The third argument is read three ways, in order:
 *
 *   1. a literal or ternary naming `ExecutionState.<name>` tokens;
 *   2. a bare local, resolved through the assignments made to it in the same member (a postcondition is usually
 *      `state = succeeded ? ExecutionState.Succeeded : ExecutionState.Uncertain;`);
 *   3. a bare parameter, resolved through the `if (<name> is A or B)` guard that opens the block the site sits in -
 *      a progress funnel takes the controller's state and filters it before minting.
 *
 * A state that cannot be read that way is `terminal_idle_state_unresolved`, never a pass: the direction a silent gate
 * fails here is a terminal with no idle, and that is the whole population.
 *
 * WHICH STATES ARE TERMINAL is not restated. `integrations/stardew/src/Core/Models/BridgeProtocolModels.cs` owns both
 * the enum and `IsTerminal` ("`state is not (Accepted or Running or MeaningfulProgress)`"), so the gate reads the enum
 * members and the negation from there; a tree where either cannot be read is blocked rather than green, because a
 * population that cannot be named would agree with itself.
 *
 * THE EXEMPT LIST IS A RATCHET (`tools/terminal-idle-publication-exemptions.json`). An entry names the file, the member
 * (stable across line shifts), how many silent terminal sites that member still owes, the family that owes them and a
 * one-line reason. An entry whose member publishes idle now, or owes fewer sites than it records, is
 * `stale_terminal_idle_exemption`.
 *
 * USAGE:
 *   node tools/check-terminal-idle-publication.mjs
 *
 * red-proof: inject  a terminal store-and-publish pair with no idle announcement (`ExecuteTillSoil`'s shape, and the
 *                    whole tool-approach family before this change) ->
 *                    `terminal_without_idle_publication:<file>:<line>:<family>`, exit 1
 *                    (tools/check-terminal-idle-publication.test.mjs)
 * red-proof: inject  an exemption for a member whose site announces the idle now -> `stale_terminal_idle_exemption`
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { collectSourceFiles, familyOf, scanSource } from "./check-terminal-commit-single-entry.mjs";

const GATE_ID = "terminal-idle-publication";
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TERMINAL_AUTHORITY = "integrations/stardew/src/Core/Models/BridgeProtocolModels.cs";
const EXEMPTION_PATH = "tools/terminal-idle-publication-exemptions.json";

/** The one method that announces a released body, named once. */
export const IDLE_METHOD = "PublishIdleAfterRelease";

const IDLE_CALL = new RegExp(`\\b${IDLE_METHOD}\\s*\\(`, "u");
const MEMBER_SIGNATURE =
  /^ {4}(?:(?:public|private|internal|protected|static|virtual|override|sealed|async|partial|extern|new|readonly)\s+)*[\w<>[\],.?]+\s+([A-Za-z_]\w*)\s*\(/u;
const STATE_TOKEN = /ExecutionState\.(\w+)/gu;

/**
 * The terminal states, read from the authority that declares both halves: the enum's members minus the names
 * `IsTerminal` excludes. Returns null when either half cannot be read, so a caller can block instead of guessing.
 */
export function readTerminalStates(text) {
  const declaration = /enum\s+ExecutionState\s*\{([\s\S]*?)\}/u.exec(text);
  const negation = /IsTerminal\s*\(\s*this\s+ExecutionState\s+\w+\s*\)\s*=>\s*state\s+is\s+not\s*\(([^)]*)\)/u.exec(
    text,
  );
  if (declaration === null || negation === null) return null;
  const members = [...declaration[1].matchAll(/\b([A-Z][A-Za-z0-9_]*)\b/gu)].map((match) => match[1]);
  const occupied = new Set(
    negation[1]
      .split(/\bor\b/u)
      .map((name) => name.trim().replace(/^ExecutionState\./u, ""))
      .filter((name) => /^[A-Z][A-Za-z0-9_]*$/u.test(name)),
  );
  if (members.length === 0 || occupied.size === 0) return null;
  const terminal = members.filter((member) => !occupied.has(member));
  return terminal.length === 0 ? null : { members, occupied: [...occupied], terminal };
}

/** The `[open, close]` line range of the innermost brace block that encloses `lineIndex`. */
function enclosingBlock(lines, lineIndex) {
  let depth = 0;
  let open = -1;
  for (let index = lineIndex; index >= 0 && open < 0; index--) {
    for (let cursor = lines[index].length - 1; cursor >= 0; cursor--) {
      const character = lines[index][cursor];
      if (character === "}") depth++;
      else if (character === "{") {
        if (depth === 0) {
          open = index;
          break;
        }
        depth--;
      }
    }
  }
  if (open < 0) return null;
  depth = 0;
  for (let index = open; index < lines.length; index++) {
    for (const character of lines[index]) {
      if (character === "{") depth++;
      else if (character === "}") {
        depth--;
        if (depth === 0) return [open, index];
      }
    }
  }
  return [open, lines.length - 1];
}

/** Whether the block the site sits in announces the idle AFTER the commit, which is the seam's third step. */
export function publishesIdleAfter(lines, lineIndex) {
  const block = enclosingBlock(lines, lineIndex);
  if (block === null) return false;
  return lines.slice(lineIndex, block[1] + 1).some((line) => IDLE_CALL.test(line));
}

/** Split a call's arguments on commas that are not inside brackets or string literals. */
function splitArguments(text) {
  const args = [];
  let depth = 0;
  let current = "";
  let quote = null;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quote !== null) {
      current += character;
      if (character === "\\") {
        current += text[index + 1] ?? "";
        index++;
      } else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (character === "(" || character === "[" || character === "{") depth++;
    else if (character === ")" || character === "]" || character === "}") depth--;
    if (character === "," && depth === 0) {
      args.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  args.push(current);
  return args.map((entry) => entry.trim());
}

/** The argument list of the first `new(` in `text`, or null when it does not open one. */
function constructionArguments(text) {
  const start = text.indexOf("new(");
  if (start < 0) return null;
  let depth = 0;
  let quote = null;
  for (let index = start + 3; index < text.length; index++) {
    const character = text[index];
    if (quote !== null) {
      if (character === "\\") index++;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "(") depth++;
    else if (character === ")") {
      depth--;
      if (depth === 0) return splitArguments(text.slice(start + 4, index));
    }
  }
  return null;
}

/** The states a `if (<name> is A or B)` guard around the site names, or null when there is no such guard. */
function guardStates(lines, lineIndex, identifier) {
  const block = enclosingBlock(lines, lineIndex);
  if (block === null) return null;
  const condition = lines.slice(Math.max(0, block[0] - 2), block[0] + 1).join(" ");
  const pattern = new RegExp(
    `\\b${identifier}\\s+is\\s+((?:ExecutionState\\.\\w+|\\w+)(?:\\s+or\\s+(?:ExecutionState\\.\\w+|\\w+))*)`,
    "u",
  );
  const matched = pattern.exec(condition);
  if (matched === null) return null;
  const named = [...matched[1].matchAll(/[A-Za-z_]\w*/gu)]
    .map((entry) => entry[0])
    .filter((name) => name !== "or" && name !== "ExecutionState");
  return named.length === 0 ? null : named;
}

/** Every state the receipt stored at this site can carry, or null when the site does not say. */
function resolveStates(lines, memberStart, lineIndex, variable) {
  const assignment = new RegExp(`\\b${variable}\\s*=(?!=)`, "u");
  const declaration = new RegExp(`\\b(LocalExecutionReceipt|FarmhandExecutionReceipt|var)\\s+${variable}\\s*=`, "u");
  let assignLine = -1;
  for (let index = lineIndex; index >= memberStart && assignLine < 0; index--) {
    const cut = lines[index].indexOf("this.Remember(");
    const head = cut < 0 ? lines[index] : lines[index].slice(0, cut);
    if (assignment.test(head) || declaration.test(head)) assignLine = index;
  }
  if (assignLine < 0) return null;

  const siteLine = lines[lineIndex].slice(0, Math.max(0, lines[lineIndex].indexOf("this.Remember(")));
  const args = constructionArguments(lines.slice(assignLine, lineIndex).concat([siteLine]).join("\n"));
  if (args === null || args.length < 3) return null;

  const stateArgument = args[2];
  const direct = [...stateArgument.matchAll(STATE_TOKEN)].map((match) => match[1]);
  if (direct.length > 0) return direct;
  if (!/^[A-Za-z_]\w*$/u.test(stateArgument)) return null;
  const guarded = guardStates(lines, lineIndex, stateArgument);
  if (guarded !== null) return guarded;

  const assigned = new RegExp(`(?:\\bExecutionState\\s+)?\\b${stateArgument}\\b\\s*=(?!=)`, "u");
  const collected = new Set();
  for (let index = memberStart; index < lineIndex; index++) {
    if (!assigned.test(lines[index])) continue;
    let statement = "";
    for (let cursor = index; cursor < lineIndex && cursor <= index + 12; cursor++) {
      statement += `${lines[cursor]}\n`;
      if (lines[cursor].includes(";")) break;
    }
    for (const match of statement.matchAll(STATE_TOKEN)) collected.add(match[1]);
  }
  return collected.size === 0 ? null : [...collected];
}

/** The class member a line sits in, by walking back to the nearest member signature. */
function memberAt(lines, lineIndex) {
  for (let index = lineIndex; index >= 0; index--) {
    const matched = MEMBER_SIGNATURE.exec(lines[index]);
    if (matched) return { name: matched[1], start: index };
  }
  return { name: "<file>", start: -1 };
}

/**
 * One file's silent sites: every store-and-publish pair outside the seam that does not announce the idle, with the
 * states its receipt can carry. The pair population itself is the sibling gate's - it already derives it from the tree
 * and already owns the seam's own body as the one place the pair belongs.
 */
export function scanSourceForIdle(relativePath, text, terminalStates) {
  const lines = text.split(/\r?\n/u);
  const family = familyOf(relativePath);
  const scanned = scanSource(relativePath, text);
  const sites = [];
  for (const site of scanned.bypasses) {
    const lineIndex = site.line - 1;
    if (publishesIdleAfter(lines, lineIndex)) continue;
    const member = memberAt(lines, lineIndex);
    const states = resolveStates(lines, member.start, lineIndex, site.variable);
    sites.push({
      path: relativePath,
      family,
      line: site.line,
      member: member.name,
      states,
      terminal: states === null ? null : states.filter((state) => terminalStates.includes(state)),
    });
  }
  return { family, pairs: scanned.bypasses.length + scanned.seamSites.length, sites };
}

const siteKey = (site) => `${site.path}\u0000${site.member}`;

/** The verdict: which silent terminal sites are debts, which are exempt, and which could not be read. */
export function classifySites(sites, exemptions) {
  const exemptByKey = new Map();
  for (const entry of exemptions) {
    const key = `${entry.file}\u0000${entry.member}`;
    exemptByKey.set(key, [...(exemptByKey.get(key) ?? []), entry]);
  }
  const owed = sites.filter((site) => site.terminal !== null && site.terminal.length > 0);
  const markers = sites.filter((site) => site.terminal !== null && site.terminal.length === 0);
  const unresolved = sites.filter((site) => site.states === null);

  const findings = [];
  let exempt = 0;
  const observed = new Map();
  for (const site of owed) observed.set(siteKey(site), [...(observed.get(siteKey(site)) ?? []), site]);

  for (const [key, group] of observed) {
    const entries = exemptByKey.get(key) ?? [];
    let remaining = entries.reduce((total, entry) => total + entry.sites, 0);
    for (const site of [...group].sort((left, right) => left.line - right.line)) {
      if (remaining > 0) {
        remaining--;
        exempt++;
        continue;
      }
      findings.push({
        code: `terminal_without_idle_publication:${site.path}:${site.line}:${site.family}`,
        detail: `${site.member} stores and publishes \`${site.states.join("/")}\` without ${IDLE_METHOD}`,
      });
    }
    if (remaining > 0)
      findings.push({
        code: `stale_terminal_idle_exemption:${entries[0].file}:${entries[0].line ?? 0}`,
        detail: `${entries[0].member} owes ${group.length} silent terminal site(s) but its exemption records ${entries[0].sites}`,
      });
  }

  for (const entry of exemptions) {
    const key = `${entry.file}\u0000${entry.member}`;
    if (observed.has(key)) continue;
    const reached = sites.some((site) => siteKey(site) === key && (site.terminal ?? []).length === 0);
    findings.push({
      code: `stale_terminal_idle_exemption:${entry.file}:${entry.line ?? 0}`,
      detail: reached
        ? `${entry.member} publishes no terminal any more, so its exemption must be removed`
        : `${entry.member} no longer owes a silent terminal in ${entry.file}, so its exemption must be removed`,
    });
  }

  for (const site of unresolved)
    findings.push({
      code: `terminal_idle_state_unresolved:${site.path}:${site.line}:${site.member}`,
      detail: "the receipt's state is not readable at the site, so whether this silence is a debt cannot be decided",
    });

  return {
    silent: sites.length,
    owed: owed.length,
    markers: markers.length,
    unresolved: unresolved.length,
    exempt,
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

const RULE_CODES = Object.freeze([
  "terminal_without_idle_publication",
  "terminal_idle_state_unresolved",
  "stale_terminal_idle_exemption",
  "terminal_state_population_unreadable",
  "no_terminal_idle_site",
]);

/** One rule's outcome: blocked when the run decided nothing, failed when it named this code, passed otherwise. */
function checkOutcome(id, status, findings) {
  if (status === "blocked")
    return { status: "blocked", detail: "the gate refused to decide, so this rule was not exercised" };
  const named = findings.filter((finding) => finding.code.startsWith(id)).map((finding) => finding.code);
  return {
    status: named.length === 0 ? "passed" : "failed",
    detail: named.length === 0 ? "no violation" : named.join("; "),
  };
}

function report(out, { status, examined, verdict }) {
  const findings = verdict?.findings ?? [];
  out(
    `${JSON.stringify({
      gate: GATE_ID,
      status,
      examined,
      silentSites: verdict?.silent ?? 0,
      terminalWithoutIdle: verdict?.owed ?? 0,
      nonTerminalMarkers: verdict?.markers ?? 0,
      unresolvedStates: verdict?.unresolved ?? 0,
      exempt: verdict?.exempt ?? 0,
      findings: findings.length,
      checks: RULE_CODES.map((id) => ({ id, ...checkOutcome(id, status, findings) })),
    })}\n`,
  );
}

export function runGate(root = REPOSITORY_ROOT) {
  let written = "";
  let writtenError = "";
  const code = decide(
    root,
    (text) => {
      written += text;
    },
    (text) => {
      writtenError += text;
    },
  );
  return { code, stdout: written, stderr: writtenError };
}

function decide(root, out, err) {
  let sources;
  let exemptions;
  let terminalStates;
  try {
    sources = loadSources(root);
    exemptions = loadExemptions(root);
    terminalStates = readTerminalStates(readFileSync(path.join(root, TERMINAL_AUTHORITY), "utf8"));
  } catch (error) {
    err(`${GATE_ID}_blocked:${error instanceof Error ? error.message : String(error)}\n`);
    report(out, { status: "blocked", examined: 0, verdict: null });
    return 2;
  }
  if (terminalStates === null) {
    err(`${GATE_ID}_blocked:terminal_state_population_unreadable:${TERMINAL_AUTHORITY}\n`);
    report(out, { status: "blocked", examined: 0, verdict: null });
    return 2;
  }
  if (sources.length === 0) {
    err(`${GATE_ID}_blocked:no_source_examined\n`);
    report(out, { status: "blocked", examined: 0, verdict: null });
    return 2;
  }

  const scanned = sources.map((source) => scanSourceForIdle(source.path, source.text, terminalStates.terminal));
  const sites = scanned.flatMap((file) => file.sites);
  const pairPopulation = scanned.reduce((total, file) => total + file.pairs, 0);
  if (pairPopulation === 0) {
    err(
      `${GATE_ID}_blocked:no_terminal_idle_site: examined ${sources.length} file(s) and matched no store-and-publish pair\n`,
    );
    report(out, { status: "blocked", examined: 0, verdict: null });
    return 2;
  }

  const verdict = classifySites(sites, exemptions);
  for (const finding of verdict.findings) err(`${finding.code} ${finding.detail}\n`);
  out(
    `sites examined ${pairPopulation} · silent ${verdict.silent} (terminal ${verdict.owed} · marker ${verdict.markers} · ` +
      `unresolved ${verdict.unresolved}) · exempt ${verdict.exempt} · families ${new Set(sites.map((site) => site.family)).size}\n`,
  );
  report(out, { status: verdict.findings.length === 0 ? "passed" : "failed", examined: pairPopulation, verdict });
  return verdict.findings.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runGate(REPOSITORY_ROOT);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.code);
}
