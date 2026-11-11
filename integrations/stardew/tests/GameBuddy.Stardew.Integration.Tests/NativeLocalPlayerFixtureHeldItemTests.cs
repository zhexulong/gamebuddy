using System.Reflection;
using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The fixture's declared HAND: <see cref="NativeLocalPlayerFixtureConfig.HeldItemQualifiedId"/>.
///
/// <para>
/// The case that forced it is `pet_animal` with an ORDINARY item held. `Pet.checkAction` (Pet.cs:619-667) refuses
/// nothing: it reads `Items[CurrentToolIndex]` for exactly two branches — a `Hat` moved onto the pet (:621-641) and
/// `(O)ButterflyPowder` opening a question dialogue (:642-645) — and then falls through to the petting body
/// (:646-664) either way. But every item-in-hand Given in this tree is hardcoded per scenario (`(O)388` with a Sign,
/// `(H)0` with a Mannequin) and <c>InitializeNativeLocalPetFixture</c> actively cleared the selected slot, so the one
/// world that seam needs could not be armed at all — the live slice had nothing to run on.
/// </para>
/// <para>
/// The fixture cannot be EXECUTED here (no game process), so the behaviour is pinned at the two levels that can be
/// read: the config gate, which is plain managed code and runs against the config record itself, and the
/// initializer's source, which is the only place the mint/select/refusal order exists.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: five cases drive the declared hand end to end (config validation, the whole-record write,
// the engine item factory after the scenario Given, both refusals, and the pet scenario no longer clearing it), while
// four pin the source shape a behaviour test cannot see - that the field has exactly one placement path whatever the
// item kind, and that no second writer of the hand exists to disagree with it later.
public sealed class NativeLocalPlayerFixtureHeldItemTests
{
    private static NativeLocalPlayerFixtureConfig Fixture(string scenario, string heldItemQualifiedId) => new()
    {
        Enable = true,
        LogicalSaveName = "GameBuddyFixtureHeldItem",
        ObservedSaveSlot = "GameBuddyFixtureHeldItem_445094166",
        TimeoutSeconds = 90,
        FixtureScenario = scenario,
        // The config's own rule: the private target label exists only for this scenario and is empty otherwise.
        NavigationMutationTargetLabel = scenario == "navigation_mutation_v1" ? "Farm" : string.Empty,
        HeldItemQualifiedId = heldItemQualifiedId,
    };

    /// <summary>
    /// The closed scenario set is the population of the orthogonality gate below, so it is read from the config
    /// rather than written again here. A rename fails loudly instead of quietly emptying the check.
    /// </summary>
    /// <summary>
    /// The scenarios an ARMED native-local fixture accepts. Read from the config's own declaration rather than a list
    /// here, so a scenario added to the config is examined by the gates below without anyone remembering to add it. The
    /// two scenarios the host-automation dispatcher owns are not in it: the armed native-local fixture refuses a
    /// configuration whose Given it cannot build, and the declared hand is a question about scenarios it CAN build.
    /// </summary>
    private static string[] ArmedFixtureScenarios()
    {
        FieldInfo? field = typeof(NativeLocalPlayerFixtureConfig)
            .GetField("NativeLocalFixtureScenarios", BindingFlags.NonPublic | BindingFlags.Static);
        field.Should().NotBeNull("the config owns the closed scenario set this gate must examine every member of");
        return (string[])field!.GetValue(null)!;
    }

    [Fact]
    public void HeldItemQualifiedId_IsAQualifiedIdTheConfigAccepts()
    {
        Fixture("native_pet_animal_v1", "(O)72").IsValid.Should().BeTrue();
        // Absent means "the scenario declares no hand", which every other fixture in the tree relies on.
        Fixture("native_pet_animal_v1", string.Empty).IsValid.Should().BeTrue();
    }

    [Fact]
    public void HeldItemQualifiedId_IsRefusedAtConfigValidation_NotAtFirstUse()
    {
        // An unqualified id ("72") and an over-long one are refused by the config gate itself, so a typo cannot
        // arm a fixture that only discovers the problem after the world has loaded.
        Fixture("native_pet_animal_v1", "72").IsValid.Should().BeFalse();
        // "Refused by name" is literal: the value the operator typed is what the config-validation log reports, so a
        // rejected fixture cannot look like a bad save name or a stray LAN host.
        Fixture("native_pet_animal_v1", "72").HeldItemQualifiedIdRefusal.Should().Be("HeldItemQualifiedId:72");
        Fixture("native_pet_animal_v1", "(O)72").HeldItemQualifiedIdRefusal.Should().BeNull();
        NativeLocalPlayerFixtureConfig overLong = Fixture("native_pet_animal_v1", "(O)" + new string('9', 64));
        overLong.IsValid.Should().BeFalse();        // The same gate runs on the bootstrap path, which validates BEFORE a save exists.
        NativeLocalPlayerFixtureConfig bootstrap = Fixture("native_pet_animal_v1", "72") with
        {
            Bootstrap = new NativeLocalPlayerFixtureBootstrapConfig
            {
                Enable = true,
                SaveName = "GameBuddyFixtureHeldItem",
                PlayerName = "GameBuddy",
            },
        };
        bootstrap.IsBootstrapValid.Should().BeFalse();
        NativeLocalPlayerFixtureConfig qualifiedBootstrap = bootstrap with { HeldItemQualifiedId = "(O)72" };
        qualifiedBootstrap.IsBootstrapValid.Should().BeTrue();
    }

