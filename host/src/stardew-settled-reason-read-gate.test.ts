import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { STARDEW_COMPLETION_CONTRACTS } from "./stardew-completion-contracts.js";

/**
 * `every_settled_reason_the_mod_mints_is_read_by_the_host_contract:<code>` - every settled terminal the Mod can answer is
 * one the Host's row for THAT action reads back, with the `settled_by=` warrant the seam prints.
 *
 * WHY. The Mod learned a second way to say "this is done": the world already said so. `TileTargetGate.Settled` mints
 * `Succeeded` with a warrant when the target no longer has anything left to do, and `SettledIfConsumed` mints the
 * catalogue's own version of it. The Host's table was written when there was only one way, so every settled receipt was a
 * `succeeded` terminal with no arm: `round81` answered THIRTY-SEVEN real successes - 31 `soil_already_tilled`, 2
 * `weed_target_gone`, 4 `rock_source_gone` - and `tools/lib/task-purpose.mjs` filed all of them as
 * `succeeded_receipt_without_its_own_postcondition`, which is what ruled `clear_and_plant_long_patch` unproven.
 * `stardew-live-receipt-parity.test.ts` and `stardew-completion-contract-mintability.test.ts` see only the shapes their
 * corpus carries, so a settled code nobody has run yet is invisible to both. This asks the question of the PRODUCER.
 *
 * POPULATION, FROM THE PRODUCER AND NEVER FROM A LIST. It is every settlement the Mod can mint, read out of the C# where
 * it is minted:
 *
 *   - `TileTargetGate.SettledIfConsumed("<action>", ...)` - the action is the call's own first argument, and the warrant
 *     is the catalogue's (`TileTargetSettledBy.ConsumesFor`), read here as `consumes:<targetFamily>` from the action
 *     surface the Mod GENERATES (`integrations/stardew/action-development/contracts/generated/action-surface.v1.json`),
 *     because `FarmhandActionCatalog.ChoreFamilyOf` answers exactly that descriptor's `TargetFamily`;
 *   - `TileTargetGate.Settled(...)` - the warrant is the site's own last argument (`TileTargetSettledBy.EngineFlag(f, v)`
 *     or `TileTargetSettledBy.Consumes`); the action is the one whose handler arm reaches the enclosing member, or the
 *     single contract action id the members that call it name;
 *   - a receipt that interpolates `TileTargetSettledBy.EvidenceField` outside the seam that defines it - the modal path,
 *     `farmhandexecutioncontroller.modalactions.cs:92-98` - whose reason code is the plain literal of the
 *     `RememberTerminal(...)` call that mints it.
 *
 * Each site's reason code is read from the `const string` it names, never from a table here.
 *
 * PROPERTY. The Host row for that action must name the reason code AND that exact warrant string in the same arm. A row
 * that names the code but demands a different `settled_by` is not reading this producer's receipt, and a warrant a row
 * quotes only in a COMMENT is not a requirement - comments are stripped before anything is read.
 *
 * PRINT. `codes examined C · read R · unread U`, then one line per code with its action, its warrant and its site.
 * `U > 0` fails naming the action and the code. An empty population is BLOCKED with the reason, never green, and a site
 * this gate cannot read is BLOCKED by name rather than dropped - the three zeroes are told apart.
 *
 * WHAT IT CANNOT SEE, stated rather than implied. It reads the SHAPE a row demands, not the VALUES it accepts: a row that
 * names `consumes:rockSourceTargets` and then refuses every receipt carrying it would pass here. That half is
 * `stardew-completion-evidence-coverage.test.ts`'s, which drives the same rows with the run's real receipts and with the
 * warrant removed, and `stardew-completion-contract-mintability.test.ts`'s, which holds `round81`'s receipt for receipt.
 *
 * red-proof: history  the tree before this unit - the four settlement arms absent, the four codes already minted -
 *                   prints `codes examined 4 · read 0 · unread 4` and names `break_rock:rock_source_gone`,
 *                   `chop_tree:tree_chop_source_gone`, `cut_weeds:weed_target_gone` and `till_soil:soil_already_tilled`.
 *                   The same reading is asserted below by replaying the contract with those warrants changed
 *                   (`TheGateIsRedOnTheSettlementsTheModAlreadyMinted`).
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MOD_ROOT = join(ROOT, "integrations", "stardew");
const CONTRACTS_FILE = join(ROOT, "host", "src", "stardew-completion-contracts.ts");
const SURFACE_FILE = join(MOD_ROOT, "action-development", "contracts", "generated", "action-surface.v1.json");


/** One settlement the Mod can mint, with the facts the Host row must read back. */
type SettlementMint = Readonly<{
  actionId: string;
  reasonCode: string;
  /** The `settled_by=` value this site prints. */
  warrant: string;
  /** `file:member`, so a failure points at the site and not at a count. */
  site: string;
}>;

