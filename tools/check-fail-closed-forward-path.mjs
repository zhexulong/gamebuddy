#!/usr/bin/env node
/**
 * A fail-closed state must tell the player what to do next - and the answer must be the product's.
 *
 * WHY. `dialogue-web/src/composed-problem-view.ts` words every refusal the two browser contracts can
 * produce: fifty-five sentence families over sixty-one tavern codes and twenty-three game ones. The
 * sentence pair was the whole answer until now, and the card that shows it (`ProblemView`) carried one
 * control for all of them: the read taken again. So `turn_busy` (the Host is working), `session_expired`
 * (nothing can be read until GameBuddy starts again) and `payload_too_large` (send a smaller message)
 * each offered the same press, and for every one of them it was a step that cannot help. The opposite
 * defect is the same defect: a card that says "nothing can be done" where the product does have a
 * control one surface away is a promise withdrawn.
 *
 * THE ANSWER IS NOW A TYPE (`ProblemStep`, four kinds - `control`, `outside_surface`, `self_heals`,
 * `no_step`), required by `sentence(title, detail, step)`, so a family without one does not compile.
 * This gate is the other half: a type can be satisfied with a control id that names nothing, a
 * "clears by itself" that does not clear, or a "nothing to do" where a control exists.
 *
 * WHAT IT ASSERTS, per population member:
 *
 *   1. it HAS a step (a member with no answer is the finding, and the symmetric difference against the
 *      declarations is printed both ways, so a step declared for a member nobody enumerates shows up
 *      too);
 *   2. the step's own fields are inside the closed vocabulary (`outside_surface.step`,
 *      `self_heals.because`, `no_step.because` are unions in the product; a free-text answer would
 *      make every later reading of this gate a matter of opinion);
 *   3. every `control.id` names a marker the product really puts on an element - `data-testid="x"`,
 *      `data-testid={CONST}` with `CONST` a literal declared in the web sources, or the bare
 *      `data-x` markers the panels use. A control id is a claim that the player can press something,
 *      so it is checked against the markup rather than trusted;
 *   4. every `control` whose control is NOT the card's own (`elsewhere`) has `said_as` as a literal
 *      substring of that family's own `detail` in the default catalogue. This is the one place the
 *      claim "the sentence already tells you which control" can be held to account, and a family
 *      whose sentence does not say it is named;
 *   5. every phase of `GAME_SESSION_PHASES` (sixteen of them) still offers at least one forward
 *      action, and every action it offers is a member of the declared `GameSessionForwardAction`
 *      union - the same zero-forward-path rule, read off the derivation's own `build(...)` calls.
 *
 * THE POPULATION IS DERIVED, all five parts, from declarations the product already owns:
 * `PROBLEM_CODES` (the browser mirror of the tavern contract's closed union), `GAME_PROBLEM_CODES`,
 * the turn's `TURN_PROBLEM_CODES`, the classifier's `PROVIDER_FAILURES`, and `GAME_SESSION_PHASES`.
 * A code added anywhere joins this gate without an edit here; `examined 109` is printed with the
 * per-axis counts, and an empty population is `blocked` with exit 1 - a gate that examined nothing
 * has not passed.
 *
 * WHAT IT DOES NOT ASSERT, stated so a green run is not read as more than it is: that a named control
 * is *enabled* in the state the sentence describes, and that pressing it reaches the Host. Both need a
 * browser and a fixture per state; the first is asserted for the whole-window card by
 * `dialogue-web/tests/first-viewport-forward-path.spec.ts`, which mounts every tavern code at 400x800
 * and requires either an enabled control or a step sentence inside the first viewport. The Game
 * surface's controls are measured there too.
 *
 * red-proof: inject  a family loses its step argument (`sentence(title, detail)`) -> the typecheck
 *                    reports `TS2554: Expected 3 arguments, but got 2` in
 *                    dialogue-web/src/composed-problem-view.ts, and a control id that names no marker
 *                    (`message-delete` -> `message-del` ) is `control_id_not_a_control` naming that
 *                    family (tools/check-fail-closed-forward-path.test.mjs)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_ROOT = join(ROOT, "dialogue-web");
const SRC_ROOT = join(WEB_ROOT, "src");
/** The TypeScript compiler the web workspace builds with: the same parser, not a second spelling of it. */
const typescript = createRequire(join(WEB_ROOT, "package.json"))("typescript");

