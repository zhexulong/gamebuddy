using System.IO;
using System.Linq;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// `pet_farm_animal` calls the game's own <c>FarmAnimal.pet(Farmer who)</c> (FarmAnimal.cs:693) and refuses, by name,
/// every branch of that seam whose effect is not a pet.
///
/// <para>
/// WHY THIS FILE EXISTS. The seam returns calmly in four cases without petting: a farmer who is mid single animation
/// (:697), an animal that is not moving after 19:00 (:703, dialogue only), a held Golden Animal Cracker (:726, the
/// cracker is spent and the animal untouched) and an animal that was already petted today (:745, which instead mounts
/// <c>AnimalQueryMenu</c> at :791-794). A handler that only checked "did the call return" would report
/// <c>farm_animal_petted</c> for all four, and the run would believe the farm had been cared for.
/// </para>
///
/// <para>
/// Structural assertions run without a <c>Game1</c> harness; the live petting belongs to the native-local fixture
/// gates, which this action has not been through yet (hence <c>Experimental</c>).
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the pins here assert on repository source text because the native seam they cover cannot load in a headless runner, while the rest of the class reads real product declarations for the same seam.
public sealed class FarmAnimalPetActionTests
{
    private const string AnimalsFile = "farmhandexecutioncontroller.machinesanimalsitemsactions.cs";
    private const string ControllerFile = "farmhandexecutioncontroller.cs";
    private const string HandlerFile = "Handlers/MachineAndAnimalActionHandler.cs";

    // ---- what the seam does NOT do, refused by name -------------------------

    [Fact]
    public void EveryNoOpBranchOfTheSeamIsRefusedByItsOwnName()
    {
        string rule = MethodBody(Read(AnimalsFile), "private static string? FarmAnimalPetRefusal(");

        // One code per native branch, each naming the real reason rather than a shared "could not pet".
        rule.Should().Contain("\"farm_animal_already_petted_today\"")
            .And.Contain("animal.wasPet.Value", "the day marker is the engine's own, read before the call");
        rule.Should().Contain("\"farm_animal_cracker_would_be_consumed\"")
            .And.Contain("\"(O)GoldenAnimalCracker\"", "the held item that the seam would spend instead of petting");
        rule.Should().Contain("\"farm_animal_pet_requires_movement_after_1900\"")
            .And.Contain("Game1.timeOfDay >= 1900", "after 19:00 only a MOVING animal can be petted")
            .And.Contain("animal.isMoving()", "the clock alone is not the seam's precondition");

        // A generic fallback would make the four branches indistinguishable to the caller, which is the defect this
        // action exists to avoid: each refusal is its own named statement, so the four are counted here rather than
        // trusted to stay distinct.
        rule.Split('"').Where((part, index) => index % 2 == 1 && part.StartsWith("farm_animal_", System.StringComparison.Ordinal))
            .Should().BeEquivalentTo(
                new[]
                {
                    "farm_animal_already_petted_today",
                    "farm_animal_cracker_would_be_consumed",
                    "farm_animal_pet_requires_movement_after_1900",
                },
                "one code per native no-op branch of FarmAnimal.pet, and no shared fallback");
    }

