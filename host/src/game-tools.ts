import { randomUUID } from "node:crypto";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, type TObject, type TSchema, Type } from "typebox";
import {
  type ActionPolicy,
  getArgumentEnum,
  getDescriptorArgument,
  isModDescriptorComplete,
  STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS,
  STARDEW_ACTION_TOOL_NAMES,
  type StardewActionId,
  type StardewDescriptorDerivedActionId,
  TILE_TARGET_ARGUMENTS,
  searchActionsFromModCatalog,
  visibleActionsFromModCatalog,
} from "./action-registry.js";
import type { IntegrationDispatchAdmission } from "./game-integration-adapter.js";
import { type ExpressionTurnGate, expressionResultEndsTurn } from "./expression-turn-gate.js";
import { composeWorldState, unchangedWorldAnswer } from "./fact-brief.js";
import { MODEL_STOP_REASON_CODE } from "./event-pump.js";
import {
  LOOKUP_SUBJECTS,
  type AffordanceAction,
  dataQueryUnavailable,
  dataTable,
  journalUnavailable,
  lookUp,
  myWorkFromJournal,
  noSnapshot,
} from "./game-lookup.js";
import { describeBodyHoldRefusal } from "./stardew-action-remedy.js";
import { isOpaqueId, isTileCoordinate, isToolSlot } from "./protocol-target-facts.js";
import {
  type ObservationSelection,
  type SelectionAnswer,
  type SelectionAxis,
  type SelectionPredicate,
  type SelectionRectangle,
  MAX_TARGET_TILES_SHOWN,
  OBSERVATION_ENUMERATED_TILE_LIMIT,
  OBSERVATION_SELECTION_RANGE_LIMIT,
  OBSERVATION_SELECTION_ROWS_LIMIT_MAX,
  OBSERVATION_SELECTION_TILE_LIMIT,
  TARGET_FAMILY_LABELS,
  axisTileCount,
  selectObservedRows,
  selectTileAreaRows,
  selectionDisagreements,
  selectionGateReport,
  selectionRectangle,
  tileSelectionDisagreements,
  withoutRowFamilies,
} from "./game-world-vocabulary.js";
import { type ObservationBudget, boundObservedSnapshot } from "./stardew-observation-budget.js";
import type { StardewBridgeConnection } from "./game-connection.js";
import { RUN_SPAN_NAMES, type RunTrace, describeTraceFailure } from "./run-trace.js";
import {
  type ActionRegistrationDescriptor,
  type BodyProgramStatusResult,
  type DataQueryRequest,
  type DataQueryResult,
  type ExecutionReceipt,
  type ExecutionRequest,
  type Snapshot,
  TOOL_SELECTOR_VALUES,
  type TileAreaRequest,
  type TileAreaResult,
  executionRequestIntegerBounds,
  isValidObserveSceneResult,
  validateExecutionRequest,
} from "./protocol.js";

type IntegrationDispatchAdmissionFactory = () => IntegrationDispatchAdmission;

/** The wait budget for an action that publishes none of its own, matching the historical hard-coded value. */
const DEFAULT_DISPATCH_DEADLINE_MS = 30_000;
/**
 * The ceiling a Mod-published watchdog is clamped to. It matches the bridge's own maximum request timeout, so a
 * Mod cannot hand the Host a wait the transport would refuse anyway.
 */
const MAX_DISPATCH_DEADLINE_MS = 600_000;

/** A bridge that executes only Mod-declared player-enabled capabilities. */
export interface MoveCapableIntegration extends StardewBridgeConnection {
  execute(request: ExecutionRequest): Promise<ExecutionReceipt>;
  cancel(requestId: string, executionId: string, reasonCode: string): Promise<ExecutionReceipt>;
}
function isMoveCapable(value: StardewBridgeConnection): value is MoveCapableIntegration {
  return (
    "execute" in value &&
    typeof (value as { execute?: unknown }).execute === "function" &&
    "cancel" in value &&
    typeof (value as { cancel?: unknown }).cancel === "function"
  );
}

/** One published primitive action bound to its preserved concrete typed tool schema. */
type GameActionToolDefinition<TSchema extends TObject> = Readonly<{
  name: string;
  label: string;
  description: string;
  parameters: TSchema;
  action: StardewActionId;
  toArgs: (params: any) => Readonly<Record<string, unknown>>;
}>;

/**
 * Shared typed wrapper factory (Wave 1 lane A). Every materialized action tool
 * closure contributes only its action literal plus typed args; the shared
 * wrapper constructs request IDs, binds the current snapshot revision, sets the
 * deadline, rechecks connection/current capability/current restrictive policy,
 * validates the request, and acquires a fresh dispatch admission immediately
 * before the bridge write. The factory is module-private: there is no generic
 * public action/payload API.
 */
function gameActionToolFactory(
  integration: MoveCapableIntegration,
  policy: ActionPolicy | undefined,
  dispatchAdmissionFactory: IntegrationDispatchAdmissionFactory,
  trace: RunTrace | undefined,
  expressionTurnGate: ExpressionTurnGate | undefined,
) {
  return function createGameActionTool<TSchema extends TObject>(
    definition: GameActionToolDefinition<TSchema>,
  ): ReturnType<typeof defineTool> {
    return defineTool({
      name: definition.name,
      label: definition.label,
      description: definition.description,
      parameters: definition.parameters,
      execute: async (_toolCallId, params) => {
        const result = await executeGameAction(
          integration,
          policy,
          dispatchAdmissionFactory,
          definition.action,
          definition.toArgs(params as Static<TSchema>),
          callerRequestIds(params),
          trace,
        );
        // THE ONE HINT A TOOL MAY GIVE THE AGENT LOOP: stop after this batch. It rides an expression action on a turn the
        // world opened, and only on a receipt - a refusal is news she has to be able to read, so it leaves the turn
        // running rather than ending it on a sentence she never saw (`expression-turn-gate.ts`). Every other tool result
        // leaves the hint unset, which is why a batch of `emote + cut_weeds` cannot end the turn: Pi needs EVERY result in
        // the batch to carry it.
        return expressionResultEndsTurn(definition.action, expressionTurnGate) && result.details.receiptJson !== null
          ? { ...result, terminate: true }
          : result;
      },
    });
  };
}

/** Caller-supplied identity fields read from the preserved concrete tool schema. */
function callerRequestIds(params: unknown): Readonly<{ requestId?: string; idempotencyKey?: string }> {
  if (typeof params !== "object" || params === null) return {};
  const record = params as Readonly<Record<string, unknown>>;
  const requestId = typeof record.requestId === "string" && record.requestId.length > 0 ? record.requestId : undefined;
  const idempotencyKey =
    typeof record.idempotencyKey === "string" && record.idempotencyKey.length > 0 ? record.idempotencyKey : undefined;
  return Object.freeze({
    ...(requestId === undefined ? {} : { requestId }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  });
}

type NavigationActionId = "inspect_world_map" | "find_destination";
/**
 * The Mod's Body Program journal, read through the bridge.
 *
 * Narrow on purpose, and duck-typed the way `navigationRead` is: `stardew_look_up` is a read-only question, and the only
 * thing it needs from the journal is one bounded page of it.
 */
type ProgramJournalReadIntegration = {
  programStatus(request: Readonly<{ programId?: string }>): Promise<BodyProgramStatusResult>;
};
type NavigationReadIntegration = StardewBridgeConnection & {
  navigationRead(
    request: Readonly<{
      operation: NavigationActionId;
      args: Readonly<Record<string, unknown>>;
    }>,
  ): Promise<unknown>;
};

/**
 * The game's own content tables, read through the bridge.
 *
 * Duck-typed for the same reason the journal reader is: a content-table question is read-only and needs exactly one
 * method, so a session that cannot answer it says so by not having one.
 */
type DataQueryReadIntegration = {
  dataQuery(request: DataQueryRequest): Promise<DataQueryResult>;
};

/**
 * One rectangle of the live world, read through the bridge.
 *
 * Duck-typed for the same reason the content-table reader is: a rectangle question is read-only and needs exactly one
 * method, so a session that cannot answer it says so by not having one.
 */
type TileAreaReadIntegration = {
  tileArea(request: TileAreaRequest): Promise<TileAreaResult>;
};

/**
 * One rectangle read's outcome: the Mod's answer, or the refusal the model is given instead.
 *
 * `detail` is the Mod's own words when it refused. It is kept for `details` and never for the model: the Mod spells its
 * refusal with the name of the tool this read used to be mounted as, and a caller taught that name would ask for a tool
 * that does not exist - the Host's own sentence carries the same limit and the same size without it.
 */
type RectangleRead =
  | Readonly<{ ok: true; result: TileAreaResult }>
  | Readonly<{ ok: false; code: string; hint: string; detail: string | null }>;

/** The wire's own bound on one selection coordinate, matching the rectangle arithmetic the tile reader accepts. */
const SELECTION_COORDINATE_LIMIT = 1000;
/** Families one condition may name; past this the caller wants a narrower question, not a longer list. */
const SELECTION_KINDS_LIMIT = 12;

const selectionAxisSchema = Type.Object(
  {
    from: Type.Integer({ minimum: -SELECTION_COORDINATE_LIMIT, maximum: SELECTION_COORDINATE_LIMIT }),
    to: Type.Integer({ minimum: -SELECTION_COORDINATE_LIMIT, maximum: SELECTION_COORDINATE_LIMIT }),
    step: Type.Optional(Type.Integer({ minimum: 1, maximum: SELECTION_COORDINATE_LIMIT })),
  },
  { additionalProperties: false },
);

/** The largest whole number `accepts` takes, by doubling to the first refusal and bisecting back to the last acceptance. */
function largestAcceptedWholeNumber(accepts: (value: number) => boolean): number {
  let refused = 1;
  while (accepts(refused)) {
    if (refused > Number.MAX_SAFE_INTEGER / 2)
      throw new Error("largest_accepted_whole_number: the predicate accepts every whole number, so it states no bound");
    refused *= 2;
  }
  let accepted = 0;
  while (refused - accepted > 1) {
    const middle = Math.floor((accepted + refused) / 2);
    if (accepts(middle)) accepted = middle;
    else refused = middle;
  }
  return accepted;
}

/** The closed whole-number interval from 0 that a wire predicate accepts, read from the predicate itself. */
function intervalAcceptedBy(accepts: (value: number) => boolean): Readonly<{ minimum: number; maximum: number }> {
  if (!accepts(0) || accepts(-1))
    throw new Error("interval_accepted_by: the predicate is not an interval of whole numbers starting at 0");
  return Object.freeze({ minimum: 0, maximum: largestAcceptedWholeNumber(accepts) });
}

/** `isOpaqueId`'s shape as a schema: it refuses the empty string, and accepts at most its ceiling of that length. */
function opaqueIdShape(): Readonly<{ minLength: number; maxLength: number }> {
  if (isOpaqueId("")) throw new Error("opaque_id_shape: the wire's isOpaqueId now accepts the empty string");
  return Object.freeze({
    minLength: 1,
    maxLength: largestAcceptedWholeNumber((length) => isOpaqueId("a".repeat(length))),
  });
}

/**
 * The argument domains every Game Action schema shares, each one READ FROM THE WIRE'S OWN DECLARATION.
 *
 * Measured 2026-11-16: the hand-written schemas in this file carried 327 members, and only sixteen (name, expression)
 * pairs between them; 314 of those members wrote out one of five bounds that one place should own. A bound copied fifty
 * times is not a statement, it is a coincidence waiting to drift - and it had already drifted: the descriptor-derived
 * mounts declared `x`/`y` up to 100000 while `tileRow` refused a value above 1000, so a schema-conformant call was
 * refused before it reached the bridge. `tools/check-hand-written-schema-constants.mjs` is the gate that keeps each
 * bound declared exactly once.
 *
 * Where each bound comes from - the wire's validator, never this file's opinion:
 *
 *   `TILE_COORDINATE_SCHEMA`  `isTileCoordinate`, the predicate `tileRow` enforces for `args.x`/`args.y`.
 *   `TOOL_SLOT_SCHEMA`        `isToolSlot`, the predicate `slotRow` enforces for `args.slot`.
 *   `OPAQUE_ID_SCHEMA`        `isOpaqueId`: the wire's own rule for `args.expectedTargetId` (`targetRow`), for
 *                             `args.chestId` (`opaqueArgRow("chestId", ...)`) and for `requestId`/`idempotencyKey`
 *                             (the request validator). One predicate over four members, so one constant rather than four
 *                             spellings of one fact.
 *   `CALLER_REQUEST_SCHEMA`   that same domain, optional: a request MAY carry the identity pair, and none must.
 *   `ITEM_ID_SCHEMA`          the item's own wire identity. The wire enforces its 1..128 ceiling through
 *                             `boundedItemRow(refusal, 128)` at each row that carries an item rather than through an
 *                             exported predicate, so the ceiling is stated here once - this paragraph is its reason and
 *                             this line is where it moves.
 *
 * A predicate is a function, so its bound is READ by probing it instead of imported as a number: that is the only
 * reading that cannot disagree with the code deciding whether a request may leave the Host. Doubling and bisection cost
 * two logarithms of the ceiling, once, at module load.
 *
 * Eight members stay literal because they are their own action's and no other's: `respond_level_up`'s published
 * `choice`/`expectedSkill`/`expectedLevel`, `navigate_to_destination`'s typed `destination`, `equip_tool`'s tool
 * vocabulary, `till_soil`/`water_crop`'s `charge` (read from the wire's own row by `declaredIntegerArgument`), the
 * three pinned item ids a fence, a crab pot and a bait pot place, and `machine_load`'s accepted-input pattern. Each is
 * named with its reason in the gate's `ACTION_LOCAL` declaration, which expires the entry the moment the member stops
 * being written.
 */
const TILE_COORDINATE_SCHEMA = Type.Integer(intervalAcceptedBy(isTileCoordinate));
const TOOL_SLOT_SCHEMA = Type.Integer(intervalAcceptedBy(isToolSlot));
const OPAQUE_ID_SCHEMA = Type.String(opaqueIdShape());
const CALLER_REQUEST_SCHEMA = Type.Optional(OPAQUE_ID_SCHEMA);
const ITEM_ID_SCHEMA = Type.String({ minLength: 1, maxLength: 128 });

type Parsed<Value> = Readonly<{ ok: true; value: Value }> | Readonly<{ ok: false; code: string; hint: string }>;

type SelectionRead =
  | Readonly<{ ok: true; selection: ObservationSelection | null; limit: number }>
  | Readonly<{ ok: false; code: string; hint: string }>;

/** One observation answer's operator evidence, on every path: refused, unavailable, stale or answered. */
type ObservationDetails = Readonly<{
  available: boolean;
  refresh: "fresh" | "cached";
  refreshError: string | null;
  reasonCode: string | undefined;
  observationBudget: ObservationBudget | null;
  selection: SelectionAnswer | null;
  selectionGate: string | null;
  snapshotJson: string | null;
  /**
   * The Mod's own words when it refused the rectangle, kept for an operator and never handed to the model.
   *
   * The Mod spells its refusal with the name of the tool this read used to be mounted as, and a model told that name
   * would call a tool that no longer exists; the model gets the Host's sentence, which carries the same limit and the
   * same size.
   */
  selectionRefusal: string | null;
}>;

const refused = (code: string, hint: string): Readonly<{ ok: false; code: string; hint: string }> => ({
  ok: false,
  code,
  hint,
});

const readSmallInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= SELECTION_COORDINATE_LIMIT
    ? value
    : undefined;

function readSelectionAxis(raw: unknown, axis: "x" | "y"): Parsed<SelectionAxis> {
  const hint = `\`${axis}\` 是一个区间：{ from, to, step? }，坐标在 ±${String(
    SELECTION_COORDINATE_LIMIT,
  )} 之内，from ≤ to。`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return refused(`observation_selection_axis_invalid:${axis}`, hint);
  const record = raw as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(record))
    if (key !== "from" && key !== "to" && key !== "step")
      return refused(
        `observation_selection_unknown_key:${axis}.${key}`,
        "区间只认 from / to / step：step 是步长，`step: 2` 就是每隔一格取一格。",
      );
  const from = readSmallInteger(record.from);
  const to = readSmallInteger(record.to);
  if (from === undefined || to === undefined || from > to)
    return refused(`observation_selection_axis_invalid:${axis}`, hint);
  if (record.step !== undefined) {
    const step = readSmallInteger(record.step);
    if (step === undefined || step < 1) return refused(`observation_selection_axis_invalid:${axis}`, hint);
    return { ok: true, value: { from, to, step } };
  }
  return { ok: true, value: { from, to } };
}

/**
 * The top-level shape of one request: a record of exactly `select`, `tiles` and `limit`.
 *
 * Every field the rows already carry is accepted - `x`, `y` and the family a row came from - and nothing else is: an
 * ignored key is a silent default, so `occupant` or `radius` comes back as `observation_selection_unknown_key:<key>`
 * with the vocabulary that does exist.
 */
function readSelectionFields(params: unknown): Parsed<Readonly<Record<string, unknown>>> {
  if (typeof params !== "object" || params === null || Array.isArray(params))
    return refused(
      "invalid_tool_parameters",
      "stardew_observe 不带参数就是整块世界；要看一块，就带 `select`（矩形 / 步长 / kind）或 `tiles`（枚举格子），`limit` 控制每种列出几行。",
    );
  const record = params as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(record))
    if (key !== "select" && key !== "tiles" && key !== "limit")
      return refused(
        `observation_selection_unknown_key:${key}`,
        "已发布的每一行只带 x、y 和它所属的 kind，所以选择也只认 x / y / kinds；顶层只认 select、tiles、limit。",
      );
  return { ok: true, value: record };
}

/** `limit`: how many rows of each kind are listed. The rest are counted, never dropped. */
function readSelectionLimit(raw: unknown): Parsed<number> {
  if (raw === undefined) return { ok: true, value: MAX_TARGET_TILES_SHOWN };
  const asked = readSmallInteger(raw);
  if (asked === undefined || asked < 1 || asked > OBSERVATION_SELECTION_ROWS_LIMIT_MAX)
    return refused(
      `observation_selection_limit_invalid:${String(raw)}`,
      `\`limit\` 是每种列出的行数，取 1～${String(OBSERVATION_SELECTION_ROWS_LIMIT_MAX)}；其余的行只会计数，不会消失。`,
    );
  return { ok: true, value: asked };
}

