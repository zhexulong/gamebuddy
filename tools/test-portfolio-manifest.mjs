#!/usr/bin/env node
import { spawn } from "node:child_process";
/**
 * Strict, non-executing validator for the narrow P1.8 test portfolio.
 *
 * This module validates metadata only. It deliberately does not discover,
 * schedule, or claim coverage of repository tests.
 */
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const MANIFEST_SCHEMA = "gamebuddy-test-portfolio/v1";
const ROOT_KEYS = new Set(["schema", "version", "entries"]);
const ENTRY_KEYS = new Set([
  "id",
  "riskId",
  "owner",
  "evidenceKind",
  "command",
  "triggerPaths",
  "timeoutSeconds",
  "retryPolicy",
  "requiredOn",
  "requires",
  "liveGate",
]);
const RETRY_KEYS = new Set(["maxAttempts", "backoffSeconds"]);
const EVIDENCE_KINDS = new Set(["automated", "manual-diagnostic", "static", "fixture", "live"]);
const LIVE_GATES = new Set(["none", "required"]);
const REQUIRED_ON = new Set(["pull_request", "main", "release", "manual"]);
const SAFE_EXECUTABLES = new Set(["node", "pnpm"]);
const MAX_TIMEOUT_SECONDS = 3600;
const MAX_RETRY_ATTEMPTS = 3;
const MAX_BACKOFF_SECONDS = 300;
const UNSAFE_NODE_OPTIONS = Object.freeze([
  "-e",
  "--eval",
  "-p",
  "--print",
  "-r",
  "--require",
  "--import",
  "--loader",
  "--experimental-loader",
  "--inspect",
  "--inspect-brk",
  "--inspect-port",
  "--inspect-publish-uid",
  "--debug",
  "--debug-brk",
  "--debug-port",
]);

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;
const unknownKeys = (value, allowed) => (isRecord(value) ? Object.keys(value).filter((key) => !allowed.has(key)) : []);
const hasTraversal = (value) => /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value);