/** One census of the producer against the contract, plus everything that could not be read. */
type Census = Readonly<{
  mints: readonly SettlementMint[];
  /** Sites this gate could not attribute or whose warrant it could not read - never silently dropped. */
  blocked: readonly string[];
  /** `action:code` findings for rows that do not name the code with its warrant. */
  unread: readonly string[];
}>;

/** The contract's text without `/`-comments: a shape a row mentions only in prose is not a requirement. */
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
      if (entry === "obj" || entry === "bin" || entry === "tests" || entry === "action-development" || entry === "node_modules") continue;
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

/** A plain string literal - the token a site names an action or a reason code with. */
function plainLiteral(text: string | undefined): string | null {
  const match = /^@?"(?<value>[^"\\]*)"$/u.exec((text ?? "").trim());
  return match?.groups?.value ?? null;
}

/** Every `const string <name> = "<literal>"` the producer declares, by name. */
function stringConstants(sources: readonly { file: string; text: string }[]): Map<string, string> {
  const constants = new Map<string, string>();
  for (const source of sources)
    for (const match of source.text.matchAll(/const\s+string\s+(?<name>\w+)\s*=\s*"(?<value>[^"\\]*)"/gu))
      if (!constants.has(match[1] as string)) constants.set(match[1] as string, match[2] as string);
  return constants;
}

