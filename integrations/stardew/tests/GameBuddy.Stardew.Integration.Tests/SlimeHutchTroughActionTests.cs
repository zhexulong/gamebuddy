using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Handlers;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// water_slime_hutch_trough contract pins.
///
/// Seam decision: <c>SlimeHutch.waterSpots[y - 6]</c> is the only terminal this
/// action claims, and the only writer is <c>SlimeHutch.performToolAction</c>
/// (SlimeHutch.cs:154-161), which accepts a WateringCan at the FIXED interior
/// coordinates <c>tileX == 16</c>, <c>tileY in 6..9</c>. SlimeHutch fully
/// overrides that method with no base call, so there is no building-property or
/// relative-offset lookup involved — unlike the sibling `water_pet_bowl`, whose
/// gate asks <c>Building.doesTileHaveProperty</c>. The action exists separately
/// from the published <c>water_crop</c> because that action's <c>crop_watered</c>
/// postcondition describes a HoeDirt crop transition this target can never
/// satisfy, while <c>SlimeHutch.DayUpdate</c> (SlimeHutch.cs:68-94) consumes these
/// spots to produce slimes.
///
/// Structural assertions run without a Game1 harness (world-not-ready path); the
/// native watering itself and the trough's before/after observation belong to the
/// native-local fixture gate (scenario native_water_slime_hutch_trough_v1).
/// </summary>
public sealed class SlimeHutchTroughActionTests
{
    private static readonly string[] TroughReasonCodes =
    {
        "slime_hutch_trough_watered",
        "slime_hutch_trough_water_postcondition_unavailable",
        "slime_hutch_not_current_location",
        "slime_hutch_trough_target_changed",
        "slime_hutch_trough_already_watered",
        "watering_can_not_equipped",
        "watering_can_empty",
    };

    /// <summary>
    /// Codes this action can still produce but no longer owns the text of: the shared
    /// approach mechanism (design 5.2) mints them on its behalf. They are pinned where
    /// they are declared, so this action cannot silently lose a reach rejection and the
    /// mechanism cannot silently stop producing one.
    /// </summary>
    private static readonly string[] SharedMechanismReasonCodes =
    {
        "target_out_of_reach",
    };

