import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { WorldFact } from "./event-pump.js";
import { composeFactBrief, MACHINE_FIELD_HEADS, type WorldStateReading } from "./fact-brief.js";
import type { Snapshot } from "./protocol.js";

/**
 * A LINE THE MODEL READS IS NOT A MACHINE TOKEN.
 *
 * <p>
 * `round78`'s own delivery, quoted from the live prompt text: `5 份 防风草种子 (O)472 [槽 2]`, `（plant_seed 之后数的）`,
 * `（买种子的钱: 未观察 affordability_unknown）`, `world_state_stale:5;352;900000`, and raw `reasonCode`s under
 * `<execution-result>`. Every one of them is the machine's spelling welded into a Chinese sentence, and the input IS the
 * teacher: the Game floor used to say "do not read enum values and resource ids aloud" and that paragraph was deleted as a
 * second spelling of a rule this input can keep by itself. What the input printed in its place was an example of the
 * defect.
 * </p>
 *
 * <p>
 * THE POPULATION IS DERIVED, NOT LISTED. The field names come from the wire's own document (`$defs`, walked, so a family
 * that publishes a new `*ItemId` is measured without an edit here) and the tokens come from the delivery itself - the
 * snapshot and the facts the composer is handed. `MACHINE_FIELD_HEADS` is the composer's own declaration of the fields it
 * fills with addresses rather than sentences, so this gate reads the renderer instead of retyping which lines to skip. A
 * `k=v` run is the Mod's evidence, printed verbatim by design (`receiptLine`, `proofTail`, `failureWords`), so it is
 * stripped rather than judged.
 * </p>
 *
 * <p>
 * WHAT IS DEFERRED AND PRINTED RATHER THAN FAILED: nothing, since 2026-11-19. A raw `reasonCode` (`gift_given`, `not_home`,
 * `no_native_path`, and `affordability_unknown` until this lane removed it) used to be counted on every run because turning
 * it into a sentence was authoring and a later unit. That unit landed: `stardew-action-remedy.ts` is the one table that
 * answers "what can she do about this code", `fact-brief.ts` renders the state in Chinese and appends that instruction, and
 * the code and its evidence print verbatim under `ADDRESSABLE_FACTS_HEAD`. So the code is now a machine token in the
 * ADDRESS position rather than in a sentence, and this gate skips address fields by reading `MACHINE_FIELD_HEADS` - the
 * composer's own declaration - instead of needing a new special case.
 * </p>
 */

const hostRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SCHEMA_PATH = resolve(hostRoot, "../protocol/bridge-v1.schema.json");

/** A property the wire publishes as a handle an argument copies: `qualifiedItemId`, `targetId`, `slot`. */
const HANDLE_FIELD = /(?:ItemId|Id|slot)$/u;

/** A property whose value is one member of a declared union: `state`, `kind`, `status`. */
const UNION_FIELD = /^(?:state|kind|status|semanticKind)$/u;

/** A property whose value is the Mod's word for a refusal or a gap. Deferred, counted, never failed. */
const CODE_FIELD = /(?:reasonCode|code)$/u;

/** The Mod's own qualification of an item id: `(O)472`, `(BC)130`, `(W)47`. */
const QUALIFIED_ITEM_ID = /\([A-Z]{1,3}\)[A-Za-z0-9_]+/u;

/** The slot marker this file used to weld into the pack sentence: `[槽 2]`. */
const SLOT_MARKER = /槽\s*\d/u;

/** A `key=value` run: the Mod's evidence detail, which is printed verbatim on purpose. */
const MACHINE_RUN = /（[^（）]*=[^（）]*）/gu;

/** The names the wire declares for each class, read from the schema document at the root of this repository. */
function wireFieldNames(pattern: RegExp): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry);
      return;
    }
    const record = node as Record<string, unknown>;
    const properties = record.properties;
    if (properties !== null && typeof properties === "object" && !Array.isArray(properties))
      for (const name of Object.keys(properties as Record<string, unknown>))
        if (pattern.test(name)) names.add(name);
    for (const entry of Object.values(record)) visit(entry);
  };
  visit(JSON.parse(readFileSync(SCHEMA_PATH, "utf8")) as unknown);
  return names;
}

/** One machine token a delivery handed the composer, and the field it came from. */
type MachineToken = Readonly<{ field: string; token: string; kind: "handle" | "union" | "code" }>;