/** The families one condition names, each one a kind this observation publishes a row under. */
function readSelectionKinds(raw: unknown): Parsed<readonly string[]> {
  if (!Array.isArray(raw) || raw.length === 0)
    return refused("observation_selection_axis_invalid:kinds", "`kinds` 至少给一个族名。");
  if (raw.length > SELECTION_KINDS_LIMIT)
    return refused(
      `observation_selection_too_many_kinds:${String(raw.length)}:${String(SELECTION_KINDS_LIMIT)}`,
      `一个条件最多 ${String(SELECTION_KINDS_LIMIT)} 个族名；更多就用多个条件。`,
    );
  const kinds: string[] = [];
  for (const kind of raw) {
    if (typeof kind !== "string" || !Object.hasOwn(TARGET_FAMILY_LABELS, kind))
      return refused(
        `observation_selection_unknown_kind:${String(kind)}`,
        `\`kinds\` 里是该行所属的族名（观察里按 kind 发布），例如 ${Object.keys(TARGET_FAMILY_LABELS)
          .slice(0, 8)
          .join(" / ")}。`,
      );
    kinds.push(kind);
  }
  return { ok: true, value: Object.freeze(kinds) };
}

/** The rectangle half of a condition: the axes it names, each refused by its own name. */
function readSelectionAxes(
  condition: Readonly<Record<string, unknown>>,
): Parsed<Readonly<{ x?: SelectionAxis; y?: SelectionAxis }>> {
  const axes: { x?: SelectionAxis; y?: SelectionAxis } = {};
  for (const axis of ["x", "y"] as const) {
    if (condition[axis] === undefined) continue;
    const read = readSelectionAxis(condition[axis], axis);
    if (!read.ok) return read;
    axes[axis] = read.value;
  }
  return { ok: true, value: Object.freeze(axes) };
}

/**
 * One condition: a RECTANGLE (`x` and `y` together), a stride inside it, or a KIND FILTER (`kinds` alone).
 *
 * Half a rectangle is refused rather than read as the whole column it would otherwise mean.
 */
function readSelectionCondition(raw: unknown): Parsed<SelectionPredicate> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return refused("observation_selection_axis_invalid:select", "`select` 的每一项是 { x?, y?, kinds? }。");
  const condition = raw as Readonly<Record<string, unknown>>;
  for (const key of Object.keys(condition))
    if (key !== "x" && key !== "y" && key !== "kinds")
      return refused(
        `observation_selection_unknown_key:select.${key}`,
        "一个条件只认 x（区间）、y（区间）和 kinds（族名）：形状是这三样，别的都不是行里有的东西。",
      );
  if ((condition.x === undefined) !== (condition.y === undefined))
    return refused(
      `observation_selection_axis_partial:${condition.x === undefined ? "x" : "y"}`,
      "矩形需要 x 和 y 一起给；只按位置以外的东西找，就只给 `kinds`。",
    );
  const axes = readSelectionAxes(condition);
  if (!axes.ok) return axes;
  if (condition.kinds === undefined) return { ok: true, value: axes.value };
  const kinds = readSelectionKinds(condition.kinds);
  if (!kinds.ok) return kinds;
  return { ok: true, value: Object.freeze({ ...axes.value, kinds: kinds.value }) };
}

/** `select`: the union of the conditions a request names, or none when it names no `select` at all. */
function readSelectionPredicates(raw: unknown): Parsed<readonly SelectionPredicate[]> {
  if (raw === undefined) return { ok: true, value: Object.freeze([]) };
  if (!Array.isArray(raw) || raw.length === 0)
    return refused(
      "observation_selection_empty",
      "`select` 是条件的并集：一个空数组什么也不选。要么给它至少一个条件，要么不带 `select`。",
    );
  if (raw.length > OBSERVATION_SELECTION_RANGE_LIMIT)
    return refused(
      `observation_selection_too_many_ranges:${String(raw.length)}:${String(OBSERVATION_SELECTION_RANGE_LIMIT)}`,
      `一次最多 ${String(OBSERVATION_SELECTION_RANGE_LIMIT)} 个范围；更多形状请直接枚举格子（\`tiles\`）。`,
    );
  const predicates: SelectionPredicate[] = [];
  for (const condition of raw) {
    const read = readSelectionCondition(condition);
    if (!read.ok) return read;
    predicates.push(read.value);
  }
  return { ok: true, value: Object.freeze(predicates) };
}

/** One enumerated tile: a pair of integers inside the coordinate limit, refused by the shape it was given. */
function readSelectionTile(raw: unknown): Parsed<readonly [number, number]> {
  const pair = Array.isArray(raw) && raw.length === 2 ? raw : undefined;
  const x = pair === undefined ? undefined : readSmallInteger(pair[0]);
  const y = pair === undefined ? undefined : readSmallInteger(pair[1]);
  if (x === undefined || y === undefined)
    return refused(
      `observation_selection_tile_invalid:${JSON.stringify(raw)}`,
      `一个格子写成 [x, y]，坐标在 ±${String(SELECTION_COORDINATE_LIMIT)} 之内。`,
    );
  return { ok: true, value: Object.freeze([x, y] as const) };
}

/** `tiles`: the tiles a request enumerates, each an `[x, y]` inside the coordinate limit. */
function readSelectionTiles(raw: unknown): Parsed<readonly (readonly [number, number])[]> {
  if (raw === undefined) return { ok: true, value: Object.freeze([]) };
  if (!Array.isArray(raw) || raw.length === 0)
    return refused("observation_selection_empty", "`tiles` 是一串 [x, y] 格子：空数组什么也不选。");
  if (raw.length > OBSERVATION_ENUMERATED_TILE_LIMIT)
    return refused(
      `observation_selection_too_many_tiles:${String(raw.length)}:${String(OBSERVATION_ENUMERATED_TILE_LIMIT)}`,
      `最多枚举 ${String(OBSERVATION_ENUMERATED_TILE_LIMIT)} 格；更大的形状请用 \`select\` 里的 x/y 范围。`,
    );
  const tiles: (readonly [number, number])[] = [];
  for (const rawTile of raw) {
    const tile = readSelectionTile(rawTile);
    if (!tile.ok) return tile;
    tiles.push(tile.value);
  }
  return { ok: true, value: Object.freeze(tiles) };
}

/**
 * The tiles a selection covers, counted BEFORE any of them is enumerated.
 *
 * An oversized rectangle is refused by name instead of spending the process enumerating a million tiles nobody can
 * read, which is why this number is taken from the predicates rather than from the rows that came back.
 */
function countCoveredTiles(predicates: readonly SelectionPredicate[], tiles: readonly unknown[]): number {
  return predicates.reduce(
    (total, predicate) =>
      total +
      (predicate.x === undefined || predicate.y === undefined
        ? 0
        : axisTileCount(predicate.x) * axisTileCount(predicate.y)),
    tiles.length,
  );
}

/**
 * One request's selection, read and refused BY NAME.
 *
 * Read in the order the refusals are ordered: the top-level vocabulary, then `limit`, then the conditions, then the
 * enumerated tiles, and only then the size the two halves together cover. A caller that gets a code back is told
 * exactly which field it was, so a malformed selection never reaches the bridge.
 */
function readObservationSelection(params: unknown): SelectionRead {
  const fields = readSelectionFields(params);
  if (!fields.ok) return fields;
  const limit = readSelectionLimit(fields.value.limit);
  if (!limit.ok) return limit;
  const predicates = readSelectionPredicates(fields.value.select);
  if (!predicates.ok) return predicates;
  const tiles = readSelectionTiles(fields.value.tiles);
  if (!tiles.ok) return tiles;
  if (predicates.value.length === 0 && tiles.value.length === 0)
    return { ok: true, selection: null, limit: limit.value };
  const covered = countCoveredTiles(predicates.value, tiles.value);
  if (covered > OBSERVATION_SELECTION_TILE_LIMIT)
    return refused(
      `observation_selection_too_many_tiles:${String(covered)}:${String(OBSERVATION_SELECTION_TILE_LIMIT)}`,
      `这个选择覆盖 ${String(covered)} 格，超过 ${String(
        OBSERVATION_SELECTION_TILE_LIMIT,
      )} 格；枚举最多 ${String(OBSERVATION_ENUMERATED_TILE_LIMIT)} 格，更大的范围请缩窄 x/y 或用 step 跳格。`,
    );
  return {
    ok: true,
    selection: Object.freeze({ predicates: predicates.value, tiles: tiles.value }),
    limit: limit.value,
  };
}

/** One bounded observation: the snapshot the model is handed, and what bounding it cost. */
type BoundedObservation = ReturnType<typeof boundObservedSnapshot>;

/** One refresh attempt's outcome: whether the world was re-read, and the failure's own words when it was not. */
type ObservationRefresh = Readonly<{ kind: "fresh" | "cached"; error: string | null }>;

/**
 * Ask the Mod for a fresh observation, once.
 *
 * A fresh solicited observe is the only way the Agent can see the world after its own navigate/execute advanced the Mod
 * revision; the Host cache alone would still describe the pre-action location. The observed snapshot is admitted into
 * the connection state by the receive path, so the caller re-reads the cache afterwards (works for both the
 * Promise-returning production client and the synchronous test client).
 */
async function refreshObservation(
  integration: StardewBridgeConnection & Partial<NavigationReadIntegration>,
): Promise<ObservationRefresh> {
  if (typeof integration.observe !== "function") return { kind: "cached", error: null };
  try {
    await integration.observe();
    return { kind: "fresh", error: null };
  } catch (error) {
    return { kind: "cached", error: String(error instanceof Error ? error.message : String(error)) };
  }
}

/**
 * What an observation with no world in it says to the model, and the reason code beside it.
 *
 * The text carries the actionable cause, not one opaque sentence. A trace shows the Agent polling this tool 32 times
 * with the same uninformative reply after the bridge had gone away, because the reason code was present but only in
 * `details`.
 *
 * A FAILED refresh is not the same as "no refresh", and serving the cached snapshot as if it were current hides a
 * deadlock: the connection is still up, the request timed out, and the world may have stopped advancing. Measured
 * 2026-10-18 (run g43cross): between three 60-second action timeouts the Agent called this tool, the refresh failed, and
 * it received a perfectly ordinary-looking snapshot from revision 383 - so it kept acting on stale coordinates and
 * amplified the cascade, with the failure visible only in `details.refreshError`.
 */
function describeObservationAbsence(
  state: StardewBridgeConnection["state"],
  refreshError: string | null,
): Readonly<{ reason: string; text: string }> {
  const reason = state.latestReasonCode ?? "integration_not_ready";
  if (!state.connected)
    return {
      reason,
      text: `No live Stardew connection: ${reason}. The bridge is not attached, so the world cannot be observed and actions cannot be issued — do not keep retrying; report the state to the player instead.`,
    };
  return {
    reason,
    text: `No authoritative Stardew snapshot is available: ${reason}. The connection is up but the world is not observable yet${refreshError === null ? "" : ` (last refresh failed: ${refreshError})`}; retry only after the world state changes, not in a tight loop.`,
  };
}

/** The code one answer is labelled with: fresh, cached, cached-after-a-failed-refresh, or the absence's own name. */
function observationReasonCode(
  available: boolean,
  refresh: "fresh" | "cached",
  staleAfterFailedRefresh: boolean,
  unavailableReason: string,
): string {
  if (!available) return unavailableReason;
  if (refresh === "fresh") return "available_fresh";
  return staleAfterFailedRefresh ? "available_cached_after_failed_refresh" : "available_cached";
}

/**
 * Whether one answer is the world it already stated, or a new reading of it.
 *
 * A SELECTION is always new: the model asked a NEW question about the same revision, and "the world has not changed"
 * would leave that question unanswered.
 */
function observationNovelty(
  parts: Readonly<{
    bounded: BoundedObservation | null;
    revision: number | undefined;
    observedRevisionShown: number | undefined;
    selectionAnswer: SelectionAnswer | null;
  }>,
): Readonly<{ unchanged: boolean; fresh: boolean }> {
  if (parts.selectionAnswer !== null || parts.bounded === null || parts.revision === undefined)
    return { unchanged: false, fresh: false };
  const unchanged = parts.revision === parts.observedRevisionShown;
  return { unchanged, fresh: !unchanged };
}

/**
 * The snapshot the world block describes: the bounded one, without its row families when a selection prints those rows
 * itself, so a row is rendered once and never twice.
 */
function worldSnapshotOf(
  bounded: BoundedObservation | null,
  selectionAnswer: SelectionAnswer | null,
): Readonly<Record<string, unknown>> | undefined {
  if (bounded === null) return undefined;
  return selectionAnswer === null ? bounded.snapshot : withoutRowFamilies(bounded.snapshot);
}

/**
 * The world block one answer hands the model, and the selection block in front of it.
 *
 * The answer is the SAME block the per-turn delivery composes (`fact-brief.ts`), from the snapshot the Mod just
 * published - not a second rendering of the world with its own wording. Measured `round44`: the JSON dump this replaces
 * was a median 20,980 characters per call, 648,059 over 31 calls, 81.1% of every tool-result byte.
 */
function composeObservationBody(
  parts: Readonly<{
    bounded: BoundedObservation | null;
    revision: number | undefined;
    unchanged: boolean;
    selectionAnswer: SelectionAnswer | null;
  }>,
): string {
  const worldSnapshot = worldSnapshotOf(parts.bounded, parts.selectionAnswer);
  if (parts.bounded === null || parts.revision === undefined || worldSnapshot === undefined)
    return parts.selectionAnswer === null ? "" : parts.selectionAnswer.text;
  const worldText = parts.unchanged
    ? unchangedWorldAnswer(parts.revision)
    : composeWorldState({
        snapshot: worldSnapshot as unknown as Snapshot,
        revision: parts.revision,
        ageTurns: 0,
        // This answer IS the observation the block describes, so its age is zero on both measures.
        ageMs: 0,
        contentAgeMs: 0,
      });
  if (parts.selectionAnswer === null) return worldText;
  return worldText === "" ? parts.selectionAnswer.text : `${parts.selectionAnswer.text}\n${worldText}`;
}

/** The model-facing text of one answer: the stale warning first, then the world; or the absence, in its own words. */
function observationContent(
  parts: Readonly<{
    available: boolean;
    staleAfterFailedRefresh: boolean;
    refreshError: string | null;
    body: string;
    unavailable: string;
  }>,
): string {
  if (!parts.available) return parts.unavailable;
  if (!parts.staleAfterFailedRefresh) return parts.body;
  // A refresh the Mod refused still has a world to state - the last one it published - and the failure is said FIRST,
  // because a block that reads as current after a failed refresh is the deadlock this sentence exists for.
  return `STALE SNAPSHOT: the fresh observation FAILED (${String(
    parts.refreshError,
  )}) while the connection is still attached, so the world may have stopped advancing. Do not treat these coordinates as current - re-observe or report the state to the player instead of acting on them.\n${parts.body}`;
}

/**
 * One selection answer's outcome: the answer and the gate's own line, or the refusal the model is given instead.
 *
 * `text` is the whole model-facing sentence rather than a code the caller re-joins with a hint, because the
 * disagreement refusal names EVERY disagreeing group at once: a caller that reassembled `${code}。${hint}` would drop
 * the groups after the first and ship the model a shorter complaint than the gate made.
 */
type SelectionAttempt =
  | Readonly<{ ok: true; answer: SelectionAnswer; gate: string }>
  | Readonly<{
      ok: false;
      reasonCode: string | undefined;
      text: string;
      selection: SelectionAnswer | null;
      gate: string | null;
      refusal: string | null;
    }>;

/**
 * One rectangle read, through the Mod, in one round trip.
 *
 * THE BOUND IS THE MOD'S (`TileAreaQuery.AreaLimit`), which is why this request carries no area check: a refusal the Mod
 * answers is the one that names that limit beside the size that was asked for, and a Host-side copy of the number would
 * be a second opinion the model could be told instead of the truth.
 */
