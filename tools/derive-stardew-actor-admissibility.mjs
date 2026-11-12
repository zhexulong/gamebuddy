/**
 * Derive `actor-admissibility.v1.json` - the body-hold contract two gates have been blocked on.
 *
 * WHAT IS DERIVED, AND FROM WHAT. Nothing about the facts is hand-listed, because a hand-listed population is how a
 * fact arrives without a release, a row, or a gate that notices either:
 *
 *   - the POPULATION is the parameter list of `ActorWorldFacts` (`integrations/stardew/WorldModel.cs`), in declaration
 *     order, so a member added there appears here on the next run and a member removed here disappears;
 *   - each fact's ENGINE READ is the argument `WorldModel.ReadFacts` passes for that parameter (positionally - the two
 *     `new ActorWorldFacts(...)` calls must agree on arity, or derivation fails), and the read's declaration is
 *     resolved in the decompiled tree;
 *   - each fact's KIND, WIRE SPELLING, REASON CODE and TRANSIENT KIND come from the branch of `WorldModel.Classify`
 *     that tests it (through `HasMountedModal` where the branch names a helper) crossed with the two switch
 *     expressions `KindForWire` and `HoldReasonCode`;
 *   - each read's HOLDING PREDICATE (`holdsWhen`) comes from the comparison `Classify` applies to it, or from the
 *     expression `ReadFacts` reads it with - that predicate is what the hold-sufficiency gate evaluates an engine write
 *     against, so a write that CLEARS a fact can no longer count as accompaniment for a hold.
 *
 * WHAT IS AUTHORED, and re-verified by the gates on every run against the tree it cites:
 *
 *   - the RELEASE of each fact: the engine line whose write clears it, and where the engine releases the BODY;
 *   - the RESIDUAL: one row per engine site that writes `canMove = false` with no declared fact established there,
 *     each with the fact that names it (or a stated reason no fact can), the engine line that releases it, and the
 *     evidence a reader would need to check the judgement;
 *   - the sites the analysis cannot attribute at all, named with the reason and what would settle them;
 *   - the decision sites and derived inputs the admissibility gate adjudicates.
 *
 * A row is a claim about Stardew's source, so the gate re-reads the cited line and refuses the claim when the line no
 * longer says what the row says it does. That is the direction that matters: the contract cannot drift silently, and
 * the gate does not read this file's mind.
 *
 * Determinism: the output is a pure function of the two sources above (no clock, no absolute path, no map iteration
 * order), so a second run is byte-identical. The script prints whether it was.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WORLD_MODEL = "integrations/stardew/WorldModel.cs";
const ENGINE_ROOT = "ref/external/StardewValleyDecompiled/Stardew Valley";
const OUTPUT = "integrations/stardew/action-development/contracts/actor-admissibility/actor-admissibility.v1.json";

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const normalize = (line) => line.replace(/\s+/gu, " ").trim();
const lineAt = (text, index) => text.slice(0, index).split("\n").length;

/** The text between the bracket at `open` and its match, and the index of that match. */
function balanced(text, open) {
  const opener = text[open];
  const closer = opener === "(" ? ")" : opener === "{" ? "}" : "]";
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === opener) depth += 1;
    else if (text[i] === closer) {
      depth -= 1;
      if (depth === 0) return { text: text.slice(open + 1, i), start: open + 1, end: i };
    }
  }
  throw new Error(`unbalanced ${opener} at ${open}`);
}

/** Split a parameter/argument list on its top-level commas, with each part's offset. */
function splitTopLevel(text, base) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    // Angle brackets are NOT counted: a comparison inside an argument (`player.freezePause > 0`) would
    // otherwise close a bracket that was never opened and silently merge every later argument.
    if (ch === "(" || ch === "{" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "}" || ch === "]") depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push({ text: text.slice(from, i), at: base + from });
      from = i + 1;
    }
  }
  if (text.slice(from).trim() !== "") parts.push({ text: text.slice(from), at: base + from });
  return parts;
}

/**
 * Blank `//` comments so a commented-out parameter is not read as a member.
 *
 * The comment is replaced by spaces rather than deleted: every caller then reports the REAL line it read, and a
 * deletion would shift every offset after it (the first run of this generator reported line numbers 20 lines early
 * for exactly that reason).
 */
const withoutLineComments = (text) =>
  text
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/u, (comment) => " ".repeat(comment.length)))
    .join("\n");

// ---------------------------------------------------------------------------------------------- the fact union

function factUnion(source) {
  const at = source.indexOf("record struct ActorWorldFacts(");
  if (at < 0) throw new Error("ActorWorldFacts is not declared in WorldModel.cs");
  const list = balanced(source, source.indexOf("(", at));
  return splitTopLevel(withoutLineComments(list.text), list.start).map((part) => {
    const text = part.text.trim();
    const name = /([A-Za-z_]\w*)\s*$/u.exec(text)?.[1];
    if (name === undefined) throw new Error(`parameter without a name: ${text}`);
    return { name, type: text.slice(0, text.length - name.length).trim(), line: lineAt(source, part.at) };
  });
}

// ---------------------------------------------------------------------------------------------- ReadFacts