    [Fact]
    public void TheRuleIsConsultedBeforeTheNativeCall_BothOnAdmissionAndOnArrival()
    {
        string admitted = MethodBody(Read(AnimalsFile), "public LocalExecutionReceipt RequestLocalPetFarmAnimal(");
        string arrived = MethodBody(Read(AnimalsFile), "private LocalExecutionReceipt ExecutePetFarmAnimal(");

        int admittedRule = admitted.IndexOf("FarmAnimalPetRefusal(Game1.player, animal)", System.StringComparison.Ordinal);
        int admittedTile = admitted.IndexOf("TileTargetGate.Resolved(", System.StringComparison.Ordinal);
        admittedRule.Should().BeGreaterThanOrEqualTo(0);
        admittedRule.Should().BeLessThan(
            admittedTile,
            "an animal that cannot be petted must be refused before the actor is sent walking to it");
        admitted.Should().Contain("ResolveFarmAnimalPetTarget(location, expectedTargetId)");
        admitted.IndexOf("ResolveFarmAnimalPetTarget(", System.StringComparison.Ordinal).Should().BeLessThan(
            admittedRule,
            "the rule answers about one animal, so the animal is resolved by identity first");
        admitted.Should().NotContain("TryBeginToolApproach", "the walk is the seam's, not this request half's");

        int arrivedRule = arrived.IndexOf("FarmAnimalPetRefusal(Game1.player, animal)", System.StringComparison.Ordinal);
        int arrivedNative = arrived.IndexOf("animal.pet(Game1.player)", System.StringComparison.Ordinal);
        arrivedRule.Should().BeGreaterThanOrEqualTo(0);
        arrivedNative.Should().BeGreaterThan(
            arrivedRule,
            "the walk takes ticks, so the day marker, the held item and the clock are re-read before the call");

        // Admission owns the actor-side early return (`who.FarmerSprite.PauseForSingleAnimation`, :697): a paused,
        // eating or menu-held farmer is refused or parked there, and the shared profile is the one admission gate. It now
        // runs inside the seam, before the gate this request half hands over - which is why the request half carries no
        // admission of its own.
        admitted.Should().Contain("AdmissionActionabilityProfile.General");
        admitted.Should().Contain("this.RequestLocalTileTarget(");
    }

    // ---- the seam, and only the seam ----------------------------------------

    [Fact]
    public void TheBodyCallsTheNativePet_AndReImplementsNoneOfItsMutation()
    {
        string body = MethodBody(Read(AnimalsFile), "private LocalExecutionReceipt ExecutePetFarmAnimal(");

        body.Should().Contain("animal.pet(Game1.player)", "the native manual-pet call is the whole effect");
        // Re-implementing the mutation would be a second authority for the day marker and the friendship: the game's
        // own `wasPet` / `friendshipTowardFarmer` / `happiness` updates are what the postcondition reads.
        body.Should().NotContain("friendshipTowardFarmer.Value =");
        body.Should().NotContain("happiness.Value =");
        body.Should().NotContain("wasPet.Value =");
        body.Should().NotContain("wasAutoPet.Value =");
        body.Should().NotContain("AnimalQueryMenu", "petting must not mount a modal this action does not own");
        body.Should().NotContain("is_auto_pet: true", "the auto-pet branch is the machine's, not the companion's");
    }

    // ---- the postcondition --------------------------------------------------

    [Fact]
    public void ThePostconditionReadsTheEnginesOwnMarkerAndTheFriendshipTheSeamApplied()
    {
        string body = MethodBody(Read(AnimalsFile), "private LocalExecutionReceipt ExecutePetFarmAnimal(");

        int native = body.IndexOf("animal.pet(Game1.player)", System.StringComparison.Ordinal);
        int marker = body.IndexOf("bool marked = animal.wasPet.Value;", System.StringComparison.Ordinal);
        int friendship = body.IndexOf("int friendshipAfter = animal.friendshipTowardFarmer.Value;", System.StringComparison.Ordinal);
        marker.Should().BeGreaterThan(native, "`wasPet` is read AFTER the call: it is the engine's own marker (:749)");
        friendship.Should().BeGreaterThan(native, "the applied friendship is read from the animal, not re-derived");
        // And the SAME field is read BEFORE the call too: the delta the caller receives is the engine's change across its
        // own mutation, not a number this action computed.
        friendship.Should().BeGreaterThan(body.IndexOf("int friendshipBefore = animal.friendshipTowardFarmer.Value;", System.StringComparison.Ordinal));

        // The floor mirrors the seam's own branches (:751-:763): 15 normally, 7 when the animal was already auto-petted
        // that morning, and the friendship-boost profession only ever adds. Anything weaker would report success for a
        // branch that granted nothing.
        body.Should().Contain("autoPettedBefore ? 7 : 15");
        body.Should().Contain("Math.Min(1000,", "the seam caps the friendship at 1000, so the floor must cap identically");
        body.Should().Contain("\"farm_animal_pet_postcondition_not_observed\"");
        body.Should().Contain("ExecutionState.Uncertain", "a seam that took an early return is not a failure to retry blindly");
        body.Should().Contain("\"farm_animal_petted\"");
    }

