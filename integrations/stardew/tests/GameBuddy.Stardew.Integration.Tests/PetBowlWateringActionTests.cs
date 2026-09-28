using System.Reflection;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Handlers;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// water_pet_bowl contract pins.
///
/// Seam decision: <c>PetBowl.watered</c> is the only terminal this action claims,
/// and the only writer is <c>PetBowl.performToolAction</c> (PetBowl.cs:81-91),
/// reached from <c>WateringCan.DoFunction</c> through
/// <c>location.performToolAction</c> (WateringCan.cs:182) and the buildings loop
/// (GameLocation.cs:16256-16260). The action exists separately from the published
/// <c>water_crop</c> because that action's <c>crop_watered</c> postcondition is a
/// HoeDirt crop transition a pet bowl can never satisfy; the precedent for a
/// second action over the same WateringCan seam is <c>refill_watering_can</c>.
///
/// Structural assertions run without a Game1 harness (world-not-ready path); the
/// native watering itself and the bowl's before/after observation belong to the
/// native-local fixture gate (scenario native_water_pet_bowl_v1).
/// </summary>
public sealed class PetBowlWateringActionTests
{
    [Fact]
    public void Catalog_WaterPetBowl_RegisteredAsExperimentalAnimalsPetsWithTarget()
    {
        FarmhandActionRegistration? reg = FarmhandActionCatalog.Registrations
            .FirstOrDefault(r => r.ActionId == "water_pet_bowl");

        reg.Should().NotBeNull();
        reg!.FamilyId.Should().Be("animals_pets");
        reg.Lifecycle.Should().Be(FarmhandActionLifecycle.Experimental);
        reg.Kind.Should().Be(FarmhandOperationKind.Execution);
        reg.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.MachinesAndAnimals);
        reg.Descriptor.Should().NotBeNull();
        reg.Descriptor!.Arguments.Select(a => a.Name)
            .Should().BeEquivalentTo(new[] { "x", "y", "expectedTargetId" });
        reg.Descriptor.Effect.Should().Be("write");
        reg.Descriptor.Postcondition.Should().Be("native_action_postcondition");
    }

    [Fact]
    public void Router_WaterPetBowl_WhenWorldNotReady_Rejects()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "water_pet_bowl" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var handler = new MachineAndAnimalActionHandler(executions);

        var request = new BridgeExecutionRequest(
            "req_water_pet_bowl_1", "idemp_water_pet_bowl_1", "water_pet_bowl",
            new BridgeExecutionArgs { X = 53, Y = 9, ExpectedTargetId = "pet_bowl_0123456789abcdef" },
            1, 5000);
        var receipt = handler.Execute(request, executions);

        receipt.Should().NotBeNull();
        receipt.State.Should().Be(ExecutionState.Rejected);
        // The scope-bound actor proof precedes every world read, so in a world-less
        // probe the identity guard is what refuses. pet_bowl_target_unavailable is
        // the code a real actor-less Farm returns and is pinned by the live gate.
        receipt.ReasonCode.Should().Be("world_not_ready");
    }

    [Fact]
    public void RequestLocalWaterPetBowl_EmitsStaminaEvidenceAndThePetBowlReasonCode()
    {
        string source = File.ReadAllText(NativeActionSourcePath());
        int start = source.IndexOf("public LocalExecutionReceipt RequestLocalWaterPetBowl(", StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, "the handler must live in an owned execution-manager partial");

        // Scope to the one handler body: brace balance from its declaration, so a
        // neighbouring handler's evidence can never satisfy this assertion.
        int depth = 0;
        bool started = false;
        int end = -1;
        for (int index = start; index < source.Length; index++)
        {
            char character = source[index];
            if (character == '{')
            {
                depth++;
                started = true;
            }
            else if (character == '}')
            {
                depth--;
                if (started && depth == 0)
                {
                    end = index;
                    break;
                }
            }
        }
        end.Should().BeGreaterThan(start);
        string body = source[start..(end + 1)];

        // The tool-family gate requires the agent half of the mutation on any
        // tool-driven succeeded receipt (WateringCan deducts stamina in DoFunction).
        body.Should().Contain("stamina_before");
        body.Should().Contain("stamina_after");
        body.Should().Contain("stamina_delta");
        body.Should().Contain("expected_stamina_cost");
        // A direct DoFunction bypasses Farmer.useTool, so the persistent cross-day
        // exhaustion consequence must be set here or the companion escapes it.
        body.Should().Contain("checkForExhaustion");
        body.Should().Contain("\"pet_bowl_watered\"");
        body.Should().Contain("\"pet_bowl_water_postcondition_unavailable\"");
        // The postcondition is this execution's own before/after observation.
        body.Should().Contain("before_watered=");
        body.Should().Contain("after_watered=");
        body.Should().Contain("native_menu_opened=");
    }

    /// <summary>
    /// The target tile is the one the native gate accepts, and it is asked of the
    /// building rather than computed from footprint arithmetic. `PetBowl.
    /// performToolAction` only sets `watered` when the watered tile carries the
    /// building's PetBowl property, and `Building.doesTileHaveProperty` resolves
    /// that against each BuildingData entry's relative TileArea - which for the
    /// shipped Pet Bowl sits at relative (1, 0), not the footprint origin. A raw
    /// origin or `tileX + 1` computation would run the native path and silently
    /// leave `watered` false, which is exactly the observed live failure.
    /// </summary>
    [Fact]
    public void PetBowlTargeting_AsksTheBuildingForItsWaterableTile_NotFootprintArithmetic()
    {
        string actionSource = File.ReadAllText(NativeActionSourcePath());
        string discoverySource = File.ReadAllText(RepositorySourcePath(
            Path.Combine("integrations", "stardew", "farmhandexecutioncontroller.cs")));

        // The shared helper is the single owner of "which tiles accept watering",
        // and it asks the building's own predicate.
        actionSource.Should().Contain("internal static IEnumerable<Vector2> PetBowlWaterableTiles(");
        actionSource.Should().Contain("bowl.doesTileHaveProperty(x, y, \"PetBowl\", \"Buildings\", ref propertyValue)");
        // Resolution and identity both go through the helper, so a bowl reached by
        // any of its waterable tiles resolves and hashes to one stable identity.
        actionSource.Should().Contain("PetBowlWaterableTiles(candidate).Any(");
        actionSource.Should().Contain("PetBowlWaterableTiles(bowl).DefaultIfEmpty(");
        // Discovery advertises the same waterable tiles the handler accepts, and
        // anchors its identity on them rather than on the footprint origin.
        discoverySource.Should().Contain("PetBowlWaterableTiles(bowl)");
        discoverySource.Should().Contain("BuildPetBowlTargetId(location, (int)tile.X, (int)tile.Y)");

        // No tile offset is hardcoded: the fix must not reintroduce footprint or
        // relative-offset arithmetic, which is what broke the first live attempt.
        actionSource.Should().NotContain("tileX.Value + 1");
        actionSource.Should().NotContain("tileY.Value + 1");
        actionSource.Should().NotContain("new Vector2(1, 0)");
        discoverySource.Should().NotContain("bowl.tileX.Value +");

        // The YIELDED tile is the predicate's own (x, y), not the footprint origin.
        // Pinning only the predicate's presence would leave the exact live failure
        // undetected: a regression that keeps `doesTileHaveProperty` but yields the
        // origin would compile, resolve and water the wrong tile, and still satisfy
        // every assertion above. Assert the yielded expression itself. The genuinely
        // behavioral proof of this remains the native-local live gate (scenario
        // native_water_pet_bowl_v1), which is what originally caught this bug; the
        // test project has no Game1 harness to construct a bowl with building data.
        actionSource.Should().Contain("yield return new Vector2(x, y);");
        actionSource.Should().NotContain("yield return new Vector2(bowl.tileX.Value");
        actionSource.Should().NotContain("yield return new Vector2((int)bowl.tileX.Value");
    }

    /// <summary>Tests run from the project or its bin output; walk up to the repository root.</summary>
    private static string NativeActionSourcePath() => RepositorySourcePath(Path.Combine(
        "integrations", "stardew", "farmhandexecutioncontroller.petbowlactions.cs"));

    /// <summary>Resolve a repository-relative source path from either test working directory.</summary>
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