function readFacts(source, factNames) {
  const at = source.indexOf("internal static ActorWorldFacts ReadFacts(Farmer? player)");
  if (at < 0) throw new Error("ReadFacts is not declared in WorldModel.cs");
  const body = balanced(source, source.indexOf("{", at));
  // Comments are blanked rather than removed, so every offset still points at the same source character and the
  // line numbers below stay the file's own.
  const stripped = withoutLineComments(body.text);
  const locals = new Map();
  for (const match of stripped.matchAll(/^\s*(?:bool|int|float|string\??)\s+([A-Za-z_]\w*)\s*=\s*([^;]+);/gmu))
    locals.set(match[1], { expression: match[2].trim(), line: lineAt(source, body.start + match.index) });

  const calls = [];
  for (let i = stripped.indexOf("new ActorWorldFacts("); i >= 0; i = stripped.indexOf("new ActorWorldFacts(", i + 1)) {
    const args = balanced(stripped, stripped.indexOf("(", i));
    calls.push(
      splitTopLevel(args.text, args.start).map((part) => ({
        expression: part.text.trim(),
        line: lineAt(source, body.start + part.at),
      })),
    );
  }
  if (calls.length !== 2) throw new Error(`expected the null-player and player reads, found ${calls.length} calls`);
  for (const call of calls)
    if (call.length !== factNames.length)
      throw new Error(`a ReadFacts call passes ${call.length} arguments for ${factNames.length} facts`);

  // The player-side call is the one whose arguments name `player`; the null side passes literals.
  const playerCall = calls.find((call) => call.some((arg) => /\bplayer\b/u.test(arg.expression)));
  const nullCall = calls.find((call) => call !== playerCall);
  return factNames.map((name, index) => {
    const argument = playerCall[index];
    const local = locals.get(argument.expression);
    const expression = local?.expression ?? argument.expression;
    const nullExpression = nullCall[index].expression;
    return {
      expression,
      expressionLine: local?.line ?? argument.line,
      argument: argument.expression,
      argumentLine: argument.line,
      nullArgument: nullExpression,
      // A farmer fact is one whose null-player value is a literal (a body nobody is bound to cannot hold);
      // a Game1 fact is read whatever the player is.
      readsFromGame1: !/^(?:false|0f?|null)$/u.test(nullExpression),
    };
  });
}

/** The engine members an argument expression reads, in source order, without duplicates. */
function engineReads(expression) {
  const members = [];
  let rest = expression;
  rest = rest.replace(/\bplayer\.FarmerSprite\.([A-Za-z_]\w*)/gu, (_, member) => {
    members.push(`FarmerSprite.${member}`);
    return " ";
  });
  rest = rest.replace(/\bplayer\.([A-Za-z_]\w*)/gu, (_, member) => {
    members.push(`Farmer.${member}`);
    return " ";
  });
  rest = rest.replace(/\bGame1\.([A-Za-z_]\w*)/gu, (_, member) => {
    members.push(`Game1.${member}`);
    return " ";
  });
  if (members.length === 0) throw new Error(`no engine read in "${expression}"`);
  return [...new Set(members)];
}

/**
 * Every `.cs` file in the decompiled tree by basename.
 *
 * The decompiled tree mirrors NAMESPACES as directories (`StardewValley.Locations/BusStop.cs`), so the file that
 * declares `Game1` is not at `StardewValley/Game1.cs` from the root - the first run of this generator resolved every
 * declaration against the wrong path and reported `null` for all of them.
 */
const engineFileIndex = (() => {
  const index = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".cs") && !index.has(entry.name)) index.set(entry.name, path);
    }
  };
  walk(ENGINE_ROOT);
  return index;
})();

/** Where a `Class.member` read is declared in the decompiled tree. */
function engineDeclaration(member) {
  const [type, name] = member.split(".");
  const file = engineFileIndex.get(`${type}.cs`);
  if (file === undefined) return null;
  const text = read(file);
  const declaration = new RegExp(
    `^\\s*(?:public|internal|private|protected|readonly|static|virtual|override)[^;=()]*\\b${name}\\b\\s*(?:;[^;]*$|=|=>|\\{|$)`,
  );
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1)
    if (declaration.test(lines[i])) return { file, line: i + 1, declaration: normalize(lines[i]) };
  return null;
}

/** The backing member a read resolves to: `public static bool isWarping => _isWarping` reads `_isWarping`. */
function backingMember(member) {
  const declaration = engineDeclaration(member)?.declaration;
  if (declaration === undefined) return member;
  const expressionBody = /=>\s*([A-Za-z_]\w*)\s*;?$/u.exec(declaration);
  if (expressionBody === null) return member;
  return `${member.split(".")[0]}.${expressionBody[1]}`;
}

// ---------------------------------------------------------------------------------------------- Classify

const CONSTANTS = (source) => {
  const constants = new Map();
  for (const match of source.matchAll(/\bconst\s+(?:int|float)\s+([A-Za-z_]\w*)\s*=\s*(-?[\d.]+)f?\s*;/gu))
    constants.set(match[1], match[2]);
  return constants;
};

/** The `facts.<Member>` names a condition establishes, following a same-file helper one level. */
function factsInCondition(condition, source) {
  const direct = [...condition.matchAll(/\bfacts\.([A-Za-z_]\w*)/gu)].map((match) => match[1]);
  if (direct.length > 0) return [...new Set(direct)];
  const helper = /\b([A-Za-z_]\w*)\s*\(\s*facts\s*\)/u.exec(condition)?.[1];
  if (helper === undefined) return [];
  const at = source.indexOf(`static bool ${helper}(in ActorWorldFacts facts)`);
  if (at < 0) return [];
  // A helper may be expression-bodied (`=> a || b;`), in which case there is no brace to walk - and reading the
  // next method's body instead would attribute a different method's facts to this branch.
  const head = source.slice(at, source.indexOf("\n", at));
  const body = head.includes("=>")
    ? { text: head.slice(head.indexOf("=>")) }
    : balanced(source, source.indexOf("{", at));
  return [...new Set([...body.text.matchAll(/\bfacts\.([A-Za-z_]\w*)/gu)].map((match) => match[1]))];
}

/**
 * The branches of `Classify`, in precedence order, each with the facts it decides, the kind it returns and the
 * transient kind it names. A return is attributed to the INNERMOST enclosing `if` that names a fact, which is what
 * makes the nested `facts.MenuType is { } menuType` inside a `HasMountedModal(facts)` branch read as `MenuType`
 * while the branch's own fallback return reads as both modal facts.
 */
