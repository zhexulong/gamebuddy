using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The moving-target contract of the actions whose subject walks.
///
/// <para>
/// Discovery publishes a villager, a Pet and a FarmAnimal at the tile it occupies
/// in the snapshot; all three then move on their own (a villager's schedule, a
/// Pet's <c>WalkInDirection</c> behaviour, a FarmAnimal's in-building wander). The
/// shared approach leg (design 5.2: <c>TryBeginToolApproach</c> /
/// <c>CompleteToolApproach</c>) is what turns "outside the native Chebyshev-1
/// radius" from a refusal into a walk, and the arrival is not the terminal: the
/// action's own execution body re-reads the world and settles it.
/// </para>
///
/// <para>
/// <c>pet_animal</c> and <c>collect_animal_product</c> used to be bare distance
/// checks with no pathfinding, so a target published inside the radius-6 discovery
/// window and refused past radius 1 was unreachable without the Agent moving the
/// actor itself and re-observing between every step. These tests pin the two
/// halves that make the walk honest rather than a pursuit: the walk is planned
/// against the target's LIVE tile, and an arrival that lands outside the radius is
/// the approach leg's own named refusal -- never a native call against the
/// coordinate the snapshot happened to publish.
/// </para>
///
/// <para>
/// Structural assertions run without a Game1 harness; the live arrival against a
/// wandering target belongs to the native-local / HostAutomation fixture gates.
/// </para>
/// </summary>
public sealed class MovingTargetApproachTests
{
    private const string AnimalsFile = "farmhandexecutioncontroller.machinesanimalsitemsactions.cs";
    private const string NpcFile = "farmhandexecutioncontroller.npcactions.cs";

    // ---- the refusal became a walk -------------------------------------------

    [Fact]
    public void Pet_OutOfRange_AdmitsAnApproach_InsteadOfRefusing()
    {
        string body = MethodBody(Read(AnimalsFile), "public LocalExecutionReceipt RequestLocalPetAnimal(");

        // The pet is resolved by identity first, so the walk is only started for a
        // pet that could actually be petted on arrival.
        body.Should().Contain("ResolvePetTarget(location, expectedTargetId)");
        int resolve = body.IndexOf("ResolvePetTarget(location, expectedTargetId)", StringComparison.Ordinal);
        int hands = body.IndexOf("\"hands_not_empty\"", StringComparison.Ordinal);
        int geometry = body.IndexOf("IsTileWithinChebyshevRadius", StringComparison.Ordinal);
        int approach = body.IndexOf("TryBeginToolApproach", StringComparison.Ordinal);
        resolve.Should().BeLessThan(geometry, "the pet must resolve before the geometry decision");
        hands.Should().BeLessThan(geometry, "an empty-handed precondition must hold before deciding to walk");
        geometry.Should().BeLessThan(approach, "the approach is the out-of-range branch");

        body.Should().NotContain("\"target_out_of_range\"",
            "pet_animal no longer refuses a published target for being two tiles away; it walks");
        // The arrival is not the terminal: the closure hands off to the one execution body
        // the in-range path also uses, and the approach carries the real action id so a
        // snapshot names `pet_animal` rather than an internal approach phase.
        body.Should().Contain("this.ExecutePetAnimal(arrivalExecutionId, arrivalRequestId");
        body.Should().Contain("return this.ExecutePetAnimal(executionId, requestId");
        body.Should().Contain("\"pet_animal\"");
    }

