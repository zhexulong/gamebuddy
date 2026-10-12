using System;
using System.Globalization;
using StardewValley;
using StardewValley.Characters;

namespace GameBuddy.Stardew;

// `name_entity`: give the actor's OWN horse its name, through the game's own naming settlement.
//
// THE SEAM IS `Horse.nameHorse(string name)` (StardewValley.Characters/Horse.cs:570) - public,
// one argument, UI-free, and the body that actually writes the name. It is NOT `NamingMenu`:
// that class assigns nothing. `NamingMenu.doneNaming` is a delegate FIELD the caller supplies
// (NamingMenu.cs:29) and `textBoxEnter` merely invokes it after a length check and the platform
// word filter (`:85-100`), so the settlement lives in the CALLBACK BODY, and for the horse the
// callback IS this public method - its only in-game binding is Horse.cs:637, inside the
// stable-driven interaction. This action therefore calls the settlement and never the input
// dispatcher: no NamingMenu, no textBoxEnter, no `Game1.activeClickableMenu =`.
//
// WHY THE OTHER NAMING CALLERS ARE NOT THIS ACTION'S SEAM. Each other caller's callback body does
// strictly more than name an existing entity, or names something the same callback creates:
//   * QuestionEvent.cs:123 / Event.cs:2258 bind `AnimalHouse.addNewHatchedAnimal(string)`
//     (AnimalHouse.cs:107), which CREATES a FarmAnimal out of a ready incubator egg and then names
//     it - so its terminal is a hatch, not a name write, and its precondition is a loaded incubator.
//   * Event.cs:13092's `namePet` runs `Game1.dedicatedServer.DoHostAction("NamePet", name)`
//     (Event.cs:13095) into `Event.hostActionNamePet` (internal static, Event.cs:13071), which
//     CONSTRUCTS the Pet, warps it into the farmhouse and assigns it to a free PetBowl.
//   * BirthingEvent.returnBabyName (BirthingEvent.cs:58) only stores `babyName`; the child NPC is
//     created later in that same event's own tickUpdate.
// `Horse.nameHorse` is the one caller body that assigns a name to an entity that ALREADY EXISTS,
// which is what a `name_entity` capability means. The horse is named when its Stable is built
// (Horse.cs:622 reads `base.Name.Length <= 0`), and the name is SAVED state: the method writes
// `Name`, `displayName` and - only for a horse that has never been named - the durable per-player
// `Game1.player.horseName.Value` (Horse.cs:585-590).
//
// THE SUBJECT is the ACTOR'S OWN horse, resolved live through `Utility.findHorseForPlayer(long uid)`
// (Utility.cs:4411), which scans every location's characters for the Horse whose `ownerId` is the
// actor. That is the same singleton relation `dismount_transport` uses for the actor's own mount.
//
// ARGUMENTS are exactly `{ text }`, and the wire argument carries the requested name. There is
// deliberately NO `expectedTargetId` and NO coordinate:
//   * the only horse projection this Mod publishes (`HorseTargets`, for `mount_transport`) is built
//     by `DiscoverHorseTargets`, which SKIPS every horse whose `Name` is empty or literally
//     "Horse" (transportactions.cs:43-44) - exactly because you may only mount a NAMED horse. An
//     unnamed horse therefore has no published id to hand back, so a target-id argument would make
//     this action uncallable by the very caller it exists for. Adding a second projection means a
//     new snapshot field, which reaches the Host's exact-shape contract and is outside this lane;
//   * the protocol has no optional arguments and rejects a missing OR extra key, so a target id
//     "for safety" is not available either (the same rule `dismount_transport` records).
// The wire name `text` is the protocol's own free-text argument (`BridgeExecutionArgs.Text`); its
// other user is `send_multiplayer_chat` (BridgeProtocol.cs:1948).
//
// NO REACH RULE, and why that is the honest answer rather than an omission. `nameHorse` reads no
// geometry at all: it never touches the actor's tile, the horse's tile, facing or distance. The
// native prompt is raised from the STABLE interaction while the horse may be anywhere on the map
// (and a named horse is warped into the farmhouse when the player sleeps), so requiring Chebyshev-1
// here would invent a precondition the game does not have and would fail for a horse that wandered
// away. The sibling action on the SAME entity, `dismount_transport`, carries no geometry and no
// reach for the same reason. Admission is therefore the shared `General` profile.
//
// NO WORD FILTER, for the reason `send_multiplayer_chat` records: the platform censorship pass
// (`Utility.FilterDirtyWords` -> `Program.sdk.FilterDirtyWords`, Utility.cs:7756) belongs to the
// surface that owns the text, and the naming menu applies it to PLAYER-TYPED input. The stored
// value is echoed verbatim in `name_after`, so a caller sees exactly what was written.
//
// POSTCONDITION is the STORED NAME READ BACK FROM THE ENTITY: `horse.Name` is re-read after the
// call and must equal the requested name. `nameHorse` returns void and cannot refuse, so a call
// that left the name unchanged is `Uncertain` (`name_entity_postcondition_unavailable`) with the
// value it actually read in the evidence - never a success. The durable per-player `horseName` is
// reported as a corroborating flag (`player_horse_name_updated`) and is NOT part of the
// postcondition, because the native method writes it only when it was null (Horse.cs:587) - a
// world where it already holds something is still correctly named.
//
// EVIDENCE. Every field is a non-empty `key=value`, and every value is separator-free: the two
// names the evidence echoes are the REQUESTED name (validated below to contain no `;` or `=`) and
// the value read back from the entity, which the settlement has just set to exactly that name. A
// PRE-EXISTING name is never echoed, because a player-typed name may contain either separator; the
// already-named refusal reports `existing_name_present=true` and `existing_name_length` instead.
//
// FAILURE MODES, each with its own terminal code: a name that is blank, over-long, or carries the
// receipt's own separators (`name_entity_name_invalid`), the actor owning no horse in the live
// world (`name_entity_target_unavailable`), the horse already carrying a name
// (`name_entity_target_already_named` - the game's own gate at Horse.cs:622), the native call
// throwing (`name_entity_native_exception`), the world not showing the name
// (`name_entity_postcondition_unavailable`), and success (`entity_named`).
//
// LIFECYCLE. Registered Experimental in `FarmhandActionCatalog` (family `animals_pets`, handler
// group MachinesAndAnimals) through this lane's wiring manifest: it has no live gate yet, so it
// stays off the default Agent surface until its own native-local gate passes.
internal sealed partial class ExecutionManager
{
    /// <summary>
    /// The bound on one entity name. The name is SAVED state and is rendered as a single label in
    /// the game's own UIs, so an unbounded wire string would grow both without limit; the value is
    /// this action's own bound and is reported in the refusal.
    /// </summary>
    internal const int EntityNameMaximumLength = 64;