    [Fact]
    public void AnAnimalThatWalkedOutOfReachNamesTheMovedFact_RatherThanThePettingAddress()
    {
        string body = MethodBody(Read(AnimalsFile), "private LocalExecutionReceipt ExecutePetFarmAnimal(");

        body.Should().Contain("\"target_out_of_reach\"");
        body.Should().Contain("reach=1;approach=target_moved");
        int range = body.IndexOf("target_out_of_reach", System.StringComparison.Ordinal);
        int native = body.IndexOf("animal.pet(Game1.player)", System.StringComparison.Ordinal);
        native.Should().BeGreaterThan(range, "the native entry must never run against a tile the animal has left");

        // The request's published coordinate is geometry for the walk only: a barn animal wanders, so the body
        // measures reach against the animal's LIVE tile.
        body.Should().Contain("IsTileWithinChebyshevRadius(Game1.player, animalTileX, animalTileY, 1)");
        body.Should().NotContain("targetX");
        body.Should().NotContain("targetY");
    }

    // ---- identity -----------------------------------------------------------

    [Fact]
    public void TheTargetIdCarriesTheLocationAndTheAnimal_AndNoCoordinate()
    {
        string identity = MethodBody(Read(ControllerFile), "private static string BuildFarmAnimalPetTargetId(");

        identity.Should().Contain("{location.NameOrUniqueName}:farmAnimal:{animal.myID.Value}");
        identity.Should().NotContain(".Tile.X");
        identity.Should().NotContain(".Tile.Y");

        // The same id shape the household Pet uses (`location:pet:<id>`) with its own noun, so the two families cannot
        // collide on a location that holds both.
        string petIdentity = MethodBody(Read(ControllerFile), "private static string BuildPetTargetId(");
        petIdentity.Should().Contain(":pet:");
        identity.Should().NotContain(":pet:");
    }

    [Fact]
    public void TheResolverDoesNotReapplyThePetDayFilter()
    {
        string resolver = ExpressionBody(Read(AnimalsFile), "private static FarmAnimal? ResolveFarmAnimalPetTarget(");

        // Discovery filters `wasPet`; RESOLUTION must not, because an animal this farmer petted after the snapshot
        // still exists. Filtering here would answer `farm_animal_target_gone` for an animal standing in front of the
        // actor and hide the real reason (`farm_animal_already_petted_today`).
        resolver.Should().NotContain("wasPet");
        resolver.Should().Contain("location.animals.Values");
        resolver.Should().Contain("BuildFarmAnimalPetTargetId(location, candidate)");
    }

    [Fact]
    public void DiscoveryPublishesOnlyAnimalsThisActorHasNotPettedToday()
    {
        string discovery = MethodBody(Read(ControllerFile), "private static IReadOnlyList<BridgeFarmAnimalPetTarget> DiscoverFarmAnimalPetTargets(");

        discovery.Should().Contain("location.animals.Values", "farm animals live in the farm AND inside every barn/coop");
        // The day marker is still the engine's own per-farmer, per-day `wasPet` - read as the GUARD it now is, and
        // PUBLISHED as the reason: an animal this farmer already petted is withheld with `petted_today` instead of
        // vanishing from a list that reads the same as "no animals here".
        discovery.Should().Contain("if (animal.wasPet.Value)", "the engine's own per-farmer, per-day marker decides");
        discovery.Should().Contain(
            "exclusions.Record(\"farmAnimalPetTargets\", DiscoveryExclusionReasons.PettedToday)",
            "a withheld animal must be counted under the reason that withheld it");
        discovery.Should().Contain("TargetDiscoveryRadius");
        discovery.Should().Contain("OrderBy(", "a wanderer's dictionary order is neither spatial nor stable");
        discovery.Should().NotContain("animal.happiness", "the row publishes what a caller can act on, not the whole animal");
    }

    [Fact]
    public void TheSnapshotPublishesTheFamilyOnlyWhileTheActionIsAdvertised()
    {
        string controller = Read(ControllerFile);

        controller.Should().Contain(
            "advertisedCapabilities.Contains(\"pet_farm_animal\", StringComparer.Ordinal) ? DiscoverFarmAnimalPetTargets(player, discoveryExclusions) : null",
            "a family published without its capability is a target the caller cannot address");
        // And the world-not-ready snapshot answers null for it, like every other family, so no consumer plans from it.
        controller.Should().Contain("FarmAnimalPetTargets: null");
    }

    // ---- wiring -------------------------------------------------------------

