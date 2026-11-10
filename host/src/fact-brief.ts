/**
 * The model-facing text of one delivery, as four named blocks of prose.
 *
 * <p>
 * WHY NOT JSON. Measured 2026-11-10 (`round44`, 109 delivered batches): the model's user message was ONE stringified
 * object - `{"kind":"gamebuddy_fact_batch", batchId, disposition, triggerEventIds, playerInputs, worldFacts, events}` -
 * averaging 11,066 characters, carrying 819,382 characters of `worldFacts` and the SAME facts again under `events`. The
 * player's day note ("找片水，钓条鱼回来") was one array element inside an 11 KB frame, and she never mentioned fishing:
 * 0 of 162 thinking parts. A JSON envelope is the wrong shape for a world report; the instruction has to be a block of
 * its own, not an element beside the facts.
 * </p>
 *
 * <p>
 * THE CLOSED SET is `FACT_BRIEF_BLOCKS`, and the Game surface's prompt floor names all four, once, at session
 * construction (`identity-profile.ts`). A block with nothing to say is omitted rather than emitted empty.
 * </p>
 *
 * <p>
 * WHICH BLOCK A FACT BELONGS IN is a property of the fact, not of the batch:
 * </p>
 *
 * <ul>
 *   <li>`<player-note>` - the player's own words, verbatim, first, never mixed with a fact;</li>
 *   <li>`<world-state>` - the snapshot as a paragraph: clock, date, weather, where, stamina, what she carries, and the
 *       nearby target families with their tiles;</li>
 *   <li>`<world-facts>` - the events: receipts, dialogue, stalls, milestones, arrivals, lifecycles;</li>
 *   <li>`<execution-result>` - what a submitted programme DID, in sentences. A settlement is deliberately NOT also a
 *       `<world-facts>` line: the two blocks would then state one outcome twice, and the aggregate is the only place a
 *       run of twenty node rows becomes a sentence.</li>
 * </ul>
 *
 * <p>
 * WHAT IS NOT HERE. `batchId`, `disposition` and `triggerEventIds` are Host bookkeeping and never enter the text; the
 * delivery frame carries them beside it (`PendingBatch`). Chinese, because the player and the card are Chinese and the
 * vocabulary for the world already is (`game-world-vocabulary.ts`).
 * </p>
 */

import type { PlayerInput, WorldFact } from "./event-pump.js";
import {
  formatGameEnvironmentFacts,
  formatGameClock,
  gameLocationName,
  nearbyTargetFamilies,
  MAX_TARGET_FAMILIES_SHOWN,
  MAX_EMPTY_FAMILIES_NAMED,
} from "./game-world-vocabulary.js";
import type { Snapshot } from "./protocol.js";

/** The closed set of block names a delivery may use. The prompt floor names exactly these. */
export const FACT_BRIEF_BLOCKS = Object.freeze([
  "player-note",
  "world-state",
  "world-facts",
  "execution-result",
] as const);

export type FactBriefBlock = (typeof FACT_BRIEF_BLOCKS)[number];

/**
 * The most fact lines `<world-facts>` names before it counts the rest.
 *
 * The pump already bounds how many facts a batch may hold (`MAX_PENDING_*`) and how large the whole delivery may be
 * (`MAX_BATCH_BYTES`), and the byte bound is what protects the context. This cap is the SECOND bound, and it exists
 * because dropping the oldest fact is right for a run and wrong for a REPORT: a batch of ninety receipts answered "what
 * just happened" with the thirty newest ones and said nothing about the sixty it left out. So the line count is
 * bounded where the sentences are composed, and the remainder is named.
 */
export const MAX_WORLD_FACT_LINES = 24;

/** One node row of a settled programme, as `program-settlement-digest.ts` publishes it. */
type SettledNode = Readonly<{
  nodeId?: string;
  actionId?: string;
  state?: string;
  reasonCode?: string;
  hint?: string;
  reasonDetail?: string;
}>;

