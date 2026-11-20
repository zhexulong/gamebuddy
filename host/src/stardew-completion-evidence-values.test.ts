import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * `a_success_evidence_field_carries_a_value_the_contract_can_read:<action>.<field>` - the value the Mod PRINTS for a
 * declared evidence field is a value the Host's reader for that field can read.
 *
 * WHY. A receipt is read by two programs written in two languages, and the only thing joining them was the field NAME.
 * The value's spelling was nobody's job: `fish_here` printed `bite_observed=isNibbling` - a C# expression's own source
 * text, where a value belongs - and the Host's boolean reader accepts only `true`/`false`, so EVERY real catch in
 * `round80` was a `fish_caught` receipt that proved nothing (`succeeded_receipt_without_its_own_postcondition`), and the
 * day's `a_fish_from_the_water` was ruled `task_purpose_evidence_without_postcondition`. The same run answered 119 real
 * emotes with `armed=`, a field no declaration listed (that half is the parity file's: an undeclared field refuses a
 * receipt, see `an_undeclared_receipt_field_refuses_a_real_receipt`).
 *
 * POPULATION, FROM THE DECLARATIONS AND NEVER FROM A LIST. Both halves are read out of the authorities:
 *   - the FIELDS and the READER THE CONTRACT USES FOR EACH are parsed from `STARDEW_COMPLETION_CONTRACTS`' own source:
 *     every `claim.reasonCode === "<code>"` arm, the `declaredCompletionEvidence(...)` call beside it, its key list, and
 *     the function that reads the key (`booleanEvidenceValue(e.x)`, `integerEvidenceValue(e.x)`, `e.x === "lit"`, ...).
 *     A row added tomorrow is examined without touching this file, and a row that declares a new key joins with the
 *     reader its author wrote;
 *   - the VALUES are the Mod's own evidence literals, bound to an arm by the CALL that mints that reason code - the
 *     code literal has to be in the call, and the evidence is either inline in it or the local the call passes (which
 *     is resolved to its `string x = ...` initializer). That binding is what keeps one member's refusal shape from being
 *     judged against another terminal's success contract in the same member.
 *
 * PROPERTY, in three clauses. Every (arm, field) the Mod prints is classified:
 *   - `literals`   the producer printed a value, and the reader accepts it (`true`, `-1`, `none`, `{hole}`, ...);
 *   - `expressions` the producer printed the SOURCE TEXT OF AN EXPRESSION where a value belongs (`isNibbling`);
 *   - `unreadable`  the producer printed a value the reader refuses (`True` where `true` is read, `every_slot_...` where
 *                   an integer is read, a value carrying the `;` field separator, ...).
 * `E > 0` and `U > 0` fail, naming the action, the terminal, the field and the producer site. `E` is never exemptible -
 * it is the defect this file was written for - and the one `U` below is debt with a reason, because its owner is
 * another unit's file.
 *
 * PRINT. `fields examined F · literals L · expressions E · unreadable U`, then `arms witnessed A of N`, then one line per
 * finding. An empty population is BLOCKED, never green: a fold over no fields agrees with itself.
 *
 * WHAT IT CANNOT SEE, stated rather than implied. A field whose value is assembled from a vocabulary constant
 * (`$"{TileTargetSettledBy.EvidenceField}{settledBy}"`, `dismiss_modal`'s warrant) is a value the producer COMPUTES, so it
 * reads as a hole here; that spelling is held by the producer's own test (`ModalDismissActionTests`,
 * `Dismiss_WithoutAModal_IsTheNoOp_TheInsertedNodeNeeds`) and by the row that requires it
 * (`stardew-completion-contract-mintability.test.ts`). And a row that hands its evidence to a named predicate instead of
 * `declaredCompletionEvidence` is counted as `delegating` and printed, not judged.
 *
 * red-proof: history  the tree before this unit, read by this file: `expressions 1 · unreadable 1`, naming
 *                    `fish_here.fish_caught.bite_observed = "isNibbling"` in
 *                    `farmhandexecutioncontroller.fishingactions.cs:UpdateFishingCast`. The `armed=` half of the same
 *                    run is measured by `stardew-live-receipt-parity.test.ts`, whose population is undeclared producer
 *                    fields (host/src/stardew-completion-evidence-values.test.ts).
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONTRACTS = readFileSync(join(ROOT, "host", "src", "stardew-completion-contracts.ts"), "utf8");

