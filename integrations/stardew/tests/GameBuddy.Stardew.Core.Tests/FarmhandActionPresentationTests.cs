using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// What each published action is called and the kinds of thing it acts on (<see cref="FarmhandActionPresentationCatalog"/>),
/// and what it does NOT publish (the sentence a model reads, which is the Host's).
///
/// <para>
/// WHY THIS GATE EXISTS. The two facts were the Host's, in two tables keyed by action id, and nothing in this assembly held
/// them to anything: an action could be renamed in the Host and no test on this side could notice, because this side
/// declared no name at all. The assertions below are the producer's half - every row names a catalog action, every row
/// reaches the projection, the projection carries no description, and the count of rows is PRINTED rather than assumed -
/// while the cross-language half (exactly the actions whose mounted tool reads a row, and no others, with its sentence from
/// the Host's own table) is `host/src/action-tool-presentation-derivation.test.ts`.
/// </para>
///
/// <para>
/// AN ACTION WITH NO ROW IS A STATEMENT, NOT A HOLE. Nine registrations carry none today: six still write their schema
/// in their own mount block on the Host side, and three mount no Game Action tool at all. The unit that deletes one of
/// those mounts adds its row. This test
/// counts both sides so that a row disappearing and a row arriving are both visible in the run's own output.
/// </para>
///
/// <para>
/// THE BOUNDARY IS ASSERTED HERE, not just in the Host: the projection has no <c>Description</c> member to publish, so a
/// sentence that came back would have to arrive as a new member - which the Host's exact-key gate refuses
/// (<c>action-publication-carries-facts-not-prose.test.ts</c>), and which the record here could not compile.
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
            row.TargetKinds.Should().Equal(presentation.TargetKinds, $"{actionId} publishes the kinds the catalog declares");
            projectedRows++;
        }

        projectedRows.Should().Be(declared.Count);

        // The pair travels together on every projection: a kinds list with no label names an action nothing can address,
        // and a label with no kinds is a name with nothing to say about what it acts on.
        foreach (FarmhandActionDescriptorProjection row in projected.Values)
        {
            bool presented = row.Label is not null;
            (row.TargetKinds is not null).Should().Be(presented, $"{row.ActionId} publishes both fact members or neither");
        }

        // Printed on every run: the table's own coverage, so a row that arrives or leaves says so where a reader looks.
        Console.WriteLine(
            $"actions registered {FarmhandActionCatalog.Registrations.Count} · publishing a label {declared.Count} · " +
            $"publishing none {FarmhandActionCatalog.Registrations.Count - declared.Count} · " +
            $"projection members {typeof(FarmhandActionDescriptorProjection).GetProperties().Length}");
    }

    [Fact]
    public void ADeclaredPresentationIsANameAndKindsWithinThePublishedBounds()
    {
        // The catalog refuses these at construction, so this asserts the bounds that are actually in force are the ones the
        // readers apply - and that no row leans on the ceiling: a label is a name, and every kind is one lower_snake word.
        foreach ((string actionId, FarmhandActionPresentation presentation) in FarmhandActionPresentationCatalog.ByActionId)
        {
            presentation.Label.Length.Should().BeInRange(1, FarmhandActionPresentationCatalog.MaximumLabelLength, actionId);
            presentation.Label.Should().NotContain("\n", $"{actionId} publishes one name, not a block");
            presentation.TargetKinds.Should().NotBeEmpty($"{actionId} acts on something, or its target family says it addresses none");
            presentation.TargetKinds.Should().OnlyHaveUniqueItems($"{actionId} names each kind once");
        }
    }

    [Fact]
    public void TheProjectionCarriesNoSentenceAModelReads()
    {
        // The member that left on 2026-11-25. Asserted against the RECORD rather than a comment, so a re-added member fails
        // here by name: the Mod publishes what the action IS - its name, the kinds it acts on, its arguments and their
        // bounds - and every description a model reads is the Host's table (`game-tools.ts`).
        Type projection = typeof(FarmhandActionDescriptorProjection);
        projection.GetProperty("Description").Should().BeNull(
            "the action descriptor publishes no sentence a model reads: that prose is the Host's");
        projection.GetProperty("Label").Should().NotBeNull("the label is a fact the action owns");
        projection.GetProperty("TargetKinds").Should().NotBeNull("the kinds it acts on are a fact the action owns");
    }
}
