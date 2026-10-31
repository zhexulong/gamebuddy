import { join } from "node:path";

import { atomicWriteFile } from "../path-lock.js";

/**
 * The player's choice of which companion this installation plays, written for the launcher
 * to apply at the next launch.
 *
 * **Why the Host writes a request instead of switching.** The companion in play is the
 * deployment identity's `companionId`, and the semantic authority binds its database to that
 * one principal: `production_bootstrap.companion_id`, `production_partition.companion_id` and
 * the authority marker all have to match, or the Host refuses the root with
 * `production_store_identity_mismatch`. That identity is therefore the launcher's to change -
 * `desktop/GameBuddy.Desktop/DeploymentIdentity.cs` is its one authority - and this Host would
 * be a second one if it wrote it.
 *
 * So the division is: the Host records which companion it read as in play and which one the
 * player chose; the launcher parks the authority root that is in play, brings the chosen
 * companion's back, and replaces the identity record. Everything else already partitions per
 * companion by itself, because `contexts/<identityKey>`, the tavern companion roots and each
 * companion's Magic Context store all hang off `identityKey(playerId, companionId, continuityId)`.
 *
 * **Why a request is a real step rather than a deferred wish.** A restart is genuinely required
 * - the manifest is read at Host boot - so the surface can say so truthfully, and it can show
 * the player the state that makes it a step: her name, chosen, waiting for the next launch.
 * That is the fact this record exists to make true.
 */
export const COMPANION_SWITCH_REQUEST_SCHEMA = "gamebuddy-companion-switch-request/v1" as const;

/**
 * The one file, at the durable root beside the deployment identity it is about, so the
 * launcher reads and repairs the two together.
 *
 * The name and the key set are mirrored by `desktop/GameBuddy.Desktop/CompanionSwitch.cs`.
 * They are one fact with two readers, so a drift is a refusal on the launcher side rather than
 * a quiet degrade: `companion-switch-record-shape.test.ts` compares the two sources.
 */
export const COMPANION_SWITCH_REQUEST_FILE_NAME = "companion-switch-request.json" as const;

/** The exact key set both sides require. One spelling, asserted by the cross-language test. */
export const COMPANION_SWITCH_REQUEST_KEYS = [
  "schemaVersion",
  "requestId",
  "status",
  "expectedActiveCompanionId",
  "targetCompanionId",
  "targetContinuityId",
] as const;

/** `requested` is the only status the Host writes; a settled request is the launcher's to clear. */
export const COMPANION_SWITCH_REQUESTED_STATUS = "requested" as const;

/**
 * The bounded identifier shape the deployment manifest, the semantic store and the authority
 * marker all enforce. A value outside it could never name a companion to the launcher.
 */
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;

export type CompanionSwitchRequest = Readonly<{
  schemaVersion: typeof COMPANION_SWITCH_REQUEST_SCHEMA;
  requestId: string;
  status: typeof COMPANION_SWITCH_REQUESTED_STATUS;
  /** The companion the surface read as in play: the compare-and-set this request is about. */
  expectedActiveCompanionId: string;
  /** The companion the player chose. */
  targetCompanionId: string;
  /** The target's own continuity, from her library record - the launcher never invents one. */
  targetContinuityId: string;
}>;

export function companionSwitchRequestPath(runtimeRoot: string): string {
  return join(runtimeRoot, COMPANION_SWITCH_REQUEST_FILE_NAME);
}

export function createCompanionSwitchRequest(
  input: Readonly<{
    requestId: string;
    expectedActiveCompanionId: string;
    targetCompanionId: string;
    targetContinuityId: string;
  }>,
): CompanionSwitchRequest {
  for (const value of [
    input.requestId,
    input.expectedActiveCompanionId,
    input.targetCompanionId,
    input.targetContinuityId,
  ])
    if (!IDENTIFIER.test(value)) throw new Error("invalid_companion_switch_request");
  // A switch to the companion who is already in play is not a switch. It is refused here
  // rather than written, because the launcher would have to either apply a no-op (which would
  // park and restore her for nothing) or refuse a request the player was told had succeeded.
  if (input.expectedActiveCompanionId === input.targetCompanionId) throw new Error("companion_switch_already_in_play");
  return Object.freeze({
    schemaVersion: COMPANION_SWITCH_REQUEST_SCHEMA,
    requestId: input.requestId,
    status: COMPANION_SWITCH_REQUESTED_STATUS,
    expectedActiveCompanionId: input.expectedActiveCompanionId,
    targetCompanionId: input.targetCompanionId,
    targetContinuityId: input.targetContinuityId,
  });
}

/**
 * Writes the request atomically at the exact path the launcher reads.
 *
 * It replaces a previous request rather than refusing to write beside one: the player may
 * change their mind before restarting, and the last choice is the one they will launch with.
 * A request the launcher already applied is gone by then, so this is the only window in which
 * two writes can arrive - and the later one is the player's answer.
 */
export async function writeCompanionSwitchRequest(runtimeRoot: string, request: CompanionSwitchRequest): Promise<void> {
  await atomicWriteFile(companionSwitchRequestPath(runtimeRoot), JSON.stringify(request));
}
