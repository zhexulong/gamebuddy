#!/usr/bin/env node
/**
 * Gate: plan_legal_fixpoint/v1 - "talk, then buy" either runs as written, or the refusal hands back a step that does.
 *
 * WHY (measured, round42 day 6). A player's obvious plan - talk to the shopkeeper, then buy - died four times in one
 * live run, and no gate looked at the pair. Two of the product's own rules were each locally justified:
 *
 *   1. `body-program-script.ts` refuses any step written after an action that leaves the body held (`talk_to_npc`
 *      raises a native dialogue, `player.CanMove = false`, and the Mod reports the node Succeeded while it is up);
 *   2. the shop handler requires the actor within reach of the shop's OWNER tile.
 *
 * The first rule is a PLAN-SHAPE rule, so it is the one a gate can read without a game: for every action the compiler
 * declares body-yielding (Y) and every action the surface publishes (X), the two-node program `[Y, X]` must either
 * compile INTO A PROGRAM THAT CARRIES BOTH STEPS, or be refused with a remedy that, applied mechanically, compiles. A
 * pair that does neither is a dead end: a published action that the product's own rules make unreachable, invisible
 * until a live run spends a turn on it.
 *
 * MEASURED, so the reading below is not a matter of opinion. At `3d249ff1` (the commit before the compiler wrote the
 * dismissal itself), `builder.talk_to_npc(...); builder.shop_purchase(...)` returned `ok: true` with ONE node: the
 * purchase call was rejected, the plan was submitted without it, and the answer reported a successful plan. Reading
 * `ok` therefore answers the wrong question - which is why acceptance here is "the program carries the steps", and why
 * `node tools/check-plan-legal-fixpoint.mjs --revision 3d249ff1...` replays 94 of 96 pairs as dead ends, the pinned
 * `talk_to_npc->shop_purchase` among them.
 *
 * THE PROPERTY, for every pair (Y, X), is the fixpoint of the two rules rather than either rule alone:
 *
 *   1. ACCEPTED  - the compiled program carries a node of Y and a node of X (every requested step, in the count the
 *                  script asked for; the compiler may add nodes of its own, such as a walk or a dismissal);
 *   2. REPAIRED  - the plan was REFUSED (`ok: false`, so nothing ran) and the refusal names a `<key>=<actionId>`
 *                  remedy whose mechanical application - that action inserted between the two steps - compiles and
 *                  carries all three;
 *   3. DEAD END  - everything else, named `plan_dead_end:<Y>-><X>:<code>`. An `ok` answer that does not carry the step
 *                  is a dead end even when the dropped call named a workable remedy: the plan was accepted, the step
 *                  never ran, and the remedy was advice rather than something the program did.
 *
 * THE SECOND ASSERTION, same class and nearly free: an action whose own precondition is a modal must not be declared
 * body-yielding. Both sides are declarations - the Host's own adapter table says what an action acts on
 * (`targetKinds` includes `modal`: `dismiss_modal`, `answer_dialogue`, `respond_level_up`), and the compiler exports
 * the set it calls body-yielding. A member of both is a contradiction by definition (`plan_rule_contradiction:<X>:
 * <why>`): it can only run when a modal is open, so declaring that it leaves the body held would write a dismissal
 * after the very step that cleared it.
 *
 * THE THIRD AND FOURTH ASSERTIONS read the SAME answers, because a pair table cannot see the defect that matters most:
 *
 *   3. NO FORGED SUCCESS - an `ok` answer means every step the author wrote is in the program. An `ok` answer that says
 *                        it dropped a call is red, named `forged_success:<shape>:<dropped>`. That is the shape that
 *                        shipped at `3d249ff1` and again round40 (`accepted: true` beside `droppedCount: 15`), and it is
 *                        the most expensive answer this product can give: the companion plans around work that never ran
 *                        and nothing in the program or the answer disagrees with her.
 *   4. NO VANISHED CALL - the compiler answers with four lists that PARTITION the author's calls (`acceptedSteps`,
 *                        `merged`, `noStepNeeded`, `dropped`), so their counts must sum to the number of calls the script
 *                        made, each call must land in exactly one, and no list may be a window narrower than its own
 *                        count. Named `plan_account_gap|_double|_truncated|_unplaceable:<shape>:...`. The stated limit:
 *                        a refusal that ends the WHOLE script stops the interpreter, so the calls after it were never
 *                        reached; this population writes published action ids only, so no answer here is that shape.
 *
 * Both read an answer's own account, in whichever spelling it says it in: `dropped` on today's answer, the `rejected`
 * records on one from before the field existed - so `--revision 3d249ff1` is red for the FORGED reason and `blocked`
 * for the accounting one ("not measured") rather than green over nothing.
 *
 * WHAT IS READ, and how (no fifth parser):
 *   - the compiler MODULE, imported and driven: `compilePlanScript` and `planActionsFromRegistrations` are the
 *     product's own admission and refusal functions, so a new rule or a new argument shape is covered the same run;
 *   - Y from the compiler's exported `BODY_YIELDING_PLAN_ACTION_IDS` - the declaration `emitPlanNode` itself checks,
 *     never a list repeated here;
 *   - X from the generated action surface the Mod publishes, admitted through `planActionsFromRegistrations` - the same
 *     two steps the Host takes when it mounts `stardew_plan_work`;
 *   - the modal-targeted side from `host/src/action-registry.ts`'s `STARDEW_ACTION_ADAPTERS`, the adapter table the
 *     per-action tools are built from.
 * The pair world is the whole world a pair needs: no game, no bridge, no snapshot beyond the minimum the compiler
 * requires (`PAIR_SNAPSHOT`), because a pair is a question about ORDER and not about which tile is which. Every X is
 * asserted writable alone in that world first, so a pair result is about the pair and never about a value this gate
 * could not write.
 *
 * Usage:
 *   node tools/check-plan-legal-fixpoint.mjs                     # the gate; exit 1 on a dead end, a contradiction, a forged
 *                                                               # success, an account that does not add up, or a population
 *                                                               # it could not measure
 *   node tools/check-plan-legal-fixpoint.mjs --json              # the reading, machine-readable
 *   node tools/check-plan-legal-fixpoint.mjs --revision <rev>    # the RED PROOF: the compiler as that commit had it
 *
 * Zero population is `blocked`, never green: an empty Y or X, a Y the surface does not publish, or an X this gate
 * cannot write alone all mean the pairs were not measured.
 *
 * red-proof: history  `--revision 3d249ff1894040dc2f0a960486dff1ff04992946` (the commit before the compiler wrote the
 *            dismissal) -> `plan_dead_end:talk_to_npc->shop_purchase:...:dismiss_first=dismiss_modal`, 94 of 96 pairs
 *            dead, and the same pair named `forged_success:pair:talk_to_npc->shop_purchase:n02:plan_script_action_after_
 *            body_yield:shop_purchase:talk_to_npc:dismiss_first=dismiss_modal`, exit 1
 *            (tools/check-plan-legal-fixpoint.test.mjs)
 * red-proof: history  the same run prints `... forged 188 · accounted 0` and `call_accounting: blocked` over 474 answers:
 *            a compiler from before the account existed cannot pass assertion 4, it can only fail to be measured by it
 *            (tools/check-plan-legal-fixpoint.test.mjs)
 * red-proof: inject   an `ok` answer carrying only the first of the two steps -> `accepted_without_step` dead end, not
 *            `accepted` - the shape the pre-fix compiler actually returned (tools/check-plan-legal-fixpoint.test.mjs)
 * red-proof: inject   an `ok` answer whose own refusals name a call -> `forged_success:<shape>:<dropped>`, with its
 *            accounting clean, so the finding is the forged success and nothing else
 *            (tools/check-plan-legal-fixpoint.test.mjs)
 * red-proof: inject   an account that loses a call, lists one twice, cuts a list short of its count, or numbers a step
 *            past the calls written -> `plan_account_gap|_double|_truncated|_unplaceable:<shape>`
 *            (tools/check-plan-legal-fixpoint.test.mjs)
 * red-proof: inject   a plan-level refusal naming `dismiss_first=<id>` whose application compiles -> `repaired`, no
 *            dead end (tools/check-plan-legal-fixpoint.test.mjs)
 * red-proof: inject   a refusal naming no remedy while `[Y, <clearing>, X]` compiles by hand -> `refused` dead end that
 *            says the compiler is the one that must write the step (tools/check-plan-legal-fixpoint.test.mjs)
 * red-proof: inject   `dismiss_modal` added to the body-yielding declaration -> `plan_rule_contradiction:dismiss_modal:`
 *            (tools/check-plan-legal-fixpoint.test.mjs)
 * red-proof: inject   an empty Y, an empty X, a Y the surface does not publish, or an X that cannot be written alone ->
 *            `blocked`, never a green run (tools/check-plan-legal-fixpoint.test.mjs)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const GATE = "plan_legal_fixpoint/v1";

/** Every file this gate reads. The surface is the Mod's emitted declaration; the two `.ts` files are the Host's. */
export const SOURCES = Object.freeze({
  surface: "integrations/stardew/action-development/contracts/generated/action-surface.v1.json",
  compiler: "host/src/body-program-script.ts",
  registry: "host/src/action-registry.ts",
});