function classifyBranches(source) {
  const at = source.indexOf("internal static ActorDisposition Classify(in ActorWorldFacts facts)");
  if (at < 0) throw new Error("Classify is not declared in WorldModel.cs");
  const body = balanced(source, source.indexOf("{", at));
  const text = withoutLineComments(body.text);
  const stack = [];
  const branches = [];
  let pendingCondition = null;
  for (let i = 0; i < text.length; i += 1) {
    if (text.startsWith("if (", i)) {
      const condition = balanced(text, i + 3).text;
      pendingCondition = condition;
      i += 3 + condition.length;
      continue;
    }
    if (text[i] === "{") {
      stack.push({
        condition: pendingCondition,
        facts: pendingCondition === null ? [] : factsInCondition(pendingCondition, source),
      });
      pendingCondition = null;
      continue;
    }
    if (text[i] === "}") {
      stack.pop();
      continue;
    }
    if (text.startsWith("return new ActorDisposition(", i)) {
      const call = balanced(text, i + "return new ActorDisposition".length);
      const args = splitTopLevel(call.text, call.start);
      const kind = /ActorDispositionKind\.([A-Za-z_]\w*)/u.exec(args[0].text)?.[1];
      const transient = /^\s*"([^"]+)"\s*$/u.exec(args[3]?.text ?? "")?.[1] ?? null;
      const frame = [...stack].reverse().find((entry) => entry.facts.length > 0);
      branches.push({
        precedence: branches.length + 1,
        condition: normalize(frame?.condition ?? ""),
        facts: frame?.facts ?? [],
        kind,
        transientKind: transient,
        line: lineAt(source, body.start + call.start),
      });
      i = call.end;
    }
  }
  return branches;
}

/** A `kind switch` expression's arms, e.g. KindForWire / HoldReasonCode. */
function kindSwitch(source, signature) {
  const at = source.indexOf(signature);
  if (at < 0) throw new Error(`switch not found: ${signature}`);
  const body = balanced(source, source.indexOf("{", at));
  const arms = new Map();
  for (const match of body.text.matchAll(/ActorDispositionKind\.([A-Za-z_]\w*)\s*=>\s*"([^"]+)"/gu))
    arms.set(match[1], match[2]);
  // `HoldReasonCode` spells its last resort as the default arm (`_ => "player_not_actionable"`), which is the word
  // for the state that is NOT a hold; a switch that states it explicitly wins over its own default.
  const fallback = /_\s*=>\s*"([^"]+)"/u.exec(body.text)?.[1];
  if (fallback !== undefined) arms.fallback = fallback;
  return arms;
}

// ---------------------------------------------------------------------------------------------- holdsWhen

/**
 * The predicate a declared read is HOLDING under, as `{ relation, value }` over the engine member.
 *
 * `<member> = <clearing value>` is a write that RELEASES the fact, and the hold-sufficiency gate must not count it as
 * accompaniment - a write that clears a fact cannot establish the hold the fact is supposed to name. This is the
 * predicate that decides the difference, so it is derived from three things the Mod and the engine already state:
 * the comparison `Classify` applies to the fact (`Stamina <= -15`), the comparison `ReadFacts` reads the member with
 * (`freezePause > 0`, `toolPower is { Value: not 0 }`), and the DECLARED TYPE of the member itself (`bool`,
 * `NetInt`, `IClickableMenu`). Nothing here is authored.
 */