async function readRectangle(
  integration: StardewBridgeConnection & Partial<NavigationReadIntegration>,
  rectangle: SelectionRectangle,
): Promise<RectangleRead> {
  const reader = (integration as Partial<TileAreaReadIntegration>).tileArea;
  if (typeof reader !== "function")
    return {
      ok: false,
      code: "tile_area_query_unavailable",
      hint: "这次会话没有矩形读取通道，这块格子读不到；用不带参数的 observe 看整块世界，或用 `tiles` 逐格问已发布的行。",
      detail: null,
    };
  let result: TileAreaResult;
  try {
    result = await (integration as TileAreaReadIntegration).tileArea({
      x: rectangle.x,
      y: rectangle.y,
      w: rectangle.w,
      h: rectangle.h,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      code: "tile_area_query_failed",
      hint: `矩形读取失败了（${message}）：世界可能没在推进，先重新 observe 一次再问，别在这个循环里重试。`,
      detail: message,
    };
  }
  if (result.status === "answered") return { ok: true, result };
  const size = result.w * result.h;
  return {
    ok: false,
    code: `observation_rectangle_refused:${result.status}:${String(size)}:${String(result.areaLimit)}`,
    hint:
      result.status === "area_too_large"
        ? `${String(result.w)}×${String(result.h)} 共 ${String(size)} 格，超过一次能读的 ${String(
            result.areaLimit,
          )} 格：把 x 或 y 收窄成更短的条，或分几次问。`
        : `Mod 拒绝了这个 ${String(result.w)}×${String(result.h)} 的矩形（${result.status}）：换一个落在这张地图上、有世界状态的矩形再问。`,
    detail: result.detail,
  };
}

/**
 * THE SELECTION IS ANSWERED FROM WHERE THE QUESTION LIVES, in one place.
 *
 * A rectangle names TILES, and a tile no family published is one only the Mod can read, so that is a single `tile_area`
 * round trip; a kind filter or an enumerated tile names published ROWS and is filtered out of the snapshot the answer
 * just admitted. Either way the answer's shape, its gate and the three zeroes are the same, and nothing reaches the
 * model before the gate has run.
 */
async function answerSelection(
  integration: StardewBridgeConnection & Partial<NavigationReadIntegration>,
  selection: ObservationSelection,
  observed: Snapshot,
  limit: number,
): Promise<SelectionAttempt> {
  const rectangle = selectionRectangle(selection);
  const read = rectangle === null ? null : await readRectangle(integration, rectangle);
  if (read !== null && !read.ok)
    return {
      ok: false,
      reasonCode: read.code,
      text: `${read.code}。${read.hint}`,
      selection: null,
      gate: null,
      refusal: read.detail,
    };
  let answer: SelectionAnswer;
  let disagreements: readonly string[];
  if (read === null) {
    const fromRows = selectObservedRows(observed, selection, limit);
    answer = fromRows;
    disagreements = selectionDisagreements(observed, selection, fromRows);
  } else {
    const fromTiles = selectTileAreaRows(read.result, selection, limit, observed.tile);
    answer = fromTiles;
    disagreements = tileSelectionDisagreements(read.result, fromTiles);
  }
  const gate = selectionGateReport();
  // A summary that does not add up is refused, not shipped: the model would have no way to tell which of the two numbers
  // is the wrong one.
  if (disagreements.length > 0)
    return {
      ok: false,
      reasonCode: disagreements[0],
      text: `${disagreements.join("；")}。这张回答的分组和它自己带的行对不上，所以不交给你；重新 observe 一次再看。`,
      selection: answer,
      gate,
      refusal: null,
    };
  return { ok: true, answer, gate };
}

/** Read-only tools always expose facts exactly as supplied by the Mod. */
export function createStardewObservationTools(
  integration: StardewBridgeConnection & Partial<NavigationReadIntegration>,
  policy?: ActionPolicy,
) {
  // Which catalog revision this model has already been shown. Held in the closure because the connection
  // state belongs to the bridge, and "what this model has been told" is a property of the model's view.
  let surfaceRevisionShown: number | undefined;
  // The snapshot revision this tool last ANSWERED with. An observation that finds the revision it already
  // stated is one line, because the caller already has the world.
  let observedRevisionShown: number | undefined;
  const observe = defineTool({
    name: "stardew_observe",
    label: "Observe Stardew",
    description:
      "Read the latest authoritative Stardew Farmhand snapshot by asking the Mod for a fresh observation. This never changes the game. Always call this again after any action that changes location or world state; the previous result may describe a location you have already left. " +
      "With NO argument you get the whole bounded world. To ask about a SHAPE instead - 'the 3-wide, 20-long strip', 'the row along the fence', 'what is on these three tiles' - pass a SELECTION and the answer is about that shape: " +
      "`select` is a union of conditions, each { x?: {from,to,step?}, y?: {from,to,step?}, kinds?: [family,...] } - a rectangle, a stride (`step: 2` is every other tile), or kinds alone (every published row of those families wherever it stands); `tiles` is a union of explicit [x,y] tiles for any shape a rectangle cannot say. Both are unioned when both are given. " +
      "ONE `select` entry that gives `x` and `y` and no `kinds` IS a RECTANGLE, and it is answered PER TILE in ONE round trip: the Mod reads every tile of it, and each row carries tillable (would the Hoe admit this tile), occupant (the engine's own name for what is stored on it, 'none' when it is free), occupantKind (what stands there, in the same words an action's `Clears` declaration uses, so the word that names what removes a tile is the word the row carries), hoed / watered / crop (the soil's state), and passable (would the pathfinder step onto it now). The answer states the rectangle's size and how many of its tiles were read, counted apart: tiles with something on them, tiles measured empty, and tiles it could not read. Ask for the rectangle whenever the task has a shape instead of observing again and guessing the tiles in between: the observation's own families are only a square window around you, so a long strip is not in them. A rectangle has a SIZE limit, and a bigger one is REFUSED by name with the limit and the size you asked for. " +
      "`kinds` are the family names the observation already publishes (weedTargets, treeStumpTargets, soilTiles, debrisTargets, ...), and a condition that names them is filtered over the rows this snapshot ALREADY published - a family row says where something stands and nothing about the tiles between them, so name `kinds` only when that is the question. An unknown one is refused by name. " +
      "`limit` (1-" +
      String(OBSERVATION_SELECTION_ROWS_LIMIT_MAX) +
      ", default " +
      String(MAX_TARGET_TILES_SHOWN) +
      ") is how many rows of each kind are listed; the rest are COUNTED, never dropped. " +
      "The answer always has one shape: how many tiles the selection named (with rows / measured-empty / unreadable), then per kind its count, then the nearest rows. The three zeroes stay apart: a tile that was read and has nothing on it is EMPTY, a tile the answer carries no row for is named UNREADABLE, and a kind this observation never published is NOT MEASURED.",
    parameters: Type.Object(
      {
        select: Type.Optional(
          Type.Array(
            Type.Object(
              {
                x: Type.Optional(selectionAxisSchema),
                y: Type.Optional(selectionAxisSchema),
                kinds: Type.Optional(
                  Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
                    minItems: 1,
                    maxItems: SELECTION_KINDS_LIMIT,
                  }),
                ),
              },
              { additionalProperties: false },
            ),
            { minItems: 1, maxItems: OBSERVATION_SELECTION_RANGE_LIMIT },
          ),
        ),
        tiles: Type.Optional(
          Type.Array(
            Type.Tuple([
              Type.Integer({ minimum: -SELECTION_COORDINATE_LIMIT, maximum: SELECTION_COORDINATE_LIMIT }),
              Type.Integer({ minimum: -SELECTION_COORDINATE_LIMIT, maximum: SELECTION_COORDINATE_LIMIT }),
            ]),
            { minItems: 1, maxItems: OBSERVATION_ENUMERATED_TILE_LIMIT },
          ),
        ),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: OBSERVATION_SELECTION_ROWS_LIMIT_MAX })),
      },
      { additionalProperties: false },
    ),
    execute: async (
      _toolCallId,
      params,
    ): Promise<{ content: { type: "text"; text: string }[]; details: ObservationDetails }> => {
      const asked = readObservationSelection(params);
      const state = integration.state;
      // A malformed selection is refused BEFORE the bridge is asked anything: the request names a vocabulary this
      // tool does not have, and a round trip would only spend the answer on the same refusal.
      if (!asked.ok)
        return {
          content: [{ type: "text" as const, text: `${asked.code}。${asked.hint}` }],
          details: {
            available: state.connected && state.snapshot !== null,
            refresh: "cached" as const,
            refreshError: null,
            reasonCode: asked.code,
            observationBudget: null,
            selection: null as SelectionAnswer | null,
            selectionGate: null as string | null,
            snapshotJson: null,
            selectionRefusal: null,
          },
        };
      const refreshed = await refreshObservation(integration);
      const observed = integration.state.snapshot;
      const available = state.connected && observed !== null;
      // The admitted snapshot is the whole published world. What the model is HANDED is bounded to the facts an action
      // is dispatched with (see `boundObservedSnapshot`); the bridge, the connection state and the plan tool all keep
      // reading the untouched snapshot.
      const bounded = available ? boundObservedSnapshot(observed, surfaceRevisionShown) : null;
      // The action surface is described ONCE per catalog revision; every later observation says only that it has not
      // changed. Recorded only when the observation succeeded, so a failed refresh cannot consume the one description
      // the model was owed.
      if (bounded !== null && observed !== null) surfaceRevisionShown = observed.catalogRevision;
      // Operator evidence and the payload both read these two, so they are taken once: a second spelling is how a
      // refusal's `details` drifts from the answer it belongs to.
      const budget = bounded === null ? null : bounded.budget;
      const snapshotJson = bounded === null ? null : JSON.stringify(bounded.snapshot);
      const absence = describeObservationAbsence(state, refreshed.error);
      const staleAfterFailedRefresh = available && refreshed.kind === "cached" && refreshed.error !== null;
      const revision = observed === null ? undefined : observed.revision;
      let selectionAnswer: SelectionAnswer | null = null;
      let selectionGate: string | null = null;
      if (asked.selection !== null && observed !== null) {
        const attempt = await answerSelection(integration, asked.selection, observed, asked.limit);
        if (!attempt.ok)
          return {
            content: [{ type: "text" as const, text: attempt.text }],
            details: {
              available,
              refresh: refreshed.kind,
              refreshError: refreshed.error,
              reasonCode: attempt.reasonCode,
              observationBudget: budget,
              selection: attempt.selection,
              selectionGate: attempt.gate,
              snapshotJson,
              selectionRefusal: attempt.refusal,
            },
          };
        selectionAnswer = attempt.answer;
        selectionGate = attempt.gate;
      }
      const novelty = observationNovelty({ bounded, revision, observedRevisionShown, selectionAnswer });
      const body = composeObservationBody({ bounded, revision, unchanged: novelty.unchanged, selectionAnswer });
      if (novelty.fresh) observedRevisionShown = revision;
      return {
        content: [
          {
            type: "text" as const,
            text: observationContent({
              available,
              staleAfterFailedRefresh,
              refreshError: refreshed.error,
              body,
              unavailable: absence.text,
            }),
          },
        ],
        details: {
          available,
          refresh: refreshed.kind,
          refreshError: refreshed.error,
          reasonCode: observationReasonCode(available, refreshed.kind, staleAfterFailedRefresh, absence.reason),
          // Operator evidence that the bound ran and what it cost. Deliberately NOT in the payload: the provider sends
          // text blocks only, so a byte count there would never reach the model.
          observationBudget: budget,
          selection: selectionAnswer,
          // `observations examined N · kinds K · disagreeing 0`: the gate's own population and verdict.
          selectionGate,
          snapshotJson,
          selectionRefusal: null,
        },
      };
    },
  });
  /**
   * A question about the state this session already holds, not a new observation.
   *
   * `stardew_observe` asks the Mod; this answers from the snapshot the last observation admitted, so it costs a tool call
   * and no bridge round trip. It is mounted beside the observation tools because it is the same kind of thing - read-only,
   * constant, and never an action - and it is deliberately NOT one of the adapter's action tools: `runtime-core.internal.ts`
   * strips those when a composition declares `planActionSurface`, and a question about the world is not a step in a plan.
   */
  /**
   * The live surface reduced to the one fact an affordance needs: which actions exist, and which snapshot family each
   * one's targets come from.
   *
   * Two authorities and no third. `visibleActionsFromModCatalog` decides WHICH actions are published, live, and admitted
   * by policy - the same one definition the catalogue tool, the search tool and every mounted action use - and each
   * descriptor's own `targetFamily` decides which family it consumes, which is the Mod's declaration rather than a table
   * here. An action that declares no family contributes nothing, because it names no target to look for.
   */
  const affordanceSurface = (): readonly AffordanceAction[] => {
    const state = integration.state;
    const currentCapabilities =
      state.connected && state.snapshot !== null
        ? state.capabilities.filter((capability) => state.snapshot!.capabilities.includes(capability))
        : [];
    return visibleActionsFromModCatalog(state.catalogRegistrations ?? [], currentCapabilities, policy).flatMap(
      (entry) =>
        entry.descriptor?.targetFamily === undefined
          ? []
          : [{ actionId: entry.actionId, targetFamily: entry.descriptor.targetFamily }],
    );
  };
  /**
   * One answer shape for every lookup path: the payload, whether anything was read, and the revision the answer describes.
   *
   * `snapshotRevision` is read from the answer's own `source`, so an answer that names no snapshot (`my_work` reads the
   * journal, `noSnapshot` reads nothing) cannot inherit a revision from the session's last observation.
   */
  const lookupResult = (
    answer: Readonly<{ source: Readonly<{ snapshotRevision: number | null }> }>,
    available: boolean,
  ) => ({
    content: [{ type: "text" as const, text: JSON.stringify(answer) }],
    details: { answer, available, snapshotRevision: answer.source.snapshotRevision },
  });
  const lookup = defineTool({
    name: "stardew_look_up",
    label: "Look Up Stardew",
    description:
      "Answer a question about the Stardew state this session already holds, without asking the Mod again. Subjects: my_work (WHAT HAVE I ACTUALLY DONE: totals of programs submitted/settled/running, of nodes by terminal state and of `executions` - the actions that really reached the game; `byAction` with succeeded/failed/rejected per action; the distinct `tiles` your succeeded receipts addressed, with `unproven` for those that named none; and the newest `programs` ids with their state, so one can be passed to stardew_action_program_status. It needs no id and reads the Mod's durable journal, so it answers the same after any number of context folds and with no prior tool result in scope; `population` says \"programs read N of M\" when the journal is longer than one answer. `since` is NOT available: the journal records no day boundary, and the answer says so rather than guessing), affordances (WHAT CAN BE DONE HERE, NOW: one group per kind of target already in the snapshot, each naming the `family` it counts, the `action` every consumer would use, and the nearest target's id and tile; `count` is how many of that kind are in view, and the action's own preconditions still apply), crops (tiles that need water or are ready to harvest, per location), chests (which chest holds an item), inventory (items held), npcs (where a villager is), calendar (day, time, weather), data (THE GAME'S OWN CONTENT TABLES, which no observation carries: pass `table` and, for one row, `key`. `table` is an engine table name - FarmAnimals, Buildings, Shops, Machines, Crops, Objects, BigCraftables, Tools, and LocationFish (WHAT MAY BE CAUGHT IN ONE PLACE, NOW: pass `key` = a location name, or `here` for the place you are standing. It joins the game's own two fish tables - the location's spawn rows and each species' row - and answers per species its difficulty, the fishing level it needs, its time-of-day `window` and the `weather` it requires, plus, for a blocked species, a `blocked_by` code naming the fact that would have to change (time_outside_window, season_mismatch, skill_too_low, weather_mismatch, needs_deeper_water, ...). Read it as MAY, never WILL: the game rolls for every species, so a listed one can still fail to bite. `status: not_measured` means the place could not be read - that is not an empty pond) - read through the engine's own loaders, so it answers what a chicken costs, how many days until it matures, what it produces and from what, what a shop sells it for, and what a machine accepts and how long it takes. Without `key` the answer is a bounded index of the row ids with `population` beside `matched` and `omitted`; with `key` it is that one row projected to the fields that decide an action. The outcome is named: `data_table_unknown:<table>` (no such table), `data_row_absent:<table>:<key>` (the table has no such row), `data_row_found:<table>:<key>`, `data_table_not_projectable:<table>:<why>`. A table with zero rows answers `population: 0`, never unknown). Every answer names `source.family` and the `source.snapshotRevision` it describes; `source.family: null` means the snapshot does not carry that fact - that is not an empty world, and `missingField` names what the Mod would have to publish. Lists are bounded and report `omitted`. This never refreshes the world: call stardew_observe first if it may have moved.",
    parameters: Type.Object(
      {
        // The subject vocabulary is the module's own table, so a subject cannot be advertised here and refused there.
        subject: literalUnionSchema(LOOKUP_SUBJECTS.map((subject) => Type.Literal(subject))),
        query: Type.Optional(Type.String({ minLength: 0, maxLength: 64 })),
        // Accepted so a caller that asks for a day scope is TOLD the journal has none, instead of silently getting the
        // whole journal under a heading it did not earn.
        since: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
        // `subject: "data"` only. The table vocabulary belongs to the Mod's own registry, so this is a free name and an
        // unknown one comes back as `data_table_unknown:<table>` rather than being rejected here.
        table: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
        key: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, params) => {
      const asked = params as Readonly<{
        subject?: unknown;
        query?: unknown;
        since?: unknown;
        table?: unknown;
        key?: unknown;
      }>;
      const state = integration.state;
      const since = typeof asked.since === "string" ? asked.since : undefined;
      // `my_work` is answered from the Mod's journal, not from the snapshot in `state`, so it is resolved before the
      // snapshot check: the whole point of the subject is that it works when the world has moved on or was never observed,
      // and that it depends on nothing the transcript holds.
      if (String(asked.subject) === "my_work") {
        const reader = (integration as Partial<ProgramJournalReadIntegration>).programStatus;
        if (typeof reader !== "function")
          return lookupResult(journalUnavailable("this session has no Body Program journal reader"), state.connected);
        let journal: BodyProgramStatusResult;
        try {
          // No program id: the journal's own newest-programs page. The Mod remains the one authority, and this is the same
          // query `stardew_action_program_status` makes, asked the only way a reader without an id can ask it.
          journal = await (integration as unknown as ProgramJournalReadIntegration).programStatus({});
        } catch (error) {
          return lookupResult(
            journalUnavailable(
              `the Body Program journal could not be read: ${error instanceof Error ? error.message : String(error)}`,
            ),
            state.connected,
          );
        }
        return lookupResult(myWorkFromJournal(journal, { since }), state.connected);
      }
      const snapshot = state.connected ? state.snapshot : null;
      // `data` is answered by the game's own content tables, which no snapshot carries: the tables are engine state and
      // publishing them in every observation would turn an observation into a dump.
      if (String(asked.subject) === "data") {
        const table = typeof asked.table === "string" ? asked.table.trim() : "";
        if (table.length === 0)
          return lookupResult(
            dataQueryUnavailable("`data` needs a `table`: the engine table to read, e.g. FarmAnimals"),
            state.connected,
          );
        const reader = (integration as Partial<DataQueryReadIntegration>).dataQuery;
        if (typeof reader !== "function")
          return lookupResult(dataQueryUnavailable("this session has no content-data reader"), state.connected);
        const key = typeof asked.key === "string" && asked.key.trim().length > 0 ? asked.key.trim() : null;
        try {
          const result = await (integration as DataQueryReadIntegration).dataQuery({ table, key });
          return lookupResult(dataTable(result, key), state.connected);
        } catch (error) {
          return lookupResult(
            dataQueryUnavailable(
              `the content table could not be read: ${error instanceof Error ? error.message : String(error)}`,
            ),
            state.connected,
          );
        }
      }
      const answer =
        snapshot === null
          ? noSnapshot(state.latestReasonCode ?? "integration_not_ready")
          : lookUp(
              snapshot,
              String(asked.subject),
              typeof asked.query === "string" ? asked.query : "",
              affordanceSurface(),
            );
      return lookupResult(answer, snapshot !== null);
    },
  });
  const execution = defineTool({
    name: "stardew_execution_status",
    label: "Stardew Execution Status",
    description:
      "Read the latest diagnostic Stardew execution receipt snapshot. This is an inspection-only view for debugging; it is not authoritative completion proof for any task and must not be used to confirm an action finished.",
    parameters: Type.Object({}),
    execute: async () => {
      const receipt = integration.state.latestReceipt;
      return {
        content: [
          {
            type: "text" as const,
            text:
              receipt === null ? "No authoritative Stardew execution receipt is available." : JSON.stringify(receipt),
          },
        ],
        details: {
          receiptJson: receipt === null ? null : JSON.stringify(receipt),
        },
      };
    },
  });
  const catalog = defineTool({
    name: "stardew_interaction_catalog",
    label: "Stardew Interaction Catalog",
    description:
      "List published Stardew actions currently declared by the live Mod. Denied and unpublished actions are not represented.",
    parameters: Type.Object({}),
    execute: async () => {
      const state = integration.state;
      const modRegistrations = state.catalogRegistrations ?? [];
      const currentCapabilities =
        state.connected && state.snapshot !== null
          ? state.capabilities.filter((capability) => state.snapshot!.capabilities.includes(capability))
          : [];
      const actions = visibleActionsFromModCatalog(modRegistrations, currentCapabilities, policy).map((entry) => ({
        actionId: entry.actionId,
        familyId: entry.familyId,
        label: entry.label,
        description: entry.description,
        targetKinds: entry.targetKinds,
        availableNow: true,
        snapshotRevision: state.snapshot?.revision ?? null,
        location: state.snapshot?.location ?? null,
      }));
      return {
        content: [{ type: "text" as const, text: JSON.stringify(actions) }],
        details: { actions },
      };
    },
  });
  const search = defineTool({
    name: "stardew_search_interactions",
    label: "Search Stardew Interactions",
    description:
      "Search the currently published and live Stardew interaction surface without revealing denied or unpublished actions.",
    parameters: Type.Object({
      query: Type.String({ minLength: 0, maxLength: 128 }),
    }),
    execute: async (_toolCallId, params) => {
      const state = integration.state;
      const modRegistrations = state.catalogRegistrations ?? [];
      const currentCapabilities =
        state.connected && state.snapshot !== null
          ? state.capabilities.filter((capability) => state.snapshot!.capabilities.includes(capability))
          : [];
      const actions = searchActionsFromModCatalog(modRegistrations, currentCapabilities, params.query, policy).map(
        (entry) => ({
          actionId: entry.actionId,
          familyId: entry.familyId,
          label: entry.label,
          targetKinds: entry.targetKinds,
        }),
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(actions) }],
        details: { actions },
      };
    },
  });

  const navigationCapabilityReady = (actionId: NavigationActionId): boolean => {
    const state = integration.state as typeof integration.state & {
      catalogRevision?: number;
    };
    const snapshot = state.snapshot;
    const deniedActions = new Set(policy?.deniedActions ?? []);
    const deniedFamilies = new Set(policy?.deniedFamilies ?? []);
    return (
      state.connected &&
      snapshot !== null &&
      typeof (integration as { navigationRead?: unknown }).navigationRead === "function" &&
      state.catalogRevision === snapshot.catalogRevision &&
      state.capabilities.includes(actionId) &&
      snapshot.capabilities.includes(actionId) &&
      !deniedActions.has(actionId) &&
      !deniedFamilies.has("world_navigation") &&
      (state.catalogRegistrations ?? []).some(
        (registration) =>
          registration.actionId === actionId &&
          registration.familyId === "world_navigation" &&
          registration.lifecycle === "published" &&
          registration.kind === "read_only" &&
          registration.identityVersion === 1,
      )
    );
  };
  const requireStrictObject = (params: unknown): Readonly<Record<string, unknown>> => {
    if (typeof params !== "object" || params === null || Array.isArray(params))
      throw new Error("invalid_tool_parameters");
    return params as Readonly<Record<string, unknown>>;
  };
  const navigationResult = (result: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    details: { result },
  });
  /**
   * The read-only gate's answer, with the failing term named.
   *
   * Three tools share one refusal string and one boolean, so a failure could not be diagnosed from a run: measured
   * 2026-10-28, `stardew_read_scene` failed 72 of 72 calls, `stardew_find_destination` 25 of 25 and
   * `stardew_inspect_world_map` 9 of 9, every one of them `bridge_capability_not_ready` in under a millisecond.
   * The bridge owns the six terms; this asks it which one is false.
   */
  const readOnlyRefusal = (actionId: string): string => {
    const refusal = (
      integration as { readOnlyCapabilityRefusal?: (id: string) => string | null }
    ).readOnlyCapabilityRefusal?.(actionId);
    return refusal === undefined || refusal === null
      ? "bridge_capability_not_ready"
      : `bridge_capability_not_ready:${refusal}`;
  };

  const sceneCapabilityReady = (): boolean => {
    const state = integration.state;
    const snapshot = state.snapshot;
    return (
      state.connected &&
      snapshot !== null &&
      state.catalogRevision === snapshot.catalogRevision &&
      state.capabilities.includes("observe_scene") &&
      snapshot.capabilities.includes("observe_scene") &&
      (state.catalogRegistrations ?? []).some(
        (registration) =>
          registration.actionId === "observe_scene" &&
          registration.familyId === "world_perception" &&
          registration.identityVersion === 1 &&
          registration.lifecycle === "published" &&
          registration.kind === "read_only",
      ) &&
      typeof (integration as { observeScene?: unknown }).observeScene === "function" &&
      !new Set(policy?.deniedActions ?? []).has("observe_scene") &&
      !new Set(policy?.deniedFamilies ?? []).has("world_perception")
    );
  };

  const tools: Array<ReturnType<typeof defineTool>> = [observe, lookup, execution, catalog, search];
  {
    // constant mount; readiness re-checked at execution
    tools.push(
      defineTool({
        // Renamed from stardew_observe_scene: sharing the stardew_observe prefix with the per-turn
        // context tool made two different observations look like one family at selection time. The
        // wire action id is unchanged.
        name: "stardew_read_scene",
        label: "Observe Stardew Scene",
        description:
          "Read the Mod-advertised live Stardew scene projection. Scene references are observational only " +
          "and never authorize mutation. Each affordance may carry `reachable` (true, false, or ABSENT): true means the " +
          "companion can act on it from where it stands (walk onto the tile or stand beside it), false means a measured no, " +
          "and ABSENT means undecided -- nobody measured it, which is not a denial. Prefer acting on reachable targets; " +
          "a refusal is the fallback, not the plan.",
        parameters: Type.Object({}, { additionalProperties: false }),
        execute: async (_toolCallId, params) => {
          if (!requireStrictObject(params) || Object.keys(params).length !== 0)
            throw new Error("invalid_tool_parameters");
          if (!sceneCapabilityReady()) throw new Error(readOnlyRefusal("observe_scene"));
          const result = await (
            integration as StardewBridgeConnection & { observeScene: (request: {}) => Promise<unknown> }
          ).observeScene({});
          if (!isValidObserveSceneResult(result)) throw new Error("invalid_observe_scene_result");
          return navigationResult(result);
        },
      }),
    );
  }
  {
    // constant mount; readiness re-checked at execution
    tools.push(
      defineTool({
        name: "stardew_inspect_world_map",
        label: "Inspect Stardew World Map",
        description: "Read the authoritative Stardew navigation map without changing the game.",
        parameters: Type.Object(
          {
            nodeRef: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
            cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
          },
          { additionalProperties: false },
        ),
        execute: async (_toolCallId, params) => {
          const args = requireStrictObject(params);
          const keys = Object.keys(args);
          if (
            keys.length > 1 ||
            keys.some((key) => key !== "nodeRef" && key !== "cursor") ||
            (keys.length === 1 &&
              (typeof args[keys[0]!] !== "string" ||
                (args[keys[0]!] as string).length < 1 ||
                (args[keys[0]!] as string).length > 128))
          )
            throw new Error("invalid_tool_parameters");
          if (!navigationCapabilityReady("inspect_world_map")) throw new Error(readOnlyRefusal("inspect_world_map"));
          return navigationResult(
            await (integration as NavigationReadIntegration).navigationRead({
              operation: "inspect_world_map",
              args: keys.length === 0 ? {} : { [keys[0]!]: args[keys[0]!] },
            }),
          );
        },
      }),
    );
  }
  {
    // constant mount; readiness re-checked at execution
    tools.push(
      defineTool({
        name: "stardew_find_destination",
        label: "Find Stardew Destination",
        description:
          "Resolve a destination query from the authoritative Stardew world map without choosing or changing a destination.",
        parameters: Type.Object(
          { query: Type.String({ minLength: 1, maxLength: 128 }) },
          { additionalProperties: false },
        ),
        execute: async (_toolCallId, params) => {
          const args = requireStrictObject(params);
          const keys = Object.keys(args);
          if (
            keys.length !== 1 ||
            keys[0] !== "query" ||
            typeof args.query !== "string" ||
            args.query.length < 1 ||
            args.query.length > 128
          )
            throw new Error("invalid_tool_parameters");
          if (!navigationCapabilityReady("find_destination")) throw new Error(readOnlyRefusal("find_destination"));
          return navigationResult(
            await (integration as NavigationReadIntegration).navigationRead({
              operation: "find_destination",
              args: { query: args.query },
            }),
          );
        },
      }),
    );
  }
  return tools;
}

