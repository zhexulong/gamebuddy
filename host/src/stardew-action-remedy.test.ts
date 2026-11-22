import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { STARDEW_ACTION_TOOL_NAMES } from "./action-registry.js";
import { planActionsFromRegistrations } from "./body-program-script.js";
import { ADVERTISED, MOUNTED_GAME_SURFACE_TOOL_NAMES } from "./game-surface-prompt-floor.test-support.js";
import {
  MACHINE_ONLY_REFUSAL_CODES,
  describeRefusalRemedy,
  evidenceDetailOf,
  evidenceField,
  remedyForRefusal,
} from "./stardew-action-remedy.js";

test("every named hold gets a countermeasure, and none of them is the same text", () => {
  const codes = ["actor_held_by_modal", "transient_busy", "cutscene_active", "actor_passed_out"];
  const guidances = codes.map((code) => remedyForRefusal(code, null)?.guidance);
  for (const [index, guidance] of guidances.entries()) {
    assert.ok(
      guidance,
      `${codes[index]} must have a countermeasure: a named hold with no remedy is only a ` + "prettier dead end",
    );
  }
  // The point of the whole change: one code used to cover all of these, so five states gave one answer.
  assert.equal(
    new Set(guidances).size,
    codes.length,
    "each hold must be answered differently or the Agent still cannot choose",
  );
});

test("a door the clock shuts names the hour it opens, and is not read as a body hold", () => {
  // round91: `door_gate_refused` shared one sentence with `navigation_commit_body_still_owned` - "wait for that to clear" -
  // for a door that opens at a stated hour, and the run spent the next minute asking the same door.
  const shut = remedyForRefusal(
    "door_gate_refused",
    "source=9,12;gate=refused;entry=perform_action;map=SeedShop;door_tile=9,12;door_at_tile=locked_by_hours;" +
      "opens_at=900;closes_at=1900;now=1730;dialogue=It's not open right now.",
  );
  assert.equal(shut?.action, null, "no tool opens a door the game's own clock has shut");
  assert.match(shut?.guidance ?? "", /opens at 900/, "the hour it opens is the instruction");
  assert.match(shut?.guidance ?? "", /1900/);
  assert.match(shut?.guidance ?? "", /1730/, "beside the clock the reader is holding");
  assert.doesNotMatch(shut?.guidance ?? "", /something still holds the body/, "a clock is not a body hold");
  assert.notEqual(
    shut?.guidance,
    remedyForRefusal("navigation_commit_body_still_owned", null)?.guidance,
    "the two facts were one sentence, which is why the minute was spent re-asking",
  );
  // The other shade of the same code: a door whose hours the map does not declare still says which door it was.
  const gated = remedyForRefusal(
    "door_gate_refused",
    "source=9,12;gate=refused;entry=perform_action;map=CommunityCenter;door_tile=9,12;door_at_tile=declared;dialogue=It's locked.",
  );
  assert.match(gated?.guidance ?? "", /\(9,12\)/, "the door is named, so the reader knows which one was refused");
  assert.match(gated?.guidance ?? "", /dialogue/, "and that the game's own words say why");
});

test("a door that is not on this map says so, and a repeated refusal says how often it has come back", () => {
  const absent = remedyForRefusal(
    "door_not_available",
    "source=7,18;warps=10;you=7,18;nearest=28,15;distance=21;doors=28,15->Greenhouse;map=Town;door_tile=7,18;door_at_tile=absent",
  );
  assert.equal(absent?.action, null, "nothing can be dispatched at a door that is not there");
  assert.match(absent?.guidance ?? "", /Town/, "the map's doors were the ones enumerated, and it says whose they were");
  assert.match(absent?.guidance ?? "", /no door of Town/, "doorless and shut are different sentences");
  assert.match(absent?.guidance ?? "", /\(28,15\)/, "the transition this map does publish is the way out");

  // The same map, a door it DOES declare: the other sentence.
  const declared = remedyForRefusal(
    "door_not_available",
    "source=7,18;warps=10;nearest=28,15;map=Town;door_tile=7,18;door_at_tile=declared",
  );
  assert.match(declared?.guidance ?? "", /does declare a door/, "a door that leads nowhere is not a doorless tile");
  assert.notEqual(declared?.guidance, absent?.guidance);

  // AND THE MINUTE. The Mod counts identical answers; the sentence must say the repetition out loud.
  const repeated = remedyForRefusal(
    "door_not_available",
    "source=7,18;warps=10;nearest=28,15;map=Town;door_tile=7,18;door_at_tile=absent;same_refusal_as_before=7",
  );
  assert.match(repeated?.guidance ?? "", /7 time\(s\)/, "the count travels into the sentence");
  assert.match(repeated?.guidance ?? "", /do something else/, "and so does the instruction it exists for");
  assert.doesNotMatch(absent?.guidance ?? "", /time\(s\)/, "a first refusal is a new fact and says nothing about repeats");
});