    /// <summary>
    /// The receipt evidence cannot carry a value containing `;` (the field separator) or `=`
    /// (which would split the field into an unreadable key), so a REQUESTED name containing either
    /// is refused by name rather than flattened into a field that no longer says which name was
    /// stored.
    /// </summary>
    private static readonly char[] EntityNameForbiddenCharacters = { ';', '=' };

    /// <summary>
    /// Gives the actor's own horse its name through the native settlement. See the file header for
    /// the seam, the subject, the argument shape, the reach rule and the failure modes.
    /// </summary>
    public LocalExecutionReceipt RequestLocalNameEntity(string requestId, string name, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // General, not Physical: the seam drives no tool lifecycle and starts no swing - it is one
        // instantaneous name write, the same profile dismount_transport and equip_wearable admit
        // through.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        Farmer actor = Game1.player;
        string? invalidReason = DescribeInvalidEntityName(name);
        if (invalidReason is not null)
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "name_entity_name_invalid",
                $"reason={invalidReason};length={name.Length};maximum_length={EntityNameMaximumLength}");

        string requested = name.Trim();

        if (!TryResolveOwnedHorse(actor, out Horse? horse, out string subjectEvidence))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "name_entity_target_unavailable", subjectEvidence);

        Horse subject = horse!;
        string? existingName = subject.Name;
        if (!string.IsNullOrEmpty(existingName))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "name_entity_target_already_named",
                $"{subjectEvidence};existing_name_present=true;existing_name_length={existingName.Length};requested_length={requested.Length}");

        try
        {
            // THE SEAM. The native naming menu's own callback body, called with the same textual
            // input the menu would have handed it.
            subject.nameHorse(requested);
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Uncertain,
                "name_entity_native_exception",
                $"{subjectEvidence};name_before=none;requested={requested};name_after={DescribeEntityName(subject.Name)};"
                + $"native_exception={nativeException.GetType().Name};native_call_ran_unknown=true");
        }

        // The postcondition is the name the ENTITY now stores, never "we called the method":
        // `nameHorse` is void and cannot refuse.
        string storedName = subject.Name;
        bool named = string.Equals(storedName, requested, StringComparison.Ordinal);
        string evidence =
            $"{subjectEvidence};horse_id={subject.HorseId:N};name_before=none;requested={requested};"
            + $"name_after={DescribeEntityName(storedName)};name_matches_requested={named.ToString().ToLowerInvariant()};"
            + $"player_horse_name_updated={string.Equals(actor.horseName.Value, requested, StringComparison.Ordinal).ToString().ToLowerInvariant()}";
        return named
            ? this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "entity_named", evidence)
            : this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "name_entity_postcondition_unavailable", evidence);
    }

    /// <summary>
    /// The one place that answers "which horse is this actor's own, and where is it?", shared by
    /// execution, the fixture's Given and the runner's read-back so the product and its declared
    /// precondition can never disagree about who is being named. False means the actor owns no
    /// horse in the live world, which is a different answer from "the horse already has a name".
    /// </summary>
    internal static bool TryResolveOwnedHorse(Farmer actor, out Horse? horse, out string evidence)
    {
        horse = Utility.findHorseForPlayer(actor.UniqueMultiplayerID);
        string location = actor.currentLocation?.NameOrUniqueName ?? "unknown";
        evidence =
            $"owner_id={actor.UniqueMultiplayerID.ToString(CultureInfo.InvariantCulture)};location={location};"
            + $"actor_tile={actor.TilePoint.X},{actor.TilePoint.Y}";
        if (horse is null)
        {
            evidence += ";horse=none";
            return false;
        }

        evidence += $";horse_tile={(int)horse.Tile.X},{(int)horse.Tile.Y}"
            + $";horse_owner_id={horse.ownerId.Value.ToString(CultureInfo.InvariantCulture)}"
            + $";horse_name={DescribeEntityName(horse.Name)}";
        return true;
    }

    /// <summary>An empty native name reads as `none` in the evidence, never as an empty field.</summary>
    internal static string DescribeEntityName(string? name) => string.IsNullOrEmpty(name) ? "none" : name;

    /// <summary>
    /// The refusal reason for a requested name, or null when it is usable. The three rules exist
    /// because the name is persisted as saved state, rendered as one label, and echoed through a
    /// `;`-separated `key=value` list.
    /// </summary>
    private static string? DescribeInvalidEntityName(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return "blank";
        if (name.Length > EntityNameMaximumLength) return "too_long";
        if (name.IndexOfAny(EntityNameForbiddenCharacters) >= 0) return "separator_character";
        return null;
    }
}