function holdsWhen({ fact, member, readExpression, condition, constants }) {
  const name = member.split(".").slice(-1)[0];
  const comparison = new RegExp(`facts\\.${fact}\\s*(<=|>=|<|>|==|!=)\\s*([A-Za-z_]\\w*|-?[\\d.]+f?)`, "u").exec(
    condition,
  );
  if (comparison !== null) {
    const raw = comparison[2];
    const value = constants.get(raw) ?? raw.replace(/f$/u, "");
    return { relation: comparison[1], value: Number(value) };
  }
  const declaration = engineDeclaration(member)?.declaration ?? "";
  // The declared TYPE, read as the token before the member's own name - the shape a declaration takes here has no
  // reliable terminator (`public bool UsingTool` ends at the member, `public static bool eventUp;` at a semicolon).
  const tokens = declaration
    .replace(/[;={()]/gu, " ")
    .split(/\s+/u)
    .filter(Boolean);
  const nameAt = tokens.indexOf(name);
  const declaredType = nameAt > 0 ? tokens[nameAt - 1] : "";
  if (declaredType.includes("bool")) return { relation: "=", value: true };
  if (/^(?:int|long|float|double|Net[A-Z]\w*)$/u.test(declaredType)) {
    const inline = new RegExp(`player\\.${name}\\s*(<=|>=|<|>|==|!=)\\s*(-?[\\d.]+)f?`, "u").exec(readExpression);
    if (inline !== null) return { relation: inline[1], value: Number(inline[2]) };
    if (/Value:\s*not\s+0/u.test(readExpression)) return { relation: "!=", value: 0 };
    return { relation: "!=", value: 0 };
  }
  return { relation: "!=", value: null };
}

// ---------------------------------------------------------------------------------------------- authored releases

/**
 * The engine's release of each fact, one entry per declared read plus one for the body.
 *
 * `anchor` is the engine line whose write clears the fact; `bodyRelease` is where the engine gives the BODY back
 * (a `CanMove = true` write, a `forceCanMove()` call), or a stated mechanism for the holds that never write the body
 * flag at all. Every anchor and every statement is re-read by the gate, so a line that moves, changes, or disappears
 * turns the claim red instead of quietly describing another line.
 */
const RELEASES = {
  EventUp: {
    kind: "event-end",
    anchor: "StardewValley/Game1.cs:7216",
    reads: ["Game1.eventUp"],
    bodyRelease: { anchor: "StardewValley/Game1.cs:7217" },
    bound: "the whole scene, minutes",
  },
  MenuType: {
    kind: "menu-closed",
    anchor: "StardewValley/Game1.cs:6130",
    reads: ["Game1.activeClickableMenu"],
    bodyRelease: {
      mechanism:
        "a mounted menu holds the body through the engine's own control-input gate (`!globalFade && !freezeControls && activeClickableMenu == null`, Game1.cs:4286), not through a CanMove write, so clearing the menu is the whole release",
    },
    bound: "until the menu is closed",
  },
  DialogueUp: {
    kind: "dialogue-closed",
    anchor: "StardewValley/Game1.cs:11197",
    reads: ["Game1.dialogueUp"],
    bodyRelease: { anchor: "StardewValley.Menus/DialogueBox.cs:226" },
    bound: "until the box is advanced or closed",
  },
  TimeOfDay: {
    kind: "day-rollover",
    anchor: "StardewValley/Game1.cs:4190",
    reads: ["Game1.timeOfDay"],
    bodyRelease: { anchor: "StardewValley/Game1.cs:4213" },
    bound: "until the new day starts, minutes",
  },
  Stamina: {
    kind: "day-rollover",
    anchor: "StardewValley/Farmer.cs:2070",
    reads: ["Farmer.Stamina"],
    bodyRelease: {
      mechanism:
        "a faint ends with the day: the overnight sequence restores the actor (`player.forceCanMove()`, Game1.cs:4213) rather than the stamina write releasing the body",
    },
    bound: "until the new day starts, minutes",
  },
  FreezePaused: {
    kind: "body-release",
    anchor: "StardewValley/Farmer.cs:7097",
    reads: ["Farmer.freezePause"],
    bodyRelease: { anchor: "StardewValley/Farmer.cs:7095" },
    bound: "the frozen window the engine armed, 7000 ms for a faint",
  },
  Eating: {
    kind: "body-release",
    anchor: "StardewValley/Farmer.cs:7094",
    reads: ["Farmer.isEating"],
    bodyRelease: { anchor: "StardewValley/Farmer.cs:7095" },
    bound: "the item's own eat delay",
  },
  UsingTool: {
    kind: "body-release",
    anchor: "StardewValley/Farmer.cs:7098",
    reads: ["Farmer.UsingTool"],
    bodyRelease: { anchor: "StardewValley/Farmer.cs:7095" },
    bound: "one swing",
  },
  ToolCharged: {
    kind: "charge-spent",
    anchor: "StardewValley/Game1.cs:11589",
    reads: ["Farmer.toolPower"],
    bodyRelease: { anchor: "StardewValley/Farmer.cs:6761" },
    bound: "one swing",
  },
  SelfAnimation: {
    kind: "animation-end",
    anchor: "StardewValley/FarmerSprite.cs:792",
    reads: ["FarmerSprite.PauseForSingleAnimation"],
    bodyRelease: { anchor: "StardewValley/FarmerSprite.cs:789" },
    bound: "400-2000 ms depending on the animation",
  },
  Warping: {
    kind: "warp-complete",
    anchor: "StardewValley/Game1.cs:6271",
    reads: ["Game1.isWarping"],
    bodyRelease: { anchor: "StardewValley/Game1.cs:6229" },
    bound: "the fade to black, ~580 ms",
  },
  DayTransition: {
    kind: "overnight-sequence",
    anchor: "StardewValley/Game1.cs:8567",
    reads: ["Game1.newDay"],
    secondAnchor: { anchor: "StardewValley/Game1.cs:8606", reads: ["Game1.farmEvent"] },
    bodyRelease: { anchor: "StardewValley/Game1.cs:4213" },
    bound: "the whole overnight sequence, minutes",
  },
  ControlsFrozen: {
    kind: "body-release",
    anchor: "StardewValley/Farmer.cs:7096",
    reads: ["Game1.freezeControls"],
    bodyRelease: { anchor: "StardewValley/Farmer.cs:7095" },
    bound: "seconds - a bus ride, the walk to a door",
  },
  Minigame: {
    kind: "minigame-unload",
    anchor: "StardewValley/Game1.cs:4171",
    reads: ["Game1.currentMinigame"],
    bodyRelease: {
      mechanism:
        "the minigame loop owns the actor while it is mounted (Farmer.cs:7936) and unloads only when the minigame's own tick returns true (Game1.cs:4165-4171); there is no CanMove write to release",
    },
    bound: "up to the minigame's own result screen, 11.1 s on fishing",
  },
  ScreenFade: {
    kind: "fade-complete",
    anchor: "StardewValley.BellsAndWhistles/ScreenFade.cs:134",
    reads: ["Game1.globalFade"],
    bodyRelease: {
      mechanism:
        "the global fade writes no CanMove flag of its own; the hold is the caller's write (MineShaft.cs:3025) and the caller's afterFade releases it, while the fade itself clears at ScreenFade.cs:134/:154",
    },
    bound: "the fade's own speed, 380-830 ms by caller",
  },
};

/**
 * One row per engine site that writes `canMove = false` with no holding write of a declared read in its own method or
 * a same-file callee. Each row names the fact that publishes the hold (or the reason none can), the engine line that
 * releases it, and the evidence a reader needs to check the judgement.
 */
const RESIDUAL = [
  {
    site: "StardewValley/Crop.cs:541",
    method: "harvest",
    verdict: "named_by_fact",
    namedBy: "SelfAnimation",
    establishedAt: "StardewValley/Crop.cs:540",
    evidence:
      "`Game1.player.animateOnce(279 + facing)` (Crop.cs:540) raises the animation pause through Farmer.animateOnce -> FarmerSprite.animateOnce (Farmer.cs:6479, FarmerSprite.cs:673) in another type, which this analysis' same-file callee walk cannot follow",
    release: { anchor: "StardewValley/FarmerSprite.cs:789", kind: "animation-end" },
    bound: "600 ms (6 frames at 100 ms)",
  },
  {
    site: "StardewValley/Crop.cs:629",
    method: "harvest",
    verdict: "named_by_fact",
    namedBy: "SelfAnimation",
    establishedAt: "StardewValley/Crop.cs:628",
    evidence:
      "the grab branch of the same harvest: `animateOnce(283 + facing)` on the same primitive, one frame later than the row above",
    release: { anchor: "StardewValley/FarmerSprite.cs:789", kind: "animation-end" },
    bound: "600 ms",
  },
  {
    site: "StardewValley/Event.cs:11460",
    method: "OnPlayerControlSequenceEnd",
    verdict: "named_by_fact",
    namedBy: "EventUp",
    establishedAt: "StardewValley/GameLocation.cs:15763",
    evidence:
      "only reachable from the `Event.playerControlSequence` setter, i.e. inside a running event; `Game1.eventUp = true` is set by the event driver (GameLocation.cs:15759-15766) in another file, and the body is given back by `setUpPlayerControlSequence` (Event.cs:11468)",
    release: { anchor: "StardewValley/Event.cs:11468", kind: "control-sequence-end" },
    bound: "until the event releases the player control sequence",
  },
  {
    site: "StardewValley/Farmer.cs:6482",
    method: "animateOnce",
    verdict: "named_by_fact",
    namedBy: "SelfAnimation",
    establishedAt: "StardewValley/FarmerSprite.cs:673",
    evidence:
      "the engine's own single-animation hold primitive: it calls `FarmerSprite.animateOnce(...)` (Farmer.cs:6479) which raises the pause flag in FarmerSprite.cs, so the establishing write is in the callee's own type",
    release: { anchor: "StardewValley/FarmerSprite.cs:789", kind: "animation-end" },
    bound: "the animation's own frame budget",
  },
  {
    site: "StardewValley/Farmer.cs:8448",
    method: "PerformKiss",
    verdict: "named_by_fact",
    namedBy: "SelfAnimation",
    establishedAt: "StardewValley/Farmer.cs:8452",
    evidence:
      "the guard above requires every other declared fact to be ABSENT (`!Game1.eventUp && !UsingTool && ... && CanMove`), then takes the body and arms a 1000 ms + 1 ms frame pair; the only `PauseForSingleAnimation` write in this method CLEARS the flag, which is why this row is not accompanied",
    release: { anchor: "StardewValley/FarmerSprite.cs:789", kind: "animation-end" },
    bound: "1001 ms",
  },
  {
    site: "StardewValley/Farmer.cs:9315",
    method: "grabObject",
    verdict: "named_by_fact",
    namedBy: "SelfAnimation",
    establishedAt: "StardewValley/Farmer.cs:9316",
    evidence:
      "`CanMove = false` then `animateOnce(64/72/80/88, 50f, 8)`; the animation pause is raised through FarmerSprite in another type, so no same-file callee establishes it here",
    release: { anchor: "StardewValley/FarmerSprite.cs:789", kind: "animation-end" },
    bound: "400 ms (8 frames at 50 ms)",
  },
  {
    site: "StardewValley/Object.cs:3312",
    method: "rainTotem",
    verdict: "named_by_fact",
    namedBy: "SelfAnimation",
    establishedAt: "StardewValley/Object.cs:3315",
    evidence:
      "`who.canMove = false` then a one-frame 2000 ms animation whose frame-end behaviour IS the release (`Farmer.canMoveNow`, Object.cs:3315-3318); `Game1.pauseThenMessage` only arms `messageAfterPause`, which no declared read observes",
    release: { anchor: "StardewValley/Farmer.cs:6761", kind: "animation-frame-end" },
    bound: "2000 ms",
  },
  {
    site: "StardewValley.BellsAndWhistles/ParrotUpgradePerch.cs:797",
    method: "AttemptConstruction",
    verdict: "named_unknown",
    namedBy: null,
    unknownReason:
      "the release lives in a per-location `NetMutex`: `RequestLock` defers both callbacks (NetMutex.cs:44-59) and runs them from `Update` (:83-90), so the flag is false for at least one update tick and one server round-trip in multiplayer, and the only readable state is that perch's own mutex",
    settledBy:
      "a 30-second live probe on the perch logging `IsLocked()` per tick, or a `NetMutex`-scoped fact on the actor (a new `ActorWorldFacts` member this contract cannot invent)",
    release: { anchor: "StardewValley.BellsAndWhistles/ParrotUpgradePerch.cs:800", kind: "mutex-callback" },
    bound: "at least one mutex update tick, one server round-trip in multiplayer",
  },
  {
    site: "StardewValley.BellsAndWhistles/ScreenFade.cs:88",
    method: "FadeScreenToBlack",
    verdict: "named_by_fact",
    namedBy: "Warping",
    establishedAt: "StardewValley/Game1.cs:10031",
    evidence:
      "this is the WARP's fade, not the global one: it CLEARS `globalFade` (ScreenFade.cs:82) and raises `fadeToBlack`, so the only fact up across it is `Game1.isWarping`, raised by `performWarpFarmer` (Game1.cs:10031) in another file",
    release: { anchor: "StardewValley/Game1.cs:6229", kind: "warp-complete" },
    bound: "the fade to black, ~580 ms",
  },
  {
    site: "StardewValley.Events/BirthingEvent.cs:34",
    method: "setUp",
    verdict: "named_by_fact",
    namedBy: "DayTransition",
    establishedAt: "StardewValley/Game1.cs:8604",
    evidence:
      "a `BaseFarmEvent`: the driver is the new-day sequence (`if (farmEvent != null && farmEvent.setUp())`, Game1.cs:8604) and its own tick (Game1.cs:4187-4193). Farm events run with `eventUp == false` - the two are tracked separately - so `DayTransition` is the fact, and `ActorWorldFacts` reads it as `newDay || farmEvent != null`",
    release: { anchor: "StardewValley/Game1.cs:4213", kind: "overnight-sequence-end" },
    bound: "the overnight sequence, minutes",
  },
  {
    site: "StardewValley.Events/PlayerCoupleBirthingEvent.cs:89",
    method: "setUp",
    verdict: "named_by_fact",
    namedBy: "DayTransition",
    establishedAt: "StardewValley/Game1.cs:8604",
    evidence: "the same class and the same driver as the row above: a `BaseFarmEvent` mounted for the night",
    release: { anchor: "StardewValley/Game1.cs:4213", kind: "overnight-sequence-end" },
    bound: "the overnight sequence, minutes",
  },
  {
    site: "StardewValley.Locations/BusStop.cs:316",
    method: "UpdateWhenCurrentLocation",
    verdict: "named_by_fact",
    namedBy: "ControlsFrozen",
    establishedAt: "StardewValley.Locations/BusStop.cs:268",
    evidence:
      "re-asserted every tick while the bus drives (`drivingBack || drivingOff`, BusStop.cs:309-323); the fact is `Game1.freezeControls`, raised where the ride starts (BusStop.cs:268) rather than in this method",
    release: { anchor: "StardewValley.Locations/BusStop.cs:296", kind: "ride-arrival" },
    bound: "the whole drive",
  },
  {
    site: "StardewValley.Locations/ManorHouse.cs:44",
    method: "performAction",
    verdict: "named_by_fact",
    namedBy: "DialogueUp",
    establishedAt: "StardewValley/Game1.cs:9560",
    evidence:
      "the very next statement is `Game1.multipleDialogues(...)` (ManorHouse.cs:47-51), which mounts the box and sets `dialogueUp = true` (Game1.cs:9557-9562) in another file - the cross-file companion this analysis' same-file callee walk cannot see",
    release: { anchor: "StardewValley.Menus/DialogueBox.cs:226", kind: "dialogue-closed" },
    bound: "until the box is closed",
  },
  {
    site: "StardewValley.Locations/MineShaft.cs:3025",
    method: "enterMineShaft",
    verdict: "named_by_fact",
    namedBy: "ScreenFade",
    establishedAt: "StardewValley.BellsAndWhistles/ScreenFade.cs:107",
    evidence:
      "`Game1.globalFadeToBlack(afterFall, 0.045f)` (MineShaft.cs:3024) raises `globalFade` inside ScreenFade, then this line takes the body; between the two the only fact up is the fade, and `afterFall` (:3037-3045) opens a dialogue before the mine re-entry",
    release: { anchor: "StardewValley.Menus/DialogueBox.cs:226", kind: "dialogue-closed" },
    bound: "the fade plus the fall dialogue",
  },
  {
    site: "StardewValley.Locations/VolcanoDungeon.cs:286",
    method: "UseVolcanoShortcut",
    verdict: "named_by_fact",
    namedBy: "Warping",
    establishedAt: "StardewValley/Game1.cs:10031",
    evidence:
      "`CanMove = false; jump(); Game1.warpFarmer(...)` (VolcanoDungeon.cs:286-288): the warp flag is raised inside `performWarpFarmer` (Game1.cs:10031), one cross-file call away",
    release: { anchor: "StardewValley/Game1.cs:6229", kind: "warp-complete" },
    bound: "the fade to black, ~580 ms",
  },
  {
    site: "StardewValley.Minigames/FishingGame.cs:170",
    method: "gameDoneAfterFade",
    verdict: "named_by_fact",
    namedBy: "Minigame",
    establishedAt: "StardewValley/Game1.cs:4165",
    evidence:
      "runs as the `afterFade` of `Game1.globalFadeToBlack(gameDoneAfterFade, 0.01f)` (:159) and arms `showResultsTimer = 11100`; the minigame stays mounted until its own tick returns true (Game1.cs:4165-4171), and `Game1.currentMinigame` is the fact",
    release: { anchor: "StardewValley/Game1.cs:4171", kind: "minigame-unload" },
    bound: "11100 ms",
  },
];

/**
 * The four sites the analysis cannot attribute at all. They are this tool's own bound, not an engine fact: the brace
 * walk in `enclosingMethod` loses them, so no verdict about them is derivable from it.
 */
const UNATTRIBUTED = [
  {
    site: "StardewValley/GameLocation.cs:9287",
    reason: "the enclosing `switch` arm sits inside a method `enclosingMethod` cannot attribute",
    settledBy:
      "attribute the enclosing method through the switch arm (a brace walk that tracks `case` bodies), then re-derive the row; all four are followed by `Game1.multipleDialogues(...)` (:9289), so they are the same family as ManorHouse.cs:44",
  },
  {
    site: "StardewValley/GameLocation.cs:9297",
    reason: "the same brace-walk limit",
    settledBy: "the same attribution fix; followed by `Game1.multipleDialogues(...)` at :9300",
  },
  {
    site: "StardewValley/GameLocation.cs:9321",
    reason: "the same brace-walk limit",
    settledBy: "the same attribution fix; followed by `Game1.multipleDialogues(...)` at :9324",
  },
  {
    site: "StardewValley/GameLocation.cs:9345",
    reason: "the same brace-walk limit",
    settledBy: "the same attribution fix; followed by `Game1.multipleDialogues(...)` at :9349",
  },
];

/**
 * The Mod's own decision sites the admissibility gate adjudicates: every place the hold vocabulary is decided or
 * re-spelled outside `WorldModel`. `second_spelling_owed` rows are the ones this tree still carries - declared with an
 * owner and the condition that closes them, never silently dropped.
 */
const DECISION_SITES = [
  {
    file: "integrations/stardew/farmhandexecutioncontroller.cookingactions.cs",
    verdict: "second_spelling_owed",
    what: "a carried object blocking the cookout kit's vanilla entry is refused as `player_not_actionable` (line 178), a body-hold word for a station precondition no disposition produced",
    owner: "stardew-integration",
    closesWhen:
      "the refusal names the station precondition (`active_object_held;station=cookout_kit`) as its own code instead of the hold vocabulary's",
  },
  {
    file: "integrations/stardew/farmhandexecutioncontroller.modalactions.cs",
    verdict: "second_spelling_owed",
    what: "a failed actor/location binding is refused as `player_not_actionable` (line 546) with `actor=...;location=...`, which is an identity guard rather than a hold",
    owner: "stardew-integration",
    closesWhen:
      "the identity guard answers with the execution-scope code it already has (`execution_scope_mismatch`) rather than the hold word",
  },
  {
    file: "integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs",
    verdict: "not_a_decision",
    what: "the two matches (lines 480, 636) are comments describing the `player_menu_open` / `player_event_active` / `player_cannot_move` guards this code replaced; nothing decides anything",
    owner: "tools",
    closesWhen: "the comments are rewritten without the retired code names, and this row is deleted",
  },
  {
    file: "integrations/stardew/StardewBodyController.cs",
    verdict: "second_spelling_owed",
    what: "a movement lock is refused as `player_not_actionable` (line 1127) from `!localPlayer.CanMove`, a second spelling of a hold `WorldModel.DescribeNavigationHold` already publishes as `unknown_holder:CanMove`",
    owner: "stardew-integration",
    closesWhen:
      "the body loop reports the navigation hold through `WorldModel.DescribeNavigationHold` instead of minting the collapsed word itself",
  },
];

/** The derived booleans no decision may key on, with the site that shipped the defect they caused. */
const DERIVED_INPUTS = [
  {
    id: "snapshot.actionable",
    form: "!snapshot.actionable",
    whyForbidden:
      "a derived boolean collapses every hold into one word: `player_not_actionable` came to mean menu, cutscene, faint, eating and tool swing at once, leaving an Agent no countermeasure to choose",
    history: "host/src/stardew-action-remedy.ts:5 - the Host answered a held body with this and nothing else",
  },
  {
    id: "snapshot.actionable_guard",
    form: "if (!snapshot.actionable)",
    whyForbidden:
      "the same boolean read as a guard rather than as evidence; the disposition names the hold, a boolean cannot",
    history: null,
  },
];

// ---------------------------------------------------------------------------------------------- assemble

const source = read(WORLD_MODEL);
const union = factUnion(source);
const factNames = union.map((fact) => fact.name);
const constants = CONSTANTS(source);
const reads = readFacts(source, factNames);
const branches = classifyBranches(source);
const wire = kindSwitch(source, "public static string KindForWire(ActorDispositionKind kind) => kind switch");
const reason = kindSwitch(source, "public static string HoldReasonCode(ActorDispositionKind kind) => kind switch");

const anchorOf = (rel) => {
  const [, path, line] = /^(.+):(\d+)$/u.exec(rel) ?? [];
  if (path === undefined) throw new Error(`anchor "${rel}" is not <path>:<line>`);
  const text = read(join(ENGINE_ROOT, path)).split("\n")[Number(line) - 1];
  if (text === undefined) throw new Error(`anchor "${rel}" is past the end of ${path}`);
  return `${ENGINE_ROOT}/${path}:${line}`;
};
const engineLineOf = (anchor) => {
  const [, path, line] = /^(.*):(\d+)$/u.exec(anchor);
  return read(path).split("\n")[Number(line) - 1];
};

const factEntries = union.map((fact, index) => {
  const readInfo = reads[index];
  const members = engineReads(readInfo.expression);
  const branch = branches.find((entry) => entry.facts.includes(fact.name));
  if (branch === undefined) throw new Error(`${fact.name} is published by no branch of Classify`);
  const published = {
    kind: branch.kind,
    wire: wire.get(branch.kind),
    reasonCode: reason.get(branch.kind) ?? reason.fallback,
    transientKind: branch.transientKind,
    precedence: branch.precedence,
  };
  for (const [key, value] of Object.entries(published))
    if (value === undefined) throw new Error(`${fact.name}: ${key} is not derivable from the switch expressions`);

  const release = RELEASES[fact.name];
  if (release === undefined)
    throw new Error(`${fact.name} has no release row: a hold nobody releases is not admissible`);
  const releases = [
    { reads: release.reads, anchor: anchorOf(release.anchor), kind: release.kind },
    ...(release.secondAnchor === undefined
      ? []
      : [{ reads: release.secondAnchor.reads, anchor: anchorOf(release.secondAnchor.anchor), kind: release.kind }]),
  ].map((entry) => ({ ...entry, statement: normalize(engineLineOf(entry.anchor)) }));
  for (const entry of releases)
    for (const member of entry.reads)
      if (!members.includes(member))
        throw new Error(
          `${fact.name}: release cites ${member}, which ReadFacts does not read for it (${members.join(", ")})`,
        );
  const bodyRelease =
    release.bodyRelease.anchor === undefined
      ? { mechanism: release.bodyRelease.mechanism }
      : {
          anchor: anchorOf(release.bodyRelease.anchor),
          statement: normalize(engineLineOf(anchorOf(release.bodyRelease.anchor))),
        };
  if (bodyRelease.mechanism === undefined && bodyRelease.anchor === undefined)
    throw new Error(`${fact.name}: the release names neither a body anchor nor a mechanism`);

  return {
    fact: fact.name,
    reads: members.map((member) => ({
      member,
      holdsWhen: holdsWhen({
        fact: fact.name,
        member,
        readExpression: readInfo.expression,
        condition: branches.find((entry) => entry.facts.includes(fact.name))?.condition ?? "",
        constants,
      }),
      declaredAt: engineDeclaration(member),
      resolvesTo: backingMember(member),
    })),
    publishes: published,
    publishedAt: { file: WORLD_MODEL, line: fact.line },
    readAt: {
      file: WORLD_MODEL,
      line: readInfo.expressionLine,
      expression: readInfo.expression,
      argument: readInfo.argument,
      argumentLine: readInfo.argumentLine,
    },
    classifyAt: { file: WORLD_MODEL, line: branch.line, condition: branch.condition },
    release: { kind: release.kind, bound: release.bound, clears: releases, bodyRelease },
    assertedBy:
      "tools/check-stardew-actor-admissibility.mjs: FACT-4 release (each anchor still says what this row says, and a literal release must clear its fact)",
  };
});

const holdReasons = [...wire.keys()].map((kind) => ({
  kind,
  wire: wire.get(kind),
  reasonCode: reason.get(kind) ?? reason.fallback,
  // In RULING order, which is the order `Classify` tests them: a list in declaration order would read as if the
  // precedence were the parameter list's.
  publishedBy: factEntries
    .filter((entry) => entry.publishes.kind === kind)
    .sort((left, right) => left.publishes.precedence - right.publishes.precedence)
    .map((entry) => entry.fact),
}));

const residual = RESIDUAL.map((row) => ({
  site: `${ENGINE_ROOT}/${row.site}`,
  method: row.method,
  verdict: row.verdict,
  namedBy: row.namedBy,
  ...(row.namedBy === null
    ? { unknownReason: row.unknownReason, settledBy: row.settledBy }
    : { establishedAt: anchorOf(row.establishedAt), evidence: row.evidence }),
  release: {
    anchor: anchorOf(row.release.anchor),
    kind: row.release.kind,
    statement: normalize(engineLineOf(anchorOf(row.release.anchor))),
  },
  bound: row.bound,
}));
for (const row of residual) {
  if (row.verdict === "named_by_fact" && !factNames.includes(row.namedBy))
    throw new Error(`${row.site}: namedBy "${row.namedBy}" is not a member of ActorWorldFacts`);
  if (row.verdict === "named_unknown" && (row.unknownReason === undefined || row.settledBy === undefined))
    throw new Error(`${row.site}: an unnamed hold must state why and what would settle it`);
}

const contract = {
  schemaVersion: 1,
  artifactKind: "stardew_actor_admissibility",
  slice: "world-interruption-arbitration 4.1/4.2 - the body-hold algebra the Mod decides and the engine enters",
  note:
    "DERIVED by tools/derive-stardew-actor-admissibility.mjs from `ActorWorldFacts`, `WorldModel.ReadFacts`/`Classify`, " +
    "`KindForWire` and `HoldReasonCode` (the population, the publishes and the holding predicates), with the release " +
    "anchors and the residual rows authored here and re-verified against the decompiled tree by the two gates. Do not " +
    "hand-edit: a row edited by hand is a claim no generator reproduces.",
  populationBound: {
    heldFact: "Farmer.canMove = false",
    howMeasured:
      "literal writes of `canMove = false` in ref/external/StardewValleyDecompiled, attributed to a method by a lexical brace walk, with companion writes followed one same-file callee level deep",
    notCounted: [
      "a hold written as an expression (`CanMove = !Game1.eventUp`, Farmer.cs:9015; `CanMove = value`, Farmer.cs:1727)",
      "a hold written through an alias or a property setter",
      "a companion established in another type, which needs a residual row",
    ],
  },
  facts: factEntries,
  holdReasons,
  environmentReads: factEntries.flatMap((entry) =>
    entry.reads.map((readInfo) => ({
      member: readInfo.member,
      fact: entry.fact,
      holdsWhen: readInfo.holdsWhen,
      declaredAt: readInfo.declaredAt,
      resolvesTo: readInfo.resolvesTo,
    })),
  ),
  orphanHoldResidual: residual,
  unattributedHoldSites: UNATTRIBUTED.map((row) => ({
    site: `${ENGINE_ROOT}/${row.site}`,
    reason: row.reason,
    settledBy: row.settledBy,
  })),
  adjudication: {
    decisionSites: DECISION_SITES,
    derivedInputs: DERIVED_INPUTS,
    vocabulary: [
      "not_a_decision - the match is prose, and nothing is decided there",
      "second_spelling_owed - the site decides a hold word outside WorldModel; the row names the owner and the condition that closes it",
    ],
  },
};

const text = `${JSON.stringify(contract, null, 2)}\n`;
let existing = null;
try {
  existing = read(OUTPUT);
} catch {}
mkdirSync(dirname(join(ROOT, OUTPUT)), { recursive: true });
writeFileSync(join(ROOT, OUTPUT), text);

const releases = contract.facts.reduce((total, fact) => total + fact.release.clears.length, 0);
const unknown = contract.orphanHoldResidual.filter((row) => row.verdict === "named_unknown").length;
console.log(`facts ${contract.facts.length} · release paths ${releases} · named unknowns ${unknown}`);
console.log(
  `residual ${contract.orphanHoldResidual.length} (named_by_fact ` +
    `${contract.orphanHoldResidual.filter((row) => row.verdict === "named_by_fact").length}) · ` +
    `unattributed ${contract.unattributedHoldSites.length} · reads ${contract.environmentReads.length}`,
);
console.log(`wrote ${OUTPUT}`);
console.log(
  existing === text ? "regenerated: byte-identical to the previous run" : "regenerated: CHANGED from the previous run",
);
