import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { BODY_WAY_FORWARD_EN, BODY_WAY_FORWARD_ZH, formatBodyState } from "./game-world-vocabulary.js";

/**
 * `body_state_names_a_way_out`: a held body says who holds it and what to do next, never only that it cannot act.
 *
 * <p>
 * MEASURED 2026-11-13 (`round47`, the companion's own debrief, verbatim): "进入农舍后状态变成 身体: 忙（不可行动），我把
 * 「身体忙」读成「这轮不能动」，于是不再提交任何东西。这是判断错误：身体忙说明引擎占着这个 actor，我该做的是查状态/等
 * 结算，看它什么时候释放，而不是默认放弃。" The line she read named neither the holder nor the way out, so the only
 * reading available to her was a prohibition - and she obeyed it for the rest of the run.
 * </p>
 * <p>
 * The same defect class as `soil_not_diggable` before it named a tile: a refusal that names no address. The guard below
 * is the property, not today's wording - the line must carry the holder, whether a command can take the body, and one
 * of the declared way-forward answers, and the word that made her stop submitting must not appear at all.
 * </p>
 */

/** The wire's own schema document: the disposition set the Mod publishes and the Host validates. */
const WIRE_SCHEMA_PATH = fileURLToPath(new URL("../../protocol/bridge-v1.schema.json", import.meta.url));

/**
 * The closed set of `actorDispositionKind` values, read from the wire's schema rather than retyped here.
 *
 * The population has to come from the authority: `protocol.ts` validates every snapshot against this enum
 * (`invalid_snapshot:actorDispositionKind:<value>`), so a kind added to the Mod and the wire without a line here is a
 * body state she would read as `未知` forever - and a hand-written list in this test could never notice.
 */
function wireDispositionKinds(): readonly string[] {
  const schema = JSON.parse(readFileSync(WIRE_SCHEMA_PATH, "utf8")) as unknown;
  const found = findDispositionEnum(schema);
  assert.ok(
    found !== undefined,
    "the wire schema declares no actorDispositionKind enum any more: find its replacement",
  );
  return found;
}