/** One accepted terminal of one action, with the evidence contract its row declares beside it. */
type Arm = Readonly<{
  actionId: string;
  reasonCode: string;
  keys: ReadonlySet<string>;
  readers: ReadonlyMap<string, ReadonlySet<string>>;
}>;

/** The index of the `)` that closes the `(` at `from`, or -1 when the text runs out. */
function closingParen(text: string, from: number): number {
  let depth = 0;
  for (let index = from; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Every `declaredCompletionEvidence(...)` argument list in `text`, by balanced parentheses. */
function declaredCalls(text: string): string[] {
  const calls: string[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf("declaredCompletionEvidence(", from);
    if (at < 0) return calls;
    const open = at + "declaredCompletionEvidence".length;
    const close = closingParen(text, open);
    if (close < 0) return calls;
    calls.push(text.slice(open + 1, close));
    from = close;
  }
}

/**
 * The string literals a call writes inside SQUARE BRACKETS: the required and optional key lists, in either spelling
 * (one key per line, or several on one). A quoted word outside brackets is a validator's compared value
 * (`e.x === "true"`), not a declared key, so it is not collected here.
 */
function declaredKeys(call: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  for (let index = 0; index < call.length; index += 1) {
    const character = call[index];
    if (character === '"') {
      const close = call.indexOf('"', index + 1);
      if (close < 0) break;
      const text = call.slice(index + 1, close);
      if (depth > 0 && /^[a-z][a-z0-9_]*$/u.test(text)) keys.push(text);
      index = close;
      continue;
    }
    if (character === "[") depth += 1;
    else if (character === "]") depth = Math.max(0, depth - 1);
  }
  return keys;
}

/** The declared key list and the readers a call's validator uses on each key. */
function describeCall(call: string): { keys: Set<string>; readers: Map<string, Set<string>> } {
  const keys = new Set(declaredKeys(call));
  const readers = new Map<string, Set<string>>();
  const add = (key: string, reader: string) => {
    if (!readers.has(key)) readers.set(key, new Set());
    readers.get(key)?.add(reader);
  };
  for (const match of call.matchAll(/([A-Za-z]\w*)\(e\.([a-z_0-9]+)\b/gu)) add(match[2] as string, match[1] as string);
  for (const match of call.matchAll(/e\.([a-z_0-9]+) === "([^"]*)"/gu)) add(match[1] as string, `exact:${match[2]}`);
  return { keys, readers };
}

/**
 * Every arm of every row that declares its evidence through `declaredCompletionEvidence`.
 *
 * A row that delegates to a named predicate keeps its key list in a helper with a different grammar; those arms are
 * counted as `delegating` and printed, not silently skipped.
 */
function declaredArms(): { arms: Arm[]; rows: number; delegating: number } {
  const tableStart = CONTRACTS.indexOf("export const STARDEW_COMPLETION_CONTRACTS");
  const tableEnd = CONTRACTS.indexOf('} satisfies Record<ExecutionRequest["action"]');
  assert.ok(
    tableStart >= 0 && tableEnd > tableStart,
    "blocked: the completion table is no longer where this gate reads it, so nothing below was examined",
  );
  const table = CONTRACTS.slice(tableStart, tableEnd);
  const rowStarts = [...table.matchAll(/^ {2}([a-z][a-z0-9_]*): \(claim\) => \{/gmu)];
  assert.ok(rowStarts.length > 0, "blocked: no rows were found in the completion table");

  const arms: Arm[] = [];
  let delegating = 0;
  rowStarts.forEach((row, index) => {
    const actionId = row[1] as string;
    const text = table.slice(row.index, index + 1 < rowStarts.length ? rowStarts[index + 1]?.index : table.length);
    const codes = [...text.matchAll(/claim\.reasonCode === "([a-z0-9_]+)"/gu)].map((match) => ({
      code: match[1] as string,
      at: match.index,
    }));
    let declared = false;
    codes.forEach((terminal, codeIndex) => {
      const slice = text.slice(terminal.at, codeIndex + 1 < codes.length ? codes[codeIndex + 1]?.at : text.length);
      const keys = new Set<string>();
      const readers = new Map<string, Set<string>>();
      for (const call of declaredCalls(slice)) {
        const described = describeCall(call);
        for (const key of described.keys) keys.add(key);
        for (const [key, reader] of described.readers) {
          if (!readers.has(key)) readers.set(key, new Set());
          for (const name of reader) readers.get(key)?.add(name);
        }
      }
      if (keys.size === 0) return;
      declared = true;
      arms.push({ actionId, reasonCode: terminal.code, keys, readers });
    });
    if (!declared) delegating += 1;
  });
  return { arms, rows: rowStarts.length, delegating };
}

/** A member declaration of any shape, so the body a producer's evidence sits in can be read. */
const MEMBER = /^[ \t]*(?:(?:private|internal|public|protected|static|sealed|override|partial|async|readonly|unsafe|new)\s+)+[\w<>?,\[\]\.\s]+?\s(?<name>\w+)\s*\(/gmu;
const CALL = /\b(?:this\.)?(?<name>\w+)\s*\(/gu;

type ProducerMember = Readonly<{ file: string; name: string; text: string }>;

/** Every producer member of the Mod, tests and generated trees excluded: a directory scan, not a file list. */
function producerMembers(): ProducerMember[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      if (["obj", "bin", "tests", "action-development", "node_modules"].includes(entry)) continue;
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(".cs")) files.push(path);
    }
  };
  walk(join(ROOT, "integrations", "stardew"));

  const members: ProducerMember[] = [];
  for (const path of files) {
    // A commented-out shape is prose, not something the Mod prints: `/`-comments are stripped before anything is read.
    const source = readFileSync(path, "utf8")
      .replace(/\r/gu, "")
      .split("\n")
      .map((line) => {
        const comment = line.indexOf("//");
        return comment < 0 ? line : line.slice(0, comment);
      })
      .join("\n");
    const starts = [...source.matchAll(MEMBER)];
    starts.forEach((start, index) => {
      members.push({
        file: relative(ROOT, path),
        name: start[1] as string,
        text: source.slice(start.index, index + 1 < starts.length ? starts[index + 1]?.index : source.length),
      });
    });
  }
  return members;
}

/** The string literals of a piece of C#, with the text they print (interpolation holes included, as written). */
function stringLiterals(text: string): string[] {
  return [...text.matchAll(/(\$@|@\$|\$|@)?"((?:[^"\\\n]|\\.|"")*)"/gu)].map((match) => match[2] as string);
}

/** The `string <name> = ...;` initializer before `before`, when the member holds one. */
function localInitializer(member: ProducerMember, name: string, before: number): string | null {
  const pattern = new RegExp(`(?:^|[\\s;{])(?:string|var)\\s+${name}\\s*=`, "gu");
  let start = -1;
  for (const match of member.text.slice(0, before).matchAll(pattern)) start = match.index + match[0].length;
  if (start < 0) return null;
  const end = member.text.slice(start).search(/;[ \t]*\n/u);
  return end < 0 ? null : member.text.slice(start, start + end);
}

/**
 * The evidence literals BOUND to a reason code in this member: the call that carries the code literal, the strings
 * written inside that call, and the initializer of every local the call passes by name.
 */
function boundLiterals(member: ProducerMember, reasonCode: string): string[] {
  const found: string[] = [];
  for (const match of member.text.matchAll(CALL)) {
    const open = match.index + match[0].length - 1;
    const close = closingParen(member.text, open);
    if (close < 0) continue;
    const call = member.text.slice(match.index, close + 1);
    if (!stringLiterals(call).includes(reasonCode)) continue;
    found.push(...stringLiterals(call));
    // EVERY LOCAL THE CALL NAMES, not only a bare argument: the evidence is as often `$"..." + staleReading` as it is
    // a variable passed on its own, and both are the same fact - the call is what mints this terminal.
    for (const name of new Set([...call.matchAll(/\b([a-z]\w*)\b/gu)].map((one) => one[1] as string))) {
      const initializer = localInitializer(member, name, match.index);
      if (initializer !== null) found.push(...stringLiterals(initializer));
    }
  }
  return found;
}

/**
 * The `field=value` clauses the printed literals carry, as the wire will read them.
 *
 * A value the literal COMPUTES is written as a hole and stops the literal's own text: `commit_already_driven=true{tail}`
 * prints `true` and then whatever `tail` holds, and `";text=" + bounded` prints `text=` with the line appended from
 * another expression - which is a computed value, not an empty one (an empty value would be the whole receipt, refused by
 * the shared parser). Both are recorded as `{...}` so they are judged as values and not as source text.
 */
function clauses(literals: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const literal of literals) {
    for (const part of literal.split(";")) {
      const separator = part.indexOf("=");
      if (separator <= 0) continue;
      const key = part.slice(0, separator);
      if (!/^[a-z][a-z0-9_]*$/u.test(key)) continue;
      const printed = part.slice(separator + 1);
      const hole = printed.indexOf("{");
      const value = hole === 0 ? "{...}" : hole > 0 ? printed.slice(0, hole).trim() : printed.trim();
      values.set(key, value.length === 0 ? "{...}" : value);
    }
  }
  return values;
}

type Verdict = "literals" | "expressions" | "unreadable";

/**
 * What a value the producer printed IS, as far as the reader the contract uses on that field goes.
 *
 * A `{...}` hole is a value the producer computes, so this gate cannot judge it. A field read OPAQUELY
 * (`hasOpaqueEvidenceValue` and its siblings) reads any non-empty token, so only its presence is a contract - which is
 * why the expression-text verdict below is reserved for a field the contract reads as a TYPED value (a boolean, a number,
 * an enumerated word): there, an identifier with an inner capital (`isNibbling`, `IsEmoting`) can only be the source text
 * of the expression that computed the value, never a value.
 *
 * A TYPED READER IS ASKED ABOUT THE SPELLING, NOT THE MATCH: `clump_removed=false` and `tool=hoe` are readable values of
 * a field whose accepted words are `true` and `axe`/`pickaxe` (the other branch's literal, which this scan cannot
 * separate from this one); the row itself decides whether the value is the one it wanted. What this gate refuses is a
 * token the reader cannot read AT ALL - a word where a number goes, `True` where `true` is read.
 */
function classify(value: string, readers: ReadonlySet<string>): Verdict {
  if (value.startsWith("{")) return "literals";
  if (value.length === 0) return "unreadable";
  const exact = [...readers].filter((name) => name.startsWith("exact:")).map((name) => name.slice("exact:".length));
  const boolean = readers.has("booleanEvidenceValue");
  const numeric = [...readers].some((name) => /integer|Slot|finite/iu.test(name));
  if (!boolean && exact.length === 0 && !numeric) return "literals";
  if (exact.includes(value)) return "literals";
  if (boolean && (value === "true" || value === "false")) return "literals";
  if (exact.some((accepted) => sameKind(accepted, value))) return "literals";
  if (numeric && /^-?\d+(?:\.\d+)?$/u.test(value)) return "literals";
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value) && /[A-Z]/u.test(value) ? "expressions" : "unreadable";
}