/**
 * Dynamically builds a restrictive TypeBox schema from an authenticated candidate action descriptor.
 * Validates strictly with additionalProperties: false and enforces Mod-provided enums.
 */
export function buildCandidateToolSchema(
  actionId: StardewDescriptorDerivedActionId,
  descriptor: ActionRegistrationDescriptor,
): TObject {
  if (actionId === "express_emote") {
    const arg = getDescriptorArgument(descriptor, "emote");
    const enumVals = getArgumentEnum(arg);
    if (!enumVals || enumVals.length === 0) {
      throw new Error("Invalid or incomplete descriptor for express_emote: missing emote enum");
    }
    const literals = enumVals.map((v) => Type.Literal(v));
    const emoteSchema = literalUnionSchema(literals);
    return Type.Object(
      {
        emote: emoteSchema,
      },
      { additionalProperties: false },
    );
  }

  if (actionId === "face_direction") {
    const arg = getDescriptorArgument(descriptor, "direction");
    const enumVals = getArgumentEnum(arg);
    if (!enumVals || enumVals.length === 0) {
      throw new Error("Invalid or incomplete descriptor for face_direction: missing direction enum");
    }
    const literals = enumVals.map((v) => Type.Literal(v));
    const directionSchema = literalUnionSchema(literals);
    return Type.Object(
      {
        direction: directionSchema,
      },
      { additionalProperties: false },
    );
  }

  if (actionId === "respond_level_up") {
    // Both halves of this action carry a real constraint, so this is the override the fallback below
    // documents. `choice` is the Mod's own published closed set (`FarmhandActionCatalog.LevelUpChoiceEnum`,
    // projected onto the descriptor); the pair is the binding the Mod re-checks against the menu it is
    // holding, bounded to the values the engine can actually put in `Farmer.newLevels` - skills 0..5
    // (luck included) and levels 1..10, the SAME bounds `FarmhandExecutionAcceptance` and the Host's
    // request validator enforce. Measured 2026-10-18: the fallback described `choice` as any string and
    // `expectedLevel` as "any integer from 0", and the schema-derived call was refused by the Host's own
    // validator - a tool whose declared domain the bridge could never accept.
    const vocabulary = getArgumentEnum(getDescriptorArgument(descriptor, "choice"));
    if (vocabulary === undefined) {
      throw new Error("Invalid or incomplete descriptor for respond_level_up: missing choice vocabulary");
    }
    return Type.Object(
      {
        choice: literalUnionSchema(vocabulary.map((value) => Type.Literal(value))),
        expectedSkill: Type.Integer({ minimum: 0, maximum: 5 }),
        expectedLevel: Type.Integer({ minimum: 1, maximum: 10 }),
      },
      { additionalProperties: false },
    );
  }

  if (actionId === "interact_npc_with_item") {
    // Exact five-argument shape derived from the frozen descriptor; the
    // opaque NPC target and qualified item must be copied verbatim from the
    // most recent observation and are never synthesized by the tool.
    return Type.Object(
      {
        slot: TOOL_SLOT_SCHEMA,
        x: TILE_COORDINATE_SCHEMA,
        y: TILE_COORDINATE_SCHEMA,
        expectedQualifiedItemId: ITEM_ID_SCHEMA,
        expectedTargetId: OPAQUE_ID_SCHEMA,
      },
      { additionalProperties: false },
    );
  }

  if (actionId === "talk_to_npc") {
    // The NPC family's shape: the opaque NPC target id and the tile it was published at,
    // both copied verbatim from the most recent npcRelationshipTargets observation and
    // never synthesized by the tool.
    return Type.Object(
      {
        x: TILE_COORDINATE_SCHEMA,
        y: TILE_COORDINATE_SCHEMA,
        expectedTargetId: OPAQUE_ID_SCHEMA,
      },
      { additionalProperties: false },
    );
  }

  if (actionId === "pet_animal" || actionId === "pet_farm_animal") {
    // Identity-locked target: the opaque pet/animal target id is copied verbatim from
    // the most recent observation, while x/y are the observed geometry.
    return Type.Object(
      {
        x: TILE_COORDINATE_SCHEMA,
        y: TILE_COORDINATE_SCHEMA,
        expectedTargetId: OPAQUE_ID_SCHEMA,
      },
      { additionalProperties: false },
    );
  }

  if (actionId === "ride_bus") {
    // No client-supplied target: the ticket machine of the current location is
    // the whole input, so there is nothing to synthesize or spoof.
    return Type.Object({}, { additionalProperties: false });
  }

  if (actionId === "ride_minecart") {
    // Station tile plus the opaque ride selector: both are copied verbatim from
    // the minecartTargets entries of the most recent observation.
    return Type.Object(
      {
        x: TILE_COORDINATE_SCHEMA,
        y: TILE_COORDINATE_SCHEMA,
        expectedTargetId: OPAQUE_ID_SCHEMA,
      },
      { additionalProperties: false },
    );
  }

  if (actionId === "withdraw_silo_hay" || actionId === "use_obelisk" || actionId === "toggle_animal_door") {
    // Same shape as ride_minecart: the tile plus the opaque target from the most
    // recent observation, both copied verbatim.
    return Type.Object(
      {
        x: TILE_COORDINATE_SCHEMA,
        y: TILE_COORDINATE_SCHEMA,
        expectedTargetId: OPAQUE_ID_SCHEMA,
      },
      { additionalProperties: false },
    );
  }

  // FALLBACK: derive the schema from the descriptor's own declared arguments.
  //
  // The explicit arms above are OVERRIDES for arguments that carry a real constraint (an enum, a range
  // the Mod also enforces, an opaque id). Everything else derives. An earlier version threw here, and
  // because `createStardewActionTools` has no try around its mount blocks, ONE descriptor-complete action
  // without an arm made the entire tool set fail to build. That had happened for fifteen mounted ids
  // (answer_dialogue, dismiss_modal, shop_purchase, select_mine_elevator_floor and the newest nine among
  // them) and no test noticed, because a runner calls `execute` directly and never mounts a tool. A
  // derived schema cannot drift from the Mod the way a hand-maintained list does.
  const declaredNames = declaredArgumentNames(descriptor);
  if (declaredNames === undefined) throw new Error(`Unsupported candidate action: ${actionId}`);
  const properties: Record<string, TSchema> = {};
  for (const name of declaredNames)
    properties[name] = candidateArgumentSchema(name, declaredArgumentType(descriptor, name));
  return Type.Object(properties, { additionalProperties: false });
}

/** The argument's declared type from EITHER descriptor shape: the Mod's own declaration, not a name convention. */
function declaredArgumentType(descriptor: ActionRegistrationDescriptor, name: string): string | undefined {
  if (Array.isArray(descriptor.arguments)) {
    const argument = descriptor.arguments.find((entry) => entry?.name === name);
    return typeof argument?.type === "string" ? argument.type : undefined;
  }
  const declared = descriptor.argumentSchema?.[name];
  return declared !== undefined && typeof declared.type === "string" ? declared.type : undefined;
}

/** The argument names a descriptor declares, in either shape the wire and the surface artifact use. */
function declaredArgumentNames(descriptor: ActionRegistrationDescriptor): readonly string[] | undefined {
  if (Array.isArray(descriptor.arguments)) {
    const names = descriptor.arguments.map((argument) => argument?.name);
    return names.every((name) => typeof name === "string" && name.length > 0) ? (names as string[]) : undefined;
  }
  if (
    descriptor.argumentSchema !== undefined &&
    typeof descriptor.argumentSchema === "object" &&
    descriptor.argumentSchema !== null
  )
    return Object.keys(descriptor.argumentSchema);
  return undefined;
}

/**
 * Forward exactly these argument names, and nothing else. This is the ONE projection rule a mount has: a mount that
 * spelled the names again would be a second spelling of an argument set the Mod or the registry already owns, and the
 * failure it ships is invisible from outside - several tools derived a complete `{ x, y, expectedTargetId }` schema and
 * then forwarded `{}`, which the Host protocol refused as `invalid_execution_request` before the bridge: a registered,
 * advertised, described capability that could not execute, with no fact in the refusal for the model to act on.
 */
function forwardDeclaredArguments(
  names: readonly string[],
  params: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const args: Record<string, unknown> = {};
  for (const name of names) args[name] = params[name];
  return args;
}

/**
 * The descriptor-shaped caller above: the names come off the Mod's own declaration, so a descriptor-derived mount's
 * parameter schema and its wire args read ONE source.
 */
function declaredArguments(
  descriptor: ActionRegistrationDescriptor | undefined,
  params: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  return forwardDeclaredArguments((descriptor === undefined ? [] : declaredArgumentNames(descriptor)) ?? [], params);
}