export const SOURCES = {
  tavernApi: join(SRC_ROOT, "reference-pipeline-api.ts"),
  gameApi: join(SRC_ROOT, "composed-reference-game-browser-api.ts"),
  problemView: join(SRC_ROOT, "composed-problem-view.ts"),
  turnFailure: join(SRC_ROOT, "components", "turn-failure-text.ts"),
  lifecycle: join(SRC_ROOT, "game-lifecycle-controls.ts"),
  catalogue: join(SRC_ROOT, "i18n.ts"),
  srcRoot: SRC_ROOT,
};

/**
 * The falsifier seam: run the same checks over another tree.
 *
 * `tools/check-fail-closed-forward-path.test.mjs` turns each finding red by pointing one source at a
 * throwaway copy - so the proof drives the gate's own readers rather than a second implementation of
 * them. Nothing else swaps a source; the default run reads the real tree above.
 */
export function checkForwardPathOf(overrides) {
  const saved = { ...SOURCES };
  Object.assign(SOURCES, overrides);
  try {
    return checkForwardPath();
  } finally {
    Object.assign(SOURCES, saved);
  }
}

const STEP_KINDS = Object.freeze(["control", "outside_surface", "self_heals", "no_step"]);
const OUTSIDE_SURFACE_STEPS = Object.freeze(["open_settings", "retry_bootstrap", "restart_gamebuddy"]);
const SELF_HEALS_REASONS = Object.freeze(["host_retries", "next_read", "stream_resumes"]);
const NO_STEP_REASONS = Object.freeze(["over_a_ceiling", "already_true", "not_this_artifact"]);

// ---------------------------------------------------------------------------------------------------
// TypeScript reading: declarations, not text
// ---------------------------------------------------------------------------------------------------

function parseFile(path) {
  const kind = path.endsWith(".tsx") ? typescript.ScriptKind.TSX : typescript.ScriptKind.TS;
  return typescript.createSourceFile(path, readFileSync(path, "utf8"), typescript.ScriptTarget.Latest, true, kind);
}

/** Every `const <name> = <initializer>` the file declares, nested scope included. */
function constantsOf(sourceFile) {
  const constants = new Map();
  const visit = (node) => {
    if (typescript.isVariableDeclaration(node) && typescript.isIdentifier(node.name) && node.initializer !== undefined)
      constants.set(node.name.text, node.initializer);
    typescript.forEachChild(node, visit);
  };
  visit(sourceFile);
  return constants;
}

/** `x as const`, `(x)`, `x satisfies T` and `Object.freeze(x)` all still name `x`. */
function unwrap(node) {
  let current = node;
  while (
    typescript.isAsExpression(current) ||
    typescript.isParenthesizedExpression(current) ||
    typescript.isSatisfiesExpression(current) ||
    typescript.isNonNullExpression(current)
  )
    current = current.expression;
  if (
    typescript.isCallExpression(current) &&
    typescript.isPropertyAccessExpression(current.expression) &&
    current.expression.name.text === "freeze" &&
    current.arguments.length === 1
  )
    return unwrap(current.arguments[0]);
  return current;
}

/** Every string literal inside a node, in source order: a union's members, an array's items. */
function stringLiterals(node) {
  const values = [];
  const visit = (current) => {
    if (typescript.isStringLiteral(current)) values.push(current.text);
    typescript.forEachChild(current, visit);
  };
  visit(node);
  return values;
}

/** The string members of a string-literal array constant, by name. */
function stringArray(sourceFile, name) {
  const initializer = constantsOf(sourceFile).get(name);
  return initializer === undefined ? null : stringLiterals(unwrap(initializer));
}