test("a modal points at the plan step that matches whether an answer is owed", () => {
  const question = remedyForRefusal("actor_held_by_modal", "modal_type=DialogueBox;is_question=true;can_move=false");
  assert.equal(question?.action, "stardew_plan_work");
  assert.match(question?.guidance ?? "", /'answer_dialogue'/);
  assert.match(question?.guidance ?? "", /stardew_plan_work/);

  const informational = remedyForRefusal(
    "actor_held_by_modal",
    "modal_type=DialogueBox;is_question=false;can_move=false",
  );
  assert.equal(informational?.action, "stardew_plan_work");
  assert.match(informational?.guidance ?? "", /'dismiss_modal'/);
  assert.match(informational?.guidance ?? "", /stardew_plan_work/);
});

test("an unreadable answer state is honest rather than promising a close that may be refused", () => {
  // A non-dialogue operation menu: the question flag is absent because it does not apply, and dismiss_modal's
  // audited whitelist may refuse it. The guidance must not claim the close will work.
  const remedy = remedyForRefusal(
    "actor_held_by_modal",
    "modal_type=LetterViewerMenu;is_question=unknown;can_move=false",
  );
  assert.equal(remedy?.action, "stardew_plan_work");
  assert.match(remedy?.guidance ?? "", /refuses menus it is not allowed to close/);
  assert.match(remedy?.guidance ?? "", /report the blockage/, "the Agent must be told what to do if the remedy fails");
});

test("a transient hold tells the Agent to wait and to keep the SAME target", () => {
  const remedy = remedyForRefusal("transient_busy", "transient_kind=toolAnimation;retry_window_ms=2000;can_move=false");
  assert.equal(remedy?.action, null, "no tool can shorten a transient, so none may be named");
  assert.match(remedy?.guidance ?? "", /toolAnimation/);
  assert.match(remedy?.guidance ?? "", /2000/);
  assert.match(remedy?.guidance ?? "", /SAME request/, "changing the target is the failure mode this prevents");
});

test("a hold with no countermeasure says so instead of naming a tool", () => {
  for (const code of ["cutscene_active", "actor_passed_out"]) {
    const remedy = remedyForRefusal(code, null);
    assert.equal(remedy?.action, null, `${code} cannot be cleared by a tool`);
    assert.match(remedy?.guidance ?? "", /retry|Do not issue|Do not retry/i);
  }
});

test("a cutscene points at the plan step that acts on the box it is showing", () => {
  // A cutscene is not one state. Two handlers act on its own dialogue box, and the evidence says which box is on
  // screen - the same fact the modal hold publishes. The dead end this replaces: one sentence for both, telling a run
  // that could have advanced the box that no action can run (four retries over twenty minutes).
  const question = remedyForRefusal(
    "cutscene_active",
    "event_up=true;dialogue_box=true;is_question=true;admissible_actions=answer_dialogue,dismiss_modal;can_move=false",
  );
  assert.equal(question?.action, "stardew_plan_work");
  assert.match(question?.guidance ?? "", /'answer_dialogue'/);
  assert.match(question?.guidance ?? "", /'dismiss_modal'/, "the way to learn the offered keys must be named");

  const informational = remedyForRefusal(
    "cutscene_active",
    "event_up=true;dialogue_box=true;is_question=false;admissible_actions=answer_dialogue,dismiss_modal;can_move=false",
  );
  assert.equal(informational?.action, "stardew_plan_work");
  assert.match(informational?.guidance ?? "", /'dismiss_modal'/);
  assert.match(
    informational?.guidance ?? "",
    /'answer_dialogue'/,
    "a question box must name the action that answers it",
  );
  for (const guidance of [question?.guidance, informational?.guidance])
    assert.match(guidance ?? "", /stardew_plan_work/, "a step needs the route that can submit it");

  // No box: nothing to act on, and the guidance must not name a tool that would be refused.
  const bare = remedyForRefusal(
    "cutscene_active",
    "event_up=true;dialogue_box=false;admissible_actions=none;next_step=wait_for_event_to_advance;can_move=false",
  );
  assert.equal(bare?.action, null);
  assert.match(bare?.guidance ?? "", /Do not issue actions until the scene ends/);
});

test("a cutscene with nothing to act on is its own code, with its own answer", () => {
  // The modal family was admitted into the cutscene and found no box. That is a wait which ends by itself, not the
  // anonymous cutscene hold whose countermeasure a run is still looking for.
  const remedy = remedyForRefusal(
    "event_has_no_dialogue_box",
    "event_up=true;dialogue_box=false;admissible_actions=none;next_step=wait_for_event_to_advance;can_move=false",
  );
  assert.equal(remedy?.action, null, "no tool advances an event's own command program");
  assert.match(remedy?.guidance ?? "", /no dialogue box on screen/);
  assert.match(remedy?.guidance ?? "", /advances on its own/);
  assert.notEqual(
    remedy?.guidance,
    remedyForRefusal("cutscene_active", null)?.guidance,
    "two different facts must not read as one sentence",
  );
});