    [Fact]
    public void TheHandlerDispatchesTheFarmAnimalActionToItsOwnEntryPoint()
    {
        string handler = Read(HandlerFile);

        handler.Should().Contain("\"pet_farm_animal\" => this.executions.RequestLocalPetFarmAnimal(");
        handler.Should().Contain("\"pet_animal\" => this.executions.RequestLocalPetAnimal(");
        // One action per seam: the farm-animal id must never be routed to the household Pet's entry point.
        handler.Should().NotContain("\"pet_farm_animal\" => this.executions.RequestLocalPetAnimal(");
    }

    [Theory]
    [InlineData("farm_animal_target_gone")]
    [InlineData("farm_animal_already_petted_today")]
    [InlineData("farm_animal_cracker_would_be_consumed")]
    [InlineData("farm_animal_pet_requires_movement_after_1900")]
    [InlineData("farm_animal_pet_postcondition_not_observed")]
    [InlineData("farm_animal_petted")]
    public void EveryReasonCodeThisActionMintsIsALegalReceiptCode(string reasonCode)
    {
        // Asserted against the REAL journal validator and the REAL wire pattern, not a second copy of either: these
        // strings are emitted into receipts, so a future tightening has to fail here instead of faulting the bridge.
        FarmhandExecutionJournal.IsValidReasonCode(reasonCode)
            .Should().BeTrue($"'{reasonCode}' is journaled as a receipt reasonCode");

        System.Text.RegularExpressions.Regex.IsMatch(reasonCode, "^[a-z0-9_:-]{1,128}$")
            .Should().BeTrue($"'{reasonCode}' is published to the Host as a receipt reasonCode");
    }

    [Fact]
    public void EveryCodeThisActionMintsIsActuallyReachableFromItsOwnBodies()
    {
        string action = Read(AnimalsFile);
        string admitted = MethodBody(action, "public LocalExecutionReceipt RequestLocalPetFarmAnimal(");
        string arrived = MethodBody(action, "private LocalExecutionReceipt ExecutePetFarmAnimal(");
        string rule = MethodBody(action, "private static string? FarmAnimalPetRefusal(");

        foreach (string code in new[]
                 {
                     "farm_animal_target_gone",
                     "farm_animal_already_petted_today",
                     "farm_animal_cracker_would_be_consumed",
                     "farm_animal_pet_requires_movement_after_1900",
                     "farm_animal_pet_postcondition_not_observed",
                     "farm_animal_petted",
                 })
        {
            string quoted = $"\"{code}\"";
            bool reachable = admitted.Contains(quoted) || arrived.Contains(quoted) || rule.Contains(quoted);
            reachable.Should().BeTrue($"'{code}' must be minted by one of this action's own bodies");
        }
    }

    // -------------------------------------------------------------------------

    private static string Read(string relative) =>
        File.ReadAllText(RepositorySourcePath(Path.Combine("integrations", "stardew", relative)));

    /// <summary>Extracts a brace-balanced body starting at the first <c>{</c> that follows the signature.</summary>
    private static string MethodBody(string source, string signature)
    {
        int index = source.IndexOf(signature, System.StringComparison.Ordinal);
        index.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");
        int opening = source.IndexOf('{', index + signature.Length);
        opening.Should().BeGreaterThanOrEqualTo(0, $"{signature} must have a body");

        int depth = 0;
        for (int cursor = opening; cursor < source.Length; cursor++)
        {
            if (source[cursor] == '{') depth++;
            else if (source[cursor] == '}' && --depth == 0) return source[opening..(cursor + 1)];
        }

        throw new System.InvalidOperationException($"unbalanced body for {signature}");
    }

    /// <summary>Extracts an expression-bodied member: from its signature to the terminating semicolon.</summary>
    private static string ExpressionBody(string source, string signature)
    {
        int index = source.IndexOf(signature, System.StringComparison.Ordinal);
        index.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");
        int end = source.IndexOf(';', index + signature.Length);
        end.Should().BeGreaterThan(index, $"{signature} must be an expression-bodied member");
        return source[index..(end + 1)];
    }

    private static string RepositorySourcePath(string relative)
    {
        foreach (string start in new[] { System.AppContext.BaseDirectory, System.Environment.CurrentDirectory })
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
