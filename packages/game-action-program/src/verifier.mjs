import {
  ACTION_PROGRAM_SCHEMA, BINDING_KEYS, EDGE_KEYS, GUARD_KEYS, NODE_KEYS, PROGRAM_KEYS,
  PROGRAM_LIMITS, canonicalStringify, deepFreeze, hasExactKeys, isPlainDataObject, jsonDepth,
} from "./model.mjs";
import { descriptorMap } from "./descriptors.mjs";

const FORBIDDEN_FIELDS = new Set(["resources", "locks", "claimMode", "lease", "leases", "owner", "owners", "acquire", "release"]);
const ID = /^[a-z][a-z0-9_]{1,127}$/;

/** Pure, descriptor-constrained validation. It neither accesses world state nor grants execution authority. */
export function verifyActionProgram({ program, descriptors, restrictivePolicy }) {
  const diagnostics = [];
  const descriptorRevision = readDescriptorRevision(descriptors);
  const add = (code, path, nodeId = null, message = code) => diagnostics.push({
    severity: "error",
    code,
    nodeId: typeof nodeId === "string" ? nodeId : null,
    path,
    message: message.slice(0, 256),
  });
  const catalog = descriptorMap(descriptors);
  if (!catalog) {
    add("invalid_descriptor_projection", "/descriptors", null, "Descriptor projection is not a valid authoritative v1 projection.");
    return report(program, descriptorRevision, diagnostics);
  }
  if (!isPlainDataObject(restrictivePolicy) || !Array.isArray(restrictivePolicy.enabledActionIds)
    || !restrictivePolicy.enabledActionIds.every((id) => typeof id === "string")) {
    add("invalid_restrictive_policy", "/restrictivePolicy", null, "Restrictive policy must provide enabledActionIds.");
  }
  const enabled = new Set(restrictivePolicy?.enabledActionIds ?? []);
  if (!hasExactKeys(program, PROGRAM_KEYS)) {
    findForbidden(program, "", add);
    add("invalid_program_shape", "", null, "Program must contain exactly schema, programId, nodes, and edges.");
    return report(program, descriptorRevision, diagnostics);
  }
  if (program.schema !== ACTION_PROGRAM_SCHEMA) add("invalid_program_schema", "/schema", null, "Program schema must be gamebuddy-action-program/v1.");
  if (typeof program.programId !== "string" || !ID.test(program.programId)) add("invalid_program_id", "/programId", null, "programId must be a bounded identifier.");
  const encoded = canonicalStringify(program);
  if (encoded === null) {
    add("invalid_program_encoding", "", null, "Program cannot be canonically serialized.");
    return report(program, descriptorRevision, diagnostics);
  }
  if (!canonicalRoundTrips(program, encoded)) add("invalid_program_encoding", "", null, "Program is not canonical plain data.");
  else if (new TextEncoder().encode(encoded).byteLength > PROGRAM_LIMITS.maxUtf8Bytes) add("program_too_large", "", null, "Program exceeds the canonical UTF-8 byte limit.");
  if (jsonDepth(program) > PROGRAM_LIMITS.maxJsonDepth) add("json_too_deep", "", null, "Program exceeds the JSON depth limit.");
  findForbidden(program, "", add);
  if (!Array.isArray(program.nodes) || program.nodes.length > PROGRAM_LIMITS.maxNodes) add("invalid_node_bounds", "/nodes", null, "nodes must be an array within the v1 limit.");
  if (!Array.isArray(program.edges) || program.edges.length > PROGRAM_LIMITS.maxEdges) add("invalid_edge_bounds", "/edges", null, "edges must be an array within the v1 limit.");
  if (!Array.isArray(program.nodes) || !Array.isArray(program.edges)) return report(program, descriptorRevision, diagnostics);

  const nodes = new Map(); let totalGuards = 0; let totalBindings = 0;
  program.nodes.forEach((node, index) => {
    const path = `/nodes/${index}`;
    if (!hasExactKeys(node, NODE_KEYS)) { add("invalid_node_shape", path, null, "Node has an invalid exact-key shape."); return; }
    if (typeof node.nodeId !== "string" || !ID.test(node.nodeId) || nodes.has(node.nodeId)) add("invalid_node_id", `${path}/nodeId`, node.nodeId ?? null, "nodeId must be unique and bounded.");
    else nodes.set(node.nodeId, { node, index });
    if (typeof node.actionId !== "string" || !catalog?.has(node.actionId)) add("unknown_action", `${path}/actionId`, node.nodeId ?? null, "Action is absent from the descriptor projection.");
    else if (!enabled.has(node.actionId)) add("action_restricted_by_policy", `${path}/actionId`, node.nodeId, "Action is not enabled by restrictive policy.");
    if (!isPlainDataObject(node.args)) add("invalid_argument_shape", `${path}/args`, node.nodeId ?? null, "args must be a plain exact-key object.");
    if (!Array.isArray(node.bindings) || node.bindings.length > PROGRAM_LIMITS.maxBindingsPerNode) add("invalid_binding_bounds", `${path}/bindings`, node.nodeId ?? null, "bindings exceed the per-node limit.");
    else totalBindings += node.bindings.length;
    if (!Array.isArray(node.guards) || node.guards.length > PROGRAM_LIMITS.maxGuardsPerNode) add("invalid_guard_bounds", `${path}/guards`, node.nodeId ?? null, "guards exceed the per-node limit.");
    else totalGuards += node.guards.length;
  });
  if (totalBindings > PROGRAM_LIMITS.maxBindings) add("invalid_binding_bounds", "/nodes", null, "Total bindings exceed the v1 limit.");
  if (totalGuards > PROGRAM_LIMITS.maxGuards) add("invalid_guard_bounds", "/nodes", null, "Total guards exceed the v1 limit.");

  const adjacency = new Map([...nodes.keys()].map((id) => [id, new Set()]));
  const indegree = new Map([...nodes.keys()].map((id) => [id, 0]));
  program.edges.forEach((edge, index) => {
    const path = `/edges/${index}`;
    if (!hasExactKeys(edge, EDGE_KEYS) || typeof edge.from !== "string" || typeof edge.to !== "string") { add("invalid_edge_shape", path, null, "Edge must contain exactly from and to identifiers."); return; }
    if (!nodes.has(edge.from) || !nodes.has(edge.to) || edge.from === edge.to || adjacency.get(edge.from).has(edge.to)) { add("invalid_edge", path, null, "Edge must connect distinct known nodes exactly once."); return; }
    adjacency.get(edge.from).add(edge.to); indegree.set(edge.to, indegree.get(edge.to) + 1);
  });
  for (const [id, next] of adjacency) if (next.size > PROGRAM_LIMITS.maxDegree || indegree.get(id) > PROGRAM_LIMITS.maxDegree) add("invalid_node_degree", `/nodes/${nodes.get(id).index}`, id, "Node degree exceeds the v1 limit.");
  const order = topologicalOrder(nodes, adjacency, indegree);
  if (order === null) add("cycle_detected", "/edges", null, "Program edges must form a DAG.");

  for (const { node, index } of nodes.values()) validateNode(node, index, catalog, nodes, adjacency, add);
  if (order !== null) validateResourceConflicts(nodes, adjacency, catalog, add);
  return report(program, descriptorRevision, diagnostics);
}

