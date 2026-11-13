using System;
using System.IO;
using System.Text.RegularExpressions;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The two readers that name a raw <c>ISpawnItemData.ItemId</c>, pinned where this process can check them.
///
/// <para>
/// WHAT CAN BE DRIVEN. <see cref="GameBuddy.Stardew.ItemDisplayName"/> is a decision over (raw value, the engine's answer),
/// so both branches are driven here: an answer is used verbatim, and no answer is STATED as
/// <c>display_name_unresolved:&lt;raw&gt;</c> rather than returned as null.
/// </para>
///
/// <para>
/// WHAT CANNOT, AND IS PINNED INSTEAD. The name itself needs a content manager: measured in this very process,
/// <c>ItemRegistry.GetData("(O)128")</c> answers null for every id, <c>ItemQueryResolver.TryResolve</c> throws
/// NullReferenceException and <c>GetDataOrErrorItem</c> throws KeyNotFoundException ("No item type definition found with ID
/// '(O)'"). A double returning a name would prove only that the double works, so the engine read is asserted at the call
/// site with the engine cited, and no test here claims that retail data names a fish or a shop item.
/// </para>
/// </summary>
public sealed class ItemDisplayNameTests
{
    private const string ReaderPath = "integrations/stardew/ItemDisplayName.cs";
    private const string FishingReaderPath = "integrations/stardew/FishingCatchableQuery.cs";
    private const string DestinationPath = "integrations/stardew/navigation/deriveddestinationset.cs";

    /// <summary>
    /// The engine's answer is the name, whatever kind of item it belongs to: a weapon and a big craftable are named like an
    /// object is, and a qualified id is not re-read as something else on the way.
    /// </summary>
    [Theory]
    [InlineData("(O)128", "Carp")]
    [InlineData("(W)1", "Rusty Sword")]
    [InlineData("(BC)130", "Chest")]
    [InlineData("128", "Carp")]
    public void TheEnginesAnswerIsUsedVerbatim(string rawId, string engineName) =>
        GameBuddy.Stardew.ItemDisplayName.Resolve(rawId, engineName).Should().Be(
            engineName,
            "`ItemRegistry.GetData` answers for every item type (ItemRegistry.cs:316-323), so no type is filtered here");

    /// <summary>
    /// Defect A, at the decision: a QUALIFIED id is a plain item id. `int.TryParse("(O)128")` is false by construction, so a
    /// layer that classifies a value by whether it is an integer reports a qualified id as an item query and loses its name -
    /// this reader cannot do that, because the raw value only ever travels unchanged and the engine's answer decides.
    /// </summary>
    [Theory]
    [InlineData("(O)128")]
    [InlineData("(W)1")]
    [InlineData("(BC)130")]
    [InlineData("(F)1300")]
    [InlineData("ALL_ITEMS")]
    [InlineData("128")]
    public void AQualifiedIdIsCarriedIntoTheReasonUnchangedWhenNothingAnswers(string rawId) =>
        GameBuddy.Stardew.ItemDisplayName.Resolve(rawId, null).Should().Be(
            $"display_name_unresolved:{rawId}",
            "an unnamed value states which value went unnamed, and a qualified id is not rewritten to look like a query");

    /// <summary>
    /// Defect A and defect B, at the fallback: a name this layer cannot resolve is NAMED as a reason. `null` would read
    /// downstream as "this row names nothing", which is the silence the two readers used to leave behind.
    /// </summary>
    [Fact]
    public void AnUnnamedValueIsStatedRatherThanNull()
    {
        GameBuddy.Stardew.ItemDisplayName.Resolve("(W)999999", null).Should().Be(
            "display_name_unresolved:(W)999999",
            "the reason carries the raw value, so the next reader can go and look at it");
        GameBuddy.Stardew.ItemDisplayName.Resolve("(O)128", "   ").Should().Be(
            "display_name_unresolved:(O)128",
            "a blank name is no name: an item the engine can name never produces one");
        GameBuddy.Stardew.ItemDisplayName.Resolve("(O)128", null).Should().NotBeNull("silence is the defect");
    }

    /// <summary>The reason and a name are told apart, so a caller can keep the reason out of a search list.</summary>
    [Fact]
    public void TheReasonIsNotMistakenForAName()
    {
        GameBuddy.Stardew.ItemDisplayName.IsReason("display_name_unresolved:(BC)130").Should().BeTrue();
        GameBuddy.Stardew.ItemDisplayName.IsReason("Rusty Sword").Should().BeFalse();
        GameBuddy.Stardew.ItemDisplayName.IsReason("Chest").Should().BeFalse();
    }