/**
 * One declared vocabulary as a schema: a closed set the Mod published, never a Host guess. `getArgumentEnum`
 * is the only reader of it, so the model-facing domain and the Mod's own acceptance check read the same list.
 */
function literalUnionSchema(literals: readonly TSchema[]): TSchema {
  return literals.length === 1 ? literals[0]! : Type.Union([...literals]);
}

/**
 * The tool-parameter schema for one declared argument, chosen by the convention the Mod's own argument
 * names follow. Advisory: the Mod re-validates every argument on the game thread, so a wrong guess here
 * cannot widen what an action accepts - it can only make the Host's description of the argument less exact.
 */
function candidateArgumentSchema(name: string, declaredType?: string): TSchema {
  // The tile and the backpack slot are the two arguments whose domain the WIRE declares as a predicate
  // (`isTileCoordinate`, `isToolSlot`) and whose numbers every mounted tool states again. Read first, ahead of the
  // declared type, because the type branch's ceiling described a value the validator refuses: measured 2026-11-16,
  // 17 descriptor-derived mounts offered `x`/`y` up to 100000 and `slot` up to 100000 while `tileRow`/`slotRow`
  // answered `invalid_*_tile`/`invalid_*_slot` above 1000 and 36 - the `charge` defect one layer down, where the
  // schema and the validator disagree about the RANGE instead of about the argument set.
  if (name === "slot") return Type.Integer({ minimum: 0, maximum: 36 });
  if (name === "x" || name === "y") return Type.Integer({ minimum: 0, maximum: 1000 });
  // The Mod's own declaration wins over the remaining name conventions: a name-convention guess can contradict the
  // wire validator, which is how a mounted tool came to describe integers as strings. `expectedTargetId` keeps its
  // tighter string bound, and the name refinements below only apply where the declared type is absent.
  if (declaredType === "integer" || declaredType === "number")
    return Type.Integer({ minimum: name === "quantity" ? 1 : 0, maximum: 100000 });
  if (declaredType === "string" && name === "expectedTargetId") return Type.String({ minLength: 1, maxLength: 128 });
  if (name === "quantity") return Type.Integer({ minimum: 1, maximum: 9999 });
  if (name === "expectedTargetId") return Type.String({ minLength: 1, maxLength: 128 });
  if (declaredType === "boolean") return Type.Boolean();
  return Type.String({ minLength: 1, maxLength: 256 });
}

/**
 * One whole-number argument EXACTLY as the wire pins it, read from `EXECUTION_REQUEST_ARGUMENT_RULES`.
 *
 * The schema is what the model is shown and what a call is validated against before it is built, and the protocol is what
 * decides whether the built request may leave the Host at all. Stating a bound here and enforcing it there are two
 * statements of one fact, so this reads the declaration's own range: a mount for an action whose range the wire pins
 * (a tool's `charge`) cannot describe a value the validator refuses, and cannot drift when the range moves.
 */
function declaredIntegerArgument(action: ExecutionRequest["action"], name: string): TSchema {
  const bound = executionRequestIntegerBounds(action).find((candidate) => candidate.argument === name);
  if (bound === undefined) throw new Error(`execution_request_integer_bound_missing:${action}:${name}`);
  return Type.Integer({
    minimum: bound.minimum,
    ...(bound.maximum === null ? {} : { maximum: bound.maximum }),
  });
}

/**
 * The presentation of each descriptor-derived Game Action tool, and the whole of what its mount states for itself.
 *
 * The Mod's declaration owns the action's arguments, their domains and its name; this table owns what the declaration
 * cannot carry - the label and the sentence a model reads - and nothing else. The mount below therefore reads: the ids
 * are `STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS` (the registry's own list), the parameters are the declaration's arguments,
 * and the forwarded names are the declaration's names. A row here is typed against that list, so an action added to it
 * without a label is a compile error rather than a mount that quietly lost its description, and a row for an action the
 * list does not name is one too.
 */
const DECLARED_ACTION_TOOL_PRESENTATION: Readonly<
  Record<StardewDescriptorDerivedActionId, Readonly<{ label: string; description: string }>>
> = Object.freeze({
  send_multiplayer_chat: Object.freeze({
    label: "Say one line to the lobby",
    description:
      "Send one chat line to the whole multiplayer lobby through the game own chat egress. It takes exactly one string (`text`), moves nobody, opens nothing and touches no inventory, and it is REFUSED when there is no lobby (chat_multiplayer_only), when the text is blank or longer than one native chat line (chat_message_invalid), or when you send again inside the minimum interval (chat_rate_limited, with retry_after_ms). The receipt proves the SEND only: it never claims that anyone read the line.",
  }),
  name_entity: Object.freeze({
    label: "Name your horse",
    description:
      "Give your own horse its name through the game own naming settlement. It takes exactly one string (`text`) and no target: the subject is YOUR horse, found live. It is REFUSED when you own no horse (name_entity_target_unavailable), when the horse already carries a name (name_entity_target_already_named), or when the name is blank, longer than 64 characters, or carries a `;` or `=` (name_entity_name_invalid). The receipt reports the name READ BACK from the entity, never the call itself.",
  }),
  express_emote: Object.freeze({
    label: "Express Stardew Emote",
    description:
      "Show a native overhead emote balloon for the companion actor. A gesture is one step by nature, so this tool is mounted on its own beside the plan builder and is NOT a step inside `stardew_plan_work`: one call is the whole gesture, it never queues behind the work in front of it, and its settlement is its own. It takes exactly one `emote` word, and this parameter list carries the closed set of words the Mod accepts.",
  }),
  face_direction: Object.freeze({
    label: "Face Stardew Direction",
    description:
      "Turn the companion actor to face a cardinal direction (up, right, down, left). Mounted on its own beside the plan builder for the same reason as `stardew_express_emote` - a turn is one step by nature and is NOT a step inside `stardew_plan_work` - and it takes exactly one `direction` word, whose closed set this parameter list carries.",
  }),
  interact_npc_with_item: Object.freeze({
    label: "Offer Item to NPC",
    description:
      "Offer one carried inventory item to an adjacent villager. slot, x, y, expectedQualifiedItemId and expectedTargetId must be copied exactly from the npcRelationshipTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). A matching native quest delivery completes first and returns quest_item_delivered; the ordinary gift path returns gift_given.",
  }),
  talk_to_npc: Object.freeze({
    label: "Talk to Villager",
    description:
      "Talk to an adjacent villager: the Mod drives the game's own NPC.checkAction talk branch, so the villager's real dialogue is what appears. x, y and expectedTargetId must be copied exactly from the npcRelationshipTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). Empty your hands first: with an item in hand the game takes the gift path instead and the action refuses with hands_not_empty, and a villager who is asleep or out of reach is refused too. Returns talk_to_npc_talked when the dialogue is open; the actor stays inside that dialogue until it is closed (stardew_dismiss_modal, or stardew_answer_dialogue for a question).",
  }),
  pet_animal: Object.freeze({
    label: "Pet Animal",
    description:
      "Pet a nearby pet. x, y and expectedTargetId must be copied exactly from the petTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). The pet target is bound by identity: if it has moved away, the native interaction returns a rejection instead of petting a different pet. A pet that is stationary right now is the reliable target; a moving one may leave before dispatch returns. Returns pet_completed.",
  }),
  pet_farm_animal: Object.freeze({
    label: "Pet Farm Animal",
    description:
      "Pet one of your own farm animals - a cow, chicken, sheep, pig, duck, rabbit or dinosaur - in the barn, coop or pasture you are standing in. This is NOT stardew_pet_animal: that one pets the household cat/dog, this one pets barn and coop stock through the game's own FarmAnimal.pet, and the two read different day markers. x, y and expectedTargetId must be copied exactly from the farmAnimalPetTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates): x and y are only the tile the animal was published at, and the animal is named by the opaque id, so the Mod re-resolves it from its live tile and walks the actor into reach when it has wandered, while an animal that is no longer in the building is refused as farm_animal_target_gone instead of petting a different one. A second pet attempt in the same day is refused as farm_animal_already_petted_today, because the game's pet would open the animal menu and change no friendship at all. Also refused by name: farm_animal_cracker_would_be_consumed (a held Golden Animal Cracker would be spent instead of petting) and farm_animal_pet_requires_movement_after_1900 (after 19:00 only a moving animal answers a pet). Returns farm_animal_petted with the friendship before and after; an animal whose friendship and wasPet marker did not move comes back as farm_animal_pet_postcondition_not_observed rather than as a pet that never happened.",
  }),
  sleep: Object.freeze({
    label: "Sleep and Advance the Day",
    description:
      "End the day the way the player does: the Farmhand walks to its own bed, lets the native bedtime path run, declares bedtime-ready through that same native path, and then observes the native save and new-day transition. In a shared world the night completes only when every required player is ready; the Farmhand never marks another player ready and never forces the day. Takes no arguments. Returns day_advanced when the native save and day transition are observed, blocked with requires_other_player when the ready barrier is still waiting on someone else.",
  }),
  dismiss_modal: Object.freeze({
    label: "Dismiss a Dialog",
    description:
      "Close the informational native dialogue currently on screen (a DialogueBox with no pending question) through the native closeDialogue path. The dialog must have been opened by the world (a villager, a door gate, an event) and must not be a question that requires choosing an answer.",
  }),
  ride_bus: Object.freeze({
    label: "Ride the Bus",
    description:
      "Ride the native bus from the Bus Stop ticket machine to the desert. Stand next to the ticket machine first (otherwise the action refuses with bus_ticket_machine_out_of_reach). The Mod verifies the vault, the driver and the fare itself, then drives the game's own ticket interaction: the receipt arrives as bus_arrived when the actor is in the desert, or bus_arrival_unconfirmed if the ride never completes.",
  }),
  withdraw_silo_hay: Object.freeze({
    label: "Take hay from a silo",
    description:
      "Withdraw one hay from a discovered silo. Stand within reach of the silo first. Read the opaque target id, its tile and the stored `hay` count from the `siloTargets` entries of the most recent observation (the same list `stardew_deposit_silo_hay` reads). The Mod re-resolves the silo from the opaque target id and asserts BOTH halves of the move (the silo store drops by one and the carried hay rises by one), so a one-sided change is never reported as success.",
  }),
  clear_fish_pond: Object.freeze({
    label: "Empty a fish pond",
    description:
      "Empty a built fish pond of every occupant through the pond own clearing settlement. Read the opaque target id, its tile, the pond type, the occupant count and the fish type from the `fishPondTargets` projection. The fish are NOT destroyed: each one is put on the ground as debris for you to collect, and the pond itself is reset and must be restocked from scratch. An empty pond is never advertised, and one that was already emptied refuses by name (pond_already_empty) rather than clearing nothing and calling it a success.",
  }),
  build_farm_building: Object.freeze({
    label: "Commission a farm building",
    description:
      "Commission a farm building at a site the game itself accepts. Read the opaque target id, its tile, the `buildingType`, the `buildCost` and the `buildDays` from the `farmBuildingTargets` entries of the most recent observation - the site carries the type, so name the site and never a bare structure. The commission charges the build cost and the materials the game declares, and the terminal is a building standing on that site with a durable id; a site the game no longer accepts, or that you cannot afford or supply, is refused by name rather than built.",
  }),
  accept_daily_quest: Object.freeze({
    label: "Accept the day's posted quest",
    description:
      "Accept the help-wanted quest the town has posted for today. Read the opaque target id, the `questType` and the `title` from the `dailyQuestTargets` entries of the most recent observation, and check `acceptedDailyQuest`: it is the day flag the accept turns true, so a day that already accepted one refuses by name instead of accepting twice. The board is only where a player reads the offer; naming the quest is what this does.",
  }),
  accept_special_order: Object.freeze({
    label: "Accept an offered special order",
    description:
      "Accept one of the special orders a board is offering. Read the opaque target id, the `questKey` and the `orderType` from the `specialOrderTargets` entries of the most recent observation, and expect the order to appear in the snapshot's `activeSpecialOrderKeys` afterwards; an order that is already active, or whose board has already been used for an accept, is refused by name.",
  }),
  claim_museum_reward: Object.freeze({
    label: "Collect the museum rewards you are owed",
    description:
      "Collect every museum donation reward this player is entitled to. Read the opaque target id and the `rewardCount` from the `museumRewardTargets` entries of the most recent observation; the reward items are delivered into the backpack and recorded as collected. A museum with nothing to collect is refused by name rather than reporting an empty success.",
  }),
  redeem_prize_ticket: Object.freeze({
    label: "Redeem a prize ticket",
    description:
      "Redeem one prize ticket at the machine. It takes NO arguments: the prize is whatever the machine own track head offers you right now, derived by the game from your own ticketPrizesClaimed stat, so there is nothing to choose and nothing to name. The receipt proves BOTH halves - the ticket stack fell by exactly one AND the prize entered your pack - and it refuses by name when you hold no ticket (prize_ticket_unavailable) or your pack cannot take the prize (prize_inventory_full) rather than dropping it on the ground.",
  }),
  tailor_clothing: Object.freeze({
    label: "Tailor clothing from a recipe pair",
    description:
      "Consume the cloth and the reagent a live sewing-machine recipe pairs and produce that recipe's garment into your backpack. Read the opaque target id, the two backpack slots (`leftSlot`/`rightSlot`) and the produced item id from the `tailoringTargets` entries of the most recent observation; the Mod re-reads both named slots on the game thread and refuses by name when the pair no longer mints the published id. A garment only part of which fits is reported as `clothing_tailoring_output_dropped`, never as a full success.",
  }),
  color_placed_object: Object.freeze({
    label: "Repaint a placed chest",
    description:
      "Repaint one placed chest with one of the game's own 21 palette colours. Read the opaque target id, its tile (`x`, `y`) and the `color` it already carries from the `colorTargets` entries of the most recent observation, then name the palette index (`colorSelection`) it should carry. Only palette colours are writable, so no RGB value is accepted, and a repaint to the colour it already carries is refused by name instead of being reported as a change.",
  }),
  dye_clothing_with_item: Object.freeze({
    label: "Dye clothing with one item",
    description:
      "Recolour one existing garment from one dye item. Read the opaque target id, the garment slot (`leftSlot`), the dye slot (`rightSlot`) and the garment's CURRENT `garmentColour` from the `tailoringTargets` entries of the most recent observation. The receipt proves the dye was spent AND the colour settled, and reports before/expected/after; a colour that did not move is never reported as success.",
  }),
  toggle_animal_door: Object.freeze({
    label: "Toggle an animal door",
    description:
      "Open or close a barn or coop animal door. Stand within reach of the building first. Read the opaque target id, its tile and the current `isOpen` state from the `animalDoorTargets` entries of the most recent observation. The Mod re-resolves the building from the opaque target id and asserts the door state flipped; the receipt carries the observed before/after state.",
  }),
  use_obelisk: Object.freeze({
    label: "Use a warp obelisk",
    description:
      "Activate a discovered warp obelisk. Stand within reach of it first. Read the opaque target id, `route`, tile and `destination` from the `obeliskTargets` entries of the most recent observation. The Mod chooses the destination from the target itself (a Data/Buildings obelisk building, or the island farm obelisk tile), so name the structure and never a destination; the arrival is the terminal, not the dispatch.",
  }),
  shop_purchase: Object.freeze({
    label: "Buy from a shop",
    description:
      "Buy goods from a shop the game says is open here. Read the opaque target id, `shopId`, the owner tile and `stockItemIds` from the `shopTargets` entries of the most recent observation; `stockItemIds` lists what this shop actually sells, so do not request an item it does not name. A shop may be opened by an eligible owner (an NPC) OR by its own tile or object, which is why a target can exist with no owner standing nearby; the Mod reads owner eligibility and stock from the game's own content data, and the purchase runs through the game's own shop menu. Move into reach of the shop first; the action does not walk.",
  }),
  select_mine_elevator_floor: Object.freeze({
    label: "Use the Mine Elevator",
    description:
      "Select an already-reached floor on the mine elevator. Read the opaque target id, `floor` and `isCurrentFloor` from the `mineElevatorFloorTargets` entries of the most recent observation. The offered floors come from the Mod reading the live lowest level reached, so a level the player has not unlocked cannot be requested. Floor 0 returns to the mine entrance and is only valid from inside the mine.",
  }),
  answer_dialogue: Object.freeze({
    label: "Answer a Dialogue",
    description:
      "Choose one response from the currently displayed native question dialogue. responseKey must exactly match a response offered by the live DialogueBox.",
  }),
  respond_level_up: Object.freeze({
    label: "Settle a Level-up",
    description:
      'Settle the level-up the actor is being shown: choice "confirm" for an ordinary level, or "branch_a"/"branch_b" for one of the two professions a level-5 or level-10 menu offers. Pass the skill and level the menu is about, so a persistent choice can never be applied to the wrong level-up.',
  }),
  ride_minecart: Object.freeze({
    label: "Ride a Native Minecart",
    description:
      "Ride one advertised native minecart objective from a live station tile. x, y and expectedTargetId must be copied exactly from the minecartTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates); x,y is the STATION tile, not the destination. The Mod re-derives the network, its unlock, the destination condition and the ticket price on the game thread from the live map tile and Data/Minecarts, then performs the native ride. Only the minecart_ride_completed receipt, which names the ridden objective and the exact arrival tile, reports success.",
  }),
  sweep_scythe: Object.freeze({
    label: "Sweep the Scythe Arc",
    description:
      "Swing the scythe ONCE at a tile arc. x and y are only the tile the Farmhand must FACE, copied from the MOST RECENT observe result for the current location (never invent or guess coordinates) - there is no target id, because one swing covers a SET of tiles the engine itself samples, and the scythe comes from the action's own `tool:scythe` claim rather than a slot you name. The receipt is that arc's own measurement: arc_tiles, arc_sweepable and arc_clear count what it sampled, and changed names the tiles that moved with what stood on each before the swing. Completion is the NAMED tile moving (scythe_sweep_cut); a swing that left it alone comes back as scythe_sweep_partial rather than as a completed sweep, and nothing here claims a monster hit.",
  }),
  use_mine_ladder: Object.freeze({
    label: "Leave the mine by its ladder",
    description:
      "Leave the mine level you are inside through its own exit ladder, so you are not trapped when nothing can be mined. x, y and expectedTargetId must be copied exactly from the mineEntranceTargets entries of the most recent observe result: inside a mine level that family publishes the ladder tiles, and the exit ladder is the one this action owns. The game opens its own Leave question and performs the warp, so no destination is accepted here. A row that belongs to the DESCENDING ladder is refused by name and points at stardew_enter_mine; to choose a floor you have already reached, use stardew_select_mine_elevator_floor.",
  }),
  load_building_chest: Object.freeze({
    label: "Load a building chest",
    description:
      "Put the held item into a storage chest the BUILDING itself declares, such as a Mill's input chest. Stand within reach of the building first. Read the opaque target id, its tile, the chest id and the load hint from the buildingChestTargets entries of the most recent observation. Only the native Load branch is driven; a chest the game exposes only through a menu is refused by name.",
  }),
  collect_building_chest_output: Object.freeze({
    label: "Collect building chest output",
    description:
      "Take what a building's OWN output chest holds, such as a Mill's flour or a Junimo Hut's crops. Stand within reach of the building first. Read the opaque target id, its tile and `stackCount` from the `buildingChestTargets` entries of the most recent observation. A chest holding two or more stacks is refused by name (building_chest_requires_menu), because the native branch would open a container menu this action does not drive; otherwise the Mod asserts the stack left the chest AND arrived in the pack.",
  }),
  use_warp_item: Object.freeze({
    label: "Use a held warp totem",
    description:
      "Use a held warp totem (farm, mountain, beach, desert or island) through the game's own object-use path, consuming the totem and warping the Farmhand. slot and expectedQualifiedItemId must be copied exactly from the warpItemTargets entry of the MOST RECENT observe result. The destination comes from the totem itself; only the arrival postcondition can report success.",
  }),
  pan_ore: Object.freeze({
    label: "Pan the water for ore",
    description:
      "Pan an ore-panning spot with the Copper Pan the Farmhand is holding. slot, x and y must be copied exactly from the panSites entry of the MOST RECENT observe result; the tile is re-checked against the game's own live panning point, so a stale site is refused rather than panned. Only the observed point change plus the panning counter can report success.",
  }),
  claim_mail_attachment: Object.freeze({
    label: "Claim a mailbox attachment",
    description:
      "Claim whatever is waiting in a mailbox. x, y and expectedTargetId must be copied exactly from the mailboxTargets entry of the MOST RECENT observe result; the target id binds the location, the tile and the pending letter, so a stale id is refused rather than claiming the next letter. A letter whose %item attachment has to be delivered is completed with the native letter exit, not discarded.",
  }),
  equip_wearable: Object.freeze({
    label: "Equip a wearable",
    description:
      "Put a wearable Farmhand inventory item into the body slot it belongs to. expectedTargetId must be copied exactly from the wearableTargets entry of the MOST RECENT observe result: it names the BODY slot (hat, shirt, pants, boots, left_ring, right_ring), so a stale id is refused. slot and expectedQualifiedItemId must be copied from the inventoryItemFacts entry of that same result: that is the pack slot holding the item to wear. A repeat of the same equip is an idempotent success, not an error.",
  }),
  unequip_wearable: Object.freeze({
    label: "Unequip a wearable",
    description:
      "Take the wearable out of a body slot and put it into a free pack slot. expectedTargetId must be copied exactly from the wearableTargets entry of the MOST RECENT observe result: it names the BODY slot to empty, so a stale id is refused. slot is the DESTINATION pack slot and must be a slot that the same result does not list in inventoryItemFacts (that list holds only OCCUPIED slots) and that is below inventorySlots. The action refuses when the pack is full rather than losing the item, and emptying an already-empty body slot is an idempotent success.",
  }),
  dismount_transport: Object.freeze({
    label: "Dismount the ridden transport",
    description:
      "Get off the horse or other mount the Farmhand is currently riding. This action takes NO arguments. It is a pure state assertion: it refuses when the actor is not riding anything, and only the observed end state (!isRidingHorse) can report success.",
  }),
  place_owned_object: Object.freeze({
    label: "Place an owned object",
    description:
      "Place a big-craftable the Farmhand owns onto a live lawful tile. slot, x, y, expectedQualifiedItemId and expectedTargetId must be copied exactly from the worldObjectTargets entry of the MOST RECENT observe result; the target id names the exact placement candidate, so a stale id is refused rather than placed somewhere else. Only the observed new object on the tile can report success.",
  }),
  remove_placed_item: Object.freeze({
    label: "Remove a placed object",
    description:
      "Remove a placed object from the world with the tool that can remove it: the action takes an Axe or Pickaxe out of the pack (the object itself decides which one removes it) and puts the actor's previous selection back, so slot is the number from toolSlots in the MOST RECENT observe result and need not be the held one. x, y and expectedTargetId must be copied exactly from the worldObjectTargets entry. A pack with neither tool, or a tool that cannot remove THIS object, is refused by name rather than silently doing nothing, and success is the object being GONE from the tile.",
  }),
  move_placed_furniture: Object.freeze({
    label: "Pick up placed furniture",
    description:
      "Pick up a piece of furniture that is already placed in the room, so it can be put down somewhere else. x, y and expectedTargetId must be copied exactly from the `placed_furniture` entry of the worldObjectTargets list in the MOST RECENT observe result; a stale id is refused rather than lifting a different piece that now stands there. There is no slot to name: the game chooses which backpack slot receives it. If the pack is full the piece goes back exactly where it stood and the action is refused by name - it is never silently lost - and success is the piece gone from the room AND one more in the pack.",
  }),
  break_container: Object.freeze({
    label: "Break a container",
    description:
      "Break a breakable container on the map, such as a crate or barrel. The action takes a tool the container accepts (any heavy hitter) out of the pack and puts the actor's previous selection back, so slot is the number from toolSlots in the MOST RECENT observe result and need not be the held one; x, y and expectedTargetId must be copied exactly from the worldObjectTargets entry. Success is the container being GONE and its drops accounted for, not the tool's return value.",
  }),
  rotate_furniture: Object.freeze({
    label: "Rotate placed furniture",
    description:
      "Turn one already-placed piece of furniture one step through its own rotation cycle, in place. x, y and expectedTargetId must be copied exactly from the `placed_furniture` entry of the worldObjectTargets list in the MOST RECENT observe result; there is no angle to name, because the piece's own `rotations` data decides whether it alternates or steps. A piece with fewer than two rotations is refused by name (`furniture_rotation_unsupported`), never reported as a turn that did nothing, and success is the piece's rotation changed while it still stands on the same tile.",
  }),
  remove_fence: Object.freeze({
    label: "Remove a placed fence",
    description:
      "Take one placed fence or fence gate off its tile with the tool the fence's own data accepts. x, y, expectedTargetId and the TOOL's slot must be copied exactly from the worldObjectTargets entry of the MOST RECENT observe result. Fence.performToolAction answers false on every branch, including the one that destroyed the fence, so success is the fence GONE from the location plus the drops it produced; a tool that cannot remove that exact fence is refused by name (`remove_fence_tool_cannot_remove_target`).",
  }),
  put_item_in_fish_tank: Object.freeze({
    label: "Put an item in a fish tank",
    description:
      "Put one backpack item into a placed fish tank, letting the tank's own CanBeDeposited rule decide whether it may hold it. slot, the item's expectedQualifiedItemId, x, y and expectedTargetId must be copied exactly from the worldObjectTargets entry of the MOST RECENT observe result. Success is the tank holding exactly one more item, that one, while the pack lost exactly one; an item the tank will not hold is refused by name (`fish_tank_rejects_item`), and a deposit the engine took the item for but never completed is put back and reported, never as a success.",
  }),
  place_item_on_pedestal: Object.freeze({
    label: "Place an item on a pedestal",
    description:
      "Place one backpack item on an empty pedestal, whose own drop-in action decides acceptance. slot, the item's expectedQualifiedItemId, x, y and expectedTargetId must be copied exactly from the worldObjectTargets entry of the MOST RECENT observe result; the id names the `empty_pedestal` row, because a pedestal already holding something has no such row. An occupied pedestal is refused by name (`pedestal_occupied`) before the call, because its own branch would knock the standing item off, and success is the pedestal's heldObject being this item while the pack lost exactly one.",
  }),
  break_resource_clump: Object.freeze({
    label: "Break a large stump, log or boulder",
    description:
      "Use the Axe or Pickaxe a large stump, hollow log, boulder or meteorite demands on it, one call swinging until the clump is gone. x, y and expectedTargetId must be copied exactly from the debrisTargets entries of the MOST RECENT observe result - never invent or guess coordinates. There is no slot to name: the handler selects the tool the clump's own switch requires and restores the previous selection, and a pack that cannot supply the level it needs is refused by name (`clump_tool_too_weak`). Success is the clump GONE, not the swing's return value.",
  }),
  open_geode: Object.freeze({
    label: "Open a geode",
    description:
      "Crack one carried geode at the blacksmith's own counter, through the game's GeodeMenu, so the machine's assignment and fee decide what comes out. slot and expectedQualifiedItemId must be copied exactly from the `inventoryItemFacts` row of the MOST RECENT observe result, and the slice is checked against that id before anything is consumed, so a stale pair is refused rather than opening a different item. There is no target id and no tile: the counter is the location's own. A counter out of reach, a fee the actor cannot pay and a full backpack are each refused by name, and success is the geode gone and the reward in the pack.",
  }),
});