function validateNode(node, index, catalog, nodes, adjacency, add) {
  const descriptor = catalog?.get(node.actionId); if (!descriptor) return;
  const expected = Object.keys(descriptor.argumentSchema);
  const validArgs = isPlainDataObject(node.args);
  const validBindings = Array.isArray(node.bindings);
  const validGuards = Array.isArray(node.guards);
  const bindingArgs = new Set();
  for (let i = 0; validBindings && i < node.bindings.length; i += 1) {
    const binding = node.bindings[i]; const path = `/nodes/${index}/bindings/${i}`;
    if (!hasExactKeys(binding, BINDING_KEYS) || typeof binding.arg !== "string" || typeof binding.from !== "string" || typeof binding.fact !== "string") { add("invalid_binding_shape", path, node.nodeId, "Binding must contain exactly arg, from, and fact."); continue; }
    if (!expected.includes(binding.arg) || bindingArgs.has(binding.arg)) add("invalid_binding_argument", `${path}/arg`, node.nodeId, "Binding argument must be a unique descriptor argument.");
    bindingArgs.add(binding.arg); const producer = nodes.get(binding.from);
    if (!producer || !reachable(binding.from, node.nodeId, adjacency)) add("binding_dependency_not_dominant", `${path}/from`, node.nodeId, "Binding producer must be a declared dependency ancestor.");
    const fact = declaredOutputFactType(catalog?.get(producer?.node.actionId), binding.fact);
    if (!fact || fact !== descriptor.argumentSchema[binding.arg]?.type) add("binding_type_mismatch", path, node.nodeId, "Binding fact must be declared and type-compatible.");
  }
  if (validArgs) {
    const actual = Object.keys(node.args);
    if (actual.some((arg) => !expected.includes(arg)) || expected.some((arg) => !actual.includes(arg) && !bindingArgs.has(arg))) add("argument_schema_mismatch", `/nodes/${index}/args`, node.nodeId, "Arguments plus bindings must exactly satisfy the descriptor schema.");
    for (const [arg, value] of Object.entries(node.args)) if (descriptor.argumentSchema[arg] && !matchesType(value, descriptor.argumentSchema[arg].type)) add("argument_type_mismatch", `/nodes/${index}/args/${escapePointer(arg)}`, node.nodeId, "Argument does not match the descriptor type.");
  }
  for (let i = 0; validGuards && i < node.guards.length; i += 1) {
    const guard = node.guards[i]; const path = `/nodes/${index}/guards/${i}`;
    if (!hasExactKeys(guard, GUARD_KEYS) || !["fact_present", "fact_equals", "node_succeeded"].includes(guard.kind) || !isIdentifier(guard.nodeId)) {
      add("invalid_guard", path, node.nodeId, "Guard is not a finite v1 guard.");
      continue;
    }
    const producer = nodes.get(guard.nodeId);
    const producerDescriptor = catalog?.get(producer?.node.actionId);
    const dominant = Boolean(producer && reachable(guard.nodeId, node.nodeId, adjacency));
    const factType = declaredOutputFactType(producerDescriptor, guard.fact);
    const valid = dominant && (
      (guard.kind === "fact_present"
        && isIdentifier(guard.fact) && factType !== null && guard.operator === null && guard.value === null)
      || (guard.kind === "fact_equals"
        && isIdentifier(guard.fact) && isScalarFactType(factType) && guard.operator === null && matchesType(guard.value, factType))
      || (guard.kind === "node_succeeded"
        && guard.fact === null && guard.operator === null && guard.value === null)
    );
    if (!valid) add("invalid_guard", path, node.nodeId, "Guard must reference a dominant declared fact or terminal node state.");
  }
}