/** Whether two tokens are spellings of the same kind: a boolean, a number, or a bare lowercase word. */
function sameKind(accepted: string, value: string): boolean {
  const isBoolean = (token: string) => token === "true" || token === "false";
  const isNumber = (token: string) => /^-?\d+(?:\.\d+)?$/u.test(token);
  const isWord = (token: string) => /^[a-z][a-z0-9_]*$/u.test(token);
  return (isBoolean(accepted) && isBoolean(value)) || (isNumber(accepted) && isNumber(value)) || (isWord(accepted) && isWord(value));
}

/**
 * THE DEBT, NAMED AND EXPIRING. One real finding in this population belongs to another unit's file, and it is a defect
 * rather than a disagreement: `ExecuteCollectCrabPotOutput` writes `native_entry=GameLocation.checkAction;CrabPot
 * .checkForAction`, and the `;` inside the value splits the receipt into a clause with no `=`, which the Host's shared
 * parser refuses - so every real `crab_pot_output_collected` success is unreadable, the same class as the
 * `shop_purchase` separator defect. The Mod calls `location.checkAction` (`:151`), so the honest value is that one entry;
 * the fix belongs to the file's owner, not here.
 *
 * AN ENTRY THAT STOPS MATCHING FAILS AS STALE, so this table cannot outlive the defect it names.
 */
