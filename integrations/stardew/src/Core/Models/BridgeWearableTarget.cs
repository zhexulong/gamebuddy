using System.Text.Json.Serialization;

namespace GameBuddy.Stardew.Core.Models;

/// <summary>
/// One wearable body slot of the acting farmer: the slot the actor wears a hat, boots, shirt,
/// pants or ring in. Every slot of the fixed set is published, empty or not — an EMPTY slot is
/// exactly the target an equip into a free slot names — and the occupant fields say which are
/// filled.
/// </summary>
/// <remarks>
/// <para>
/// <c>TargetId</c> is opaque and binds the slot AND its current occupant, because the postcondition
/// of both wearable actions is that the slot's contents MOVE: "the hat slot, which is currently
/// empty" and "the hat slot, which currently holds (H)0" are two different targets, and a request
/// naming the stale one is refused instead of silently swapping the wrong item out.
/// </para>
/// <para>
/// The occupant members are declared <see cref="JsonIgnoreCondition.Never"/> on purpose: an empty
/// slot must arrive as an explicit null, not as an absent member, because "empty" is a state an
/// Agent has to be able to read rather than infer from a missing key.
/// </para>
/// </remarks>
public sealed record BridgeWearableTarget(
    string TargetId,
    string BodySlot,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? OccupantQualifiedItemId,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? OccupantDisplayName);
