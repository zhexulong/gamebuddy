namespace GameBuddy.Stardew.Core.Policy;

/// <summary>
/// What the Mod's own classifier says an area row IS, and which published action clears it.
///
/// <para>
/// `for_each` accepts `do: { action: "by_kind" }`, and <see cref="FarmhandForEachStep.ByKindAction"/> is explicit about
/// what that means: a REFERENCE the Mod resolves, never a mapping the caller supplies. This is that resolution, and it
/// lives here - beside <see cref="ClearableKind"/>, the one mapping from the engine's containers onto the kind words -
/// because a caller that could restate it would be writing a second classifier.
/// </para>
/// <para>
/// A kind with no action answers null and the row says `no_action_for_kind:&lt;kind&gt;`. That is the whole point: a
/// silent skip reads as a cleared patch, which is the defect this form exists to remove. `rock` is such a kind TODAY -
/// a boulder has no published action that removes it - and it is named here as the answer rather than guessed at.
/// </para>
/// <para>
/// The mapped ids are asserted against <see cref="FarmhandActionCatalog.Registrations"/> in `FarmhandForEachKindActionsTests`:
/// a renamed action fails that test instead of a tile.
/// </para>
/// </summary>
public static class FarmhandForEachKindActions
{
    /// <summary>The kind word a farm tile nobody has touched yet carries when the Hoe would accept it.</summary>
    public const string EmptyTillableKind = "empty_tillable";

    /// <summary>A hoed tile with nothing planted on it: the state `plant_seed` and `water_crop` address.</summary>
    public const string SoilKind = "soil";

    /// <summary>Ground that is neither clearable nor tillable: a wall as far as a clear plan is concerned.</summary>
    public const string GroundKind = "ground";

    /// <summary>Something standing on the tile that no published action clears (`furniture`, a placed object).</summary>
    public const string ObjectKind = "object";

    /// <summary>
    /// The action that works one kind, or null when no action this form can dispatch does.
    ///
    /// <para>
    /// A CLASSIFIER MAPS ONLY KINDS ITS OWN FORM CAN DISPATCH. A `for_each` row supplies the tile, the target identity
    /// the family mints from it, and the step's own scalars - nothing else - so an action that declares an argument only
    /// the caller can supply is not dispatchable from a row. `till_soil` is that action since the area-tool unit gave it
    /// `charge`: a row has nowhere to put the charge, and mapping `empty_tillable` to it would advertise a capability that
    /// always refuses with `row_argument_missing:charge` - a refusal whose repair the caller cannot make from inside the
    /// form. Fresh ground is tilled with an explicit `{ action: \"till_soil\", charge: 0 }` step instead, and the row's own
    /// answer says what this form cannot do.
    /// </para>
    /// <para>
    /// The kinds with an action are therefore the ones whose work needs no per-action argument: weeds, grass and crops
    /// are cut, a stump is chopped. A kind whose action would need an identity this pass cannot derive (a rock) is
    /// deliberately absent instead of mapped to the nearest tool call.
    /// </para>
    /// </summary>
    public static string? ActionFor(string? kind) => kind switch
    {
        "weed" => "cut_weeds",
        "grass" => "cut_grass",
        "crop" => "scythe_crop",
        "stump" => "chop_stump",
        _ => null,
    };
}
