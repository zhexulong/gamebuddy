import { types } from "node:util";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EFFECTS = new Set(["read_only", "mutation"]);
const STATUSES = new Set(["draft", "frozen", "blocked", "withdrawn"]);
const KEYS = new Set(["schema", "gameId", "actionId", "contractVersion", "status", "effect", "claimScope", "ownedPaths", "sharedHubs", "checks"]);

function fail(code) { throw new Error(`game_action_brief_${code}`); }
function object(value) { return value !== null && typeof value === "object" && !types.isProxy(value) && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exactDataRecord(value, keys, code) {
  if (!object(value)) fail(code);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.size || ownKeys.some((key) => typeof key !== "string" || !keys.has(key))) fail(code);
  for (const key of ownKeys) if (typeof Object.getOwnPropertyDescriptor(value, key)?.get === "function" || typeof Object.getOwnPropertyDescriptor(value, key)?.set === "function") fail(code);
}
function id(value, code) { if (typeof value !== "string" || !ID_PATTERN.test(value)) fail(code); }
function arrayOfUniqueStrings(value, code) {
  if (types.isProxy(value) || !Array.isArray(value) || value.length > 64 || value.some((item) => typeof item !== "string" || item.length === 0 || item.length > 512)) fail(code);
  const seen = new Set(value.map((item) => item.toLocaleLowerCase("en-US")));
  if (seen.size !== value.length) fail(`${code}_duplicate`);
  return Object.freeze([...value]);
}
function safeRepositoryPath(value, code, { allowSubtree = false } = {}) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) fail(code);
  const suffix = allowSubtree && value.endsWith("/**") ? "/**" : "";
  const base = suffix ? value.slice(0, -suffix.length) : value;
  if (base.length === 0 || base.split("/").some((part) => part.length === 0 || part === "." || part === "..") || (!allowSubtree && value.includes("*")) || (allowSubtree && base.includes("*"))) fail(code);
  return value;
}
function matchesOwnedPath(pattern, changedPath) {
  return pattern.endsWith("/**") ? changedPath.startsWith(pattern.slice(0, -2)) : pattern === changedPath;
}

export function validateFrozenWorkBrief(brief, { expectedGameId, expectedActionId } = {}) {
  exactDataRecord(brief, KEYS, "invalid_shape");
  if (brief.schema !== "gamebuddy-action-work-brief/v1") fail("invalid_schema");
  id(brief.gameId, "invalid_game_id");
  id(brief.actionId, "invalid_action_id");
  if (expectedGameId && brief.gameId !== expectedGameId) fail("game_mismatch");
  if (expectedActionId && brief.actionId !== expectedActionId) fail("action_mismatch");
  if (!Number.isInteger(brief.contractVersion) || brief.contractVersion < 1) fail("invalid_contract_version");
  if (brief.status !== "frozen") fail("not_frozen");
  if (!EFFECTS.has(brief.effect)) fail("invalid_effect");
  if (typeof brief.claimScope !== "string" || brief.claimScope.length === 0 || brief.claimScope.length > 512) fail("invalid_claim_scope");
  const ownedPaths = arrayOfUniqueStrings(brief.ownedPaths, "invalid_owned_paths");
  const sharedHubs = arrayOfUniqueStrings(brief.sharedHubs, "invalid_shared_hubs");
  for (const ownedPath of ownedPaths) safeRepositoryPath(ownedPath, "invalid_owned_paths", { allowSubtree: true });
  for (const sharedHub of sharedHubs) safeRepositoryPath(sharedHub, "invalid_shared_hubs", { allowSubtree: true });
  const checks = arrayOfUniqueStrings(brief.checks, "invalid_checks");
  if (ownedPaths.length === 0 || checks.length === 0) fail("missing_required_content");
  return Object.freeze({
    schema: brief.schema,
    gameId: brief.gameId,
    actionId: brief.actionId,
    contractVersion: brief.contractVersion,
    status: brief.status,
    effect: brief.effect,
    claimScope: brief.claimScope,
    ownedPaths,
    sharedHubs,
    checks,
  });
}

/**
 * Pure admission check: callers supply a frozen brief and their own changed-path observation.
 * It deliberately does not run Git or construct worktrees.
 */
export function checkWorkBriefOwnership(brief, changedPaths, expected = {}) {
  const validated = validateFrozenWorkBrief(brief, expected);
  if (types.isProxy(changedPaths) || !Array.isArray(changedPaths) || changedPaths.length > 4_096) fail("invalid_changed_paths");
  const owned = [];
  const shared = [];
  for (const changedPath of changedPaths) {
    safeRepositoryPath(changedPath, "invalid_changed_paths");
    if (validated.ownedPaths.some((pattern) => matchesOwnedPath(pattern, changedPath))) owned.push(changedPath);
    else if (validated.sharedHubs.some((pattern) => matchesOwnedPath(pattern, changedPath))) shared.push(changedPath);
    else fail("changed_path_unowned");
  }
  return Object.freeze({ ownedPaths: Object.freeze(owned), sharedHubPaths: Object.freeze(shared) });
}

export { EFFECTS, STATUSES };
