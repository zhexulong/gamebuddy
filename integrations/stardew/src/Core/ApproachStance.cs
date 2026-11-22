namespace GameBuddy.Stardew.Core;

/// <summary>
/// Which neighbours of a target the body may work it from - the STANCE, declared by the action that will be stood for.
///
/// <para>
/// A STAND TILE IS CHOSEN FOR THE ACTION THAT WILL STAND THERE. <see cref="ApproachTileSelector"/> has always chosen from
/// the eight neighbours, and that is right for the tool families whose native entry names the target tile directly: a Hoe,
/// an Axe or a Can is aimed at a tile and any neighbour is in reach. <c>sweep_scythe</c> is not one of them -
/// <c>MeleeWeapon.DoDamage</c> derives one rectangle per animation frame from the wielder's bounding box and FACING
/// (<c>MeleeWeapon.cs:694-867</c>), so the facing IS the arc's orientation and only a cardinal neighbour can be faced.
/// Measured `round92` `plan_40`: four swings, zero successes - target 64,22 while she stood at 65,21 and 66,23 while she
/// stood at 65,22, three of them refused `sweep_needs_cardinal_stance` because the approach leg had walked her onto a
/// diagonal, which is a legal stand tile for every other tool.
/// </para>
///
/// <para>
/// THE DECLARATION IS THE ACTION'S (<c>FarmhandActionApproachRequirement.Stance</c>) AND BOTH HALVES OF THE LEG READ IT: the
/// reach test asks whether she already stands inside the declared ring (<see cref="ApproachTileSelector.StandsWithin"/>) and
/// the stand-tile search only offers tiles from it (<see cref="ApproachTileSelector.Select"/>). An adjacency hard-coded in
/// either place is the second spelling of one fact, and the two halves disagreeing is exactly the shape that produced
/// `round92`: the reach said "beside the target, swing", and the swing said "not from there".
/// </para>
/// </summary>
public enum ApproachStance
{
    /// <summary>
    /// Any of the eight neighbours - what a row that declares no stance means, and what every tool family but a
    /// stance-constrained swing actually has. It is the default so that a declaration without one changes nothing.
    /// </summary>
    Any = 0,

    /// <summary>
    /// The four orthogonal neighbours only: the tiles a swing can be faced from (<see cref="SwingFacing.For"/>), and the
    /// tiles a CHARGED tool use can be aimed from - `Tool.tilesAffected` orients its rectangle along the facing
    /// (`Tool.cs:919`), so a target on a diagonal is on no axis the tool can point down.
    /// </summary>
    Cardinal = 1,
}

/// <summary>
/// The two words a declared stance owes: its own name, and the refusal an action mints when the only tiles the body could
/// stand on are outside it.
///
/// <para>
/// DERIVED HERE SO `cardinal` IS SPELLED ONCE. The refusal a stance produces is `no_cardinal_stance:diagonal_only`, and a
/// literal beside the enum member would be a second spelling of the same word - the drift this Mod keeps rediscovering
/// (one `reachable` fact spelled in a verdict and in a hint, and the two disagreeing for a run). A caller reads
/// <see cref="StanceRefusalCode"/> and <see cref="OutsideNeighbour"/> rather than composing either by hand.
/// </para>
///
/// <para>
/// `Any` answers null for both: it is the ABSENCE of a stance, so it neither adds a word to the wire nor refuses for a
/// ring it does not have.
/// </para>
/// </summary>
public static class ApproachStanceWords
{
    /// <summary>The stance's own name, or null for <see cref="ApproachStance.Any"/>.</summary>
    public static string? Name(ApproachStance stance) => stance switch
    {
        ApproachStance.Cardinal => "cardinal",
        _ => null,
    };

    /// <summary>
    /// The refusal an action owes when the only tiles the body could stand on are outside its declared stance
    /// (<c>no_cardinal_stance</c>), or null when the stance restricts nothing.
    /// </summary>
    public static string? StanceRefusalCode(ApproachStance stance) =>
        Name(stance) is { } name ? $"no_{name}_stance" : null;

    /// <summary>
    /// What the ring OUTSIDE the stance is, as the neighbour word its refusal carries (<c>diagonal_only</c>), or null when
    /// the stance restricts nothing. It names the complement rather than the stance because that is the answer to the
    /// reader's question: the tiles she could stand on, and why none of them will do.
    /// </summary>
    public static string? OutsideNeighbour(ApproachStance stance) => stance switch
    {
        ApproachStance.Cardinal => "diagonal_only",
        _ => null,
    };

    /// <summary>
    /// The whole refusal a body outside this stance owes, from the two words above: <c>no_cardinal_stance:diagonal_only</c>,
    /// or null when the stance restricts nothing. A reader that has to state both halves itself is a second spelling of
    /// the pair, which is how one of them comes to be renamed without the other.
    /// </summary>
    public static string? Refusal(ApproachStance stance) =>
        StanceRefusalCode(stance) is { } code ? $"{code}:{OutsideNeighbour(stance)}" : null;
}