/**
 * Every machine token in one delivery, taken from the two things the composer is given: the snapshot and the facts.
 *
 * The field names are the wire's (`wireFieldNames`), so a family that grows an id is measured; the values are this
 * delivery's own, so nothing here is a vocabulary somebody typed.
 */
function machineTokens(reading: WorldStateReading, events: readonly WorldFact[]): readonly MachineToken[] {
  const handles = wireFieldNames(HANDLE_FIELD);
  const unions = wireFieldNames(UNION_FIELD);
  const codes = wireFieldNames(CODE_FIELD);
  const found: MachineToken[] = [];
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    for (const [field, entry] of Object.entries(value as Record<string, unknown>)) {
      const scalar = typeof entry === "string" || typeof entry === "number";
      if (scalar && field === "slot") found.push({ field, token: String(entry), kind: "handle" });
      else if (scalar && typeof entry === "string" && handles.has(field))
        found.push({ field, token: entry, kind: "handle" });
      else if (scalar && typeof entry === "string" && unions.has(field))
        found.push({ field, token: entry, kind: "union" });
      else if (scalar && typeof entry === "string" && codes.has(field))
        found.push({ field, token: entry, kind: "code" });
      walk(entry);
    }
  };
  walk(reading.snapshot);
  for (const fact of events) walk(fact.payload);
  return found;
}

/** The lines a reader hears: block tags out, the composer's own machine fields out, the Mod's `k=v` runs out. */
function narrationLines(text: string): readonly string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !/^<\/?[a-z-]+>$/u.test(line))
    .filter((line) => !MACHINE_FIELD_HEADS.some((head) => line.startsWith(head)))
    .map((line) => line.replace(MACHINE_RUN, ""))
    .filter((line) => line !== "");
}

const world: Snapshot = {
  revision: 108,
  location: "Mine",
  tile: { x: 64, y: 15 },
  stamina: 82,
  health: 100,
  actionable: true,
  capabilities: [],
  catalogRevision: 3,
  enabledActionIds: [],
  presentationLocale: "zh-CN",
  exhausted: false,
  timeOfDay: 620,
  dayOfMonth: 3,
  seasonIndex: 0,
  year: 1,
  weather: "rain",
  currentTool: "(T)Hoe",
  currentToolSlot: 0,
  toolSlots: [{ slot: 0, label: "(T)Hoe", category: "hoe", upgradeLevel: 2 }],
  inventoryItemFacts: [{ slot: 2, qualifiedItemId: "(O)472", displayName: "防风草种子", stack: 5 }],
} as unknown as Snapshot;

function fact(overrides: Partial<WorldFact> & Pick<WorldFact, "kind">): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    correlationId: overrides.kind,
    revision: 108,
    payload: {},
    ...overrides,
  }) as WorldFact;
}

/** `round78`'s refusal: the Mod's own code and evidence, on a receipt whose action the line also names. */
function refusedReceipt(): WorldFact {
  return fact({
    kind: "execution_receipt",
    eventId: "receipt_gift",
    payload: {
      actionId: "pickup_item",
      state: "rejected",
      reasonCode: "gift_given",
      evidence: { detail: "location=Farm;item=(O)472;inventory_after=5" },
    } as never,
  });
}

function reading(snapshot: Snapshot = world): WorldStateReading {
  return { snapshot, revision: 108, ageTurns: 0, ageMs: 0, contentAgeMs: 0 };
}

function measure(text: string, tokens: readonly MachineToken[]): { prose: number; leaks: readonly string[] } {
  const lines = narrationLines(text);
  const leaks: string[] = [];
  for (const line of lines) {
    for (const { field, token, kind } of tokens) {
      if (kind === "code") continue;
      // A NUMBER IS NOT A TOKEN: a slot is a small integer and the block is full of numbers (`06:20`, `1年第3天`). What
      // the gate refuses about a slot is its MARKER inside a sentence, checked below.
      if (field === "slot") continue;
      if (kind === "handle" && QUALIFIED_ITEM_ID.test(token) && line.includes(token))
        leaks.push(`${field}:${token} in \`${line}\``);
      else if (kind === "union" && new RegExp(`(?:^|[^A-Za-z0-9_])${token}(?:$|[^A-Za-z0-9_])`, "u").test(line))
        leaks.push(`${field}:${token} in \`${line}\``);
      // AN ACTION ID IN PARENTHESES is the provenance claim's machine spelling: `（plant_seed 之后数的）`.
      else if (field === "actionId" && new RegExp(`[（(][^（）()]*${token}[^（）()]*[）)]`, "u").test(line))
        leaks.push(`${field}:${token} in \`${line}\``);
    }
    if (SLOT_MARKER.test(line)) leaks.push(`slot:槽 in \`${line}\``);
  }
  return { prose: lines.length, leaks };
}

