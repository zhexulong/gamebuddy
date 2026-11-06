using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The <c>break_resource_clump</c> registration: the shape the bridge, the Host validator and the adapters have to agree
/// on, asserted from the catalog and from the wire parser rather than from a second copy of the numbers.
///
/// <para>
/// The action clears a large stump, hollow log, boulder or meteorite - the `ResourceClump` family - and the tool it needs
/// is a property of the CLUMP (<c>ResourceClump.performToolAction</c> switches on <c>parentSheetIndex</c>), not of this
/// row. Two consequences are pinned here because they are easy to undo by accident: the request carries no <c>slot</c>,
/// and the row declares no <c>tool:</c> claim. A row that named one family would be wrong for every clump of the other,
/// and the refusal a caller reads would then be about the pack instead of about the target.
/// </para>
/// </summary>
public sealed class BreakResourceClumpRegistrationTests
{
    private static FarmhandActionRegistration Registration() =>
        FarmhandActionCatalog.Registrations.Single(candidate => candidate.ActionId == "break_resource_clump");

    [Fact]
    public void TheRowIsAResourceToolActionWhoseTargetsAreThePublishedClumpFamily()
    {
        FarmhandActionRegistration registration = Registration();

        registration.FamilyId.Should().Be("resource_gathering");
        registration.IdentityVersion.Should().Be(1);
        registration.Kind.Should().Be(FarmhandOperationKind.Execution);
        registration.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.ResourceTools);
        // The same family `clear_debris` publishes: one clump is one published row, however it is cleared.
        registration.Descriptor!.TargetFamily.Should().Be("debrisTargets");
        // A gate descriptor is a promise that the action has its own live-run gate, so it needs at least `published`.
        // This action has no live gate yet, and the rung says so instead of implying one.
        registration.Lifecycle.Should().Be(FarmhandActionLifecycle.Experimental);
    }

    [Fact]
    public void TheRequestNamesATileAndATargetAndNoToolSlot()
    {
        FarmhandActionDescriptor descriptor = Registration().Descriptor!;

        descriptor.Arguments.Select(argument => argument.Name)
            .Should().Equal(new[] { "x", "y", "expectedTargetId" });
        descriptor.Arguments.Should().OnlyContain(argument => argument.Enum == null);
        descriptor.Arguments.Should().OnlyContain(argument => argument.Type != "integer" || argument.Name != "slot");
        // No `slot` is not a relaxation: the handler selects the tool the clump's own switch demands and restores the
        // actor's selection, so a number here would be a fact the caller cannot know and the handler would not obey.
        descriptor.Arguments.Select(argument => argument.Name).Should().NotContain("slot");
        descriptor.Effect.Should().Be("write");
        descriptor.OutputFacts.Should().BeEmpty();
    }

    [Fact]
    public void TheRowDeclaresNoToolClaimBecauseTheTargetOwnsThatFact()
    {
        FarmhandActionDescriptor descriptor = Registration().Descriptor!;

        descriptor.ResourceTemplate.Should().ContainSingle()
            .Which.Should().Be(new FarmhandActionResourceTemplateClaim("embodied_actor", FarmhandResourceTemplateValue.ScopePlayer));
        descriptor.ResourceTemplate
            .Where(claim => claim.Key.StartsWith("tool:", System.StringComparison.Ordinal))
            .Should().BeEmpty(
                "ResourceClump.performToolAction decides the family and the upgrade floor from parentSheetIndex, so a "
                + "single `tool:` claim on this row would refuse every clump of the other family");
    }

    [Fact]
    public void TheWireWhitelistIsTheRowsOwnArgumentList()
    {
        // Two independent statements of one fact - the parser's whitelist and the published descriptor - compared to
        // each other rather than to a third hand-written list. A whitelist that drifts refuses every request with the
        // parser's own `invalid_envelope`, which is how `cut_grass` was registered, advertised and unreachable.
        string[]? wire = BridgeProtocol.ExecutionArgumentProperties("break_resource_clump");
        string[] declared = Registration().Descriptor!.Arguments.Select(argument => argument.Name).ToArray();

        wire.Should().NotBeNull("a registered execution action the parser does not whitelist can never be invoked");
        wire!.Should().Equal(declared);
    }
}
