import { types } from "node:util";

export const WORK_BRIEF_SCHEMA = "gamebuddy-action-work-brief/v1";
export const WORK_BRIEF_HANDOFF_SCHEMA = "gamebuddy-action-work-brief-handoff/v1";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BASE_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const EFFECTS = new Set(["read_only", "mutation"]);
const STATUSES = new Set(["draft", "frozen", "blocked", "withdrawn"]);
const STAGES = new Set(["check", "preflight", "live", "status", "publication-check"]);
const HANDOFF_REASONS = new Set(["timeout", "observer_failure", "observer_invalid", "git_diff_invalid", "check_failure"]);
const GIT_NAME_STATUS_PATTERN = /^[ACDMRTUXB?!]+(?:\d+)?$/u;
const BRIEF_KEYS = new Set([
  "schema",
  "gameId",
  "actionId",
  "baseCommit",
  "contractVersion",
  "status",
  "effect",
  "claimScope",
  "ownedPaths",
  "sharedHubs",
  "requiredPortfolioEntries",
  "checks",
  "liveAuthorized",
]);
const MAX_ARRAY_ITEMS = 64;
const MAX_PATH_LENGTH = 512;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_OBSERVER_TIMEOUT_MS = 15 * 60 * 1000;

function fail(code) {
  throw new Error(`game_action_brief_${code}`);
}

function isPlainDataObject(value) {
  try {
    return value !== null
      && typeof value === "object"
      && !types.isProxy(value)
      && !Array.isArray(value)
      && Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function exactDataRecord(value, keys, code) {
  if (!isPlainDataObject(value)) fail(code);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.size || ownKeys.some((key) => typeof key !== "string" || !keys.has(key))) fail(code);
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.get || descriptor?.set) fail(code);
  }
}

function id(value, code) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) fail(code);
  return value;
}

function baseCommit(value, code = "invalid_base_commit") {
  if (typeof value !== "string" || !BASE_COMMIT_PATTERN.test(value)) fail(code);
  return value;
}

function caseFold(value) {
  return value.normalize("NFC").toLocaleLowerCase("en-US");
}

function arrayOfUniqueStrings(value, code, { allowEmpty = true, ids = false } = {}) {
  if (
    types.isProxy(value)
    || !Array.isArray(value)
    || value.length > MAX_ARRAY_ITEMS
    || (!allowEmpty && value.length === 0)
  ) fail(code);
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor?.get || descriptor?.set) fail(code);
    const item = value[index];
    if (typeof item !== "string" || item.length === 0 || item.length > MAX_PATH_LENGTH) fail(code);
    if (ids && !ID_PATTERN.test(item)) fail(code);
  }
  const seen = new Set(value.map(caseFold));
  if (seen.size !== value.length) fail(`${code}_duplicate`);
  return Object.freeze([...value]);
}

function safeRepositoryPath(value, code, { allowSubtree = false } = {}) {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_PATH_LENGTH
    || value.includes("\\")
    || value.includes("\0")
    || /[\u0001-\u001f\u007f]/u.test(value)
    || value.startsWith("/")
    || /^[A-Za-z]:/.test(value)
  ) fail(code);
  const suffix = allowSubtree && value.endsWith("/**") ? "/**" : "";
  const base = suffix ? value.slice(0, -suffix.length) : value;
  if (
    base.length === 0
    || base.split("/").some((part) => part.length === 0 || part === "." || part === "..")
    || (!allowSubtree && value.includes("*"))
    || (allowSubtree && base.includes("*"))
  ) fail(code);
  return value;
}

function pathBase(pattern) {
  return pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern;
}

function isSubtree(pattern) {
  return pattern.endsWith("/**");
}

function patternMatches(pattern, changedPath) {
  if (isSubtree(pattern)) return changedPath.startsWith(`${pathBase(pattern)}/`);
  return pattern === changedPath;
}

