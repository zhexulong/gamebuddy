/**
 * Is every family the multi-day task rotation names actually there in the multi-day world?
 *
 * <p>
 * THE DEFECT THIS EXISTS FOR. `tend_the_animals` is one of the rotation's days and names four actions that all belong to
 * `animals_pets`; the family's only targets are barn/coop stock. Measured 2026-11-09: the play-session world's coop Given
 * was switched off because its footprint severed the door->field route, and NOTHING failed - a day went on being rotated
 * into a world with no coop and no animal in it, while the single-action gate stayed green because its own fixture builds
 * a coop. Green by deleting the subject.
 * </p>
 *
 * <h2>Two readings, deliberately different in kind</h2>
 * <ul>
 *   <li>WHAT THE TASKS NEED comes from `tools/lib/multiday-daily-tasks.mjs` by import (never parsed out of its text), with
 *       each action's family from the Mod's own registration catalog (`FarmhandActionDefinitions.cs`). Sweep tasks also
 *       declare families directly, and those are unioned in.</li>
 *   <li>WHAT THE WORLD ADVERTISES comes from the fixture that provisions it: a Given states the family it makes
 *       publishable next to the method that installs it, and that statement is TRUE only while the method is actually
 *       invoked by the composed play-session world. A declaration whose Given is not called is an ABSENT family, which is
 *       exactly the shipped defect - the difference between "the world has animals" and "the world says it does".</li>
 * </ul>
 *
 * <p>
 * A family NOTHING declares is not checked: a farm save's crops, backpack, tools and trees are not this fixture's doing,
 * and inventing a list of them would be a second authority that goes stale. What is checked is the class that shipped: a
 * family the fixture itself provides, turned off, while the rotation still names it.
 * </p>
 */

/** A C# declaration of the method that installs a Given's targets: `const string XProvider = nameof(Y);`. */
const PROVIDER_DECLARATION = /\bconst\s+string\s+([A-Za-z_]\w*?)Provider\s*=\s*nameof\(\s*([A-Za-z_]\w*)\s*\)\s*;/gu;

/** The family the same Given makes publishable: `const string XFamily = "family_id";`. */
const FAMILY_DECLARATION = /\bconst\s+string\s+([A-Za-z_]\w*?)Family\s*=\s*"([a-z][a-z0-9_]{1,127})"\s*;/gu;

