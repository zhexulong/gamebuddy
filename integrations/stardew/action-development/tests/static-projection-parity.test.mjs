import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  PROJECTION_PARITY_ABSENT_ROUTE_TOKENS,
  PROJECTION_PARITY_ADMITTED_LIFECYCLES,
  PROJECTION_PARITY_ENVELOPE_KEYS,
  PROJECTION_PARITY_FIXED_PROTOCOL_CONTROLS,
  PROJECTION_PARITY_GAME_ID,
  PROJECTION_PARITY_GUARD_ORDER,
  PROJECTION_PARITY_KINDS,
  PROJECTION_PARITY_SCHEMA,
  PROJECTION_PARITY_SURFACE_SCHEMA,
  parseActionProjectionParity,
  validateActionProjectionParity,
} from "../src/static-projection/action-projection-parity.mjs";

const SNAPSHOT_RELATIVE_PATH = "contracts/projection/action-projection-parity.v1.json";
const directory = path.dirname(fileURLToPath(import.meta.url));
const packageDirectory = path.dirname(directory);
const paritySourcePath = path.join(packageDirectory, "src", "static-projection", "action-projection-parity.mjs");

async function loadSnapshot() {
  const text = await readFile(path.join(packageDirectory, SNAPSHOT_RELATIVE_PATH), "utf8");
  return { text, snapshot: JSON.parse(text) };
}

function fails(code, callback) {
  assert.throws(callback, new RegExp(`stardew_projection_parity_${code}`));
}

function clone(snapshot) {
  return structuredClone(snapshot);
}

test("accepts the checked-in versioned parity snapshot and returns an immutable consumer view", async () => {
  const { text, snapshot } = await loadSnapshot();
  const validated = validateActionProjectionParity(snapshot);
  assert.equal(validated.schema, PROJECTION_PARITY_SCHEMA);
  assert.equal(validated.developmentOnly, true);
  assert.equal(validated.gameId, PROJECTION_PARITY_GAME_ID);
  assert.equal(validated.surface.schema, PROJECTION_PARITY_SURFACE_SCHEMA);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.surface), true);
  assert.equal(Object.isFrozen(validated.surface.registrations), true);
  assert.equal(Object.isFrozen(validated.surface.registrations[0]), true);

  const parsed = parseActionProjectionParity(text);
  assert.equal(parsed.schema, PROJECTION_PARITY_SCHEMA);
  assert.equal(parsed.lifecycle.admittedLifecycles.length, PROJECTION_PARITY_ADMITTED_LIFECYCLES.length);
});

test("preserves registration identity/lifecycle/kind and the published-vs-withdrawn partition", async () => {
  const { snapshot } = await loadSnapshot();
  const validated = validateActionProjectionParity(snapshot);
  const byId = new Map(validated.surface.registrations.map((registration) => [registration.actionId, registration]));

  for (const registration of validated.surface.registrations) {
    assert.equal(typeof registration.actionId, "string");
    assert.ok(Number.isSafeInteger(registration.identityVersion) && registration.identityVersion >= 1);
    assert.ok(PROJECTION_PARITY_ADMITTED_LIFECYCLES.includes(registration.lifecycle));
    assert.ok(PROJECTION_PARITY_KINDS.includes(registration.kind));
  }

  const executable = new Set(validated.lifecycle.executableActionIds);
  for (const actionId of executable) {
    assert.equal(byId.get(actionId).lifecycle, "published");
    assert.equal(byId.get(actionId).kind, "execution");
  }
  for (const actionId of validated.lifecycle.readOnlyActionIds) {
    assert.equal(byId.get(actionId).lifecycle, "published");
    assert.equal(byId.get(actionId).kind, "read_only");
  }
  for (const actionId of validated.lifecycle.experimentalActionIds) {
    assert.equal(byId.get(actionId).lifecycle, "experimental");
  }
  assert.ok(validated.lifecycle.experimentalActionIds.length > 0);

  const partition = new Set([
    ...validated.lifecycle.executableActionIds,
    ...validated.lifecycle.readOnlyActionIds,
    ...validated.lifecycle.experimentalActionIds,
  ]);
  assert.equal(partition.size, validated.surface.registrations.length);
  for (const registration of validated.surface.registrations) {
    assert.ok(partition.has(registration.actionId));
  }

  const native = new Set(validated.ownership.nativeActionIds);
  const local = new Set(validated.ownership.localFixtureOwnedActionIds);
  for (const actionId of executable) {
    if (!native.has(actionId) && !local.has(actionId)) assert.fail(`unowned executable: ${actionId}`);
  }
  for (const actionId of local) assert.ok(executable.has(actionId), `widened local ownership: ${actionId}`);
});