function foldedPatternMatches(pattern, changedPath) {
  const foldedPattern = caseFold(pattern);
  const foldedChangedPath = caseFold(changedPath);
  if (isSubtree(pattern)) return foldedChangedPath.startsWith(`${caseFold(pathBase(pattern))}/`);
  return foldedPattern === foldedChangedPath;
}

function patternsOverlap(left, right) {
  const leftBase = caseFold(pathBase(left));
  const rightBase = caseFold(pathBase(right));
  if (leftBase === rightBase) return true;
  if (isSubtree(left)) return rightBase.startsWith(`${leftBase}/`);
  if (isSubtree(right)) return leftBase.startsWith(`${rightBase}/`);
  return false;
}

function assertPathBoundaries(ownedPaths, sharedHubs) {
  const all = [
    ...ownedPaths.map((pattern) => ({ pattern, category: "owned" })),
    ...sharedHubs.map((pattern) => ({ pattern, category: "shared" })),
  ];
  for (let leftIndex = 0; leftIndex < all.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < all.length; rightIndex += 1) {
      if (!patternsOverlap(all[leftIndex].pattern, all[rightIndex].pattern)) continue;
      fail(all[leftIndex].category === all[rightIndex].category
        ? "path_boundary_overlap"
        : "path_boundary_collision");
    }
  }
}

function validateExpectedIdentity(expected) {
  if (expected === undefined) return;
  if (!isPlainDataObject(expected)) fail("invalid_expected_identity");
  if (expected.expectedGameId !== undefined) id(expected.expectedGameId, "invalid_expected_game_id");
  if (expected.expectedActionId !== undefined) id(expected.expectedActionId, "invalid_expected_action_id");
  if (expected.expectedBaseCommit !== undefined) baseCommit(expected.expectedBaseCommit, "invalid_expected_base_commit");
}

export function validateFrozenWorkBrief(brief, expected = {}) {
  exactDataRecord(brief, BRIEF_KEYS, "invalid_shape");
  validateExpectedIdentity(expected);
  if (brief.schema !== WORK_BRIEF_SCHEMA) fail("invalid_schema");
  id(brief.gameId, "invalid_game_id");
  id(brief.actionId, "invalid_action_id");
  baseCommit(brief.baseCommit);
  if (expected.expectedGameId !== undefined && brief.gameId !== expected.expectedGameId) fail("game_mismatch");
  if (expected.expectedActionId !== undefined && brief.actionId !== expected.expectedActionId) fail("action_mismatch");
  if (expected.expectedBaseCommit !== undefined && brief.baseCommit !== expected.expectedBaseCommit) fail("base_commit_mismatch");
  if (!Number.isSafeInteger(brief.contractVersion) || brief.contractVersion < 1) fail("invalid_contract_version");
  if (brief.status !== "frozen") fail("not_frozen");
  if (!EFFECTS.has(brief.effect)) fail("invalid_effect");
  if (typeof brief.claimScope !== "string" || brief.claimScope.length === 0 || brief.claimScope.length > MAX_PATH_LENGTH) fail("invalid_claim_scope");
  if (typeof brief.liveAuthorized !== "boolean") fail("invalid_live_authorization");

  const ownedPaths = arrayOfUniqueStrings(brief.ownedPaths, "invalid_owned_paths");
  const sharedHubs = arrayOfUniqueStrings(brief.sharedHubs, "invalid_shared_hubs");
  const requiredPortfolioEntries = arrayOfUniqueStrings(brief.requiredPortfolioEntries, "invalid_required_portfolio_entries", { ids: true });
  const checks = arrayOfUniqueStrings(brief.checks, "invalid_checks", { allowEmpty: false });
  if (ownedPaths.length === 0) fail("missing_required_content");
  for (const ownedPath of ownedPaths) safeRepositoryPath(ownedPath, "invalid_owned_paths", { allowSubtree: true });
  for (const sharedHub of sharedHubs) safeRepositoryPath(sharedHub, "invalid_shared_hubs", { allowSubtree: true });
  assertPathBoundaries(ownedPaths, sharedHubs);

  return Object.freeze({
    schema: brief.schema,
    gameId: brief.gameId,
    actionId: brief.actionId,
    baseCommit: brief.baseCommit,
    contractVersion: brief.contractVersion,
    status: brief.status,
    effect: brief.effect,
    claimScope: brief.claimScope,
    ownedPaths,
    sharedHubs,
    requiredPortfolioEntries,
    checks,
    liveAuthorized: brief.liveAuthorized,
  });
}

