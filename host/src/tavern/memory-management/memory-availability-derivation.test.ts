import assert from "node:assert/strict";
import test from "node:test";

import { composeTavernProfile, TavernBrowserContractV1 } from "../browser-contract/index.js";

import type { MemoryManagementService } from "./memory-management.js";
import {
  MEMORY_STATE_UNAVAILABLE_CAUSES,
  MEMORY_STATE_UNAVAILABLE_OWNERS,
  type MemoryStateProjectionV1,
  projectMemoryStateV1,
} from "./memory-state-projection.js";

/**
 * Every `*Available` boolean the state snapshot publishes must be a reading, not a constant.
 *
 * The defect this gate exists for: three of the four snapshot producers wrote
 * `{ readAvailable: false, mutationAvailable: false, projectionRevision: null }` as a literal, so the
 * Memory surface had to treat a served read route as the capability to draw its authoring form, and
 * the live run of `v-injection-claims` printed `memory.read=false memory.mutate=false` beside a
 * Memory route that answered 200 with rows.
 *
 * The population is derived from the contract's own snapshot schema, so a field added later is
 * examined without anyone remembering to list it. The verdict comes from driving the real projection
 * under mounts that genuinely differ: a field that reads the same value on every mount is not
 * projecting anything, which is exactly what a literal does.
 */

/** The suffix that makes a snapshot member a capability flag. */
const AVAILABILITY_FIELD = /Available$/;

/** The revision the stub Memory route answers, distinguishable from any literal a producer could write. */
const MEMORY_ROUTE_REVISION = `${"R".repeat(42)}A`;

type Mount = Readonly<{
  label: string;
  profile: Parameters<typeof projectMemoryStateV1>[0];
  service?: MemoryManagementService;
}>;

function memoryService(options: Readonly<{ mutate: boolean; readFails?: boolean }>): MemoryManagementService {
  const read = async () => {
    if (options.readFails === true) throw new Error("memory_store_unavailable");
    return Object.freeze({
      apiVersion: 1 as const,
      projectionRevision: MEMORY_ROUTE_REVISION,
      memories: Object.freeze([]),
      chapters: Object.freeze([]),
    });
  };
  return Object.freeze({
    read,
    ...(options.mutate ? { mutate: async () => await read() } : {}),
    close: async () => undefined,
  });
}

const chatOnlyProfile = composeTavernProfile({
  profileId: "gamebuddy.chat-core.reference-pipeline",
  releaseTier: "chat_core",
  routeIds: ["state.read"],
  operationIds: [],
  navigationItemIds: ["chat"],
});

const readOnlyProfile = composeTavernProfile({
  profileId: "gamebuddy.tavern-management.memory-read",
  releaseTier: "tavern_management",
  routeIds: ["memory.read"],
  operationIds: [],
  navigationItemIds: ["chat", "memory"],
});

const memoryProfile = composeTavernProfile({
  profileId: "gamebuddy.tavern-management.memory",
  releaseTier: "tavern_management",
  routeIds: ["memory.read", "memory.mutate"],
  operationIds: ["memory.mutate"],
  navigationItemIds: ["chat", "memory"],
});

/** Every `path.to.field` in `schema` whose own name ends in `Available`, through unions and arrays. */
function availabilityFieldPaths(schema: unknown, prefix = "", into = new Set<string>()): string[] {
  if (schema === null || typeof schema !== "object") return [...into].sort();
  const node = schema as Readonly<Record<string, unknown>>;
  const properties = node.properties;
  if (properties !== null && typeof properties === "object") {
    for (const [key, child] of Object.entries(properties as Readonly<Record<string, unknown>>)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      if (AVAILABILITY_FIELD.test(key)) into.add(path);
      availabilityFieldPaths(child, path, into);
    }
  }
  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    const variants = node[keyword];
    if (!Array.isArray(variants)) continue;
    for (const variant of variants) availabilityFieldPaths(variant, prefix, into);
  }
  if (node.items !== undefined) availabilityFieldPaths(node.items, prefix, into);
  return [...into].sort();
}

