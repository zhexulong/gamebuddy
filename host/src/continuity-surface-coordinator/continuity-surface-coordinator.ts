import { withContinuitySurfaceTransitionLock } from "../continuity-transition-lock.js";

/**
 * The sole Host capability for a cross-surface durable transition. Its
 * callback is intentionally non-reentrant: operations invoked from it must
 * use their local stores directly rather than acquire this coordinator again.
 */
export type ContinuitySurfaceCoordinator = Readonly<{
  withTransition<T>(continuityId: string, work: () => Promise<T>): Promise<T>;
}>;

export function createContinuitySurfaceCoordinator(runtimeRoot: string): ContinuitySurfaceCoordinator {
  // Reentrancy is isolated by continuity partition: independent companions
  // may transition concurrently, while a partition can never reacquire itself.
  const heldPartitions = new Set<string>();
  return Object.freeze({
    async withTransition<T>(continuityId: string, work: () => Promise<T>): Promise<T> {
      if (heldPartitions.has(continuityId)) throw new Error("continuity_surface_transition_reentrant");
      return withContinuitySurfaceTransitionLock(runtimeRoot, continuityId, async () => {
        if (heldPartitions.has(continuityId)) throw new Error("continuity_surface_transition_reentrant");
        heldPartitions.add(continuityId);
        try {
          return await work();
        } finally {
          heldPartitions.delete(continuityId);
        }
      });
    },
  });
}
