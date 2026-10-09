using StardewValley;

namespace GameBuddy.Stardew;

/// <summary>What the Mod must do about the world the staged request asks for.</summary>
internal enum WorldCreationOutcome
{
    /// <summary>No world of this request exists yet: create exactly one.</summary>
    CreateWorld,

    /// <summary>This request's own world already exists: enter that exact save.</summary>
    EnterExistingWorld,

    /// <summary>The request cannot be answered without creating a duplicate or adopting a foreign save.</summary>
    Refuse,
}

/// <summary>
/// The bounded, stable reason a staged world request was refused. The prose in
/// <see cref="WorldCreationPlan.Reason"/> is for a human reading a log; this code
/// is what a product can branch on, so the one refusal a player has to answer -
/// "you already have more than one companion world, choose which one" - is never
/// indistinguishable from a refusal the product itself caused.
/// </summary>
internal enum WorldCreationRefusal
{
    /// <summary>Not a refusal: the plan asks for a world to be created or entered.</summary>
    None,

    /// <summary>The configured farm name has no native save identity at all.</summary>
    FarmNameHasNoSaveIdentity,

    /// <summary>The save folder could not be read, so "no world exists yet" is not proved.</summary>
    SavesUnreadable,

    /// <summary>More than one save carries this request's own world identity.</summary>
    MultipleOwnWorlds,

    /// <summary>A save is named for this farm but is not identity-equal to this request.</summary>
    ForeignSlotCollision,

    /// <summary>The world this request owns contains no Cabin, so the single companion it exists for cannot live in it.</summary>
    CompanionCabinMissing,
}

/// <summary>
/// The single decision the staged world request resolves to, plus the exact
/// physical save slot it names when the answer is
/// <see cref="WorldCreationOutcome.EnterExistingWorld"/>, plus the reason and the
/// bounded refusal code when the answer is
/// <see cref="WorldCreationOutcome.Refuse"/>.
/// </summary>
internal readonly record struct WorldCreationPlan(
    WorldCreationOutcome Outcome,
    string SlotName,
    string Reason,
    WorldCreationRefusal Refusal);

/// <summary>
/// The rule that reads a staged world request as "create", "enter the world I
/// already created", or "refuse".
///
/// How "this request's own world" is decided, and why that is trustworthy:
///
/// * the game names a save folder after the farm name the request carries —
///   <c>SaveGame.FilterFileName(farmName)</c> plus the game's own unique id
///   (<c>SaveGame.cs:448</c>) — so a candidate slot has to be
///   <c>{filtered farm name}_{digits}</c>, and a folder that only looks similar
///   is never a candidate;
/// * the request's three frozen identity fields (farm name, player name,
///   favourite thing) are exactly the three fields the Mod writes into the
///   world when it creates one, and the game writes them into the save's own
///   <c>SaveGameInfo</c>; so a candidate is only this request's own world when
///   the save itself claims the same three values.
///
/// Only that combination is accepted, and only when it is unique. A collision
/// with a save that is not identity-equal (one different field, one different
/// folder shape, or an unreadable save list) is refused instead of adopted or
/// overwritten, and a second world is never created.
///
/// What this rule deliberately does NOT do: prefer a previously entered slot.
/// The Host's private bootstrap staging path cannot hand one over -- the slot it
/// learns is persisted only as an opaque world-binding ref keyed by the previous
/// game session, and no existing durable field the bootstrap can read carries it
/// -- so identity matching stays the only rule, and the refusals carry a bounded
/// code (see <see cref="WorldCreationRefusal"/>) that distinguishes the case the
/// player has to answer from the cases the product has to fix.
/// </summary>
internal static class WorldCreationDecision
{
    internal static WorldCreationPlan Decide(WorldCreationConfig config, IReadOnlyList<WorldSaveIdentity>? existingSaves)
    {
        string requestedFilteredName = FilterSaveName(config.FarmName);
        if (requestedFilteredName.Length == 0)
            return new(WorldCreationOutcome.Refuse, string.Empty, "the configured farm name has no native save identity", WorldCreationRefusal.FarmNameHasNoSaveIdentity);
        if (existingSaves is null)
        {
            return new(
                WorldCreationOutcome.Refuse,
                string.Empty,
                "the existing saves could not be read, so this request cannot prove that its own world does not already exist",
                WorldCreationRefusal.SavesUnreadable);
        }
        WorldSaveIdentity[] namedSlots = existingSaves
            .Where(save => IsNativeSaveSlotFor(save.SlotName, requestedFilteredName))
            .ToArray();
        WorldSaveIdentity[] ownWorlds = namedSlots
            .Where(save => string.Equals(save.FarmName, config.FarmName, StringComparison.Ordinal)
                && string.Equals(save.PlayerName, config.PlayerName, StringComparison.Ordinal)
                && string.Equals(save.FavoriteThing, config.FavoriteThing, StringComparison.Ordinal))
            .ToArray();
        if (ownWorlds.Length == 1)
            return new(WorldCreationOutcome.EnterExistingWorld, ownWorlds[0].SlotName, string.Empty, WorldCreationRefusal.None);
        if (ownWorlds.Length > 1)
        {
            return new(
                WorldCreationOutcome.Refuse,
                string.Empty,
                $"{ownWorlds.Length} saves carry this request's own world identity, so which one is this request's world is ambiguous",
                WorldCreationRefusal.MultipleOwnWorlds);
        }
        if (namedSlots.Length > 0)
        {
            return new(
                WorldCreationOutcome.Refuse,
                string.Empty,
                $"a save named '{requestedFilteredName}' already exists and is not this request's own world",
                WorldCreationRefusal.ForeignSlotCollision);
        }
        return new(WorldCreationOutcome.CreateWorld, string.Empty, string.Empty, WorldCreationRefusal.None);
    }

    /// <summary>
    /// The native save identity the game derives from a farm name. This is the
    /// game's own filter (<c>SaveGame.FilterFileName</c>), not a copy of it, so
    /// the Mod's slot rule can never drift from the folders the game writes.
    /// </summary>
    internal static string FilterSaveName(string farmName) => SaveGame.FilterFileName(farmName);

    /// <summary>
    /// Whether a save folder basename is this farm name's own native slot, in
    /// the form the game assigns it: the filtered farm name, one underscore, and
    /// the game's unique id.
    /// </summary>
    internal static bool IsNativeSaveSlotFor(string slotName, string filteredFarmName)
    {
        if (!slotName.StartsWith(filteredFarmName + "_", StringComparison.Ordinal))
            return false;
        string suffix = slotName[(filteredFarmName.Length + 1)..];
        return suffix.Length is >= 1 and <= 32 && suffix.All(char.IsDigit);
    }
}