/** The properties of an object literal (symbol-named, string-literal-named and identifier-named). */
function objectProperties(node) {
  const literal = unwrap(node);
  if (!typescript.isObjectLiteralExpression(literal)) return null;
  const properties = new Map();
  for (const property of literal.properties) {
    if (!typescript.isPropertyAssignment(property)) continue;
    const name = property.name;
    const key = typescript.isIdentifier(name) || typescript.isStringLiteral(name) ? name.text : null;
    if (key !== null) properties.set(key, property.initializer);
  }
  return properties;
}

/** `labels.problemFooDetail` -> `problemFooDetail`; anything else -> null. */
function catalogueKey(node) {
  const unwrapped = unwrap(node);
  if (
    typescript.isPropertyAccessExpression(unwrapped) &&
    typescript.isIdentifier(unwrapped.expression) &&
    unwrapped.expression.text === "labels"
  )
    return unwrapped.name.text;
  return null;
}

/**
 * One `ProblemStep` literal, resolved.
 *
 * A step is either written where it is used or named by a constant beside the families that share it
 * (`RETRY_READ`, `HOST_RETRIES`, ...), so an identifier is followed to its declaration in the same
 * file. A node this reader cannot resolve is `null`, and the caller reports it: an answer nobody can
 * read is not an answer.
 */
function readStep(node, constants) {
  const value = unwrap(node);
  if (typescript.isIdentifier(value)) {
    const declaration = constants.get(value.text);
    return declaration === undefined ? null : readStep(declaration, constants);
  }
  const properties = objectProperties(value);
  if (properties === null) return null;
  const literal = (key) => {
    const property = properties.get(key);
    if (property === undefined) return null;
    let node = unwrap(property);
    // A field may name a constant (`id: PROBLEM_RETRY_READ`), so an identifier is followed to its
    // declaration for the same reason a whole step is: the value is what the product declared.
    for (let hops = 0; hops < 8 && typescript.isIdentifier(node); hops += 1) {
      const declaration = constants.get(node.text);
      if (declaration === undefined) return null;
      node = unwrap(declaration);
    }
    return typescript.isStringLiteral(node) ? node.text : null;
  };
  const step = { kind: literal("kind"), id: literal("id"), step: literal("step"), because: literal("because") };
  const elsewhere = properties.get("elsewhere");
  if (elsewhere !== undefined) {
    const saidAs = objectProperties(elsewhere);
    const phrase = saidAs === null ? undefined : saidAs.get("said_as");
    step.said_as =
      phrase === undefined ? null : typescript.isStringLiteral(unwrap(phrase)) ? unwrap(phrase).text : null;
  }
  return step;
}

/**
 * The `sentence(title, detail, step)` call a family returns, as its three arguments.
 *
 * A family is `const name: ProblemSentence = (labels) => sentence(...)`, occasionally wrapped in
 * parentheses; the game map's one templated entry is the same call inside an object literal. Anything
 * that is not that shape is reported rather than guessed at.
 */
function sentenceCall(node) {
  const visit = (current) => {
    if (
      typescript.isCallExpression(current) &&
      typescript.isIdentifier(current.expression) &&
      current.expression.text === "sentence"
    )
      return current;
    let found = null;
    typescript.forEachChild(current, (child) => {
      if (found === null) found = visit(child);
    });
    return found;
  };
  return visit(unwrap(node));
}

// ---------------------------------------------------------------------------------------------------
// The declarations this gate derives its population and its answers from
// ---------------------------------------------------------------------------------------------------

function readViews() {
  const problemFile = parseFile(SOURCES.problemView);
  const problemConstants = constantsOf(problemFile);
  const families = new Map();
  for (const [name, initializer] of problemConstants) {
    const call = sentenceCall(initializer);
    if (call === null) continue;
    families.set(name, {
      detailKey: call.arguments.length > 1 ? catalogueKey(call.arguments[1]) : null,
      step: call.arguments.length > 2 ? readStep(call.arguments[2], problemConstants) : null,
    });
  }
  return { families, problemConstants };
}

