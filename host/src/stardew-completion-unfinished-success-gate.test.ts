import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { STARDEW_COMPLETION_CONTRACTS, STARDEW_UNFINISHED_SUCCESSES } from "./stardew-completion-contracts.js";

/**
 * `every_succeeded_verdict_the_mod_can_mint_is_read_or_a_named_not_yet:<action>:<code>` - the two-arm success is
 * either the action's postcondition, or declared with the warrant that says "not yet", and never both and never
 * neither.
 *
 * WHY. `PostconditionVerdict(observed, observedCode, unobservedCode)` (`farmhandexecutioncontroller.verdicts.cs:7-13`)
 * mints `Succeeded` with `observedCode` and `Uncertain` with `unobservedCode`. Most callers pass one plain literal, but
 * `resourcetoolactions.cs:393` passes a choice - `removed ? "rock_source_broken" : "rock_source_damaged"` - so ONE
 * action can answer TWO succeeded terminals and only one of them is its postcondition. Measured `round90`
 * (2026-11-22, `mine_delve`, `2026-11-22T06-04-54-555Z-multiday_routine`): four `rock_source_damaged` receipts came back
 * `state: succeeded`, the Host read them exactly, and `tools/lib/task-purpose.mjs` filed all four as
 * `succeeded_receipt_without_its_own_postcondition` - the label the contract publishes when it cannot read a receipt at
 * all, said about receipts it read in full.
 *
 * POPULATION, FROM THE PRODUCER AND NEVER FROM A LIST. Every string literal in the SECOND argument of a
 * `PostconditionVerdict(` call in the Mod, which is the `observedCode` slot and therefore a code that ships with
 * `ExecutionState.Succeeded`. Each site is attributed to its action by the member that CALLS the member holding the
 * site and names that action's id - the same `"break_rock"` + `ExecuteBreakRock(` pair that request handler states.
 *
 * PROPERTY, in three parts. For each `(action, code)`:
 *
 *   1. the action's row NAMES the code (`claim.reasonCode === "<code>"`) - the receipt is its postcondition - or
 *      `STARDEW_UNFINISHED_SUCCESSES` declares it, and a code that is neither is `unfinished_success_with_no_reading`.
 *      That is the finding the next `rock_source_damaged` would produce, named instead of found by a live run;
 *   2. a code BOTH read and declared is `unfinished_success_declared_and_read`: the row answers it first, so the
 *      declaration can never be reached and is a claim nobody checks;
 *   3. a declaration no producer site still mints is `unfinished_declaration_has_no_producer`, so an exemption expires
 *      instead of outliving the code it was written for.
 *
 * PRINT. `codes examined C · read R · declared U`, then one line per code with its action and site. An empty
 * population is BLOCKED with the reason rather than green, and a site this gate cannot attribute is BLOCKED by name
 * rather than dropped.
 *
 * WHAT IT CANNOT SEE, stated rather than implied. It reads the SURFACE a row names, not the values it accepts, so a
 * row that names `rock_source_damaged` and then refused every receipt carrying it would pass here;
 * `stardew-completion-contract-mintability.test.ts` drives the same rows with round90's receipts and with the warrant
 * removed. And it reads one producer construct: a succeeded code minted by `RememberTerminal(... ExecutionState.Succeeded
 * ...)` directly is outside this population, which is why `stardew-settled-reason-read-gate.test.ts` holds the
 * settlements and `stardew-completion-contract-mintability.test.ts` holds the recorded corpus.
 *
 * red-proof: history  round90's shape as this tree shipped it - no declaration at all - prints
 *                   `unfinished_success_with_no_reading:break_rock:rock_source_damaged`, and the falsifier below asserts
 *                   that reading of the shipped text plus the two expiry directions.
 */

type Declarations = Readonly<Record<string, Readonly<Record<string, unknown>> | undefined>>;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MOD_ROOT = join(ROOT, "integrations", "stardew");
const CONTRACTS_FILE = join(ROOT, "host", "src", "stardew-completion-contracts.ts");

/** The contract's text without `//`-comments: a shape a row mentions only in prose is not a requirement. */
function withoutLineComments(text: string): string {
  return text
    .replace(/\r/gu, "")
    .split("\n")
    .map((line) => {
      const comment = line.indexOf("//");
      return comment < 0 ? line : line.slice(0, comment);
    })
    .join("\n");
}