function validateChangedPaths(changedPaths) {
  if (types.isProxy(changedPaths) || !Array.isArray(changedPaths) || changedPaths.length > 4_096) fail("invalid_changed_paths");
  const folded = new Set();
  for (const changedPath of changedPaths) {
    safeRepositoryPath(changedPath, "invalid_changed_paths");
    const key = caseFold(changedPath);
    if (folded.has(key)) fail("invalid_changed_paths_case_collision");
    folded.add(key);
  }
  return Object.freeze([...changedPaths]);
}

function classifyOwnedPaths(validated, changedPaths) {
  const owned = [];
  const shared = [];
  for (const changedPath of changedPaths) {
    const exactOwned = validated.ownedPaths.some((pattern) => patternMatches(pattern, changedPath));
    const foldedOwned = !exactOwned && validated.ownedPaths.some((pattern) => foldedPatternMatches(pattern, changedPath));
    const exactShared = validated.sharedHubs.some((pattern) => patternMatches(pattern, changedPath));
    const foldedShared = !exactShared && validated.sharedHubs.some((pattern) => foldedPatternMatches(pattern, changedPath));
    if (foldedOwned || foldedShared) fail("changed_path_case_collision");
    if (exactOwned && exactShared) fail("changed_path_ambiguous");
    if (exactOwned) owned.push(changedPath);
    else if (exactShared) shared.push(changedPath);
    else fail("changed_path_unowned");
  }
  return Object.freeze({ ownedPaths: Object.freeze(owned), sharedHubPaths: Object.freeze(shared) });
}

/**
 * Pure ownership admission. Git is intentionally not invoked here: callers
 * provide the changed-path observation obtained from their project boundary.
 */
export function checkWorkBriefOwnership(brief, changedPaths, expected = {}) {
  const validated = validateFrozenWorkBrief(brief, expected);
  return classifyOwnedPaths(validated, validateChangedPaths(changedPaths));
}

function stripGitPrefix(value) {
  if (value === "/dev/null") return null;
  if (value.startsWith("a/") || value.startsWith("b/")) return value.slice(2);
  return value;
}

function preserveGitPath(value) {
  return value === "/dev/null" ? null : value;
}

function parseNameStatusRecord(record, paths) {
  const fields = record.split("\t");
  const status = fields[0];
  if (GIT_NAME_STATUS_PATTERN.test(status)) {
    for (const field of fields.slice(1)) {
      const normalized = preserveGitPath(field);
      if (normalized !== null && normalized.length > 0) paths.push(normalized);
    }
    return true;
  }
  return false;
}

/**
 * Parse either `git diff --name-only`/`--name-status` output or a bounded
 * unified patch into repository-relative changed paths. This parser does not
 * execute Git and deliberately returns both sides of renames.
 */