function findDispositionEnum(node: unknown): readonly string[] | undefined {
  if (node === null || typeof node !== "object") return undefined;
  const record = node as Record<string, unknown>;
  const properties = record.properties;
  if (properties !== null && typeof properties === "object") {
    const declared = (properties as Record<string, unknown>).actorDispositionKind;
    if (declared !== null && typeof declared === "object") {
      const values = (declared as Record<string, unknown>).enum;
      if (Array.isArray(values) && values.every((value) => typeof value === "string")) return values as string[];
    }
  }
  for (const value of Object.values(record)) {
    const nested = findDispositionEnum(value);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/** The answers the line may offer, in both languages, read from the module's own vocabulary rather than retyped. */
const WAY_FORWARD_ZH = Object.values(BODY_WAY_FORWARD_ZH);
const WAY_FORWARD_EN = Object.values(BODY_WAY_FORWARD_EN);

/**
 * The property: a held-body line names its holder, says whether a command can take the body, and names the way
 * forward. Throwing here is what makes the guard reusable as its own falsifier - the pre-change lines are fed to it.
 */
function assertBodyLineNamesAWayOut(line: string, holder: string, zh = true): void {
  const ways = zh ? WAY_FORWARD_ZH : WAY_FORWARD_EN;
  assert.match(
    line,
    new RegExp(zh ? `持有: ${holder}` : `held by: ${holder}`, "u"),
    `the line names the holder: ${line}`,
  );
  assert.match(line, new RegExp(zh ? "可由指令接管: (是|否|未知)" : "command can take over: (yes|no|unknown)", "u"));
  assert.ok(
    ways.some((way) => line.includes(way)),
    `the line names one of the declared ways forward (${ways.join(" / ")}), not only that the body is held: ${line}`,
  );
  assert.ok(
    !line.includes("不可行动") && !line.includes("not actionable"),
    `"cannot act" is the reading that made her stop submitting; a line may not end there: ${line}`,
  );
}

test("body_state_names_a_way_out: every wire disposition does, in both languages", () => {
  const kinds = wireDispositionKinds();
  assert.ok(kinds.length > 0, "zero population is blocked, never green: no disposition kinds were read");
  const held = kinds.filter((kind) => kind !== "idle");
  assert.ok(held.length > 0, "the disposition set declares no hold at all: this guard would agree with itself");

  for (const kind of held) {
    for (const owned of [false, true]) {
      const line = formatBodyState(
        { actionable: false, actorDispositionKind: kind, actorDispositionActionOwned: owned },
        true,
      );
      assertBodyLineNamesAWayOut(line, kind);
      const english = formatBodyState(
        { actionable: false, actorDispositionKind: kind, actorDispositionActionOwned: owned },
        false,
      );
      assertBodyLineNamesAWayOut(english, kind, false);
    }
  }
});

test("body_state_names_a_way_out: the two lines she actually read are REFUSED by the guard", () => {
  // THE FALSIFIER, quoting `round47`'s prompt. `身体: 忙（不可行动）` is the farmhouse door; `身体: 忙（modal）` is the
  // rendering this repo shipped for a named disposition. Both are held bodies that name no way out, so the guard that
  // the current line passes must reject them - otherwise it is decoration.
  assert.throws(
    () => assertBodyLineNamesAWayOut("身体: 忙（不可行动）", "modal"),
    /the line names the holder|the line names one of the declared ways forward|made her stop submitting/u,
  );
  assert.throws(
    () => assertBodyLineNamesAWayOut("身体: 忙（modal）", "modal"),
    /the line names the holder: 身体|the line names one of the declared ways forward/u,
  );
});

test("body_state_names_a_way_out: a body held by nothing named says 未知, never 不可行动", () => {
  const line = formatBodyState({ actionable: false }, true);
  assertBodyLineNamesAWayOut(line, "未知");
  assert.ok(line.includes("下一步: 未知"), `with no disposition there is no way to name a way forward: ${line}`);
  assert.equal(
    line.includes("空闲"),
    false,
    "a body the Mod says is not actionable is not free, and silence would read as free",
  );
});

test("body_state_names_a_way_out: what the snapshot does not project is silent, not free", () => {
  assert.equal(formatBodyState({}, true), "", "no reading at all must claim nothing");
  assert.equal(formatBodyState({ actorDispositionKind: "idle", actionable: true }, true), "身体: 空闲");
});

test("body_state_names_a_way_out: the ownership flag decides the way forward for a modal", () => {
  // `actorDispositionActionOwned` is the Mod's own statement that the mounted modal belongs to an execution of ours.
  // Reading it is what keeps this from being a second guess: an owned modal is being closed by that execution, so the
  // release is its settlement; a modal nobody owns has to be answered or closed by the world first.
  const owned = formatBodyState(
    { actionable: false, actorDispositionKind: "modal", actorDispositionActionOwned: true },
    true,
  );
  const unowned = formatBodyState(
    { actionable: false, actorDispositionKind: "modal", actorDispositionActionOwned: false },
    true,
  );
  assert.ok(owned.includes("下一步: 等结算"), `an owned modal is settled by us: ${owned}`);
  assert.ok(unowned.includes("下一步: 下一回合"), `a modal nobody owns ends with the world: ${unowned}`);
  assert.notEqual(owned, unowned, "if the flag changed nothing, the line would be guessing");
});

test("body_state_names_a_way_out: a transient hold is the one a command can wait out", () => {
  const transient = formatBodyState({ actionable: false, actorDispositionKind: "transient" }, true);
  assert.ok(transient.includes("可由指令接管: 是"), `a transient hold is retryable: ${transient}`);
  assert.ok(transient.includes("下一步: 重试可行"));
  for (const kind of ["event", "pass_out", "modal"]) {
    const line = formatBodyState({ actionable: false, actorDispositionKind: kind }, true);
    assert.ok(line.includes("可由指令接管: 否"), `nothing shortens a ${kind}: ${line}`);
    assert.equal(line.includes("重试可行"), false, `a ${kind} is not a 2-second window: ${line}`);
  }
});

test("body_state_names_a_way_out: the holder's own detail is named when the wire publishes it", () => {
  const line = formatBodyState(
    { actionable: false, actorDispositionKind: "modal", actorDispositionDetail: "DialogueBox" },
    true,
  );
  assert.ok(line.includes("持有: modal/DialogueBox"), `the holder is what the Mod named, not only its kind: ${line}`);
  const noDetail = formatBodyState(
    { actionable: false, actorDispositionKind: "modal", actorDispositionDetail: null },
    true,
  );
  assert.ok(noDetail.includes("持有: modal ·"), `a null detail adds nothing rather than a placeholder: ${noDetail}`);
});

test("body_state_names_a_way_out: a kind this table has not met stays unknown instead of invented", () => {
  // The population is the wire's enum, so this is about a FUTURE member: the Mod adds a kind, the schema carries it,
  // and this line must say it cannot tell rather than guess a hold the Mod never stated.
  const line = formatBodyState({ actionable: false, actorDispositionKind: "minigame_mount" }, true);
  assert.ok(line.includes("持有: minigame_mount"), `the unknown kind is still named: ${line}`);
  assert.ok(line.includes("下一步: 未知"), `and its way forward is declared unknown: ${line}`);
});

test("body_state_names_a_way_out: the answers are a closed set, so a reader can act on every one", () => {
  // Every way-forward this module can print is one of the four its vocabulary declares: a fifth answer would be a word
  // no caller can branch on. The population is the schema's kinds plus the unheld body, so a new kind is measured too.
  const lines: string[] = [];
  for (const kind of [...wireDispositionKinds(), "minigame_mount"]) {
    for (const owned of [false, true]) {
      lines.push(
        formatBodyState({ actionable: false, actorDispositionKind: kind, actorDispositionActionOwned: owned }, true),
      );
    }
  }
  lines.push(formatBodyState({ actionable: false }, true));
  assert.ok(lines.length > 0, "zero answers measured is not a passing reading");
  for (const line of lines) {
    const matched = /下一步: (?<answer>[^·]+)$/u.exec(line);
    assert.ok(matched?.groups !== undefined, `every held-body line ends with its way forward: ${line}`);
    const answer = (matched.groups.answer ?? "").trim();
    assert.ok(WAY_FORWARD_ZH.includes(answer), `"${answer}" is a fifth answer nobody declared: ${line}`);
  }
});