/** A line that DECLARES a method, i.e. one where a `name(` occurrence is not a call. */
const METHOD_DECLARATION_LINE = /^\s*(?:private|internal|public|protected)\b[^;=]*\w+\s*\(/u;

/**
 * Every `<stem>Provider = nameof(<method>)` / `<stem>Family = "<family>"` pair in these sources.
 *
 * <p>
 * The pair is joined on the STEM, so two Givens declaring their own advertisements is already supported and no list of
 * stems is kept here. A provider with no family, or a family with no provider, is a declaration half-written - reported
 * rather than ignored, because it would otherwise leave a family the world never claims to have and no gate able to say
 * so.
 * </p>
 */
export function parseWorldTargetFamilies(sources) {
  const providers = new Map();
  const families = new Map();
  for (const source of Array.isArray(sources) ? sources : [sources]) {
    for (const match of String(source).matchAll(PROVIDER_DECLARATION)) providers.set(match[1], match[2]);
    for (const match of String(source).matchAll(FAMILY_DECLARATION)) families.set(match[1], match[2]);
  }
  const declarations = [];
  const unpaired = [];
  for (const [stem, provider] of providers) {
    const family = families.get(stem);
    if (family === undefined) unpaired.push(`provider_without_family:${stem}:${provider}`);
    else declarations.push(Object.freeze({ stem, provider, family }));
  }
  for (const stem of families.keys()) {
    if (!providers.has(stem)) unpaired.push(`family_without_provider:${stem}:${families.get(stem)}`);
  }
  return Object.freeze({ declarations: Object.freeze(declarations), unpaired: Object.freeze(unpaired) });
}

/**
 * Is `provider` actually CALLED anywhere in these sources?
 *
 * <p>
 * `nameof(...)` is neutralised first, and declaration lines are dropped: the declaration that states the family names the
 * method too, and counting that as an invocation would make every advertisement true by construction - the one thing this
 * reading exists to avoid.
 * </p>
 */
export function isProviderInvoked(provider, sources) {
  const pattern = new RegExp(`\\b${provider}\\s*\\(`, "u");
  for (const source of Array.isArray(sources) ? sources : [sources]) {
    const callable = String(source)
      // Comments go first: the shipped defect was a call replaced by a paragraph, and a call commented out is not a
      // call - reading it as one is exactly the "green by deleting the subject" this gate exists against.
      .replace(/\/\/[^\n]*/gu, "")
      .replace(/\bnameof\s*\(/gu, "nameof_")
      .split("\n")
      .filter((line) => !METHOD_DECLARATION_LINE.test(line))
      .join("\n");
    if (pattern.test(callable)) return true;
  }
  return false;
}

/**
 * What each rotation task needs, as families: its actions' families from the catalog, plus any family a sweep task
 * declares for itself.
 *
 * <p>
 * FAILS CLOSED on the two silences: an action the catalog does not carry a family for, and a rotation entry that names
 * nothing at all. Either would silently widen the gate's pass set.
 * </p>
 */
export function rotationRequirement({ rotation, taskActions, actionFamilies, sweepFamilies = new Map() }) {
  const tasks = [];
  const violations = [];
  const actionsOf = (taskId) => (taskActions instanceof Map ? taskActions.get(taskId) : taskActions?.[taskId]) ?? [];
  const familyOf = (action) => (actionFamilies instanceof Map ? actionFamilies.get(action) : actionFamilies?.[action]);
  const sweep = sweepFamilies instanceof Map ? sweepFamilies : new Map(Object.entries(sweepFamilies));
  for (const taskId of rotation ?? []) {
    const families = new Set();
    for (const action of actionsOf(taskId)) {
      const family = familyOf(action);
      if (family === undefined) violations.push({ code: `task_action_has_no_family:${taskId}:${action}` });
      else families.add(family);
    }
    for (const family of sweep.get(taskId) ?? []) families.add(family);
    if (families.size === 0) violations.push({ code: `task_names_no_family:${taskId}` });
    tasks.push(Object.freeze({ id: taskId, families: Object.freeze([...families].sort()) }));
  }
  return Object.freeze({ tasks: Object.freeze(tasks), violations: Object.freeze(violations) });
}

/**
 * The gate's verdict, as data.
 *
 * <p>
 * `absent` is the world's own advertisement read against the world's own provisioning: a family a Given declares while
 * that Given is not invoked. Everything else passes, because a family this fixture does not provision is not a family
 * this fixture can withdraw.
 * </p>
 */
export function multidayTaskFamilyVerdict({
  tasks,
  violations = [],
  declarations = [],
  producedFamilies,
  knownFamilies,
}) {
  const findings = [...violations];
  const known = knownFamilies instanceof Set ? knownFamilies : new Set(knownFamilies ?? []);
  const produced = producedFamilies instanceof Set ? producedFamilies : new Set(producedFamilies ?? []);
  const absent = new Set();
  for (const declaration of declarations) {
    if (!known.has(declaration.family)) {
      findings.push({ code: `unknown_declared_family:${declaration.family}:${declaration.provider}` });
      continue;
    }
    if (!produced.has(declaration.family)) absent.add(declaration.family);
  }
  let examined = 0;
  for (const task of tasks) {
    for (const family of task.families) {
      examined += 1;
      if (absent.has(family)) findings.push({ code: `task_requires_absent_family:${task.id}:${family}` });
    }
  }
  // The three zeroes, told apart. A gate whose population is empty agrees with itself, and a gate that cannot see the
  // fixture's advertisement has nothing to compare the tasks against - both are blocked, never green.
  const blocked =
    tasks.length === 0
      ? "no_rotation_tasks"
      : declarations.length === 0
        ? "world_advertises_no_target_family"
        : examined === 0
          ? "no_task_family_pair_examined"
          : null;
  return Object.freeze({
    status: blocked !== null ? "blocked" : findings.length === 0 ? "passed" : "failed",
    blocked: blocked,
    tasks: tasks.length,
    examined,
    declaredFamilies: declarations.length,
    advertised: Object.freeze([...produced].sort()),
    absent: Object.freeze([...absent].sort()),
    findings: Object.freeze(findings),
  });
}