    [Fact]
    public void CollectAnimalProduct_OutOfRange_AdmitsAnApproach_InsteadOfRefusing()
    {
        string body = MethodBody(Read(AnimalsFile), "public LocalExecutionReceipt RequestLocalCollectAnimalProduct(");

        // Position-independent preconditions come first, so the actor is not sent
        // walking for an animal it could not milk on arrival.
        int targetChanged = body.IndexOf("\"animal_product_target_changed\"", StringComparison.Ordinal);
        int inventoryFull = body.IndexOf("\"inventory_full\"", StringComparison.Ordinal);
        int geometry = body.IndexOf("IsAnimalProductTargetInRange", StringComparison.Ordinal);
        int approach = body.IndexOf("TryBeginToolApproach", StringComparison.Ordinal);
        targetChanged.Should().BeLessThan(geometry, "the produce/adult/tool state must be validated before walking");
        inventoryFull.Should().BeLessThan(geometry, "capacity must be validated before walking");
        geometry.Should().BeLessThan(approach, "the approach is the out-of-range branch");

        body.Should().NotContain("\"target_out_of_range\"",
            "collect_animal_product no longer refuses a published animal for being two tiles away; it walks");
        body.Should().Contain("this.ExecuteCollectAnimalProduct(arrivalExecutionId, arrivalRequestId");
        body.Should().Contain("return this.ExecuteCollectAnimalProduct(executionId, requestId");
        body.Should().Contain("\"collect_animal_product\"");
    }

    // ---- the arrival re-reads the LIVE target --------------------------------

    [Fact]
    public void Pet_ExecutionReReadsTheLivePet_AndNamesTheMovedRefusal()
    {
        string executed = MethodBody(Read(AnimalsFile), "private LocalExecutionReceipt ExecutePetAnimal(");

        // The person/pet is re-derived from the opaque id on the game thread, and reach
        // is measured against the tile it occupies NOW -- the request's published
        // coordinate is not part of this body at all.
        executed.Should().Contain("ResolvePetTarget(location, expectedTargetId)");
        executed.Should().Contain("IsTileWithinChebyshevRadius(Game1.player, petTileX, petTileY, 1)");
        executed.Should().NotContain("targetX");
        executed.Should().NotContain("targetY");

        // A walk that ended out of reach reports the shared approach vocabulary with both
        // tiles, so "the pet moved" is visible instead of being read as a stale request.
        executed.Should().Contain("\"target_out_of_reach\"");
        executed.Should().Contain("reach=1;approach=target_moved");

        int range = executed.IndexOf("target_out_of_reach", StringComparison.Ordinal);
        int native = executed.IndexOf("pet.checkAction(Game1.player, location)", StringComparison.Ordinal);
        native.Should().BeGreaterThan(range, "the native entry must never run against a stale coordinate");
    }

    [Fact]
    public void CollectAnimalProduct_ExecutionReReadsTheLiveAnimal_AndAimsAtItsLiveTile()
    {
        string executed = MethodBody(Read(AnimalsFile), "private LocalExecutionReceipt ExecuteCollectAnimalProduct(");

        executed.Should().Contain("ResolveAnimalProductTarget(location, slot, tool, expectedTargetId)");
        executed.Should().Contain("IsAnimalProductTargetInRange(Game1.player, animalTileX, animalTileY)");
        // The request's published coordinate is not trusted anywhere in this body: an
        // animal that walked would otherwise be aimed at with lastClick/FacingDirection
        // pointing at the tile it had left, and the native binding guard would refuse the
        // exact animal this body just validated.
        executed.Should().NotContain("targetX");
        executed.Should().NotContain("targetY");
        executed.Should().Contain("GetCardinalFacingDirectionToTile(Game1.player, animalTileX, animalTileY)");
        executed.Should().Contain("animalTileX * 64f + 32f, animalTileY * 64f + 32f");

        executed.Should().Contain("\"target_out_of_reach\"");
        executed.Should().Contain("reach=1;approach=target_moved");

        int range = executed.IndexOf("target_out_of_reach", StringComparison.Ordinal);
        int native = executed.IndexOf("Game1.player.BeginUsingTool()", StringComparison.Ordinal);
        native.Should().BeGreaterThan(range, "the native tool lifecycle must never start outside the native radius");
    }

    [Fact]
    public void TalkToNpc_ArrivalOutOfReach_IsTheNamedApproachRefusal()
    {
        string executed = MethodBody(Read(NpcFile), "private LocalExecutionReceipt ExecuteTalkToNpc(");

        // The villager walks too, so the post-approach re-check names the same fact the
        // shared arrival leg names -- not the planner's `target_out_of_range`, which
        // would report "too far" for an arrival that actually happened.
        executed.Should().Contain("\"target_out_of_reach\"");
        executed.Should().Contain("reach=1;approach=target_moved");
        executed.Should().Contain("IsTileWithinChebyshevRadius(Game1.player, npcTileX, npcTileY, 1)");
    }