function normalizeRepoPath(value) {
  if (typeof value !== "string") return null;
  if (value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return null;
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return null;
  return parts.join("/") === value ? value : null;
}

function checkSafePath(value, label, errors) {
  if (!isNonEmptyString(value)) {
    errors.push(`${label}_must_be_non_empty`);
    return;
  }
  if (normalizeRepoPath(value) === null || hasTraversal(value)) {
    errors.push(`${label}_unsafe_path`);
  }
}

function checkCommand(value, label, errors) {
  if (!isNonEmptyString(value)) {
    errors.push(`${label}_must_be_non_empty`);
    return;
  }
  // Commands are data for the repository-owned runner, never shell source.
  if (/[^\x20-\x7e]/.test(value) || /[;&|<>`$()\\'\"]/.test(value) || hasTraversal(value)) {
    errors.push(`${label}_unsafe_command`);
    return;
  }
  const tokens = value.trim().split(/\s+/u);
  if (!SAFE_EXECUTABLES.has(tokens[0])) errors.push(`${label}_executable_not_allowlisted`);
  const unsafe = (token) => {
    const option = token.split("=", 1)[0];
    return (
      UNSAFE_NODE_OPTIONS.includes(option) ||
      UNSAFE_NODE_OPTIONS.some(
        (flag) =>
          flag.length === 2 && token.startsWith(flag) && token.length > flag.length && !token.startsWith(`${flag}=`),
      )
    );
  };
  const nodeIndex = tokens.indexOf("node");
  if (nodeIndex >= 0 && tokens.slice(nodeIndex + 1).some(unsafe))
    errors.push(`${label}_module_loader_eval_inspect_forbidden`);
  for (const token of tokens.slice(1)) {
    if (token.includes("/") || token.includes("*")) checkSafePath(token.split("=", 2).at(-1), `${label}_path`, errors);
  }
}

function checkBoundedTimeout(value, label, errors) {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_TIMEOUT_SECONDS) {
    errors.push(`${label}_must_be_bounded_positive_seconds`);
  }
}

export function validateTestPortfolioManifest(manifest) {
  const errors = [];
  if (!isRecord(manifest)) return { valid: false, errors: ["manifest_must_be_object"] };
  for (const key of unknownKeys(manifest, ROOT_KEYS)) errors.push(`manifest_unknown_key:${key}`);
  if (manifest.schema !== MANIFEST_SCHEMA) errors.push("manifest_schema_invalid");
  if (manifest.version !== 1) errors.push("manifest_version_invalid");
  if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
    errors.push("manifest_entries_must_be_non_empty_array");
    return { valid: false, errors };
  }

  const ids = new Set();
  const triggerPaths = new Set();
  const triggerPathsFolded = new Set();
  const entriesById = new Map();
  for (const [index, entry] of manifest.entries.entries()) {
    const label = `entry[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${label}_must_be_object`);
      continue;
    }
    for (const key of unknownKeys(entry, ENTRY_KEYS)) errors.push(`${label}_unknown_key:${key}`);
    for (const field of ["id", "riskId", "owner"]) {
      if (!isNonEmptyString(entry[field])) errors.push(`${label}_${field}_must_be_non_empty`);
    }
    if (isNonEmptyString(entry.id)) {
      if (ids.has(entry.id)) errors.push(`duplicate_id:${entry.id}`);
      ids.add(entry.id);
      entriesById.set(entry.id, entry);
      if (!/^[a-z0-9][a-z0-9._-]*$/u.test(entry.id)) errors.push(`${label}_id_invalid`);
    }
    if (!EVIDENCE_KINDS.has(entry.evidenceKind)) errors.push(`${label}_evidence_kind_invalid`);
    if (!Array.isArray(entry.triggerPaths) || entry.triggerPaths.length === 0) {
      errors.push(`${label}_trigger_paths_must_be_non_empty_array`);
    } else {
      for (const [pathIndex, path] of entry.triggerPaths.entries()) {
        const pathLabel = `${label}_triggerPaths[${pathIndex}]`;
        checkSafePath(path, pathLabel, errors);
        if (normalizeRepoPath(path) !== null) {
          const foldedPath = path.toLocaleLowerCase("en-US");
          if (triggerPaths.has(path) || triggerPathsFolded.has(foldedPath))
            errors.push(`duplicate_trigger_path:${path}`);
          triggerPaths.add(path);
          triggerPathsFolded.add(foldedPath);
        }
      }
    }
    if (!Array.isArray(entry.requiredOn) || entry.requiredOn.length === 0) {
      errors.push(`${label}_required_on_must_be_non_empty_array`);
    } else {
      const seenRequiredOn = new Set();
      for (const target of entry.requiredOn) {
        if (!REQUIRED_ON.has(target)) errors.push(`${label}_requiredOn_invalid:${target}`);
        if (seenRequiredOn.has(target)) errors.push(`${label}_requiredOn_duplicate:${target}`);
        seenRequiredOn.add(target);
      }
    }
    if (!Array.isArray(entry.requires)) errors.push(`${label}_requires_must_be_array`);
    else
      for (const required of entry.requires)
        if (!isNonEmptyString(required)) errors.push(`${label}_requires_invalid_reference`);
    if (!LIVE_GATES.has(entry.liveGate)) errors.push(`${label}_live_gate_invalid`);

    const automated = entry.evidenceKind === "automated" || entry.evidenceKind === "live";
    const requiredAutomated =
      automated && Array.isArray(entry.requiredOn) && entry.requiredOn.some((target) => target !== "manual");
    if (!automated && Array.isArray(entry.requiredOn)) {
      const manualOnly = entry.requiredOn.length === 1 && entry.requiredOn[0] === "manual";
      if (!manualOnly) errors.push(`${label}_non_automated_requires_manual_only`);
    }
    if (automated) {
      checkCommand(entry.command, `${label}_command`, errors);
      checkBoundedTimeout(entry.timeoutSeconds, `${label}_timeoutSeconds`, errors);
      if (!isRecord(entry.retryPolicy)) errors.push(`${label}_retry_policy_must_be_object`);
      else {
        for (const key of unknownKeys(entry.retryPolicy, RETRY_KEYS))
          errors.push(`${label}_retryPolicy_unknown_key:${key}`);
        if (
          !Number.isInteger(entry.retryPolicy.maxAttempts) ||
          entry.retryPolicy.maxAttempts < 1 ||
          entry.retryPolicy.maxAttempts > MAX_RETRY_ATTEMPTS
        )
          errors.push(`${label}_retryPolicy_maxAttempts_must_be_bounded`);
        if (
          !Number.isInteger(entry.retryPolicy.backoffSeconds) ||
          entry.retryPolicy.backoffSeconds < 0 ||
          entry.retryPolicy.backoffSeconds > MAX_BACKOFF_SECONDS
        )
          errors.push(`${label}_retryPolicy_backoffSeconds_invalid`);
      }
      if (
        requiredAutomated &&
        (!Number.isFinite(entry.timeoutSeconds) ||
          entry.timeoutSeconds <= 0 ||
          entry.timeoutSeconds > MAX_TIMEOUT_SECONDS)
      )
        errors.push(`${label}_required_automated_timeout_invalid`);
    } else {
      if (entry.command !== null) errors.push(`${label}_command_must_be_null_for_non_automated`);
      if (entry.timeoutSeconds !== null) errors.push(`${label}_timeout_must_be_null_for_non_automated`);
      if (entry.retryPolicy !== null) errors.push(`${label}_retry_policy_must_be_null_for_non_automated`);
    }
    if (["static", "fixture"].includes(entry.evidenceKind) && entry.liveGate === "required")
      errors.push(`${label}_static_or_fixture_cannot_be_live`);
    if (entry.evidenceKind === "manual-diagnostic") {
      if (!Array.isArray(entry.requiredOn) || !entry.requiredOn.includes("manual"))
        errors.push(`${label}_manual_diagnostic_requires_manual_trigger`);
      if (entry.liveGate !== "none") errors.push(`${label}_manual_diagnostic_live_gate_invalid`);
    }
    if (entry.evidenceKind === "live" && entry.liveGate !== "required")
      errors.push(`${label}_live_evidence_requires_live_gate`);
  }

  for (const [index, entry] of manifest.entries.entries()) {
    if (!isRecord(entry) || !Array.isArray(entry.requires)) continue;
    for (const required of entry.requires)
      if (isNonEmptyString(required) && !entriesById.has(required))
        errors.push(`entry[${index}]_requires_unknown:${required}`);
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) {
      errors.push(`requires_cycle:${id}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of entriesById.get(id)?.requires ?? []) if (entriesById.has(dependency)) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of entriesById.keys()) visit(id);
  return { valid: errors.length === 0, errors };
}

async function validateTriggerFiles(manifest, repositoryRoot) {
  const errors = [];
  const root = resolve(repositoryRoot);
  for (const entry of manifest.entries ?? []) {
    for (const [index, triggerPath] of (entry.triggerPaths ?? []).entries()) {
      const label = `entry[${manifest.entries.indexOf(entry)}]_triggerPaths[${index}]`;
      if (normalizeRepoPath(triggerPath) === null) continue;
      const absolute = resolve(root, triggerPath);
      const relation = relative(root, absolute);
      if (relation === ".." || relation.startsWith(`..${sep}`)) {
        errors.push(`${label}_unsafe_path`);
        continue;
      }
      let state;
      try {
        state = await lstat(absolute);
        const canonicalFile = await realpath(absolute);
        const canonicalRelation = relative(root, canonicalFile);
        if (isAbsolute(canonicalRelation) || canonicalRelation === ".." || canonicalRelation.startsWith(`..${sep}`)) {
          errors.push(`${label}_must_be_canonical_file`);
          continue;
        }
        const parts = triggerPath.split("/");
        for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
          const component = resolve(root, ...parts.slice(0, partIndex + 1));
          const componentState = await lstat(component);
          if (componentState.isSymbolicLink()) {
            errors.push(`${label}_must_be_canonical_file`);
            state = null;
            break;
          }
        }
        if (state === null) continue;
      } catch (error) {
        errors.push(`${label}_must_exist_as_regular_file`);
        continue;
      }
      if (state.isSymbolicLink() || !state.isFile() || state.nlink !== 1)
        errors.push(`${label}_must_exist_as_regular_file`);
    }
  }
  return errors;
}

export async function readAndValidateTestPortfolioManifest(
  filePath = resolve(import.meta.dirname, "../.ci/test-portfolio-manifest.v1.json"),
  repositoryRoot,
) {
  const root = repositoryRoot ?? dirname(dirname(resolve(filePath)));
  let manifest;
  try {
    manifest = JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    return { valid: false, errors: [`manifest_read_failed:${error.code ?? error.name ?? "unknown"}`] };
  }
  const result = validateTestPortfolioManifest(manifest);
  if (!result.valid) return result;
  const triggerErrors = await validateTriggerFiles(manifest, root);
  return { valid: triggerErrors.length === 0, errors: triggerErrors };
}

if (import.meta.main) {
  const filePath = process.argv[2] ? resolve(process.argv[2]) : undefined;
  const result = await readAndValidateTestPortfolioManifest(filePath);
  console.log(JSON.stringify({ schema: MANIFEST_SCHEMA, ...result }, null, 2));
  process.exitCode = result.valid ? 0 : 1;
}