test("every named body owner gets actionable guidance, and no two owners read the same", () => {
  const owners = [
    "body_owned_by_navigation",
    "body_owned_by_travel",
    "body_owned_by_movement",
    "body_owned_by_approach",
    "body_owned_by_ride",
    "body_owned_by_day_advance",
    "body_owned_by_activity",
  ];
  const guidances = owners.map((code) => remedyForRefusal(code, null)?.guidance);
  for (const [index, guidance] of guidances.entries()) {
    assert.ok(guidance, `${owners[index]} must name a next step, not just report the hold`);
    assert.match(guidance ?? "", /Wait|Re-issue/, `${owners[index]} must say to wait or to re-issue`);
  }
  assert.equal(
    new Set(guidances).size,
    owners.length,
    "owners that share a sentence leave the Agent guessing which hold it is again",
  );
});

test("only a supersedable owner is told to re-issue; every other owner must settle first", () => {
  // The Mod's frozen table marks an in-flight local movement supersedable by a newer command, but ONLY a
  // movement displaces it: `RequestLocalMove` cancels `active`, while any other action goes through shared
  // admission and is refused again. The guidance must therefore name both cases instead of promising a
  // takeover to whichever request happens to be holding the code.
  const movement = remedyForRefusal("body_owned_by_movement", null)?.guidance ?? "";
  assert.match(movement, /if you meant to walk somewhere, re-issue the request now/);
  assert.match(movement, /Any other action has to wait/, "a tool action must not be told to re-issue blindly");
  for (const code of [
    "body_owned_by_travel",
    "body_owned_by_approach",
    "body_owned_by_ride",
    "body_owned_by_day_advance",
    "body_owned_by_activity",
    "body_owned_by_navigation",
  ]) {
    assert.match(remedyForRefusal(code, null)?.guidance ?? "", /Wait for/, `${code} cannot be interrupted`);
  }
  // Navigation is deliberately in the settle-only list above, matching the Mod's own `interruptible=false`.
  // It used to offer a takeover here as well; that contradicted the structured fact published in the same
  // snapshot, and the movement path has no clean takeover to offer (`RequestLocalMove`'s occupancy guard does
  // not include `activeNavigate`). One authority, one answer.
  const navigation = remedyForRefusal("body_owned_by_navigation", null)?.guidance ?? "";
  assert.match(navigation, /cannot be taken over/, "the guidance must say so plainly");
  assert.doesNotMatch(navigation, /also takes over|takes over from/, "and must not promise a takeover the Mod denies");
});

test("a body_owned_* code the table does not list still gets a generic actionable remedy", () => {
  // A named hold the Host has not heard of yet must not degrade to an unknown-error dead end.
  const remedy = remedyForRefusal("body_owned_by_future_owner", null);
  assert.equal(remedy?.action, null, "a prefixed hold names no tool");
  assert.match(remedy?.guidance ?? "", /Wait for it to settle/);
  assert.match(remedy?.guidance ?? "", /re-issue the same request/);
});

test("the bare legacy body_owned stays a dead end for the prefix fallback", () => {
  // `body_owned` is not `body_owned_`: the fallback must not swallow the code whose test asserts no remedy.
  assert.equal(remedyForRefusal("body_owned", null), null);
});

test("a queued request that outlived its wait names the owner it waited for", () => {
  // The Mod parks a request behind the actor's OWN in-flight work and dispatches it when that work ends. When the
  // boundary is crossed, the wait answers with `waiting_for_body:<owner>` - a code neither the named table nor the
  // `body_owned_` prefix fallback covers. It must still give the Agent a next step, and it must name the owner.
  const remedy = remedyForRefusal(
    "waiting_for_body:body_owned_by_activity",
    "owner_execution_id=exec_1;owner_action=pickup_item",
  );
  assert.equal(remedy?.action, null, "the wait is over: there is no tool to call");
  assert.match(remedy?.guidance ?? "", /pickup_item/, "the guidance must name the owner, not just the hold");
  assert.match(remedy?.guidance ?? "", /Re-issue the same request/);
  // Evidence is optional: without it the code itself still says which owner the wait was for.
  const withoutDetail = remedyForRefusal("waiting_for_body:body_owned_by_movement", null);
  assert.match(withoutDetail?.guidance ?? "", /body_owned_by_movement/);
});

test("a code outside every refusal family still gets no remedy", () => {
  // Attaching a remedy here would tell the Agent to close a dialogue that is not open. `no_native_path` used to sit in
  // this list; it has a sentence now (the movement family), which is the change this suite's coverage gate measures.
  for (const code of ["player_not_actionable", "invalid_target_tile", "body_owned", "accepted", null]) {
    assert.equal(remedyForRefusal(code, "modal_type=DialogueBox"), null, `${String(code)} is not a refusal this owns`);
  }
});

