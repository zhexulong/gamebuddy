import type { ComposedTavernProfile, TavernStateSnapshotV1 } from "../browser-contract/index.js";

import type { MemoryManagementService } from "./memory-management.js";

/**
 * The snapshot's `memory` capability, projected from the route that answers it.
 *
 * `GET /api/tavern/v1/memory` and this projection must agree, because the browser cannot use a
 * flag that disagrees with the route beside it: while three of the four snapshot producers wrote
 * the literal `{ readAvailable: false, mutationAvailable: false, projectionRevision: null }`, the
 * Memory surface had to treat a served read route as the capability and draw its authoring form
 * anyway, and a `false` that meant "no Memory on this origin", "the service was never injected"
 * and "the durable read just failed" was one indistinguishable value. The live run of
 * `v-injection-claims` printed `memory.read=false memory.mutate=false` from the snapshot and a
 * 200 with rows from the route in the same breath.
 *
 * The probe is `MemoryManagementService.read()` - the same call the route makes: two vendored
 * SQLite list reads (`listMemories`, `listChapters`) and the HMAC projection revision over them,
 * once per `/state` read. That is the cost of the truth, and it is the price the management
 * snapshot already paid; a constant is not cheaper in any way that matters, because the surface
 * that had to work around it is the one this module exists to delete.
 */

/** Exactly the contract's three members, nothing else: the value is spread into the snapshot. */
export type TavernMemoryStateV1 = TavernStateSnapshotV1["memory"];

const unavailableState: Extract<TavernMemoryStateV1, { readAvailable: false }> = Object.freeze({
  readAvailable: false,
  mutationAvailable: false,
  projectionRevision: null,
});

/**
 * The closed reasons a snapshot may say Memory is unavailable, each with the owner that decides it.
 *
 * A `false` is only honest when it names which of these it is: `no_memory_read_route_on_this_origin`
 * is a mount that serves no Memory surface at all (the frozen reference Chat profile declares no
 * `memory.read`), and `memory_read_probe_failed` is a mounted route whose own durable read failed -
 * the same failure the route would answer with an error. A route declared without the service that
 * answers it is neither: that is a broken composition and throws below.
 */
export const MEMORY_STATE_UNAVAILABLE_CAUSES = Object.freeze([
  "no_memory_read_route_on_this_origin",
  "memory_read_probe_failed",
] as const);

export type MemoryStateUnavailableCause = (typeof MEMORY_STATE_UNAVAILABLE_CAUSES)[number];

export const MEMORY_STATE_UNAVAILABLE_OWNERS: Readonly<Record<MemoryStateUnavailableCause, string>> = Object.freeze({
  no_memory_read_route_on_this_origin:
    "the profiles mounted on this origin - the frozen reference Chat profile declares " +
    "['bootstrap','state.read','draft.read','chat.submit','chat.cancel','chat.submission_status','events'], " +
    "so no GET /api/tavern/v1/memory is served here and there is nothing to read",
  memory_read_probe_failed:
    "MemoryManagementService.read() (host/src/tavern/memory-management/memory-management.ts) - the durable " +
    "listMemories/listChapters read the route itself runs; a failed probe is a route that would answer an " +
    "error, never an empty notebook",
});

export type MemoryStateProjectionV1 = Readonly<{
  state: TavernMemoryStateV1;
  /** `null` when `state.readAvailable` is true, otherwise why not, from the closed vocabulary above. */
  unavailableCause: MemoryStateUnavailableCause | null;
}>;

/**
 * Whether this mount serves `memory.mutate`: the three facts its write route is gated by
 * (`routeId`, `operationId`, and the service method the route row requires).
 */
export function memoryMutationServed(
  profile: ComposedTavernProfile | undefined,
  memoryService: MemoryManagementService | undefined,
): boolean {
  return (
    profile !== undefined &&
    memoryService !== undefined &&
    memoryService.mutate !== undefined &&
    profile.routeIds.includes("memory.mutate") &&
    profile.operationIds.includes("memory.mutate")
  );
}

function unavailable(cause: MemoryStateUnavailableCause): MemoryStateProjectionV1 {
  return Object.freeze({ state: unavailableState, unavailableCause: cause });
}

export async function projectMemoryStateV1(
  profile: ComposedTavernProfile | undefined,
  memoryService: MemoryManagementService | undefined,
): Promise<MemoryStateProjectionV1> {
  if (profile === undefined || !profile.routeIds.includes("memory.read"))
    return unavailable("no_memory_read_route_on_this_origin");
  // A profile that advertises the route without the service that answers it fails closed rather
  // than degrading to "unavailable": the management dispatcher already refuses to mount that
  // combination, so reaching here is a caller that dropped the service, not a capability answer.
  if (memoryService === undefined) throw new Error("memory_read_route_without_service");
  let projectionRevision: string;
  try {
    projectionRevision = (await memoryService.read()).projectionRevision;
  } catch {
    return unavailable("memory_read_probe_failed");
  }
  return Object.freeze({
    state: Object.freeze({
      readAvailable: true as const,
      mutationAvailable: memoryMutationServed(profile, memoryService),
      projectionRevision,
    }),
    unavailableCause: null,
  });
}