/** What one delivered batch shows the model. The snapshot is state, everything else is news. */
export type FactBriefInput = Readonly<{
  inputs: readonly PlayerInput[];
  /** The snapshot this batch states, and how many delivered turns ago it was observed (`0` is this turn). */
  snapshot: Readonly<{ fact: WorldFact; ageTurns: number }> | undefined;
  /** The events, in the order the batch delivers them. */
  events: readonly WorldFact[];
  /** The language the player wrote in. The brief is Chinese; this is what a caller checks it against. */
  locale: string;
}>;

/**
 * The whole model-facing text of one delivery.
 *
 * Deterministic: no clock of its own, no map iteration, no field rendered twice. The text is folded into the session's
 * cached history, so two batches with the same content must render the same bytes.
 */
export function composeFactBrief(input: FactBriefInput): string {
  const blocks: string[] = [];
  const note = composePlayerNote(input.inputs);
  if (note !== "") blocks.push(note);
  const state = composeWorldState(input.snapshot);
  if (state !== "") blocks.push(state);
  const settlements = input.events.filter((fact) => fact.semanticKind === PROGRAM_SETTLED);
  const facts = input.events.filter((fact) => fact.semanticKind !== PROGRAM_SETTLED);
  const factBlock = composeWorldFacts(facts);
  if (factBlock !== "") blocks.push(factBlock);
  const resultBlock = composeExecutionResult(settlements);
  if (resultBlock !== "") blocks.push(resultBlock);
  return blocks.join("\n");
}

/** The player's own words, verbatim, one line per utterance. Empty when nobody said anything. */
function composePlayerNote(inputs: readonly PlayerInput[]): string {
  const lines = inputs.map((input) => input.text.trim()).filter((text) => text !== "");
  if (lines.length === 0) return "";
  return block("player-note", lines.join("\n"));
}

/**
 * The snapshot as one paragraph, then the nearby families.
 *
 * THE STATE PARAGRAPH is `formatGameEnvironmentFacts` - the same line the Chat surface's `<runtime-environment>` carries,
 * from the same vocabulary module, so a clock or a map is spelled one way in both places. On top of it: what she is
 * carrying, how old the reading is, and the target families.
 *
 * WHY THE TARGETS ARE HERE. Measured 2026-11-10 (`round44`): 31 of 109 turns called `stardew_observe` and a snapshot was
 * already in the batch that opened 28 of them - the state block was not missing, it was missing the objects she acts on.
 * Not one of those batches named a tile.
 */
function composeWorldState(snapshot: Readonly<{ fact: WorldFact; ageTurns: number }> | undefined): string {
  if (snapshot === undefined) return "";
  const world = snapshot.fact.payload as unknown as Snapshot & {
    readonly inventoryItemFacts?: readonly Readonly<{ name?: unknown; stack?: unknown }>[];
  };
  if (world === null || typeof world !== "object") return "";
  const parts: string[] = [];
  // The age comes FIRST and in words, because the paragraph reads as the present tense otherwise. A reading is not the
  // world: measured 2026-11-05, six consecutive turns were handed `18:00` while the model's own reasoning read "It's
  // 22:00 now" in the same turn, and the run ended `companion_did_not_sleep`.
  if (snapshot.ageTurns >= 1)
    parts.push(`（这是 ${snapshot.ageTurns} 轮之前看到的，世界已经不一样了）`);
  const environment = formatGameEnvironmentFacts(world, true);
  if (environment !== "") parts.push(environment);
  const carrying = formatCarrying(world);
  if (carrying !== "") parts.push(carrying);
  const paragraph = parts.join("；");
  const lines: string[] = [];
  if (paragraph !== "") lines.push(paragraph);
  lines.push(...composeNearbyTargets(world));
  return lines.length === 0 ? "" : block("world-state", lines.join("\n"));
}

/** How many item rows the pack names before it counts the rest. */
export const MAX_CARRYING_ROWS = 8;

/**
 * What she is carrying that is not a tool.
 *
 * `inventoryItemFacts` is the Mod's own bounded inventory publication (36 rows: slot, id, name, stack); the tools are
 * already named by the state line's `手持`, so this prints only their stacks. ABSENT means the Mod did not publish the
 * family at all - the field is gated on the actions that read the inventory - and stays silent, which is a different
 * statement from `身上没有东西`.
 */