test("the Mod's evidence is read in both the shapes it arrives in", () => {
  assert.equal(evidenceDetailOf({ detail: "a=1;b=2" }), "a=1;b=2");
  assert.equal(evidenceDetailOf("a=1"), "a=1", "a bare string is accepted rather than silently dropped");
  assert.equal(evidenceDetailOf(null), null);
  assert.equal(evidenceDetailOf({ other: 1 }), null);

  assert.equal(evidenceField("a=1;is_question=false;b=2", "is_question"), "false");
  assert.equal(evidenceField("a=1", "is_question"), null);
  assert.equal(evidenceField(null, "is_question"), null);
  // A value that itself contains '=' must survive, or a modal type with punctuation would be truncated.
  assert.equal(evidenceField("modal_type=DialogueBox;x=a=b", "x"), "a=b");
});

/**
 * The remedy table's own source: the population the reachability test below reads.
 *
 * Resolved through `../src` rather than beside this file, because the test is compiled into `host/dist-test`, one level
 * below `host`: the same expression names the module from `host/src` (run from source) and from `host/dist-test` (run
 * compiled). Beside this file it read `dist-test/stardew-action-remedy.ts`, which only exists in the source layout, so
 * the gate answered ENOENT in every compiled run.
 */
const REMEDY_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "stardew-action-remedy.ts");

/** The module's own string constants, so a route it names through one is resolved rather than guessed. */
function moduleStringConstants(sourceFile: ts.SourceFile): Map<string, string> {
  const constants = new Map<string, string>();
  const walk = (node: ts.Node | undefined): void => {
    if (node === undefined) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isStringLiteral(node.initializer)
    )
      constants.set(node.name.text, node.initializer.text);
    ts.forEachChild(node, walk);
  };
  walk(sourceFile);
  return constants;
}

/**
 * The text of one `guidance` initializer, its literal chunks joined as the model reads them, with a
 * substitution the module declares as a constant resolved to its value.
 */
function guidanceText(initializer: ts.Node, constants: Map<string, string>): string {
  const parts: string[] = [];
  const collect = (node: ts.Node | undefined): void => {
    if (node === undefined) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      parts.push(node.text);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      parts.push(node.head.text);
      for (const span of node.templateSpans) {
        if (ts.isIdentifier(span.expression) && constants.has(span.expression.text))
          parts.push(constants.get(span.expression.text) ?? "");
        parts.push(span.literal.text);
      }
      return;
    }
    ts.forEachChild(node, collect);
  };
  collect(initializer);
  return parts.join("");
}

/**
 * Every route the remedy table names: each `action:` value, and every tool name inside a `guidance`
 * sentence, each tagged with the reason code whose case declares it. A bare action id in a sentence is
 * the plan-step spelling, so it is resolved to the id itself.
 */