export function parseGitDiffPaths(diff) {
  if (Array.isArray(diff)) return validateChangedPaths(diff);
  if (typeof diff !== "string" || Buffer.byteLength(diff, "utf8") > MAX_DIFF_BYTES) fail("invalid_git_diff");
  if (diff.includes("\0")) {
    const records = diff.split("\0");
    const paths = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (record.length === 0) continue;
      if (GIT_NAME_STATUS_PATTERN.test(record)) {
        // `git diff --name-status -z` emits a status, then one path for
        // ordinary changes or old/new paths for a rename/copy.
        const pathCount = /^[RC]/u.test(record) ? 2 : 1;
        for (let pathIndex = 0; pathIndex < pathCount && index + 1 < records.length; pathIndex += 1) {
          const normalized = preserveGitPath(records[++index]);
          if (normalized !== null && normalized.length > 0) paths.push(normalized);
        }
        continue;
      }
      const normalized = preserveGitPath(record);
      if (normalized !== null && normalized.length > 0) paths.push(normalized);
    }
    return validateChangedPaths([...new Set(paths)]);
  }

  const paths = [];
  const lines = diff.split(/\r?\n/u);
  for (const line of lines) {
    if (line.length === 0) continue;
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      const normalized = stripGitPrefix(line.slice(4).split("\t", 1)[0]);
      if (normalized !== null && normalized.length > 0) paths.push(normalized);
      continue;
    }
    const renamePrefix = line.startsWith("rename from ")
      ? "rename from "
      : line.startsWith("rename to ")
        ? "rename to "
        : null;
    if (renamePrefix !== null) {
      // Rename metadata contains the repository path after its full header;
      // slice the known prefix so spaces in the path remain untouched.
      const normalized = preserveGitPath(line.slice(renamePrefix.length));
      if (normalized !== null && normalized.length > 0) paths.push(normalized);
      continue;
    }
    if (parseNameStatusRecord(line, paths)) continue;
    if (/^(?:diff --git |index |old mode |new mode |similarity index |dissimilarity index |new file mode |deleted file mode |Binary files |@@ |[+\-])/u.test(line)) continue;
    // A plain line is the output of `git diff --name-only`; it must still be
    // checked as a repository path below rather than trusted as an option.
    paths.push(line);
  }
  return validateChangedPaths([...new Set(paths)]);
}

function normalizeCompletedChecks(value) {
  return arrayOfUniqueStrings(value, "invalid_completed_checks");
}

function normalizePortfolioEntries(value) {
  return arrayOfUniqueStrings(value, "invalid_portfolio_entries", { ids: true });
}

function validateStage(value) {
  const stage = value ?? "check";
  if (typeof stage !== "string" || !STAGES.has(stage)) fail("invalid_stage");
  return stage;
}

function normalizeDiffOptions(options) {
  if (!isPlainDataObject(options)) fail("invalid_diff_observation");
  const allowed = new Set([
    "baseCommit",
    "diff",
    "changedPaths",
    "completedChecks",
    "requireChecks",
    "portfolioEntries",
    "stage",
    "command",
  ]);
  if (Object.keys(options).some((key) => !allowed.has(key))) fail("invalid_diff_observation_key");
  if (options.diff !== undefined && options.changedPaths !== undefined) fail("ambiguous_git_diff");
  if (options.baseCommit === undefined) fail("missing_observed_base_commit");
  baseCommit(options.baseCommit, "invalid_observed_base_commit");
  if (options.diff === undefined && options.changedPaths === undefined) fail("missing_git_diff");
  const paths = parseGitDiffPaths(options.diff ?? options.changedPaths);
  const completedChecks = options.completedChecks === undefined ? undefined : normalizeCompletedChecks(options.completedChecks);
  if (options.requireChecks !== undefined && typeof options.requireChecks !== "boolean") fail("invalid_require_checks");
  const portfolioEntries = options.portfolioEntries === undefined ? undefined : normalizePortfolioEntries(options.portfolioEntries);
  if (options.stage !== undefined && options.command !== undefined && options.stage !== options.command) fail("ambiguous_stage");
  const stage = validateStage(options.stage ?? options.command);
  return Object.freeze({
    baseCommit: options.baseCommit,
    paths,
    completedChecks,
    requireChecks: options.requireChecks === true || completedChecks !== undefined,
    portfolioEntries,
    stage,
  });
}

