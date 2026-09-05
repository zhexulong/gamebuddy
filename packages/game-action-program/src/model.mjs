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
});

export const PROGRAM_KEYS = new Set(["schema", "programId", "nodes", "edges"]);
export const NODE_KEYS = new Set(["nodeId", "actionId", "args", "bindings", "guards"]);
export const EDGE_KEYS = new Set(["from", "to"]);
export const BINDING_KEYS = new Set(["arg", "from", "fact"]);
export const GUARD_KEYS = new Set(["kind", "nodeId", "fact", "operator", "value"]);

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

export function jsonDepth(value, depth = 1) {
  if (value === null || typeof value !== "object") return depth;
  let maximum = depth;
  for (const child of Object.values(value)) maximum = Math.max(maximum, jsonDepth(child, depth + 1));
  return maximum;
}

export function utf8Bytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