/**
 * The commit the red proof replays: the tree as it was when the compiler still refused a step after a body-yielding
 * one instead of writing the dismissal itself. Pinned rather than `HEAD` because HEAD moves the moment the fix lands,
 * and a red proof that follows HEAD silently stops being a proof.
 */
export const PRE_FIX_REVISION = "3d249ff1894040dc2f0a960486dff1ff04992946";

/**
 * The world a pair is compiled against: the minimum `compilePlanScript` requires, and nothing a pair could be about.
 * `tile` is where the actor stands (unused by an ordering rule), `enabledActionIds` is the vocabulary the compiler
 * checks the snapshot is usable against.
 */
export function pairSnapshot(actionIds) {
  return Object.freeze({
    revision: 1,
    mapId: "plan_fixpoint_fixture",
    tile: Object.freeze({ x: 5, y: 5 }),
    enabledActionIds: Object.freeze([...actionIds]),
  });
}

let hooksRegistered = false;

/**
 * The Host's plan compiler, imported and driven.
 *
 * The compiler is TypeScript whose own imports name `.js` files that exist as `.ts` (a build rewrites them), so a plain
 * `import` of the source cannot resolve its graph. One resolve hook, registered once, maps a relative `.js` specifier
 * inside `host/src` onto the `.ts` file beside it - the module the build would have loaded.
 *
 * `revision` serves that same module from a git revision instead of the worktree, which is the red proof and its only
 * caller. A revision that predates the exported declaration (`3d249ff1` has the set, `const` and unexported) lends its
 * CLASSIFIER and nothing else: Y is read from the tree under review, because the question is what today's declaration
 * does against the older compiler.
 */