    [Fact]
    public void HeldItemQualifiedId_IsTheJsonKeyACallerWrites()
    {
        // The exact shape a caller stages into config.json. SMAPI reads with a case-insensitive System.Text.Json.
        string json = "{\"NativeLocalPlayerFixture\":{"
            + "\"Enable\":true,"
            + "\"LogicalSaveName\":\"GameBuddyFixtureHeldItem\","
            + "\"ObservedSaveSlot\":\"GameBuddyFixtureHeldItem_445094166\","
            + "\"FixtureScenario\":\"native_pet_animal_v1\","
            + "\"HeldItemQualifiedId\":\"(O)72\"}}";
        var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };

        ModConfig restored = JsonSerializer.Deserialize<ModConfig>(json, options)!;

        NativeLocalPlayerFixtureConfig fixture = restored.NativeLocalPlayerFixture!;
        fixture.HeldItemQualifiedId.Should().Be("(O)72");
        fixture.IsValid.Should().BeTrue();
    }

    [Fact]
    public void HeldItemQualifiedId_SurvivesTheWholeRecordConfigWrite()
    {
        // Helper.WriteConfig replaces config.json whole, and the bootstrap completion persists a COPY with three
        // overrides. The declared hand is not one of them, so it must ride through untouched - the field a
        // hand-written rebuild forgets is exactly how the navigation fixture's private target label was lost.
        NativeLocalPlayerFixtureConfig persisted = Fixture("native_pet_animal_v1", "(O)72")
            .WithObservedBootstrapCompletion("GameBuddyFixtureHeldItem", "GameBuddyFixtureHeldItem_445094166", "GameBuddy");

        persisted.HeldItemQualifiedId.Should().Be("(O)72");
        persisted.IsValid.Should().BeTrue();
    }

    [Fact]
    public void EveryKnownFixtureScenario_AcceptsTheDeclaredHand()
    {
        // Every scenario in the set failed the same way before this field existed: the hand could not be declared,
        // so the property is stated for the whole population instead of the one scenario that needed it first.
        string[] scenarios = ArmedFixtureScenarios();
        scenarios.Should().NotBeEmpty("an empty population would let this gate pass without examining anything");

        foreach (string scenario in scenarios)
            Fixture(scenario, "(O)72").IsValid.Should().BeTrue($"the declared hand is never a scenario's concern: {scenario}");
    }

    [Fact]
    public void DeclaredHand_IsAppliedAfterTheScenarioGiven_ThroughTheEngineItemFactory()
    {
        string source = FixtureSource();
        string entry = MethodBody(source, "private void TryInitializeNativeLocalPlayerFixture()");
        int givenWork = entry.IndexOf("this.TryInitializeNativeLocalPlayerFixtureScenario(fixture);", StringComparison.Ordinal);
        int declaredHand = entry.IndexOf("this.ApplyNativeLocalPlayerFixtureHeldItem(fixture);", StringComparison.Ordinal);
        givenWork.Should().BeGreaterThanOrEqualTo(0, "the scenario dispatch must stay the first half of the fixture");
        declaredHand.Should().BeGreaterThan(givenWork, "the declared hand is the SECOND half: after the scenario's own Given, never before it");

        string apply = MethodBody(source, "private void ApplyNativeLocalPlayerFixtureHeldItem(NativeLocalPlayerFixtureConfig fixture)");
        // The scenario's Given has to exist before the hand can be judged; a scenario still pending its native warp
        // must leave this method to the next tick rather than mint into a world that is not staged yet.
        apply.Should().Contain("!this.nativeLocalPlayerFixtureInitialized");
        apply.Should().Contain("this.nativeLocalPlayerFixtureTerminal");
        // Once, not once per tick.
        apply.Should().Contain("this.nativeLocalPlayerFixtureHeldItemApplied");

        string place = MethodBody(source, "private static string? TryPlaceNativeLocalFixtureHeldItem(Farmer player, string qualifiedId)");
        place.Should().Contain("ItemRegistry.Exists(qualifiedId)", "an id with no item data is refused by name, never minted as an Error Item");
        place.Should().Contain("ItemRegistry.Create(qualifiedId, 1)", "the item must be the engine's own factory output, not a hand-built instance");
        place.Should().Contain("player.CurrentToolIndex = slot;", "the declared item must be the SELECTED slot, the one Pet.checkAction reads");
    }

    [Fact]
    public void DeclaredHand_RefusalsNameTheId()
    {
        string source = FixtureSource();
        string place = MethodBody(source, "private static string? TryPlaceNativeLocalFixtureHeldItem(Farmer player, string qualifiedId)");

        // The two refusals the fixture owes, each carrying the id that was asked for: "something went wrong" is
        // indistinguishable from a product defect at the far end of a live run.
        place.Should().Contain("$\"fixture_held_item_unknown:{qualifiedId}\"");
        place.Should().Contain("$\"fixture_held_item_no_room:{qualifiedId}\"");
        // A hand that is not the declared item is a fixture failure too, not a world the action may run against.
        place.Should().Contain("$\"fixture_held_item_not_held:{qualifiedId}\"");
    }

    [Fact]
    public void PetFixture_NoLongerClearsADeclaredHand_AndStillRefusesADirtyOne()
    {
        string source = FixtureSource();
        string body = MethodBody(source, "private void InitializeNativeLocalPetFixture(Farmer player, Farm farm)");

        // The initializer used to clear the selected slot unconditionally, which is what made an ordinary held item
        // impossible: the only world the native seam's fall-through needs is the one it destroyed.
        body.Should().Contain("HeldItemQualifiedId");
        int guard = body.IndexOf("HeldItemQualifiedId", StringComparison.Ordinal);
        int emptyHand = body.IndexOf("RequireNativeLocalPetEmptyHand(player)", StringComparison.Ordinal);
        emptyHand.Should().BeGreaterThan(guard, "an empty hand is only this fixture's Given when it declares no hand");
        body.Should().NotContain(
            "Items[player.CurrentToolIndex] = null",
            "the selected slot is the save's, not this fixture's: nulling it deleted the starting kit's Axe");

        string establish = MethodBody(source, "private static void RequireNativeLocalPetEmptyHand(Farmer player)");
        // An EMPTY slot is the same Given as a nulled one, and it costs the actor nothing.
        establish.Should().Contain("player.CurrentToolIndex = index;", "selecting an empty slot empties the hand without destroying what stood in it");
        establish.Should().NotContain("= null", "the starting kit must survive a pet scenario");
        establish.Should().Contain("fixture_native_local_pet_hands_not_empty", "a hand that cannot be emptied is refused by name");
        establish.Should().Contain(
            "player.Items.Count(item => item is not null) == carriedBefore",
            "the fixture must MEASURE that it destroyed nothing rather than assume it");
    }

    [Fact]
    public void DeclaredHand_HasExactlyOnePlacementPath_WhateverTheItemKind()
    {
        // A tool and an ordinary object fill the hand the SAME way: one mint, one insert into a free slot, one
        // selection. `Farmer.CurrentItem` is the selected slot whatever it holds, and `CurrentTool` is that same slot
        // seen as a Tool, so a second "tool slot" route would be a second way to say one thing - and the two would
        // drift. This pins the single path rather than the kind.
        string place = MethodBody(FixtureSource(), "private static string? TryPlaceNativeLocalFixtureHeldItem(Farmer player, string qualifiedId)");

        place.Split("player.addItemToInventory(").Length.Should().Be(2, "one insertion path, not one per item kind");
        place.Split("player.CurrentToolIndex = slot;").Length.Should().Be(2, "one selection path, not one per item kind");
        place.Should().NotContain("is Tool", "routing on the item's kind is exactly the second path this pins against");
    }

    private static string FixtureSource() => File.ReadAllText(
        RepositorySourcePath(Path.Combine("integrations", "stardew", "ModEntry.Fixtures.cs")));

    private static string RepositorySourcePath(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate))
                    return candidate;
                directory = directory.Parent;
            }
        }
        throw new FileNotFoundException($"repository source not found: {relative}");
    }

    /// <summary>Extract one method by brace balance. Valid only for bodies whose literals carry no unbalanced braces.</summary>
    private static string MethodBody(string source, string declaration)
    {
        int start = source.IndexOf(declaration, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"declaration not found: {declaration}");
        int open = source.IndexOf('{', start);
        int depth = 0;
        for (int index = open; index < source.Length; index++)
        {
            if (source[index] == '{')
                depth++;
            else if (source[index] == '}')
            {
                depth--;
                if (depth == 0)
                    return source.Substring(start, index - start + 1);
            }
        }
        throw new InvalidOperationException($"unbalanced body: {declaration}");
    }
}
