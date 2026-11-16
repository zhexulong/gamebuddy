using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The wire contract of <c>open_geode</c>, pinned where the Host and the Mod must agree.
///
/// WHY THESE ASSERTIONS. Three separate facts decide whether the action can be invoked at all, and
/// each is written down in a different file: the CATALOG owns membership, identity and lifecycle
/// (<c>FarmhandActionDefinitions.cs</c>), the PARSER owns the argument names a request may carry
/// (<see cref="BridgeProtocol.ExecutionArgumentProperties"/>, the first gate every request passes),
/// and the descriptor owns the arguments the Agent is told about. An action whose parser list and
/// descriptor list disagree cannot be called with the arguments it publishes, and an action missing
/// from the parser list dies with <c>invalid_envelope</c> on every request - the failure class the
/// wholesale gate above this file already names (<c>cut_grass</c> shipped registered, discovered,
/// advertised and unreachable).
///
/// So the argument list is asserted ONCE, against the catalog's own declaration, and the literal
/// shape is pinned beside it as the readable form a reviewer can check against the handler's
/// signature. The rung is NOT restated: whether this action reaches the Agent is
/// `ActionPolicyEngine.ComputeEnabledActions`'s answer, and a promotion or a demotion is measured there
/// without a second copy of the fact landing in this file.
/// </summary>
public sealed class OpenGeodeWireContractTests
{
    private const string ActionId = "open_geode";

    private static FarmhandActionRegistration Registration() =>
        FarmhandActionCatalog.Registrations.Should().ContainSingle(entry => entry.ActionId == ActionId).Subject;

    [Fact]
    public void OpenGeodeIsRegisteredAsAnEnabledBackpackAction()
    {
        FarmhandActionRegistration registration = Registration();

        registration.Kind.Should().Be(FarmhandOperationKind.Execution, "it performs a world change");
        registration.HandlerGroup.Should().Be(
            FarmhandActionHandlerGroup.ResourceTools,
            "the geode is the actor's own carried item, the same handler group the sewing-machine pair uses");
        // Not a restated rung: `ComputeEnabledActions` is the one place that decides which rungs reach the Agent
        // (`ModConfig.EnabledActionSet`), so a demotion fails here without a second copy of the promotion fact.
        ActionPolicyEngine.ComputeEnabledActions(new ActionPolicyOptions())
            .Should().Contain(ActionId, "a promoted action is on the Agent surface with no opt-in");
        registration.Descriptor.Should().NotBeNull();

        FarmhandActionDescriptor descriptor = registration.Descriptor!;
        // No coordinate and no opaque target id: the counter is the blacksmith's own dialogue case and
        // the geode is named by the slot's live item, so a target family here would claim a snapshot
        // projection this action does not publish.
        descriptor.TargetFamily.Should().BeNull("open_geode publishes no snapshot target family");
        descriptor.NativeBinding.Should().Be("GeodeMenu.receiveLeftClick", "the descriptor must name the native face actually driven");
        descriptor.Postcondition.Should().Be(
            "geode_opened",
            "the receipt this handler mints when the geode left the pack, the fee moved and the treasure landed is "
                + "`geode_opened`; the generic `native_action_postcondition` named no member, which kept this action "
                + "outside the postcondition-delta gate's population while its handler was already measuring one");

        descriptor.Arguments.Select(argument => (argument.Name, argument.Type)).Should().Equal(
            ("slot", "integer"),
            ("expectedQualifiedItemId", "string"));
    }

    /// <summary>
    /// The parser's list and the catalog's descriptor are the same fact, so they are compared as one:
    /// an action whose two halves disagree is callable only by accident.
    /// </summary>
    [Fact]
    public void OpenGeodeWireArgumentsAreTheCatalogDescriptorArguments()
    {
        string[]? wire = BridgeProtocol.ExecutionArgumentProperties(ActionId);
        string[] descriptorArguments = Registration().Descriptor!.Arguments.Select(argument => argument.Name).ToArray();

        wire.Should().NotBeNull("a registered action with no parser list dies with invalid_envelope on every request");
        wire.Should().Equal(descriptorArguments);
    }

    [Fact]
    public void OpenGeodeIsReachableOverTheWireWithTheGeodeSlotAndItsItemId()
    {
        BridgeProtocol.ExecutionArgumentProperties(ActionId)
            .Should().Equal(new[] { "slot", "expectedQualifiedItemId" });
    }
}
