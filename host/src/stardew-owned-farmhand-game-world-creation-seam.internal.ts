import type { StardewAttachmentFlow } from "./stardew-attachment.js";
import type { CreateWorldBindingSeam } from "./stardew-owned-farmhand-game-world-binding-resolver.internal.js";

/**
 * Loop 4 path B' production implementation of the integration-private create
 * seam declared in
 * `stardew-owned-farmhand-game-world-binding-resolver.internal.ts:18-22`.
 *
 * `createWorldBinding` returns exactly one opaque value: the physical save-slot
 * basename the launched Player Host observed for the world the game itself
 * created (`{filteredSaveName}_{Game1.uniqueIDForThisGame}`). The Mod publishes
 * that basename inside the signed join manifest
 * (`FarmhandJoinManifest.ObservedSaveSlot`,
 * integrations/stardew/FarmhandProvisioningModels.cs:142-173; derived at
 * integrations/stardew/HostFarmhandProvisioner.cs:646-702). The coordinator
 * persists the returned ref verbatim; it never names, derives or guesses a slot.
 *
 * Why this seam waits for the manifest instead of deriving a slot itself: the
 * slot is minted by the game from the native save name it assigned, and only the
 * exact launched Player Host can observe it. Reassembling it here - from the
 * staged farm name plus the advertised save id, or from any other manifest field
 * - would be fabrication: a wrong slot is a binding ref that can never be
 * attached, so a create returning one would be a fabricated success. The issued
 * manifest is the only authority for the slot, so the seam waits for it, bounded
 * by the create deadline, and fails closed when it does not arrive.
 *
 * The "exact Player Host for this create has been launched" precondition is
 * structural rather than re-proved here: a usable manifest source only exists
 * over the owner-bound attachment flow, which the composition mints from the
 * staged session material of the owner this lifecycle launched and attested
 * (`stardew-private-bootstrap-composer.core.ts:1896-1923`). The seam therefore
 * adds no second launch authority and no launch/world fact of its own.
 */

/** The one published integration identity owned by this Stardew lifecycle surface. */
const INTEGRATION_ID = "stardew";
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const JOIN_MANIFEST_FILE = "stardew-farmhand-manifest.json";
const DEFAULT_POLL_INTERVAL_MS = 25;

/**
 * Physical save-slot basename shape: the game's filtered save identity plus its
 * unique id. It is the Host reader's own `isObservedSaveSlot`
 * (`stardew-attachment.ts:494-496`), so a path separator, a space, punctuation
 * or a value without the game's unique id can never be persisted as a binding
 * ref.
 */
const OBSERVED_SAVE_SLOT_PATTERN = /^[A-Za-z0-9]{1,64}_[0-9]{1,32}$/;

/**
 * The publication states the Mod passes through on its way to the signed
 * manifest: the file is not there yet, it is being atomically replaced, or the
 * short-lived signed advertisement has not been refreshed yet. It mirrors the
 * attachment flow's own `isTransientManifestPublicationError`
 * (`stardew-attachment.ts:386-392`), which is not exported.
 */
export const STARDEW_WORLD_CREATION_MANIFEST_ABSENT = "stardew_world_creation_manifest_absent";

/**
 * Bounded machine-readable failures. The create path turns every throw into its
 * terminal `unavailable` outcome (never a fabricated success, never a bare
 * `accepted`), so these codes are the only thing a caller may match on.
 */
export const STARDEW_GAME_WORLD_CREATION_MANIFEST_UNAVAILABLE = "stardew_game_world_creation_manifest_unavailable";
export const STARDEW_GAME_WORLD_CREATION_SLOT_MISSING = "stardew_game_world_creation_slot_missing";
export const STARDEW_GAME_WORLD_CREATION_SLOT_INVALID = "stardew_game_world_creation_slot_invalid";
export const STARDEW_GAME_WORLD_CREATION_INTEGRATION_CONFLICT = "stardew_game_create_integration_conflict";

/**
 * One bounded read attempt of the join manifest the exact launched Player Host
 * issued for this world. It resolves with the manifest exactly as the Host
 * received it, before this seam interprets it, and rejects with
 * `STARDEW_WORLD_CREATION_MANIFEST_ABSENT` while the manifest (or the signed
 * advertisement it is verified against) has not been published yet. Any other
 * rejection is a terminal read failure: the seam must not retry it.
 */
export type StardewIssuedJoinManifestSource = Readonly<{
  readIssuedJoinManifest(): Promise<unknown>;
}>;

/**
 * Owner-bound manifest source over the composition's attachment flow
 * (`StardewAttachmentFlow.readIssuedManifest`, `stardew-attachment.ts:286-321`).
 * The flow owns session/token/cabin identity verification and signature
 * verification; this adapter only distinguishes "not published yet" from a
 * terminal read failure. It never writes, repairs or re-signs a manifest.
 */