    /// <summary>
    /// The one spelling: both readers take the prefix from the resolver, so the fish answer and the destination directory
    /// cannot drift into two vocabularies for one fact.
    /// </summary>
    [Fact]
    public void TheReasonSpellingExistsOnce()
    {
        string literal = "display_name_unresolved:";

        StripComments(Read(ReaderPath)).Should().Contain($"UnresolvedPrefix = \"{literal}\"");
        StripComments(Read(FishingReaderPath)).Should().NotContain(
            literal, "the fish reader uses the resolver, so it must not spell the reason itself");
        StripComments(Read(DestinationPath)).Should().NotContain(
            literal, "the destination directory uses the resolver, so it must not spell the reason itself");
    }

    /// <summary>
    /// Defect A at its call site. The row's species, its query flag and its name all come from ONE engine read of the RAW
    /// value: `SpawnFishData.ItemId` is "either a qualified item ID, or an item query like ALL_ITEMS"
    /// (`StardewValley.GameData.xml:1863-1865`) and `ItemRegistry.GetData` is the reader for both forms
    /// (`ItemRegistry.cs:316-323`). The retired test was `int.TryParse(itemId)`, which is FALSE for `(O)128`.
    ///
    /// The `Data/Fish` row is joined on the RESOLVED item's unqualified id, which is the key the engine joins on
    /// (`fish.ItemId`, `GameLocation.cs:14044`); the raw value carries a type tag and misses every entry.
    /// </summary>
    [Fact]
    public void TheFishRowIsNamedByTheEngineReaderForBothIdForms()
    {
        string source = StripComments(Read(FishingReaderPath));

        source.Should().Contain(
            "ParsedItemData? speciesData = ItemRegistry.GetData(itemId)",
            "the engine's reader, asked with the raw value, is what decides whether this row names one item");
        source.Should().NotContain(
            "int.TryParse",
            "`int.TryParse(\"(O)128\")` is false, so an integer test reports every qualified id as an item query");
        source.Should().Contain(
            "string? species = speciesData?.QualifiedItemId",
            "the species is the engine's own id, and null exactly when the engine answered no item (an item query)");
        source.Should().Contain(
            "fishRows.TryGetValue(resolved.ItemId",
            "the species row is joined on the resolved item's unqualified id (GameLocation.cs:14044), not on the tagged raw value");
        source.Should().Contain(
            "ItemDisplayName.Resolve(itemId, speciesData?.DisplayName)",
            "the name is the engine's answer, or the stated reason - never a silent null");
    }

    /// <summary>
    /// Defect B at its call site. `ShopItemData.ItemId` is the same `ISpawnItemData.ItemId`, so the shop's item name comes
    /// from the same engine reader. The retired code sliced the value after its type tag and looked the remainder up in
    /// `DataLoader.Objects`, where a `(W)`, `(F)` or `(BC)` row shares nothing with an object but its NUMBER: the row was
    /// either named as an item of an entirely different kind or dropped.
    /// </summary>
    [Fact]
    public void TheShopItemNameComesFromTheEngineReaderNotTheObjectTable()
    {
        string source = StripComments(Read(DestinationPath));

        source.Should().Contain(
            "ItemDisplayName.Resolve(itemId, ItemRegistry.GetData(itemId)?.DisplayName)",
            "the engine's reader covers weapons, furniture and big craftables; the object table does not");
        source.Should().NotContain(
            "DataLoader.Objects",
            "the object table cannot answer for `(W)`/`(F)`/`(BC)`, and answers with the WRONG item for a colliding number");
        source.Should().NotContain(
            "Substring(closingBracket",
            "the value must reach the engine reader whole, or the type tag that distinguishes it is thrown away");
    }

    private static string Read(string relativePath)
    {
        DirectoryInfo? directory = new(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, relativePath)))
            directory = directory.Parent;
        directory.Should().NotBeNull($"`{relativePath}` must be reachable from the test's own directory");
        return File.ReadAllText(Path.Combine(directory!.FullName, relativePath));
    }

    /// <summary>The source without its comments, because a sentence naming a symbol is not a use of it.</summary>
    private static string StripComments(string source) =>
        Regex.Replace(
            Regex.Replace(source, @"/\*.*?\*/", string.Empty, RegexOptions.Singleline),
            @"//[^\r\n]*",
            string.Empty);
}
