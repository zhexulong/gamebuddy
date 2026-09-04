import {
  ACTION_PROGRAM_SCHEMA, BINDING_KEYS, EDGE_KEYS, GUARD_KEYS, NODE_KEYS, PROGRAM_KEYS,
  PROGRAM_LIMITS, hasExactKeys, isPlainDataObject, jsonDepth, utf8Bytes,
} from "./model.mjs";
import { descriptorMap } from "./descriptors.mjs";

const FORBIDDEN_FIELDS = new Set(["resources", "locks", "claimMode", "lease", "leases", "owner", "owners", "acquire", "release"]);
const ID = /^[a-z][a-z0-9_]{1,127}$/;

/** Pure, descriptor-constrained validation. It neither accesses world state nor grants execution authority. */
export function verifyActionProgram({ program, descriptors, restrictivePolicy }) {
  const diagnostics = [];
  const add = (code, path, nodeId = null, message = code) => diagnostics.push({ severity: "error", code, nodeId, path, message: message.slice(0, 256) });
  const catalog = descriptorMap(descriptors);
  if (!catalog) {
    add("invalid_descriptor_projection", "/descriptors", null, "Descriptor projection is not a valid authoritative v1 projection.");
    return report(program, descriptors, diagnostics);
  }
  if (!isPlainDataObject(restrictivePolicy) || !Array.isArray(restrictivePolicy.enabledActionIds)
    || !restrictivePolicy.enabledActionIds.every((id) => typeof id === "string")) {
    add("invalid_restrictive_policy", "/restrictivePolicy", null, "Restrictive policy must provide enabledActionIds.");
  }
  const enabled = new Set(restrictivePolicy?.enabledActionIds ?? []);
  if (!hasExactKeys(program, PROGRAM_KEYS)) {
    findForbidden(program, "", add);
    add("invalid_program_shape", "", null, "Program must contain exactly schema, programId, nodes, and edges.");
    return report(program, descriptors, diagnostics);
  }
  if (program.schema !== ACTION_PROGRAM_SCHEMA) add("invalid_program_schema", "/schema", null, "Program schema must be gamebuddy-action-program/v1.");
  if (typeof program.programId !== "string" || !ID.test(program.programId)) add("invalid_program_id", "/programId", null, "programId must be a bounded identifier.");
  if (utf8Bytes(program) > PROGRAM_LIMITS.maxUtf8Bytes) add("program_too_large", "", null, "Program exceeds the canonical UTF-8 byte limit.");
  if (jsonDepth(program) > PROGRAM_LIMITS.maxJsonDepth) add("json_too_deep", "", null, "Program exceeds the JSON depth limit.");
  findForbidden(program, "", add);
  if (!Array.isArray(program.nodes) || program.nodes.length > PROGRAM_LIMITS.maxNodes) add("invalid_node_bounds", "/nodes", null, "nodes must be an array within the v1 limit.");
  if (!Array.isArray(program.edges) || program.edges.length > PROGRAM_LIMITS.maxEdges) add("invalid_edge_bounds", "/edges", null, "edges must be an array within the v1 limit.");
  if (!Array.isArray(program.nodes) || !Array.isArray(program.edges)) return report(program, descriptors, diagnostics);

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
  return report(program, descriptors, diagnostics);
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
    const fact = catalog?.get(producer?.node.actionId)?.outputFacts[binding.fact];
    if (!fact || fact !== descriptor.argumentSchema[binding.arg]?.type) add("binding_type_mismatch", path, node.nodeId, "Binding fact must be declared and type-compatible.");
  }
  if (validArgs) {
    const actual = Object.keys(node.args);
    if (actual.some((arg) => !expected.includes(arg)) || expected.some((arg) => !actual.includes(arg) && !bindingArgs.has(arg))) add("argument_schema_mismatch", `/nodes/${index}/args`, node.nodeId, "Arguments plus bindings must exactly satisfy the descriptor schema.");
    for (const [arg, value] of Object.entries(node.args)) if (descriptor.argumentSchema[arg] && !matchesType(value, descriptor.argumentSchema[arg].type)) add("argument_type_mismatch", `/nodes/${index}/args/${escapePointer(arg)}`, node.nodeId, "Argument does not match the descriptor type.");
  }
  for (let i = 0; validGuards && i < node.guards.length; i += 1) {
    const guard = node.guards[i]; const path = `/nodes/${index}/guards/${i}`;
    if (!hasExactKeys(guard, GUARD_KEYS) || !["fact_present", "fact_equals", "node_succeeded"].includes(guard.kind) || typeof guard.nodeId !== "string") { add("invalid_guard", path, node.nodeId, "Guard is not a finite v1 guard."); continue; }
    const producer = nodes.get(guard.nodeId);
    const producerDescriptor = catalog?.get(producer?.node.actionId);
    const factType = typeof guard.fact === "string" ? producerDescriptor?.outputFacts[guard.fact] : null;
    if (!producer || (guard.kind !== "node_succeeded" && !factType) || (guard.kind === "fact_equals" && !matchesType(guard.value, factType)) || (guard.kind !== "fact_equals" && guard.value !== null) || !reachable(guard.nodeId, node.nodeId, adjacency)) add("invalid_guard", path, node.nodeId, "Guard must reference a dominant declared fact or terminal node state.");
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
function matchesType(value, type) { return (type === "string" && typeof value === "string") || (type === "integer" && Number.isSafeInteger(value)) || (type === "boolean" && typeof value === "boolean") || (type === "object" && isPlainDataObject(value)); }
function findForbidden(value, path, add) { if (!value || typeof value !== "object") return; for (const [key, child] of Object.entries(value)) { const childPath = `${path}/${escapePointer(key)}`; if (FORBIDDEN_FIELDS.has(key)) add("forbidden_raw_resource_field", childPath, null, "Candidate resource, lock, lease, owner, or acquire/release fields are forbidden."); findForbidden(child, childPath, add); } }
function escapePointer(value) { return value.replaceAll("~", "~0").replaceAll("/", "~1"); }
function report(program, descriptors, diagnostics) { diagnostics.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code) || String(a.nodeId).localeCompare(String(b.nodeId))); if (diagnostics.length > PROGRAM_LIMITS.maxDiagnostics) diagnostics.splice(PROGRAM_LIMITS.maxDiagnostics, Infinity, { severity: "error", code: "diagnostics_truncated", nodeId: null, path: "", message: "Diagnostics were truncated." }); return Object.freeze({ accepted: diagnostics.length === 0, catalogRevision: descriptors?.catalogRevision ?? null, normalizedProgram: diagnostics.length === 0 ? structuredClone(program) : null, diagnostics, runtimeRequirements: ["fresh_mod_admission", "descriptor_derived_resources", "live_postcondition", "stop_epoch"] }); }