/** The value a dotted path names, or `undefined` when the snapshot does not carry it. */
function fieldValue(snapshot: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (value === null || typeof value !== "object") return undefined;
    return (value as Readonly<Record<string, unknown>>)[key];
  }, snapshot);
}

/** A snapshot-shaped container holding one projection, so paths are read the way the wire orders them. */
const snapshotOf = (projection: MemoryStateProjectionV1) => ({ memory: projection.state });

test("every *Available boolean on the state snapshot is a reading, not a constant", async (t) => {
  const population = availabilityFieldPaths(TavernBrowserContractV1.schemas.TavernStateSnapshotV1Schema);
  t.diagnostic(
    `population: ${population.length} *Available field(s) on TavernStateSnapshotV1 - ${population.join(", ")}`,
  );
  // Zero population is blocked, not green: a schema this walker cannot read and a schema with no
  // flags are the same silence, and neither is evidence that the flags are honest.
  assert.notEqual(
    population.length,
    0,
    "blocked: TavernStateSnapshotV1Schema names no *Available field, so this gate examined nothing",
  );

  const mounts: readonly Mount[] = [
    { label: "no memory route on this origin", profile: chatOnlyProfile },
    {
      label: "memory.read served, durable read failed",
      profile: readOnlyProfile,
      service: memoryService({ mutate: false, readFails: true }),
    },
    { label: "memory.read served, mutation not", profile: readOnlyProfile, service: memoryService({ mutate: false }) },
    { label: "memory.read and memory.mutate served", profile: memoryProfile, service: memoryService({ mutate: true }) },
  ];
  const projections: MemoryStateProjectionV1[] = [];
  for (const mount of mounts) {
    const projection = await projectMemoryStateV1(mount.profile, mount.service);
    projections.push(projection);
    t.diagnostic(`${mount.label}: ${JSON.stringify(projection.state)} cause=${projection.unavailableCause ?? "none"}`);
  }

  // The differential that a literal cannot survive: each flag has to take BOTH values across mounts
  // that really differ, so a producer that stopped asking the route fails here by field name.
  for (const path of population) {
    const readings = projections.map((projection) => fieldValue(snapshotOf(projection), path));
    const distinct = new Set(readings.map((value) => JSON.stringify(value)));
    assert.equal(
      distinct.size > 1,
      true,
      `${path} reads ${JSON.stringify(readings[0])} on every mount (${readings.map((value) => JSON.stringify(value)).join(", ")}), so the snapshot is not projecting the probe that answers it - derive it in host/src/tavern/memory-management/memory-state-projection.ts, and if this field belongs to another subtree, extend the mounts above to drive that subtree's producer`,
    );
  }

  // The flag's revision is the probe's own answer, so a snapshot that says "available" without having
  // read anything is impossible: the contract's true branch requires this exact string.
  const wired = projections[projections.length - 1]!;
  assert.equal(wired.unavailableCause, null);
  assert.deepEqual(wired.state, {
    readAvailable: true,
    mutationAvailable: true,
    projectionRevision: MEMORY_ROUTE_REVISION,
  });

  // Every `false` names which of the closed causes it is, and every cause names its owner. A cause no
  // mount reaches is dead vocabulary; a `false` naming no cause is the defect.
  for (const projection of projections) {
    if (projection.state.readAvailable) {
      assert.equal(projection.unavailableCause, null, "available with a cause, so the two readings disagree");
      continue;
    }
    assert.notEqual(projection.unavailableCause, null, "unavailable without a named cause");
    assert.ok(
      MEMORY_STATE_UNAVAILABLE_CAUSES.includes(projection.unavailableCause!),
      `${String(projection.unavailableCause)} is not in the closed cause vocabulary`,
    );
    assert.notEqual(MEMORY_STATE_UNAVAILABLE_OWNERS[projection.unavailableCause!].trim(), "");
  }
  const reached = new Set(
    projections.map((projection) => projection.unavailableCause).filter((cause) => cause !== null),
  );
  assert.deepEqual(
    [...reached].sort(),
    [...MEMORY_STATE_UNAVAILABLE_CAUSES].sort(),
    "a cause no mount reaches, or one reached that is not declared",
  );
});
