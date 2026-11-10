using GameBuddy.Stardew.Core.Policy;

namespace GameBuddy.Stardew.Core.Abstractions;

/// <summary>
/// The live farm as one `for_each` pass reads it, on the game thread, against the world as it is NOW.
///
/// <para>
/// It is an interface and not a read of the world because <see cref="GameBuddy.Stardew.Core.Policy.FarmhandForEachExpansion"/>
/// must stay pure: the pass decides, the caller reads. The implementation lives in the Mod assembly, where the engine's
/// own containers - <c>resourceClumps</c>, <c>objects</c>, <c>terrainFeatures</c> - are visible, and the row it answers
/// with is the same shape a published target family would have produced.
/// </para>
/// <para>
/// <see cref="ActionForKind"/> is the Mod's classifier answering <c>do: { action: "by_kind" }</c>; it lives beside the
/// classifier rather than in the pass, because a table the caller could restate would be a second classifier.
/// <see cref="IsActionEnabled"/> is the live action policy: a loop is a FORM and each of its rows is an ordinary
/// dispatch, so the policy gate belongs to the row.
/// </para>
/// </summary>
public interface IFarmhandForEachWorld
{
    /// <summary>
    /// The live tile at <paramref name="x"/>,<paramref name="y"/>, or null when that tile is not on the farm this pass
    /// reads. A tile that is not on the farm is not a row, and the pass says so instead of acting on it.
    /// </summary>
    /// <param name="localColumn">The row's 0-based column inside the loop's source, which a position guard tests.</param>
    /// <param name="localRow">The row's 0-based row inside the loop's source.</param>
    FarmhandForEachRow? ReadRow(int x, int y, int localColumn, int localRow);

    /// <summary>The published action that clears or works a row's kind, or null when no published action does.</summary>
    string? ActionForKind(string kind);

    /// <summary>
    /// The identity the published <paramref name="family"/> mints for the row at this tile, or null when that family has
    /// no identity there.
    ///
    /// <para>
    /// ONE IDENTITY PER FAMILY, AND IT IS THE FAMILY'S OWN. The implementation calls the same function the family's
    /// discovery publishes its rows with, so the id a row dispatches with is the id the handler recomputes before it acts.
    /// A second hash that happens to agree today is the defect this seam exists to remove.
    /// </para>
    /// <para>
    /// WHICH FAMILY TO ASK IS NOT A QUESTION FOR THIS METHOD. The action's own descriptor declares it
    /// (<c>FarmhandActionDescriptor.TargetFamily</c>), so the caller passes the declaration and never a table of its own.
    /// </para>
    /// <para>
    /// <paramref name="declaredArguments"/> is the row's own `do` arguments, because some identities are a function of the
    /// caller's item selector as well as the tile: a seed target is (slot, tile, item). An identity the live world cannot
    /// compute answers null, and the row is refused by name instead of being dispatched with nothing.
    /// </para>
    /// </summary>
    /// <param name="family">The `targetFamily` the action's own descriptor declares.</param>
    /// <param name="x">The row's map tile.</param>
    /// <param name="y">The row's map tile.</param>
    /// <param name="declaredArguments">The row's `do` arguments, or null when it declared none.</param>
    string? TargetIdFor(string family, int x, int y, IReadOnlyDictionary<string, string>? declaredArguments);

    /// <summary>
    /// Whether this pass can name a tile AT ALL under <paramref name="family"/>.
    ///
    /// <para>
    /// THE OTHER HALF OF <see cref="TargetIdFor"/>, and it exists because one refusal answered two different facts. A family
    /// this seam has no arm for (every published family but three) and a family it CAN derive over a tile that carries
    /// nothing for it (a `cropTargets` row over bare ground) both used to answer null, so the row said the same thing for
    /// both - and the companion reading the live run concluded that `cropTargets` could never match rather than that the
    /// tiles carried no crop.
    /// </para>
    /// <para>
    /// A CALLER THAT GETS FALSE IS REFUSED BY FAMILY NAME; a caller that gets true and an invalid tile is told the tile has
    /// nothing there. Neither is a silent skip.
    /// </para>
    /// </summary>
    bool CanNameFamily(string family);

    /// <summary>Whether the live action policy enables this action right now.</summary>
    bool IsActionEnabled(string actionId);

    /// <summary>Whether STOP has arrived for the program this pass belongs to; consulted between two effects only.</summary>
    bool StopRequested { get; }
}