    // ---- one radius, one spelling --------------------------------------------

    [Fact]
    public void EveryWalkingFamily_MeasuresReachWithTheOneChebyshev1Predicate()
    {
        string animals = Read(AnimalsFile);
        string npc = Read(NpcFile);

        // The pet path used the native `Utility.tileWithinRadiusOfPlayer` while the two
        // NPC actions used the Mod's own `IsTileWithinChebyshevRadius`. Both are
        // Chebyshev-1, so the radius never disagreed -- but two spellings of one rule is
        // two places a future radius change can miss. The walking families now share the
        // one predicate.
        MethodBody(animals, "public LocalExecutionReceipt RequestLocalPetAnimal(")
            .Should().NotContain("Utility.tileWithinRadiusOfPlayer");
        MethodBody(animals, "private LocalExecutionReceipt ExecutePetAnimal(")
            .Should().NotContain("Utility.tileWithinRadiusOfPlayer");
        animals.Should().Contain("IsTileWithinChebyshevRadius(Game1.player, petTileX, petTileY, 1)");
        npc.Should().Contain("IsTileWithinChebyshevRadius(Game1.player, npcTileX, npcTileY, 1)");

        // The animal product family reaches its radius through the named wrapper, which
        // itself delegates to the same predicate at radius 1.
        string controller = Read("farmhandexecutioncontroller.cs");
        controller.Should().Contain("private static bool IsAnimalProductTargetInRange(Farmer player, int targetX, int targetY)");
        controller.Should().Contain("return IsTileWithinChebyshevRadius(player, targetX, targetY, AnimalProductActionRadius);");
    }

    // ---- the shared arrival leg still gates the walk -------------------------

    [Fact]
    public void BothFamilies_RelyOnTheSharedArrivalLeg_NotOnAPrivateWalk()
    {
        string animals = Read(AnimalsFile);

        // One shared mechanism owns the geometry, the ownership bookkeeping and the
        // release paths; neither family grows a private walk of its own, and neither
        // stops the target or re-plans towards it (no pursuit controller).
        animals.Should().NotContain("PathFindController");
        animals.Should().NotContain("new LocalMoveSpec(");
        animals.Should().Contain("this.TryBeginToolApproach(");
    }

    [Theory]
    [InlineData("target_out_of_reach")]
    public void ReasonCodes_MatchReceiptSchemaPattern(string reasonCode)
    {
        // Mirrors protocol/bridge-v1.schema.json #/$defs/reasonCode.
        System.Text.RegularExpressions.Regex.IsMatch(reasonCode, "^[a-z0-9_:-]{1,128}$")
            .Should().BeTrue($"reasonCode '{reasonCode}' must satisfy the bridge schema pattern");
    }

    // -------------------------------------------------------------------------

    private static string Read(string fileName) =>
        File.ReadAllText(RepositorySourcePath(Path.Combine("integrations", "stardew", fileName)));

    /// <summary>Extracts a brace-balanced body starting at the first <c>{</c> that follows the signature.</summary>
    private static string MethodBody(string source, string signature)
    {
        int index = source.IndexOf(signature, StringComparison.Ordinal);
        index.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");
        int opening = source.IndexOf('{', index + signature.Length);
        opening.Should().BeGreaterThanOrEqualTo(0, $"{signature} must have a body");

        int depth = 0;
        for (int cursor = opening; cursor < source.Length; cursor++)
        {
            if (source[cursor] == '{') depth++;
            else if (source[cursor] == '}' && --depth == 0) return source[opening..(cursor + 1)];
        }

        throw new InvalidOperationException($"unbalanced body for {signature}");
    }

    private static string RepositorySourcePath(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate))
                    return candidate;
            }
        }

        throw new FileNotFoundException($"repository path not found: {relative}");
    }
}