function namedRemedyRoutes(): readonly Readonly<{ route: string; remedy: string; bare: boolean }>[] {
  const sourceFile = ts.createSourceFile(
    REMEDY_SOURCE,
    readFileSync(REMEDY_SOURCE, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const constants = moduleStringConstants(sourceFile);
  const routes: { route: string; remedy: string; bare: boolean }[] = [];
  const walk = (node: ts.Node | undefined, remedy: string): void => {
    if (node === undefined) return;
    const owner = ts.isCaseClause(node) && ts.isStringLiteral(node.expression) ? node.expression.text : remedy;
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      if (node.name.text === "action") {
        if (ts.isStringLiteral(node.initializer))
          routes.push({ route: node.initializer.text, remedy: owner, bare: false });
        else if (ts.isIdentifier(node.initializer) && constants.has(node.initializer.text))
          routes.push({ route: constants.get(node.initializer.text) ?? "", remedy: owner, bare: false });
      }
      if (node.name.text === "guidance") {
        const text = guidanceText(node.initializer, constants);
        for (const match of text.matchAll(/stardew_[a-z0-9_]+/gu))
          routes.push({ route: match[0], remedy: owner, bare: false });
        for (const actionId of Object.keys(STARDEW_ACTION_TOOL_NAMES))
          if (new RegExp(`(?<![A-Za-z0-9_])${actionId}(?![A-Za-z0-9_])`, "u").test(text))
            routes.push({ route: actionId, remedy: owner, bare: true });
      }
    }
    ts.forEachChild(node, (child) => walk(child, owner));
  };
  walk(sourceFile, "<no case>");
  return routes;
}

test("every route a remedy names is one the mounted surface can take", (t) => {
  // The population is the module's own table, so a remedy added tomorrow is judged by the same rule
  // without editing this test. It named `stardew_dismiss_modal` and `stardew_answer_dialogue` until
  // 2026-11-12: both are declared by the module that builds the flat tools, and `planActionSurface`
  // drops every one of them, so the only sentence the Agent got after a hold pointed at a tool that
  // was not in the request. A mounted tool is a route; a step the plan builder admits is a route.
  const mounted = new Set<string>(MOUNTED_GAME_SURFACE_TOOL_NAMES);
  const admitted = new Set<string>(planActionsFromRegistrations(ADVERTISED).map((action) => action.actionId));
  assert.ok(mounted.size > 0, "blocked: the recorded mounted Game tool set is empty, so every route would fail");
  assert.ok(admitted.size > 0, "blocked: the plan builder admits no action, so no step could be a route");
  const routes = namedRemedyRoutes();
  assert.ok(routes.length > 0, "blocked: the remedy table names no route at all, so this reads nothing");
  // A prefixed name is a tool the Agent calls, so it has to be MOUNTED; a bare id is a plan step, so it
  // has to be admitted by the plan builder. Neither may borrow the other's authority.
  const findings = routes
    .filter((entry) => (entry.bare ? !admitted.has(entry.route) : !mounted.has(entry.route)))
    .map((entry) => `remedy_names_an_unreachable_route:${entry.route}:${entry.remedy}`);
  t.diagnostic(
    `every route a remedy names: ${routes.length} route mention(s) (${routes.filter((entry) => entry.bare).length} plan step(s), ${routes.filter((entry) => !entry.bare).length} tool name(s)) · ${mounted.size} mounted · ${admitted.size} plan-admissible; ${findings.length} unreachable`,
  );
  assert.deepEqual(
    findings,
    [],
    "a remedy that points at a route the game cannot take is the defect this module's own header rules out",
  );
});

/**
 * The Mod's own file that declares the refusal vocabulary the healing join can publish.
 *
 * Resolved through `../..` for the same reason as `REMEDY_SOURCE`: the test is compiled into `host/dist-test`, so `..` is
 * `host` and `../..` is the repository root, in both the source and the compiled layout.
 */
const HEALING_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "integrations",
  "stardew",
  "src",
  "Core",
  "Policy",
  "FarmhandForEachHealing.cs",
);

/**
 * Every shipped `.cs` file of the Mod: the population below is read from declarations rather than from a list, so a
 * declaration added tomorrow enrols itself and one deleted leaves. `obj`/`bin` are build output, `tests` is not shipped,
 * and `action-development` is the offline devkit.
 *
 * A directory that cannot be read is NOT skipped silently: it is a BLOCKED reading of a population this gate claims to
 * have counted, so it throws.
 */
function shippedModSources(): readonly string[] {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "integrations", "stardew");
  const skip = new Set(["obj", "bin", "tests", "action-development", "node_modules"]);
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(join(directory, entry.name));
        continue;
      }
      if (entry.name.endsWith(".cs")) files.push(join(directory, entry.name));
    }
  };
  walk(root);
  return files;
}

/**
 * The codes the Mod DECLARES as refusals, from the declarations themselves.
 *
 * A code is declared when the Mod gives it a NAME THAT SAYS WHAT IT IS: `internal const string
 * NoNativePathReasonCode = "no_native_path";`. That convention is what makes this derivable at all.
 *
 * THE THREE THAT ARE STILL BARE LITERALS AT THEIR MINT SITES, named here rather than left to be discovered - a declaration
 * population that quietly omits them is how the ninth code goes unseen:
 *
 *   - `native_path_ended` - `integrations/stardew/StardewBodyController.cs:180`, returned by `StallRefusalCode`;
 *   - `warp_out_of_range` and its sibling `door_out_of_range` - `integrations/stardew/farmhandexecutioncontroller.movementactions.cs:793`,
 *     a conditional expression whose every sibling in that file is a declared constant.
 *
 * They are DEBT, not coverage: both live codes reach this gate through the recorded run below (which is why they are
 * rendered rather than missing), and the fix is one `internal const string …ReasonCode` per site - not this test's to
 * make, because declaring them lands in the Mod and the class-size record those files carry is re-recorded by its own lane.
 * A fourth code, `actor_moving`, was retired at its mint site and is named in the same printed line.
 */
function declaredReasonCodes(files: readonly string[]): readonly string[] {
  const codes = new Set<string>();
  for (const file of files) {
    for (const match of readFileSync(file, "utf8").matchAll(
      /(?:internal|public|private) const string \w*Reason\w* = "([a-z][a-z0-9_]{2,})";/gu,
    ))
      if (match[1] !== undefined) codes.add(match[1]);
  }
  return [...codes].sort();
}

const NAVIGATION_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "integrations",
  "stardew",
  "navigation",
  "navigationnextstep.cs",
);

