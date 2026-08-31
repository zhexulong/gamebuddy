import { join, resolve } from "node:path";
import { withPathLock } from "./path-lock.js";
import { readStardewGuardianArmBinding } from "./stardew-private-bootstrap-composer.core.js";
import type { StardewGuardianBinding } from "./stardew-private-bootstrap-composer.js";

const OWNER_FILE = "owner.json";
const OPAQUE = /^[A-Za-z0-9_-]{1,128}$/;

export type StardewBootstrapGuardianArmCorrelation = Readonly<{
  runtimeRoot: string;
  bootstrapId: string;
  playerId: string;
  companionId: string;
  expectedRevision: string;
}>;

/**
 * Frozen private transport for the Guardian's authenticated arm ingress.
 * It is intentionally available only inside `consumeArmBinding`; neither this
 * module nor its facade can create processes or persist owner identities.
 */
export type StardewBootstrapGuardianArmBinding = Readonly<StardewGuardianBinding>;

export type StardewBootstrapGuardianPrivateArmBindingFacade = Readonly<{
  consumeArmBinding<T>(
    callback: (binding: StardewBootstrapGuardianArmBinding) => Promise<T> | T,
  ): Promise<T>;
}>;

/**
 * Creates a one-shot, owner-record-bound private arm transport. The exact
 * owner bytes are read and validated while holding the existing owner path
 * lock, immediately before the caller performs its native private ingress.
 */
export function createStardewBootstrapGuardianPrivateArmBindingFacade(
  correlation: StardewBootstrapGuardianArmCorrelation,
): StardewBootstrapGuardianPrivateArmBindingFacade {
  validateCorrelation(correlation);
  const frozenCorrelation = Object.freeze({ ...correlation });
  let consumed = false;

  return Object.freeze({
    async consumeArmBinding<T>(
      callback: (binding: StardewBootstrapGuardianArmBinding) => Promise<T> | T,
    ): Promise<T> {
      if (typeof callback !== "function" || consumed) {
        throw new Error("stardew_bootstrap_guardian_arm_binding_unavailable");
      }
      // Linearize replay before any filesystem or native-facing callback.
      consumed = true;
      const root = resolve(frozenCorrelation.runtimeRoot);
      const ownerPath = join(
        root,
        "stardew-private-bootstrap",
        frozenCorrelation.bootstrapId,
        OWNER_FILE,
      );
      return withPathLock(ownerPath, async () => {
        const binding = await readStardewGuardianArmBinding({
          ownerPath,
          containmentRoot: root,
          bootstrapId: frozenCorrelation.bootstrapId,
          playerId: frozenCorrelation.playerId,
          companionId: frozenCorrelation.companionId,
          expectedRevision: frozenCorrelation.expectedRevision,
          nowMs: Date.now(),
        });
        return callback(binding);
      }, { containmentRoot: root });
    },
  });
}


function validateCorrelation(value: StardewBootstrapGuardianArmCorrelation): void {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["runtimeRoot", "bootstrapId", "playerId", "companionId", "expectedRevision"]) ||
    typeof value.runtimeRoot !== "string" ||
    value.runtimeRoot.length === 0 ||
    !OPAQUE.test(value.bootstrapId) ||
    !OPAQUE.test(value.playerId) ||
    !OPAQUE.test(value.companionId) ||
    !OPAQUE.test(value.expectedRevision)
  ) throw new TypeError("invalid_stardew_bootstrap_guardian_arm_correlation");
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}