function assertObservedRequirements(validated, observation) {
  if (observation.requireChecks) {
    const completed = new Set(observation.completedChecks ?? []);
    const missing = validated.checks.filter((check) => !completed.has(check));
    if (missing.length > 0) fail("missing_required_checks");
  }
  if (observation.portfolioEntries !== undefined) {
    const present = new Set(observation.portfolioEntries);
    const missing = validated.requiredPortfolioEntries.filter((entry) => !present.has(entry));
    if (missing.length > 0) fail("missing_required_portfolio_entries");
  }
}

function normalizeBriefArguments(briefOrInput, options) {
  if (isPlainDataObject(briefOrInput) && Object.hasOwn(briefOrInput, "brief")) {
    if (options !== undefined) fail("ambiguous_diff_observation");
    const { brief, ...rest } = briefOrInput;
    return { brief, options: rest };
  }
  return { brief: briefOrInput, options };
}

/**
 * Compare a supplied Git observation with a frozen brief. The base commit is
 * an exact equality check; this function never resolves refs or creates a
 * worktree. Shared-hub paths are returned separately for the repository's
 * existing owner/review rule.
 */
export function compareWorkBriefDiff(briefOrInput, options) {
  const normalizedArguments = normalizeBriefArguments(briefOrInput, options);
  const validated = validateFrozenWorkBrief(normalizedArguments.brief);
  const observation = normalizeDiffOptions(normalizedArguments.options);
  if (observation.baseCommit !== validated.baseCommit) fail("base_commit_mismatch");
  if (observation.stage === "live" && !validated.liveAuthorized) fail("live_unauthorized");
  const ownership = classifyOwnedPaths(validated, observation.paths);
  assertObservedRequirements(validated, observation);
  return Object.freeze({
    schema: "gamebuddy-action-work-brief-result/v1",
    status: "accepted",
    gameId: validated.gameId,
    actionId: validated.actionId,
    baseCommit: validated.baseCommit,
    stage: observation.stage,
    ownedPaths: ownership.ownedPaths,
    sharedHubPaths: ownership.sharedHubPaths,
    requiredChecks: validated.checks,
    completedChecks: observation.completedChecks ?? Object.freeze([]),
    requiredPortfolioEntries: validated.requiredPortfolioEntries,
    portfolioEntries: observation.portfolioEntries ?? Object.freeze([]),
    liveAuthorized: validated.liveAuthorized,
  });
}


function handoffBriefValue(brief) {
  try {
    return validateFrozenWorkBrief(brief);
  } catch {
    fail("invalid_handoff_brief");
  }
}

/**
 * Build a content-free, bounded handoff for observer timeout/failure. Raw
 * process/observer errors are intentionally not represented in this object.
 */
export function createIncompleteWorkBriefHandoff(briefOrInput, options = {}) {
  let brief = briefOrInput;
  let handoffOptions = options;
  if (isPlainDataObject(briefOrInput) && Object.hasOwn(briefOrInput, "brief")) {
    brief = briefOrInput.brief;
    handoffOptions = { ...briefOrInput };
    delete handoffOptions.brief;
  }
  if (!isPlainDataObject(handoffOptions)) fail("invalid_handoff_options");
  const allowed = new Set(["reasonCode", "stage", "timedOut", "completedChecks"]);
  if (Object.keys(handoffOptions).some((key) => !allowed.has(key))) fail("invalid_handoff_options_key");
  const validated = handoffBriefValue(brief);
  const reasonCode = HANDOFF_REASONS.has(handoffOptions.reasonCode) ? handoffOptions.reasonCode : "observer_failure";
  const stage = validateStage(handoffOptions.stage);
  if (handoffOptions.timedOut !== undefined && typeof handoffOptions.timedOut !== "boolean") fail("invalid_handoff_timeout");
  const completedChecks = handoffOptions.completedChecks === undefined
    ? Object.freeze([])
    : normalizeCompletedChecks(handoffOptions.completedChecks);
  return Object.freeze({
    schema: WORK_BRIEF_HANDOFF_SCHEMA,
    status: "incomplete",
    verdict: "uncertain",
    reasonCode,
    timedOut: handoffOptions.timedOut === true || reasonCode === "timeout",
    gameId: validated.gameId,
    actionId: validated.actionId,
    baseCommit: validated.baseCommit,
    stage,
    ownedPaths: Object.freeze([]),
    sharedHubPaths: Object.freeze([]),
    requiredChecks: validated.checks,
    completedChecks,
  });
}


