using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// What each published action is called, the sentence a model reads about it, and the kinds it acts on
/// (<see cref="FarmhandActionPresentationCatalog"/>).
///
/// <para>
/// WHY THIS GATE EXISTS. Those three facts were the Host's, in two tables keyed by action id, and nothing in this assembly
/// held them to anything: an action could be renamed in the Host and no test on this side could notice, because this side
/// declared no name at all. The assertions below are the producer's half - every row names a catalog action, every row
/// reaches the projection, and the count of rows without one is PRINTED rather than assumed - while the cross-language
/// half (exactly the actions whose mounted tool reads a row, and no others) is
/// `host/src/action-tool-presentation-derivation.test.ts`, which is the side that knows which mounts project a
/// declaration.
/// </para>
///
/// <para>
/// AN ACTION WITH NO ROW IS A STATEMENT, NOT A HOLE. Fifty-eight registrations carry none today: their tool text is still
/// written in its own mount block on the Host side, and the unit that deletes those mounts adds their rows. This test
/// counts both sides so that a row disappearing and a row arriving are both visible in the run's own output.
/// </para>
/// </summary>
public sealed class FarmhandActionPresentationTests
{
    [Fact]
    public void EveryPresentedActionIsACatalogActionAndEveryRowReachesTheProjection()
    {
        IReadOnlyDictionary<string, FarmhandActionPresentation> declared = FarmhandActionPresentationCatalog.ByActionId;

        declared.Should().NotBeEmpty("the published surface declares its labels rather than the Host holding them");

        // Both directions: a row for an action the catalog does not register is an entry that outlived its action, and the
        // projection is what a consumer outside a running game reads, so a row that never reaches it is a label nobody can
        // see.
        foreach (string actionId in declared.Keys)
            FarmhandActionCatalog.Registrations.Should().Contain(
                registration => registration.ActionId == actionId,
                $"{actionId} declares a presentation, so the catalog must register it");

        Dictionary<string, FarmhandActionDescriptorProjection> projected = FarmhandActionSurfacePublication.Actions
            .ToDictionary(action => action.ActionId, StringComparer.Ordinal);
        int projectedRows = 0;
        foreach ((string actionId, FarmhandActionPresentation presentation) in declared)
        {
            FarmhandActionDescriptorProjection row = projected[actionId];
            row.Label.Should().Be(presentation.Label, $"{actionId} publishes the label the catalog declares");
            row.Description.Should().Be(presentation.Description, $"{actionId} publishes the sentence the catalog declares");
            row.TargetKinds.Should().Equal(presentation.TargetKinds, $"{actionId} publishes the kinds the catalog declares");
            projectedRows++;
        }

        projectedRows.Should().Be(declared.Count);

        // The three travel together on every row and on every projection: a label with no sentence is a tool a model can call
        // and not understand, and a kinds list with no label names an action nothing can address.
        foreach (FarmhandActionDescriptorProjection row in projected.Values)
        {
            bool presented = row.Label is not null;
            (row.Description is not null).Should().Be(presented, $"{row.ActionId} publishes all three presentation members or none");
            (row.TargetKinds is not null).Should().Be(presented, $"{row.ActionId} publishes all three presentation members or none");
        }

        // Printed on every run: the table's own coverage, so a row that arrives or leaves says so where a reader looks.
        Console.WriteLine(
            $"actions registered {FarmhandActionCatalog.Registrations.Count} · publishing a label {declared.Count} · " +
            $"publishing none {FarmhandActionCatalog.Registrations.Count - declared.Count}");
    }

    [Fact]
    public void ADeclaredPresentationIsANameAndASentenceWithinThePublishedBounds()
    {
        // The catalog refuses these at construction, so this asserts the bounds that are actually in force are the ones the
        // readers apply - and that no row leans on the ceiling: a label is a name, and every sentence here is shorter than
        // the bound that admits it.
        foreach ((string actionId, FarmhandActionPresentation presentation) in FarmhandActionPresentationCatalog.ByActionId)
        {
            presentation.Label.Length.Should().BeInRange(1, FarmhandActionPresentationCatalog.MaximumLabelLength, actionId);
            presentation.Description.Length.Should().BeInRange(1, FarmhandActionPresentationCatalog.MaximumDescriptionLength, actionId);
            presentation.Description.Should().NotContain("\n", $"{actionId} publishes one sentence, not a block");
            presentation.TargetKinds.Should().NotBeEmpty($"{actionId} acts on something, or its target family says it addresses none");
            presentation.TargetKinds.Should().OnlyHaveUniqueItems($"{actionId} names each kind once");
        }
    }
}
