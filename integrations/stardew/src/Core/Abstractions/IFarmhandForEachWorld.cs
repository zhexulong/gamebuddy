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

    /// <summary>Whether the live action policy enables this action right now.</summary>
    bool IsActionEnabled(string actionId);

    /// <summary>Whether STOP has arrived for the program this pass belongs to; consulted between two effects only.</summary>
    bool StopRequested { get; }
}