function validateResourceConflicts(nodes, adjacency, catalog, add) {
  const entries = [...nodes.values()];
  for (let i = 0; i < entries.length; i += 1) for (let j = i + 1; j < entries.length; j += 1) {
    const left = entries[i]; const right = entries[j];
    if (reachable(left.node.nodeId, right.node.nodeId, adjacency) || reachable(right.node.nodeId, left.node.nodeId, adjacency)) continue;
    const a = catalog.get(left.node.actionId); const b = catalog.get(right.node.actionId);
    if (!a || !b) continue;
    const leftClaims = new Set(a.resourceTemplate.claims.map((claim) => `${claim.key}:${claim.value}`));
    const overlap = b.resourceTemplate.claims.some((claim) => leftClaims.has(`${claim.key}:${claim.value}`));
    if (overlap && (a.effect === "write" || b.effect === "write")) add("resource_conflict_requires_dependency", `/nodes/${right.index}`, right.node.nodeId, "Potentially concurrent descriptor-derived resource claims require a dependency.");
  }
}
function topologicalOrder(nodes, adjacency, indegree) { const pending = new Map(indegree); const ready = [...pending].filter(([, v]) => v === 0).map(([id]) => id); const order = []; while (ready.length) { const id = ready.shift(); order.push(id); for (const next of adjacency.get(id)) { pending.set(next, pending.get(next) - 1); if (pending.get(next) === 0) ready.push(next); } } return order.length === nodes.size ? order : null; }
function reachable(from, to, adjacency) { const seen = new Set([from]); const todo = [from]; while (todo.length) { const current = todo.pop(); for (const next of adjacency.get(current) ?? []) { if (next === to) return true; if (!seen.has(next)) { seen.add(next); todo.push(next); } } } return false; }
function isIdentifier(value) { return typeof value === "string" && ID.test(value); }
function matchesType(value, type) { return (type === "string" && typeof value === "string") || (type === "integer" && Number.isSafeInteger(value)) || (type === "boolean" && typeof value === "boolean") || (type === "object" && isPlainDataObject(value)) || (type === "destination_selector" && isDestinationSelector(value)) || (type === "destination_arrival" && isDestinationArrival(value)); }
function isDestinationSelector(value) {
  return isPlainDataObject(value)
    && ((value.kind === "label" && typeof value.label === "string" && value.label.length >= 1 && value.label.length <= 128 && value.ref === undefined)
      || (value.kind === "ref" && typeof value.ref === "string" && /^dr1_[A-Za-z0-9_-]{21}[AQgw]$/.test(value.ref) && value.label === undefined));
}
function isDestinationArrival(value) {
  return isPlainDataObject(value)
    && (value.reason === "destination_arrived" || value.reason === "already_at_destination")
    && isPlainDataObject(value.destination)
    && typeof value.destination.label === "string"
    && value.destination.label.length >= 1
    && value.destination.label.length <= 128;
}
function isScalarFactType(type) { return type === "string" || type === "integer" || type === "boolean"; }
function declaredOutputFactType(descriptor, fact) {
  const outputFacts = descriptor?.outputFacts;
  if (!isPlainDataObject(outputFacts) || !isIdentifier(fact) || !Object.hasOwn(outputFacts, fact)) return null;
  return outputFacts[fact];
}
function findForbidden(value, path, add) {
  const visited = new WeakSet();
  const visit = (node, currentPath, depth) => {
    if (!node || typeof node !== "object" || visited.has(node) || depth > PROGRAM_LIMITS.maxJsonDepth) return;
    visited.add(node);
    for (const [key, child] of Object.entries(node)) {
      const childPath = `${currentPath}/${escapePointer(key)}`;
      if (FORBIDDEN_FIELDS.has(key)) add("forbidden_raw_resource_field", childPath, null, "Candidate resource, lock, lease, owner, or acquire/release fields are forbidden.");
      visit(child, childPath, depth + 1);
    }
  };
  visit(value, path, 0);
}
function escapePointer(value) { return value.replaceAll("~", "~0").replaceAll("/", "~1"); }
function readDescriptorRevision(descriptors) {
  try {
    if (descriptors === null || (typeof descriptors !== "object" && typeof descriptors !== "function")) return null;
    const descriptor = Object.getOwnPropertyDescriptor(descriptors, "catalogRevision");
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
    return Number.isSafeInteger(descriptor.value) && descriptor.value >= 0 ? descriptor.value : null;
  } catch {
    return null;
  }
}
function report(program, descriptorRevision, diagnostics) {
  diagnostics.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code) || String(a.nodeId).localeCompare(String(b.nodeId)));
  if (diagnostics.length > PROGRAM_LIMITS.maxDiagnostics) diagnostics.splice(PROGRAM_LIMITS.maxDiagnostics, Infinity, { severity: "error", code: "diagnostics_truncated", nodeId: null, path: "", message: "Diagnostics were truncated." });
  const accepted = diagnostics.length === 0;
  return deepFreeze({
    accepted,
    descriptorRevision,
    normalizedProgram: accepted ? structuredClone(program) : null,
    diagnostics,
    runtimeRequirements: ["fresh_mod_admission", "descriptor_derived_resources", "live_postcondition", "stop_epoch"],
  });
}

/** Canonical JSON round-trip guard: the program must be exactly representable as plain JSON data. */
function canonicalRoundTrips(value, encoded) {
  try {
    return samePlainValue(value, JSON.parse(encoded));
  } catch {
    return false;
  }
}
function samePlainValue(left, right) {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    const length = left.length;
    if (!canonicalArrayKeys(left, length) || !canonicalArrayKeys(right, length)) return false;
    for (let index = 0; index < length; index += 1) if (!samePlainValue(left[index], right[index])) return false;
    return true;
  }
  if (left === null || typeof left !== "object") return left === right;
  if (right === null || typeof right !== "object" || Array.isArray(right)) return false;
  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  const rightSet = new Set(rightKeys);
  return leftKeys.every((key) => typeof key === "string" && rightSet.has(key) && samePlainValue(left[key], right[key]));
}
function canonicalArrayKeys(value, length) {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1) return false;
  for (let index = 0; index < length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, String(index))) return false;
  }
  return keys.every((key) => key === "length"
    || (typeof key === "string" && isArrayIndexKey(key) && Number(key) < length));
}
function isArrayIndexKey(key) {
  if (typeof key !== "string" || key === "") return false;
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < 2 ** 32 - 1 && String(index) === key;
}