    [Fact]
    public void Catalog_WaterSlimeHutchTrough_RegisteredAsLiveVerifiedAnimalsPetsWithTarget()
    {
        FarmhandActionRegistration? reg = FarmhandActionCatalog.Registrations
            .FirstOrDefault(r => r.ActionId == "water_slime_hutch_trough");

        reg.Should().NotBeNull();
        reg!.FamilyId.Should().Be("animals_pets");
        reg.Lifecycle.Should().Be(FarmhandActionLifecycle.LiveVerified);
        reg.Kind.Should().Be(FarmhandOperationKind.Execution);
        reg.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.MachinesAndAnimals);
        reg.Descriptor.Should().NotBeNull();
        reg.Descriptor!.Arguments.Select(a => a.Name)
            .Should().BeEquivalentTo(new[] { "x", "y", "expectedTargetId" });
        reg.Descriptor.Effect.Should().Be("write");
        reg.Descriptor.Postcondition.Should().Be("native_action_postcondition");
    }

    [Fact]
    public void Router_WaterSlimeHutchTrough_WhenWorldNotReady_Rejects()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "water_slime_hutch_trough" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var handler = new MachineAndAnimalActionHandler(executions);

        var request = new BridgeExecutionRequest(
            "req_water_slime_hutch_trough_1", "idemp_water_slime_hutch_trough_1", "water_slime_hutch_trough",
            new BridgeExecutionArgs { X = 16, Y = 6, ExpectedTargetId = "slime_hutch_trough_0123456789abcdef" },
            1, 5000);
        var receipt = handler.Execute(request, executions);

        receipt.Should().NotBeNull();
        receipt.State.Should().Be(ExecutionState.Rejected);
        // The scope-bound actor proof precedes every world read, so in a world-less
        // probe the identity guard is what refuses. The location and target-change
        // codes a real actor-less interior returns are pinned by the live gate.
        receipt.ReasonCode.Should().Be("world_not_ready");
    }

    [Fact]
    public void Handler_ClaimsOnlyTheNativeTroughReasonCodes_AndKeepsTheToolFamilyStaminaEvidence()
    {
        string wrapper = HandlerBody("public LocalExecutionReceipt RequestLocalWaterSlimeHutchTrough(");
        // Design 5.2 split this handler into a request path (admission, geometry, then
        // either an approach leg or the execution body) and the shared execution body
        // `ExecuteWaterSlimeHutchTrough`. The contract lives on whichever body the
        // action executes through, so follow the delegation instead of pinning the
        // wrapper -- a wrapper delegating to a body missing any of these still fails,
        // because the reachable body is what gets checked. The wrapper is checked
        // separately for its own job, which is the closure wiring.
        wrapper.Should().Contain("TryBeginToolApproach(");
        wrapper.Should().Contain("this.ExecuteWaterSlimeHutchTrough(arrivalExecutionId, arrivalRequestId");
        wrapper.Should().Contain("return this.ExecuteWaterSlimeHutchTrough(executionId, requestId");
        string body = ToolExecuteBody("ExecuteWaterSlimeHutchTrough", wrapper);

        // Claimed codes: the success/uncertain pair and this action's own rejections.
        // The rejections are checked on the wrapper when they are position-independent
        // and on the execution body when they are re-checked after the walk, so the
        // union is what must hold.
        string claimed = wrapper + "\n" + body;
        claimed.Should().Contain("\"slime_hutch_trough_watered\"");
        claimed.Should().Contain("\"slime_hutch_trough_water_postcondition_unavailable\"");
        claimed.Should().Contain("\"slime_hutch_not_current_location\"");
        claimed.Should().Contain("\"slime_hutch_trough_target_changed\"");
        claimed.Should().Contain("\"slime_hutch_trough_already_watered\"");

        // The tool-family gate requires the agent half of every tool mutation, and a
        // direct DoFunction bypasses Farmer.useTool, so the persistent cross-day
        // exhaustion consequence must be set here or the companion escapes it.
        // The handler no longer inlines that step: it routes its one native swing
        // through the shared seam, which is where both vanilla closing steps live.
        // So the invariant is two-part -- this handler must reach the seam, and the
        // seam must still run dispatch, click-anchor clear and exhaustion.
        body.Should().Contain("stamina_before");
        body.Should().Contain("stamina_after");
        body.Should().Contain("stamina_delta");
        body.Should().Contain("expected_stamina_cost");
        body.Should().Contain("UseNativeToolOnTile(");
        body.Should().NotContain("checkForExhaustion");
        SharedToolUseSeam().Should().Contain("DoFunction(");
        SharedToolUseSeam().Should().Contain("lastClick = Vector2.Zero");
        SharedToolUseSeam().Should().Contain("checkForExhaustion(");
        body.Should().Contain("native_menu_opened");
        body.Should().Contain("before_watered=");
        body.Should().Contain("after_watered=");

        // The postcondition is this execution's own before/after read of the native
        // spot, so both reads must be present around the single native call.
        body.Should().Contain("beforeWatered = hutch.waterSpots[");
        body.Should().Contain("afterWatered = hutch.waterSpots[");
    }

    /// <summary>
    /// The `private LocalExecutionReceipt Execute*` body a migrated handler executes
    /// through. The wrapper must actually reach it, or the delegation claim would be
    /// decorative.
    /// </summary>
    private static string ToolExecuteBody(string executeName, string wrapper)
    {
        string source = File.ReadAllText(NativeActionSourcePath());
        int start = source.IndexOf($"private LocalExecutionReceipt {executeName}(", StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{executeName} must exist (design 5.2 shares one body per action)");
        wrapper.Should().Contain($"this.{executeName}(");

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
        return source[start..(end + 1)];
    }

    [Fact]
    public void Resolution_UsesTheFixedNativeCoordinates_NotBuildingPropertyArithmetic()
    {
        string source = File.ReadAllText(NativeActionSourcePath());

        // The native gate compares literal interior coordinates, so resolution must
        // too. Pinning the predicate keeps a future edit from silently substituting
        // the Pet Bowl property lookup, which measures a different seam.
        source.Should().Contain("internal static bool IsSlimeHutchTroughTile(int x, int y)");
        source.Should().Contain("x == SlimeHutchTroughColumn");
        source.Should().Contain("y >= SlimeHutchTroughFirstRow");
        source.Should().Contain("y <= SlimeHutchTroughLastRow");
        source.Should().Contain("private const int SlimeHutchTroughColumn = 16;");
        source.Should().Contain("private const int SlimeHutchTroughFirstRow = 6;");
        source.Should().Contain("private const int SlimeHutchTroughLastRow = 9;");

        // The Pet Bowl seam must not leak in: no building-property lookup, and no
        // crop/HoeDirt postcondition, belong to this action. Assert against CODE
        // only — the header comment legitimately names the seams this action is NOT,
        // so scanning the raw file would flag the explanation rather than the code.
        string code = StripLineComments(source);
        code.Should().NotContain("doesTileHaveProperty");
        code.Should().NotContain("HoeDirt");
        code.Should().NotContain("crop_watered");

        // Discovery advertises exactly the fixed tiles the handler accepts.
        string discovery = File.ReadAllText(RepositorySourcePath(
            Path.Combine("integrations", "stardew", "farmhandexecutioncontroller.cs")));
        discovery.Should().Contain("DiscoverSlimeHutchTroughTargets");
        discovery.Should().Contain("IsSlimeHutchTroughTile(SlimeHutchTroughColumn, y)");
    }

    [Fact]
    public void ReasonCodeVocabulary_IsDisjointFromTheSiblingWateringActions()
    {
        // The three WateringCan actions share a native seam but must not share a
        // terminal vocabulary: their postconditions describe different world state.
        string source = File.ReadAllText(NativeActionSourcePath());
        foreach (string code in TroughReasonCodes)
            source.Should().Contain($"\"{code}\"");
        source.Should().NotContain("\"pet_bowl_watered\"");
        source.Should().NotContain("\"crop_watered\"");

        // Reach refusals now come from the shared approach mechanism rather than this
        // file. Both halves are pinned: this action must go through the mechanism, and
        // the mechanism must still refuse by reach -- otherwise a migrated action could
        // lose its rejection entirely while this test kept passing.
        source.Should().Contain("TryBeginToolApproach(");
        string mechanism = HandlerBodyOf("farmhandexecutioncontroller.resourcetoolactions.cs", "private void CompleteToolApproach(");
        foreach (string code in SharedMechanismReasonCodes)
            mechanism.Should().Contain($"\"{code}\"");
    }

    /// <summary>Drop <c>//</c> line comments so negative pins test code, not prose.</summary>
    private static string StripLineComments(string source)
    {
        var builder = new System.Text.StringBuilder(source.Length);
        foreach (string line in source.Split('\n'))
        {
            int comment = line.IndexOf("//", StringComparison.Ordinal);
            builder.AppendLine(comment >= 0 ? line[..comment] : line);
        }
        return builder.ToString();
    }

    /// <summary>Extract one handler body by brace balance from its declaration.</summary>
    private static string HandlerBody(string declaration) =>
        HandlerBodyOf("farmhandexecutioncontroller.slimehutchtroughactions.cs", declaration);

    /// <summary>
    /// Extract one body by brace balance from a named partial, so a pin can also read
    /// the shared mechanism that now mints some of this action's reason codes.
    /// </summary>
    private static string HandlerBodyOf(string sourceFile, string declaration)
    {
        string source = File.ReadAllText(RepositorySourcePath(Path.Combine("integrations", "stardew", sourceFile)));
        int start = source.IndexOf(declaration, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, "the handler must live in an owned execution-manager partial");

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
        return source[start..(end + 1)];
    }

    private static string NativeActionSourcePath() => RepositorySourcePath(Path.Combine(
        "integrations", "stardew", "farmhandexecutioncontroller.slimehutchtroughactions.cs"));

    /// <summary>
    /// The body of the one shared native tool-use seam, read from the main
    /// execution-manager partial where it is declared.
    ///
    /// The tool-family invariant has two halves. A handler must route its single
    /// native swing through this seam, and the seam itself must keep performing
    /// vanilla <c>Farmer.useTool</c>'s closing steps. Pinning only the handler would
    /// let the seam be hollowed out, so both halves are read here.
    /// </summary>
    private static string SharedToolUseSeam()
    {
        string source = File.ReadAllText(RepositorySourcePath(Path.Combine(
            "integrations", "stardew", "farmhandexecutioncontroller.cs")));
        string signature = "private static void UseNativeToolOnTile(";
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, "the shared native tool-use seam must be declared in the main partial");

        int depth = 0;
        bool started = false;
        for (int index = start; index < source.Length; index++)
        {
            char character = source[index];
            if (character == '{')
            {
                depth++;
                started = true;
            }
            else if (character == '}' && started)
            {
                depth--;
                if (depth == 0)
                    return source.Substring(start, index - start + 1);
            }
        }

        return source.Substring(start);
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