test("a_line_the_model_reads_is_not_a_machine_token: the two blocks state the world in sentences", () => {
  const events = [refusedReceipt()];
  const state = reading();
  const tokens = machineTokens(state, events);
  const text = composeFactBrief({ inputs: [], snapshot: state, events, locale: "zh-CN" });
  const { prose, leaks } = measure(text, tokens);
  const deferred = tokens.filter((entry) => entry.kind === "code");
  const fields = new Set(tokens.map((entry) => entry.field));

  assert.ok(fields.size > 0, "the wire published no machine-valued field this delivery carries, so nothing was measured");
  assert.ok(prose > 0, "the delivery rendered no narration line at all, so nothing was measured");
  process.stdout.write(
    `fields examined ${String(fields.size)} · prose ${String(prose)} · machine-in-prose ${String(leaks.length)}` +
      ` · reason codes deferred ${String(new Set(deferred.map((entry) => entry.token)).size)}` +
      ` (${[...new Set(deferred.map((entry) => entry.token))].join(", ")})` +
      `\n--- the delivery ---\n${text}\n`,
  );
  assert.deepEqual(leaks, [], `a narration line carries a machine token:\n${leaks.join("\n")}\n---\n${text}`);
});

/**
 * THE FALSIFIER: `round78`'s own lines, replayed.
 *
 * Each line this lane changed is fed in its live shape and read back. The claim is not "the token is gone" - a token
 * deleted from a report is a fact deleted - but "the sentence says it in words and the machine's spelling is still in the
 * block, in the field that says it is an address".
 */
