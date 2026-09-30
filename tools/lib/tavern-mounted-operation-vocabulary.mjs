/**
 * The mounted Tavern management profile's operation vocabulary, in one place.
 *
 * Both the release gate and the operation-evidence recorder must accept exactly
 * the profile the Host actually mounts
 * (`host/src/composition/desktop-presentation-admission-owner.ts`,
 * `composeTavernManagementProfile`). They previously each carried their own
 * copy: `ac5baeb` added the voice settings surface to the profile and extended
 * the gate, but the recorder kept its older five-entry list and began rejecting
 * the real production profile outright with
 * `mounted_profile_operations_invalid`. A hard-coded second list is what let
 * that drift happen, so the vocabulary lives here and both consumers import it.
 *
 * These are the operation ids the mounted management profile declares. The
 * profile itself remains the authority: this module only records the ids, and
 * `assertMountedOperationVocabulary` fails loudly if the profile ever declares
 * something absent here, rather than silently rejecting it.
 */
export const MOUNTED_TAVERN_MANAGEMENT_OPERATION_IDS = Object.freeze([
  "draft.save",
  "draft.discard",
  "chat.rename",
  "memory.mutate",
  "world-info.bind",
  "settings.voice.read",
  "settings.voice.consent",
  "settings.voice.devices",
]);

const KNOWN = new Set(MOUNTED_TAVERN_MANAGEMENT_OPERATION_IDS);

/**
 * True when every id the profile declares is in the shared vocabulary. A false
 * result means the profile gained an operation and this list was not updated:
 * callers must fail closed rather than drop the unknown id, because dropping it
 * would make the mapping look complete while an operation went unexercised.
 */
export function declaresOnlyKnownOperations(profile) {
  return (
    Array.isArray(profile?.operationIds) &&
    profile.operationIds.length > 0 &&
    profile.operationIds.every((id) => typeof id === "string" && KNOWN.has(id))
  );
}

/** The route each operation is served by, for route/operation membership checks. */
export const MOUNTED_TAVERN_MANAGEMENT_OPERATION_ROUTES = Object.freeze({
  "draft.save": "draft.save",
  "draft.discard": "draft.discard",
  "chat.rename": "chat.rename",
  "memory.mutate": "memory.mutate",
  "world-info.bind": "world-info.bind",
  "settings.voice.read": "settings.voice.read",
  "settings.voice.consent": "settings.voice.consent",
  "settings.voice.devices": "settings.voice.devices",
});