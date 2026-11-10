/// <summary>
/// The one xunit collection every test class that builds a headless <c>Game1</c> world belongs to.
///
/// <para>
/// A test world is a set of PROCESS-WIDE statics - <c>Game1.game1</c>, <c>_player</c>, <c>netWorldState</c>, the floor-
/// path table - so two classes that each build one overwrite each other, and a teardown that lands in the middle of the
/// other class's call reads as a NullReferenceException from inside the engine instead of as a failure of the code under
/// test. xunit runs every class in its own collection, in parallel, unless it is told otherwise; this name is how they
/// are told. It is a NAME and not a definition class because a collection needs no body.
/// </para>
///
/// <para>
/// Membership is by the fact the class shares, not by a list: a class that constructs a <c>GameLocation</c>, a
/// <c>Farmer</c> or a <c>Game1</c> for a fixture joins it, and a class that only reads source text or pure arithmetic
/// stays out - serialising those would buy nothing and cost the suite its wall clock.
/// </para>
/// </summary>
internal static class HeadlessGameWorld
{
    internal const string Collection = "stardew-headless-game-world";
}