/**
 * Mounts the complete Game Action tool surface for the life of a connected
 * session. The mounted tool NAME set is constant: per-action eligibility is
 * decided at execution time by executeGameAction against the Mod's live
 * capability snapshot and restrictive policy, which returns a structured
 * rejected receipt (capability_not_declared / action_policy_denied) instead
 * of withdrawing the tool. A constant name set preserves the provider prefix
 * cache, which a per-snapshot tool add/remove would otherwise bust. The Host
 * never mints per-turn permission or treats model prose as an authorization
 * source.
 */
export function createStardewActionTools(
  integration: StardewBridgeConnection,
  policy: ActionPolicy | undefined,
  dispatchAdmissionFactory?: IntegrationDispatchAdmissionFactory,
  trace?: RunTrace,
  expressionTurnGate?: ExpressionTurnGate,
) {
  if (!isMoveCapable(integration) || dispatchAdmissionFactory === undefined) return [] as const;
  const state = integration.state;
  if (!state.connected || state.snapshot === null) return [] as const;
  // Frozen Manifest content only: descriptor-complete blocks (express_emote,
  // face_direction) mount from published registrations, never from live
  // capability snapshots or per-turn permission.
  const modRegistrations = state.catalogRegistrations ?? [];
  const tools: Array<ReturnType<typeof defineTool>> = [];
  const makeGameActionTool = gameActionToolFactory(
    integration,
    policy,
    dispatchAdmissionFactory,
    trace,
    expressionTurnGate,
  );
  // Every action whose tool is a projection of the Mod's own declaration, mounted through the one rule a mount has: the
  // parameters are `buildCandidateToolSchema` over the published descriptor, and the names forwarded to the wire are that
  // same descriptor's. Forty-eight blocks used to spell each of these out by hand - the schema call, the forwarded names
  // and the arm that admitted it - and every one of them was a second copy of a declaration the Mod already publishes.
  // The condition is unchanged: a descriptor that cannot open its own arm means the tool is not mounted.
  //
  // WHAT THIS LOOP READS, AND WHAT IT DOES NOT. It reads the Mod's own published descriptor (`registration.descriptor`
  // through `isModDescriptorComplete`, which only ever closes) and nothing else: not `lifecycle`, not the live capability
  // snapshot, not the policy. So this loop is NOT the visibility decision - `visibleActionsFromModCatalog` is, and there
  // is one of it - and the reason the difference is harmless is the constant name set the provider prefix cache needs:
  // per-action eligibility is decided at execution time by the receipt-backed admission, which is why a capability the
  // snapshot no longer carries withdraws the ACTION and not the tool.
  //
  // The difference is still a fact that can drift, so `action-registry-consistency.test.ts`'s mount gate holds the mounted
  // action set and the visibility decision's set to each other and fails by name on either difference. Measured
  // 2026-11-20: both sets are the same 103 actions, and that agreement is what a visibility row deleted while its action
  // stays `experimental` would break - the visibility gate would refuse the action while this loop kept handing it out.
  for (const actionId of STARDEW_DESCRIPTOR_DERIVED_ACTION_IDS) {
    const registration = modRegistrations.find((entry) => entry.actionId === actionId);
    if (registration?.descriptor === undefined) continue;
    const descriptor = registration.descriptor;
    if (!isModDescriptorComplete(actionId, descriptor)) continue;
    const presentation = DECLARED_ACTION_TOOL_PRESENTATION[actionId];
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES[actionId],
        label: presentation.label,
        description: presentation.description,
        parameters: buildCandidateToolSchema(actionId, descriptor),
        action: actionId,
        toArgs: (params) => declaredArguments(descriptor, params),
      }),
    );
  }

  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.navigate_to_destination,
        label: "Navigate Farmhand to Destination",
        description:
          "Navigate to exactly one destination selected by a label or canonical destination reference. Only the authoritative Mod receipt can report completion.",
        parameters: Type.Object(
          {
            destination: Type.Union([
              Type.Object(
                {
                  kind: Type.Literal("label"),
                  label: Type.String({ minLength: 1, maxLength: 128 }),
                },
                { additionalProperties: false },
              ),
              Type.Object(
                {
                  kind: Type.Literal("ref"),
                  ref: Type.String({ pattern: "^dr1_[A-Za-z0-9_-]{21}[AQgw]$" }),
                },
                { additionalProperties: false },
              ),
            ]),
            requestId: CALLER_REQUEST_SCHEMA,
            idempotencyKey: CALLER_REQUEST_SCHEMA,
          },
          { additionalProperties: false },
        ),
        action: "navigate_to_destination",
        toArgs: (params) => ({ destination: params.destination }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.move_to_tile,
        label: "Move Farmhand to Tile",
        description:
          "Request the player-enabled stardew_move_to_tile capability. Inspect its authoritative receipt before saying movement succeeded. " +
          "A tile that holds an object (crop, weed, chest, machine) is approached from a standable neighbouring tile: the receipt then reports target_reached with adjacent_arrival=true and names the requested tile. " +
          "If the actor is already at the destination (or already within the approach ring of a substituted one), the receipt reports target_reached with already_at_target=true — nothing moved because nothing needed to. " +
          "A refusal (no_native_path) names the cause: blocked_by=<item>@x,y, target_standable, and probe_says_reachable.",
        parameters: Type.Object({
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "move_to_tile",
        toArgs: (params) => ({ x: params.x, y: params.y }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.travel,
        label: "Travel Through a Stardew Warp",
        description:
          "Use a live native warp at the source tile x, y. The Mod resolves the destination and only a Warped postcondition can report success; a named minecart ride is the separate stardew_ride_minecart action.",
        parameters: Type.Object({
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "travel",
        toArgs: (params) => ({ x: params.x, y: params.y }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.enter_exit,
        label: "Enter or Exit Stardew Location",
        description:
          "Enter or leave a location through a live native door or warp tile. The target may be a building door or a map tile carrying its own warp action, in which case the game's own gate runs and a refusal is reported instead of being bypassed (a gated door such as the Community Center is refused while its condition is unmet). x and y must be copied exactly from the sourceX and sourceY of a doorTargets entry in the most recent observe result; only the Warped postcondition can report success.",
        parameters: Type.Object({
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "enter_exit",
        toArgs: (params) => ({ x: params.x, y: params.y }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.till_soil,
        label: "Till Stardew Soil",
        description:
          "Use a live native Hoe on a soil tile. charge is the tool charge ONE native use covers: 0 tills the named tile alone, and a wider charge tills the box the held hoe's own level reaches - a charge the held tool cannot reach is refused by name, never clamped. Only a Mod receipt with soil_tilled evidence reports completion.",
        parameters: Type.Object({
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          charge: declaredIntegerArgument("till_soil", "charge"),
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "till_soil",
        toArgs: (params) => ({ x: params.x, y: params.y, charge: params.charge }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.pickup_forage,
        label: "Pick Up Stardew Forage",
        description:
          "Pick up a live native forage target. x, y, expectedQualifiedItemId and expectedTargetId must be copied exactly from the forageTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). Only the authoritative native receipt and target disappearance can report completion.",
        parameters: Type.Object({
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedQualifiedItemId: ITEM_ID_SCHEMA,
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "pickup_forage",
        toArgs: (params) => ({
          x: params.x,
          y: params.y,
          expectedQualifiedItemId: params.expectedQualifiedItemId,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.pickup_item,
        label: "Pick Up Stardew Item Drop",
        description:
          "Approach a live native Debris target. x, y, expectedQualifiedItemId and expectedTargetId must be copied exactly from the itemTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). Only the native magnetic-collection receipt and exact inventory evidence can report completion.",
        parameters: Type.Object({
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedQualifiedItemId: ITEM_ID_SCHEMA,
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "pickup_item",
        toArgs: (params) => ({
          x: params.x,
          y: params.y,
          expectedQualifiedItemId: params.expectedQualifiedItemId,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.refill_watering_can,
        label: "Refill Stardew Watering Can",
        description:
          "Refill one selected, partially filled Watering Can from a live adjacent native water source. slot, x, y and expectedTargetId must be copied exactly from the refillWateringCanTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates).",
        parameters: Type.Object({
          slot: TOOL_SLOT_SCHEMA,
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "refill_watering_can",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.water_crop,
        label: "Water Stardew Crop",
        description:
          "Water a live unwatered crop target. x, y and expectedTargetId must be copied exactly from the cropTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). charge is the watering can's charge for ONE native use: 0 waters the named tile alone, and a wider charge waters the box the can's own level reaches - a charge the held can cannot reach is refused by name, never clamped. Only the authoritative native receipt can report completion.",
        parameters: Type.Object({
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedTargetId: OPAQUE_ID_SCHEMA,
          charge: declaredIntegerArgument("water_crop", "charge"),
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "water_crop",
        toArgs: (params) => ({
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
          charge: params.charge,
        }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.plant_seed,
        label: "Plant Stardew Seed",
        description:
          "Plant a live ordinary seed into a live empty ground HoeDirt target. slot, x, y, expectedQualifiedItemId and expectedTargetId must be copied exactly from the seedTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). Native crop creation and the authoritative receipt determine completion.",
        parameters: Type.Object({
          slot: TOOL_SLOT_SCHEMA,
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedQualifiedItemId: ITEM_ID_SCHEMA,
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "plant_seed",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedQualifiedItemId: params.expectedQualifiedItemId,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.place_wood_fence,
        label: "Place Stardew Wood Fence",
        description:
          "Place only a qualified (O)322 Wood Fence on a fresh empty Farm tile. slot, x, y, expectedQualifiedItemId and expectedTargetId must be copied exactly from the woodFenceTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). Native Fence evidence determines completion.",
        parameters: Type.Object({
          slot: TOOL_SLOT_SCHEMA,
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedQualifiedItemId: Type.Literal("(O)322"),
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "place_wood_fence",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedQualifiedItemId: params.expectedQualifiedItemId,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.place_crab_pot,
        label: "Place Stardew Crab Pot",
        description:
          "Place only a qualified (O)710 Crab Pot on a fresh valid Farm water tile. slot, x, y, expectedQualifiedItemId and expectedTargetId must be copied exactly from the crabPotTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). Native Crab Pot evidence determines completion.",
        parameters: Type.Object({
          slot: TOOL_SLOT_SCHEMA,
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedQualifiedItemId: Type.Literal("(O)710"),
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "place_crab_pot",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedQualifiedItemId: params.expectedQualifiedItemId,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.bait_crab_pot,
        label: "Bait Stardew Crab Pot",
        description:
          "Attach exactly one live owned (O)685 Bait to a fresh adjacent unbaited current-player-owned (O)710 Crab Pot. slot, x, y, expectedQualifiedItemId and expectedTargetId must be copied exactly from the baitCrabPotTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). The native interaction and authoritative receipt determine completion.",
        parameters: Type.Object({
          slot: TOOL_SLOT_SCHEMA,
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedQualifiedItemId: Type.Literal("(O)685"),
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "bait_crab_pot",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedQualifiedItemId: params.expectedQualifiedItemId,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.harvest_bush,
        label: "Harvest Stardew Berry Bush",
        description:
          "Harvest a live in-bloom berry bush using its native interaction. x, y and expectedTargetId must come from the bushTargets entries of the most recent observe result for the current location.",
        parameters: Type.Object({
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "harvest_bush",
        toArgs: (params) => forwardDeclaredArguments(TILE_TARGET_ARGUMENTS, params),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.fish_here,
        label: "Fish Stardew Water Tile",
        description:
          "Cast a fishing rod at one water tile the game itself says a rod may be cast at, wait for the game's own bite, and let the game's own win path credit the catch. x, y and expectedTargetId must be copied exactly from the waterTargets entries of the MOST RECENT observe result for the current location - never invent or guess coordinates. The row names a tile the engine's own canFishHere/isTileFishable pair admitted, not a particular fish: which fish swims there is decided inside the engine at the bite. There is no slot to name: the handler selects the rod the action's own tool claim requires and restores the previous selection on every exit. Every refusal happens before the cast - no rod in the pack, no bait that rod needs, water the engine refuses, too little stamina, or a target id that no longer names this tile - and success is the catch the engine itself credited.",
        parameters: Type.Object({
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "fish_here",
        toArgs: (params) => forwardDeclaredArguments(TILE_TARGET_ARGUMENTS, params),
      }),
    );
  }
  for (const action of ["harvest_fruit_tree", "shake_tree", "take_pedestal_item", "toggle_fence_gate"] as const) {
    const labels = (
      {
        harvest_fruit_tree: [
          "Harvest Stardew Fruit Tree",
          "fruitTreeTargets",
          "Harvest fruit from a live fruit tree through its native interaction.",
        ],
        shake_tree: [
          "Shake Stardew Tree",
          "shakeTreeTargets",
          "Shake a live tree that has not been shaken today through its native interaction.",
        ],
        take_pedestal_item: [
          "Take Stardew Pedestal Item",
          "pedestalTargets",
          "Take the displayed item through the native pedestal inventory transaction.",
        ],
        toggle_fence_gate: [
          "Toggle Stardew Fence Gate",
          "fenceGateTargets",
          "Toggle a live fence gate through its native gate state transition.",
        ],
      } as const
    )[action];
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES[action],
        label: labels[0],
        description: `${labels[2]} x, y and expectedTargetId must be copied exactly from ${labels[1]} in the most recent observe result for the current location; the target id names the exact object, so a stale id from another location or an earlier visit is refused rather than applied. Do not invent or guess coordinates.`,
        parameters: Type.Object({
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action,
        toArgs: (params) => forwardDeclaredArguments(TILE_TARGET_ARGUMENTS, params),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.fertilize_tile,
        label: "Fertilize Stardew Soil",
        description:
          "Apply one live owned fertilizer item to a live eligible ground HoeDirt target. slot, x, y, expectedQualifiedItemId and expectedTargetId must be copied exactly from the fertilizerTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). Native placement and the authoritative receipt determine completion.",
        parameters: Type.Object({
          slot: TOOL_SLOT_SCHEMA,
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedQualifiedItemId: ITEM_ID_SCHEMA,
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "fertilize_tile",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedQualifiedItemId: params.expectedQualifiedItemId,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.machine_inspect,
        label: "Inspect Stardew Machine",
        description:
          "Read a live native machine state without opening a menu or changing the machine. x, y and expectedTargetId must be copied exactly from the machineTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates, never reuse coordinates observed in a different location). requestId/idempotencyKey are optional request metadata, not ActionProgram node arguments; execution deadlines are absolute Unix epoch milliseconds, not durations.",
        parameters: Type.Object({
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "machine_inspect",
        toArgs: (params) => forwardDeclaredArguments(TILE_TARGET_ARGUMENTS, params),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.machine_load,
        label: "Load Machine Input",
        description:
          "Load a carried item into a live idle machine through the normal native machine interaction. slot, x, y, expectedQualifiedItemId and expectedTargetId must be copied exactly from the machineTargets entry of the MOST RECENT observe result for the current location (use that row's loadInputSlot/loadInputQualifiedItemId, never invent or guess coordinates, never reuse coordinates observed in a different location). Which inputs a machine takes, and how many it consumes, is that machine's own game data: the row only publishes a load when the machine accepts the stack the actor carries. A receipt proves native input consumption and the processing window the machine's data declares. requestId/idempotencyKey are optional request metadata, not ActionProgram node arguments; execution deadlines are absolute Unix epoch milliseconds, not durations.",
        parameters: Type.Object({
          slot: TOOL_SLOT_SCHEMA,
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedQualifiedItemId: Type.String({
            pattern: "^\\([^()\\s]+\\)[^()\\s]+$",
            minLength: 1,
            maxLength: 128,
            description:
              "The machine's own accepted input, copied from loadInputQualifiedItemId on the same machineTargets row.",
          }),
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "machine_load",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedQualifiedItemId: params.expectedQualifiedItemId,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.machine_collect_output,
        label: "Collect Machine Output",
        description:
          "Collect the ready output of a live machine through the normal native machine interaction. x, y and expectedTargetId must be copied exactly from the machineTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). A receipt proves native inventory delivery, the held item and the stack that moved, and a cleared ready state.",
        parameters: Type.Object({
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "machine_collect_output",
        toArgs: (params) => forwardDeclaredArguments(TILE_TARGET_ARGUMENTS, params),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.collect_animal_product,
        label: "Collect Stardew Animal Product",
        description:
          "Use the live compatible Farmhand-owned tool on a live ready animal-product target. slot, x, y and expectedTargetId must be copied exactly from the animalProductTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). Native animation and receipt determine completion.",
        parameters: Type.Object({
          slot: TOOL_SLOT_SCHEMA,
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "collect_animal_product",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.feed_animal,
        label: "Place Hay in Stardew Trough",
        description:
          "Place one live owned Hay item in a live empty AnimalHouse trough. slot, x, y and expectedTargetId must be copied exactly from the feedTroughTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). This does not claim an animal has eaten.",
        parameters: Type.Object({
          slot: TOOL_SLOT_SCHEMA,
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "feed_animal",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.use_item,
        label: "Consume Held Stardew Food Item",
        description:
          "Eat one ordinary edible Farmhand inventory item. This does NOT use a tool on a world object; for that use stardew_clear_debris, stardew_chop_tree, stardew_break_rock, stardew_clear_hoedirt, stardew_refill_watering_can, stardew_scythe_crop, stardew_cut_weeds, stardew_cut_grass or stardew_till_soil instead. slot and expectedQualifiedItemId must be copied exactly from the foodTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). The item is consumed as the action is accepted, so a later interruption does not un-eat it. Native eating animation and the authoritative receipt determine completion.",
        parameters: Type.Object({
          slot: TOOL_SLOT_SCHEMA,
          expectedQualifiedItemId: ITEM_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "use_item",
        toArgs: (params) => ({
          slot: params.slot,
          expectedQualifiedItemId: params.expectedQualifiedItemId,
        }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.harvest_crop,
        label: "Harvest Stardew Crop",
        description:
          "Harvest a live ready ordinary crop. x, y, expectedQualifiedItemId and expectedTargetId must be copied exactly from the harvestTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). Only the native harvest receipt and inventory/regrow postcondition determine completion.",
        parameters: Type.Object({
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedQualifiedItemId: ITEM_ID_SCHEMA,
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "harvest_crop",
        toArgs: (params) => ({
          x: params.x,
          y: params.y,
          expectedQualifiedItemId: params.expectedQualifiedItemId,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.chop_tree,
        label: "Chop Stardew Tree",
        description:
          "Chop one live ordinary mature tree. The Mod keeps swinging the equipped Axe until the tree is felled and reports how many swings it took, so one call completes the chop. slot, x, y and expectedTargetId must be copied exactly from the treeChopSourceTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). Only the felled tree in the authoritative receipt determines completion.",
        parameters: Type.Object({
          slot: TOOL_SLOT_SCHEMA,
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "chop_tree",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.dig_artifact_spot,
        label: "Dig Stardew Artifact Spot",
        description:
          "Use one equipped Basic Hoe on a live adjacent diggable artifact spot. slot, x, y and expectedTargetId must be copied exactly from the artifactSpotTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). Source removal and native HoeDirt creation are required; rewards are excluded.",
        parameters: Type.Object({
          slot: TOOL_SLOT_SCHEMA,
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "dig_artifact_spot",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.clear_hoedirt,
        label: "Clear Stardew HoeDirt",
        description:
          "Use one equipped Basic Pickaxe hit on live adjacent empty ground HoeDirt. slot, x, y and expectedTargetId must be copied exactly from the clearHoeDirtTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). Crops, IndoorPots, drops, and pickup are excluded.",
        parameters: Type.Object({
          slot: TOOL_SLOT_SCHEMA,
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "clear_hoedirt",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.break_rock,
        label: "Break Stardew Rock",
        description:
          "Use one equipped basic Pickaxe swing on a live ordinary breakable stone. slot, x, y and expectedTargetId must be copied exactly from the rockSourceTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). Drops and pickup are separate actions.",
        parameters: Type.Object({
          slot: TOOL_SLOT_SCHEMA,
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "break_rock",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.equip_tool,
        label: "Equip Stardew Tool",
        description: `Select a Tool already owned by the AI Farmhand by semantic category (${[...TOOL_SELECTOR_VALUES].join(", ")}). The Mod receipt reports the authoritative before/after CurrentTool state.`,
        parameters: Type.Object({
          tool: Type.Union([...TOOL_SELECTOR_VALUES].map((selector) => Type.Literal(selector))),
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "equip_tool",
        toArgs: (params) => ({ tool: params.tool }),
      }),
    );
  }

  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.clear_debris,
        label: "Clear Stardew Debris",
        description:
          "Clear one live ResourceClump with the equipped Axe or Pickaxe, walking to it first when it is out of reach. slot, x, y and expectedTargetId must be copied exactly from the debrisTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). One call swings until the clump is gone and returns succeeded/debris_cleared, or uncertain/debris_not_cleared when the bounded swing cap could not finish it; drops and pickup are separate actions.",
        parameters: Type.Object({
          slot: TOOL_SLOT_SCHEMA,
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "clear_debris",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.npc_relationship,
        label: "Inspect NPC Relationship",
        description:
          "Read the live relationship facts of one adjacent villager. x, y and expectedTargetId must be copied exactly from the npcRelationshipTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). This never changes friendship, gifts or dialogue; it returns npc_relationship_inspected.",
        parameters: Type.Object({
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "npc_relationship",
        toArgs: (params) => forwardDeclaredArguments(TILE_TARGET_ARGUMENTS, params),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.water_pet_bowl,
        label: "Water the Pet Bowl",
        description:
          "Water the current location's completed, unwatered native Pet Bowl with the equipped Watering Can. x, y and expectedTargetId must be copied exactly from the petBowlTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). Returns pet_bowl_watered with the exact water and stamina delta.",
        parameters: Type.Object({
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "water_pet_bowl",
        toArgs: (params) => forwardDeclaredArguments(TILE_TARGET_ARGUMENTS, params),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.water_slime_hutch_trough,
        label: "Water a Slime Hutch Trough",
        description:
          "Water one unwatered trough tile inside the current Slime Hutch with the equipped Watering Can. x, y and expectedTargetId must be copied exactly from the slimeHutchTroughTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). The Farmhand must already be inside the hutch. Returns slime_hutch_trough_watered.",
        parameters: Type.Object({
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "water_slime_hutch_trough",
        toArgs: (params) => forwardDeclaredArguments(TILE_TARGET_ARGUMENTS, params),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.chest_store,
        label: "Store Item in Chest",
        description:
          "Move one carried inventory stack into a reachable chest. chestId and expectedQualifiedItemId must be copied from the MOST RECENT observe result for the current location: chestId is the `chestId` of one `chests` entry, which already names that container's location and tile, and expectedQualifiedItemId is the `qualifiedItemId` of the carried stack you mean. There is no x, y, expectedTargetId or slot to send - the container is the whole address, and the body takes the first stack of that item in the backpack and names the slot it moved in the receipt. No ItemGrabMenu is opened. Refused chest_target_changed when no live container answers to chestId, and item_not_owned_in_slot when the backpack holds none of that item by then. Returns chest_stored with the exact stack conservation evidence.",
        parameters: Type.Object({
          chestId: OPAQUE_ID_SCHEMA,
          expectedQualifiedItemId: ITEM_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "chest_store",
        toArgs: (params) => ({
          chestId: params.chestId,
          expectedQualifiedItemId: params.expectedQualifiedItemId,
        }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.chest_retrieve,
        label: "Take Item From Chest",
        description:
          "Move one item out of a reachable chest into the Farmhand inventory. chestId and expectedQualifiedItemId must be copied from the MOST RECENT observe result for the current location: chestId is the `chestId` of one `chests` entry, which already names that container's location and tile, and expectedQualifiedItemId is the `qualifiedItemId` of one item in that entry's `items` list, which carries every item the container holds. There is no x, y, expectedTargetId or slot to send - the container and the item are the whole address, so nothing is picked by position. The item id pins the observed item, so one that is gone by then is refused chest_empty rather than substituted. No ItemGrabMenu is opened. Returns chest_retrieved.",
        parameters: Type.Object({
          chestId: OPAQUE_ID_SCHEMA,
          expectedQualifiedItemId: ITEM_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "chest_retrieve",
        toArgs: (params) => ({
          chestId: params.chestId,
          expectedQualifiedItemId: params.expectedQualifiedItemId,
        }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.chop_stump,
        label: "Chop Tree Stump",
        description:
          "Chop one live ordinary tree that is already a stump with the equipped Axe. slot, x, y and expectedTargetId must be copied exactly from the treeStumpTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). The Mod swings the native axe until the stump is cleared. Returns stump_cleared. A mature standing tree is stardew_chop_tree, not this action.",
        parameters: Type.Object({
          slot: TOOL_SLOT_SCHEMA,
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "chop_stump",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.plant_sapling,
        label: "Plant Tree Sapling",
        description:
          "Plant one observed tree sapling on a live lawful tile through the native wild-tree-seed placement path. slot, x, y, expectedQualifiedItemId and expectedTargetId must be copied exactly from the treeSaplingTargets entries of the MOST RECENT observe result (never invent or guess coordinates). Returns sapling_planted with the seed consumed exactly once.",
        parameters: Type.Object({
          slot: TOOL_SLOT_SCHEMA,
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedQualifiedItemId: ITEM_ID_SCHEMA,
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "plant_sapling",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedQualifiedItemId: params.expectedQualifiedItemId,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.cut_weeds,
        label: "Cut Weeds",
        description:
          "Cut one live adjacent Weed with the equipped scythe. slot, x, y and expectedTargetId must be copied exactly from the weedTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). The Mod swings the native scythe until the weed is removed; the family is free, so the stamina cost is an explicit zero. Returns weeds_cut. Standing crops are stardew_scythe_crop, not this action.",
        parameters: Type.Object({
          slot: TOOL_SLOT_SCHEMA,
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "cut_weeds",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.cut_grass,
        label: "Cut Grass",
        description:
          "Cut one live adjacent Grass tuft (a TerrainFeature, distinct from weeds) with the equipped scythe. slot, x, y and expectedTargetId must be copied exactly from the grassTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). The Mod swings the native scythe until the tuft is removed; grassType 1/7 feeds Hay into a silo (hay_unstored 0 = all stored) and grassType 6 drops rare items. Returns grass_cut.",
        parameters: Type.Object({
          slot: TOOL_SLOT_SCHEMA,
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "cut_grass",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.clear_cask,
        label: "Clear Cask",
        description:
          "Clear one live adjacent Cask with a heavy hitter that is not a melee weapon (an Axe, Pickaxe or Hoe); the action takes that tool out of the pack itself and puts the actor's previous selection back, so slot is the number from toolSlots in the MOST RECENT observe result and need not be the held one. x, y and expectedTargetId must be copied exactly from caskTargets. A filled Cask drops its contents and remains; an empty Cask is removed. Returns cask_cleared.",
        parameters: Type.Object({
          slot: TOOL_SLOT_SCHEMA,
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "clear_cask",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  for (const action of ["dress_mannequin", "set_sign_display", "deposit_silo_hay"] as const) {
    const isMannequin = action === "dress_mannequin";
    const isSign = action === "set_sign_display";
    const targetKey = isMannequin ? "mannequinTargets" : isSign ? "signTargets" : "siloTargets";
    const label = isMannequin ? "Dress Mannequin" : isSign ? "Set Sign Display" : "Deposit Silo Hay";
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES[action],
        label,
        description: `${label} using the held inventory item. slot, x, y and expectedTargetId must be copied exactly from the toolSlots and ${targetKey} in the MOST RECENT observe result for the current location; the target id names the exact object, so a stale id is refused rather than applied. The item must be the one that slot really holds, and a refusal names which precondition failed rather than reporting a generic failure.`,
        parameters: Type.Object({
          slot: TOOL_SLOT_SCHEMA,
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action,
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  {
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.toggle_tool_light,
        label: "Toggle Tool Light",
        description:
          "Toggle the Lantern light; the action takes the lantern its own `tool:lantern` claim declares out of the pack and puts the actor's previous selection back, so slot is the number from lanternSlots in the most recent observe result and need not be the held one. The light toggles on the tool itself, not on a world object.",
        parameters: Type.Object({
          slot: TOOL_SLOT_SCHEMA,
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "toggle_tool_light",
        toArgs: (params) => ({ slot: params.slot, x: params.x, y: params.y }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.scythe_crop,
        label: "Scythe Crop",
        description:
          "Scythe one live ready Scythe-method crop. slot, x, y and expectedTargetId must be copied exactly from the scytheCropTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). The native scythe harvest removes the crop and leaves the produce on the ground; the produce is not added to the inventory by this action, so expect ground debris rather than an inventory increase. Returns scythe_crops_harvested.",
        parameters: Type.Object({
          slot: TOOL_SLOT_SCHEMA,
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "scythe_crop",
        toArgs: (params) => ({
          slot: params.slot,
          x: params.x,
          y: params.y,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.craft_item,
        label: "Craft Item",
        description:
          "Craft one learned recipe from the Farmhand's own inventory. expectedTargetId must be copied exactly from the craftingRecipeTargets entries of the MOST RECENT observe result (never invent or guess a recipe). A targetId is the canonical recipe identity, not its display name. An unknown or unlearned recipe fails closed. Items that do not fit are dropped on the ground rather than lost, and the receipt reports the exact conservation evidence. Returns crafted_item_created.",
        parameters: Type.Object({
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "craft_item",
        toArgs: (params) => ({
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.cook_recipe,
        label: "Cook Recipe",
        description:
          "Cook one learned cooking recipe at a live adjacent cooking station. expectedTargetId must be copied exactly from the cookingRecipeTargets entries of the MOST RECENT observe result (never invent or guess a recipe). A targetId is the canonical recipe identity, not its display name. The station adjacency is re-derived and re-checked Mod-side from the live world rather than trusted from the client. Items that do not fit are dropped on the ground rather than lost. Returns dish_cooked.",
        parameters: Type.Object({
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "cook_recipe",
        toArgs: (params) => ({
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.collect_crab_pot_output,
        label: "Collect Crab Pot Output",
        description:
          "Collect the ready output of one live adjacent baited Crab Pot. x, y and expectedTargetId must be copied exactly from the crabPotCollectTargets entries of the MOST RECENT observe result for the current location (never invent or guess coordinates). The Mod re-checks that the pot is really harvest-ready and visually ready before calling the native interaction, so an immature or unbaited pot is rejected rather than torn down. Returns crab_pot_output_collected.",
        parameters: Type.Object({
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "collect_crab_pot_output",
        toArgs: (params) => forwardDeclaredArguments(TILE_TARGET_ARGUMENTS, params),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.ship_item,
        label: "Ship Item",
        description:
          "Move the Farmhand's carried stack of one item into their own live shipping bin. x, y, expectedQualifiedItemId and expectedTargetId must be copied exactly from the shippingBinTargets entries of the MOST RECENT observe result (never invent or guess coordinates). There is no slot argument: walking to a bin takes many ticks and the pack shifts on the way, so the Mod resolves the FIRST carried stack of that item id when it arrives and the receipt names which slot actually shipped. Non-shippable items such as tools are rejected before any native settlement. In a shared world the destination bin depends on the world's separate-wallets setting. Returns item_shipped.",
        parameters: Type.Object({
          x: TILE_COORDINATE_SCHEMA,
          y: TILE_COORDINATE_SCHEMA,
          expectedQualifiedItemId: ITEM_ID_SCHEMA,
          expectedTargetId: OPAQUE_ID_SCHEMA,
          requestId: CALLER_REQUEST_SCHEMA,
          idempotencyKey: CALLER_REQUEST_SCHEMA,
        }),
        action: "ship_item",
        toArgs: (params) => ({
          x: params.x,
          y: params.y,
          expectedQualifiedItemId: params.expectedQualifiedItemId,
          expectedTargetId: params.expectedTargetId,
        }),
      }),
    );
  }
  {
    // constant mount; per-action admission at execution
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.mount_transport,
        label: "Mount a Native Horse",
        description:
          "Mount an advertised named horse in range; x, y and expectedTargetId must be copied exactly from horseTargets in the most recent observe result. The Mod waits for the native mounting animation to finish before reporting success.",
        parameters: Type.Object(
          {
            x: TILE_COORDINATE_SCHEMA,
            y: TILE_COORDINATE_SCHEMA,
            expectedTargetId: OPAQUE_ID_SCHEMA,
            requestId: CALLER_REQUEST_SCHEMA,
            idempotencyKey: CALLER_REQUEST_SCHEMA,
          },
          { additionalProperties: false },
        ),
        action: "mount_transport",
        toArgs: (params) => forwardDeclaredArguments(TILE_TARGET_ARGUMENTS, params),
      }),
    );
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.enter_mine,
        label: "Enter the Mine",
        description:
          "Enter the mine through the live entrance tile OR descend the ladder tile inside a shaft; x, y and expectedTargetId must be copied exactly from mineEntranceTargets in the most recent observe result. The ladder descends exactly one level, derived from the live shaft. This uses normal game progression and does not accept a level selector - to choose a floor, use stardew_select_mine_elevator_floor.",
        parameters: Type.Object(
          {
            x: TILE_COORDINATE_SCHEMA,
            y: TILE_COORDINATE_SCHEMA,
            expectedTargetId: OPAQUE_ID_SCHEMA,
            requestId: CALLER_REQUEST_SCHEMA,
            idempotencyKey: CALLER_REQUEST_SCHEMA,
          },
          { additionalProperties: false },
        ),
        action: "enter_mine",
        toArgs: (params) => forwardDeclaredArguments(TILE_TARGET_ARGUMENTS, params),
      }),
    );
    tools.push(
      makeGameActionTool({
        name: STARDEW_ACTION_TOOL_NAMES.use_raft,
        label: "Launch Stardew Raft",
        description:
          "Launch the equipped Raft from an adjacent native water tile listed in raftTargets. This begins rafting; it does not steer to shore.",
        parameters: Type.Object(
          {
            slot: TOOL_SLOT_SCHEMA,
            x: TILE_COORDINATE_SCHEMA,
            y: TILE_COORDINATE_SCHEMA,
            requestId: CALLER_REQUEST_SCHEMA,
            idempotencyKey: CALLER_REQUEST_SCHEMA,
          },
          { additionalProperties: false },
        ),
        action: "use_raft",
        toArgs: (params) => ({ slot: params.slot, x: params.x, y: params.y }),
      }),
    );
  }

  // THE ONE cancellation the model may use, and it is deliberately NOT an action: it is absent from the action
  // registry, carries no game semantics of its own, and can only stop the execution the LATEST observation named.
  // A generic cancel stays refused, which is what the two shipped assertions pin; the narrowed primitive is gated
  // twice over - here on the observation's `cancelSafe`, and again in the Mod on the same reason code, so a race
  // between the observation and the request cannot cancel a committed action.
  tools.push(
    defineTool({
      name: "stardew_stop_action",
      label: "Stop the current Stardew action",
      description:
        "Stop the action that currently holds the character's body, so a different action can be issued. Read the latest observation first: this stops ONLY the execution that observation named (its requestId/executionId), and only while it says the hold can still be released (`activeExecution.cancelSafe === true`). When the action is already past its cancel point the tool refuses by name - the action is committed and you must wait for its terminal receipt. It never changes the world beyond ending that action.",
      parameters: Type.Object({}),
      execute: async () => {
        const snapshot = integration.state.snapshot;
        if (!integration.state.connected || snapshot === null) return receiptResult(null, "integration_not_ready");
        const active = snapshot.activeExecution ?? null;
        if (active === null) return receiptResult(null, "no_active_execution");
        if (active.cancelSafe !== true)
          return receiptResult(null, `action_past_cancel_point: phase=${active.phase ?? "unknown"};cancel_safe=false`);
        try {
          // The Mod's own gate keys on this reason code, so the player STOP and the worker's teardown keep their
          // semantics while a MODEL stop can be refused.
          return receiptResult(
            await integration.cancel(active.requestId, active.executionId, MODEL_STOP_REASON_CODE),
            null,
          );
        } catch (error) {
          return receiptResult(
            null,
            error instanceof Error ? error.message.replace(/^bridge_rejected:/, "") : "bridge_cancel_failed",
            "write_unknown",
          );
        }
      },
    }),
  );

  return tools;
}
async function executeGameAction(
  integration: MoveCapableIntegration,
  policy: ActionPolicy | undefined,
  dispatchAdmissionFactory: IntegrationDispatchAdmissionFactory,
  action: StardewActionId,
  args: Readonly<Record<string, unknown>>,
  callerIds: Readonly<{ requestId?: string; idempotencyKey?: string }>,
  trace: RunTrace | undefined,
) {
  const snapshot = integration.state.snapshot;
  if (!integration.state.connected || snapshot === null) return receiptResult(null, "integration_not_ready");
  const currentCapabilities = integration.state.capabilities.filter((capability) =>
    snapshot.capabilities.includes(capability),
  );
  if (!currentCapabilities.includes(action)) return receiptResult(null, "capability_not_declared");
  if (
    !visibleActionsFromModCatalog(integration.state.catalogRegistrations ?? [], currentCapabilities, policy).some(
      (entry) => entry.actionId === action,
    )
  )
    return receiptResult(null, "action_policy_denied");

  // The shared wrapper owns identity, revision, and deadline construction; tool closures contribute only an action
  // literal plus typed args.
  //
  // The deadline is the ACTION's own budget when the Mod publishes one: `sleep`'s watchdog is 600s because a
  // night waits on other players, the save and the day start, and a hard-coded 30s made it time out by construction
  // (measured 2026-10-17). The 30s default stays for every action that publishes no watchdog, and the Mod's budget
  // is clamped to the bridge's own maximum so neither side can be handed an unbounded wait.
  const publishedWatchdogMs = integration.state.catalogRegistrations?.find(
    (registration) => registration.actionId === action,
  )?.descriptor?.watchdogMs;
  const deadlineBudgetMs =
    typeof publishedWatchdogMs === "number" && Number.isSafeInteger(publishedWatchdogMs) && publishedWatchdogMs > 0
      ? Math.min(publishedWatchdogMs, MAX_DISPATCH_DEADLINE_MS)
      : DEFAULT_DISPATCH_DEADLINE_MS;
  const request: ExecutionRequest = {
    requestId: callerIds.requestId ?? randomUUID(),
    idempotencyKey: callerIds.idempotencyKey ?? randomUUID(),
    action,
    args,
    expectedRevision: snapshot.revision,
    deadlineMs: Date.now() + deadlineBudgetMs,
  };
  const invalid = validateExecutionRequest(request, snapshot);
  if (invalid !== null) return receiptResult(null, invalid);
  // One span per dispatch, from the Host's send decision to the answer that settles it: the same two moments the
  // hand-built action trace stamped, so exec/think/idle stay derivable (see run-trace-cadence.ts).
  const actionSpan = trace?.begin(RUN_SPAN_NAMES.action, { actionId: action, requestId: request.requestId });
  try {
    const receipt = await executeBridge(
      integration,
      dispatchAdmissionFactory,
      request,
      trace,
      actionSpan?.spanId ?? null,
    );
    actionSpan?.end({ state: receipt.state, reasonCode: receipt.reasonCode });
    return receiptResult(receipt, null);
  } catch (error) {
    const reasonCode =
      error instanceof Error ? error.message.replace(/^bridge_rejected:/, "") : "bridge_execute_failed";
    actionSpan?.end({ state: "rejected", reasonCode });
    // Whether the native write happened is the one fact the caller needs and
    // cannot infer from a flat "not created". executeBridge tags the failure
    // with the phase it failed in, so the message can say which it was: a
    // refusal before any write, or a write whose outcome is unknown. The audit
    // that motivated this saw the Agent read "not created" for an action the
    // world had already performed, invent a cause, and re-dispatch it.
    return receiptResult(null, reasonCode, error instanceof Error ? writePhaseOf(error) : "write_unknown");
  }
}

/** How far a failed dispatch got, read from the tag executeBridge attached. */
function writePhaseOf(error: Error): "not_written" | "write_unknown" {
  return error.message.startsWith("write_unknown:") ? "write_unknown" : "not_written";
}
async function executeBridge(
  integration: MoveCapableIntegration,
  dispatchAdmissionFactory: IntegrationDispatchAdmissionFactory,
  request: ExecutionRequest,
  trace: RunTrace | undefined,
  actionSpanId: string | null,
): Promise<ExecutionReceipt> {
  if (!integration.state.connected) {
    throw new Error("bridge_rejected:integration_not_ready");
  }
  if (Date.now() > request.deadlineMs) {
    throw new Error("bridge_rejected:expired_deadline");
  }
  /* Never retain an admission in the tool closure: STOP fences the final pre-write boundary. */
  const admission = dispatchAdmissionFactory();
  const admissionSpan = trace?.begin(
    RUN_SPAN_NAMES.admission,
    { actionId: request.action, requestId: request.requestId },
    actionSpanId,
  );
  // Register the immutable tuple before the write so a lost first receipt can
  // be queried after a fresh authenticated binding without reissuing action.
  const dispatch = {
    ...admission.owner,
    requestId: request.requestId,
    idempotencyKey: request.idempotencyKey,
    recoveryMaterial: {
      logicalActionId: request.requestId,
      request,
    },
    ...(admissionSpan === undefined ? {} : { traceParentId: admissionSpan.spanId }),
  };
  try {
    await admission.observer.beforeWrite(dispatch);
  } catch (error) {
    admissionSpan?.end({ failed: describeTraceFailure(error) });
    throw error;
  }
  admissionSpan?.end({ state: "prepared" });
  try {
    const receipt = await (trace === undefined
      ? integration.execute(request)
      : trace.span(
          RUN_SPAN_NAMES.bridgeCall,
          { actionId: request.action, requestId: request.requestId },
          () => integration.execute(request),
          actionSpanId,
        ));
    await admission.observer.bindReceipt(receipt);
    return receipt;
  } catch (error) {
    // An explicit Mod rejection is authoritative proof that no native write
    // happened (the Mod returns it before routing, e.g. stale_snapshot or an
    // invalid envelope). Marking such a dispatch uncertain would turn a
    // provably-unstarted action into a recovery obligation and invite a replay
    // the authority never asked for. Only a failure that leaves the write
    // outcome genuinely unknown becomes uncertain.
    if (!isAuthoritativeRejection(error)) {
      await admission.observer.markUncertain(dispatch);
    } else {
      await admission.observer.markAuthoritativelyRejected(dispatch);
    }
    // Tag the failure with the phase so the caller can say which it was. A
    // refusal carries bridge_rejected:* and proves no write; anything else
    // happened after the request reached the bridge and its outcome is unknown.
    const reason = error instanceof Error ? error.message : "bridge_execute_failed";
    throw new Error(isAuthoritativeRejection(error) ? reason : `write_unknown:${reason}`);
  }
}

/**
 * The bridge answers a refusal with `bridge_rejected:<reasonCode>`; that is the
 * authoritative "not accepted" signal produced before any native dispatch.
 * Transport faults, timeouts, and unexpected shapes stay unknown on purpose.
 */
function isAuthoritativeRejection(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("bridge_rejected:");
}

function receiptResult(
  receipt: ExecutionReceipt | null,
  reasonCode: string | null,
  writePhase: "not_written" | "write_unknown" = "not_written",
) {
  // The failure text states whether the world changed. "Not created" is only
  // true when the refusal happened before any write; otherwise the caller is
  // told the outcome is unknown and must not assume nothing happened.
  const failureText =
    writePhase === "write_unknown"
      ? `Game action outcome is unknown: ${reasonCode}. The request reached the bridge, so the world may have changed - do not re-issue it; observe the world to determine what happened.`
      : `Game action was not created: ${reasonCode}. Nothing was written; the world is unchanged.`;
  // A hold the Mod named arrives with the facts a countermeasure needs, so the Agent is told what to DO and not
  // only what failed. The sentence comes from the production helper the live probe also asserts against, so a
  // probe can never pass on wording the tool layer does not actually emit.
  const remedy = describeBodyHoldRefusal(receipt?.reasonCode ?? reasonCode, receipt?.evidence);
  return {
    content: [
      {
        type: "text" as const,
        text:
          (receipt === null ? failureText : JSON.stringify(receipt)) + (remedy === null ? "" : `\n${remedy.guidance}`),
      },
    ],
    details: {
      receiptJson: receipt === null ? null : JSON.stringify(receipt),
      reasonCode,
      writePhase,
      ...(remedy === null ? {} : { remedy }),
    },
  };
}
