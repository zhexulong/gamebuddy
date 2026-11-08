using FluentAssertions;
using StardewValley.GameData.FarmAnimals;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// `look_up({ subject: "data", table: "FarmAnimals" })` answers from the engine's OWN data type.
///
/// <para>
/// WHY THIS EXISTS. Before this channel, "how do I get an animal?", "what does Marnie charge for a chicken?" and "how
/// many days until this hen lays?" had no answer at all: the facts live in `Data/FarmAnimals`, the engine parses them
/// into <c>Game1.farmAnimalData</c>, and the observation baseline filed that cache as never-read. The projection is the
/// new part, and the risk in a projection is that it names a field the game does not have - so this test builds a real
/// <see cref="FarmAnimalData"/> and drives the REAL projector. A renamed or removed engine field is a compile error
/// here, which is the only check a stub could not give: a hand-built JSON row would keep passing after the game moved.
/// </para>
/// <para>
/// The second half pins what the projection DROPS. `Texture`, `SpriteWidth`, `Skins` and the shadow frames are the
/// presentation half of the same record; a projection that carried them would be an observation with different field
/// names, and an answer that says "days to mature: 4" must not also cost 2 KB of sprite geometry.
/// </para>
/// </summary>
[Trait("kind", "content-data")]
public sealed class ContentDataQueryFarmAnimalsTests
{
    private static FarmAnimalData WhiteChicken() => new()
    {
        DisplayName = "White Chicken",
        House = "Coop",
        DaysToMature = 4,
        DaysToProduce = 1,
        ProduceItemIds = new List<FarmAnimalProduce> { new() { ItemId = "176" } },
        DeluxeProduceItemIds = new List<FarmAnimalProduce> { new() { ItemId = "180", MinimumFriendship = 200 } },
        DeluxeProduceMinimumFriendship = 200,
        HarvestType = FarmAnimalHarvestType.DropOvernight,
        HarvestTool = null,
        ProduceOnMature = false,
        PurchasePrice = 800,
        SellPrice = 400,
        RequiredBuilding = "Coop",
        CanGetPregnant = false,
        // The half the projection must NOT carry.
        Texture = "Animals\\White Chicken",
        SpriteWidth = 16,
        SpriteHeight = 16,
    };

    [Fact]
    public void TheProjectionCarriesTheFieldsThatDecideAnAnimalAction()
    {
        var row = ContentDataQuery.FarmAnimalRow("White Chicken", WhiteChicken());

        row.Id.Should().Be("White Chicken");
        row.Fields["house"].Should().Be("Coop", "which house an animal lives in decides whether it can be bought at all");
        row.Fields["daysToMature"].Should().Be(4);
        row.Fields["daysToProduce"].Should().Be(1);
        row.Fields["produce"].Should().BeEquivalentTo(new[] { "176" });
        row.Fields["deluxeProduce"].Should().BeEquivalentTo(new[] { "180" });
        row.Fields["deluxeProduceMinimumFriendship"].Should().Be(200, "a large product needs friendship, and the threshold is the fact");
        row.Fields["harvestType"].Should().Be("DropOvernight");
        row.Fields["harvestTool"].Should().BeNull("a hen drops its egg; only a tool-harvested animal names one, and null is that fact");
        row.Fields["purchasePrice"].Should().Be(800);
        row.Fields["sellPrice"].Should().Be(400);
        row.Fields["requiredBuilding"].Should().Be("Coop");
    }

    [Fact]
    public void TheProjectionDropsThePresentationHalfOfTheSameRecord()
    {
        var row = ContentDataQuery.FarmAnimalRow("White Chicken", WhiteChicken());

        row.Fields.Keys.Should().NotContain(new[] { "texture", "spriteWidth", "spriteHeight", "skins", "shadow" });
    }

    [Fact]
    public void AnUnknownTableIsNamedAndCountsNothing()
    {
        var answer = ContentDataQuery.Answer("Animals", null);

        answer.Status.Should().Be("unknown_table");
        answer.Table.Should().Be("Animals");
        answer.Population.Should().Be(-1, "no table was found, so nothing was counted");
        answer.Detail.Should().Contain("Animals");
    }

    [Fact]
    public void ATableTooLargeToAnswerWithRefusesByName()
    {
        var answer = ContentDataQuery.Answer("Locations", null);

        answer.Status.Should().Be("not_projectable");
        answer.Population.Should().Be(-1);
        answer.Detail.Should().NotBeNullOrEmpty("the refusal has to say why it cannot answer");
    }

    [Fact]
    public void EveryTableTheModExposesIsDeclaredInTheRegistry()
    {
        foreach (string table in new[] { "FarmAnimals", "Buildings", "Crops", "Objects", "BigCraftables", "Tools", "Machines", "Shops", "Locations" })
            ContentDataQuery.Exposes(table).Should().BeTrue($"{table} is part of the published content-table surface");
        ContentDataQuery.Exposes("Animals").Should().BeFalse("the engine has no Data/Animals table; FarmAnimals is the real name");
    }
}