function observerInput(brief, observer) {
  return Object.freeze({
    gameId: brief.gameId,
    actionId: brief.actionId,
    baseCommit: brief.baseCommit,
  });
}

function validateObserverTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_OBSERVER_TIMEOUT_MS) fail("invalid_observer_timeout");
  return value;
}

async function observeWithTimeout(observer, context, timeoutMs) {
  let timer;
  let timedOut = false;
  const outcome = await new Promise((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve({ kind: "timeout" });
    }, timeoutMs);
    timer.unref?.();
    Promise.resolve()
      .then(() => observer(context))
      .then(
        (value) => resolve({ kind: "value", value }),
        () => resolve({ kind: "failure" }),
      );
  });
  clearTimeout(timer);
  if (timedOut || outcome.kind === "timeout") return outcome;
  return outcome;
}

/**
 * Safe work-brief check entrypoint. Direct observations are synchronous and
 * reject contract violations. An injected asynchronous Git observer is
 * bounded and returns an incomplete handoff on timeout/failure instead of
 * exposing the observer's raw process error.
 */
export function checkWorkBrief(briefOrInput, options) {
  const normalizedArguments = normalizeBriefArguments(briefOrInput, options);
  const rawOptions = normalizedArguments.options;
  const validated = validateFrozenWorkBrief(normalizedArguments.brief);
  if (!isPlainDataObject(rawOptions)) fail("invalid_diff_observation");
  const observer = rawOptions.gitObserver;
  if (observer === undefined) return compareWorkBriefDiff(validated, rawOptions);
  if (typeof observer !== "function") fail("invalid_git_observer");
  const allowed = new Set(["gitObserver", "timeoutMs", "stage", "command"]);
  if (Object.keys(rawOptions).some((key) => !allowed.has(key))) fail("invalid_observer_options_key");
  const timeoutMs = validateObserverTimeout(rawOptions.timeoutMs ?? 30_000);
  const stage = validateStage(rawOptions.stage ?? rawOptions.command);
  return (async () => {
    const observation = await observeWithTimeout(observer, observerInput(validated, observer), timeoutMs);
    if (observation.kind === "timeout") {
      return createIncompleteWorkBriefHandoff(validated, { reasonCode: "timeout", timedOut: true, stage });
    }
    if (observation.kind === "failure") {
      return createIncompleteWorkBriefHandoff(validated, { reasonCode: "observer_failure", stage });
    }
    if (!isPlainDataObject(observation.value)) {
      return createIncompleteWorkBriefHandoff(validated, { reasonCode: "observer_invalid", stage });
    }
    try {
      return compareWorkBriefDiff(validated, { ...observation.value, stage });
    } catch (error) {
      if (String(error?.message).startsWith("game_action_brief_")) throw error;
      return createIncompleteWorkBriefHandoff(validated, { reasonCode: "git_diff_invalid", stage });
    }
  })();
}


export function assertWorkBriefStageAuthorized(brief, stage) {
  const validated = validateFrozenWorkBrief(brief);
  const normalizedStage = validateStage(stage);
  if (normalizedStage === "live" && !validated.liveAuthorized) fail("live_unauthorized");
  return Object.freeze({ gameId: validated.gameId, actionId: validated.actionId, stage: normalizedStage, liveAuthorized: validated.liveAuthorized });
}