export function loadPlanCompiler({ revision = null, root = REPOSITORY_ROOT } = {}) {
  registerHostTypeScript({ root });
  const compilerUrl = pathToFileURL(path.resolve(root, SOURCES.compiler)).href;
  const source = revision === null ? null : revisionSource(revision, root);
  const url = source === null ? compilerUrl : `${compilerUrl}?revision=${encodeURIComponent(revision)}`;
  if (source !== null) historicalSources.set(url, source);
  return import(url).then((compiler) => ({
    revision,
    compilePlanScript: compiler.compilePlanScript,
    planActionsFromRegistrations: compiler.planActionsFromRegistrations,
    bodyYieldingActionIds: () => bodyYieldingActionIdsOf(compiler, root),
  }));
}

/** The one revision override a run can hold: the URL it was requested for, keyed beside its source. */
const historicalSources = new Map();

function revisionSource(revision, root) {
  try {
    return execFileSync("git", ["show", `${revision}:${SOURCES.compiler}`], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(
      `plan_fixpoint_history_skipped: revision ${revision} is not in this checkout (${scratchOf(error)})`,
    );
  }
}

/** git's own words, on one line, so a missing revision reads as a reason and not as a stack trace. */
function scratchOf(error) {
  const stderr = typeof error?.stderr === "string" ? error.stderr : "";
  return stderr.trim().split("\n")[0] ?? error?.message ?? String(error);
}

function registerHostTypeScript({ root }) {
  if (hooksRegistered) return;
  hooksRegistered = true;
  const hostSourceDirectory = path.resolve(root, "host", "src") + path.sep;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL ?? "";
      if (
        !(
          specifier.startsWith(".") &&
          specifier.endsWith(".js") &&
          parent.startsWith(pathToFileURL(hostSourceDirectory).href)
        )
      )
        return nextResolve(specifier, context);
      const candidate = new URL(specifier.replace(/\.js$/u, ".ts"), parent);
      return existsSync(fileURLToPath(candidate))
        ? { url: candidate.href, shortCircuit: true, format: "module-typescript" }
        : nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      const source = historicalSources.get(url);
      if (source === undefined) return nextLoad(url, context);
      return { format: "module-typescript", source, shortCircuit: true };
    },
  });
}

/**
 * The yielding declaration as the compiler exported it, or the empty set with the reason it could not be read.
 *
 * A revision that predates the export answers nothing here; the tree under review does, because the declaration is the
 * thing being tested and the revision only lends its classifier.
 */
async function bodyYieldingActionIdsOf(compiler, root) {
  if (Array.isArray(compiler.BODY_YIELDING_PLAN_ACTION_IDS))
    return Object.freeze([...compiler.BODY_YIELDING_PLAN_ACTION_IDS]);
  const current = await import(pathToFileURL(path.resolve(root, SOURCES.compiler)).href);
  return Array.isArray(current.BODY_YIELDING_PLAN_ACTION_IDS)
    ? Object.freeze([...current.BODY_YIELDING_PLAN_ACTION_IDS])
    : Object.freeze([]);
}

