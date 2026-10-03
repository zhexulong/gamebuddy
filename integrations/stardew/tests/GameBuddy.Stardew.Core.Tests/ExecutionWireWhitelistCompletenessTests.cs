using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// Every registered execution action must be reachable over the wire: the
/// parser's <see cref="BridgeProtocol.ExecutionArgumentProperties"/> whitelist
/// is the first gate a request passes, and an action missing from it is a
/// capability that can never be invoked (the <c>invalid_envelope</c> class of
/// silent breakage — cut_grass hit exactly this: it was registered, discovered,
/// and advertised, yet every request died with parse rejection because the
/// whitelist was not updated with it).
///
/// Read-only actions (observe_scene / find_destination / inspect_world_map) are
/// exempt: they travel over their own read channels, not execution_request.
/// </summary>
public sealed class ExecutionWireWhitelistCompletenessTests
{
    private static readonly string[] ReadOnlyActions = { "find_destination", "inspect_world_map", "observe_scene" };

    [Fact]
    public void EveryRegisteredExecutionActionHasAWireArgumentWhitelist()
    {
        string[] missing = FarmhandActionCatalog.Registrations
            .Where(registration => registration.Kind == FarmhandOperationKind.Execution)
            .Select(registration => registration.ActionId)
            .Except(ReadOnlyActions)
            .Where(actionId => BridgeProtocol.ExecutionArgumentProperties(actionId) is null)
            .OrderBy(actionId => actionId)
            .ToArray();

        missing.Should().BeEmpty(
            "a registered execution action with no wire whitelist dies with invalid_envelope on every request: "
            + string.Join(", ", missing));
    }

    [Fact]
    public void ClearCaskIsReachableOverTheWireWithEquippedToolSlot()
    {
        string[]? argumentProperties = BridgeProtocol.ExecutionArgumentProperties("clear_cask");

        argumentProperties.Should().NotBeNull();
        argumentProperties!.Should().Equal(new[] { "x", "y", "slot", "expectedTargetId" });
    }

    [Fact]
    public void UseRaftIsReachableOverTheWire()
    {
        string[]? argumentProperties = BridgeProtocol.ExecutionArgumentProperties("use_raft");
        argumentProperties.Should().Equal(new[] { "slot", "x", "y" });
    }

    [Fact]
    public void CutGrassIsReachableOverTheWire()
    {
        string[]? argumentProperties = BridgeProtocol.ExecutionArgumentProperties("cut_grass");

        argumentProperties.Should().NotBeNull("a registered action the parser rejects can never be invoked");
        argumentProperties!.Should().Equal(new[] { "x", "y", "slot", "expectedTargetId" });
    }
}