export function createStardewIssuedJoinManifestSource(
  input: Readonly<{ attachmentFlow: StardewAttachmentFlow; requestId: string }>,
): StardewIssuedJoinManifestSource {
  const flow = input?.attachmentFlow;
  if (
    typeof flow?.readIssuedManifest !== "function" ||
    typeof input?.requestId !== "string" ||
    !SAFE_ID_PATTERN.test(input.requestId)
  )
    throw new Error("invalid_stardew_world_creation_manifest_source");
  const requestId = input.requestId;
  return Object.freeze({
    readIssuedJoinManifest: async (): Promise<unknown> => {
      try {
        return await flow.readIssuedManifest(JOIN_MANIFEST_FILE, requestId);
      } catch (error) {
        if (isUnpublishedManifest(error)) throw new Error(STARDEW_WORLD_CREATION_MANIFEST_ABSENT, { cause: error });
        throw error;
      }
    },
  });
}

/**
 * Integration-private create seam over an exact-owner-bound manifest source.
 *
 * `deadlineMs` is the coordinator's own create deadline; the seam never extends
 * it and never waits past it. Every success path returns the observed slot
 * unchanged; every other path throws one of the bounded codes above.
 */
export function createStardewWorldCreationBindingSeam(
  options: Readonly<{
    manifestSource: StardewIssuedJoinManifestSource;
    deadlineMs: number;
    nowMs?: () => number;
    pollIntervalMs?: number;
  }>,
): CreateWorldBindingSeam {
  const source = options?.manifestSource;
  if (typeof source?.readIssuedJoinManifest !== "function")
    throw new Error("invalid_stardew_world_creation_manifest_source");
  const deadlineMs = options.deadlineMs;
  if (!Number.isSafeInteger(deadlineMs)) throw new Error("invalid_stardew_world_creation_deadline");
  const nowMs = options.nowMs ?? Date.now;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1)
    throw new Error("invalid_stardew_world_creation_poll_interval");
  return Object.freeze({
    createWorldBinding: async (
      input: Readonly<{ gameSessionId: string; integrationId: string; worldRequest: unknown }>,
    ): Promise<Readonly<{ bindingRef: string }>> => {
      // The seam is Stardew-private: it must never consume a foreign
      // integration's create and read the Stardew Player Host's manifest for it.
      // The sibling resolver pins the same constant (`…resolver…:6,78`).
      if (input.integrationId !== INTEGRATION_ID || !SAFE_ID_PATTERN.test(input.gameSessionId))
        throw new Error(STARDEW_GAME_WORLD_CREATION_INTEGRATION_CONFLICT);
      // `input.worldRequest` stays a verbatim passthrough: it is never read,
      // never consulted for identity, and never written into the returned ref.
      const manifest = await awaitIssuedManifest(source, deadlineMs, nowMs, pollIntervalMs);
      return Object.freeze({ bindingRef: readObservedSaveSlot(manifest) });
    },
  });
}

async function awaitIssuedManifest(
  source: StardewIssuedJoinManifestSource,
  deadlineMs: number,
  nowMs: () => number,
  pollIntervalMs: number,
): Promise<unknown> {
  for (;;) {
    try {
      return await source.readIssuedJoinManifest();
    } catch (error) {
      if (!isManifestAbsent(error)) throw new Error(STARDEW_GAME_WORLD_CREATION_MANIFEST_UNAVAILABLE, { cause: error });
      const remainingMs = deadlineMs - nowMs();
      if (remainingMs <= 0) throw new Error(STARDEW_GAME_WORLD_CREATION_MANIFEST_UNAVAILABLE);
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, Math.min(pollIntervalMs, remainingMs)));
    }
  }
}

function readObservedSaveSlot(manifest: unknown): string {
  // Only the observed slot is ever read. Every other manifest field (saveId,
  // worldId, requestId, farmhandId, cabinId, sessionNonce, …) is deliberately
  // ignored: none of them is the physical basename the game assigned, so
  // composing one from them would bind a world that cannot be attached.
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest))
    throw new Error(STARDEW_GAME_WORLD_CREATION_SLOT_MISSING);
  const value = (manifest as Record<string, unknown>).observedSaveSlot;
  if (value === undefined) throw new Error(STARDEW_GAME_WORLD_CREATION_SLOT_MISSING);
  if (typeof value !== "string" || !OBSERVED_SAVE_SLOT_PATTERN.test(value))
    throw new Error(STARDEW_GAME_WORLD_CREATION_SLOT_INVALID);
  return value;
}

function isManifestAbsent(error: unknown): boolean {
  return error instanceof Error && error.message === STARDEW_WORLD_CREATION_MANIFEST_ABSENT;
}

function isUnpublishedManifest(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if (error instanceof SyntaxError) return true;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return true;
  if (!(error instanceof Error)) return false;
  return (
    error.message === "stardew_session_expired" ||
    error.message === "stardew_host_not_ready" ||
    error.message === "invalid_stardew_session"
  );
}