const UNREADABLE_DEBT: Readonly<Record<string, string>> = Object.freeze({
  "collect_crab_pot_output.native_entry":
    "farmhandexecutioncontroller.crabpotactions.cs:ExecuteCollectCrabPotOutput prints a `;` INSIDE the value "
    + "(`native_entry=GameLocation.checkAction;CrabPot.checkForAction`), so the receipt splits into a clause with no `=` "
    + "and the Host cannot parse it; outside this unit's approved files, and the fix is to print the entry the handler "
    + "actually invoked (`location.checkAction`, `:151`)",
});

/** The arms this unit measured, so a refactor that drops one from the population fails instead of shrinking it. */
const MUST_BE_WITNESSED: readonly string[] = Object.freeze([
  "fish_here:fish_caught",
  "express_emote:emote_started",
  "dismiss_modal:nothing_to_dismiss",
]);

test("a_success_evidence_field_carries_a_value_the_contract_can_read:<action>.<field>", (t) => {
  const { arms, rows, delegating } = declaredArms();
  const members = producerMembers();
  assert.ok(arms.length > 0, "blocked: no row declares its evidence through declaredCompletionEvidence");
  assert.ok(members.length > 0, "blocked: no producer member was found, so no value could be read");

  const counts = { fields: 0, literals: 0, expressions: 0, unreadable: 0, undeclared: 0 };
  const findings: string[] = [];
  const witnessed = new Set<string>();
  for (const member of members) {
    for (const arm of arms) {
      const values = clauses(boundLiterals(member, arm.reasonCode));
      if (values.size === 0) continue;
      const keys = [...values.keys()];
      if (!keys.some((key) => arm.keys.has(key))) continue;
      witnessed.add(`${arm.actionId}:${arm.reasonCode}`);
      const where = `${member.file}:${member.name}`;
      // A FIELD NO DECLARATION KNOWS refuses the whole receipt, so it is named here as well: this is the half that
      // counted 119 emotes as nothing (`armed=`), measured from the declarations rather than from a corpus that might
      // not carry the shape.
      for (const key of keys.filter((candidate) => !arm.keys.has(candidate))) {
        if ([...arm.keys].every((declared) => values.has(declared)) && arms.every((other) => !other.keys.has(key))) {
          counts.undeclared += 1;
          findings.push(
            `evidence_field_not_declared:${arm.actionId}:${arm.reasonCode}:${key} - the Mod prints ${key}="${values.get(key)}" (${where}) and the row does not declare it, so the receipt is refused whole`,
          );
        }
      }
      for (const key of keys.filter((candidate) => arm.keys.has(candidate))) {
        counts.fields += 1;
        const verdict = classify(values.get(key) ?? "", arm.readers.get(key) ?? new Set());
        counts[verdict] += 1;
        if (verdict === "literals") continue;
        findings.push(
          `${verdict === "expressions" ? "evidence_value_is_expression_text" : "evidence_value_not_readable"}:${arm.actionId}:${arm.reasonCode}:${key} - the Mod prints ${key}="${values.get(key)}" (${where}) and the row reads it with [${[...(arm.readers.get(key) ?? [])].join(",")}]`,
        );
      }
    }
  }

  const exempt = new Set<string>();
  const failing = findings.filter((finding) => {
    if (!finding.startsWith("evidence_value_not_readable:")) return true;
    const head = finding.split(" - ")[0] ?? "";
    const [, actionId = "", , field = ""] = head.split(":");
    const name = `${actionId}.${field}`;
    if (!Object.hasOwn(UNREADABLE_DEBT, name)) return true;
    exempt.add(name);
    return false;
  });

  console.log(
    `fields examined ${String(counts.fields)} · literals ${String(counts.literals)} · expressions ${String(counts.expressions)} · unreadable ${String(counts.unreadable)}`,
  );
  console.log(
    `rows ${String(rows)} · arms ${String(arms.length)} · witnesses ${String(witnessed.size)} · delegating rows ${String(delegating)} · undeclared fields ${String(counts.undeclared)} · exempt ${String(exempt.size)}`,
  );
  t.diagnostic(`witnessed ${[...witnessed].sort((left, right) => left.localeCompare(right)).join(", ")}`);

  assert.ok(counts.fields > 0, "blocked: no declared field was matched to a printed value, so nothing was judged");
  assert.deepEqual(
    MUST_BE_WITNESSED.filter((name) => !witnessed.has(name)),
    [],
    "the gate cannot see an arm round80 refused, so its population has silently lost the receipts this file exists for",
  );
  assert.equal(
    counts.expressions,
    0,
    "an evidence field carries a VALUE, never the source text of an expression that computed one",
  );
  assert.deepEqual(failing, [], "a value the contract's own reader cannot read is a receipt that proves nothing");
  assert.deepEqual(
    Object.keys(UNREADABLE_DEBT).filter((name) => !exempt.has(name)),
    [],
    "an exemption whose finding is gone must be deleted: it would exempt the next defect at that field",
  );
});