/**
 * The navigation terminals, minus the ones that are not refusals.
 *
 * `NavigationNextStep.Of` is the Mod's own closed vocabulary of navigation endings, and it CLASSIFIES each label
 * (`Action(...)`, `Permanent(...)`, `Progress`). The progress entries are the navigation still running or having arrived, so
 * they are excluded by reading the Mod's classification rather than by naming three labels here - which is the same reason
 * the population is declarations instead of a list.
 */
function navigationRefusalCodes(): readonly string[] {
  const source = readFileSync(NAVIGATION_SOURCE, "utf8");
  const entries = [...source.matchAll(/^\s*"([a-z][a-z0-9_]+)"\s*=>\s*(\w+)/gmu)];
  assert.ok(
    entries.length > 0,
    `blocked: no navigation terminal classified in ${NAVIGATION_SOURCE}, so this source contributes nothing and would agree with itself`,
  );
  return entries
    .filter((entry) => entry[2] !== "Progress")
    .map((entry) => entry[1] ?? "")
    .filter((code) => code !== "")
    .sort();
}

/**
 * The codes a REAL run delivered, counted from its own record - and `null` when the record is not on this tree.
 *
 * <p>
 * THE RECORD. `tools/_multiday_routine-round78-live-runner.log` is the live runner's own log for `round78` (2026-11-19,
 * the mine window): every `BRIDGE_FACT` it received, which is the delivery path itself rather than a transcription of it.
 * The file is gitignored (`/tools/_*`), so a fresh checkout does not carry it - and the three zeroes are kept apart
 * instead of collapsed: absent is `not_measured` and says so on the printed line, an empty result is a BLOCKED reading,
 * and a real read prints its codes with their counts.
 * </p>
 *
 * <p>
 * WHY THIS HALF EXISTS AT ALL. The declared catalogues are what the Mod SAYS it can refuse with; this is what it DID, and
 * the two disagreed: `round78` read eight codes, and the delivery had no sentence for any of them. A population built only
 * from declarations cannot see that, because the codes she read arrived as settlement-node reasons rather than as
 * `ExecutionState.Rejected` receipts - the other family, printed below, whose 345 codes contain none of these eight.
 * </p>
 */
function codesARealRunDelivered(): readonly Readonly<{ code: string; count: number }>[] | null {
  const path = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "tools",
    "_multiday_routine-round78-live-runner.log",
  );
  if (!existsSync(path)) return null;
  const counts = new Map<string, number>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const at = line.indexOf("BRIDGE_FACT ");
    if (at < 0) continue;
    let fact: unknown;
    try {
      fact = JSON.parse(line.slice(at + "BRIDGE_FACT ".length));
    } catch {
      continue;
    }
    const payload = (fact as { worldFactPayload?: unknown }).worldFactPayload ?? fact;
    if (payload === null || typeof payload !== "object") continue;
    const record = payload as { state?: unknown; reasonCode?: unknown };
    if (!REFUSED_RECEIPT_STATES.has(String(record.state))) continue;
    if (typeof record.reasonCode !== "string" || record.reasonCode === "") continue;
    counts.set(record.reasonCode, (counts.get(record.reasonCode) ?? 0) + 1);
  }
  return [...counts].map(([code, count]) => ({ code, count })).sort((left, right) => right.count - left.count || left.code.localeCompare(right.code));
}

/** The receipt states in which a fact is a refusal rather than a step that happened. */
const REFUSED_RECEIPT_STATES: ReadonlySet<string> = new Set(["rejected", "failed", "blocked", "uncertain"]);

/**
 * The receipt-path family this gate does NOT take its population from, recorded with the command that measured it.
 *
 * It is printed beside the verdict so a reader sees the larger set exists and why it is not this gate's: those codes are
 * `ExecutionState.Rejected` receipt reasons, and NONE of the eight a real run delivered is among them - a population that
 * excludes every code she read cannot be the population for "a refusal she reads is a sentence". They are not unrendered
 * either: a refused receipt is exactly what `receiptLine` renders, through this same table.
 *
 * `node tools/check-refusal-informativeness.mjs`, 2026-11-19: `actions=106 reasonFamilies=344 reasonCodes=345
 * receiptSites=521`. A reading, not a gate input: it is a report, and the day it changes this line is stale prose rather
 * than a false pass.
 */
const REFUSED_AS_RECEIPT_MEASURED = 345;

/**
 * The codes the Mod's clearing join publishes, from ITS OWN closed set.
 *
 * `FarmhandForEachHealing.RefusalCodes` is an array the Mod compiles from the same constants its join returns, and it is
 * the one family whose codes are minted with a parameterisation (`no_safe_clear:crop:scythe_crop`), so it cannot be read
 * out of a `const string` name convention: those constants are `NoSafeClear` and `NoPublishedActionClears`, and neither
 * says "reason". A declaration that cannot be read is a BLOCKED reading, never an empty set that agrees with itself.
 */