/** The published action surface, rebuilt into the registrations a live `hello_ack` advertises. */
export function readPublishedActions({ compiler, root = REPOSITORY_ROOT } = {}) {
  const surfacePath = path.resolve(root, SOURCES.surface);
  const surface = JSON.parse(readFileSync(surfacePath, "utf8"));
  const registrations = (surface.actions ?? []).map((action) =>
    Object.freeze({
      actionId: action.actionId,
      // The artifact does not publish the Mod's family id; `planActionsFromRegistrations` groups by it and this gate
      // counts ids, so one placeholder family carries every action rather than a second table of families here.
      familyId: "plan_fixpoint_family",
      identityVersion: action.identityVersion ?? 1,
      lifecycle: action.lifecycle,
      kind: action.kind,
      ...(action.argumentSchema === undefined
        ? {}
        : {
            descriptor: {
              argumentSchema: action.argumentSchema,
              outputFacts: action.outputFacts ?? {},
              ...(action.resourceTemplate === undefined ? {} : { resourceTemplate: action.resourceTemplate }),
            },
          }),
    }),
  );
  return Object.freeze({
    surfacePath: SOURCES.surface,
    surfaceActions: Object.freeze((surface.actions ?? []).map((action) => action.actionId)),
    actions: compiler.planActionsFromRegistrations(registrations),
  });
}

/** The actions whose own adapter says they act on a modal, read from the Host's table rather than repeated here. */
export async function readModalTargetedActionIds({ root = REPOSITORY_ROOT } = {}) {
  registerHostTypeScript({ root });
  const registry = await import(pathToFileURL(path.resolve(root, SOURCES.registry)).href);
  const adapters = registry.STARDEW_ACTION_ADAPTERS ?? [];
  return Object.freeze([
    ...new Set(adapters.filter((adapter) => adapter.targetKinds?.includes("modal")).map((adapter) => adapter.actionId)),
  ]);
}

/**
 * The value this gate writes for one declared argument.
 *
 * A pair is a question about ORDER, so every value is a legal constant of its declared type and nothing else: an
 * integer is `0`, an enum its first member, a destination selector a label. `undefined` means the declaration carries a
 * type this gate cannot write, which is reported rather than guessed.
 */
function valueOf(argument) {
  switch (argument.type) {
    case "integer":
      return 0;
    case "boolean":
      return true;
    case "destination_selector":
      return { kind: "label", label: "plan_fixpoint_destination" };
    case "string":
      return argument.enum === undefined ? "plan_fixpoint_value" : argument.enum[0];
    default:
      return undefined;
  }
}

/** One builder call for one published action, or the reason this gate could not write it. */
function callFor(action) {
  const supplied = {};
  for (const argument of action.arguments) {
    const value = valueOf(argument);
    if (value === undefined)
      return { ok: false, actionId: action.actionId, argument: argument.name, type: argument.type };
    supplied[argument.name] = value;
  }
  return {
    ok: true,
    script:
      action.arguments.length === 0
        ? `builder.${action.actionId}();`
        : `builder.${action.actionId}(${JSON.stringify(supplied)});`,
  };
}

/** The script for one program, or the first action it could not be written for. */
export function scriptFor(actions, actionIds) {
  const byId = new Map(actions.map((action) => [action.actionId, action]));
  const lines = [];
  for (const actionId of actionIds) {
    const action = byId.get(actionId);
    if (action === undefined) return { ok: false, actionId, reason: "not_published" };
    const call = callFor(action);
    if (!call.ok) return { ok: false, actionId, reason: `argument_${call.type}_unwritable` };
    lines.push(call.script);
  }
  return { ok: true, script: lines.join("\n") };
}

/**
 * Does the program carry every step the script asked for, in the count it asked for?
 *
 * THE MULTISET, not the set: `[talk_to_npc, talk_to_npc]` asking for one node twice is not satisfied by one node, and a
 * membership test would call that pair legal. Nodes the compiler adds (a walk, a dismissal) are not counted against it:
 * the property is that the author's steps survive, not that nothing was added.
 */
export function carriesSteps(compiled, steps) {
  if (compiled?.ok !== true) return false;
  const carried = new Map();
  for (const node of compiled.program?.nodes ?? []) carried.set(node.actionId, (carried.get(node.actionId) ?? 0) + 1);
  const wanted = new Map();
  for (const step of steps) wanted.set(step, (wanted.get(step) ?? 0) + 1);
  for (const [actionId, count] of wanted) if ((carried.get(actionId) ?? 0) < count) return false;
  return true;
}

/** The `<key>=<actionId>` remedies a refusal names, values only: the key says why, the value is what to write. */
export function remediesNamedIn(reasonCode) {
  const named = [];
  for (const [, value] of String(reasonCode).matchAll(/(?:^|:)[a-z][a-z0-9_]*=([a-z0-9_]+)(?=:|$)/gu))
    named.push(value);
  return Object.freeze([...new Set(named)]);
}

