import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { STARDEW_ACTION_TOOL_NAMES } from "./action-registry.js";
import { planActionsFromRegistrations } from "./body-program-script.js";
import { ADVERTISED, MOUNTED_GAME_SURFACE_TOOL_NAMES } from "./game-surface-prompt-floor.test-support.js";
import { evidenceDetailOf, evidenceField, remedyForBodyHold } from "./stardew-action-remedy.js";

test("every named hold gets a countermeasure, and none of them is the same text", () => {
  const codes = ["actor_held_by_modal", "transient_busy", "cutscene_active", "actor_passed_out"];
  const guidances = codes.map((code) => remedyForBodyHold(code, null)?.guidance);
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

test("a modal points at the plan step that matches whether an answer is owed", () => {
  const question = remedyForBodyHold("actor_held_by_modal", "modal_type=DialogueBox;is_question=true;can_move=false");
  assert.equal(question?.action, "stardew_plan_work");
  assert.match(question?.guidance ?? "", /'answer_dialogue'/);
  assert.match(question?.guidance ?? "", /stardew_plan_work/);

  const informational = remedyForBodyHold(
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
  const remedy = remedyForBodyHold(
    "actor_held_by_modal",
    "modal_type=LetterViewerMenu;is_question=unknown;can_move=false",
  );
  assert.equal(remedy?.action, "stardew_plan_work");
  assert.match(remedy?.guidance ?? "", /refuses menus it is not allowed to close/);
  assert.match(remedy?.guidance ?? "", /report the blockage/, "the Agent must be told what to do if the remedy fails");
});

test("a transient hold tells the Agent to wait and to keep the SAME target", () => {
  const remedy = remedyForBodyHold(
    "transient_busy",
    "transient_kind=toolAnimation;retry_window_ms=2000;can_move=false",
  );
  assert.equal(remedy?.action, null, "no tool can shorten a transient, so none may be named");
  assert.match(remedy?.guidance ?? "", /toolAnimation/);
  assert.match(remedy?.guidance ?? "", /2000/);
  assert.match(remedy?.guidance ?? "", /SAME request/, "changing the target is the failure mode this prevents");
});

test("a hold with no countermeasure says so instead of naming a tool", () => {
  for (const code of ["cutscene_active", "actor_passed_out"]) {
    const remedy = remedyForBodyHold(code, null);
    assert.equal(remedy?.action, null, `${code} cannot be cleared by a tool`);
    assert.match(remedy?.guidance ?? "", /retry|Do not issue|Do not retry/i);
  }
});

test("a cutscene points at the plan step that acts on the box it is showing", () => {
  // A cutscene is not one state. Two handlers act on its own dialogue box, and the evidence says which box is on
  // screen - the same fact the modal hold publishes. The dead end this replaces: one sentence for both, telling a run
  // that could have advanced the box that no action can run (four retries over twenty minutes).
  const question = remedyForBodyHold(
    "cutscene_active",
    "event_up=true;dialogue_box=true;is_question=true;admissible_actions=answer_dialogue,dismiss_modal;can_move=false",
  );
  assert.equal(question?.action, "stardew_plan_work");
  assert.match(question?.guidance ?? "", /'answer_dialogue'/);
  assert.match(question?.guidance ?? "", /'dismiss_modal'/, "the way to learn the offered keys must be named");

  const informational = remedyForBodyHold(
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
  const bare = remedyForBodyHold(
    "cutscene_active",
    "event_up=true;dialogue_box=false;admissible_actions=none;next_step=wait_for_event_to_advance;can_move=false",
  );
  assert.equal(bare?.action, null);
  assert.match(bare?.guidance ?? "", /Do not issue actions until the scene ends/);
});

test("a cutscene with nothing to act on is its own code, with its own answer", () => {
  // The modal family was admitted into the cutscene and found no box. That is a wait which ends by itself, not the
  // anonymous cutscene hold whose countermeasure a run is still looking for.
  const remedy = remedyForBodyHold(
    "event_has_no_dialogue_box",
    "event_up=true;dialogue_box=false;admissible_actions=none;next_step=wait_for_event_to_advance;can_move=false",
  );
  assert.equal(remedy?.action, null, "no tool advances an event's own command program");
  assert.match(remedy?.guidance ?? "", /no dialogue box on screen/);
  assert.match(remedy?.guidance ?? "", /advances on its own/);
  assert.notEqual(
    remedy?.guidance,
    remedyForBodyHold("cutscene_active", null)?.guidance,
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
  const guidances = owners.map((code) => remedyForBodyHold(code, null)?.guidance);
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
  const movement = remedyForBodyHold("body_owned_by_movement", null)?.guidance ?? "";
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
    assert.match(remedyForBodyHold(code, null)?.guidance ?? "", /Wait for/, `${code} cannot be interrupted`);
  }
  // Navigation is deliberately in the settle-only list above, matching the Mod's own `interruptible=false`.
  // It used to offer a takeover here as well; that contradicted the structured fact published in the same
  // snapshot, and the movement path has no clean takeover to offer (`RequestLocalMove`'s occupancy guard does
  // not include `activeNavigate`). One authority, one answer.
  const navigation = remedyForBodyHold("body_owned_by_navigation", null)?.guidance ?? "";
  assert.match(navigation, /cannot be taken over/, "the guidance must say so plainly");
  assert.doesNotMatch(navigation, /also takes over|takes over from/, "and must not promise a takeover the Mod denies");
});

test("a body_owned_* code the table does not list still gets a generic actionable remedy", () => {
  // A named hold the Host has not heard of yet must not degrade to an unknown-error dead end.
  const remedy = remedyForBodyHold("body_owned_by_future_owner", null);
  assert.equal(remedy?.action, null, "a prefixed hold names no tool");
  assert.match(remedy?.guidance ?? "", /Wait for it to settle/);
  assert.match(remedy?.guidance ?? "", /re-issue the same request/);
});

test("the bare legacy body_owned stays a dead end for the prefix fallback", () => {
  // `body_owned` is not `body_owned_`: the fallback must not swallow the code whose test asserts no remedy.
  assert.equal(remedyForBodyHold("body_owned", null), null);
});

test("a queued request that outlived its wait names the owner it waited for", () => {
  // The Mod parks a request behind the actor's OWN in-flight work and dispatches it when that work ends. When the
  // boundary is crossed, the wait answers with `waiting_for_body:<owner>` - a code neither the named table nor the
  // `body_owned_` prefix fallback covers. It must still give the Agent a next step, and it must name the owner.
  const remedy = remedyForBodyHold(
    "waiting_for_body:body_owned_by_activity",
    "owner_execution_id=exec_1;owner_action=pickup_item",
  );
  assert.equal(remedy?.action, null, "the wait is over: there is no tool to call");
  assert.match(remedy?.guidance ?? "", /pickup_item/, "the guidance must name the owner, not just the hold");
  assert.match(remedy?.guidance ?? "", /Re-issue the same request/);
  // Evidence is optional: without it the code itself still says which owner the wait was for.
  const withoutDetail = remedyForBodyHold("waiting_for_body:body_owned_by_movement", null);
  assert.match(withoutDetail?.guidance ?? "", /body_owned_by_movement/);
});

test("a reason code that is not a body hold gets no remedy", () => {
  // Attaching a remedy here would tell the Agent to close a dialogue that is not open.
  for (const code of [
    "player_not_actionable",
    "invalid_target_tile",
    "no_native_path",
    "body_owned",
    "accepted",
    null,
  ]) {
    assert.equal(remedyForBodyHold(code, "modal_type=DialogueBox"), null, `${String(code)} is not a body hold`);
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