function clearingRefusalCodes(): readonly string[] {
  const source = readFileSync(HEALING_SOURCE, "utf8");
  const declared = /RefusalCodes\s*=\s*Array\.AsReadOnly\(new\[\]\s*\{([^}]*)\}\)/u.exec(source);
  assert.ok(
    declared !== null,
    `blocked: the Mod declares no RefusalCodes array in ${HEALING_SOURCE}, so this source contributes nothing`,
  );
  const constants = new Map(
    [...source.matchAll(/public const string (\w+) = "([a-z0-9_]+)";/gu)].map((match) => [
      match[1] ?? "",
      match[2] ?? "",
    ]),
  );
  return (declared[1] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => {
      const value = constants.get(name);
      assert.ok(value !== undefined, `blocked: ${name} is in RefusalCodes and this file declares no literal for it`);
      return value;
    });
}

/** One code in the population, and where it came from. */
type RefusalSource = "declared" | "navigation" | "clearing" | "delivered";

/**
 * The population: every declared code, every navigation terminal that is a refusal, and every code a recorded run
 * actually delivered.
 *
 * The third source is what keeps the first two honest - a declaration set is a claim about the Mod, and the delivery is
 * the fact.
 */
function refusalPopulation(delivered: readonly Readonly<{ code: string; count: number }>[] | null): readonly Readonly<{
  code: string;
  source: RefusalSource;
}>[] {
  const byCode = new Map<string, RefusalSource>();
  for (const code of navigationRefusalCodes()) byCode.set(code, "navigation");
  for (const code of clearingRefusalCodes()) if (!byCode.has(code)) byCode.set(code, "clearing");
  for (const code of declaredReasonCodes(shippedModSources())) if (!byCode.has(code)) byCode.set(code, "declared");
  for (const entry of delivered ?? []) if (!byCode.has(entry.code)) byCode.set(entry.code, "delivered");
  return [...byCode].map(([code, source]) => ({ code, source })).sort((left, right) => left.code.localeCompare(right.code));
}

type RefusalCoverage = Readonly<{
  examined: number;
  rendered: number;
  machineOnly: number;
  findings: readonly string[];
}>;

/**
 * The judgement, as a pure function of the population and a renderer.
 *
 * A code passes when this module composes a sentence for it, or when it is declared machine-only WITH a reason. Anything
 * else is a code the model would read bare, which is the defect: a code names the fact and never what to do about it.
 *
 * A TOKEN IS NOT A SENTENCE, so a guidance string with no spaces and no full stop is a finding rather than a pass - the
 * cheapest way to make a coverage gate green is to hand the token back. The check is a SHAPE (`sentenceShape`) rather than
 * a ban on the code's spelling: `stopped` is a code AND an ordinary English word, and a rule that refused the word would
 * refuse the sentence that explains it.
 */
function judgeRefusalCoverage(codes: readonly string[], render: (code: string) => string | null): RefusalCoverage {
  const findings: string[] = [];
  let rendered = 0;
  let machineOnly = 0;
  for (const code of codes) {
    const guidance = render(code);
    if (guidance !== null) {
      if (!sentenceShape(guidance)) findings.push(`sentence_is_a_token:${code}`);
      else rendered += 1;
      continue;
    }
    const reason = MACHINE_ONLY_REFUSAL_CODES.get(code);
    if (reason !== undefined && reason.trim().length > 0) {
      machineOnly += 1;
      continue;
    }
    findings.push(`code_reads_bare:${code}`);
  }
  return { examined: codes.length, rendered, machineOnly, findings };
}

/**
 * Whether a guidance string is a sentence a reader can act on rather than the code printed back.
 *
 * Words and a full stop, which a reason code never has: every code in this population is one `snake_case` token. Six words
 * is below the shortest sentence this table composes and far above a token, so the reading is about the SHAPE and not about
 * how long the author happened to be.
 */
function sentenceShape(guidance: string): boolean {
  const trimmed = guidance.trim();
  return trimmed.split(/\s+/u).length > 6 && /[.!?]/u.test(trimmed);
}

/**
 * The sentence this module composes for one code.
 *
 * A clearing code is parameterised (`no_safe_clear:<occupant>:<action>`) because the Mod publishes it that way, and the
 * bare code alone is not a shape it mints; every other family is minted as the code itself.
 */
function sentenceFor(code: string): string | null {
  const direct = remedyForRefusal(code, null)?.guidance ?? null;
  if (direct !== null) return direct;
  return remedyForRefusal(`${code}:occupant:action`, null)?.guidance ?? null;
}