/** One member's answer: the step, and the catalogue key its own sentence is. */
function tavernMembers() {
  const problemFile = parseFile(SOURCES.problemView);
  const { families } = readViews();
  const codes = stringArray(parseFile(SOURCES.tavernApi), "PROBLEM_CODES");
  const sentences = objectProperties(constantsOf(problemFile).get("PROBLEM_SENTENCES") ?? problemFile);
  return (codes ?? []).map((code) => {
    const family = sentences === null ? undefined : sentences.get(code);
    const familyName = family !== undefined && typescript.isIdentifier(unwrap(family)) ? unwrap(family).text : null;
    const resolved = familyName === null ? null : (families.get(familyName) ?? null);
    return {
      axis: "tavern",
      member: code,
      family: familyName,
      detailKey: resolved?.detailKey ?? null,
      step: resolved?.step ?? null,
    };
  });
}

function gameMembers() {
  const problemFile = parseFile(SOURCES.problemView);
  const problemConstants = constantsOf(problemFile);
  const { families } = readViews();
  const codes = stringArray(parseFile(SOURCES.gameApi), "GAME_PROBLEM_CODES");
  const views = objectProperties(problemConstants.get("GAME_PROBLEM_VIEWS"));
  return (codes ?? []).map((code) => {
    const entry = views === null ? undefined : views.get(code);
    if (entry === undefined) return { axis: "game", member: code, family: null, detailKey: null, step: null };
    const value = unwrap(entry);
    // `refused(family)` / `unsettled(family)` name a family; `game_unavailable` writes its templated
    // sentence in place, so its own `sentence(...)` call is read instead.
    if (
      typescript.isCallExpression(value) &&
      value.arguments.length === 1 &&
      typescript.isIdentifier(unwrap(value.arguments[0]))
    ) {
      const familyName = unwrap(value.arguments[0]).text;
      const resolved = families.get(familyName) ?? null;
      return {
        axis: "game",
        member: code,
        family: familyName,
        detailKey: resolved?.detailKey ?? null,
        step: resolved?.step ?? null,
      };
    }
    const call = sentenceCall(value);
    const step = call === null ? null : readStep(call.arguments[2], problemConstants);
    return { axis: "game", member: code, family: `${code} (inline)`, detailKey: null, step: step ?? null };
  });
}

function turnMembers() {
  const apiFile = parseFile(SOURCES.tavernApi);
  const turnFile = parseFile(SOURCES.turnFailure);
  const turnConstants = constantsOf(turnFile);
  const steps = objectProperties(turnConstants.get("TURN_FAILURE_STEPS"));
  const byCode = objectProperties(turnConstants.get("byCode"));
  const byProvider = objectProperties(turnConstants.get("byProviderFailure"));
  const members = [];
  for (const [axis, codes] of [
    ["turn", stringArray(apiFile, "TURN_PROBLEM_CODES") ?? []],
    ["provider", stringArray(apiFile, "PROVIDER_FAILURES") ?? []],
  ]) {
    for (const code of codes) {
      const declared = steps === null ? undefined : steps.get(code);
      const detail = (axis === "turn" ? byCode : byProvider)?.get(code);
      members.push({
        axis,
        member: code,
        family: `turn-failure-text.ts ${code}`,
        detailKey: detail === undefined ? null : catalogueKey(detail),
        step: declared === undefined ? null : readStep(declared, turnConstants),
      });
    }
  }
  return members;
}

/**
 * The Game phases and the forward actions their own derivation offers.
 *
 * Every phase is produced by one `build(phase, flags, actions)` call; two of those pass a variable
 * (`phase`) or a ternary instead of a literal, so the phase names are read from the argument's own
 * initializer rather than from a list retyped here.
 */