test("protocol union, fixed controls, guard order, and absent routes are pinned versioned facts", async () => {
  const { snapshot } = await loadSnapshot();
  const validated = validateActionProjectionParity(snapshot);

  assert.deepEqual(validated.protocol.schemas, [...validated.protocol.schemas].sort());
  assert.deepEqual(validated.protocol.fixedControls, PROJECTION_PARITY_FIXED_PROTOCOL_CONTROLS);
  for (const controlId of PROJECTION_PARITY_FIXED_PROTOCOL_CONTROLS) {
    assert.equal(validated.surface.registrations.some((registration) => registration.actionId === controlId), false);
  }

  assert.deepEqual(validated.guardOrder, PROJECTION_PARITY_GUARD_ORDER);
  assert.equal(new Set(PROJECTION_PARITY_GUARD_ORDER).size, PROJECTION_PARITY_GUARD_ORDER.length);
  assert.deepEqual(validated.absentRoutes, PROJECTION_PARITY_ABSENT_ROUTE_TOKENS);

  for (const token of PROJECTION_PARITY_ABSENT_ROUTE_TOKENS) {
    assert.equal(snapshot.surface.registrations.some((registration) => registration.lifecycle === token), false);
  }
});

test("rejects envelope, registration, and lifecycle drift with exact codes", async () => {
  const { snapshot } = await loadSnapshot();

  const wrongSchema = clone(snapshot);
  wrongSchema.schema = "wrong/v1";
  fails("invalid_schema", () => validateActionProjectionParity(wrongSchema));

  const notDevOnly = clone(snapshot);
  notDevOnly.developmentOnly = false;
  fails("invalid_scope", () => validateActionProjectionParity(notDevOnly));

  const wrongGameId = clone(snapshot);
  wrongGameId.gameId = "other";
  fails("invalid_game_id", () => validateActionProjectionParity(wrongGameId));

  const extraKey = clone(snapshot);
  extraKey.extra = true;
  fails("invalid_envelope_shape", () => validateActionProjectionParity(extraKey));

  const badRegistrationKey = clone(snapshot);
  badRegistrationKey.surface.registrations[0].extra = "x";
  fails("invalid_registration_shape", () => validateActionProjectionParity(badRegistrationKey));

  const duplicateId = clone(snapshot);
  duplicateId.surface.registrations[1].actionId = duplicateId.surface.registrations[0].actionId;
  fails("duplicate_action_id", () => validateActionProjectionParity(duplicateId));

  const zeroVersion = clone(snapshot);
  zeroVersion.surface.registrations[0].identityVersion = 0;
  fails("invalid_identity_version", () => validateActionProjectionParity(zeroVersion));

  const withdrawnLifecycle = clone(snapshot);
  withdrawnLifecycle.surface.registrations[0].lifecycle = "withdrawn";
  fails("invalid_lifecycle", () => validateActionProjectionParity(withdrawnLifecycle));

  const wrongKind = clone(snapshot);
  wrongKind.surface.registrations[0].kind = "mutation";
  fails("invalid_kind", () => validateActionProjectionParity(wrongKind));

  const admittedExpanded = clone(snapshot);
  admittedExpanded.lifecycle.admittedLifecycles = ["published", "experimental", "withdrawn"];
  fails("invalid_admitted_lifecycles", () => validateActionProjectionParity(admittedExpanded));

  const droppedFromPartition = clone(snapshot);
  droppedFromPartition.lifecycle.executableActionIds = droppedFromPartition.lifecycle.executableActionIds.slice(1);
  fails("lifecycle_partition_mismatch", () => validateActionProjectionParity(droppedFromPartition));

  const overlap = clone(snapshot);
  overlap.lifecycle.readOnlyActionIds = [...overlap.lifecycle.readOnlyActionIds, overlap.lifecycle.executableActionIds[0]];
  fails("lifecycle_overlap", () => validateActionProjectionParity(overlap));

  const executableViolation = clone(snapshot);
  const vulnerable = executableViolation.surface.registrations.find((registration) => registration.actionId === "equip_tool");
  vulnerable.kind = "read_only";
  fails("executable_subset_invalid", () => validateActionProjectionParity(executableViolation));

  const readonlyViolation = clone(snapshot);
  const vulnerableReadOnly = readonlyViolation.surface.registrations.find((registration) => registration.actionId === "inspect_world_map");
  vulnerableReadOnly.kind = "execution";
  fails("readonly_subset_invalid", () => validateActionProjectionParity(readonlyViolation));

  const experimentalViolation = clone(snapshot);
  const vulnerableExperimental = experimentalViolation.surface.registrations.find((registration) => registration.actionId === "clear_debris");
  vulnerableExperimental.lifecycle = "published";
  fails("experimental_subset_invalid", () => validateActionProjectionParity(experimentalViolation));
});

