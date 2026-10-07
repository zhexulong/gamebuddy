namespace GameBuddy.Stardew.Core.Models;

/// <summary>
/// One entry of the world-object lane's discovery projection: something the actor can
/// name at a world tile, together with the backpack slot the action that acts on it
/// needs.
///
/// <para>
/// <c>Kind</c> is what the live object IS for this lane, never a client-supplied
/// classification:
/// <c>placement_candidate</c> is a tile the item in <c>Slot</c> could be placed on now
/// (the object does not exist yet, and <c>QualifiedItemId</c> is the item that would be
/// placed); <c>removable_object</c> is an object the axe or pickaxe in <c>Slot</c>
/// removes; <c>non_removable_object</c> is an object no axe or pickaxe removes, so the
/// removal action refuses it by name instead of the Agent having to guess why it is
/// invisible; <c>breakable_container</c> is a breakable container and <c>Slot</c> holds
/// a heavy hitter for it.
/// </para>
/// <para>
/// <c>Slot</c> is the backpack slot the named action must act through, or -1 when the
/// actor owns no tool this lane can act with. It is a fact about the actor's own
/// backpack, not an instruction: the action still requires that slot to be EQUIPPED and
/// refuses with a named code when it is not. The Mod's serializer omits null members, so
/// every field here is always written and never null.
/// </para>
/// </summary>
public sealed record BridgeWorldObjectTarget(
    string TargetId,
    string Kind,
    string Location,
    int X,
    int Y,
    int Slot,
    string QualifiedItemId,
    string DisplayName);
