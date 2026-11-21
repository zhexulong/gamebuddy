namespace GameBuddy.Stardew;

/// <summary>
/// WHEN a postcondition that compares a world state with itself read that state, relative to the mutation the pair
/// judges.
///
/// <para>
/// WHY A POSTCONDITION HAS TO SAY THIS. <c>removed=False;inventory_before=0;inventory_after=0</c> is what a caller read
/// for four live refusals of <c>pickup_forage</c> (`round82` once, `round83` twice), and those three numbers are equally
/// true of a click the engine declined, of a click that removed the object and delivered nothing, and of a check that
/// ran before the engine's own update could apply the removal. The first is a fact about the object; the third is a
/// fact about the RECEIPT. A pair sampled on the request's tick cannot see a mutation the engine applies on a later
/// update, so a postcondition that publishes a pair without saying when it read it invites a reader to diagnose a race
/// that is not there - which is exactly what those four refusals did for two rounds.
/// </para>
///
/// <para>
/// The window is per ACTION rather than per family, because the engine's write is: <c>GameLocation.checkAction</c>
/// removes the forage and fills the pack INSIDE the call the Mod makes (<c>addItemToInventoryBool</c> :7830,
/// <c>objects.Remove</c> :7837, <c>return true</c> :7838), so <c>pickup_forage</c>'s read after
/// <c>Game1.tryToCheckAt</c> is after the settle. <c>Debris.updateChunks</c> collects a ground drop on ITS OWN update
/// instead (Debris.cs:793), which is why <c>pickup_item</c> settles through the frame loop rather than on this tick.
/// </para>
/// </summary>
internal enum PostconditionReadPoint
{
    /// <summary>
    /// After the native call that performs the mutation returned, so the pair saw everything the engine did.
    /// </summary>
    AfterTheSettle,

    /// <summary>
    /// On the request's own tick, before the mutation could be applied. Declaring this is always a defect: it names
    /// the shape the gate <c>a_postcondition_that_reads_a_world_state_says_when_it_read_it</c> exists to refuse.
    /// </summary>
    AtTheCall,
}

/// <summary>
/// The wire word of each read point, and the whole set as data - the same shape <see cref="RefusalLayerWire"/> uses, so
/// a fourth form cannot be invented and the compiler refuses the build until one is given a word here.
/// </summary>
internal static class PostconditionReadPointWire
{
    internal static string ToWireValue(this PostconditionReadPoint point) => point switch
    {
        PostconditionReadPoint.AfterTheSettle => "after_the_settle",
        PostconditionReadPoint.AtTheCall => "at_the_call",
    };

    /// <summary>Every word <see cref="PostconditionReadPoint"/> puts on the wire, in declaration order.</summary>
    internal static IReadOnlyList<string> All { get; } = Array.AsReadOnly(
        Enum.GetValues<PostconditionReadPoint>().Select(static point => point.ToWireValue()).ToArray());
}

/// <summary>
/// A postcondition that publishes a before/after pair of one world state says WHEN it read that pair.
///
/// <para>
/// THE POPULATION IS DERIVED, NOT LISTED. The gate
/// <c>a_postcondition_that_reads_a_world_state_says_when_it_read_it:&lt;action&gt;</c> walks the Mod's assembly for
/// every type declaring a <c>*Before</c>/<c>*After</c> pair, so a postcondition factored into a type joins the gate the
/// moment it is declared - and a type that compares a pair without answering this interface fails it by name. What the
/// gate cannot see is a handler that keeps its pair in two locals and inlines them into the sentence; those are the
/// price of this gate being structural, and each such action carries the same two tokens in its own receipt instead.
/// </para>
///
/// <para>
/// The read point is a fact about the TYPE rather than about one attempt, so a default-constructed instance answers it
/// and the value does not depend on the world. <see cref="ActionId"/> is here for the same reason a receipt names the
/// action: a failure has to say which action broke the rule, not merely which struct did.
/// </para>
/// </summary>
internal interface IReadsAWorldStateBeforeAndAfter
{
    /// <summary>The action id of the request this postcondition settles, as the catalogue registers it.</summary>
    string ActionId { get; }

    /// <summary>
    /// When this postcondition's pair was read. <see cref="PostconditionReadPoint.AfterTheSettle"/> is the only value
    /// a shipped postcondition may answer.
    /// </summary>
    PostconditionReadPoint ReadPoint { get; }
}