function phaseMembers() {
  const file = parseFile(SOURCES.lifecycle);
  const constants = constantsOf(file);
  const phases = stringArray(file, "GAME_SESSION_PHASES") ?? [];
  const union = new Set(stringLiterals(unionTypeMembers(file, "GameSessionForwardAction")));
  const offered = new Map();
  const visit = (node) => {
    if (
      typescript.isCallExpression(node) &&
      typescript.isIdentifier(node.expression) &&
      node.expression.text === "build"
    ) {
      const phaseArgument = unwrap(node.arguments[0]);
      const phaseNames = stringLiterals(
        typescript.isIdentifier(phaseArgument)
          ? unwrap(constants.get(phaseArgument.text) ?? phaseArgument)
          : phaseArgument,
      );
      const actions = node.arguments.length > 2 ? stringLiterals(unwrap(node.arguments[2])) : [];
      for (const phase of phaseNames) offered.set(phase, [...(offered.get(phase) ?? []), ...actions]);
    }
    typescript.forEachChild(node, visit);
  };
  visit(file);
  return {
    union,
    members: phases.map((phase) => ({
      axis: "phase",
      member: phase,
      family: `GAME_SESSION_PHASES ${phase}`,
      detailKey: null,
      step: null,
      actions: offered.get(phase) ?? [],
    })),
  };
}