function formatCarrying(world: Snapshot & { readonly inventoryItemFacts?: readonly Readonly<{ name?: unknown; stack?: unknown }>[] }): string {
  const rows = world.inventoryItemFacts;
  if (!Array.isArray(rows)) return "";
  const named = rows
    .filter((row) => typeof row?.name === "string" && String(row.name).trim() !== "")
    .map((row) => ({ name: String(row.name).trim(), stack: Number.isFinite(row.stack) ? Number(row.stack) : 1 }));
  if (named.length === 0) return "身上没有别的东西";
  const shown = named.slice(0, MAX_CARRYING_ROWS).map((row) => `${row.stack} 份 ${row.name}`);
  const rest = named.length - shown.length;
  return `身上带着 ${shown.join("、")}${rest > 0 ? ` 其余 ${rest} 种未列出` : ""}`;
}

/**
 * The nearby target families: the non-empty ones first, nearest first, then one line for the families the snapshot
 * published as empty.
 *
 * A family the snapshot does not carry is not printed at all, and a family it carries as `[]` is - `nearbyTargetFamilies`
 * owns that distinction and says why. Both caps live here, in the composition, so the consumer is never the thing that
 * decides how much of the world fits.
 */
function composeNearbyTargets(world: Snapshot): readonly string[] {
  const families = nearbyTargetFamilies(world);
  const occupied = families
    .filter((family) => family.rendered !== undefined)
    .sort(
      (left, right) =>
        (left.nearest?.distance ?? Number.MAX_SAFE_INTEGER) - (right.nearest?.distance ?? Number.MAX_SAFE_INTEGER) ||
        left.family.localeCompare(right.family),
    );
  const lines: string[] = [];
  for (const family of occupied.slice(0, MAX_TARGET_FAMILIES_SHOWN))
    if (family.rendered !== undefined) lines.push(family.rendered);
  const restFamilies = occupied.length - Math.min(occupied.length, MAX_TARGET_FAMILIES_SHOWN);
  if (restFamilies > 0) lines.push(`其余 ${restFamilies} 类未列出`);
  const empty = families.filter((family) => family.total === 0).map((family) => family.label);
  if (empty.length > 0) {
    const named = empty.slice(0, MAX_EMPTY_FAMILIES_NAMED);
    const more = empty.length - named.length;
    lines.push(`这一带没有：${named.join("、")}${more > 0 ? ` 等 ${empty.length} 类` : ""}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------
// The events.
// ---------------------------------------------------------------------------------------------------------------

/**
 * The receipt states, said in words.
 *
 * The Mod's token is the authority and it is printed beside the words, not replaced by them: a run audit greps for
 * `rejected`, and a sentence that only said 没做成 would be a second vocabulary for the same fact.
 */
const RECEIPT_STATE_ZH: Readonly<Record<string, string>> = Object.freeze({
  accepted: "已接下",
  running: "正在进行",
  meaningful_progress: "有进展",
  blocked: "卡住了",
  succeeded: "做成了",
  rejected: "没做成",
  failed: "失败了",
  cancelled: "取消了",
  uncertain: "结果不明",
});

/** The Mod's own semantic-event kinds, said in words. A kind not named here is printed verbatim rather than dropped. */
const SEMANTIC_KIND_ZH: Readonly<Record<string, string>> = Object.freeze({
  execution_started: "开始动手",
  execution_settled_succeeded: "这一步成了",
  execution_settled_failed: "这一步没成",
  route_progress: "在路上",
  body_idle: "身体空下来了",
  snapshot_changed: "眼前变了",
});

/** The Host's and the Mod's world-fact kinds, said in words. */
const WORLD_FACT_KIND_ZH: Readonly<Record<string, string>> = Object.freeze({
  day_started: "新的一天",
  time_milestone: "又过了一个时辰",
  npc_dialogue_presented: "有人跟你说话",
  execution_stalled: "有个动作卡住不动了",
  companion_arrival: "她到了",
  native_notice: "游戏里冒出个提示",
  night_ended_pass_out: "夜里没撑住，昏过去了",
});

const PROGRAM_SETTLED = "program_settled";

/** `<world-facts>`: one line per event, the oldest first, the remainder counted. */
function composeWorldFacts(events: readonly WorldFact[]): string {
  const lines = events.map(factLine).filter((line): line is string => line !== "");
  if (lines.length === 0) return "";
  const shown = lines.slice(0, MAX_WORLD_FACT_LINES);
  const rest = lines.length - shown.length;
  if (rest > 0) shown.push(`其余 ${rest} 条未列出`);
  return block("world-facts", shown.join("\n"));
}

function factLine(fact: WorldFact): string {
  const at = clockOf(fact);
  switch (fact.kind) {
    case "snapshot":
      // The snapshot is the state block, not news; printing it twice is the duplication this whole change removes.
      return "";
    case "execution_receipt":
      return receiptLine(fact, at);
    case "semantic_event": {
      const kind = typeof fact.payload.kind === "string" ? fact.payload.kind : "semantic_event";
      const words = SEMANTIC_KIND_ZH[kind] ?? kind;
      const reason = typeof fact.payload.reasonCode === "string" ? `（${fact.payload.reasonCode}）` : "";
      return `- ${at}${words}${reason}`;
    }
    case "lifecycle": {
      const state = typeof fact.payload.state === "string" ? fact.payload.state : "lifecycle";
      const reason = typeof fact.payload.reasonCode === "string" ? `：${fact.payload.reasonCode}` : "";
      return `- ${at}${state}${reason}`;
    }
    case "world_fact":
      return worldFactLine(fact, at);
  }
}

/**
 * One action receipt.
 *
 * A refusal prints the Mod's own `reasonCode` and, when it published one, its `evidence.detail` - the refusal text the
 * Mod already produces, reused rather than rephrased here. "够不到 (74,22)，那块地不可耕" is the shape this line is for:
 * the code names the rule, the detail names the tile, and neither is invented by the Host.
 */
function receiptLine(fact: WorldFact, at: string): string {
  const action = typeof fact.payload.actionId === "string" ? fact.payload.actionId : "动作";
  const state = typeof fact.payload.state === "string" ? fact.payload.state : "";
  const words = RECEIPT_STATE_ZH[state] ?? state;
  const reason = typeof fact.payload.reasonCode === "string" ? `：${fact.payload.reasonCode}` : "";
  const detail = evidenceDetail(fact.payload);
  return `- ${at}${action} ${words}${reason}${detail === "" ? "" : `（${detail}）`}`;
}

/** The Mod's own evidence detail for a refusal, bounded; never a Host paraphrase of it. */
function evidenceDetail(payload: Readonly<Record<string, unknown>>): string {
  const evidence = payload.evidence;
  if (evidence === null || typeof evidence !== "object") return "";
  const detail = (evidence as { detail?: unknown }).detail;
  if (typeof detail !== "string") return "";
  return detail.length > MAX_EVIDENCE_DETAIL_CHARS ? `${detail.slice(0, MAX_EVIDENCE_DETAIL_CHARS)}…` : detail;
}

/** One evidence string's share of a line. Measured: a warp refusal writes ~130 characters of tile and door facts. */
export const MAX_EVIDENCE_DETAIL_CHARS = 160;

function worldFactLine(fact: WorldFact, at: string): string {
  const kind = fact.semanticKind ?? "";
  switch (kind) {
    case "day_started": {
      const day = fact.payload.day;
      return `- ${at}新的一天${typeof day === "number" ? `：第 ${day} 天` : ""}`;
    }
    case "time_milestone": {
      const milestone = fact.payload.milestone;
      return `- ${at}又过了一个时辰${typeof milestone === "string" || typeof milestone === "number" ? `：${milestone}` : ""}`;
    }
    case "npc_dialogue_presented": {
      const speaker = typeof fact.payload.speaker === "string" ? fact.payload.speaker : "有人";
      const pages = Array.isArray(fact.payload.pages)
        ? fact.payload.pages.filter((page): page is string => typeof page === "string")
        : [];
      const choices = Array.isArray(fact.payload.choices)
        ? fact.payload.choices
            .map((choice) =>
              typeof choice === "object" && choice !== null && typeof (choice as { text?: unknown }).text === "string"
                ? String((choice as { text: string }).text)
                : undefined,
            )
            .filter((text): text is string => text !== undefined)
        : [];
      return `- ${at}${speaker}说：「${pages.join(" ")}」${choices.length === 0 ? "" : `（可以答：${choices.join(" / ")}）`}`;
    }
    case "execution_stalled": {
      const action = typeof fact.payload.actionId === "string" ? fact.payload.actionId : "动作";
      const elapsed = Number(fact.payload.elapsedMs);
      const seconds = Number.isFinite(elapsed) ? Math.round(elapsed / 1000) : undefined;
      return `- ${at}${action} 卡住了${seconds === undefined ? "" : ` ${seconds} 秒`}`;
    }
    default: {
      const words = WORLD_FACT_KIND_ZH[kind] ?? kind ?? "世界消息";
      return `- ${at}${words}`;
    }
  }
}

/** `<execution-result>`: what a submitted programme did, in sentences, one per settlement. */
function composeExecutionResult(settlements: readonly WorldFact[]): string {
  const lines = settlements.map(settlementLine).filter((line) => line !== "");
  return lines.length === 0 ? "" : block("execution-result", lines.join("\n"));
}

/**
 * One settled programme.
 *
 * The counts and the rows come from `program-settlement-digest.ts`'s own payload (`total`, `counts`, `nodes`), so this
 * sentence and a `stardew_action_program_status` answer cannot disagree. A failure is said in WORDS: the node's own
 * `hint` when the Mod published one, else its `reasonCode` - never a Host paraphrase, and never a bare count.
 */
function settlementLine(fact: WorldFact): string {
  const total = Number(fact.payload.total);
  const counts = fact.payload.counts;
  const done =
    counts !== null && typeof counts === "object" ? Number((counts as Record<string, unknown>).succeeded ?? 0) : 0;
  const head = Number.isFinite(total) ? `${done}/${total} 步做成了` : "计划收尾了";
  const nodes = Array.isArray(fact.payload.nodes) ? (fact.payload.nodes as readonly SettledNode[]) : [];
  const failures = nodes
    .filter((node) => typeof node.state === "string" && node.state !== "succeeded")
    .map((node) => failureWords(node))
    .filter((words): words is string => words !== "");
  const omitted = Number(fact.payload.omitted);
  const more = Number.isFinite(omitted) && omitted > 0 ? `（另有 ${omitted} 步未列出）` : "";
  return `- ${head}${more}${failures.length === 0 ? "" : `：${failures.join("；")}`}`;
}

/** One failed node in words: the Mod's own hint first, because that is the sentence that says what would fix it. */
function failureWords(node: SettledNode): string {
  const action = typeof node.actionId === "string" ? node.actionId : "一步";
  const hint = typeof node.hint === "string" && node.hint.trim() !== "" ? node.hint.trim() : undefined;
  const detail =
    typeof node.reasonDetail === "string" && node.reasonDetail.trim() !== "" ? node.reasonDetail.trim() : undefined;
  const code = typeof node.reasonCode === "string" && node.reasonCode !== "" ? node.reasonCode : undefined;
  const reason = hint ?? detail ?? code;
  return reason === undefined ? `${action} 没做成` : `${action} 没做成（${reason}）`;
}

/**
 * The game clock a fact happened at, as `HH:MM ` - or nothing at all.
 *
 * `gameTime` is published on some world facts and not on others, and a receipt carries no game clock at all. An absent
 * clock prints as an empty prefix rather than as a Host wall-clock guess: the Host does not know what hour it is in the
 * game (`snapshot-hud.ts#aged` carries the same measurement), and `08:12` invented from `Date.now()` would be a fact.
 */
function clockOf(fact: WorldFact): string {
  if (typeof fact.gameTime !== "string") return "";
  const parsed = Number(fact.gameTime);
  if (!Number.isFinite(parsed)) return "";
  const clock = formatGameClock(parsed, true);
  return clock === "" ? "" : `${clock.replace(/（.*$/, "")} `;
}

/** One block, closed by its own name. */
function block(name: FactBriefBlock, body: string): string {
  return `<${name}>\n${body}\n</${name}>`;
}

/** The location a fact happened in, for a caller that wants to name it in a diagnostic. */
export function factLocationName(fact: WorldFact, zh: boolean): string {
  return gameLocationName(typeof fact.payload.location === "string" ? fact.payload.location : undefined, zh);
}