/** The `targetFamily` each action publishes, from the surface the Mod generates. */
function declaredTargetFamilies(): Map<string, string> {
  const surface = JSON.parse(readFileSync(SURFACE_FILE, "utf8")) as {
    actions: Array<{ actionId: string; targetFamily?: string }>;
  };
  const families = new Map<string, string>();
  for (const action of surface.actions)
    if (action.targetFamily !== undefined) families.set(action.actionId, action.targetFamily);
  return families;
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

/** The clause of a row that answers `reasonCode`, from that arm to the next one. */
function armFor(rowText: string, reasonCode: string): string | null {
  const at = rowText.indexOf(`claim.reasonCode === "${reasonCode}"`);
  if (at < 0) return null;
  const next = rowText.indexOf("claim.reasonCode === ", at + 1);
  return next < 0 ? rowText.slice(at) : rowText.slice(at, next);
}

/** The action whose handler chain reaches `member`, or the reason this gate cannot name one. */
function actionOf(
  member: Member,
  members: readonly Member[],
  rowIds: ReadonlySet<string>,
  sources: readonly { file: string; text: string }[],
): { actionId: string } | { blocked: string } {
  // 1. THE DISPATCH ARM that routes one action to a member calling this one.
  const armed = new Set<string>();
  const arm = new RegExp(`"(?<action>[a-z][a-z0-9_]*)"\\s*=>[^;]{0,200}?\\b${member.name}\\s*\\(`, "gu");
  for (const source of sources) for (const match of source.text.matchAll(arm)) if (rowIds.has(match[1] as string)) armed.add(match[1] as string);
  if (armed.size === 1) return { actionId: [...armed][0] as string };
  // 2. THE MEMBERS THAT CALL IT, when exactly one contract action id is named beside the call.
  const callers = new Set<string>();
  for (const caller of members)
    if (caller.name !== member.name && caller.text.includes(`${member.name}(`))
      for (const match of caller.text.matchAll(/"([a-z][a-z0-9_]*)"/gu)) if (rowIds.has(match[1] as string)) callers.add(match[1] as string);
  return callers.size === 1
    ? { actionId: [...callers][0] as string }
    : {
        blocked: `${member.file}:${member.name} is reached by ${[...armed].sort().join(", ") || "no dispatch arm"} and names ${[...callers].sort().join(", ") || "no contract action"}`,
      };
}

/** The `consumes:<family>` the catalogue's own `ConsumesFor` prints for this action. */
function consumesFor(
  actionId: string,
  families: ReadonlyMap<string, string>,
): { warrant: string } | { blocked: string } {
  const family = families.get(actionId);
  return family === undefined
    ? { blocked: `${actionId} publishes no targetFamily, so SettledIfConsumed cannot mint for it` }
    : { warrant: `consumes:${family}` };
}

/** The warrant a site's own argument names, spelled through the one vocabulary that declares the forms. */
function warrantOf(
  argument: string,
  actionId: string,
  families: ReadonlyMap<string, string>,
): { warrant: string } | { blocked: string } {
  const engineFlag = /TileTargetSettledBy\.EngineFlag\(\s*"(?<field>[^"]*)"\s*,\s*"(?<value>[^"]*)"\s*\)/u.exec(argument);
  if (engineFlag?.groups) return { warrant: `engine_flag:${engineFlag.groups.field}=${engineFlag.groups.value}` };
  if (/TileTargetSettledBy\.Consumes\b/u.test(argument)) return consumesFor(actionId, families);
  return { blocked: `the site's warrant argument names no readable form: ${argument.slice(0, 120) || "<none>"}` };
}

/**
 * The census: every settlement the Mod can mint, against the row that must read it.
 *
 * `contractsText` is a parameter so the falsifier can replay the tree before this unit without keeping a second reading.
 */
function measure(contractsText: string): Census {
  const sources = csharpSources();
  assert.ok(sources.length > 0, "blocked: no producer source was found, so no settlement could be read");
  const constants = stringConstants(sources);
  const families = declaredTargetFamilies();
  assert.ok(families.size > 0, "blocked: the action surface declares no target family, so no consumes warrant can be read");
  const members = membersOf(sources);
  const rowIds = new Set(Object.keys(STARDEW_COMPLETION_CONTRACTS));
  const arms = contractArms(contractsText);

  // The seam that DEFINES the vocabulary is not a site that mints one: its `Settled`/`SettledIfConsumed` are the helpers
  // every site calls, and its `EvidenceField` interpolation is the spelling they share.
  const seams = sources.filter((source) => /const\s+string\s+EvidenceField\s*=/u.test(source.text));
  assert.equal(
    seams.length,
    1,
    `blocked: expected exactly one seam to declare the evidence field, found ${seams.map((seam) => seam.file).join(", ") || "none"}`,
  );
  const seam = seams[0]?.file as string;

  const blocked: string[] = [];
  const mints: SettlementMint[] = [];
  const seen = new Set<string>();
  const record = (mint: SettlementMint) => {
    const key = `${mint.actionId}:${mint.reasonCode}:${mint.warrant}`;
    if (seen.has(key)) return;
    seen.add(key);
    mints.push(mint);
  };

  for (const source of sources) {
    if (source.file === seam) continue;

    for (const match of source.text.matchAll(/TileTargetGate\.SettledIfConsumed\(/gu)) {
      const args = callArguments(source.text, match.index + match[0].length - 1);
      const actionId = plainLiteral(args[0]);
      const expression = (args[2] ?? "").trim();
      const reasonCode = constants.get(expression) ?? plainLiteral(expression);
      const site = `${source.file}:${memberAt(members, source.file, match.index)?.name ?? "<no member>"}`;
      if (actionId === null || reasonCode === null) {
        blocked.push(`${site} SettledIfConsumed names no readable action or reason code`);
        continue;
      }
      const warrant = consumesFor(actionId, families);
      if ("blocked" in warrant) {
        blocked.push(`${site} ${warrant.blocked}`);
        continue;
      }
      record({ actionId, reasonCode, warrant: warrant.warrant, site });
    }

    for (const match of source.text.matchAll(/TileTargetGate\.Settled\(/gu)) {
      const args = callArguments(source.text, match.index + match[0].length - 1);
      const expression = (args[1] ?? "").trim();
      const reasonCode = constants.get(expression) ?? plainLiteral(expression);
      const member = memberAt(members, source.file, match.index);
      const site = `${source.file}:${member?.name ?? "<no member>"}`;
      if (reasonCode === null || member === undefined) {
        blocked.push(`${site} Settled names no readable reason code or enclosing member`);
        continue;
      }
      const action = actionOf(member, members, rowIds, sources);
      if ("blocked" in action) {
        blocked.push(`${site} Settled cannot be attributed to one action: ${action.blocked}`);
        continue;
      }
      const warrant = warrantOf(args[3] ?? "", action.actionId, families);
      if ("blocked" in warrant) {
        blocked.push(`${site} ${warrant.blocked}`);
        continue;
      }
      record({ actionId: action.actionId, reasonCode, warrant: warrant.warrant, site });
    }

    for (const match of source.text.matchAll(/\{TileTargetSettledBy\.EvidenceField\}/gu)) {
      const member = memberAt(members, source.file, match.index);
      const site = `${source.file}:${member?.name ?? "<no member>"}`;
      const callAt = source.text.lastIndexOf("RememberTerminal(", match.index);
      if (member === undefined || callAt < 0 || callAt < member.start) {
        blocked.push(`${site} prints the evidence field from no RememberTerminal call this gate can read`);
        continue;
      }
      const args = callArguments(source.text, callAt + "RememberTerminal".length);
      const reasonCode = args
        .map((argument) => plainLiteral(argument))
        .find((literal) => literal !== null && /^[a-z][a-z0-9_]*$/u.test(literal));
      if (reasonCode === undefined || reasonCode === null) {
        blocked.push(`${site} prints the evidence field under no literal reason code`);
        continue;
      }
      const action = actionOf(member, members, rowIds, sources);
      if ("blocked" in action) {
        blocked.push(`${site} prints the evidence field and cannot be attributed to one action: ${action.blocked}`);
        continue;
      }
      const named = /TileTargetSettledBy\.EngineFlag\(\s*"(?<field>[^"]*)"\s*,\s*"(?<value>[^"]*)"\s*\)/u.exec(member.text);
      if (named?.groups === undefined) {
        blocked.push(`${site} prints the evidence field from no engine flag this gate can read`);
        continue;
      }
      record({
        actionId: action.actionId,
        reasonCode,
        warrant: `engine_flag:${named.groups.field}=${named.groups.value}`,
        site,
      });
    }
  }

  const unread: string[] = [];
  for (const mint of mints) {
    const row = arms.get(mint.actionId);
    const arm = row === undefined ? null : armFor(row, mint.reasonCode);
    if (arm === null || !arm.includes(`"${mint.warrant}"`))
      unread.push(
        `${mint.actionId}:${mint.reasonCode} at ${mint.site} prints settled_by=${mint.warrant} - ${
          row === undefined ? "the contract has no row for this action" : "the row refuses the code or demands another warrant"
        }`,
      );
  }
  return { mints, blocked, unread };
}

test("every_settled_reason_the_mod_mints_is_read_by_the_host_contract:<code>", () => {
  const census = measure(readFileSync(CONTRACTS_FILE, "utf8"));

  process.stdout.write(
    `codes examined ${String(census.mints.length)} · read ${String(census.mints.length - census.unread.length)} · unread ${String(census.unread.length)}\n`,
  );
  process.stdout.write(`sites blocked ${String(census.blocked.length)}\n`);
  for (const mint of [...census.mints].sort((left, right) =>
    `${left.actionId}:${left.reasonCode}`.localeCompare(`${right.actionId}:${right.reasonCode}`),
  ))
    process.stdout.write(`  ${mint.actionId}:${mint.reasonCode} settled_by=${mint.warrant} (${mint.site})\n`);

  assert.ok(
    census.mints.length > 0,
    "blocked: the producer mints no settlement this gate can read, so its population is empty and its verdict is not measured",
  );
  assert.deepEqual(
    census.blocked,
    [],
    "a settlement this gate could not read is a settlement no row was checked against, and passing it would be silent",
  );
  assert.deepEqual(
    census.unread,
    [],
    "a_settled_receipt_is_not_a_success_until_its_row_reads_it: the Mod mints this terminal and the Host's row for the "
      + "action does not read it, so a real success is a `succeeded_receipt_without_its_own_postcondition`",
  );
});

/**
 * THE FALSIFIER, on the code that shipped: every settlement arm's warrant is changed in a copy of the contract, and the
 * gate must name each action and each code. `round81` produced 37 such receipts, so a gate that cannot go red on the
 * shapes it was written for is a gate nobody has read.
 */
test("TheGateIsRedOnTheSettlementsTheModAlreadyMinted", () => {
  const shipped = readFileSync(CONTRACTS_FILE, "utf8");
  const expected = [
    "break_rock:rock_source_gone",
    "chop_tree:tree_chop_source_gone",
    "cut_weeds:weed_target_gone",
    "till_soil:soil_already_tilled",
  ];

  // (1) THE ARM IS NOT THERE: the four codes renamed, which is byte-for-byte the state the table shipped in - no arm
  // answered any of them, so each real success returned `false`.
  const withoutArms = shipped
    .replace(/"soil_already_tilled"/gu, '"unread_settlement"')
    .replace(/"weed_target_gone"/gu, '"unread_settlement"')
    .replace(/"rock_source_gone"/gu, '"unread_settlement"')
    .replace(/"tree_chop_source_gone"/gu, '"unread_settlement"');
  const missingArm = measure(withoutArms).unread.map((finding) => finding.slice(0, finding.indexOf(" at ")));
  assert.deepEqual(
    [...missingArm].sort(),
    expected,
    "a row that answers no arm for the settled code is the defect round81 paid for, and the gate must name every one",
  );

  // (2) THE CODE IS READ BUT UNDER ANOTHER WARRANT: the arm stays and the `settled_by` it demands is not the one the seam
  // prints. A row that reads the code but not the claim is the same failure one layer further in.
  const otherWarrant = shipped
    .replace(/"engine_flag:hoedirt=present"/gu, '"engine_flag:someone_elses_reading"')
    .replace(/"consumes:(?:weedTargets|rockSourceTargets|treeChopSourceTargets)"/gu, '"consumes:someone_elses_reading"');
  const misread = measure(otherWarrant).unread.map((finding) => finding.slice(0, finding.indexOf(" at ")));
  assert.deepEqual([...misread].sort(), expected, "the warrant is the whole content of the claim, not decoration");
});
