using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The wire argument list must cover every registered execution action, and must agree with what the catalog
/// declares for it.
///
/// `BridgeProtocol.ExecutionArgumentProperties` is what the inbound parser uses to demand the EXACT argument shape
/// of a request, and an action missing from it fails with `invalid_envelope` **before any handler sees it** - the
/// parser's own comment says so. That error also carries no correlation id, so the Host cannot match the refusal
/// to the call that caused it and reports only its own deadline instead: a registered capability that can never be
/// invoked, and cannot be diagnosed from either side's log.
///
/// Measured 2026-10-18, on the multi-day run that was supposed to cross its first night: `respond_level_up` was
/// registered, published, admitted through the Modal profile, granted by the fixture - and absent from this map,
/// so every dispatch died at the parser while the run reported a 45 s timeout.
/// </summary>
public sealed class ExecutionArgumentWireCoverageTests
{
    private const string RepositoryRelativeRoot = "../../../../../../../";

    private static string ReadProtocol() =>
        File.ReadAllText(
            Path.GetFullPath(
                Path.Combine(
                    AppContext.BaseDirectory,
                    RepositoryRelativeRoot,
                    "integrations",
                    "stardew",
                    "src",
                    "Core",
                    "Protocol",
                    "BridgeProtocol.cs")));

    [Fact]
    public void TheDeclaredDriftIsStillRealAndStillTheOnlyOne()
    {
        // A declared exception has to stay HONEST: if the drift is fixed, this fails and the exception is removed;
        // if another action starts drifting, the equality test above names it.
        var nowDrifting = new List<string>();
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            if (registration.Kind != FarmhandOperationKind.Execution) continue;
            if (registration.Descriptor is not { } descriptor) continue;
            string[]? wire = BridgeProtocol.ExecutionArgumentProperties(registration.ActionId);
            if (wire is null) continue;
            string declared = string.Join(",", descriptor.Arguments.Select((argument) => argument.Name).OrderBy((name) => name, StringComparer.Ordinal));
            string onWire = string.Join(",", wire.OrderBy((name) => name, StringComparer.Ordinal));
            if (declared != onWire) nowDrifting.Add(registration.ActionId);
        }
        nowDrifting.Should().BeEquivalentTo(DeclaredDrift.Keys);
    }

    [Fact]
    public void EveryRegisteredExecutionActionHasAWireArgumentList()
    {
        string[] executionActions = FarmhandActionCatalog.Registrations
            .Where((registration) => registration.Kind == FarmhandOperationKind.Execution)
            .Select((registration) => registration.ActionId)
            .ToArray();
        executionActions.Should().NotBeEmpty();

        var missing = new List<string>();
        foreach (string actionId in executionActions)
        {
            if (BridgeProtocol.ExecutionArgumentProperties(actionId) is null) missing.Add(actionId);
        }

        missing.Should().BeEmpty(
            "the parser rejects a request for an action it has no argument list for, so a registered action missing "
                + "from that map can never be invoked: "
                + string.Join(", ", missing));
    }

    /// <summary>
    /// Actions whose wire list and catalog list disagree TODAY. Each is a real drift that needs its own fix and its
    /// own live gate; they are named here so the guard stays strict for everything else instead of being weakened to
    /// cover them.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, string> DeclaredDrift = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["pickup_forage"] =
            "the wire list carries `sceneTarget` and the catalog descriptor does not declare it as an argument: the parser ",
    };

    [Fact]
    public void TheWireListAndTheCatalogDeclareTheSameArgumentNames()
    {
        var mismatched = new List<string>();
        foreach (FarmhandActionRegistration registration in FarmhandActionCatalog.Registrations)
        {
            if (registration.Kind != FarmhandOperationKind.Execution) continue;
            if (registration.Descriptor is not { } descriptor) continue;
            if (DeclaredDrift.ContainsKey(registration.ActionId)) continue;
            string[]? wire = BridgeProtocol.ExecutionArgumentProperties(registration.ActionId);
            if (wire is null) continue;
            // The descriptor declares the argument names the acceptance layer demands; the wire list decides what
            // the parser will even read. Two vocabularies for one fact drift silently, so they are compared.
            string declared = string.Join(",", descriptor.Arguments.Select((argument) => argument.Name).OrderBy((name) => name, StringComparer.Ordinal));
            string onWire = string.Join(",", wire.OrderBy((name) => name, StringComparer.Ordinal));
            if (declared != onWire) mismatched.Add($"{registration.ActionId}: catalog=[{declared}] wire=[{onWire}]");
        }

        mismatched.Should().BeEmpty(
            "the parser and the acceptance layer must agree on an action's argument names: " + string.Join(" | ", mismatched));
    }
}