test("round78_replay: the pack sentence is prose and the address is a field in the same block", () => {
  const state = reading();
  const text = composeFactBrief({ inputs: [], snapshot: state, events: [], locale: "zh-CN" });
  const [sentence = ""] = narrationLines(text).filter((line) => line.includes("身上带着"));

  assert.match(sentence, /身上带着 5 份 防风草种子/u, `the count and the name are the sentence: ${sentence}`);
  assert.equal(sentence.includes("(O)472"), false, `the qualified id is not in the sentence: ${sentence}`);
  assert.equal(/\[槽/u.test(sentence), false, `and no slot marker either: ${sentence}`);

  const address = text.split("\n").filter((line) => MACHINE_FIELD_HEADS.some((head) => line.startsWith(head)));
  assert.equal(address.length, 1, `exactly one address field carries the rows: ${text}`);
  assert.match(String(address[0]), /防风草种子 槽 2 \(O\)472/u, `and it carries the pair an argument takes: ${String(address[0])}`);
});

test("round78_replay: the provenance claim is Chinese and names no action id", () => {
  const snapshot = {
    ...world,
    inventoryItemFacts: [{ slot: 2, qualifiedItemId: "(O)472", displayName: "防风草种子", stack: 4 }],
  } as unknown as Snapshot;
  const recounted = fact({
    kind: "execution_receipt",
    eventId: "receipt_plant",
    payload: {
      actionId: "plant_seed",
      state: "succeeded",
      evidence: { detail: "location=Farm;item=(O)472;inventory_after=4" },
    } as never,
  });
  const text = composeFactBrief({
    inputs: [],
    snapshot: { snapshot, revision: 108, ageTurns: 0, ageMs: 0, contentAgeMs: 0 },
    events: [recounted],
    locale: "zh-CN",
  });
  const [sentence = ""] = narrationLines(text).filter((line) => line.includes("身上带着"));

  assert.match(sentence, /（刚做完那一步之后数的）/u, `the provenance stays a claim: ${sentence}`);
  assert.equal(sentence.includes("plant_seed"), false, `and it names no action id: ${sentence}`);
  // The receipt that made the claim true is in the same delivery, with its own action id: the fact is not lost, it moved.
  assert.match(text, /plant_seed/u, `the receipt still names the action: ${text}`);
});

test("round78_replay: the affordability gap is a sentence, and the seed line carries no code", () => {
  const snapshot = {
    ...world,
    inventoryItemFacts: [],
    seedSupplyTargets: [{ qualifiedItemId: "(O)472", displayName: "防风草种子", heldCount: 3 }],
  } as unknown as Snapshot;
  const text = composeFactBrief({
    inputs: [],
    snapshot: { snapshot, revision: 108, ageTurns: 0, ageMs: 0, contentAgeMs: 0 },
    events: [],
    locale: "zh-CN",
  });
  assert.match(text, /买种子的钱: 未观察/u, `the gap is named in words: ${text}`);
  assert.equal(text.includes("affordability_unknown"), false, `and not by a token: ${text}`);
});

/**
 * THE DEFERRED HALF, PAID AND MEASURED - it was deferred until 2026-11-19.
 *
 * A raw `reasonCode` (`gift_given`, `not_home`, `no_native_path`) is the Mod's word for a fact, and this gate used to count
 * how many still reached her instead of failing on them. The renderers paid that debt: a refusal reads as `<action> 没做成`
 * plus the instruction `stardew-action-remedy.ts` composes for the code, and the code itself prints verbatim on the block's
 * address line (`ADDRESSABLE_FACTS_HEAD`). So the claim is now in both directions, and the second one is the point: the code
 * must NOT be in the prose (it was the thing she was being told to translate) and must STILL be in the delivery (a run audit
 * greps it, and the next tool argument may copy the ids beside it).
 */
test("reason_codes_no_longer_reach_her_as_tokens, and stay addressable in the delivery", () => {
  const events = [refusedReceipt()];
  const state = reading();
  const text = composeFactBrief({ inputs: [], snapshot: state, events, locale: "zh-CN" });
  const codes = new Set(machineTokens(state, events).filter((entry) => entry.kind === "code").map((e) => e.token));
  const reaching = [...codes].filter((code) => narrationLines(text).some((line) => line.includes(code)));
  const addresses = text
    .split("\n")
    .filter((line) => MACHINE_FIELD_HEADS.some((head) => line.startsWith(head)))
    .join("\n");

  assert.ok(codes.size > 0, "the delivery carried no reason code, so the deferred count would be a zero it did not measure");
  assert.deepEqual(reaching, [], `no refusal code may stay in the prose she reads: ${reaching.join(", ")}`);
  for (const code of codes)
    assert.ok(
      addresses.includes(`reasonCode=${code}`),
      `the code left the sentence and must be on the address line - an id a reader cannot reach is a step they cannot take:\n${text}`,
    );
  // AND THE VALUES A TOOL ARGUMENT COPIES ARE THERE, verbatim: `open_geode` refuses a request without the slot and the
  // qualified id, and both are in the detail the Mod published.
  assert.match(addresses, /location=Farm;item=\(O\)472;inventory_after=5/u, `the detail is verbatim: ${addresses}`);
  // The sentence is not empty in its place: the block says what the step did, in the words the state table owns.
  assert.match(text, /pickup_item 没做成/u, `the state is a sentence: ${text}`);
});

/**
 * THE OTHER BLOCK, ON THE SAME PATTERN: a settled programme's failed node reads as a sentence + a remedy, and its code and
 * detail print on the block's own address line.
 */
test("a settled failure reads as a sentence, and its code and detail stay addressable", () => {
  const settlement = fact({
    kind: "execution_settled",
    semanticKind: "program_settled",
    gameTime: "620",
    payload: {
      total: 2,
      counts: { succeeded: 1, failed: 1 },
      omitted: 0,
      nodes: [
        { nodeId: "n01", actionId: "move_to_tile", state: "failed", reasonCode: "no_native_path", reasonDetail: "closest=34,6;closest_distance=6" },
      ],
    },
  } as never);
  const state = reading();
  const text = composeFactBrief({ inputs: [], snapshot: state, events: [settlement], locale: "zh-CN" });
  const prose = narrationLines(text);
  const addresses = text.split("\n").filter((line) => MACHINE_FIELD_HEADS.some((head) => line.startsWith(head)));

  assert.ok(
    prose.some((line) => line.includes("move_to_tile 没做成")),
    `the step is a sentence: ${text}`,
  );
  assert.equal(
    prose.some((line) => line.includes("no_native_path")),
    false,
    `and the code is not in the prose: ${text}`,
  );
  assert.ok(
    addresses.some((line) => line.includes("n01 reasonCode=no_native_path；closest=34,6;closest_distance=6")),
    `the node's address names which node, which code, and the Mod's own detail verbatim: ${text}`,
  );
});