test("rejects protocol, ownership, guard-order, and absence drift with exact codes", async () => {
  const { snapshot } = await loadSnapshot();

  const unsortedSchemas = clone(snapshot);
  unsortedSchemas.protocol.schemas = [...unsortedSchemas.protocol.schemas].reverse();
  fails("protocol_union_unsorted", () => validateActionProjectionParity(unsortedSchemas));

  const missingControl = clone(snapshot);
  missingControl.protocol.fixedControls = missingControl.protocol.fixedControls.slice(1);
  fails("invalid_fixed_controls", () => validateActionProjectionParity(missingControl));

  const controlRegistered = clone(snapshot);
  controlRegistered.surface.registrations.push({
    actionId: "inspect_self",
    familyId: "protocol",
    identityVersion: 1,
    lifecycle: "published",
    kind: "read_only",
  });
  controlRegistered.lifecycle.readOnlyActionIds = [...controlRegistered.lifecycle.readOnlyActionIds, "inspect_self"];
  fails("control_in_surface", () => validateActionProjectionParity(controlRegistered));

  const widenedLocal = clone(snapshot);
  widenedLocal.ownership.localFixtureOwnedActionIds = [
    ...widenedLocal.ownership.localFixtureOwnedActionIds,
    "inspect_world_map",
  ];
  fails("local_ownership_widened", () => validateActionProjectionParity(widenedLocal));

  const overlappedLocal = clone(snapshot);
  overlappedLocal.ownership.localFixtureOwnedActionIds = [
    ...overlappedLocal.ownership.localFixtureOwnedActionIds,
    "travel",
  ];
  fails("ownership_overlap", () => validateActionProjectionParity(overlappedLocal));

  const partitionBreak = clone(snapshot);
  partitionBreak.ownership.nativeActionIds = partitionBreak.ownership.nativeActionIds.filter((actionId) => actionId !== "travel");
  fails("ownership_partition_mismatch", () => validateActionProjectionParity(partitionBreak));

  const escapingFixture = clone(snapshot);
  escapingFixture.fixtureOwnedFiles = ["tests/fixtures/../escape.json"];
  fails("invalid_envelope_shape", () => validateActionProjectionParity(escapingFixture));

  const reorderedGuards = clone(snapshot);
  reorderedGuards.guardOrder = [...reorderedGuards.guardOrder].reverse();
  fails("guard_order_drift", () => validateActionProjectionParity(reorderedGuards));

  const missingToken = clone(snapshot);
  missingToken.absentRoutes = missingToken.absentRoutes.slice(1);
  fails("obsolete_route_drift", () => validateActionProjectionParity(missingToken));

  const tokenInValue = clone(snapshot);
  const vulnerable = tokenInValue.surface.registrations.find((registration) => registration.actionId === "equip_tool");
  vulnerable.familyId = "legacy_movement";
  fails("obsolete_route_present", () => validateActionProjectionParity(tokenInValue));
});

test("rejects non-plain inputs, malformed text, and oversized text", async () => {
  const { text } = await loadSnapshot();
  fails("invalid_envelope", () => validateActionProjectionParity(Object.create(null)));
  fails("invalid_envelope", () => validateActionProjectionParity(new Date(0)));
  fails("invalid_data", () => validateActionProjectionParity(new Proxy(JSON.parse(text), {})));
  fails("invalid_json", () => validateActionProjectionParity("{"));
  fails("duplicate_key", () => validateActionProjectionParity(
    '{"schema":"gamebuddy-stardew-action-projection-parity/v1","developmentOnly":true,"gameId":"stardew","surface":{"schema":"gamebuddy-stardew-action-surface/v1","registrations":[],"registrations":[]},"lifecycle":{"admittedLifecycles":["published","experimental"],"executableActionIds":["x"],"readOnlyActionIds":["y"],"experimentalActionIds":["z"]},"protocol":{"schemas":["a/v1"],"fixedControls":["inspect_self","cancel_active_execution"]},"ownership":{"localFixtureOwnedActionIds":["x"],"nativeActionIds":["y"]},"fixtureOwnedFiles":["tests/fixtures/a.json"],"guardOrder":["schema","development_scope","game_id","envelope_shape","surface_registrations","lifecycle_partition","surface_subsets","protocol_union","protocol_controls","ownership_partition","guard_order_pinned","obsolete_route_absence"],"absentRoutes":["adoption","dual_read","fallback","legacy","migration","read_repair","withdrawn"]}',
  ));
  const oversized = JSON.stringify({ ...JSON.parse(text), extra: "x".repeat(40 * 1024) });
  fails("bounds", () => validateActionProjectionParity(oversized));
});

test("parity checker is a package-local strict consumer with no producer or root boundary", async () => {
  const source = await readFile(paritySourcePath, "utf8");
  assert.doesNotMatch(source, /(?:from|import)\s+["']/);
  assert.doesNotMatch(source, /\b(?:readFile|readdir|writeFile|lstat|realpath|spawn)\b|(?:^|[^.\w])exec\s*\(/);
  assert.doesNotMatch(source, /(?:from|import)\s+["'][^"']*(?:host|mod|bridge|runtime|producer|tools)[^"']*["']/i);
  assert.equal(PROJECTION_PARITY_ENVELOPE_KEYS.includes("absentRoutes"), true);
  assert.ok(PROJECTION_PARITY_GUARD_ORDER.length >= 12);
});