/** The members of a `type Name = "a" | "b";` union alias, as declaration nodes. */
function unionTypeMembers(sourceFile, name) {
  let found = typescript.factory.createUnionTypeNode([]);
  const visit = (node) => {
    if (typescript.isTypeAliasDeclaration(node) && node.name.text === name) found = node.type;
    typescript.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * Every marker the web sources put on an element: `data-testid="x"`, `data-x`, and
 * `data-testid={CONST}` where `CONST` is a string literal declared anywhere in the sources.
 *
 * The panels name their controls with bare `data-*` attributes (`data-world-book-submit`), the
 * message and game surfaces with `data-testid`; both are the product's own vocabulary and a control
 * id has to be one of them.
 */
function controlMarkers() {
  const files = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".tsx") || name.endsWith(".ts")) files.push(path);
    }
  };
  walk(SRC_ROOT);
  const literals = new Map();
  const pending = [];
  const markers = new Set();
  for (const path of files) {
    const sourceFile = parseFile(path);
    for (const [name, initializer] of constantsOf(sourceFile)) {
      const value = unwrap(initializer);
      if (typescript.isStringLiteral(value)) literals.set(name, value.text);
    }
    const visit = (node) => {
      if (typescript.isJsxAttribute(node) && typescript.isIdentifier(node.name)) {
        const attribute = node.name.text;
        const initializer = node.initializer;
        if (attribute === "data-testid") {
          if (initializer !== undefined && typescript.isStringLiteral(initializer)) markers.add(initializer.text);
          else if (initializer !== undefined && typescript.isJsxExpression(initializer)) {
            const expression = initializer.expression === undefined ? null : unwrap(initializer.expression);
            if (expression !== null && typescript.isIdentifier(expression)) pending.push(expression.text);
          }
        } else if (attribute.startsWith("data-") && attribute.length > 5) markers.add(attribute.slice(5));
      }
      typescript.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  for (const name of pending) if (literals.has(name)) markers.add(literals.get(name));
  // A computed testid whose name is not a string constant is a prop (`SurfaceView` renders
  // `data-testid={testId}` from its caller): it is reported as unread, never assumed to be a marker.
  return { markers, unread: pending.filter((name) => !literals.has(name)) };
}

/** The catalogue's own message sets, key by key: the default one first, every one for existence. */
function catalogues() {
  const file = parseFile(SOURCES.catalogue);
  const sets = new Map();
  for (const [name, initializer] of constantsOf(file)) {
    const properties = objectProperties(initializer);
    if (properties === null) continue;
    const values = new Map();
    for (const [key, value] of properties) {
      const unwrapped = unwrap(value);
      if (typescript.isStringLiteral(unwrapped)) values.set(key, unwrapped.text);
    }
    if (values.size > 0) sets.set(name, values);
  }
  return sets;
}

// ---------------------------------------------------------------------------------------------------
// The assertions
// ---------------------------------------------------------------------------------------------------

const finding = (code, detail) => ({ code, detail });

/** `+ newly added: [x]` / `- missing: [y]`: a difference, printed in both directions. */
function difference(declared, members) {
  const declaredSet = new Set(declared);
  const memberSet = new Set(members);
  const added = declared.filter((name) => !memberSet.has(name));
  const missing = members.filter((name) => !declaredSet.has(name));
  if (added.length === 0 && missing.length === 0) return "";
  return (
    `${added.length === 0 ? "" : ` + newly added: [${added.join(", ")}]`}` +
    `${missing.length === 0 ? "" : ` - missing: [${missing.join(", ")}]`}`
  );
}

export function checkForwardPath() {
  const findings = [];
  const { markers, unread } = controlMarkers();
  const catalogues = readCatalogues();
  const defaultCatalogue = catalogues.values().next().value ?? new Map();
  const phases = phaseMembers();
  const members = [...tavernMembers(), ...gameMembers(), ...turnMembers(), ...phases.members];

  if (markers.size === 0)
    findings.push(finding("no_control_markers", "no data-testid or data-* marker was read from dialogue-web/src"));
  for (const name of unread)
    console.log(`[forward-path] unread marker: data-testid={${name}} is not a string constant`);

  const answerable = [];
  const answered = [];
  for (const member of members) {
    const label = `${member.axis}/${member.member}`;
    if (member.axis === "phase") {
      if (member.actions.length === 0) findings.push(finding("phase_without_forward_action", label));
      for (const action of member.actions)
        if (!phases.union.has(action))
          findings.push(finding("phase_action_not_declared", `${label} offers "${action}"`));
      continue;
    }
    answerable.push(label);
    if (member.step === null) {
      findings.push(finding("step_missing", `${label} (${member.family ?? "no family"}) has no step`));
      continue;
    }
    answered.push(label);
    checkStep(member, label, { findings, markers, defaultCatalogue, catalogues });
  }

  if (members.length === 0 || answerable.length === 0)
    return {
      status: "blocked",
      findings: [
        finding(
          "population_empty",
          `examined ${members.length} members and found ${answerable.length} that owe a step, so this gate agreed with itself`,
        ),
      ],
      examined: members.length,
      difference: "",
    };

  return {
    status: findings.length === 0 ? "passed" : "failed",
    findings,
    examined: members.length,
    difference: difference(answered, answerable),
  };
}

/** Every per-member question, in one place, so the loop above reads as the list of them. */
function checkStep(member, label, { findings, markers, defaultCatalogue, catalogues }) {
  const step = member.step;
  if (!STEP_KINDS.includes(step.kind)) {
    findings.push(finding("step_kind_unknown", `${label} has step kind "${String(step.kind)}"`));
    return;
  }
  if (step.kind === "outside_surface" && !OUTSIDE_SURFACE_STEPS.includes(step.step))
    findings.push(
      finding("step_vocabulary", `${label} outside_surface.step "${String(step.step)}" is not a declared member`),
    );
  if (step.kind === "self_heals" && !SELF_HEALS_REASONS.includes(step.because))
    findings.push(
      finding("step_vocabulary", `${label} self_heals.because "${String(step.because)}" is not a declared member`),
    );
  if (step.kind === "no_step" && !NO_STEP_REASONS.includes(step.because))
    findings.push(
      finding("step_vocabulary", `${label} no_step.because "${String(step.because)}" is not a declared member`),
    );
  if (step.kind !== "control") return;

  if (step.id === null || !markers.has(step.id))
    findings.push(
      finding(
        "control_id_not_a_control",
        `${label} names control "${String(step.id)}", which no element in dialogue-web/src carries`,
      ),
    );
  if (step.said_as === undefined) return;
  if (step.said_as === null || member.detailKey === null) {
    findings.push(
      finding(
        "said_as_unverifiable",
        `${label} says its step is elsewhere, but ${member.detailKey === null ? "its sentence is templated" : "its said_as is not a literal"}`,
      ),
    );
    return;
  }
  const detail = defaultCatalogue.get(member.detailKey) ?? "";
  if (!detail.includes(step.said_as))
    findings.push(
      finding(
        "said_as_not_in_sentence",
        `${label} says the step is elsewhere "${step.said_as}", and ${member.detailKey} reads: ${detail || "(absent)"}`,
      ),
    );
  for (const [name, values] of catalogues) {
    const text = values.get(member.detailKey);
    if (text === undefined || text.length === 0)
      findings.push(finding("said_as_catalogue_gap", `${label}: catalogue ${name} declares no ${member.detailKey}`));
  }
}

/** The catalogue's message sets, keyed by the constant's name (the default set first). */
function readCatalogues() {
  return catalogues();
}

export { controlMarkers, phaseMembers, tavernMembers, gameMembers, turnMembers };

// ---------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------

function main() {
  const verdict = checkForwardPath();
  const members = [...tavernMembers(), ...gameMembers(), ...turnMembers(), ...phaseMembers().members];
  const count = (axis) => members.filter((member) => member.axis === axis).length;
  const families = new Map();
  const kinds = { control: 0, elsewhere: 0, outside_surface: 0, self_heals: 0, no_step: 0 };
  for (const member of members) {
    if (member.step === null) continue;
    const kind =
      member.step.kind === "control" ? (member.step.said_as === undefined ? "control" : "elsewhere") : member.step.kind;
    kinds[kind] += 1;
    if (member.family !== null) families.set(member.family, kind);
  }
  const familyKinds = { control: 0, elsewhere: 0, outside_surface: 0, self_heals: 0, no_step: 0 };
  for (const kind of families.values()) familyKinds[kind] += 1;
  const elsewhereChecked = members.filter(
    (member) => member.step?.said_as !== undefined && member.step?.said_as !== null,
  ).length;
  console.log(
    `[forward-path] examined ${verdict.examined} (tavern ${count("tavern")}, game ${count("game")}, ` +
      `turn ${count("turn")}, provider ${count("provider")}, game phases ${count("phase")})`,
  );
  console.log(
    `[forward-path] codes: control ${kinds.control}, control+elsewhere ${kinds.elsewhere}, ` +
      `outside_surface ${kinds.outside_surface}, self_heals ${kinds.self_heals}, no_step ${kinds.no_step}`,
  );
  console.log(
    `[forward-path] families ${families.size}: control ${familyKinds.control}, control+elsewhere ${familyKinds.elsewhere}, ` +
      `outside_surface ${familyKinds.outside_surface}, self_heals ${familyKinds.self_heals}, no_step ${familyKinds.no_step}; ` +
      `elsewhere claims verified against their sentence: ${elsewhereChecked}`,
  );
  if (verdict.difference.length > 0) console.log(`[forward-path] population vs steps:${verdict.difference}`);
  for (const entry of verdict.findings) console.log(`[forward-path] ${entry.code}: ${entry.detail}`);
  const failed = (code) => verdict.findings.some((entry) => entry.code === code);
  const failedWithPrefix = (prefix) => verdict.findings.some((entry) => entry.code.startsWith(prefix));
  console.log(
    JSON.stringify({
      gate: "fail-closed-forward-path",
      status: verdict.status,
      examined: verdict.examined,
      checks: [
        {
          id: "step_declared",
          status: failed("step_missing") ? "failed" : verdict.status === "blocked" ? "blocked" : "passed",
        },
        {
          id: "step_vocabulary",
          status: failed("step_vocabulary") || failed("step_kind_unknown") ? "failed" : "passed",
        },
        { id: "control_id_names_a_control", status: failed("control_id_not_a_control") ? "failed" : "passed" },
        { id: "said_as_is_in_the_sentence", status: failedWithPrefix("said_as") ? "failed" : "passed" },
        { id: "phase_forward_action", status: failedWithPrefix("phase_") ? "failed" : "passed" },
      ],
      findings: verdict.findings,
    }),
  );
  if (verdict.status === "blocked") {
    console.error("[forward-path] blocked: this gate examined nothing");
    process.exit(1);
  }
  process.exit(verdict.findings.length === 0 ? 0 : 1);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();
