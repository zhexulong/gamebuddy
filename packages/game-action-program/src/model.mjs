export const ACTION_PROGRAM_SCHEMA = "gamebuddy-action-program/v1";

export const PROGRAM_LIMITS = Object.freeze({
  maxUtf8Bytes: 12_288,
  maxNodes: 16,
  maxEdges: 32,
  maxGuardsPerNode: 4,
  maxGuards: 32,
  maxBindingsPerNode: 4,
  maxBindings: 32,
  maxDegree: 8,
  maxJsonDepth: 16,
  maxDiagnostics: 64,
  maxActions: 128,
  maxArgumentCount: 32,
  maxFactCount: 32,
  maxResourceClaims: 16,
  maxStringLength: 128,
});

export const PROGRAM_KEYS = new Set(["schema", "programId", "nodes", "edges"]);
export const NODE_KEYS = new Set(["nodeId", "actionId", "args", "bindings", "guards"]);
export const EDGE_KEYS = new Set(["from", "to"]);
export const BINDING_KEYS = new Set(["arg", "from", "fact"]);
export const GUARD_KEYS = new Set(["kind", "nodeId", "fact", "operator", "value"]);

/** Single identifier spelling for program/node/action/argument/fact identities across the package. */
export const ACTION_IDENTIFIER = /^[a-z][a-z0-9_]{1,127}$/;

export function isPlainDataObject(value) {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      && Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

export function hasExactKeys(value, expected) {
  if (!isPlainDataObject(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.size && keys.every((key) => typeof key === "string" && expected.has(key));
}

/**
 * Bounded JSON depth. Defaults to the protocol JSON depth limit so hostile deep or
 * circular input cannot overflow the stack; a depth above the bound is reported as
 * a limit violation rather than explored.
 */
export function jsonDepth(value, limit = PROGRAM_LIMITS.maxJsonDepth, depth = 1) {
  const bound = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : PROGRAM_LIMITS.maxJsonDepth;
  if (depth > bound) return depth;
  if (value === null || typeof value !== "object") return depth;
  let maximum = depth;
  for (const child of Object.values(value)) maximum = Math.max(maximum, jsonDepth(child, bound, depth + 1));
  return maximum;
}

/** Fail-closed canonical serialization: returns null instead of throwing on hostile values. */
export function canonicalStringify(value) {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : null;
  } catch {
    return null;
  }
}

export function utf8Bytes(value) {
  const serialized = canonicalStringify(value);
  return serialized === null ? 0 : new TextEncoder().encode(serialized).byteLength;
}

/** Recursive deep freeze for detached report values; never mutates caller data. */
export function deepFreeze(value) {
  return freezeGraph(value, new WeakSet());
}

function freezeGraph(value, visited) {
  if (value === null || typeof value !== "object" || visited.has(value)) return value;
  visited.add(value);
  for (const child of Object.values(value)) freezeGraph(child, visited);
  return Object.freeze(value);
}