/** How many builder calls a script the gate itself wrote makes: one per `builder.<id>(`. */
export function callsIn(script) {
  return [...String(script).matchAll(/builder\.[a-z0-9_]+\(/gu)].length;
}

/**
 * What an answer says about the calls that were thrown away, in whichever of its two spellings it says it.
 *
 * The current answer carries `dropped` (`n03:plan_script_...`); the answer from before that field existed carries the
 * same refusals as `rejected` records, and an `ok` answer carrying THAT is exactly the forged success this check exists
 * for - so the older spelling is read rather than skipped. A check that could only see the newest field would report the
 * defect it was written for as zero violations on the history it was written against.
 */
export function droppedNamesOf(compiled) {
  if (Array.isArray(compiled?.dropped) && compiled.dropped.length > 0) return compiled.dropped;
  const rejected = compiled?.rejected;
  if (!Array.isArray(rejected)) return [];
  // Rendered in the grammar the current answer uses - `n02:<code>` - so a finding from an older revision reads exactly
  // like one from today's, and a reader is not asked to translate two spellings of the same fact.
  return rejected.map((rejection) => `n${String(rejection?.call).padStart(2, "0")}:${String(rejection?.reasonCode)}`);
}

/**
 * THE THIRD ASSERTION: what an answer says about the calls its own script wrote.
 *
 * <p>
 * Two halves, one sentence each. <b>NO FORGED SUCCESS</b> - an `ok` answer means every step the author wrote is in the
 * program, so an `ok` answer that says it dropped a call is the shape that shipped at `3d249ff1`
 * (`talk_to_npc` + `shop_purchase` compiled to ONE node and `ok: true`) and at round40 (`accepted: true` beside
 * `droppedCount: 15`). <b>NO VANISHED CALL</b> - the compiler's four lists partition her calls, so their counts must sum
 * to the number of calls the script made, each call must land in exactly one of them, and none may be a silent window.
 * A call in none of them is the defect; a call in two would hide it.
 * </p>
 * <p>
 * The population is every answer the pair reading already compiled - the same scripts, the same compiler - and the
 * authored call count is read from the script THIS GATE WROTE, which is the authority on what was asked for. An answer
 * that carries no account at all (a compiler from before the field existed) is not measured, and `statusOf` blocks the
 * run when nothing was: "0 violations" over an empty population is the silence this gate exists to break.
 * </p>
 */
export function readPlanCallTally(answers) {
  let ok = 0;
  let refused = 0;
  let measured = 0;
  const forged = [];
  const faults = [];
  for (const { shape, script, compiled } of answers) {
    if (compiled?.ok === true) {
      ok += 1;
      const dropped = droppedNamesOf(compiled);
      if (dropped.length > 0) forged.push(`forged_success:${shape}:${dropped[0]}`);
    } else refused += 1;
    // The account is only answerable by a compiler that keeps one.
    if (!Array.isArray(compiled?.acceptedSteps)) continue;
    measured += 1;
    const calls = callsIn(script);
    const lists = [
      ["acceptedSteps", compiled.acceptedSteps, compiled.acceptedStepsCount],
      ["merged", compiled.merged, compiled.mergedCount],
      ["noStepNeeded", compiled.noStepNeeded, compiled.noStepNeededCount],
      ["dropped", compiled.dropped, compiled.droppedCount],
    ];
    const counted = lists.reduce((total, [, entries, count]) => total + (Number(count) || 0), 0);
    if (counted !== calls)
      faults.push(
        `plan_account_gap:${shape}:the script made ${calls} call(s) and the answer accounts for ${counted} ` +
          `(acceptedSteps ${compiled.acceptedStepsCount}, merged ${compiled.mergedCount}, noStepNeeded ` +
          `${compiled.noStepNeededCount}, dropped ${compiled.droppedCount})`,
      );
    const seen = new Map();
    for (const [list, entries, count] of lists) {
      if (!Array.isArray(entries) || entries.length !== count)
        faults.push(
          `plan_account_truncated:${shape}:${list} spells ${Array.isArray(entries) ? entries.length : 0} of ${String(count)} ` +
            `entries, so the list is a window and the count cannot be read against it`,
        );
      for (const entry of Array.isArray(entries) ? entries : []) {
        // The call's own position is the first field of every entry, whatever the list: `n07`, `n07:into=n03:...`.
        const step = String(entry).split(":")[0];
        const previous = seen.get(step);
        if (previous !== undefined)
          faults.push(`plan_account_double:${shape}:${step} is in both ${previous} and ${list}`);
        seen.set(step, list);
        const named = /^n(\d+)$/u.exec(step);
        if (named === null || Number(named[1]) < 1 || Number(named[1]) > calls)
          faults.push(
            `plan_account_unplaceable:${shape}:${list} names ${step}, which is not one of the ${calls} calls written`,
          );
      }
    }
  }
  return Object.freeze({ examined: answers.length, ok, refused, measured, forged, faults });
}

/** What a pair is, as one name, so a finding and the pair it names cannot drift apart. */
function pairName(yieldingId, dependentId) {
  return `${yieldingId}->${dependentId}`;
}

/**
 * The reading: every pair judged, every dead end named, and the populations printed beside the verdict.
 *
 * `compile(script, actions)` is the compiler as a function of one script, so the falsifier suite can drive this reading
 * with a compiler that answers a shape today's does not (an `ok` answer that drops a step, a plan-level refusal that
 * names a remedy) without a second implementation of the rule being judged.
 */
export function readPlanLegalFixpoint({
  compile,
  actions,
  bodyYieldingActionIds,
  modalClearingActionIds = [],
  modalTargetedActionIds = [],
}) {
  const byId = new Map(actions.map((action) => [action.actionId, action]));
  const unmeasured = [];
  const deadEnds = [];
  /**
   * Every answer this reading is judged on, by the script that produced it.
   *
   * Recorded HERE rather than by a second pass, so the call-account assertion below and the pair assertion above are
   * driven by the same compiles of the same scripts: two populations measured separately would be two populations that
   * can disagree, and the one that drifts would be the one nobody reads.
   */
  const answers = new Map();
  const examine = (shape, script) => {
    const known = answers.get(script);
    if (known !== undefined) return known.compiled;
    const compiled = compile(script);
    answers.set(script, { shape, script, compiled });
    return compiled;
  };

  // EVERY X MUST BE WRITABLE ALONE. A pair whose second step this gate cannot express says nothing about the product,
  // and counting it as a dead end would blame the tree for a fixture it does not own.
  for (const action of actions) {
    const alone = scriptFor(actions, [action.actionId]);
    if (!alone.ok) {
      unmeasured.push(`plan_population_unwritable:${action.actionId}:${alone.reason}`);
      continue;
    }
    const compiled = examine(`alone:${action.actionId}`, alone.script);
    if (!carriesSteps(compiled, [action.actionId]))
      unmeasured.push(
        `plan_population_unwritable:${action.actionId}:${compiled?.ok === true ? "accepted_without_the_step" : compiled?.reasonCode}`,
      );
  }
  // A Y THE SURFACE DOES NOT PUBLISH would silently shrink the pair population to nothing; it is named instead.
  for (const yieldingId of bodyYieldingActionIds)
    if (!byId.has(yieldingId))
      unmeasured.push(
        `plan_population_unpublished:${yieldingId}:the yielding declaration names an action the surface does not publish`,
      );

  let accepted = 0;
  let repaired = 0;
  for (const yieldingId of bodyYieldingActionIds) {
    if (!byId.has(yieldingId)) continue;
    for (const action of actions) {
      const dependentId = action.actionId;
      const written = scriptFor(actions, [yieldingId, dependentId]);
      if (!written.ok) continue;
      const compiled = examine(`pair:${pairName(yieldingId, dependentId)}`, written.script);
      if (carriesSteps(compiled, [yieldingId, dependentId])) {
        accepted += 1;
        continue;
      }
      const repairedBy = repairedByRemedy({ examine, actions, yieldingId, dependentId });
      if (repairedBy !== null) {
        repaired += 1;
        continue;
      }
      deadEnds.push(deadEndOf({ examine, actions, yieldingId, dependentId, compiled, modalClearingActionIds }));
    }
  }

  const contradictions = [];
  const modalTargeted = Object.freeze(modalTargetedActionIds.filter((actionId) => byId.has(actionId)));
  // THE SECOND ASSERTION'S POPULATION, refused if it is empty: an adapter table that declares no modal target, or a
  // surface that publishes none of them, means this rule was not measured - and "no contradiction" over nothing is the
  // silence this gate exists to break.
  if (modalTargeted.length === 0)
    unmeasured.push(
      "plan_population_unmeasured:modal_targets:no published action declares a modal target, so the rule that a modal-" +
        "taking action may not be body-yielding was not measured",
    );
  for (const actionId of bodyYieldingActionIds)
    if (modalTargetedActionIds.includes(actionId))
      contradictions.push(
        `plan_rule_contradiction:${actionId}:declared body-yielding, but its own adapter says it acts on a modal ` +
          `(targetKinds includes "modal") - it can only run while a modal is open, so a dismissal written after it would ` +
          `be refused for having nothing to close`,
      );

  return Object.freeze({
    gate: GATE,
    population: Object.freeze({
      yielding: Object.freeze([...bodyYieldingActionIds]),
      published: actions.length,
      modalTargeted,
    }),
    pairs: Object.freeze({
      examined: bodyYieldingActionIds.filter((actionId) => byId.has(actionId)).length * actions.length,
      accepted,
      repaired,
      deadEnds: Object.freeze(deadEnds),
    }),
    answers: readPlanCallTally([...answers.values()]),
    contradictions: Object.freeze(contradictions),
    unmeasured: Object.freeze(unmeasured),
  });
}

/** The remedy a plan-level refusal named, if inserting it really compiles; `null` when nothing named works. */
function repairedByRemedy({ examine, actions, yieldingId, dependentId }) {
  const written = scriptFor(actions, [yieldingId, dependentId]);
  if (!written.ok) return null;
  const compiled = examine(`pair:${pairName(yieldingId, dependentId)}`, written.script);
  // Only a REFUSED plan can be repaired: an `ok` answer that dropped the step ran without it, and inserting a step into
  // a plan that was already accepted is not applying a remedy to anything.
  if (compiled?.ok !== false) return null;
  for (const remedyId of remediesNamedIn(compiled.reasonCode)) {
    const applied = scriptFor(actions, [yieldingId, remedyId, dependentId]);
    if (
      applied.ok &&
      carriesSteps(examine(`hand:${pairName(yieldingId, dependentId)}+${remedyId}`, applied.script), [
        yieldingId,
        remedyId,
        dependentId,
      ])
    )
      return remedyId;
  }
  return null;
}

/** One dead end: the pair, the code that made it one, and what would have to change for the pair to stop being one. */
function deadEndOf({ examine, actions, yieldingId, dependentId, compiled, modalClearingActionIds }) {
  const kind = compiled?.ok === true ? "accepted_without_step" : "refused";
  const code =
    compiled?.ok === true ? (compiled.rejected?.[0]?.reasonCode ?? "accepted_without_the_step") : compiled?.reasonCode;
  const named = compiled?.ok === true ? remediesNamedIn(compiled.rejected?.[0]?.reasonCode ?? "") : [];
  const handWritten = modalClearingActionIds.filter((actionId) => {
    const applied = scriptFor(actions, [yieldingId, actionId, dependentId]);
    return (
      applied.ok &&
      carriesSteps(examine(`hand:${pairName(yieldingId, dependentId)}+${actionId}`, applied.script), [
        yieldingId,
        actionId,
        dependentId,
      ])
    );
  });
  const carried = compiled?.ok === true ? (compiled.program?.nodes ?? []).length : 0;
  const change =
    kind === "accepted_without_step"
      ? `the answer was accepted and carried ${carried} node(s); the dropped call named ${named.length > 0 ? named.join(",") : "no remedy"}` +
        `${named.length > 0 ? ` and writing it by hand ${handWritten.length > 0 ? "compiles" : "does not compile"}` : ""} - ` +
        `the compiler must write the step or refuse the plan with the remedy`
      : `the refusal names no <key>=<actionId> remedy; ` +
        (handWritten.length > 0
          ? `writing [${yieldingId}, ${handWritten[0]}, ${dependentId}] by hand does compile, so the missing step is one the compiler must write itself`
          : `no declared body-clearing action between the two steps compiles either`);
  return Object.freeze({
    pair: pairName(yieldingId, dependentId),
    kind,
    code,
    remedy: Object.freeze(named),
    handWritten,
    change,
  });
}

/**
 * The verdict: a reading that measured nothing cannot pass, whatever it found.
 *
 * `failed` BEATS `blocked`, and that order is deliberate: a revision that predates a field blocks one assertion while
 * the others still find a real defect, and reporting `blocked` over a found defect would report the weaker fact first.
 * `blocked` therefore means "nothing failed, and something was not measured".
 */
export function statusOf(reading) {
  if (
    reading.pairs.deadEnds.length > 0 ||
    reading.contradictions.length > 0 ||
    reading.answers.forged.length > 0 ||
    reading.answers.faults.length > 0
  )
    return "failed";
  if (reading.pairs.examined === 0 || reading.unmeasured.length > 0 || reading.answers.measured === 0) return "blocked";
  return "passed";
}

/**
 * Each rule this gate enumerates, with its own outcome.
 *
 * One entry per assertion rather than the whole-run verdict, because that list is what `tools/check-harness-conformance.mjs`
 * reads to decide whether a gate can report itself red: a report that only says "the gate passed" cannot say which rule.
 */
export function checksOf(reading) {
  const pairStatus =
    reading.pairs.examined === 0 || reading.unmeasured.length > 0
      ? "blocked"
      : reading.pairs.deadEnds.length > 0
        ? "failed"
        : "passed";
  const contradictionStatus =
    reading.population.modalTargeted.length === 0 ? "blocked" : reading.contradictions.length > 0 ? "failed" : "passed";
  const forgedStatus =
    reading.answers.examined === 0 ? "blocked" : reading.answers.forged.length > 0 ? "failed" : "passed";
  const accountStatus =
    reading.answers.measured === 0 ? "blocked" : reading.answers.faults.length > 0 ? "failed" : "passed";
  return Object.freeze([
    Object.freeze({ id: "pair_fixpoint", status: pairStatus, examined: reading.pairs.examined }),
    Object.freeze({
      id: "modal_target_declaration",
      status: contradictionStatus,
      examined: reading.population.modalTargeted.length,
    }),
    Object.freeze({ id: "no_forged_success", status: forgedStatus, examined: reading.answers.examined }),
    Object.freeze({ id: "call_accounting", status: accountStatus, examined: reading.answers.measured }),
  ]);
}

/** The report, as the JSON object every run ends with: the reading, the verdict, and each rule's own outcome. */
function reportOf(reading) {
  return { ...reading, status: statusOf(reading), checks: checksOf(reading) };
}

/** The population line, in the shape the report quotes: what was examined and what came of it. */
export function summaryOf(reading) {
  const yielding = reading.population.yielding.length;
  return (
    `plan_legal_fixpoint examined ${reading.pairs.examined} pairs (Y=${yielding} ${reading.population.yielding.join(",")}, ` +
    `X=${reading.population.published} published) · accepted ${reading.pairs.accepted} · repaired ${reading.pairs.repaired} · ` +
    `dead ends ${reading.pairs.deadEnds.length}`
  );
}

/**
 * The second population line: what every compiled answer claimed about the calls its own script made.
 *
 * `refused` is a count of answers, not of calls - a refusal is one answer that will run nothing - and `accounted` is
 * how many of them carried the four lists at all, so a reader can tell "nothing was wrong" from "nothing was read".
 */
export function answerSummaryOf(reading) {
  const answers = reading.answers;
  return (
    `plan_legal_fixpoint answers examined ${answers.examined} · ok ${answers.ok} · refused ${answers.refused} · ` +
    `forged ${answers.forged.length} · accounted ${answers.measured}`
  );
}

function report(reading, { json }) {
  const status = statusOf(reading);
  if (!json) {
    process.stdout.write(`${summaryOf(reading)}\n`);
    process.stdout.write(`${answerSummaryOf(reading)}\n`);
    process.stdout.write(
      `plan_legal_fixpoint_modal_targets examined ${reading.population.modalTargeted.length} published actions its own adapter ` +
        `names as acting on a modal (${reading.population.modalTargeted.join(",") || "none"}) · contradictions ${reading.contradictions.length}\n`,
    );
    for (const deadEnd of reading.pairs.deadEnds) {
      process.stdout.write(`plan_dead_end:${deadEnd.pair}:${deadEnd.code}\n`);
      process.stdout.write(`  what would have to change: ${deadEnd.change}\n`);
    }
    for (const forged of reading.answers.forged) process.stdout.write(`${forged}\n`);
    for (const fault of reading.answers.faults) process.stdout.write(`${fault}\n`);
    for (const contradiction of reading.contradictions) process.stdout.write(`${contradiction}\n`);
    for (const line of reading.unmeasured) process.stdout.write(`${line}\n`);
    if (reading.pairs.examined === 0)
      process.stdout.write(
        "plan_legal_fixpoint_blocked: the pair population is empty (a yielding declaration with no published action, or no " +
          "published action at all), so nothing was judged - a gate whose population is empty agrees with itself\n",
      );
    if (reading.answers.measured === 0)
      process.stdout.write(
        "plan_legal_fixpoint_blocked: no compiled answer carried the account of its own calls (the four lists), so the " +
          "forged-success and vanished-call assertions were not measured - a compiler from before the field existed is " +
          "not a compiler that passed this\n",
      );
    process.stdout.write(`plan_legal_fixpoint status ${status}\n`);
  }
  // The machine-readable line, printed on every run: it is the artifact `check-harness-conformance.mjs` reads to decide
  // whether this gate can report itself red, and a gate that only prints it under a flag is a gate with no report.
  process.stdout.write(`${JSON.stringify(reportOf(reading))}\n`);
  return status;
}

async function read({ revision, root }) {
  const compiler = await loadPlanCompiler({ revision, root });
  const { actions } = readPublishedActions({ compiler, root });
  const bodyYieldingActionIds = await compiler.bodyYieldingActionIds();
  const modalTargetedActionIds = await readModalTargetedActionIds({ root });
  // The clearing family is the compiler's own declaration of the step that gives the body back; it is what a dead end
  // probes by hand before it says the compiler is the one that must write it.
  const clearing = (await import(pathToFileURL(path.resolve(root, SOURCES.compiler)).href))
    .MODAL_CLEARING_PLAN_ACTION_IDS;
  return readPlanLegalFixpoint({
    compile: (script) =>
      compiler.compilePlanScript({ script }, { snapshot: pairSnapshot(actions.map((a) => a.actionId)), actions }),
    actions,
    bodyYieldingActionIds,
    modalClearingActionIds: Array.isArray(clearing) ? [...clearing] : [],
    modalTargetedActionIds,
  });
}

function main(argv) {
  const rootIndex = argv.indexOf("--root");
  const root =
    rootIndex >= 0 && typeof argv[rootIndex + 1] === "string" ? path.resolve(argv[rootIndex + 1]) : REPOSITORY_ROOT;
  const revisionIndex = argv.indexOf("--revision");
  const revision = revisionIndex >= 0 && typeof argv[revisionIndex + 1] === "string" ? argv[revisionIndex + 1] : null;
  const json = argv.includes("--json");
  read({ revision, root })
    .then((reading) => {
      process.exitCode = report(reading, { json }) === "passed" ? 0 : 1;
    })
    .catch((error) => {
      process.stderr.write(`${error?.message ?? error}\n`);
      process.exitCode = 1;
    });
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