/** Every producer `.cs` file under `integrations/stardew`, as a directory scan rather than a file list. */
function csharpSources(): Array<{ file: string; text: string }> {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      if (entry === "obj" || entry === "bin" || entry === "tests" || entry === "action-development" || entry === "node_modules")
        continue;
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(".cs")) files.push(path);
    }
  };
  walk(MOD_ROOT);
  return files.map((path) => ({ file: relative(ROOT, path), text: withoutLineComments(readFileSync(path, "utf8")) }));
}

/** A member declaration of any shape, so the body a mint stands in can be read. */
const MEMBER =
  /^[ \t]*(?:(?:private|internal|public|protected|static|sealed|override|partial|async|readonly|unsafe|new)\s+)+[\w<>?,[\].\s]+?\s(?<name>\w+)\s*\(/gmu;

type Member = Readonly<{ file: string; name: string; start: number; end: number; text: string }>;

function membersOf(sources: readonly { file: string; text: string }[]): Member[] {
  const members: Member[] = [];
  for (const source of sources) {
    const starts = [...source.text.matchAll(MEMBER)];
    starts.forEach((start, index) => {
      const end = index + 1 < starts.length ? (starts[index + 1]?.index as number) : source.text.length;
      members.push({
        file: source.file,
        name: start[1] as string,
        start: start.index,
        end,
        text: source.text.slice(start.index, end),
      });
    });
  }
  return members;
}

/** The innermost member holding `offset` of `file`. */
function memberAt(members: readonly Member[], file: string, offset: number): Member | undefined {
  let found: Member | undefined;
  for (const member of members)
    if (member.file === file && member.start <= offset && offset < member.end)
      if (found === undefined || member.start > found.start) found = member;
  return found;
}

/** The index of the `)` closing the `(` at `from`, or -1 when the text runs out. */
function closingParen(text: string, from: number): number {
  let depth = 0;
  let quote = false;
  for (let index = from; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === '"' && text[index - 1] !== "\\") quote = false;
      continue;
    }
    if (character === '"') quote = true;
    else if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** The arguments of the call whose `(` is at `open`, split at top-level commas. */
function callArguments(text: string, open: number): string[] {
  const close = closingParen(text, open);
  if (close < 0) return [];
  const args: string[] = [];
  let depth = 0;
  let quote = false;
  let start = open + 1;
  for (let index = open + 1; index < close; index += 1) {
    const character = text[index];
    if (quote) {
      if (character === '"' && text[index - 1] !== "\\") quote = false;
      continue;
    }
    if (character === '"') quote = true;
    else if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") depth -= 1;
    else if (character === "," && depth === 0) {
      args.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  args.push(text.slice(start, close).trim());
  return args;
}

/** The row text of each action, comments removed, keyed by the property name the table declares it under. */
function contractArms(contracts: string): Map<string, string> {
  const tableStart = contracts.indexOf("export const STARDEW_COMPLETION_CONTRACTS");
  const tableEnd = contracts.indexOf('} satisfies Record<ExecutionRequest["action"]');
  assert.ok(
    tableStart >= 0 && tableEnd > tableStart,
    "blocked: the completion table is no longer where this gate reads it, so nothing below was examined",
  );
  const table = withoutLineComments(contracts.slice(tableStart, tableEnd));
  const rows = [...table.matchAll(/^ {2}([a-z][a-z0-9_]*): \(claim\) => \{/gmu)];
  assert.ok(rows.length > 0, "blocked: no rows were found in the completion table");
  const arms = new Map<string, string>();
  rows.forEach((row, index) => {
    arms.set(
      row[1] as string,
      table.slice(row.index, index + 1 < rows.length ? (rows[index + 1]?.index as number) : table.length),
    );
  });
  return arms;
}

/** The action whose request handler calls `member` and names that action's id, or the reason it cannot be named. */
function actionOf(
  member: Member,
  members: readonly Member[],
  rowIds: ReadonlySet<string>,
): { actionId: string } | { blocked: string } {
  const callers = new Set<string>();
  for (const caller of members)
    if (caller.name !== member.name && caller.text.includes(`${member.name}(`))
      for (const match of caller.text.matchAll(/"([a-z][a-z0-9_]*)"/gu)) if (rowIds.has(match[1] as string)) callers.add(match[1] as string);
  return callers.size === 1
    ? { actionId: [...callers][0] as string }
    : {
        blocked: `${member.file}:${member.name} is called by members naming ${
          [...callers].sort().join(", ") || "no contract action"
        }`,
      };
}

/** One succeeded code the producer can mint, with the site that mints it. */
type Mint = Readonly<{ actionId: string; reasonCode: string; site: string }>;

type Census = Readonly<{ mints: readonly Mint[]; blocked: readonly string[]; findings: readonly string[] }>;

/** Whether this action's row NAMES this code, which is what makes the receipt that action's postcondition. */
function rowNames(arms: ReadonlyMap<string, string>, actionId: string, reasonCode: string): boolean {
  return (arms.get(actionId) ?? "").includes(`claim.reasonCode === "${reasonCode}"`);
}

/**
 * The census: every succeeded code the producer can mint, against the row and the declaration that must answer it.
 *
 * `declarations`, `arms` are parameters so the falsifier can replay a tree where one of them differs without keeping a
 * second reading of either.
 */
function measure(
  contractsText: string,
  declarations: Declarations,
  sources: readonly { file: string; text: string }[] = csharpSources(),
): Census {
  assert.ok(sources.length > 0, "blocked: no producer source was found, so no succeeded code could be read");
  const members = membersOf(sources);
  const rowIds = new Set(Object.keys(STARDEW_COMPLETION_CONTRACTS));
  const arms = contractArms(contractsText);

  const blocked: string[] = [];
  const mints: Mint[] = [];
  const seen = new Set<string>();

  for (const source of sources) {
    for (const match of source.text.matchAll(/PostconditionVerdict\(/gu)) {
      const args = callArguments(source.text, match.index + match[0].length - 1);
      const member = memberAt(members, source.file, match.index);
      const site = `${source.file}:${member?.name ?? "<no member>"}`;
      const observed = args[1] ?? "";
      const codes = [...observed.matchAll(/"([a-z][a-z0-9_]*)"/gu)].map((literal) => literal[1] as string);
      if (codes.length === 0) {
        blocked.push(`${site} PostconditionVerdict names no readable succeeded code: ${observed.slice(0, 120) || "<none>"}`);
        continue;
      }
      if (member === undefined) {
        blocked.push(`${site} PostconditionVerdict stands in no member this gate can read`);
        continue;
      }
      const action = actionOf(member, members, rowIds);
      if ("blocked" in action) {
        blocked.push(`${site} ${action.blocked}`);
        continue;
      }
      for (const reasonCode of codes) {
        const key = `${action.actionId}:${reasonCode}`;
        if (seen.has(key)) continue;
        seen.add(key);
        mints.push({ actionId: action.actionId, reasonCode, site });
      }
    }
  }

  const findings: string[] = [];
  for (const mint of mints) {
    const read = rowNames(arms, mint.actionId, mint.reasonCode);
    const declared = declarations[mint.actionId]?.[mint.reasonCode] !== undefined;
    if (!read && !declared)
      findings.push(
        `unfinished_success_with_no_reading:${mint.actionId}:${mint.reasonCode} (${mint.site}) - the Mod mints this ` +
          "terminal with `ExecutionState.Succeeded`, its row does not name it and nothing declares what it means, so " +
          "a real success is a `succeeded_receipt_without_its_own_postcondition` until somebody runs into it",
      );
    if (read && declared)
      findings.push(
        `unfinished_success_declared_and_read:${mint.actionId}:${mint.reasonCode} (${mint.site}) - the row answers ` +
          "this code before the declaration is asked, so the declaration is a claim nothing checks",
      );
  }
  for (const actionId of Object.keys(declarations))
    for (const reasonCode of Object.keys(declarations[actionId] ?? {}))
      if (!seen.has(`${actionId}:${reasonCode}`))
        findings.push(
          `unfinished_declaration_has_no_producer:${actionId}:${reasonCode} - no ` +
            "`PostconditionVerdict` site mints this code any more, so the exemption has outlived the code it was " +
            "written for",
        );

  return { mints, blocked, findings };
}

/** The shipped reading, so the assertions below and the falsifiers read one census function. */
function shipped(): Census {
  return measure(readFileSync(CONTRACTS_FILE, "utf8"), STARDEW_UNFINISHED_SUCCESSES as unknown as Declarations);
}

test("every_succeeded_verdict_the_mod_can_mint_is_read_or_a_named_not_yet:<action>:<code>", () => {
  const census = shipped();

  const read = census.mints.filter((mint) => !census.findings.some((finding) => finding.startsWith("unfinished_success_with_no_reading") && finding.includes(`:${mint.actionId}:${mint.reasonCode} `)));
  process.stdout.write(
    `codes examined ${String(census.mints.length)} · read ${String(read.length)} · declared ${String(census.mints.length - read.length)}\n`,
  );
  process.stdout.write(`sites blocked ${String(census.blocked.length)}\n`);
  for (const mint of [...census.mints].sort((left, right) =>
    `${left.actionId}:${left.reasonCode}`.localeCompare(`${right.actionId}:${right.reasonCode}`),
  ))
    process.stdout.write(`  ${mint.actionId}:${mint.reasonCode} (${mint.site})\n`);

  assert.ok(
    census.mints.length > 0,
    "blocked: the producer mints no succeeded verdict this gate can read, so its population is empty and its verdict is not measured",
  );
  assert.deepEqual(
    census.blocked,
    [],
    "a succeeded code this gate could not read is a code no row was checked against, and passing it would be silent",
  );
  assert.deepEqual(census.findings, [], "a succeeded terminal the Host has not decided about is the defect this gate holds");
});

/**
 * THE FALSIFIER, and it is round90's own history: the tree before this unit had no declaration at all, so the shipped
 * reading has to name `break_rock:rock_source_damaged` once it is taken away. `chop_tree:tree_source_damaged` is the
 * other direction - an entry no producer site mints - and the last assertion is the one that keeps an entry from
 * being a place to hide a code the row already answers.
 */
test("TheGateIsRedOnRound90sDamagedSwing", () => {
  const contracts = readFileSync(CONTRACTS_FILE, "utf8");
  const shippedDeclarations = STARDEW_UNFINISHED_SUCCESSES as unknown as Declarations;

  // (1) THE TREE AS IT SHIPPED: no declaration, so the damaged swing is read by nothing.
  const withoutDeclaration = measure(contracts, {});
  const unread = withoutDeclaration.findings
    .filter((finding) => finding.startsWith("unfinished_success_with_no_reading:"))
    .map((finding) => finding.slice(0, finding.indexOf(" (")));
  assert.deepEqual(
    unread,
    ["unfinished_success_with_no_reading:break_rock:rock_source_damaged"],
    "round90's four honest swings are the one code with no reading, and the gate must name it rather than count it",
  );

  // (2) AN EXPIRED ENTRY: a code the producer would have to mint for it to mean anything.
  const expired = measure(contracts, {
    ...shippedDeclarations,
    chop_tree: { tree_source_damaged: () => true },
  });
  assert.deepEqual(
    expired.findings,
    [
      "unfinished_declaration_has_no_producer:chop_tree:tree_source_damaged - no `PostconditionVerdict` site mints this code any more, so the exemption has outlived the code it was written for",
    ],
    "an entry no producer site mints is an exemption that has outlived its code, and it fails here rather than being read forever",
  );

  // (3) READ AND DECLARED AT ONCE: the row answers `rock_source_broken`, so declaring it would be a claim never asked.
  const doubled = measure(contracts, {
    ...shippedDeclarations,
    break_rock: { ...(shippedDeclarations.break_rock ?? {}), rock_source_broken: () => true },
  });
  assert.deepEqual(
    doubled.findings,
    [
      "unfinished_success_declared_and_read:break_rock:rock_source_broken (resourcetoolactions.cs:ExecuteBreakRock) - the row answers this code before the declaration is asked, so the declaration is a claim nothing checks",
    ],
    "a code the row already reads cannot also be declared unfinished",
  );
});
