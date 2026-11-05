using System.Text.Json.Serialization;

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
/// a heavy hitter for it; <c>placed_furniture</c> is a piece standing in
/// <c>location.furniture</c> - the room's own bed, sofa or rug, which never appears in
/// <c>location.objects</c>, so none of the four object kinds can describe it - and it is
/// named through <c>move_placed_furniture</c>.
/// </para>
/// <para>
/// <c>Slot</c> is the backpack slot the named action must act through, or -1 when the
/// actor owns no tool this lane can act with (a placed furniture piece is always -1:
/// no tool in this lane lifts one). It is a fact about the actor's own
/// backpack, not an instruction: the action still requires that slot to be EQUIPPED and
/// refuses with a named code when it is not.
/// </para>
/// <para>
/// <c>Rotation</c> and <c>Rotations</c> are the piece's live <c>currentRotation</c> and the
/// size of its own rotation cycle, and they are <c>null</c> for every kind that is not a
/// piece of furniture - <c>null</c>, not 0, because 0 is a legal rotation and a sentinel
/// that reads as a value will eventually be compared as one. Both are written even when
/// null (<c>JsonIgnoreCondition.Never</c>): the serializer's default drops null members, and
/// a dropped member is a snapshot the Host refuses wholesale as
/// <c>invalid_snapshot:worldObjectTargets</c>. Without <c>Rotations</c> a caller cannot tell a
/// piece that will turn from one that will not and would have to attempt in order to find out;
/// without <c>Rotation</c> a successful turn is unobservable, which is the whole reason
/// <c>furniture_rotation_unsupported</c> exists.
/// </para>
/// <para>
/// The Mod's serializer omits null members by default, so every field here is written
/// explicitly and never omitted.
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
    string DisplayName,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] int? Rotation,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] int? Rotations);