test("a_refusal_she_reads_is_a_sentence: every code the Mod declares or a real run delivered has words", (t) => {
  const delivered = codesARealRunDelivered();
  const population = refusalPopulation(delivered);
  assert.ok(population.length > 0, "blocked: the population is empty, so this gate would agree with itself");
  for (const [code, reason] of MACHINE_ONLY_REFUSAL_CODES)
    assert.ok(reason.trim().length > 0, `a machine-only exemption carries its reason or it is a silent drop: ${code}`);

  const verdict = judgeRefusalCoverage(
    population.map((entry) => entry.code),
    sentenceFor,
  );
  const seen = delivered ?? [];
  const declared = new Set(population.filter((entry) => entry.source !== "delivered").map((entry) => entry.code));
  const deliveredOnly = seen.filter((entry) => !declared.has(entry.code)).map((entry) => entry.code);
  const uncovered = seen.filter((entry) => sentenceFor(entry.code) === null).map((entry) => entry.code);
  const bySource = (source: RefusalSource): number => population.filter((entry) => entry.source === source).length;

  process.stdout.write(
    `\na_refusal_she_reads_is_a_sentence: codes examined ${String(verdict.examined)} · rendered ${String(verdict.rendered)}` +
      ` · machine-only ${String(verdict.machineOnly)} (declared ${String(bySource("declared"))} + navigation ${String(
        bySource("navigation"),
      )} + clearing ${String(bySource("clearing"))} + delivered-only ${String(bySource("delivered"))})\n`,
  );
  process.stdout.write(
    delivered === null
      ? "  seen in a real run: not_measured (tools/_multiday_routine-round78-live-runner.log is not on this tree)\n"
      : `  seen in round78: ${String(seen.length)} (${seen.map((entry) => `${entry.code} ${String(entry.count)}`).join(", ")})` +
          ` · declared ${String(seen.length - deliveredOnly.length)} · seen-only ${String(deliveredOnly.length)}${
            deliveredOnly.length === 0 ? "" : ` (${deliveredOnly.join(", ")})`
          } · covered ${String(seen.length - uncovered.length)} · uncovered ${String(uncovered.length)}\n`,
  );
  process.stdout.write(
    `  refused-as-receipt ${String(REFUSED_AS_RECEIPT_MEASURED)} (a different family, rendered by the receipt line)\n`,
  );
  t.diagnostic(`codes examined ${String(verdict.examined)} · rendered ${String(verdict.rendered)} · machine-only ${String(verdict.machineOnly)}`);

  assert.deepEqual(
    verdict.findings,
    [],
    "a refusal code that reaches the model without a sentence is a dead end: the Mod names the fact and this module owes the Agent what to do about it",
  );
});

test("the coverage judgement is red for a code whose sentence is deleted", () => {
  // THE FALSIFIER: withhold exactly one code's sentence - what deleting its branch does - and the judgement names that code
  // rather than passing because the rest of the table still answers. The population is still the Mod's own, and the code
  // withheld is the one a real run read most often.
  const codes = refusalPopulation(codesARealRunDelivered()).map((entry) => entry.code);
  const deleted = "no_native_path";
  assert.ok(codes.includes(deleted), `blocked: ${deleted} is not in the population, so withholding it proves nothing`);
  const verdict = judgeRefusalCoverage(codes, (code) => (code === deleted ? null : sentenceFor(code)));

  assert.ok(
    verdict.findings.includes(`code_reads_bare:${deleted}`),
    `withholding ${deleted}'s sentence must be named, got ${verdict.findings.join(" ")}`,
  );
  // And a sentence that prints the code back is not a sentence: the cheapest way to make the count look right.
  const restated = judgeRefusalCoverage([deleted], (code) => code);
  assert.ok(
    restated.findings.includes(`sentence_is_a_token:${deleted}`),
    "a guidance string that is the code itself must be refused as a token, not counted as a sentence",
  );
});

test("the clearing refusal names the occupant, the swing that was withheld, and the step that can take it", () => {
  // The shape the Mod actually publishes, read through the function the tool layer calls, so this is the Agent's text.
  const remedy = describeRefusalRemedy("no_safe_clear:crop:scythe_crop", null);
  assert.equal(remedy?.action, "stardew_plan_work", "the next step is a plan step, not a flat tool");
  assert.match(remedy?.guidance ?? "", /crop/, "the sentence has to name what is standing there");
  assert.match(remedy?.guidance ?? "", /scythe_crop/, "and the swing it weighed, which is what she may still choose");
  assert.match(remedy?.guidance ?? "", /yourself/, "the decision is hers, and the sentence must say so");
  assert.doesNotMatch(remedy?.guidance ?? "", /no safe clear/i, "a restatement of the code is not a sentence");
});

test("a tile nothing published clears says to stop asking it", () => {
  const remedy = describeRefusalRemedy("no_published_action_clears:object", null);
  assert.equal(remedy?.action, null, "no tool changes it, so none may be named");
  assert.match(remedy?.guidance ?? "", /object/);
  assert.match(remedy?.guidance ?? "", /different one/, "the Agent must be told what to do instead of re-issuing");
});
